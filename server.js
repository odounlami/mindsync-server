const WebSocket = require('ws');
const { randomInt } = require('crypto');

const PORT        = 8080;
const MAX_PLAYERS = 4;
const MIN_PLAYERS = 2;
const MAX_ROUNDS  = 5;
const JOIN_TIME   = 30_000; // 30s pour rejoindre
const ROUND_TIME  = 15_000; // 15s par round

const WORDS = [
  'chien','chat','maison','voiture','arbre',
  'soleil','lune','ordinateur','musique','livre',
  'ville','plage','montagne','école',
  'amour','amitié','rêve','mer','forêt','cinéma'
];

const rooms = {};

const wss = new WebSocket.Server({ port: PORT });
console.log(`WebSocket server running on ws://localhost:${PORT}`);

wss.on('connection', (ws) => {
  let currentRoomId  = null;
  let currentPlayerId = null;
  let roundTimer     = null;

  ws.on('message', (msg) => {
    const data = JSON.parse(msg.toString());

    // ── JOIN ──────────────────────────────────────────────────────────────────
    if (data.type === 'join') {
      currentRoomId   = data.roomId;
      currentPlayerId = data.playerId;

      if (!rooms[currentRoomId]) {
        rooms[currentRoomId] = {
          players:     [],
          submissions: [],
          round:       0,
          currentWord: null,
          joinTimer:   null,
          paused:      false, // vrai si on attend un joueur de remplacement
          usedWords:   new Set(), // mots déjà tirés — ne reviennent pas
        };
      }

      const room = rooms[currentRoomId];

      if (room.players.length >= MAX_PLAYERS) {
        ws.send(JSON.stringify({ type: 'roomFull' }));
        ws.close();
        return;
      }

      // Évite les doublons (reconnexion)
      if (!room.players.find(p => p.id === currentPlayerId)) {
        room.players.push({ id: currentPlayerId, name: data.name, totalPoints: 0, ws });
      } else {
        // Reconnexion : mettre à jour la socket
        const existing = room.players.find(p => p.id === currentPlayerId);
        if (existing) existing.ws = ws;
      }

      broadcastPlayers(currentRoomId);

      if (room.paused) {
        // La partie était suspendue — assez de joueurs pour reprendre
        if (room.players.length >= MIN_PLAYERS) {
          room.paused = false;
          broadcastAll(currentRoomId, { type: 'gameResumed' });
          // Relancer le round en cours (nouveau round depuis le suivant)
          setTimeout(() => startRound(currentRoomId), 3000);
        } else {
          // Toujours pas assez, informer le nouveau joueur qu'on attend
          ws.send(JSON.stringify({ type: 'waitingForPlayers' }));
        }
      } else {
        startJoinTimer(currentRoomId);
      }
    }

    // ── WORD ──────────────────────────────────────────────────────────────────
    if (data.type === 'word') {
      const room = rooms[currentRoomId];
      if (!room || room.paused) return;

      // Un seul envoi par joueur par round
      if (!room.submissions.find(s => s.playerId === currentPlayerId)) {
        room.submissions.push({
          playerId: currentPlayerId,
          word: data.word.trim().toLowerCase(),
        });
      }

      // Fin de round anticipée UNIQUEMENT si tous les joueurs ont soumis un vrai mot
      // Les mots vides (timeout) ne déclenchent pas la fin — on attend le setTimeout serveur
      const realSubmissions = room.submissions.filter(s => s.word !== '');
      if (realSubmissions.length === room.players.length) {
        endRound(currentRoomId);
      }
    }

    // ── LEAVE ─────────────────────────────────────────────────────────────────
    if (data.type === 'leave') {
      leaveRoom(currentRoomId, currentPlayerId);
    }
  });

  ws.on('close', () => {
    leaveRoom(currentRoomId, currentPlayerId);
  });

  // ── leaveRoom ───────────────────────────────────────────────────────────────
  function leaveRoom(roomId, playerId) {
    if (!roomId || !playerId) return;
    const room = rooms[roomId];
    if (!room) return;

    room.players = room.players.filter(p => p.id !== playerId);
    broadcastPlayers(roomId);

    const gameStarted = room.round > 0;

    if (room.players.length < MIN_PLAYERS) {
      // Stopper le timer de round en cours
      clearTimeout(roundTimer);
      roundTimer = null;

      if (!gameStarted) {
        // Partie pas encore commencée → reset du timer de lobby
        clearInterval(room.joinTimer);
        room.joinTimer = null;
        room.submissions = [];

        if (room.players.length === 0) {
          delete rooms[roomId]; // salle vide, on nettoie
        } else {
          // Relancer le countdown lobby pour attendre un autre joueur
          startJoinTimer(roomId);
        }
      } else {
        // Partie en cours → suspendre et attendre un remplaçant
        room.paused      = true;
        room.submissions = [];
        if (room.players.length > 0) {
          broadcastAll(roomId, { type: 'waitingForPlayers' });
        } else {
          delete rooms[roomId]; // plus personne, on nettoie
        }
      }
    }
    // Si room.players.length >= MIN_PLAYERS la partie continue normalement
  }

  // ── startJoinTimer ──────────────────────────────────────────────────────────
  function startJoinTimer(roomId) {
    const room = rooms[roomId];
    if (!room || room.joinTimer) return; // déjà en cours

    let timeLeft = JOIN_TIME / 1000;

    room.joinTimer = setInterval(() => {
      broadcastAll(roomId, { type: 'joinCountdown', timeLeft });

      if (timeLeft <= 0) {
        clearInterval(room.joinTimer);
        room.joinTimer = null;

        if (room.players.length < MIN_PLAYERS) {
          startJoinTimer(roomId); // reset si pas assez de joueurs
        } else {
          startRound(roomId);
        }
      }
      timeLeft--;
    }, 1000);
  }

  // ── startRound ──────────────────────────────────────────────────────────────
  function startRound(roomId) {
    const room = rooms[roomId];
    if (!room || room.players.length < MIN_PLAYERS) return;

    room.round      += 1;
    room.submissions = [];
    room.ending      = false; // reset guard

    // Piocher un mot non encore utilisé dans cette partie
    const available = WORDS.filter(w => !room.usedWords.has(w));
    const pool = available.length > 0 ? available : WORDS; // fallback si tous utilisés
    room.currentWord = pool[randomInt(pool.length)];
    room.usedWords.add(room.currentWord);

    broadcastAll(roomId, {
      type:        'roundStart',
      round:       room.round,
      roundTime:   ROUND_TIME,
      currentWord: room.currentWord,
    });

    roundTimer = setTimeout(() => endRound(roomId), ROUND_TIME);
  }

  // ── endRound ────────────────────────────────────────────────────────────────
  function endRound(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    // Guard contre double appel (setTimeout serveur + soumissions complètes simultanés)
    if (room.ending) return;
    room.ending = true;

    clearTimeout(roundTimer);
    roundTimer = null;

    // Comptage des mots non vides (insensible à la casse — déjà lowercased côté client)
    const counts = {};
    room.submissions.forEach(s => {
      if (s.word !== '') {
        counts[s.word] = (counts[s.word] || 0) + 1;
      }
    });

    const results = room.players.map(p => {
      const submission = room.submissions.find(s => s.playerId === p.id);
      let points = 0;

      // 4 pts si synchro (au moins un autre joueur a le même mot), sinon 0
      if (submission && submission.word !== '') {
        points = counts[submission.word] >= 2 ? 4 : 0;
      }

      p.totalPoints += points;
      return { playerId: p.id, word: submission ? submission.word : '', points };
    });

    broadcastAll(roomId, { type: 'roundResult', results });

    if (room.round >= MAX_ROUNDS || room.players.length < MIN_PLAYERS) {
      const finalScores = room.players.map(p => ({ name: p.name, totalPoints: p.totalPoints }));
      broadcastAll(roomId, { type: 'gameOver', finalScores });
      delete rooms[roomId];
    } else {
      setTimeout(() => startRound(roomId), 3000);
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function broadcastPlayers(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    const payload = { type: 'players', players: room.players.map(p => ({ id: p.id, name: p.name })) };
    broadcastAll(roomId, payload);
  }

  function broadcastAll(roomId, payload) {
    const room = rooms[roomId];
    if (!room) return;
    const msg = JSON.stringify(payload);
    room.players.forEach(p => {
      if (p.ws.readyState === WebSocket.OPEN) p.ws.send(msg);
    });
  }
});