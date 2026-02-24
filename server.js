const WebSocket = require('ws');
const { randomInt } = require('crypto');

const PORT        = 8080;
const MAX_PLAYERS = 4;
const MIN_PLAYERS = 2;
const MAX_ROUNDS  = 5;
const JOIN_TIME   = 30; // secondes
const ROUND_TIME  = 15_000; // ms

const WORDS = [
  'chien','chat','maison','voiture','arbre',
  'soleil','lune','ordinateur','musique','livre',
  'ville','plage','montagne','école',
  'amour','amitié','rêve','mer','forêt','cinéma',
  'feu','eau','vent','terre','nuit','jour',
];

// ── Créer une room fraîche ────────────────────────────────────────────────────
function createRoom() {
  return {
    players:    [],  // { id, name, totalPoints, ws }
    round:      0,
    submissions:[],
    currentWord:null,
    usedWords:  new Set(),
    joinTimer:  null,
    roundTimer: null,
    status:     'lobby',  // 'lobby' | 'playing' | 'waiting'
    ending:     false,
  };
}

// ── Nettoyer tous les timers d'une room ───────────────────────────────────────
function clearRoomTimers(room) {
  if (room.joinTimer)  { clearInterval(room.joinTimer);  room.joinTimer  = null; }
  if (room.roundTimer) { clearTimeout(room.roundTimer);  room.roundTimer = null; }
}

// ── Réinitialiser une room pour une nouvelle partie (garder les joueurs) ──────
function resetRoom(room) {
  clearRoomTimers(room);
  room.round       = 0;
  room.submissions = [];
  room.currentWord = null;
  room.usedWords   = new Set();
  room.status      = 'lobby';
  room.ending      = false;
}

const rooms = {};
const wss = new WebSocket.Server({ port: PORT });
console.log(`WS server on ws://localhost:${PORT}`);

// ── Helpers broadcast ─────────────────────────────────────────────────────────
function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function broadcast(room, payload) {
  const msg = JSON.stringify(payload);
  room.players.forEach(p => {
    if (p.ws.readyState === WebSocket.OPEN) p.ws.send(msg);
  });
}

function broadcastPlayers(room) {
  broadcast(room, {
    type: 'players',
    players: room.players.map(p => ({ id: p.id, name: p.name })),
  });
}

// ── Lobby : countdown avant de lancer la partie ───────────────────────────────
function startLobby(roomId) {
  const room = rooms[roomId];
  if (!room || room.joinTimer) return; // déjà en cours

  let t = JOIN_TIME;
  room.joinTimer = setInterval(() => {
    if (!rooms[roomId]) { clearInterval(room.joinTimer); return; }
    broadcast(room, { type: 'joinCountdown', timeLeft: t });
    if (t <= 0) {
      clearInterval(room.joinTimer);
      room.joinTimer = null;
      if (room.players.length >= MIN_PLAYERS) {
        startRound(roomId);
      } else {
        startLobby(roomId); // relancer si pas assez
      }
      return;
    }
    t--;
  }, 1000);
}

// ── Round ─────────────────────────────────────────────────────────────────────
function startRound(roomId) {
  const room = rooms[roomId];
  if (!room || room.players.length < MIN_PLAYERS) return;

  room.round++;
  room.submissions = [];
  room.ending      = false;
  room.status      = 'playing';

  const available = WORDS.filter(w => !room.usedWords.has(w));
  const pool = available.length > 0 ? available : WORDS;
  room.currentWord = pool[randomInt(pool.length)];
  room.usedWords.add(room.currentWord);

  broadcast(room, {
    type: 'roundStart',
    round: room.round,
    currentWord: room.currentWord,
  });

  room.roundTimer = setTimeout(() => endRound(roomId), ROUND_TIME);
}

