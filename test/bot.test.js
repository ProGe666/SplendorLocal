'use strict';

// 机器人玩家:房主添加/移除、自动行棋、单人(1人+机器人)可完整测试

const test = require('node:test');
const assert = require('node:assert');
const { startServer } = require('../server');
const P = require('../public/protocol');
const { Bot, mulberry32 } = require('./helpers');

const COLORS = P.COLORS;

test('机器人:添加/移除/权限校验,1人+机器人完整对局', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1', botDelay: 20 });
  const url = `ws://127.0.0.1:${srv.port}/ws`;
  const rng = mulberry32(77);
  const A = new Bot(url, '独狼');
  const B = new Bot(url, '路人');

  try {
    await A.opened();
    await B.opened();
    A.send({ type: P.C.HELLO, name: '独狼' });
    await A.awaitMsg(P.S.WELCOME);
    B.send({ type: P.C.HELLO, name: '路人' });
    await B.awaitMsg(P.S.WELCOME);

    A.send({ type: P.C.CREATE_ROOM, options: { cities: false, tradingPosts: false } });
    const room0 = await A.awaitMsg(P.S.ROOM);
    assert.equal(room0.players.length, 1);

    // 非房内玩家不能加机器人
    B.send({ type: P.C.ADD_BOT });
    let err = await B.awaitMsg(P.S.ERROR);
    assert.equal(err.code, P.ERR.ROOM_NOT_FOUND);

    // 房主添加机器人
    A.send({ type: P.C.ADD_BOT });
    const room1 = await A.awaitMsg(P.S.ROOM);
    assert.equal(room1.players.length, 2);
    const bot = room1.players.find((p) => p.isBot);
    assert.ok(bot);
    assert.equal(bot.connected, true);

    // 移除后重加
    A.send({ type: P.C.REMOVE_BOT, seat: bot.seat });
    const room2 = await A.awaitMsg(P.S.ROOM);
    assert.equal(room2.players.length, 1);
    A.send({ type: P.C.ADD_BOT });
    const room3 = await A.awaitMsg(P.S.ROOM);
    assert.equal(room3.players.length, 2);

    // 开局:1 人 + 1 机器人
    A.send({ type: P.C.START_GAME });
    await A.awaitMsg(P.S.GAME);
    const mySeat = A.view.players.findIndex((p) => p.name === '独狼');
    const botSeat = mySeat === 0 ? 1 : 0;

    // 轮到自己就行动,机器人回合等服务器自动走
    let guard = 0;
    while (A.view.phase !== 'finished') {
      assert.ok(guard++ < 600, '对局应在有限步内结束');
      if (A.view.current === mySeat) {
        const acts = A.candidateActions(rng);
        assert.ok(acts.length > 0, `人类侧可枚举行动 guard=${guard} phase=${A.view.phase}`);
        const pick = acts[Math.floor(rng() * acts.length)];
        let outcome;
        const wGame = A.addTempWaiter((m) => (m && m.type === P.S.GAME ? m : false));
        const wErr = A.addTempWaiter((m) => (m && m.type === P.S.ERROR ? m : false));
        try {
          A.send({ type: P.C.ACTION, action: pick });
          outcome = await Promise.race([wGame.promise, wErr.promise]);
        } finally {
          wGame.cancel();
          wErr.cancel();
        }
        if (outcome.type === P.S.ERROR) {
          if (outcome.code === P.ERR.NEED_BONUS_COLOR) {
            const c = Object.keys(pick.picks)[0];
            const opts = COLORS.filter((x) => x !== c && A.view.supply[x] > 0);
            if (opts.length) {
              const w2 = A.addTempWaiter((m) => (m && m.type === P.S.GAME ? m : false));
              A.send({
                type: P.C.ACTION,
                action: { ...pick, bonusColor: opts[Math.floor(rng() * opts.length)] }
              });
              await w2.promise;
              w2.cancel();
            }
          }
          // 其他失误:下轮重选
        }
      } else {
        // 机器人回合:等待服务器自动行棋后广播的下一份快照(约 botDelay 毫秒后)
        const target = A.gameCount + 1;
        await A.waitUntil((m) => (m ? false : A.gameCount >= target ? { ok: 1 } : false), 8000);
      }
    }

    assert.ok(A.view.result.winners.length >= 1);
    assert.equal(A.view.result.ranking.length, 2);
    // 机器人确实行动过(日志中有其座位的行动)
    const botLogs = A.view.log.filter((l) => l.seat === botSeat && ['take', 'buy', 'reserve', 'discard'].includes(l.kind));
    assert.ok(botLogs.length > 3, `机器人应有多条行动日志(实际 ${botLogs.length})`);
    // 机器人视角中人类预留牌隐藏
    const me = A.view.players[mySeat];
    assert.ok(me.reserved.every((r) => !r.hidden));

    // 对局结束后回到 lobby,机器人仍在房间
    A.send({ type: P.C.RESTART });
    const roomEnd = await A.waitUntil((m) =>
      m && m.type === P.S.ROOM && m.phase === 'lobby' ? m : false
    );
    assert.equal(roomEnd.phase, 'lobby');
    assert.equal(roomEnd.players.filter((p) => p.isBot).length, 1);
  } finally {
    A.close();
    B.close();
    await srv.stop();
  }
});
