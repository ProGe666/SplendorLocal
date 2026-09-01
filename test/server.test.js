'use strict';

const test = require('node:test');
const assert = require('node:assert');
const WebSocket = require('ws');
const { startServer } = require('../server');
const P = require('../public/protocol');

let base = null;

test.before(async () => {
  const s = await startServer({ port: 0, host: '127.0.0.1' });
  base = `ws://127.0.0.1:${s.port}`;
  test._server = s;
});

test.after(async () => {
  await test._server.stop();
});

class Client {
  constructor(name) {
    this.name = name;
    this.queue = [];
    this.waiters = [];
    this.ws = new WebSocket(base);
    this.identity = null;
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      const w = this.waiters.find((x) => x.type === msg.type);
      if (w) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(msg);
      } else {
        this.queue.push(msg);
      }
    });
  }

  opened() {
    return new Promise((resolve) => this.ws.on('open', resolve));
  }

  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  awaitMsg(type, timeout = 3000) {
    const i = this.queue.findIndex((m) => m.type === type);
    if (i >= 0) return Promise.resolve(this.queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${this.name} 等待 ${type} 超时`)), timeout);
      this.waiters.push({ type, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  }

  close() {
    this.ws.close();
  }
}

function pickGems(view) {
  const avail = P.COLORS.filter((c) => view.supply[c] > 0);
  const picks = {};
  for (const c of avail.slice(0, Math.min(3, avail.length))) picks[c] = 1;
  return picks;
}

test('HTTP:healthz 与卡牌数据可访问', async () => {
  const s = test._server;
  const h = await fetch(`http://127.0.0.1:${s.port}/healthz`);
  assert.equal(h.status, 200);
  assert.equal(h.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(h.headers.get('x-frame-options'), 'DENY');
  assert.match(h.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const j = await fetch(`http://127.0.0.1:${s.port}/data/cards.json`);
  assert.equal(j.status, 200);
  const db = await j.json();
  assert.equal(Object.keys(db.cards).length, 90);

  const malformed = await fetch(`http://127.0.0.1:${s.port}/%`);
  assert.equal(malformed.status, 400);
  const afterMalformed = await fetch(`http://127.0.0.1:${s.port}/healthz`);
  assert.equal(afterMalformed.status, 200, '非法 URL 不应导致服务进程退出');

  const debug = await fetch(`http://127.0.0.1:${s.port}/debug/rooms`);
  assert.equal(debug.status, 404);
});

test('WebSocket:拒绝跨站浏览器连接', async () => {
  const ws = new WebSocket(base, { origin: 'https://evil.example' });
  const status = await new Promise((resolve, reject) => {
    ws.once('unexpected-response', (_req, res) => {
      res.resume();
      resolve(res.statusCode);
    });
    ws.once('open', () => reject(new Error('跨站 WebSocket 不应连接成功')));
    ws.once('error', () => {});
  });
  assert.equal(status, 401);
});

test('WebSocket:单连接只能初始化一次，未入房 session 在断开后清理', async () => {
  const before = test._server.sessions.size;
  const C = new Client('临时');
  await C.opened();
  C.send(null);
  const malformed = await C.awaitMsg(P.S.ERROR);
  assert.equal(malformed.code, P.ERR.BAD_REQUEST);

  C.send({ type: P.C.HELLO, name: '临时' });
  const welcome = await C.awaitMsg(P.S.WELCOME);
  assert.equal(test._server.sessions.size, before + 1);

  C.send({ type: P.C.HELLO, playerId: welcome.playerId, token: welcome.token });
  const repeated = await C.awaitMsg(P.S.ERROR);
  assert.equal(repeated.code, P.ERR.BAD_REQUEST);
  assert.equal(test._server.sessions.size, before + 1);

  const closed = new Promise((resolve) => C.ws.once('close', resolve));
  C.close();
  await closed;
  for (let i = 0; i < 20 && test._server.sessions.size !== before; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(test._server.sessions.size, before);
});

test('完整流程:建房、加入、开局、轮流行动、预留隐藏、断线重连', async () => {
  const A = new Client('甲');
  const B = new Client('乙');
  await A.opened();
  await B.opened();

  A.send({ type: P.C.HELLO, name: '甲' });
  const wA = await A.awaitMsg(P.S.WELCOME);
  A.identity = { playerId: wA.playerId, token: wA.token };
  B.send({ type: P.C.HELLO, name: '乙' });
  const wB = await B.awaitMsg(P.S.WELCOME);
  B.identity = { playerId: wB.playerId, token: wB.token };

  A.send({ type: P.C.CREATE_ROOM, options: { cities: false, tradingPosts: false } });
  const roomA = await A.awaitMsg(P.S.ROOM);
  assert.equal(roomA.phase, 'lobby');
  assert.equal(roomA.you, 0);
  assert.equal(roomA.players.length, 1);
  assert.ok(roomA.players[0].isHost);

  B.send({ type: P.C.JOIN_ROOM, code: roomA.code });
  const roomB = await B.awaitMsg(P.S.ROOM);
  assert.equal(roomB.players.length, 2);
  assert.equal(roomB.you, 1);
  const roomA2 = await A.awaitMsg(P.S.ROOM);
  assert.equal(roomA2.players.length, 2);

  // 非 4 位/不存在的房间
  B.send({ type: P.C.JOIN_ROOM, code: 'ZZZZ' });
  const err1 = await B.awaitMsg(P.S.ERROR);
  assert.equal(err1.code, P.ERR.ROOM_NOT_FOUND);

  A.send({ type: P.C.START_GAME });
  await Promise.all([A.awaitMsg(P.S.ROOM), B.awaitMsg(P.S.ROOM)]); // phase=playing 的房间快照
  const [gA, gB] = await Promise.all([A.awaitMsg(P.S.GAME), B.awaitMsg(P.S.GAME)]);
  assert.equal(gA.state.config.playerCount, 2);
  assert.equal(gA.state.players[0].name, '甲');
  assert.equal(gA.state.players[1].name, '乙');
  assert.equal(gA.state.current, gB.state.current);

  // 轮流拿宝石 6 个回合
  let va = gA.state;
  let vb = gB.state;
  for (let i = 0; i < 6; i++) {
    const aTurn = va.current === 0;
    (aTurn ? A : B).send({ type: P.C.ACTION, action: { act: P.ACT.TAKE_GEMS, picks: pickGems(aTurn ? va : vb) } });
    const [na, nb] = await Promise.all([A.awaitMsg(P.S.GAME), B.awaitMsg(P.S.GAME)]);
    va = na.state;
    vb = nb.state;
    assert.equal(va.current, vb.current);
    assert.equal(va.current, (aTurn ? 1 : 0));
  }

  // 非当前玩家行动被拒
  const notCurrent = va.current === 0 ? B : A;
  notCurrent.send({ type: P.C.ACTION, action: { act: P.ACT.TAKE_GEMS, picks: pickGems(va) } });
  const err2 = await notCurrent.awaitMsg(P.S.ERROR);
  assert.equal(err2.code, P.ERR.NOT_YOUR_TURN);

  // 当前玩家预留牌库顶,对手视角中该预留牌应隐藏
  const reserver = va.current === 0 ? A : B;
  const seat = va.current;
  reserver.send({ type: P.C.ACTION, action: { act: P.ACT.RESERVE, from: 'deck', level: 2 } });
  const [ra, rb] = await Promise.all([A.awaitMsg(P.S.GAME), B.awaitMsg(P.S.GAME)]);
  assert.equal(ra.state.players[seat].reserved.length, 1);
  const otherView = seat === 0 ? rb.state : ra.state;
  assert.deepEqual(otherView.players[seat].reserved[0], { hidden: true });
  assert.equal(typeof ra.state.decks[1], 'number'); // 视角中牌库只有数量

  // 断线:对手收到离线状态;重连:直接收到对局快照
  B.close();
  const roomOffline = await A.awaitMsg(P.S.ROOM);
  assert.equal(roomOffline.players.find((p) => p.seat === 1).connected, false);

  const B2 = new Client('乙');
  await B2.opened();
  B2.identity = B.identity;
  B2.send({ type: P.C.HELLO, name: '乙', playerId: B.identity.playerId, token: B.identity.token });
  await B2.awaitMsg(P.S.WELCOME);
  const gRe = await B2.awaitMsg(P.S.GAME);
  assert.equal(gRe.state.phase, 'action');
  const roomBack = await A.awaitMsg(P.S.ROOM);
  assert.equal(roomBack.players.find((p) => p.seat === 1).connected, true);

  // 房主解散 → roomClosed
  A.send({ type: P.C.CLOSE_ROOM });
  const [closedA, closedB] = await Promise.all([A.awaitMsg(P.S.ROOM_CLOSED), B2.awaitMsg(P.S.ROOM_CLOSED)]);
  assert.ok(closedA.reason && closedB.reason);
  A.close();
  B2.close();
});

test('对局中离开=挂起保留座位;房主可作废本局', async () => {
  const H = new Client('主');
  const G = new Client('客');
  await Promise.all([H.opened(), G.opened()]);
  H.send({ type: P.C.HELLO, name: '主' });
  const wH = await H.awaitMsg(P.S.WELCOME);
  H.identity = { playerId: wH.playerId, token: wH.token };
  G.send({ type: P.C.HELLO, name: '客' });
  const wG = await G.awaitMsg(P.S.WELCOME);
  G.identity = { playerId: wG.playerId, token: wG.token };

  H.send({ type: P.C.CREATE_ROOM, options: {} });
  const roomMsg = await H.awaitMsg(P.S.ROOM);
  G.send({ type: P.C.JOIN_ROOM, code: roomMsg.code });
  await G.awaitMsg(P.S.ROOM);
  await H.awaitMsg(P.S.ROOM);
  H.send({ type: P.C.START_GAME });
  await Promise.all([H.awaitMsg(P.S.ROOM), G.awaitMsg(P.S.ROOM)]);
  await Promise.all([H.awaitMsg(P.S.GAME), G.awaitMsg(P.S.GAME)]);

  // 普通玩家不能用“创建新房间”旁路作废正在进行的对局
  G.send({ type: P.C.CREATE_ROOM, options: {} });
  const createDuringGame = await G.awaitMsg(P.S.ERROR);
  assert.equal(createDuringGame.code, P.ERR.GAME_IN_PROGRESS);
  assert.equal(test._server.rooms.get(roomMsg.code).phase, 'playing');
  assert.equal(test._server.rooms.get(roomMsg.code).players.length, 2);

  // 同一旁路也不能通过加入其他大厅触发
  const D = new Client('另一房主');
  await D.opened();
  D.send({ type: P.C.HELLO, name: '另一房主' });
  await D.awaitMsg(P.S.WELCOME);
  D.send({ type: P.C.CREATE_ROOM, options: {} });
  const destination = await D.awaitMsg(P.S.ROOM);
  G.send({ type: P.C.JOIN_ROOM, code: destination.code });
  const joinDuringGame = await G.awaitMsg(P.S.ERROR);
  assert.equal(joinDuringGame.code, P.ERR.GAME_IN_PROGRESS);
  assert.equal(test._server.rooms.get(roomMsg.code).phase, 'playing');

  // 非房主对局中离开 → 挂起,不毁局
  G.send({ type: P.C.LEAVE_ROOM });
  const suspended = await H.awaitMsg(P.S.ROOM);
  assert.equal(suspended.phase, 'playing'); // 对局仍在
  const gone = suspended.players.find((p) => p.seat === 1);
  assert.equal(gone.connected, false);
  assert.equal(gone.name, '客'); // 座位保留

  // 挂起者用 joinRoom 回到同一局(重绑)
  G.send({ type: P.C.JOIN_ROOM, code: roomMsg.code });
  const backGame = await G.awaitMsg(P.S.GAME);
  assert.equal(backGame.state.phase, 'action');
  const backRoom = await H.awaitMsg(P.S.ROOM);
  assert.equal(backRoom.players.find((p) => p.seat === 1).connected, true);

  // 非房主不能作废
  H.queue = H.queue.filter((m) => m.type !== P.S.ROOM);
  G.queue = G.queue.filter((m) => m.type !== P.S.ROOM);
  G.send({ type: P.C.ABANDON_GAME });
  const errAb = await G.awaitMsg(P.S.ERROR);
  assert.equal(errAb.code, P.ERR.NOT_HOST);

  // 房主作废 → 所有人回 lobby,玩家保留
  H.send({ type: P.C.ABANDON_GAME });
  const [rH, rG] = await Promise.all([H.awaitMsg(P.S.ROOM), G.awaitMsg(P.S.ROOM)]);
  assert.equal(rH.phase, 'lobby');
  assert.equal(rH.players.length, 2);
  assert.equal(rG.phase, 'lobby');
  H.send({ type: P.C.START_GAME });
  await Promise.all([H.awaitMsg(P.S.GAME), G.awaitMsg(P.S.GAME)]);

  H.close();
  G.close();
  D.close();
});

test('房主校验与扩展开局', async () => {
  const A = new Client('房主');
  const B = new Client('客');
  await Promise.all([A.opened(), B.opened()]);
  A.send({ type: P.C.HELLO, name: '房主' });
  const wA = await A.awaitMsg(P.S.WELCOME);
  A.identity = { playerId: wA.playerId, token: wA.token };

  B.send({ type: P.C.HELLO, name: '客' });
  const wB = await B.awaitMsg(P.S.WELCOME);
  B.identity = { playerId: wB.playerId, token: wB.token };

  A.send({ type: P.C.CREATE_ROOM, options: { cities: true, tradingPosts: true } });
  const roomA = await A.awaitMsg(P.S.ROOM);
  B.send({ type: P.C.JOIN_ROOM, code: roomA.code });
  await B.awaitMsg(P.S.ROOM);
  await A.awaitMsg(P.S.ROOM);

  // 非房主开局被拒
  B.send({ type: P.C.START_GAME });
  const err = await B.awaitMsg(P.S.ERROR);
  assert.equal(err.code, P.ERR.NOT_HOST);

  A.send({ type: P.C.START_GAME });
  const g = await A.awaitMsg(P.S.GAME);
  assert.equal(g.state.config.expansions.cities, true);
  assert.equal(g.state.cities.length, 3);
  assert.equal(g.state.tradingPosts.length, 5);

  // 对局未结束时不能重开
  A.send({ type: P.C.RESTART });
  const err2 = await A.awaitMsg(P.S.ERROR);
  assert.equal(err2.code, P.ERR.GAME_IN_PROGRESS);

  A.close();
  B.close();
});
