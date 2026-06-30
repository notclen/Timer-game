// ===== Room.js — Server-side game room state machine =====

const PLAYER_COLORS = [
  '#4a9eff', '#e63946', '#ffc312', '#2ed573',
  '#a55eea', '#ff9f43', '#1abc9c', '#ff6b81',
  '#6c5ce7', '#fdcb6e', '#00b894', '#e17055'
];

const MAX_PLAYERS = 12;

class Room {
  constructor(code, io) {
    this.code = code;
    this.io = io;
    this.players = [];
    this.settings = {
      gameMode: 'timeattack',    // 'timeattack' | 'blindguess' | 'relaycountdown'
      totalRounds: 3,
      timeMode: 'random',
      customTime: 4.0,
      blindMin: 3,
      blindMax: 15,
      teamMode: false,
      teamScoringRule: 'sum',    // 'sum' | 'average'
      relayTarget: 30            // target seconds for relay countdown
    };
    this.state = 'LOBBY';
    this.currentRound = 0;
    this.targetTime = 0;
    this.roundResults = [];
    this.scores = {};
    this.history = [];
    this.buzzerTimestamps = {};
    this.blindStartTime = 0;
    this.blindDuration = 0;
    this.blindTimeout = null;
    this.countdownTimeouts = [];
    this.lastActivity = Date.now();
    this.nextPlayerId = 1;
    this.destroyTimeout = null;

    // Team state
    this.teams = {};  // playerId -> 'A' | 'B'

    // Relay Countdown state
    this.relayTeamTallies = { A: 0, B: 0 };
    this.relayTurnOrder = { A: [], B: [] };
    this.relayCurrentTurnIndex = { A: 0, B: 0 };
    this.relayRoundHistory = { A: [], B: [] };
    this.relayTeamsDone = { A: false, B: false };
    this.relayRevealTimeouts = [];
  }

  // ===== PLAYER MANAGEMENT =====

  generatePlayerId() {
    return `p${this.nextPlayerId++}_${Date.now().toString(36)}`;
  }

  addPlayer(socket, name, isHost = false) {
    if (this.players.length >= MAX_PLAYERS) return null;
    const colorIndex = this.players.length;
    const player = {
      id: this.generatePlayerId(),
      socketId: socket.id,
      name,
      color: PLAYER_COLORS[colorIndex % PLAYER_COLORS.length],
      colorIndex,
      connected: true,
      isHost
    };
    this.players.push(player);
    this.scores[player.id] = 0;
    socket.join(this.code);
    socket.playerId = player.id;
    socket.roomCode = this.code;
    this.lastActivity = Date.now();

    if (this.destroyTimeout) {
      clearTimeout(this.destroyTimeout);
      this.destroyTimeout = null;
    }

    this.broadcastPlayerList();
    return player;
  }

  reconnectPlayer(playerId, socket) {
    const player = this.players.find(p => p.id === playerId);
    if (!player) return null;
    player.socketId = socket.id;
    player.connected = true;
    socket.join(this.code);
    socket.playerId = playerId;
    socket.roomCode = this.code;
    this.lastActivity = Date.now();

    if (this.destroyTimeout) {
      clearTimeout(this.destroyTimeout);
      this.destroyTimeout = null;
    }

    this.broadcastPlayerList();
    return player;
  }

