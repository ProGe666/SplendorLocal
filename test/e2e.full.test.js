'use strict';

// 全流程 E2E:3 玩家、双扩展开、随机 bot 从个人视角快照驱动打到终局。
// 同时验证:视角快照包含真实客户端所需的全部信息。

const test = require('node:test');
const assert = require('node:assert');
const { startServer } = require('../server');
const P = require('../public/protocol');
const { Bot, mulberry32 } = require('./helpers');

const COLORS = P.COLORS;

test('E2E:3 玩家双扩展,视角驱动随机对局打到终局并再开一局', async () => {
  const srv = await startServer({ port: 0, host: '127.0.0.1' });
  const url = `ws://127.0.0.1:${srv.port}`;
  const rng = mulberry32(20260831);
  const bots = [new Bot(url, '甲'), new Bot(url, '乙'), new Bot(url, '丙')];

  try {
    await Promise.all(bots.map((b) => b.opened()));
    const welcomeById = new Map();
    for (const b of bots) {
      const w = b.addTempWaiter((m) => (m && m.type === P.S.WELCOME ? m : false));
      b.send({ type: P.C.HELLO, name: b.name });
      welcomeById.set(b.name, await w.promise);
      w.cancel();
    }

    bots[0].send({ type: P.C.CREATE_ROOM, options: { cities: true, tradingPosts: true } });
    const room0 = await bots[0].awaitMsg(P.S.ROOM);
    for (const b of bots.slice(1)) b.send({ type: P.C.JOIN_ROOM, code: room0.code });
    await Promise.all(bots.slice(1).map((b) => b.awaitMsg(P.S.ROOM)));

    bots[0].send({ type: P.C.START_GAME });
    await Promise.all(bots.map((b) => b.awaitMsg(P.S.GAME)));
    assert.equal(bots[0].view.config.playerCount, 3);
    assert.equal(bots[0].view.cities.length, 3);
    assert.equal(bots[0].view.tradingPosts.length, 5);

    let steps = 0;
    let errors = 0;
    const raceOutcome = async (actor, pick) => {
      const before = bots.map((b) => b.gameCount);
      const gameW = bots.map((b, i) =>
        b.addTempWaiter((m) => (m ? false : b.gameCount > before[i] ? { ok: 1 } : false))
      );
      const errW = actor.addTempWaiter((m) => (m && m.type === P.S.ERROR ? m : false));
      let out;
      try {
        actor.send({ type: P.C.ACTION, action: pick });
        out = await Promise.race([Promise.all(gameW.map((w) => w.promise)).then(() => 'game'), errW.promise]);
      } finally {
        errW.cancel();
        gameW.forEach((w) => w.cancel());
      }
      return out;
    };

    while (bots[0].view.phase !== 'finished') {
      assert.ok(steps < 3000, `对局应在有限步内结束(已 ${steps} 步)`);
      const current = bots[0].view.current;
      const actor = bots.find((b) => b.view.players.find((p) => p.name === b.name).seat === current);
      assert.ok(actor, '找到当前行动玩家');
      const acts = actor.candidateActions(rng);
      assert.ok(acts.length > 0, `视角可枚举出行动 step=${steps} phase=${actor.view.phase}`);
      const pick = acts[Math.floor(rng() * acts.length)];
      const outcome = await raceOutcome(actor, pick);
      if (outcome === 'game') {
        // 视角一致性:三人快照的公共信息一致
        const [v0, v1, v2] = bots.map((b) => b.view);
        assert.equal(v0.current, v1.current);
        assert.equal(v1.current, v2.current);
        assert.deepEqual(v0.supply, v2.supply);
      } else {
        errors++;
        if (outcome.code === P.ERR.NEED_BONUS_COLOR) {
          const c = Object.keys(pick.picks)[0];
          const opts = COLORS.filter((x) => x !== c && actor.view.supply[x] > 0);
          if (opts.length) {
            await raceOutcome(actor, {
              ...pick,
              bonusColor: opts[Math.floor(rng() * opts.length)]
            });
          }
        }
        // 其余失误(买不起/预留满等):跳过重选
      }
      steps++;
    }
    assert.ok(errors < steps * 0.25, `随机 bot 失误率应较低(${errors}/${steps})`);

    const result = bots[0].view.result;
    console.log(`  [e2e] 对局完成: ${steps} 步, 失误 ${errors}, 终局原因 ${result.reason}, 胜者 seat=${result.winners}`);
    assert.ok(steps > 15, `对局步数应超过 15(实际 ${steps})`);
    assert.ok(bots[0].view.turnNo > 10, `turnNo 应推进(实际 ${bots[0].view.turnNo})`);
    assert.ok(result.winners.length >= 1);
    assert.equal(result.ranking.length, 3);
    assert.ok(['city', 'prestige'].includes(result.reason));

    // 终局后房主直接再开一局
    bots[0].send({ type: P.C.START_GAME });
    await Promise.all(bots.map((b) => b.awaitMsg(P.S.GAME)));
    assert.equal(bots[0].view.phase, 'action');

    // 断线重连:带原身份重新 hello,直接收到对局快照
    const dropped = bots[2];
    dropped.close();
    await bots[0].awaitMsg(P.S.ROOM); // 有人离线的房间快照
    const re = new Bot(url, '丙');
    await re.opened();
    const wWelcome = re.addTempWaiter((m) => (m && m.type === P.S.WELCOME ? m : false));
    const wGame = re.addTempWaiter((m) => (m && m.type === P.S.GAME ? m : false));
    re.send({
      type: P.C.HELLO,
      name: '丙',
      playerId: welcomeById.get('丙').playerId,
      token: welcomeById.get('丙').token
    });
    await wWelcome.promise;
    const gBack = await wGame.promise;
    assert.equal(gBack.state.phase, 'action');
    assert.equal(gBack.state.config.playerCount, 3);
    wWelcome.cancel();
    wGame.cancel();
    re.close();
  } finally {
    for (const b of bots) b.close();
    await srv.stop();
  }
});
