'use strict';

const test = require('node:test');
const assert = require('node:assert');
const engine = require('../game/engine');
const cardDb = require('../data/cards.json');
const P = require('../public/protocol');

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COLORS = P.COLORS;

function newGame(opts = {}, names = ['A', 'B']) {
  return engine.createGame({
    names,
    options: { cities: !!opts.cities, tradingPosts: !!opts.tradingPosts },
    cardDb,
    rng: mulberry32(opts.seed || 42)
  });
}

function act(st, action, seat) {
  return engine.applyAction(st, seat === undefined ? st.current : seat, action, cardDb);
}

// 把指定卡换到某级市场首位(保持 90 张卡仍在场内)
function forceMarket(st, level, id) {
  for (const lv of [1, 2, 3]) {
    const mi = st.market[lv].indexOf(id);
    if (mi >= 0) {
      [st.market[lv][mi], st.market[level][0]] = [st.market[level][0], st.market[lv][mi]];
      return;
    }
    const di = st.decks[lv].indexOf(id);
    if (di >= 0) {
      st.decks[lv].splice(di, 1);
      const old = st.market[level][0];
      st.market[level][0] = id;
      st.decks[lv].push(old);
      return;
    }
  }
}

// ---------------------------------------------------------------- 数据完整性

test('卡牌数据:张数与颜色分布', () => {
  const all = Object.entries(cardDb.cards);
  assert.equal(all.length, 90);
  for (const lv of [1, 2, 3]) {
    const cards = all.filter(([, c]) => c.level === lv);
    assert.equal(cards.length, [40, 30, 20][lv - 1], `等级${lv}张数`);
    for (const color of COLORS) {
      assert.equal(cards.filter(([, c]) => c.color === color).length, [8, 6, 4][lv - 1], `等级${lv} ${color}张数`);
    }
  }
  for (const [id, c] of all) {
    assert.ok(COLORS.includes(c.color), `${id} 颜色合法`);
    assert.ok(Number.isInteger(c.points) && c.points >= 0 && c.points <= 5);
    for (const k of Object.keys(c.cost)) assert.ok(COLORS.includes(k), `${id} 成本键合法`);
  }
  assert.equal(Object.values(cardDb.cards).reduce((a, c) => a + c.points, 0), 140); // 官方:发展卡合计 140 分
});

test('卡牌数据:每级每色标志卡', () => {
  for (const color of COLORS) {
    const l1 = Object.values(cardDb.cards).filter((c) => c.level === 1 && c.color === color && c.points === 1);
    assert.equal(l1.length, 1);
    assert.equal(Object.values(l1[0].cost)[0], 4);
    const l2 = Object.values(cardDb.cards).filter((c) => c.level === 2 && c.color === color && c.points === 3);
    assert.equal(l2.length, 1);
    assert.equal(l2[0].cost[color], 6);
    const l3 = Object.values(cardDb.cards).filter((c) => c.level === 3 && c.color === color);
    assert.equal(l3.filter((c) => c.points === 4).length, 2);
    const single7 = l3.filter((c) => c.points === 4 && Object.values(c.cost)[0] === 7 && Object.keys(c.cost).length === 1);
    assert.equal(single7.length, 1);
    const five = l3.filter((c) => c.points === 5);
    assert.equal(five.length, 1);
    assert.equal(Object.values(five[0].cost).reduce((a, b) => a + b, 0), 10);
  }
});

test('贵族数据:10 张,5 双色 4+4 与 5 三色 3+3', () => {
  const nobles = Object.values(cardDb.nobles);
  assert.equal(nobles.length, 10);
  assert.equal(nobles.filter((n) => Object.keys(n.req).length === 2).length, 5);
  assert.equal(nobles.filter((n) => Object.keys(n.req).length === 3).length, 5);
  for (const n of nobles) {
    assert.equal(n.points, 3);
    for (const v of Object.values(n.req)) assert.ok(v === 3 || v === 4);
  }
});

