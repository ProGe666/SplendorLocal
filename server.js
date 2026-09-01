'use strict';

// 单进程服务:HTTP 静态托管 + WebSocket(同端口)+ 内存房间管理 + 断线重连 + 定时清理

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const engine = require('./game/engine');
const cardDb = require('./data/cards.json');
const P = require('./public/protocol');

const ROOT = __dirname;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const MAX_PLAYERS = 4;
let BOT_DELAY = 900; // 机器人行动延迟(毫秒),测试可调小

const rooms = new Map(); // code -> room
const sessions = new Map(); // playerId -> { token, roomCode }

function randCode() {
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return s;
}

function newRoomCode() {
  let code = randCode();
  while (rooms.has(code)) code = randCode();
  return code;
}

function cleanName(name) {
  if (typeof name !== 'string') return null;
  const n = name.trim().slice(0, 12);
  return n.length ? n : null;
}

function playerSummary(room) {
  return room.players.map((p) => ({
    seat: p.seat,
    name: p.name,
    connected: p.isBot ? true : p.connected,
    isHost: p.isHost,
    isBot: !!p.isBot
  }));
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function findPlayer(room, playerId) {
  return room.players.find((p) => p.id === playerId);
}

function broadcastRoom(room, makeMsg) {
  for (const p of room.players) {
    if (!p.ws) continue;
    send(p.ws, makeMsg(p));
  }
}

function sendRoomSnapshot(room) {
  broadcastRoom(room, (p) => ({
    type: P.S.ROOM,
    code: room.code,
    phase: room.phase,
    options: room.options,
    players: playerSummary(room),
    you: p.seat
  }));
}

function sendGameSnapshots(room) {
  if (!room.game) return;
  broadcastRoom(room, (p) => ({ type: P.S.GAME, state: engine.viewFor(room.game, p.seat) }));
}

function touch(room) {
  room.updatedAt = Date.now();
}

function removePlayerFromRoom(room, playerId) {
  const idx = room.players.findIndex((p) => p.id === playerId);
  if (idx < 0) return;
  const wasHost = room.players[idx].isHost;
  room.players.splice(idx, 1);
  sessions.delete(playerId);
  if (room.players.length === 0) {
    rooms.delete(room.code);
    return;
  }
  if (wasHost) room.players[0].isHost = true;
  // 座位重排保持连续
  room.players.forEach((p, i) => (p.seat = i));
  if (room.phase === 'playing') {
    room.phase = 'finished'; // 有人中途离席,对局作废
    room.game = null;
    clearBotTimer(room);
  }
  touch(room);
  sendRoomSnapshot(room);
}

function closeRoom(room, reason) {
  clearBotTimer(room);
  broadcastRoom(room, () => ({ type: P.S.ROOM_CLOSED, reason }));
  for (const p of room.players) {
    if (p.ws) p.ws.roomCode = null;
    if (!p.isBot) sessions.delete(p.id);
  }
  rooms.delete(room.code);
}

// ---------------------------------------------------------------- http

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (urlPath === '/debug/rooms') {
    const info = [...rooms.values()].map((r) => ({
      code: r.code,
      phase: r.phase,
      gamePhase: r.game ? r.game.phase : null,
      current: r.game ? r.game.current : null,
      currentIsBot: r.game ? !!(r.players[r.game.current] && r.players[r.game.current].isBot) : null,
      pending: r.game && r.game.pending ? Object.keys(r.game.pending) : null,
      turnNo: r.game ? r.game.turnNo : null,
      players: r.players.map((p) => ({ name: p.name, seat: p.seat, bot: !!p.isBot, connected: p.isBot || p.connected })),
      idleSec: Math.round((Date.now() - r.updatedAt) / 1000),
      botTimerPending: !!r.botTimer,
      botFails: r.botFails || 0
    }));
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(info, null, 2));
    return;
  }
  let filePath;
  if (urlPath === '/data/cards.json') filePath = path.join(ROOT, 'data', 'cards.json');
  else filePath = path.join(ROOT, 'public', path.normalize(urlPath));
  if (!filePath.startsWith(path.join(ROOT, 'public')) && !filePath.startsWith(path.join(ROOT, 'data'))) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------------------------------------------------------------- ws 消息处理