  disconnectPlayer(socketId) {
    const player = this.players.find(p => p.socketId === socketId);
    if (!player) return;
    player.connected = false;
    this.lastActivity = Date.now();

    // Reassign host if needed
    if (player.isHost) {
      player.isHost = false;
      const newHost = this.players.find(p => p.connected);
      if (newHost) {
        newHost.isHost = true;
        this.io.to(newHost.socketId).emit('room:youAreHost');
      }
    }

    this.broadcastPlayerList();
    this.broadcast('room:playerDisconnected', { playerId: player.id, playerName: player.name });

    // If all disconnected, schedule cleanup
    if (this.players.every(p => !p.connected)) {
      this.destroyTimeout = setTimeout(() => {}, 300000);
    }

    // If game in progress, auto-submit for disconnected player
    if (this.state === 'PLAYING' || this.state === 'WAITING_GUESSES') {
      this.checkAllPlayersDone();
    }

    // Relay: if it was their turn, auto-submit 0
    if (this.state === 'RELAY_PLAYING') {
      const team = this.teams[player.id];
      if (team && !this.relayTeamsDone[team]) {
        const turnOrder = this.relayTurnOrder[team];
        const currentIdx = this.relayCurrentTurnIndex[team];
        if (currentIdx < turnOrder.length && turnOrder[currentIdx] === player.id) {
          this.handleRelayGuess(player.id, 0);
        }
      }
    }
  }

  getConnectedPlayers() {
    return this.players.filter(p => p.connected);
  }

  broadcastPlayerList() {
    this.broadcast('room:playerList', {
      players: this.players.map(p => ({
        id: p.id, name: p.name, color: p.color,
        connected: p.connected, isHost: p.isHost,
        team: this.teams[p.id] || null
      }))
    });
  }

  broadcast(event, data) {
    this.io.to(this.code).emit(event, data);
  }

  updateSettings(settings) {
    if (settings.gameMode) this.settings.gameMode = settings.gameMode;
    if (settings.totalRounds) this.settings.totalRounds = parseInt(settings.totalRounds);
    if (settings.timeMode) this.settings.timeMode = settings.timeMode;
    if (settings.customTime) this.settings.customTime = parseFloat(settings.customTime);
    if (settings.blindMin != null) this.settings.blindMin = parseFloat(settings.blindMin);
    if (settings.blindMax != null) this.settings.blindMax = parseFloat(settings.blindMax);
    if (settings.teamMode != null) this.settings.teamMode = !!settings.teamMode;
    if (settings.teamScoringRule) this.settings.teamScoringRule = settings.teamScoringRule;
    if (settings.relayTarget != null) this.settings.relayTarget = parseFloat(settings.relayTarget) || 30;

    // Relay countdown requires team mode
    if (this.settings.gameMode === 'relaycountdown') {
      this.settings.teamMode = true;
    }

    // Swap if min > max
    if (this.settings.blindMin > this.settings.blindMax) {
      [this.settings.blindMin, this.settings.blindMax] = [this.settings.blindMax, this.settings.blindMin];
    }
    this.broadcast('room:settingsUpdated', { settings: this.settings });
  }

  // ===== TEAM MANAGEMENT =====

  setTeams(assignments) {
    assignments.forEach(({ playerId, team }) => {
      if (team === 'A' || team === 'B') {
        this.teams[playerId] = team;
      }
    });
    this.broadcastPlayerList();
  }

  autoBalanceTeams() {
    const connected = this.getConnectedPlayers();
    const shuffled = [...connected].sort(() => Math.random() - 0.5);
    shuffled.forEach((p, i) => {
      this.teams[p.id] = i % 2 === 0 ? 'A' : 'B';
    });
    this.broadcastPlayerList();
  }

  getTeamPlayers(team) {
    return this.players.filter(p => this.teams[p.id] === team);
  }

  getTeamScores() {
    const result = {};
    ['A', 'B'].forEach(team => {
      const teamPlayers = this.getTeamPlayers(team);
      if (teamPlayers.length === 0) {
        result[team] = { total: 0, average: 0, playerCount: 0 };
        return;
      }
      const total = teamPlayers.reduce((sum, p) => sum + (this.scores[p.id] || 0), 0);
      const average = Math.round(total / teamPlayers.length);
      result[team] = { total, average, playerCount: teamPlayers.length };
    });
    return result;
  }

  // ===== GAME FLOW =====