test('扩展数据:城市 6 张、贸易站 5 项', () => {
  assert.equal(Object.keys(cardDb.cities).length, 6);
  assert.equal(Object.keys(cardDb.tradingPosts).length, 5);
  const effects = [...new Set(Object.values(cardDb.tradingPosts).map((t) => t.effect))].sort();
  assert.deepEqual(effects, ['extraOnDouble', 'gemOnBuy', 'goldTwo', 'peekReserve', 'pointsPerPost'].sort());
});

// ---------------------------------------------------------------- setup

test('setup:供应、市场、贵族张数随人数', () => {
  for (const [n, per] of [
    [2, 4],
    [3, 5],
    [4, 7]
  ]) {
    const st = newGame({}, Array.from({ length: n }, (_, i) => 'P' + i));
    for (const c of COLORS) assert.equal(st.supply[c], per);
    assert.equal(st.supply.gold, 5);
    for (const lv of [1, 2, 3]) {
      assert.equal(st.market[lv].length, 4);
      assert.equal(st.decks[lv].length, [40, 30, 20][lv - 1] - 4);
    }
    assert.equal(st.nobles.length, n + 1);
    assert.equal(st.cities.length, 0);
    assert.equal(st.tradingPosts.length, 0);
  }
  const stc = newGame({ cities: true });
  assert.equal(stc.nobles.length, 0);
  assert.equal(stc.cities.length, 3);
  const stt = newGame({ tradingPosts: true });
  assert.equal(stt.tradingPosts.length, 5);
});

// ---------------------------------------------------------------- takeGems

test('takeGems:三种各一合法;金色不可拿;非法组合拒绝', () => {
  const st = newGame({ seed: 2 });
  const mover = st.current;
  let r = act(st, { act: P.ACT.TAKE_GEMS, picks: { white: 1, blue: 1, red: 1 } });
  assert.ok(r.ok);
  assert.equal(r.state.current, (mover + 1) % st.players.length);
  assert.equal(r.state.supply.white, st.supply.white - 1);
  assert.equal(r.state.players[mover].tokens.white, 1);

  const st1 = r.state;
  r = act(st1, { act: P.ACT.TAKE_GEMS, picks: { gold: 1, white: 1, red: 1 } });
  assert.ok(!r.ok);
  r = act(st1, { act: P.ACT.TAKE_GEMS, picks: { white: 1, blue: 2 } });
  assert.ok(!r.ok);
  r = act(st1, { act: P.ACT.TAKE_GEMS, picks: { white: 3 } });
  assert.ok(!r.ok);
  r = act(st1, { act: P.ACT.TAKE_GEMS, picks: { white: 2, red: 2 } });
  assert.ok(!r.ok);
});

test('takeGems:同色2要求供应≥4;不是你的回合拒绝', () => {
  const st = newGame({ seed: 6 });
  const mover = st.current;
  let r = act(st, { act: P.ACT.TAKE_GEMS, picks: { white: 2 } });
  assert.ok(r.ok);
  assert.equal(r.state.players[mover].tokens.white, 2);

  r = act(r.state, { act: P.ACT.TAKE_GEMS, picks: { black: 2 } }, mover);
  assert.ok(!r.ok && r.error === 'NOT_YOUR_TURN');

  const st2 = newGame({ seed: 8 });
  st2.supply.white = 3;
  r = act(st2, { act: P.ACT.TAKE_GEMS, picks: { white: 2 } });
  assert.ok(!r.ok);
});

test('takeGems:供应不足时允许拿2种/1种', () => {
  const st = newGame();
  for (const c of COLORS) st.supply[c] = 0;
  st.supply.blue = 2;
  st.supply.red = 1;
  let r = act(st, { act: P.ACT.TAKE_GEMS, picks: { blue: 1, red: 1 } });
  assert.ok(r.ok);
  const st2 = r.state;
  for (const c of COLORS) st2.supply[c] = 0;
  st2.supply.green = 1;
  r = act(st2, { act: P.ACT.TAKE_GEMS, picks: { green: 1 } });
  assert.ok(r.ok);
});

// ---------------------------------------------------------------- buy