function handleMessage(ws, msg) {
  const { type } = msg;
  if (type === P.C.PING) return send(ws, { type: P.S.PONG });

  if (type === P.C.HELLO) return handleHello(ws, msg);
  if (!ws.playerId) return send(ws, { type: P.S.ERROR, code: P.ERR.BAD_REQUEST, message: '请先发送 hello' });

  const room = ws.roomCode ? rooms.get(ws.roomCode) : null;

  switch (type) {
    case P.C.CREATE_ROOM:
      return handleCreateRoom(ws, msg);
    case P.C.JOIN_ROOM:
      return handleJoinRoom(ws, msg);
    case P.C.LEAVE_ROOM:
      return handleLeaveRoom(ws, room);
    case P.C.START_GAME:
      return handleStartGame(ws, msg, room);
    case P.C.RESTART:
      return handleRestart(ws, msg, room);
    case P.C.ABANDON_GAME:
      return handleAbandonGame(ws, room);
    case P.C.UPDATE_OPTIONS:
      return handleUpdateOptions(ws, msg, room);
    case P.C.ADD_BOT:
      return handleAddBot(ws, room);
    case P.C.REMOVE_BOT:
      return handleRemoveBot(ws, msg, room);
    case P.C.CLOSE_ROOM:
      return handleCloseRoom(ws, room);
    case P.C.ACTION:
      return handleAction(ws, msg, room);
    default:
      return send(ws, { type: P.S.ERROR, code: P.ERR.BAD_REQUEST, message: '未知消息类型' });
  }
}

function handleHello(ws, msg) {
  let session = null;
  if (msg.playerId && sessions.has(msg.playerId)) {
    const s = sessions.get(msg.playerId);
    if (s.token === msg.token) session = s;
  }
  if (!session) {
    const playerId = crypto.randomUUID();
    const token = crypto.randomBytes(16).toString('hex');
    sessions.set(playerId, { token, roomCode: null });
    ws.playerId = playerId;
    ws.token = token;
    ws.name = cleanName(msg.name) || '玩家' + randCode().slice(0, 2);
    send(ws, { type: P.S.WELCOME, playerId, token, name: ws.name });
    return;
  }
  // 重连:同身份新连接替换旧连接(last-wins)
  ws.playerId = msg.playerId;
  ws.token = session.token;
  if (cleanName(msg.name)) ws.name = cleanName(msg.name);
  send(ws, { type: P.S.WELCOME, playerId: msg.playerId, token: session.token, name: ws.name });
  const room = session.roomCode ? rooms.get(session.roomCode) : null;
  if (!room) return;
  const p = findPlayer(room, msg.playerId);
  if (!p) return;
  if (p.ws && p.ws !== ws) {
    p.ws.playerId = null;
    p.ws.close(4000, 'replaced');
  }
  p.ws = ws;
  p.connected = true;
  p.name = ws.name || p.name;
  ws.roomCode = room.code;
  sendRoomSnapshot(room);
  sendGameSnapshots(room);
  touch(room);
}

function kickFromCurrentRoom(ws) {
  const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
  if (!room) return;
  const p = findPlayer(room, ws.playerId);
  if (p) {
    p.ws = null;
    p.connected = false;
  }
  ws.roomCode = null;
  removePlayerFromRoom(room, ws.playerId);
}

