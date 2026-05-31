const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const ANSWER_TIMER_MS = 30000;
const rooms = new Map();

const PRESETS_DIR = path.join(__dirname, 'data', 'presets');
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
fs.mkdirSync(PRESETS_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── Multer ──────────────────────────────────────────────────────────────────

const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname)),
});
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /^(image\/(jpeg|png|gif|webp)|video\/(mp4|webm|ogg))$/.test(file.mimetype);
    cb(null, ok);
  },
});

// ── Preset helpers ───────────────────────────────────────────────────────────

function listPresets() {
  return fs.readdirSync(PRESETS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, f), 'utf8'));
        return { id: p.id, name: p.name, questionCount: p.questions.length, createdAt: p.createdAt };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function getPreset(id) {
  const file = path.join(PRESETS_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function savePreset(preset) {
  fs.writeFileSync(path.join(PRESETS_DIR, `${preset.id}.json`), JSON.stringify(preset, null, 2));
}

function deletePresetFiles(id) {
  const preset = getPreset(id);
  if (!preset) return;
  preset.questions.forEach(q => {
    if (q.mediaFile) {
      const f = path.join(UPLOADS_DIR, q.mediaFile);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });
  const pfile = path.join(PRESETS_DIR, `${id}.json`);
  if (fs.existsSync(pfile)) fs.unlinkSync(pfile);
}

// ── REST API ─────────────────────────────────────────────────────────────────

app.get('/api/presets', (req, res) => res.json(listPresets()));

app.post('/api/presets', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  const preset = { id: uuidv4(), name, createdAt: new Date().toISOString(), questions: [] };
  savePreset(preset);
  res.json(preset);
});

app.get('/api/presets/:id', (req, res) => {
  const p = getPreset(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  res.json(p);
});

app.put('/api/presets/:id', (req, res) => {
  const p = getPreset(req.params.id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  if (req.body.name) p.name = req.body.name.trim();
  if (Array.isArray(req.body.questions)) p.questions = req.body.questions;
  savePreset(p);
  res.json(p);
});

app.delete('/api/presets/:id', (req, res) => {
  if (!getPreset(req.params.id)) return res.status(404).json({ error: 'Not found' });
  deletePresetFiles(req.params.id);
  res.json({ ok: true });
});

app.post('/api/presets/:id/upload', upload.single('media'), (req, res) => {
  if (!getPreset(req.params.id)) return res.status(404).json({ error: 'Preset not found' });
  if (!req.file) return res.status(400).json({ error: 'No valid file' });
  res.json({
    filename: req.file.filename,
    mediaType: req.file.mimetype.startsWith('video') ? 'video' : 'image',
  });
});

app.delete('/api/uploads/:filename', (req, res) => {
  const f = path.join(UPLOADS_DIR, path.basename(req.params.filename));
  if (fs.existsSync(f)) fs.unlinkSync(f);
  res.json({ ok: true });
});

// ── Room helpers ─────────────────────────────────────────────────────────────

function generateRoomCode() {
  return crypto.randomBytes(2).toString('hex').toUpperCase();
}

function blankPresetState() {
  return { presetId: null, presetName: null, presetQuestionCount: 0,
    currentQuestionIndex: null, currentQuestionText: null,
    currentQuestionMediaType: null, currentQuestionMediaFile: null };
}

function getRoomData(room) {
  const { timerId, timerEnd, ...stateForClient } = room.state;
  if (timerEnd !== null && timerEnd !== undefined) {
    stateForClient.timerMs = Math.max(0, timerEnd - Date.now());
  } else {
    stateForClient.timerMs = null;
  }
  return {
    players: Array.from(room.players.entries()).map(([id, p]) => ({
      id, name: p.name, score: p.score,
    })),
    state: stateForClient,
  };
}

function startAnswerTimer(code) {
  const room = rooms.get(code);
  if (!room) return;
  room.state.phase = 'round_timer';
  room.state.timerEnd = Date.now() + ANSWER_TIMER_MS;
  room.state.timerId = setTimeout(() => {
    const r = rooms.get(code);
    if (!r) return;
    r.state.timerId = null;
    r.state.timerEnd = null;
    r.state.phase = 'round_awarding';
    io.to(code).emit('room-update', getRoomData(r));
  }, ANSWER_TIMER_MS);
  io.to(code).emit('room-update', getRoomData(room));
}

// ── Socket.io ────────────────────────────────────────────────────────────────

io.on('connection', (socket) => {

  socket.on('create-room', ({ name }, cb) => {
    let code;
    do { code = generateRoomCode(); } while (rooms.has(code));
    const room = {
      adminId: socket.id,
      players: new Map(),
      state: {
        phase: 'lobby', round: 0, totalRounds: 5,
        buzzOrder: [], currentAnswererIndex: 0, timerEnd: null, timerId: null,
        ...blankPresetState(),
      },
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
    const { presetId, presetName, presetQuestionCount } = room.state;
    room.state = {
      phase: 'playing', round: 1, totalRounds: Number(totalRounds) || 5,
      buzzOrder: [], currentAnswererIndex: 0, timerEnd: null, timerId: null,
      presetId, presetName, presetQuestionCount,
      currentQuestionIndex: null, currentQuestionText: null,
      currentQuestionMediaType: null, currentQuestionMediaFile: null,
    };
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
    if (room.state.buzzOrder.some(b => b.id === socket.id)) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    room.state.buzzOrder.push({ id: socket.id, name: player.name, time: Date.now(), pointsAwarded: null });
    io.to(code).emit('buzz-update', room.state.buzzOrder);
  });

  socket.on('end-round', () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || room.adminId !== socket.id) return;
    if (room.state.phase !== 'round_active') return;
    if (room.state.buzzOrder.length === 0) {
      room.state.phase = 'round_results';
      io.to(code).emit('room-update', getRoomData(room));
      return;
    }
    room.state.currentAnswererIndex = 0;
    startAnswerTimer(code);
  });

  socket.on('already-answered', () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || room.adminId !== socket.id) return;
    if (room.state.phase !== 'round_timer') return;
    if (room.state.timerId) { clearTimeout(room.state.timerId); room.state.timerId = null; }
    room.state.timerEnd = null;
    room.state.phase = 'round_awarding';
    io.to(code).emit('room-update', getRoomData(room));
  });

  socket.on('award-points', ({ points }) => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || room.adminId !== socket.id) return;
    if (room.state.phase !== 'round_awarding') return;
    const idx = room.state.currentAnswererIndex;
    const buzzer = room.state.buzzOrder[idx];
    if (buzzer) {
      const pts = Math.max(0, parseInt(points) || 0);
      buzzer.pointsAwarded = pts;
      const player = room.players.get(buzzer.id);
      if (player) player.score += pts;
    }
    const nextIdx = idx + 1;
    if (nextIdx < room.state.buzzOrder.length) {
      room.state.currentAnswererIndex = nextIdx;
      startAnswerTimer(code);
    } else {
      room.state.phase = 'round_results';
      room.state.currentAnswererIndex = null;
      room.state.timerEnd = null;
      io.to(code).emit('room-update', getRoomData(room));
    }
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
      room.state.currentAnswererIndex = 0;
    }
    room.state.currentQuestionIndex = null;
    room.state.currentQuestionText = null;
    room.state.currentQuestionMediaType = null;
    room.state.currentQuestionMediaFile = null;
    io.to(code).emit('room-update', getRoomData(room));
  });

  socket.on('restart-game', () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || room.adminId !== socket.id) return;
    room.players.forEach(p => p.score = 0);
    room.state = {
      phase: 'lobby', round: 0, totalRounds: 5,
      buzzOrder: [], currentAnswererIndex: 0, timerEnd: null, timerId: null,
      ...blankPresetState(),
    };
    io.to(code).emit('room-update', getRoomData(room));
  });

  // ── Preset socket events ─────────────────────────────────────────────────

  socket.on('load-preset', ({ presetId }) => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || room.adminId !== socket.id) return;
    const preset = getPreset(presetId);
    if (!preset) return;
    room.state.presetId = preset.id;
    room.state.presetName = preset.name;
    room.state.presetQuestionCount = preset.questions.length;
    room.state.currentQuestionIndex = null;
    room.state.currentQuestionText = null;
    room.state.currentQuestionMediaType = null;
    room.state.currentQuestionMediaFile = null;
    io.to(code).emit('room-update', getRoomData(room));
  });

  socket.on('unload-preset', () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || room.adminId !== socket.id) return;
    Object.assign(room.state, blankPresetState());
    io.to(code).emit('room-update', getRoomData(room));
  });

  socket.on('show-question', ({ index }) => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || room.adminId !== socket.id) return;
    if (!room.state.presetId) return;
    const preset = getPreset(room.state.presetId);
    if (!preset) return;
    const q = preset.questions[index];
    if (!q) return;
    room.state.currentQuestionIndex = index;
    room.state.currentQuestionText = q.text;
    room.state.currentQuestionMediaType = q.mediaType || null;
    room.state.currentQuestionMediaFile = q.mediaFile || null;
    io.to(code).emit('room-update', getRoomData(room));
  });

  socket.on('clear-question', () => {
    const code = socket.data.roomCode;
    const room = rooms.get(code);
    if (!room || room.adminId !== socket.id) return;
    room.state.currentQuestionIndex = null;
    room.state.currentQuestionText = null;
    room.state.currentQuestionMediaType = null;
    room.state.currentQuestionMediaFile = null;
    io.to(code).emit('room-update', getRoomData(room));
  });

  // ── Disconnect ───────────────────────────────────────────────────────────

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
    if (room.adminId === socket.id) {
      room.adminId = room.players.keys().next().value;
      io.to(room.adminId).emit('promoted-to-admin');
    }
    io.to(code).emit('room-update', getRoomData(room));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Buzzer running at http://localhost:${PORT}`));