test('buy:全折扣免费购买、金币补足、支付回流供应', () => {
  const st = newGame({ seed: 12 });
  const p = st.players[st.current];
  const cardId = st.market[1][0];
  const card = cardDb.cards[cardId];
  for (const c of Object.keys(card.cost)) p.bonus[c] = 99;
  let r = act(st, { act: P.ACT.BUY, from: 'market', cardId });
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(r.state.players[p.seat].cards.includes(cardId));
  assert.equal(r.state.players[p.seat].bonus[card.color], 99 + (card.cost[card.color] ? 1 : 0));
  assert.equal(r.state.market[card.level].length, 4);

  // 金币补最后一颗
  const st2 = newGame({ seed: 7 });
  const p2 = st2.players[st2.current];
  const cid2 = st2.market[1][0];
  const cost2 = cardDb.cards[cid2].cost;
  const first = Object.keys(cost2)[0];
  for (const [c, v] of Object.entries(cost2)) p2.tokens[c] = v;
  p2.tokens[first] -= 1;
  p2.tokens.gold = 1;
  r = act(st2, { act: P.ACT.BUY, from: 'market', cardId: cid2 });
  assert.ok(r.ok);
  assert.equal(r.state.players[p2.seat].tokens.gold, 0);
  assert.equal(r.state.supply.gold, 6); // 玩家的 1 金(夹具)支付后回流供应

  // 精确支付:给足各色,买后归零
  const st3 = newGame({ seed: 9 });
  const p3 = st3.players[st3.current];
  const cid3 = st3.market[2][0];
  r = act(st3, { act: P.ACT.BUY, from: 'market', cardId: cid3 });
  assert.ok(!r.ok && r.error === 'INVALID_ACTION');
  for (const [c, v] of Object.entries(cardDb.cards[cid3].cost)) p3.tokens[c] = v;
  r = act(st3, { act: P.ACT.BUY, from: 'market', cardId: cid3 });
  assert.ok(r.ok);
  for (const c of Object.keys(cardDb.cards[cid3].cost)) {
    assert.equal(r.state.players[p3.seat].tokens[c], 0);
  }
  assert.equal(r.state.supply.white, st3.supply.white + (cardDb.cards[cid3].cost.white || 0));
});

// ---------------------------------------------------------------- reserve

test('reserve:明牌/盲抽预留拿金、上限3、超10触发弃置', () => {
  const st = newGame();
  const p = st.players[st.current];
  let r = act(st, { act: P.ACT.RESERVE, from: 'market', cardId: st.market[3][0] });
  assert.ok(r.ok);
  assert.equal(r.state.players[p.seat].reserved.length, 1);
  assert.equal(r.state.players[p.seat].tokens.gold, 1);
  assert.equal(r.state.supply.gold, 4);

  const st2 = r.state;
  const next = st2.current;
  const deckSize = st2.decks[2].length;
  r = act(st2, { act: P.ACT.RESERVE, from: 'deck', level: 2 }, next);
  assert.ok(r.ok);
  assert.equal(r.state.decks[2].length, deckSize - 1);
  assert.equal(r.state.players[next].reserved.length, 1);

  const st3 = newGame({ seed: 3 });
  const p3 = st3.players[st3.current];
  p3.reserved = [{ id: 't1-01' }, { id: 't1-02' }, { id: 't1-03' }];
  r = act(st3, { act: P.ACT.RESERVE, from: 'deck', level: 1 });
  assert.ok(!r.ok && r.error === 'INVALID_ACTION');

  const st4 = newGame({ seed: 4 });
  const p4 = st4.players[st4.current];
  p4.tokens = { white: 4, blue: 3, green: 3, red: 0, black: 0, gold: 0 };
  r = act(st4, { act: P.ACT.RESERVE, from: 'market', cardId: st4.market[1][0] });
  assert.ok(r.ok);
  assert.equal(r.state.phase, 'discard');
  assert.equal(r.state.pending.discardCount, 1);
  r = act(r.state, { act: P.ACT.DISCARD, tokens: { blue: 1 } });
  assert.ok(r.ok);
  assert.equal(r.state.players[p4.seat].tokens.blue, 2);
  assert.equal(r.state.players[p4.seat].tokens.gold, 1);
  assert.equal(r.state.phase, 'action');
});

