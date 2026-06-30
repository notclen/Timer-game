// ===== server.js — Time Attack Multiplayer Server =====

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const Room = require('./Room');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Serve static files from the root directory (where index.html is)
app.use(express.static(__dirname));

// Fallback to serve index.html for root access
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const rooms = new Map(); // code → Room

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let code;
  do {
    code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (rooms.has(code));
  return code;
}

// ===== Socket.io Connection Handler =====
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id}`);

  // --- CREATE ROOM ---
  socket.on('room:create', ({ playerName, settings }) => {
    const code = generateRoomCode();
    const room = new Room(code, io);
    if (settings) {
      Object.assign(room.settings, settings);
    }
    rooms.set(code, room);
    const player = room.addPlayer(socket, playerName || 'Host', true);
    socket.emit('room:created', {
      code,
      playerId: player.id,
      settings: room.settings
    });
    console.log(`  Room ${code} created by ${playerName}`);
  });

  // --- JOIN ROOM ---
  socket.on('room:join', ({ code, playerName }) => {
    const roomCode = (code || '').toUpperCase().trim();
    const room = rooms.get(roomCode);

    if (!room) {
      socket.emit('room:error', { message: 'Room not found. Check the code and try again.' });
      return;
    }

    // Reconnection attempt
    if (room.state !== 'LOBBY') {
      const existing = room.players.find(p =>
        p.name.toLowerCase() === (playerName || '').toLowerCase() && !p.connected
      );
      if (existing) {
        room.reconnectPlayer(existing.id, socket);
        socket.emit('room:rejoined', {
          code: roomCode,
          playerId: existing.id,
          state: room.state,
          settings: room.settings,
          currentRound: room.currentRound,
          totalRounds: room.settings.totalRounds,
          scores: room.scores
        });
        console.log(`  ${playerName} reconnected to ${roomCode}`);
        return;
      }
      socket.emit('room:error', { message: 'Game already in progress.' });
      return;
    }

    if (room.players.length >= 12) {
      socket.emit('room:error', { message: 'Room is full (max 12 players).' });
      return;
    }

    if (room.players.find(p => p.name.toLowerCase() === (playerName || '').toLowerCase())) {
      socket.emit('room:error', { message: 'That name is already taken in this room.' });
      return;
    }

    const player = room.addPlayer(socket, playerName || 'Player', false);
    socket.emit('room:joined', {
      code: roomCode,
      playerId: player.id,
      settings: room.settings
    });
    console.log(`  ${playerName} joined ${roomCode}`);
  });

  // --- UPDATE SETTINGS (host only) ---
  socket.on('room:updateSettings', (settings) => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.playerId);
    if (!player || !player.isHost) return;
    room.updateSettings(settings);
  });

  // --- START GAME (host only) ---
  socket.on('game:start', () => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.playerId);
    if (!player || !player.isHost) return;
    if (!room.startGame()) {
      socket.emit('room:error', { message: 'Need at least 2 players to start.' });
    }
  });

  // --- BUZZER EVENTS ---
  socket.on('buzzer:start', () => {
    const room = rooms.get(socket.roomCode);
    if (room) room.handleBuzzerStart(socket.playerId);
  });

  socket.on('buzzer:stop', () => {
    const room = rooms.get(socket.roomCode);
    if (room) room.handleBuzzerStop(socket.playerId);
  });

  // --- BLIND GUESS ---
  socket.on('blind:guess', ({ guess }) => {
    const room = rooms.get(socket.roomCode);
    if (room) room.handleBlindGuess(socket.playerId, guess);
  });

  // --- NEXT ROUND / END (host only) ---
  socket.on('game:nextRound', () => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.playerId);
    if (!player || !player.isHost) return;
    room.nextRound();
  });

  socket.on('game:endEarly', () => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.playerId);
    if (!player || !player.isHost) return;
    room.endGame();
  });

  socket.on('game:playAgain', () => {
    const room = rooms.get(socket.roomCode);
    if (!room) return;
    const player = room.players.find(p => p.id === socket.playerId);
    if (!player || !player.isHost) return;
    room.returnToLobby();
  });

  // --- DISCONNECT ---
  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id}`);
    if (socket.roomCode) {
      const room = rooms.get(socket.roomCode);
      if (room) room.disconnectPlayer(socket.id);
    }
  });
});

// Clean up stale rooms every 60s
setInterval(() => {
  for (const [code, room] of rooms) {
    if (room.players.every(p => !p.connected) && Date.now() - room.lastActivity > 300000) {
      console.log(`[x] Cleaning up room ${code}`);
      room.cleanup();
      rooms.delete(code);
    }
  }
}, 60000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n⚡ Time Attack server running on http://localhost:${PORT}\n`);
});
