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
      gameMode: 'timeattack',
      totalRounds: 3,
      timeMode: 'random',
      customTime: 4.0,
      blindMin: 3,
      blindMax: 15
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
  }

  getConnectedPlayers() {
    return this.players.filter(p => p.connected);
  }

  broadcastPlayerList() {
    this.broadcast('room:playerList', {
      players: this.players.map(p => ({
        id: p.id, name: p.name, color: p.color,
        connected: p.connected, isHost: p.isHost
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
    // Swap if min > max
    if (this.settings.blindMin > this.settings.blindMax) {
      [this.settings.blindMin, this.settings.blindMax] = [this.settings.blindMax, this.settings.blindMin];
    }
    this.broadcast('room:settingsUpdated', { settings: this.settings });
  }

  // ===== GAME FLOW =====

  startGame() {
    if (this.getConnectedPlayers().length < 2) return false;
    if (this.state !== 'LOBBY') return false;

    this.currentRound = 0;
    this.scores = {};
    this.history = [];
    this.players.forEach(p => { this.scores[p.id] = 0; });

    this.broadcast('game:started', { settings: this.settings });
    this.startNewRound();
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

    // Only send target time for timeattack mode
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
    if (this.buzzerTimestamps[playerId]) return; // Already started
    this.buzzerTimestamps[playerId] = { start: Date.now(), stop: null };
    const player = this.players.find(p => p.id === playerId);
    if (player) {
      this.io.to(player.socketId).emit('buzzer:ack', { action: 'started' });
    }
  }

  handleBuzzerStop(playerId) {
    if (this.state !== 'PLAYING') return;
    const ts = this.buzzerTimestamps[playerId];
    if (!ts || !ts.start || ts.stop) return; // Not started or already stopped
    ts.stop = Date.now();

    const elapsed = ts.stop - ts.start;
    const result = this.recordResult(playerId, elapsed);

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
    // Don't allow double guess
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
      points
    };

    this.roundResults.push(result);
    if (!this.scores[playerId]) this.scores[playerId] = 0;
    this.scores[playerId] += points;
    return result;
  }

  checkAllPlayersDone() {
    const connected = this.getConnectedPlayers();

    // Auto-submit zero for disconnected players who haven't submitted
    this.players.forEach(p => {
      if (!p.connected && !this.roundResults.find(r => r.playerId === p.id)) {
        this.recordResult(p.id, 0);
      }
    });

    // Check if all connected players have submitted
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

    this.broadcast('round:results', {
      roundNum: this.currentRound,
      totalRounds: this.settings.totalRounds,
      targetTime: this.targetTime,
      gameMode: this.settings.gameMode,
      results: sorted,
      leaderboard,
      isGameComplete
    });
  }

  getSortedLeaderboard() {
    return this.players.map(p => ({
      playerId: p.id,
      name: p.name,
      color: p.color,
      totalScore: this.scores[p.id] || 0
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
    this.broadcast('game:final', { leaderboard, history: this.history });
  }

  returnToLobby() {
    this.state = 'LOBBY';
    this.currentRound = 0;
    this.roundResults = [];
    this.scores = {};
    this.history = [];
    this.players.forEach(p => { this.scores[p.id] = 0; });
    this.clearTimeouts();
    this.broadcast('game:returnToLobby', {});
    this.broadcastPlayerList();
  }

  clearTimeouts() {
    this.countdownTimeouts.forEach(t => clearTimeout(t));
    this.countdownTimeouts = [];
    if (this.blindTimeout) { clearTimeout(this.blindTimeout); this.blindTimeout = null; }
  }

  cleanup() {
    this.clearTimeouts();
    if (this.destroyTimeout) clearTimeout(this.destroyTimeout);
  }
}

module.exports = Room;