// ---------------------------------------------------------------- nobles

test('贵族:唯一满足自动拜访;多选一时进入选择阶段', () => {
  const st = newGame({ seed: 13 });
  const p = st.players[st.current];
  st.nobles = [{ id: 'n-5', claimedBy: null }];
  p.bonus = { white: 0, blue: 3, green: 3, red: 3, black: 0 };
  let r = act(st, { act: P.ACT.TAKE_GEMS, picks: { white: 1, blue: 1, red: 1 } });
  assert.ok(r.ok);
  assert.equal(r.state.nobles[0].claimedBy, p.seat);
  assert.equal(r.state.players[p.seat].points, 3);

  const st2 = newGame({ seed: 5 });
  const p2 = st2.players[st2.current];
  st2.nobles = [
    { id: 'n-5', claimedBy: null },
    { id: 'n-6', claimedBy: null }
  ];
  p2.bonus = { white: 3, blue: 3, green: 3, red: 3, black: 0 };
  r = act(st2, { act: P.ACT.TAKE_GEMS, picks: { white: 1, blue: 1, red: 1 } });
  assert.ok(r.ok);
  assert.equal(r.state.phase, 'noble');
  assert.equal(r.state.pending.nobleChoices.length, 2);
  r = act(r.state, { act: P.ACT.CHOOSE_NOBLE, nobleId: 'n-6' });
  assert.ok(r.ok);
  assert.equal(r.state.players[p2.seat].nobles[0], 'n-6');
  assert.equal(r.state.phase, 'action');
});

// ---------------------------------------------------------------- end game

test('终局:15分后轮完本轮才结算', () => {
  const st = newGame({ seed: 14 });
  const [a, b] = st.players;
  st.current = a.seat;
  forceMarket(st, 1, 't1-08'); // 黑卡 1分 蓝4
  a.cards = ['t3-04', 't3-08', 't2-06', 't1-16']; // 14 分
  a.tokens.blue = 4;
  let r = act(st, { act: P.ACT.BUY, from: 'market', cardId: 't1-08' });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.state.players[a.seat].points, 15);
  assert.notEqual(r.state.phase, 'finished');
  assert.equal(r.state.endAfterTurn, r.state.turnNo); // 本轮最后一位行动后结算
  r = act(r.state, { act: P.ACT.TAKE_GEMS, picks: { white: 1, blue: 1, red: 1 } }, b.seat);
  assert.ok(r.ok);
  assert.equal(r.state.phase, 'finished');
  assert.deepEqual(r.state.result.winners, [a.seat]);
  assert.equal(r.state.result.reason, 'prestige');
});

test('终局平局:同分比发展卡数少者', () => {
  const st = newGame({ seed: 11 });
  const [a, b] = st.players;
  st.current = a.seat;
  forceMarket(st, 1, 't1-08'); // 1分 蓝4
  forceMarket(st, 2, 't2-03'); // 2分 蓝1绿4红2
  a.cards = ['t3-04', 't3-08', 't2-06', 't1-16']; // 14 分 → 买后 15 分 5 张卡
  a.tokens.blue = 4;
  b.cards = ['t3-08', 't3-12', 't2-06']; // 13 分 → 买后 15 分 4 张卡
  b.tokens = { white: 0, blue: 1, green: 4, red: 2, black: 0, gold: 0 };
  let r = act(st, { act: P.ACT.BUY, from: 'market', cardId: 't1-08' });
  assert.ok(r.ok);
  r = act(r.state, { act: P.ACT.BUY, from: 'market', cardId: 't2-03' }, b.seat);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.state.phase, 'finished');
  assert.equal(r.state.players[b.seat].points, 15);
  assert.deepEqual(r.state.result.winners, [b.seat]); // 卡更少
});

// ---------------------------------------------------------------- 扩展:贸易站