  startGame() {
    if (this.getConnectedPlayers().length < 2) return false;
    if (this.state !== 'LOBBY') return false;

    if (this.settings.teamMode) {
      const hasAssignments = this.getConnectedPlayers().some(p => this.teams[p.id]);
      if (!hasAssignments) {
        this.autoBalanceTeams();
      }
      this.getConnectedPlayers().forEach(p => {
        if (!this.teams[p.id]) {
          const aCount = this.getTeamPlayers('A').length;
          const bCount = this.getTeamPlayers('B').length;
          this.teams[p.id] = aCount <= bCount ? 'A' : 'B';
        }
      });
    }

    this.currentRound = 0;
    this.scores = {};
    this.history = [];
    this.players.forEach(p => { this.scores[p.id] = 0; });

    this.broadcast('game:started', { settings: this.settings, teams: this.teams });

    if (this.settings.gameMode === 'relaycountdown') {
      this.startRelayCountdown();
    } else {
      this.startNewRound();
    }
    return true;
  }

  startNewRound() {
    this.currentRound++;
    this.roundResults = [];
    this.buzzerTimestamps = {};
    this.generateTargetTime();

    const roundInfo = {
      roundNum: this.currentRound,
      totalRounds: this.settings.totalRounds,
      gameMode: this.settings.gameMode
    };

    if (this.settings.gameMode === 'timeattack') {
      roundInfo.targetTime = this.targetTime;
    }

    this.broadcast('round:new', roundInfo);
    this.state = 'COUNTDOWN';
    this.runCountdown();
  }

  generateTargetTime() {
    if (this.settings.gameMode === 'blindguess') {
      const range = this.settings.blindMax - this.settings.blindMin;
      const seconds = this.settings.blindMin + Math.random() * range;
      this.blindDuration = Math.round(seconds * 10) / 10 * 1000;
      this.targetTime = this.blindDuration;
    } else if (this.settings.timeMode === 'custom') {
      this.targetTime = this.settings.customTime * 1000;
    } else {
      const steps = Math.floor(Math.random() * 25);
      this.targetTime = (2.0 + steps * 0.25) * 1000;
    }
  }

  runCountdown() {
    this.clearTimeouts();
    let count = 3;

    const tick = () => {
      if (count > 0) {
        this.broadcast('countdown:tick', { value: count });
        count--;
        this.countdownTimeouts.push(setTimeout(tick, 900));
      } else {
        this.broadcast('countdown:tick', { value: 'GO' });
        this.countdownTimeouts.push(setTimeout(() => {
          this.state = 'PLAYING';
          if (this.settings.gameMode === 'blindguess') {
            this.startBlindTimer();
          } else {
            this.broadcast('round:play', {});
          }
        }, 700));
      }
    };

    this.countdownTimeouts.push(setTimeout(tick, 500));
  }

  // ===== TARGET BUZZER MODE =====

  handleBuzzerStart(playerId) {
    if (this.state !== 'PLAYING') return;
    if (this.buzzerTimestamps[playerId]) return;
    this.buzzerTimestamps[playerId] = { start: Date.now(), stop: null };
    const player = this.players.find(p => p.id === playerId);
    if (player) {
      this.io.to(player.socketId).emit('buzzer:ack', { action: 'started' });
    }
  }

  handleBuzzerStop(playerId) {
    if (this.state !== 'PLAYING') return;
    const ts = this.buzzerTimestamps[playerId];
    if (!ts || !ts.start || ts.stop) return;
    ts.stop = Date.now();

    const elapsed = ts.stop - ts.start;
    this.recordResult(playerId, elapsed);

    const player = this.players.find(p => p.id === playerId);
    if (player) {
      this.io.to(player.socketId).emit('buzzer:result', { elapsed });
    }

    this.broadcast('round:playerDone', {
      playerId,
      playerName: player ? player.name : '?',
      totalDone: this.roundResults.length,
      totalPlayers: this.getConnectedPlayers().length
    });

    this.checkAllPlayersDone();
  }

  // ===== BLIND GUESS MODE =====

