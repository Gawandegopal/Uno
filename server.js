/**
 * UNO Multiplayer Server — single file app
 *
 * Setup:
 *   npm install express socket.io
 *   node server.js
 *
 * Open http://localhost:3000 in multiple browser tabs/devices.
 */
'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const PERSIST_DIR = path.join(__dirname, 'playing_folder');
fs.mkdirSync(PERSIST_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html')));

// ---------------------------------------------------------------------------
// Game helpers
// ---------------------------------------------------------------------------
const COLORS = ['R', 'G', 'B', 'Y'];
const VALUES = ['0','1','2','3','4','5','6','7','8','9','Skip','Reverse','Draw2'];

let uid = 0;
function makeCard(color, value) {
  return { id: ++uid, color, value }; // color 'W' for wilds
}

function buildDeck() {
  const deck = [];
  for (const c of COLORS) {
    deck.push(makeCard(c, '0'));
    for (let i = 1; i < VALUES.length; i++) {
      deck.push(makeCard(c, VALUES[i]));
      deck.push(makeCard(c, VALUES[i]));
    }
  }
  for (let i = 0; i < 4; i++) deck.push(makeCard('W', 'Wild'));
  for (let i = 0; i < 4; i++) deck.push(makeCard('W', 'Wild4'));
  return deck; // 108 cards
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const rooms = new Map(); // roomId -> room

function log(room, msg) {
  room.logs.push({ t: new Date().toISOString(), msg });
  saveRoom(room);
}

function saveRoom(room) {
  try {
    const data = {
      roomId: room.id,
      hostId: room.hostId,
      started: room.started,
      winner: room.winner,
      direction: room.direction,
      turnIndex: room.turnIndex,
      activeColor: room.activeColor,
      players: room.players.map(p => ({
        id: p.id, name: p.name, isHost: p.isHost, unoCalled: p.unoCalled,
        handCount: p.hand.length, hand: p.hand,
      })),
      deckCount: room.deck.length,
      deck: room.deck,
      discard: room.discard,
      logs: room.logs,
    };
    fs.writeFileSync(path.join(PERSIST_DIR, `room_${room.id}.json`), JSON.stringify(data, null, 2));
  } catch (e) { console.error('persist error', e); }
}

function playerIndex(room, socketId) {
  return room.players.findIndex(p => p.id === socketId);
}

function drawCards(room, player, n) {
  for (let i = 0; i < n; i++) {
    if (room.deck.length === 0) {
      // reshuffle discard pile except top card
      const top = room.discard.pop();
      room.deck = shuffle(room.discard);
      room.discard = top ? [top] : [];
    }
    if (room.deck.length === 0) break;
    player.hand.push(room.deck.pop());
  }
  player.unoCalled = false;
}

function topCard(room) { return room.discard[room.discard.length - 1]; }

function effectiveColor(room) {
  const t = topCard(room);
  return t.color === 'W' ? (room.activeColor || 'W') : t.color;
}

function canPlay(room, card) {
  const t = topCard(room);
  if (card.color === 'W') return true;
  const color = effectiveColor(room);
  if (card.color === color) return true;
  if (card.value === t.value) return true;
  return false;
}

function advance(room, steps = 1) {
  const n = room.players.length;
  room.turnIndex = ((room.turnIndex + room.direction * steps) % n + n) % n;
}

// Public state tailored per recipient: your own hand is visible, others counts.
function publicState(room, forSocketId) {
  return {
    id: room.id,
    hostId: room.hostId,
    started: room.started,
    winner: room.winner,
    direction: room.direction,
    turnIndex: room.turnIndex,
    activeColor: room.activeColor,
    pendingColor: !!room.pendingColor,
    canChooseColor: room.pendingWild ? room.pendingWild.by === forSocketId : false,
    myTurn: room.players[room.turnIndex] ? room.players[room.turnIndex].id === forSocketId : false,
    top: topCard(room) || null,
    deckCount: room.deck.length,
    players: room.players.map(p => ({
      id: p.id, name: p.name, isHost: p.isHost, unoCalled: p.unoCalled,
      handCount: p.hand.length,
      hand: p.id === forSocketId ? p.hand : undefined,
    })),
    logs: room.logs.slice(-60),
  };
}

function broadcast(room) {
  for (const p of room.players) {
    io.to(p.id).emit('state', publicState(room, p.id));
  }
  saveRoom(room);
}

function currentPlayer(room) { return room.players[room.turnIndex]; }

// ---------------------------------------------------------------------------
// UNO penalty timer
// ---------------------------------------------------------------------------
function scheduleUnoPenalty(room, player) {
  clearTimeout(player.unoTimer);
  player.unoTimer = setTimeout(() => {
    if (!player.unoCalled && player.hand.length === 1 && room.started && !room.winner) {
      drawCards(room, player, 2);
      log(room, `⚠️ ${player.name} forgot to call UNO — +2 cards`);
      broadcast(room);
    }
  }, 3000);
}

// ---------------------------------------------------------------------------
// Socket.IO
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  socket.on('create-room', ({ name }) => {
    const id = Math.random().toString(36).slice(2, 7).toUpperCase();
    const room = {
      id, hostId: socket.id, started: false, winner: null,
      direction: 1, turnIndex: 0, activeColor: null, pendingColor: false,
      players: [{ id: socket.id, name: name || 'Host', isHost: true, hand: [], unoCalled: false }],
      deck: [], discard: [], logs: [],
    };
    rooms.set(id, room);
    socket.join(id);
    socket.data.roomId = id;
    log(room, `${name} created the room`);
    broadcast(room);
  });

  socket.on('join-room', ({ name, roomId }) => {
    const room = rooms.get((roomId || '').toUpperCase());
    if (!room) return socket.emit('error-msg', 'Room not found');
    if (room.started) return socket.emit('error-msg', 'Game already started');
    room.players.push({ id: socket.id, name: name || 'Player', isHost: false, hand: [], unoCalled: false });
    socket.join(room.id);
    socket.data.roomId = room.id;
    log(room, `${name} joined`);
    broadcast(room);
  });

  socket.on('start-game', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || room.hostId !== socket.id) return;
    if (room.players.length < 2) return socket.emit('error-msg', 'Need at least 2 players');
    room.deck = shuffle(buildDeck());
    room.discard = [];
    room.direction = 1; room.turnIndex = 0; room.winner = null; room.activeColor = null; room.pendingColor = false;
    for (const p of room.players) { p.hand = []; p.unoCalled = false; drawCards(room, p, 7); }
    let first = room.deck.pop();
    while (first.color === 'W') { room.deck.unshift(first); shuffle(room.deck); first = room.deck.pop(); }
    room.discard.push(first);
    room.activeColor = first.color;
    room.started = true;
    log(room, `Game started. First card: ${first.color} ${first.value}`);
    applyInitialAction(room, first);
    broadcast(room);
  });

  socket.on('play-card', ({ cardId }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || !room.started || room.winner || room.pendingColor) return;
    const idx = playerIndex(room, socket.id);
    if (idx !== room.turnIndex) return socket.emit('error-msg', 'Not your turn');
    const p = room.players[idx];
    const ci = p.hand.findIndex(c => c.id === cardId);
    if (ci < 0) return;
    const card = p.hand[ci];
    if (!canPlay(room, card)) return socket.emit('error-msg', 'Illegal card');

    p.hand.splice(ci, 1);
    room.discard.push(card);
    room.mustPassOrPlay = null;
    log(room, `${p.name} played ${card.color === 'W' ? card.value : card.color + ' ' + card.value}`);

    // UNO check: going down to 1 card
    if (p.hand.length === 1) {
      if (p.unoCalled) log(room, `${p.name} called UNO!`);
      else scheduleUnoPenalty(room, p);
    }
    if (p.hand.length > 1) p.unoCalled = false;

    if (p.hand.length === 0) {
      room.winner = p.name;
      log(room, `🎉 ${p.name} wins!`);
      broadcast(room);
      return;
    }

    if (card.color === 'W') {
      room.pendingColor = true;
      room.pendingWild = { draw4: card.value === 'Wild4', by: p.id };
      room.activeColor = 'W';
      broadcast(room);
      return;
    }

    room.activeColor = card.color;
    applyCardEffect(room, card, p);
    broadcast(room);
  });

  socket.on('choose-color', ({ color }) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || !room.pendingColor || !room.pendingWild) return;
    if (room.pendingWild.by !== socket.id) return;
    if (!COLORS.includes(color)) return;
    room.activeColor = color;
    room.pendingColor = false;
    room.mustPassOrPlay = null;
    const { draw4 } = room.pendingWild;
    room.pendingWild = null;
    log(room, `Color chosen: ${color}`);
    if (draw4) {
      // target is the next player from the wild player
      const wIdx = playerIndex(room, socket.id);
      let tIdx = (wIdx + room.direction + room.players.length) % room.players.length;
      drawCards(room, room.players[tIdx], 4);
      log(room, `${room.players[tIdx].name} draws 4 and is skipped`);
      room.turnIndex = (wIdx + room.direction * 2) % room.players.length;
      if (room.turnIndex < 0) room.turnIndex += room.players.length;
    } else {
      advance(room);
    }
    broadcast(room);
  });

  socket.on('draw-card', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || !room.started || room.winner || room.pendingColor) return;
    const idx = playerIndex(room, socket.id);
    if (idx !== room.turnIndex) return socket.emit('error-msg', 'Not your turn');
    const p = room.players[idx];
    drawCards(room, p, 1);
    const drawn = p.hand[p.hand.length - 1];
    log(room, `${p.name} drew a card`);
    if (canPlay(room, drawn)) {
      room.mustPassOrPlay = p.id;
      socket.emit('can-play-drawn', { cardId: drawn.id });
    } else {
      room.mustPassOrPlay = p.id;
      socket.emit('must-pass', {});
      // auto-advance after nothing played: require pass click
    }
    broadcast(room);
  });

  socket.on('pass-turn', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const idx = playerIndex(room, socket.id);
    if (idx !== room.turnIndex || room.mustPassOrPlay !== socket.id) return;
    room.mustPassOrPlay = null;
    log(room, `${room.players[idx].name} passed`);
    advance(room);
    broadcast(room);
  });

  socket.on('call-uno', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const p = room.players[playerIndex(room, socket.id)];
    if (!p) return;
    p.unoCalled = true;
    clearTimeout(p.unoTimer);
    log(room, `${p.name} calls UNO!`);
    broadcast(room);
  });

  // --- Host admin controls ---
  function isHost(room) { return room && room.hostId === socket.id; }

  socket.on('kick-player', ({ targetId }) => {
    const room = rooms.get(socket.data.roomId);
    if (!isHost(room)) return;
    const i = playerIndex(room, targetId);
    if (i < 0 || room.players[i].isHost) return;
    const [gone] = room.players.splice(i, 1);
    log(room, `⛔ ${gone.name} was kicked by host`);
    io.to(gone.id).emit('kicked');
    const s = io.sockets.sockets.get(gone.id);
    if (s) { s.leave(room.id); s.data.roomId = null; }
    if (room.turnIndex >= room.players.length) room.turnIndex = 0;
    else if (i < room.turnIndex) room.turnIndex--;
    if (room.players.length < 2 && room.started) { room.started = false; room.winner = null; log(room, 'Not enough players, game reset'); }
    broadcast(room);
  });

  socket.on('force-skip', ({ targetId }) => {
    const room = rooms.get(socket.data.roomId);
    if (!isHost(room) || !room.started) return;
    const i = playerIndex(room, targetId);
    if (i < 0) return;
    log(room, `⏭ Host force-skipped ${room.players[i].name}'s turn`);
    if (i === room.turnIndex) advance(room);
    room.mustPassOrPlay = null;
    broadcast(room);
  });

  socket.on('force-draw', ({ targetId, count }) => {
    const room = rooms.get(socket.data.roomId);
    if (!isHost(room)) return;
    const p = room.players[playerIndex(room, targetId)];
    if (!p) return;
    const n = Math.max(1, Math.min(20, count || 2));
    drawCards(room, p, n);
    log(room, `🃏 Host forced ${p.name} to draw ${n} card(s)`);
    broadcast(room);
  });

  socket.on('reset-game', () => {
    const room = rooms.get(socket.data.roomId);
    if (!isHost(room)) return;
    room.started = false; room.winner = null; room.discard = []; room.deck = [];
    for (const p of room.players) { p.hand = []; p.unoCalled = false; }
    log(room, 'Game reset by host');
    broadcast(room);
  });

  // --- WebRTC signaling ---
  socket.on('webrtc-join', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    socket.to(room.id).emit('webrtc-join', { from: socket.id });
  });
  socket.on('webrtc-leave', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    socket.to(room.id).emit('webrtc-leave', { from: socket.id });
  });
  socket.on('webrtc-offer', ({ to, sdp }) => io.to(to).emit('webrtc-offer', { from: socket.id, sdp }));
  socket.on('webrtc-answer', ({ to, sdp }) => io.to(to).emit('webrtc-answer', { from: socket.id, sdp }));
  socket.on('webrtc-ice', ({ to, candidate }) => io.to(to).emit('webrtc-ice', { from: socket.id, candidate }));

  socket.on('disconnect', () => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const i = playerIndex(room, socket.id);
    if (i >= 0) {
      const [gone] = room.players.splice(i, 1);
      log(room, `${gone.name} disconnected`);
      socket.to(room.id).emit('webrtc-leave', { from: socket.id });
      if (room.players.length === 0) { rooms.delete(room.id); return; }
      if (room.hostId === socket.id) { room.players[0].isHost = true; room.hostId = room.players[0].id; }
      if (room.turnIndex >= room.players.length) room.turnIndex = 0;
      if (i < room.turnIndex) room.turnIndex--;
      if (room.players.length < 2 && room.started) room.started = false;
      broadcast(room);
    }
  });
});

