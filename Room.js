// ===== Room.js — Server-side game room state machine =====

const PLAYER_COLORS = [
  '#F0D330', // Holland Yellow (HY)
  '#F6A91B', // Dark Yellow (DY)
  '#E17539', // Orange (OR)
  '#E74C13', // Woods Orange (WO)
  '#C1237F', // Fuchsia (FU)
  '#6E222A', // Burgundy (BU)
  '#A0232B', // Dark Red (DR)
  '#662473', // Purple (PU)
  '#74BC3A', // Gecko Green (GC)
  '#21A83E', // Spring Green (SG)
  '#0E8497', // Teal (TE)
  '#0B564E', // Green (GR)
  '#094034', // Kentucky Green (KG)
  '#1AB0D4', // Arizona Turquoise (AT)
  '#208BCD', // Cyan (CY)
  '#2E4CA2', // Blue (BL)
  '#155A7E', // Cobalt Blue (CB)
  '#91969B', // Light Grey (LGY)
  '#3A2E1C', // Brown (BR)
  '#C9AD7B'  // Tan (TA)
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
      relayTarget: 30,           // target seconds for relay countdown
      relayRoundsPerPlayer: 2    // rounds per player for relay countdown
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
    this.teamColors = { A: '#3B82F6', B: '#EF4444' };

    // Relay Countdown state
    this.relayTeamTallies = { A: 0, B: 0 };
    this.relayTurnOrder = { A: [], B: [] };
    this.relayCurrentTurnIndex = { A: 0, B: 0 };
    this.relayRoundHistory = { A: [], B: [] };
    this.relayRevealTimeouts = [];
    this.relayTurnNumber = 1;
    this.relayTurnTarget = 3;
    this.relayRunningTargetSum = 3;
    this.relayGuessesThisTurn = { A: null, B: null };
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

    if (this.settings.teamMode) {
      const aCount = this.getTeamPlayers('A').length;
      const bCount = this.getTeamPlayers('B').length;
      this.teams[player.id] = aCount <= bCount ? 'A' : 'B';
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
      })),
      teamColors: this.teamColors
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
    if (settings.relayRoundsPerPlayer != null) this.settings.relayRoundsPerPlayer = parseInt(settings.relayRoundsPerPlayer) || 2;

    // Relay countdown requires team mode
    if (this.settings.gameMode === 'relaycountdown') {
      this.settings.teamMode = true;
    }

    // Swap if min > max
    if (this.settings.blindMin > this.settings.blindMax) {
      [this.settings.blindMin, this.settings.blindMax] = [this.settings.blindMax, this.settings.blindMin];
    }
    
    // Auto-assign teams to unassigned players when team mode is enabled
    if (this.settings.teamMode) {
      let updated = false;
      this.players.forEach(p => {
        if (!this.teams[p.id]) {
          const aCount = this.getTeamPlayers('A').length;
          const bCount = this.getTeamPlayers('B').length;
          this.teams[p.id] = aCount <= bCount ? 'A' : 'B';
          updated = true;
        }
      });
      if (updated) {
        this.broadcastPlayerList();
      }
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

  getTeamCaptainId(team) {
    if (team === 'A') {
      const host = this.players.find(p => p.isHost);
      return host ? host.id : null;
    } else {
      const firstB = this.players.find(p => this.teams[p.id] === 'B');
      return firstB ? firstB.id : null;
    }
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
            this.runBlindPreCountdown();
          } else {
            this.broadcast('round:play', {});
          }
        }, 700));
      }
    };

    this.countdownTimeouts.push(setTimeout(tick, 500));
  }

  runBlindPreCountdown() {
    let preCount = 3;
    this.broadcast('blind:preCountdownStart', {});

    const preTick = () => {
      if (preCount > 0) {
        this.broadcast('blind:preCountdownTick', { value: preCount });
        preCount--;
        this.countdownTimeouts.push(setTimeout(preTick, 1000));
      } else {
        this.startBlindTimer();
      }
    };

    preTick();
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
    this.relayTurnNumber = 1;
    this.relayTurnTarget = Math.min(3, this.settings.relayTarget || 30);
    this.relayRunningTargetSum = this.relayTurnTarget;
    this.relayGuessesThisTurn = { A: null, B: null };
    this.clearTimeouts();
    this.broadcast('game:returnToLobby', {});
    this.broadcastPlayerList();
  }

  // ===== RELAY COUNTDOWN MODE =====

  startRelayCountdown() {
    this.state = 'RELAY_PLAYING';
    this.relayTeamTallies = { A: 0, B: 0 };
    this.relayRoundHistory = { A: [], B: [] };
    this.relayCurrentTurnIndex = { A: 0, B: 0 };
    this.relayGuessesThisTurn = { A: null, B: null };

    this.relayTurnOrder = {
      A: this.getTeamPlayers('A').filter(p => p.connected).map(p => p.id),
      B: this.getTeamPlayers('B').filter(p => p.connected).map(p => p.id)
    };

    const playersPerTeam = Math.max(this.relayTurnOrder.A.length, this.relayTurnOrder.B.length);
    const roundsPerPlayer = this.settings.relayRoundsPerPlayer || 2;
    this.relayTotalRounds = Math.max(2, playersPerTeam * roundsPerPlayer);

    const S = this.settings.relayTarget || 30;
    const N = this.relayTotalRounds;

    // Minimum target duration for each round.
    // If S is small relative to N, scale M down dynamically so partition is mathematically possible.
    const M = Math.min(3.0, S / (N + 1));
    const R = S - N * M;

    this.relayRoundTargets = [];
    if (R > 0) {
      // Generate N-1 random cuts in the range [0, R]
      const cuts = [];
      for (let i = 0; i < N - 1; i++) {
        cuts.push(Math.random() * R);
      }
      cuts.sort((a, b) => a - b);

      let lastCut = 0;
      for (let i = 0; i < N - 1; i++) {
        const seg = cuts[i] - lastCut;
        this.relayRoundTargets.push(parseFloat((M + seg).toFixed(1)));
        lastCut = cuts[i];
      }
      const lastSeg = R - lastCut;
      this.relayRoundTargets.push(parseFloat((M + lastSeg).toFixed(1)));
    } else {
      // fallback if S is too small: partition equally
      const equalTime = S / N;
      for (let i = 0; i < N; i++) {
        this.relayRoundTargets.push(parseFloat(equalTime.toFixed(1)));
      }
    }

    // Ensure the sum adds up EXACTLY to S after decimal rounding
    let currentSum = this.relayRoundTargets.reduce((a, b) => a + b, 0);
    const diff = S - currentSum;
    if (Math.abs(diff) > 0.01) {
      this.relayRoundTargets[this.relayRoundTargets.length - 1] = parseFloat((this.relayRoundTargets[this.relayRoundTargets.length - 1] + diff).toFixed(1));
    }

    this.relayRunningTargetSum = S;

    this.relayTurnNumber = 1;
    this.relayTurnTarget = this.relayRoundTargets[0];

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
      }
    });

    this.sendRelayTurn('A');
    this.sendRelayTurn('B');
  }

  sendRelayTurn(team) {
    const turnOrder = this.relayTurnOrder[team];
    const currentIdx = this.relayCurrentTurnIndex[team];

    if (currentIdx >= turnOrder.length) {
      this.relayCurrentTurnIndex[team] = 0;
    }

    const idx = this.relayCurrentTurnIndex[team];
    const playerId = turnOrder[idx];
    const player = this.players.find(p => p.id === playerId);

    if (!player) return;

    this.io.to(player.socketId).emit('relay:yourTurn', {
      team,
      turnTarget: this.relayTurnTarget,
      turnNumber: this.relayTurnNumber
    });

    this.broadcast('relay:turnUpdate', {
      team,
      currentPlayerId: playerId,
      currentPlayerName: player.name,
      turnTarget: this.relayTurnTarget,
      turnNumber: this.relayTurnNumber
    });
  }

  handleRelayGuess(playerId, guessSeconds) {
    if (this.state !== 'RELAY_PLAYING') return;

    const team = this.teams[playerId];
    if (!team) return;

    // Check if already guessed this turn
    if (this.relayGuessesThisTurn[team] !== null) return;

    const player = this.players.find(p => p.id === playerId);
    if (!player) return;

    this.relayGuessesThisTurn[team] = {
      playerId,
      playerName: player.name,
      playerColor: player.color,
      guess: guessSeconds,
      target: this.relayTurnTarget
    };

    // Acknowledge the guess
    this.io.to(player.socketId).emit('relay:guessConfirmed', {
      guess: guessSeconds
    });

    // Notify everyone someone on the team completed their turn
    this.broadcast('relay:guessDone', {
      team,
      playerName: player.name,
      turnNumber: this.relayTurnNumber
    });

    // If both teams have guessed for this round, compile and advance
    if (this.relayGuessesThisTurn.A !== null && this.relayGuessesThisTurn.B !== null) {
      const guessA = this.relayGuessesThisTurn.A;
      const guessB = this.relayGuessesThisTurn.B;

      this.relayRoundHistory.A.push(guessA);
      this.relayRoundHistory.B.push(guessB);

      this.relayTeamTallies.A += guessA.guess;
      this.relayTeamTallies.B += guessB.guess;

      if (this.relayTurnNumber >= this.relayTotalRounds) {
        // Relay complete! Start reveal phase after a short delay
        this.countdownTimeouts.push(setTimeout(() => {
          this.startRelayReveal();
        }, 1500));
      } else {
        // Setup next turn
        this.relayGuessesThisTurn = { A: null, B: null };
        this.relayTurnNumber++;
        this.relayTurnTarget = this.relayRoundTargets[this.relayTurnNumber - 1];

        this.relayCurrentTurnIndex.A = (this.relayCurrentTurnIndex.A + 1) % this.relayTurnOrder.A.length;
        this.relayCurrentTurnIndex.B = (this.relayCurrentTurnIndex.B + 1) % this.relayTurnOrder.B.length;

        this.countdownTimeouts.push(setTimeout(() => {
          this.sendRelayTurn('A');
          this.sendRelayTurn('B');
        }, 1000));
      }
    }
  }

  startRelayReveal() {
    this.state = 'RELAY_REVEAL';
    this.relayRevealIndex = 0;
    const maxRounds = this.relayRoundHistory.A.length;

    this.broadcast('relay:revealStart', {
      targetTime: this.settings.relayTarget,
      totalRounds: maxRounds
    });
  }

  revealNextRound() {
    if (this.state !== 'RELAY_REVEAL') return;
    const maxRounds = this.relayRoundHistory.A.length;
    const roundIdx = this.relayRevealIndex;

    if (roundIdx < maxRounds) {
      const a = this.relayRoundHistory.A[roundIdx];
      const b = this.relayRoundHistory.B[roundIdx];

      const revealData = {
        roundNumber: roundIdx + 1,
        totalRounds: maxRounds,
        turnTarget: a.target,
        teamA: {
          playerName: a.playerName,
          playerColor: a.playerColor,
          guess: a.guess,
          diff: Math.abs(a.guess - a.target)
        },
        teamB: {
          playerName: b.playerName,
          playerColor: b.playerColor,
          guess: b.guess,
          diff: Math.abs(b.guess - b.target)
        }
      };

      this.broadcast('relay:revealRound', revealData);
      this.relayRevealIndex++;

      // Automatically trigger final results on next click after last round is revealed
      if (this.relayRevealIndex === maxRounds) {
        this.broadcast('relay:revealReadyForFinal', {});
      }
    } else {
      this.revealFinalResults();
    }
  }

  revealAutoRounds() {
    if (this.state !== 'RELAY_REVEAL') return;
    const maxRounds = this.relayRoundHistory.A.length;

    const autoTick = () => {
      if (this.state !== 'RELAY_REVEAL') return;
      if (this.relayRevealIndex < maxRounds) {
        this.revealNextRound();
        this.relayRevealTimeouts.push(setTimeout(autoTick, 2500));
      } else {
        this.relayRevealTimeouts.push(setTimeout(() => {
          this.revealFinalResults();
        }, 1500));
      }
    };

    autoTick();
  }

  revealFinalResults() {
    if (this.state !== 'RELAY_REVEAL') return;

    const finalTallyA = this.relayTeamTallies.A;
    const finalTallyB = this.relayTeamTallies.B;
    const totalTarget = this.relayRunningTargetSum;
    const diffA = Math.abs(finalTallyA - totalTarget);
    const diffB = Math.abs(finalTallyB - totalTarget);

    let winner = null;
    if (diffA < diffB) winner = 'A';
    else if (diffB < diffA) winner = 'B';

    this.state = 'GAME_OVER';

    this.broadcast('relay:finalReveal', {
      targetTime: totalTarget,
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