function endRound(roomId) {
  const room = rooms[roomId];
  if (!room || room.ending) return;
  room.ending = true;

  clearTimeout(room.roundTimer);
  room.roundTimer = null;

  // Comptage
  const counts = {};
  room.submissions.forEach(s => {
    if (s.word) counts[s.word] = (counts[s.word] || 0) + 1;
  });

  const results = room.players.map(p => {
    const sub = room.submissions.find(s => s.playerId === p.id);
    let points = 0;
    if (sub && sub.word && counts[sub.word] >= 2) points = 4;
    p.totalPoints += points;
    return { playerId: p.id, word: sub ? sub.word : '', points };
  });

  broadcast(room, { type: 'roundResult', results });

  const gameOver = room.round >= MAX_ROUNDS;
  if (gameOver) {
    const finalScores = room.players.map(p => ({ id: p.id, name: p.name, totalPoints: p.totalPoints }));
    broadcast(room, { type: 'gameOver', finalScores });
    // Ne pas delete la room — réinitialiser pour permettre une nouvelle partie
    resetRoom(room);
    broadcastPlayers(room);
    // Relancer le lobby pour les joueurs encore connectés
    if (room.players.length >= 1) {
      broadcast(room, { type: 'lobbyRestart' }); // signal client : nouvelle partie
      if (room.players.length >= MIN_PLAYERS) {
        startLobby(roomId);
      }
      // sinon les joueurs attendent que d'autres rejoignent
    }
  } else {
    setTimeout(() => startRound(roomId), 3000);
  }
}

// ── Gestion départ joueur ─────────────────────────────────────────────────────
function leaveRoom(roomId, playerId) {
  if (!roomId || !playerId) return;
  const room = rooms[roomId];
  if (!room) return;

  room.players = room.players.filter(p => p.id !== playerId);
  broadcastPlayers(room);

  // Salle vide → supprimer
  if (room.players.length === 0) {
    clearRoomTimers(room);
    delete rooms[roomId];
    return;
  }

  const enough = room.players.length >= MIN_PLAYERS;

  if (room.status === 'lobby') {
    if (!enough) {
      // Plus assez en lobby : stopper le countdown, attendre
      clearRoomTimers(room);
      broadcast(room, { type: 'waitingForPlayers' });
      room.status = 'waiting';
    }
    // Si encore assez → le countdown continue naturellement
  }

  if (room.status === 'playing') {
    if (enough) {
      // Partie continue — ne rien faire, le round en cours se termine normalement
    } else {
      // Moins de MIN_PLAYERS → stopper le round, attendre
      clearRoomTimers(room);
      room.submissions = [];
      room.ending      = false;
      room.status      = 'waiting';
      broadcast(room, { type: 'waitingForPlayers' });
    }
  }

  if (room.status === 'waiting') {
    // Déjà en attente, rien de plus à faire
  }
}

// ── Connexion WebSocket ───────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  let roomId   = null;
  let playerId = null;

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }

    // ── JOIN ────────────────────────────────────────────────────────────────
    if (data.type === 'join') {
      roomId   = data.roomId;
      playerId = data.playerId;

      if (!rooms[roomId]) rooms[roomId] = createRoom();
      const room = rooms[roomId];

      if (room.players.length >= MAX_PLAYERS) {
        send(ws, { type: 'roomFull' });
        ws.close();
        return;
      }

      // Reconnexion ou nouveau joueur
      const existing = room.players.find(p => p.id === playerId);
      if (existing) {
        existing.ws   = ws;
        existing.name = data.name;
      } else {
        room.players.push({ id: playerId, name: data.name, totalPoints: 0, ws });
      }

      broadcastPlayers(room);

      // Informer ce joueur du statut actuel
      if (room.status === 'playing') {
        // Partie en cours — le joueur rejoignant voit l'écran d'attente
        // Il recevra roundStart au prochain round
        send(ws, { type: 'waitingForPlayers' });
      } else if (room.status === 'waiting') {
        // En attente d'un deuxième joueur
        if (room.players.length >= MIN_PLAYERS) {
          // Assez de joueurs — lancer une nouvelle partie
          room.status = 'lobby';
          broadcast(room, { type: 'newPartyReady' });
          startLobby(roomId);
        } else {
          send(ws, { type: 'waitingForPlayers' });
        }
      } else {
        // Lobby normal
        startLobby(roomId);
      }
    }

    // ── WORD ────────────────────────────────────────────────────────────────
    if (data.type === 'word') {
      const room = rooms[roomId];
      if (!room || room.status !== 'playing') return;
      if (room.submissions.find(s => s.playerId === playerId)) return; // déjà soumis

      room.submissions.push({ playerId, word: data.word.trim().toLowerCase() });

      const realSubs = room.submissions.filter(s => s.word !== '');
      if (realSubs.length === room.players.length) endRound(roomId);
    }

    // ── LEAVE ───────────────────────────────────────────────────────────────
    if (data.type === 'leave') {
      leaveRoom(roomId, playerId);
      roomId = playerId = null;
    }
  });

  ws.on('close', () => leaveRoom(roomId, playerId));
});