test('贸易站:达成条件获得特权,单回合多个需选择', () => {
  const st = newGame({ tradingPosts: true });
  const p = st.players[st.current];
  p.bonus = { white: 2, blue: 3, black: 1, green: 0, red: 0 }; // 同时满足 tp-1 tp-2
  let r = act(st, { act: P.ACT.TAKE_GEMS, picks: { white: 1, blue: 1, red: 1 } });
  assert.ok(r.ok);
  assert.equal(r.state.phase, 'tradingPost');
  assert.deepEqual(r.state.pending.tpChoices.sort(), ['tp-1', 'tp-2']);
  r = act(r.state, { act: P.ACT.CHOOSE_TP, tpId: 'tp-2' });
  assert.ok(r.ok);
  assert.deepEqual(r.state.players[p.seat].shields, ['tp-2']);
});

test('贸易站:pointsPerPost 每贸易站1分,可触发终局', () => {
  const st = newGame({ tradingPosts: true, seed: 15 });
  const p = st.players[st.current];
  p.cards = ['t3-04', 't3-08', 't2-06', 't1-16']; // 14 分
  p.bonus = { white: 2, green: 5, blue: 0, red: 0, black: 0 };
  let r = act(st, { act: P.ACT.TAKE_GEMS, picks: { white: 1, blue: 1, red: 1 } });
  assert.ok(r.ok);
  assert.equal(r.state.phase, 'tradingPost');
  r = act(r.state, { act: P.ACT.CHOOSE_TP, tpId: 'tp-1' });
  assert.ok(r.ok);
  assert.equal(r.state.players[p.seat].points, 14);

  const st2 = r.state;
  st2.current = p.seat; // 手动再给 p 一回合(单元测试直改状态)
  st2.phase = 'action';
  st2.pending = null;
  r = act(st2, { act: P.ACT.TAKE_GEMS, picks: { white: 1, blue: 1, red: 1 } });
  assert.ok(r.ok);
  // 仅剩 tp-4 满足 → 自动授予,无需选择;14+2=16 触发终局
  assert.equal(r.state.players[p.seat].points, 16);
  assert.deepEqual(r.state.players[p.seat].shields, ['tp-1', 'tp-4']);
  assert.ok(r.state.endAfterTurn !== null);
});

test('贸易站:extraOnDouble 附赠宝石需指定颜色', () => {
  const st = newGame({ tradingPosts: true, seed: 16 });
  const p = st.players[st.current];
  p.shields = ['tp-1'];
  let r = act(st, { act: P.ACT.TAKE_GEMS, picks: { white: 2 } });
  assert.ok(!r.ok && r.error === 'NEED_BONUS_COLOR');
  assert.equal(st.players[p.seat].tokens.white, 0); // 校验先于执行
  r = act(st, { act: P.ACT.TAKE_GEMS, picks: { white: 2 }, bonusColor: 'red' });
  assert.ok(r.ok);
  assert.equal(r.state.players[p.seat].tokens.white, 2);
  assert.equal(r.state.players[p.seat].tokens.red, 1);
});

test('贸易站:goldTwo 一金当两颗同色', () => {
  const st = newGame({ tradingPosts: true, seed: 17 });
  const p = st.players[st.current];
  p.shields = ['tp-2'];
  const cid = st.market[1][0];
  const cost = cardDb.cards[cid].cost;
  const first = Object.keys(cost)[0];
  for (const [c, v] of Object.entries(cost)) p.tokens[c] = v;
  p.tokens[first] -= 2;
  p.tokens.gold = 1;
  let r = act(st, { act: P.ACT.BUY, from: 'market', cardId: cid });
  assert.ok(r.ok, '1金抵2同色应可支付');
  assert.equal(r.state.players[p.seat].tokens.gold, 0);
});