function nextAfter(room) {
  const n = room.players.length;
  return (room.turnIndex + room.direction + n) % n;
}

function applyInitialAction(room, card) {
  const n = room.players.length;
  if (card.value === 'Skip') {
    log(room, 'First card Skip: first player skipped');
    room.turnIndex = (room.turnIndex + room.direction) % n;
  } else if (card.value === 'Reverse') {
    if (n === 2) { room.turnIndex = (room.turnIndex + 1) % n; log(room, 'First card Reverse (2p): skip'); }
    else { room.direction *= -1; log(room, 'First card Reverse: direction flipped'); }
  } else if (card.value === 'Draw2') {
    drawCards(room, room.players[0], 2);
    room.turnIndex = 1 % n;
    log(room, 'First card Draw2: P1 draws 2');
  }
}

function applyCardEffect(room, card, player) {
  const n = room.players.length;
  const pi = playerIndex(room, player.id);
  if (card.value === 'Skip') {
    if (n === 2) { log(room, `${player.name} skipped the other player — goes again`); /* stay */ }
    else { advance(room); log(room, 'Next player skipped'); }
    if (n === 2) { /* current player goes again: no advance */ } else { /* already advanced past skipped */ }
    if (n !== 2) { /* turnIndex now at player after skipped... need one more */ }
    // Simplify: in >2p, skip means turnIndex moves two steps total.
    if (n !== 2) advance(room);
    return;
  }
  if (card.value === 'Reverse') {
    if (n === 2) { log(room, 'Reverse acts as Skip — same player continues'); return; }
    room.direction *= -1;
    log(room, 'Direction reversed');
    advance(room);
    return;
  }
  if (card.value === 'Draw2') {
    const ti = (pi + room.direction + n) % n;
    drawCards(room, room.players[ti], 2);
    log(room, `${room.players[ti].name} draws 2 and is skipped`);
    room.turnIndex = (pi + room.direction * 2 + n) % n;
    return;
  }
  advance(room);
}

server.listen(PORT, () => console.log('UNO server on http://localhost:' + PORT));
