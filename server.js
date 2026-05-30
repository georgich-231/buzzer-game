const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const ANSWER_TIMER_MS = 30000;

const rooms = new Map();

function finishRound(code) {
  const room = rooms.get(code);
  if (!room) return;
  if (room.state.timerId) { clearTimeout(room.state.timerId); room.state.timerId = null; }

  const pts = [3, 2, 1];
  room.state.buzzOrder.forEach((b, i) => {
    const p = room.players.get(b.id);
    if (p) p.score += pts[i] ?? 0;
  });

  room.state.phase = 'round_results';
  room.state.timerEnd = null;
  io.to(code).emit('room-update', getRoomData(room));
}

function generateRoomCode() {
  return crypto.randomBytes(2).toString('hex').toUpperCase();
}

function getRoomData(room) {
  const { timerId, ...stateForClient } = room.state;
  return {
    players: Array.from(room.players.entries()).map(([id, p]) => ({
      id,
      name: p.name,
      score: p.score,
    })),
    state: stateForClient,
  };
}

io.on('connection', (socket) => {

  socket.on('create-room', ({ name }, cb) => {
    let code;
    do { code = generateRoomCode(); } while (rooms.has(code));

    const room = {
      adminId: socket.id,
      adminName: name,
      players: new Map(),
      state: { phase: 'lobby', round: 0, totalRounds: 5, buzzOrder: [] },
    };
    room.players.set(socket.id, { name, score: 0 });
    rooms.set(code, room);

    socket.join(code);
    socket.data.roomCode = code;
    socket.data.name = name;

    cb({ ok: true, code, isAdmin: true });
    io.to(code).emit('room-update', getRoomData(room));
  });

  socket.on('join-room', ({ code, name }, cb) => {
    const room = rooms.get(code);
    if (!room) return cb({ ok: false, error: 'Room not found' });
    if (room.state.phase !== 'lobby') return cb({ ok: false, error: 'Game already started' });

    const taken = Array.from(room.players.values()).some(p => p.name.toLowerCase() === name.toLowerCase());
    if (taken) return cb({ ok: false, error: 'Name already taken' });

    room.players.set(socket.id, { name, score: 0 });
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.name = name;

    cb({ ok: true, code, isAdmin: false });
    io.to(code).emit('room-update', getRoomData(room));
  });

  socket.on('start-game', ({ totalRounds }) => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || room.adminId !== socket.id) return;
    if (room.players.size < 1) return;

    room.state = { phase: 'playing', round: 1, totalRounds: Number(totalRounds) || 5, buzzOrder: [] };
    io.to(code).emit('room-update', getRoomData(room));
  });

  socket.on('start-round', () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || room.adminId !== socket.id) return;
    if (room.state.phase !== 'playing') return;

    room.state.phase = 'round_active';
    room.state.buzzOrder = [];
    io.to(code).emit('room-update', getRoomData(room));
  });

  socket.on('buzz', () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || room.state.phase !== 'round_active') return;

    const alreadyBuzzed = room.state.buzzOrder.some(b => b.id === socket.id);
    if (alreadyBuzzed) return;

    const player = room.players.get(socket.id);
    if (!player) return;

    room.state.buzzOrder.push({ id: socket.id, name: player.name, time: Date.now() });
    io.to(code).emit('buzz-update', room.state.buzzOrder);
  });

  socket.on('end-round', () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || room.adminId !== socket.id) return;
    if (room.state.phase !== 'round_active') return;

    room.state.phase = 'round_timer';
    room.state.timerEnd = Date.now() + ANSWER_TIMER_MS;
    room.state.timerId = setTimeout(() => finishRound(code), ANSWER_TIMER_MS);
    io.to(code).emit('room-update', getRoomData(room));
  });

  socket.on('already-answered', () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || room.adminId !== socket.id) return;
    if (room.state.phase !== 'round_timer') return;
    finishRound(code);
  });

  socket.on('next-round', () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || room.adminId !== socket.id) return;

    if (room.state.round >= room.state.totalRounds) {
      room.state.phase = 'game_over';
    } else {
      room.state.round += 1;
      room.state.phase = 'playing';
      room.state.buzzOrder = [];
    }
    io.to(code).emit('room-update', getRoomData(room));
  });

  socket.on('restart-game', () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || room.adminId !== socket.id) return;

    room.players.forEach(p => p.score = 0);
    room.state = { phase: 'lobby', round: 0, totalRounds: 5, buzzOrder: [] };
    io.to(code).emit('room-update', getRoomData(room));
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    room.players.delete(socket.id);

    if (room.players.size === 0) {
      if (room.state.timerId) clearTimeout(room.state.timerId);
      rooms.delete(code);
      return;
    }

    // If admin left, assign new admin
    if (room.adminId === socket.id) {
      room.adminId = room.players.keys().next().value;
      io.to(room.adminId).emit('promoted-to-admin');
    }

    io.to(code).emit('room-update', getRoomData(room));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Buzzer running at http://localhost:${PORT}`));