test('贸易站:gemOnBuy 买后必须拿一颗宝石', () => {
  const st = newGame({ tradingPosts: true, seed: 18 });
  const p = st.players[st.current];
  p.shields = ['tp-0'];
  const cid = st.market[1][0];
  for (const [c, v] of Object.entries(cardDb.cards[cid].cost)) p.tokens[c] = v;
  let r = act(st, { act: P.ACT.BUY, from: 'market', cardId: cid });
  assert.ok(r.ok);
  assert.equal(r.state.phase, 'bonusGem');
  const st1 = r.state;
  r = act(st1, { act: P.ACT.BONUS_GEM, color: null });
  assert.ok(!r.ok);
  r = act(st1, { act: P.ACT.BONUS_GEM, color: 'red' });
  assert.ok(r.ok);
  assert.equal(r.state.players[p.seat].tokens.red >= 1, true);
});

test('贸易站:peekReserve 盲抽看二留一,另一张回牌库底', () => {
  const st = newGame({ tradingPosts: true, seed: 21 });
  const q = st.players[st.current];
  q.shields = ['tp-3'];
  const deckTop = [...st.decks[1]].slice(-2).reverse(); // pop 顺序 [c1, c2]
  let r = act(st, { act: P.ACT.RESERVE, from: 'deck', level: 1 });
  assert.ok(r.ok);
  assert.equal(r.state.phase, 'peek');
  assert.deepEqual(r.state.pending.peek.cards, deckTop);
  const deckLen = r.state.decks[1].length;
  r = act(r.state, { act: P.ACT.CHOOSE_PEEK, keepIndex: 0 });
  assert.ok(r.ok);
  assert.equal(r.state.players[q.seat].reserved[0].id, deckTop[0]);
  assert.equal(r.state.decks[1].length, deckLen + 1);
  assert.equal(r.state.players[q.seat].tokens.gold, 1);
});

// ---------------------------------------------------------------- 扩展:城市

test('城市:达成要求触发终局,同轮多人达成比声望分', () => {
  const st = newGame({ cities: true, seed: 22 });
  const [a, b] = st.players;
  st.current = a.seat;
  st.cities = [{ id: 'c-4' }]; // 11 分 + 红4绿4
  a.cards = ['t3-04', 't3-08', 't2-06', 't1-16'];
  a.points = 14;
  a.bonus = { white: 0, blue: 0, green: 4, red: 4, black: 0 };
  let r = act(st, { act: P.ACT.TAKE_GEMS, picks: { white: 1, blue: 1, black: 1 } });
  assert.ok(r.ok);
  assert.equal(r.state.endAfterTurn, r.state.turnNo);
  assert.notEqual(r.state.phase, 'finished');

  const st2 = r.state;
  const p2 = st2.players[1];
  p2.cards = ['t3-04', 't3-08', 't2-06', 't3-12'];
  p2.points = 18;
  p2.bonus = { white: 0, blue: 0, green: 4, red: 4, black: 0 };
  r = act(st2, { act: P.ACT.TAKE_GEMS, picks: { white: 1, blue: 1, black: 1 } }, 1);
  assert.ok(r.ok);
  assert.equal(r.state.phase, 'finished');
  assert.deepEqual(r.state.result.winners, [1]); // 同为达成者,声望 18 > 14
  assert.equal(r.state.result.reason, 'city');
});

test('城市模式:15 分不触发终局', () => {
  const st = newGame({ cities: true, seed: 23 });
  const a = st.players[st.current];
  a.cards = ['t3-04', 't3-08', 't2-06', 't3-12', 't2-01']; // 18 分
  let r = act(st, { act: P.ACT.TAKE_GEMS, picks: { white: 1, blue: 1, red: 1 } });
  assert.ok(r.ok);
  assert.equal(r.state.endAfterTurn, null);
  assert.notEqual(r.state.phase, 'finished');
});

// ---------------------------------------------------------------- view