function handleCreateRoom(ws, msg) {
  kickFromCurrentRoom(ws);
  const options = {
    cities: !!(msg.options && msg.options.cities),
    tradingPosts: !!(msg.options && msg.options.tradingPosts)
  };
  const code = newRoomCode();
  const room = {
    code,
    phase: 'lobby',
    options,
    players: [],
    game: null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  rooms.set(code, room);
  joinSeat(ws, room);
}

function joinSeat(ws, room) {
  const seat = room.players.length;
  room.players.push({
    id: ws.playerId,
    name: ws.name,
    token: ws.token,
    seat,
    connected: true,
    isHost: seat === 0,
    ws
  });
  ws.roomCode = room.code;
  sessions.set(ws.playerId, { token: ws.token, roomCode: room.code });
  touch(room);
  sendRoomSnapshot(room);
}

function handleJoinRoom(ws, msg) {
  const code = typeof msg.code === 'string' ? msg.code.trim().toUpperCase() : '';
  const room = rooms.get(code);
  if (!room) return send(ws, { type: P.S.ERROR, code: P.ERR.ROOM_NOT_FOUND, message: '房间不存在' });
  const existing = findPlayer(room, ws.playerId);
  if (existing) {
    // 离线/暂时离开后经链接回来:重新绑定连接
    if (existing.ws && existing.ws !== ws) {
      existing.ws.playerId = null;
      existing.ws.close(4000, 'replaced');
    }
    existing.ws = ws;
    existing.connected = true;
    ws.roomCode = room.code;
    sessions.set(ws.playerId, { token: ws.token, roomCode: room.code });
    touch(room);
    sendRoomSnapshot(room);
    sendGameSnapshots(room);
    return;
  }
  if (room.phase !== 'lobby') return send(ws, { type: P.S.ERROR, code: P.ERR.GAME_IN_PROGRESS, message: '游戏已开始,无法加入' });
  if (room.players.length >= MAX_PLAYERS) return send(ws, { type: P.S.ERROR, code: P.ERR.ROOM_FULL, message: '房间已满' });
  kickFromCurrentRoom(ws);
  joinSeat(ws, room);
}

function handleLeaveRoom(ws, room) {
  if (!room || !findPlayer(room, ws.playerId)) return;
  if (room.phase === 'playing') {
    // 对局中"离开"= 离线挂起:保留座位,可随时通过邀请链接回来
    const p = findPlayer(room, ws.playerId);
    if (p.ws === ws) {
      p.ws = null;
      p.connected = false;
      touch(room);
      sendRoomSnapshot(room);
    }
    ws.roomCode = null;
    return;
  }
  kickFromCurrentRoom(ws);
}

function handleAbandonGame(ws, room) {
  if (!room) return send(ws, { type: P.S.ERROR, code: P.ERR.ROOM_NOT_FOUND, message: '不在房间中' });
  const p = findPlayer(room, ws.playerId);
  if (!p || !p.isHost) return send(ws, { type: P.S.ERROR, code: P.ERR.NOT_HOST, message: '只有房主可以作废本局' });
  if (room.phase !== 'playing') return send(ws, { type: P.S.ERROR, code: P.ERR.INVALID_ACTION, message: '当前没有进行中的对局' });
  room.phase = 'lobby';
  room.game = null;
  clearBotTimer(room);
  touch(room);
  sendRoomSnapshot(room);
}

function handleStartGame(ws, _msg, room) {
  if (!room) return send(ws, { type: P.S.ERROR, code: P.ERR.ROOM_NOT_FOUND, message: '不在房间中' });
  const p = findPlayer(room, ws.playerId);
  if (!p || !p.isHost) return send(ws, { type: P.S.ERROR, code: P.ERR.NOT_HOST, message: '只有房主可以开始游戏' });
  if (room.players.length < 2) return send(ws, { type: P.S.ERROR, code: P.ERR.NEED_MORE_PLAYERS, message: '至少需要 2 名玩家' });
  if (room.phase === 'playing') return;
  room.game = engine.createGame({
    names: room.players.map((x) => x.name),
    options: room.options,
    cardDb,
    rng: Math.random
  });
  room.phase = 'playing';
  clearBotTimer(room);
  room.botFails = 0;
  touch(room);
  sendRoomSnapshot(room);
  sendGameSnapshots(room);
  maybeScheduleBot(room);
}

function handleRestart(ws, msg, room) {
  if (!room) return send(ws, { type: P.S.ERROR, code: P.ERR.ROOM_NOT_FOUND, message: '不在房间中' });
  const p = findPlayer(room, ws.playerId);
  if (!p || !p.isHost) return send(ws, { type: P.S.ERROR, code: P.ERR.NOT_HOST, message: '只有房主可以重开' });
  if (room.phase !== 'finished') return send(ws, { type: P.S.ERROR, code: P.ERR.GAME_IN_PROGRESS, message: '对局尚未结束' });
  if (msg.options) {
    room.options = {
      cities: !!msg.options.cities,
      tradingPosts: !!msg.options.tradingPosts
    };
  }
  room.phase = 'lobby';
  room.game = null;
  clearBotTimer(room);
  touch(room);
  sendRoomSnapshot(room);
}

function handleUpdateOptions(ws, msg, room) {
  if (!room) return send(ws, { type: P.S.ERROR, code: P.ERR.ROOM_NOT_FOUND, message: '不在房间中' });
  const p = findPlayer(room, ws.playerId);
  if (!p || !p.isHost) return send(ws, { type: P.S.ERROR, code: P.ERR.NOT_HOST, message: '只有房主可以修改模块' });
  if (room.phase === 'playing') {
    return send(ws, { type: P.S.ERROR, code: P.ERR.GAME_IN_PROGRESS, message: '对局进行中,无法修改' });
  }
  room.options = {
    cities: !!(msg.options && msg.options.cities),
    tradingPosts: !!(msg.options && msg.options.tradingPosts)
  };
  touch(room);
  sendRoomSnapshot(room);
}

// ---------------------------------------------------------------- 机器人

function handleAddBot(ws, room) {
  if (!room) return send(ws, { type: P.S.ERROR, code: P.ERR.ROOM_NOT_FOUND, message: '不在房间中' });
  const p = findPlayer(room, ws.playerId);
  if (!p || !p.isHost) return send(ws, { type: P.S.ERROR, code: P.ERR.NOT_HOST, message: '只有房主可以添加机器人' });
  if (room.phase !== 'lobby') return send(ws, { type: P.S.ERROR, code: P.ERR.GAME_IN_PROGRESS, message: '对局进行中,无法添加' });
  if (room.players.length >= MAX_PLAYERS) return send(ws, { type: P.S.ERROR, code: P.ERR.ROOM_FULL, message: '房间已满' });
  const n = room.players.filter((x) => x.isBot).length + 1;
  const cn = ['一', '二', '三', '四'][n - 1] || String(n);
  room.players.push({
    id: 'bot-' + crypto.randomUUID(),
    name: `机器人${cn}`,
    seat: room.players.length,
    connected: true,
    isHost: false,
    isBot: true,
    ws: null
  });
  touch(room);
  sendRoomSnapshot(room);
}

function handleRemoveBot(ws, msg, room) {
  if (!room) return send(ws, { type: P.S.ERROR, code: P.ERR.ROOM_NOT_FOUND, message: '不在房间中' });
  const p = findPlayer(room, ws.playerId);
  if (!p || !p.isHost) return send(ws, { type: P.S.ERROR, code: P.ERR.NOT_HOST, message: '只有房主可以移除机器人' });
  if (room.phase !== 'lobby') return send(ws, { type: P.S.ERROR, code: P.ERR.GAME_IN_PROGRESS, message: '对局进行中,无法移除' });
  const idx = room.players.findIndex((x) => x.seat === msg.seat);
  if (idx < 0 || !room.players[idx].isBot) return send(ws, { type: P.S.ERROR, code: P.ERR.INVALID_ACTION, message: '该座位不是机器人' });
  room.players.splice(idx, 1);
  room.players.forEach((x, i) => (x.seat = i));
  touch(room);
  sendRoomSnapshot(room);
}

// 机器人策略:优先买高分卡,其次按目标卡缺口拿宝石,偶尔预留;子阶段随机/贪心
function botTargetDeficits(state, db) {
  const me = state.players[state.current];
  let best = null;
  let bestNeed = Infinity;
  for (const lv of [1, 2, 3]) {
    for (const id of state.market[lv]) {
      const cost = db.cards[id].cost;
      let need = 0;
      for (const c of P.COLORS) {
        need += Math.max(0, (cost[c] || 0) - me.bonus[c] - (me.tokens[c] || 0));
      }
      if (need > 0 && need < bestNeed) {
        bestNeed = need;
        best = cost;
      }
    }
  }
  const def = {};
  if (best) {
    for (const c of P.COLORS) {
      const d = Math.max(0, (best[c] || 0) - me.bonus[c] - (me.tokens[c] || 0));
      if (d > 0) def[c] = d;
    }
  }
  return def;
}

function botChooseAction(state, db, rng) {
  const acts = engine.enumerateActions(state, db);
  if (!acts.length) return null;
  if (state.phase !== 'action') {
    if (state.phase === 'peek') {
      const [a, b] = state.pending.peek.cards;
      const keep = db.cards[a].points >= db.cards[b].points ? 0 : 1;
      return acts.find((x) => x.keepIndex === keep) || acts[0];
    }
    return acts[Math.floor(rng() * acts.length)];
  }
  const buys = acts.filter((a) => a.act === P.ACT.BUY);
  if (buys.length && rng() < 0.92) {
    buys.sort((x, y) => {
      const cy = db.cards[y.cardId];
      const cx = db.cards[x.cardId];
      return cy.points - cx.points || cy.level - cx.level;
    });
    return buys[0];
  }
  const def = botTargetDeficits(state, db);
  const takes = acts.filter((a) => a.act === P.ACT.TAKE_GEMS);
  if (takes.length) {
    let best = null;
    let bestScore = -1;
    for (const t of takes) {
      let score = rng() * 0.5;
      for (const [c, n] of Object.entries(t.picks)) score += Math.min(n, def[c] || 0);
      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }
    return best;
  }
  const reserves = acts.filter((a) => a.act === P.ACT.RESERVE);
  if (reserves.length) return reserves[Math.floor(rng() * reserves.length)];
  return acts[0];
}

function clearBotTimer(room) {
  if (room.botTimer) {
    clearTimeout(room.botTimer);
    room.botTimer = null;
  }
}

function maybeScheduleBot(room) {
  if (!room.game || room.phase !== 'playing' || room.game.phase === 'finished') return;
  const p = room.players[room.game.current];
  if (!p || !p.isBot || room.botTimer) return;
  const gameRef = room.game;
  room.botTimer = setTimeout(() => {
    room.botTimer = null;
    if (rooms.get(room.code) !== room || room.game !== gameRef || room.phase !== 'playing') return;
    botAct(room);
  }, BOT_DELAY + Math.floor(Math.random() * 400));
}

function botAct(room) {
  const st = room.game;
  const p = room.players[st.current];
  if (!p || !p.isBot || st.phase === 'finished') return;
  let action = botChooseAction(st, cardDb, Math.random);
  if (!action) action = engine.enumerateActions(st, cardDb)[0];
  if (!action) return;
  let r = engine.applyAction(st, p.seat, action, cardDb);
  if (!r.ok && r.error === P.ERR.NEED_BONUS_COLOR) {
    const c = Object.keys(action.picks)[0];
    const opts = P.COLORS.filter((x) => x !== c && st.supply[x] > 0);
    if (opts.length) {
      action = { ...action, bonusColor: opts[Math.floor(Math.random() * opts.length)] };
      r = engine.applyAction(st, p.seat, action, cardDb);
    }
  }
  if (!r.ok) {
    const acts = engine.enumerateActions(st, cardDb);
    for (const fallback of acts) {
      r = engine.applyAction(st, p.seat, fallback, cardDb);
      if (r.ok) break;
    }
  }
  if (!r.ok) {
    // 行动全部失败:短暂延迟后重试(最多 5 次),避免对局死锁
    room.botFails = (room.botFails || 0) + 1;
    if (room.botFails <= 5) maybeScheduleBot(room);
    return;
  }
  room.botFails = 0;
  room.game = r.state;
  touch(room);
  if (r.state.phase === 'finished') {
    room.phase = 'finished';
    sendGameSnapshots(room);
    sendRoomSnapshot(room);
    return;
  }
  sendGameSnapshots(room);
  maybeScheduleBot(room);
}

function handleCloseRoom(ws, room) {
  if (!room) return send(ws, { type: P.S.ERROR, code: P.ERR.ROOM_NOT_FOUND, message: '不在房间中' });
  const p = findPlayer(room, ws.playerId);
  if (!p || !p.isHost) return send(ws, { type: P.S.ERROR, code: P.ERR.NOT_HOST, message: '只有房主可以解散房间' });
  closeRoom(room, '房主解散了房间');
}

function handleAction(ws, msg, room) {
  if (!room || !room.game) return send(ws, { type: P.S.ERROR, code: P.ERR.ROOM_NOT_FOUND, message: '不在对局中' });
  const p = findPlayer(room, ws.playerId);
  if (!p) return send(ws, { type: P.S.ERROR, code: P.ERR.ROOM_NOT_FOUND, message: '不在对局中' });
  const r = engine.applyAction(room.game, p.seat, msg.action, cardDb);
  if (!r.ok) return send(ws, { type: P.S.ERROR, code: r.error, message: errorText(r.error) });
  room.game = r.state;
  touch(room);
  if (r.state.phase === 'finished') room.phase = 'finished';
  sendGameSnapshots(room);
  if (r.state.phase === 'finished') sendRoomSnapshot(room);
  maybeScheduleBot(room);
}

function errorText(code) {
  const map = {
    [P.ERR.NOT_YOUR_TURN]: '还没轮到你',
    [P.ERR.INVALID_ACTION]: '不合法的行动',
    [P.ERR.NEED_BONUS_COLOR]: '需要指定附赠宝石颜色',
    [P.ERR.BAD_REQUEST]: '请求格式错误'
  };
  return map[code] || '操作失败';
}

function handleDisconnect(ws) {
  const room = ws.roomCode ? rooms.get(ws.roomCode) : null;
  if (!room) return;
  const p = findPlayer(room, ws.playerId);
  if (!p || p.ws !== ws) return;
  p.ws = null;
  p.connected = false;
  touch(room);
  sendRoomSnapshot(room);
}

// ---------------------------------------------------------------- 启动

function startServer({ port = 0, host = '0.0.0.0', botDelay } = {}) {
  if (botDelay !== undefined) BOT_DELAY = botDelay;
  const server = http.createServer(serveStatic);
  const wss = new WebSocketServer({ server, maxPayload: 32 * 1024 });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send(ws, { type: P.S.ERROR, code: P.ERR.BAD_REQUEST, message: '消息格式错误' });
      }
      try {
        handleMessage(ws, msg);
      } catch (err) {
        console.error('handle message error:', err);
        send(ws, { type: P.S.ERROR, code: P.ERR.BAD_REQUEST, message: '服务器内部错误' });
      }
    });
    ws.on('close', () => handleDisconnect(ws));
    ws.on('error', () => {});
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);
  wss.on('close', () => clearInterval(heartbeat));

  const cleaner = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      const idle = now - room.updatedAt;
      if (room.phase === 'lobby' && idle > 30 * 60 * 1000) {
        closeRoom(room, '房间长时间无活动');
      } else if (room.phase === 'finished' && idle > 15 * 60 * 1000) {
        closeRoom(room, '对局已结束');
      } else if (room.phase === 'playing' && room.players.every((p) => !p.connected) && idle > 2 * 60 * 60 * 1000) {
        closeRoom(room, '全员长时间离线');
      }
    }
  }, 60 * 1000);
  if (cleaner.unref) cleaner.unref();

  const stop = async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise((resolve) => wss.close(() => resolve()));
    clearInterval(heartbeat);
    clearInterval(cleaner);
    server.close();
  };

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      resolve({ server, wss, rooms, sessions, port: server.address().port, stop });
    });
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  startServer({ port }).then(({ port: actual }) => {
    console.log(`璀璨宝石已启动: http://localhost:${actual}  (PORT 环境变量可改端口)`);
  });
}

module.exports = { startServer };