  startBlindTimer() {
    this.blindStartTime = Date.now();
    this.broadcast('round:blindRunning', {});

    this.blindTimeout = setTimeout(() => {
      const actualElapsed = Date.now() - this.blindStartTime;
      this.targetTime = actualElapsed;
      this.state = 'WAITING_GUESSES';
      this.broadcast('round:blindStopped', {});
    }, this.blindDuration);
  }

  handleBlindGuess(playerId, guessSeconds) {
    if (this.state !== 'WAITING_GUESSES') return;
    if (this.roundResults.find(r => r.playerId === playerId)) return;

    const guessMs = guessSeconds * 1000;
    this.recordResult(playerId, guessMs);

    const player = this.players.find(p => p.id === playerId);
    this.broadcast('round:playerDone', {
      playerId,
      playerName: player ? player.name : '?',
      totalDone: this.roundResults.length,
      totalPlayers: this.getConnectedPlayers().length
    });

    this.checkAllPlayersDone();
  }

  // ===== SCORING =====

  recordResult(playerId, elapsedMs) {
    if (this.roundResults.find(r => r.playerId === playerId)) return null;

    const diff = Math.abs(elapsedMs - this.targetTime);
    const points = Math.max(0, Math.round(100 - diff / 10));
    const player = this.players.find(p => p.id === playerId);

    const result = {
      playerId,
      playerIndex: this.players.indexOf(player),
      playerName: player ? player.name : '?',
      color: player ? player.color : '#888',
      elapsed: elapsedMs,
      diff,
      points,
      team: this.teams[playerId] || null
    };

    this.roundResults.push(result);
    if (!this.scores[playerId]) this.scores[playerId] = 0;
    this.scores[playerId] += points;
    return result;
  }

  checkAllPlayersDone() {
    const connected = this.getConnectedPlayers();

    this.players.forEach(p => {
      if (!p.connected && !this.roundResults.find(r => r.playerId === p.id)) {
        this.recordResult(p.id, 0);
      }
    });

    const allConnectedDone = connected.every(p =>
      this.roundResults.find(r => r.playerId === p.id)
    );

    if (allConnectedDone && this.roundResults.length >= connected.length) {
      this.finishRound();
    }
  }

  finishRound() {
    this.state = 'ROUND_RESULTS';

    this.history.push({
      round: this.currentRound,
      targetTime: this.targetTime,
      gameMode: this.settings.gameMode,
      results: [...this.roundResults]
    });

    const sorted = [...this.roundResults].sort((a, b) => a.diff - b.diff);
    const leaderboard = this.getSortedLeaderboard();
    const isGameComplete = this.currentRound >= this.settings.totalRounds;

    const payload = {
      roundNum: this.currentRound,
      totalRounds: this.settings.totalRounds,
      targetTime: this.targetTime,
      gameMode: this.settings.gameMode,
      results: sorted,
      leaderboard,
      isGameComplete
    };

    if (this.settings.teamMode) {
      payload.teamScores = this.getTeamScores();
      payload.teamScoringRule = this.settings.teamScoringRule;
    }

    this.broadcast('round:results', payload);
  }

  getSortedLeaderboard() {
    return this.players.map(p => ({
      playerId: p.id,
      name: p.name,
      color: p.color,
      totalScore: this.scores[p.id] || 0,
      team: this.teams[p.id] || null
    })).sort((a, b) => b.totalScore - a.totalScore);
  }

  nextRound() {
    if (this.state !== 'ROUND_RESULTS') return;
    if (this.currentRound >= this.settings.totalRounds) {
      this.endGame();
    } else {
      this.startNewRound();
    }
  }

  endGame() {
    this.state = 'GAME_OVER';
    const leaderboard = this.getSortedLeaderboard();
    const payload = { leaderboard, history: this.history };

    if (this.settings.teamMode) {
      payload.teamScores = this.getTeamScores();
      payload.teamScoringRule = this.settings.teamScoringRule;
    }

    this.broadcast('game:final', payload);
  }