test('viewFor:他人预留牌隐藏、牌库只送数量、peek 对他人隐藏', () => {
  const st = newGame({ tradingPosts: true, seed: 24 });
  const a = st.players[st.current];
  a.reserved.push({ id: 't1-01' }, { id: 't2-02' });
  a.shields = ['tp-3'];
  st.phase = 'peek';
  st.pending = { peek: { level: 2, cards: ['t2-03', 't2-04'] } };
  const other = (a.seat + 1) % st.players.length;
  const v = engine.viewFor(st, other);
  assert.equal(v.players[a.seat].reserved.length, 2);
  assert.deepEqual(v.players[a.seat].reserved[0], { hidden: true });
  assert.equal(typeof v.decks[1], 'number');
  assert.equal(v.pending.peek.cards, undefined);
  assert.equal(v.pending.peek.count, 2);
  const own = engine.viewFor(st, a.seat);
  assert.equal(own.players[a.seat].reserved[0].id, 't1-01');
  assert.deepEqual(own.pending.peek.cards, ['t2-03', 't2-04']);
});

// ---------------------------------------------------------------- bot 模拟

function invariants(st, tag) {
  let tokens = st.supply.gold;
  for (const c of COLORS) tokens += st.supply[c];
  for (const p of st.players) {
    tokens += p.tokens.gold;
    for (const c of COLORS) tokens += p.tokens[c];
  }
  assert.equal(tokens, P.GEM_TOTALS[st.players.length] * 5 + P.GOLD_TOTAL, `${tag}: 代币守恒`);

  const seen = new Set();
  const add = (ids) => {
    for (const id of ids) {
      assert.ok(!seen.has(id), `${tag}: 卡牌重复 ${id}`);
      seen.add(id);
    }
  };
  for (const lv of [1, 2, 3]) {
    add(st.market[lv]);
    add(st.decks[lv]);
  }
  for (const p of st.players) {
    add(p.cards);
    add(p.reserved.map((r) => r.id));
  }
  if (st.pending && st.pending.peek) add(st.pending.peek.cards);
  assert.equal(seen.size, 90, `${tag}: 卡牌总数 90`);
}

function botGame(opts, seed) {
  const rng = mulberry32(seed);
  let st = engine.createGame({
    names: Array.from({ length: opts.n }, (_, i) => 'P' + i),
    options: { cities: !!opts.cities, tradingPosts: !!opts.tradingPosts },
    cardDb,
    rng
  });
  let steps = 0;
  while (st.phase !== 'finished') {
    assert.ok(steps < 1200, `游戏应在有限步内结束 seed=${seed}`);
    const acts = engine.enumerateActions(st, cardDb);
    assert.ok(acts.length > 0, `存在合法行动 seed=${seed} step=${steps} phase=${st.phase}`);
    let pick = acts[Math.floor(rng() * acts.length)];
    let r = engine.applyAction(st, st.current, pick, cardDb);
    if (!r.ok && r.error === 'NEED_BONUS_COLOR') {
      const c = Object.keys(pick.picks)[0];
      const choices = COLORS.filter((x) => x !== c && st.supply[x] > 0);
      pick = { ...pick, bonusColor: choices[Math.floor(rng() * choices.length)] };
      r = engine.applyAction(st, st.current, pick, cardDb);
    }
    assert.ok(r.ok, `bot 行动应成功 seed=${seed} step=${steps} act=${JSON.stringify(pick)} err=${r.error}`);
    st = r.state;
    steps++;
    invariants(st, `seed=${seed}`);
  }
  assert.ok(st.result.winners.length >= 1);
  assert.equal(st.result.ranking.length, opts.n);
  return steps;
}

test('bot 随机模拟:2人基础局 ×60', () => {
  for (let seed = 1; seed <= 60; seed++) botGame({ n: 2 }, seed * 17);
});

test('bot 随机模拟:3/4人 + 扩展组合', () => {
  const combos = [
    { n: 3, cities: false, tradingPosts: false },
    { n: 4, cities: true, tradingPosts: false },
    { n: 3, cities: false, tradingPosts: true },
    { n: 4, cities: true, tradingPosts: true },
    { n: 2, cities: true, tradingPosts: true }
  ];
  let i = 0;
  for (const combo of combos) {
    for (let seed = 1; seed <= 8; seed++) {
      i++;
      botGame(combo, seed * 31 + i);
    }
  }
});