  returnToLobby() {
    this.state = 'LOBBY';
    this.currentRound = 0;
    this.roundResults = [];
    this.scores = {};
    this.history = [];
    this.players.forEach(p => { this.scores[p.id] = 0; });
    this.relayTeamTallies = { A: 0, B: 0 };
    this.relayRoundHistory = { A: [], B: [] };
    this.relayTeamsDone = { A: false, B: false };
    this.clearTimeouts();
    this.broadcast('game:returnToLobby', {});
    this.broadcastPlayerList();
  }

  // ===== RELAY COUNTDOWN MODE =====

  startRelayCountdown() {
    this.state = 'RELAY_PLAYING';
    this.relayTeamTallies = { A: 0, B: 0 };
    this.relayRoundHistory = { A: [], B: [] };
    this.relayTeamsDone = { A: false, B: false };
    this.relayCurrentTurnIndex = { A: 0, B: 0 };

    this.relayTurnOrder = {
      A: this.getTeamPlayers('A').filter(p => p.connected).map(p => p.id),
      B: this.getTeamPlayers('B').filter(p => p.connected).map(p => p.id)
    };

    this.broadcast('relay:start', {
      targetTime: this.settings.relayTarget,
      teams: this.teams,
      turnOrder: {
        A: this.relayTurnOrder.A.map(id => {
          const p = this.players.find(pl => pl.id === id);
          return { id, name: p.name, color: p.color };
        }),
        B: this.relayTurnOrder.B.map(id => {
          const p = this.players.find(pl => pl.id === id);
          return { id, name: p.name, color: p.color };
        })
      },
      tallies: this.relayTeamTallies
    });

    this.sendRelayTurn('A');
    this.sendRelayTurn('B');
  }

  sendRelayTurn(team) {
    if (this.relayTeamsDone[team]) return;

    const turnOrder = this.relayTurnOrder[team];
    const currentIdx = this.relayCurrentTurnIndex[team];

    if (currentIdx >= turnOrder.length) {
      this.relayCurrentTurnIndex[team] = 0;
    }

    const idx = this.relayCurrentTurnIndex[team];
    const playerId = turnOrder[idx];
    const player = this.players.find(p => p.id === playerId);

    if (!player) return;

    const targetMs = this.settings.relayTarget * 1000;
    const remaining = (targetMs - this.relayTeamTallies[team]) / 1000;

    this.io.to(player.socketId).emit('relay:yourTurn', {
      team,
      currentTally: this.relayTeamTallies[team] / 1000,
      targetTime: this.settings.relayTarget,
      remaining: Math.max(0, remaining),
      turnNumber: this.relayRoundHistory[team].length + 1
    });

    this.broadcast('relay:turnUpdate', {
      team,
      currentPlayerId: playerId,
      currentPlayerName: player.name,
      currentTally: this.relayTeamTallies[team] / 1000,
      targetTime: this.settings.relayTarget,
      remaining: Math.max(0, remaining),
      turnNumber: this.relayRoundHistory[team].length + 1
    });
  }

  handleRelayGuess(playerId, guessSeconds) {
    if (this.state !== 'RELAY_PLAYING') return;

    const team = this.teams[playerId];
    if (!team || this.relayTeamsDone[team]) return;

    const turnOrder = this.relayTurnOrder[team];
    const currentIdx = this.relayCurrentTurnIndex[team];
    if (turnOrder[currentIdx] !== playerId) return;

    const guessMs = guessSeconds * 1000;
    this.relayTeamTallies[team] += guessMs;

    const player = this.players.find(p => p.id === playerId);
    const targetMs = this.settings.relayTarget * 1000;

    this.relayRoundHistory[team].push({
      playerId,
      playerName: player ? player.name : '?',
      playerColor: player ? player.color : '#888',
      guess: guessSeconds,
      runningTotal: this.relayTeamTallies[team] / 1000,
      targetTime: this.settings.relayTarget
    });

    this.broadcast('relay:guessDone', {
      team,
      playerName: player ? player.name : '?',
      turnNumber: this.relayRoundHistory[team].length,
      teamsDone: { A: this.relayTeamsDone.A, B: this.relayTeamsDone.B }
    });

    if (player) {
      this.io.to(player.socketId).emit('relay:guessConfirmed', {
        guess: guessSeconds
      });
    }

    if (this.relayTeamTallies[team] >= targetMs) {
      this.relayTeamsDone[team] = true;
      this.broadcast('relay:teamDone', {
        team,
        totalTurns: this.relayRoundHistory[team].length
      });
    } else {
      this.relayCurrentTurnIndex[team] = (currentIdx + 1) % turnOrder.length;
      this.countdownTimeouts.push(setTimeout(() => {
        this.sendRelayTurn(team);
      }, 500));
    }

    if (this.relayTeamsDone.A && this.relayTeamsDone.B) {
      this.countdownTimeouts.push(setTimeout(() => {
        this.startRelayReveal();
      }, 1500));
    }
  }

  startRelayReveal() {
    this.state = 'RELAY_REVEAL';
    const maxRounds = Math.max(
      this.relayRoundHistory.A.length,
      this.relayRoundHistory.B.length
    );

    this.broadcast('relay:revealStart', {
      targetTime: this.settings.relayTarget,
      totalRoundsA: this.relayRoundHistory.A.length,
      totalRoundsB: this.relayRoundHistory.B.length
    });

    let delay = 2000;
    for (let i = 0; i < maxRounds; i++) {
      const roundIdx = i;
      this.relayRevealTimeouts.push(setTimeout(() => {
        const revealData = {
          roundNumber: roundIdx + 1,
          totalRounds: maxRounds
        };

        if (roundIdx < this.relayRoundHistory.A.length) {
          const entry = this.relayRoundHistory.A[roundIdx];
          revealData.teamA = {
            playerName: entry.playerName,
            playerColor: entry.playerColor,
            guess: entry.guess,
            runningTotal: entry.runningTotal,
            targetTime: this.settings.relayTarget,
            diff: Math.abs(entry.runningTotal - this.settings.relayTarget)
          };
        }

        if (roundIdx < this.relayRoundHistory.B.length) {
          const entry = this.relayRoundHistory.B[roundIdx];
          revealData.teamB = {
            playerName: entry.playerName,
            playerColor: entry.playerColor,
            guess: entry.guess,
            runningTotal: entry.runningTotal,
            targetTime: this.settings.relayTarget,
            diff: Math.abs(entry.runningTotal - this.settings.relayTarget)
          };
        }

        this.broadcast('relay:revealRound', revealData);
      }, delay));

      delay += 2500;
    }

    this.relayRevealTimeouts.push(setTimeout(() => {
      const finalTallyA = this.relayTeamTallies.A / 1000;
      const finalTallyB = this.relayTeamTallies.B / 1000;
      const diffA = Math.abs(finalTallyA - this.settings.relayTarget);
      const diffB = Math.abs(finalTallyB - this.settings.relayTarget);

      let winner = null;
      if (diffA < diffB) winner = 'A';
      else if (diffB < diffA) winner = 'B';

      this.state = 'GAME_OVER';

      this.broadcast('relay:finalReveal', {
        targetTime: this.settings.relayTarget,
        teamA: {
          finalTally: finalTallyA,
          diff: diffA,
          history: this.relayRoundHistory.A
        },
        teamB: {
          finalTally: finalTallyB,
          diff: diffB,
          history: this.relayRoundHistory.B
        },
        winner
      });
    }, delay + 1000));
  }

  clearTimeouts() {
    this.countdownTimeouts.forEach(t => clearTimeout(t));
    this.countdownTimeouts = [];
    if (this.blindTimeout) { clearTimeout(this.blindTimeout); this.blindTimeout = null; }
    this.relayRevealTimeouts.forEach(t => clearTimeout(t));
    this.relayRevealTimeouts = [];
  }

  cleanup() {
    this.clearTimeouts();
    if (this.destroyTimeout) clearTimeout(this.destroyTimeout);
  }
}

module.exports = Room;
