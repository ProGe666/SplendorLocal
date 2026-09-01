'use strict';

// 璀璨宝石规则引擎(纯函数、零 IO)。
// 规则依据:基础版官方规则 + Silk Road(2024)版「城市 / 贸易站」模块官方规则。

const P = require('../public/protocol');
const COLORS = P.COLORS;

function blankTokens() {
  return { white: 0, blue: 0, green: 0, red: 0, black: 0, gold: 0 };
}

function blankBonus() {
  return { white: 0, blue: 0, green: 0, red: 0, black: 0 };
}

function tokenCount(t) {
  let n = 0;
  for (const c of COLORS) n += t[c];
  return n + t.gold;
}

function bonusSum(b) {
  let n = 0;
  for (const c of COLORS) n += b[c];
  return n;
}

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function covers(bonus, req) {
  for (const k of Object.keys(req)) {
    if (k === 'any') continue;
    if ((bonus[k] || 0) < req[k]) return false;
  }
  if ('any' in req && bonusSum(bonus) < req.any) return false;
  return true;
}

function log(s, kind, data) {
  s.log.push({ turnNo: s.turnNo, seat: s.current, kind, data });
  if (s.log.length > 60) s.log.splice(0, s.log.length - 60);
}

// ---------------------------------------------------------------- createGame

function createGame({ names, options, cardDb, rng }) {
  const n = names.length;
  if (n < 2 || n > 4) throw new Error('players must be 2-4');
  const gemsPerColor = P.GEM_TOTALS[n];

  const decks = { 1: [], 2: [], 3: [] };
  for (const id of Object.keys(cardDb.cards)) decks[cardDb.cards[id].level].push(id);
  for (const lv of [1, 2, 3]) shuffle(decks[lv], rng);

  const market = { 1: [], 2: [], 3: [] };
  for (const lv of [1, 2, 3]) {
    while (market[lv].length < 4 && decks[lv].length) market[lv].push(decks[lv].pop());
  }

  let nobles = [];
  let cityTiles = [];
  if (options.cities) {
    cityTiles = shuffle(Object.keys(cardDb.cities), rng).slice(0, P.CITY_COUNT).map((id) => ({ id }));
  } else {
    nobles = shuffle(Object.keys(cardDb.nobles), rng)
      .slice(0, n + 1)
      .map((id) => ({ id, claimedBy: null }));
  }

  const tradingPosts = options.tradingPosts ? Object.keys(cardDb.tradingPosts).map((id) => ({ id })) : [];

  const supply = blankTokens();
  for (const c of COLORS) supply[c] = gemsPerColor;
  supply.gold = P.GOLD_TOTAL;

  const start = Math.floor(rng() * n);

  const state = {
    config: { playerCount: n, expansions: { cities: !!options.cities, tradingPosts: !!options.tradingPosts } },
    phase: 'action',
    current: start,
    turnNo: 1,
    round: 1,
    endAfterTurn: null,
    result: null,
    supply,
    decks,
    market,
    nobles,
    cities: cityTiles,
    tradingPosts,
    players: names.map((name, i) => ({
      seat: i,
      name,
      tokens: blankTokens(),
      bonus: blankBonus(),
      cards: [],
      reserved: [],
      nobles: [],
      shields: [],
      points: 0,
      score: { cards: 0, nobles: 0, tradingPosts: 0 }
    })),
    pending: null,
    log: []
  };
  log(state, 'start', { seat: start });
  return state;
}

// ---------------------------------------------------------------- helpers

function cur(s) {
  return s.players[s.current];
}

function holdsTp(s, player, effect, db) {
  if (!s.config.expansions.tradingPosts) return false;
  return player.shields.some((id) => db.tradingPosts[id].effect === effect);
}

function recalcPoints(s, db) {
  for (const p of s.players) {
    let cardPts = 0;
    for (const id of p.cards) cardPts += db.cards[id].points;
    let noblePts = 0;
    for (const id of p.nobles) noblePts += db.nobles[id].points;
    let tpPts = 0;
    for (const id of p.shields) if (db.tradingPosts[id].effect === 'pointsPerPost') tpPts = p.shields.length;
    p.points = cardPts + noblePts + tpPts;
    p.score = { cards: cardPts, nobles: noblePts, tradingPosts: tpPts };
  }
}

function computePayment(player, cost, goldTwo) {
  const colorPays = {};
  let goldNeed = 0;
  for (const c of COLORS) {
    const eff = Math.max(0, (cost[c] || 0) - player.bonus[c]);
    if (eff <= 0) continue;
    const pay = Math.min(player.tokens[c], eff);
    if (pay > 0) colorPays[c] = pay;
    const deficit = eff - pay;
    if (deficit > 0) goldNeed += goldTwo ? Math.ceil(deficit / 2) : deficit;
  }
  if (goldNeed > player.tokens.gold) return null;
  return { colorPays, goldNeed };
}

function marketRefill(s, level) {
  while (s.market[level].length < 4 && s.decks[level].length) s.market[level].push(s.decks[level].pop());
}

function cityQualifies(s, player, cityId, db) {
  const city = db.cities[cityId];
  return player.points >= city.points && covers(player.bonus, city.req);
}

function qualifiesAnyCity(s, player, db) {
  return s.cities.some((ct) => cityQualifies(s, player, ct.id, db));
}

function availableColors(s) {
  return COLORS.filter((c) => s.supply[c] > 0);
}

// ---------------------------------------------------------------- turn flow
// 回合收尾步骤:1弃置 2贵族 3贸易站 4城市 5终局判定 6轮转

function advancePhase(s, db, step) {
  const p = cur(s);
  if (step <= 1 && tokenCount(p.tokens) > P.TOKEN_LIMIT) {
    s.phase = 'discard';
    s.pending = { discardCount: tokenCount(p.tokens) - P.TOKEN_LIMIT };
    return;
  }
  if (step <= 2 && !s.config.expansions.cities) {
    const qual = s.nobles.filter((nb) => nb.claimedBy === null && covers(p.bonus, db.nobles[nb.id].req));
    if (qual.length === 1) {
      qual[0].claimedBy = p.seat;
      p.nobles.push(qual[0].id);
      recalcPoints(s, db);
      log(s, 'noble', { noble: qual[0].id });
    } else if (qual.length > 1) {
      s.phase = 'noble';
      s.pending = { nobleChoices: qual.map((nb) => nb.id) };
      return;
    }
  }
  if (step <= 3 && s.config.expansions.tradingPosts) {
    const qual = s.tradingPosts
      .map((tp) => tp.id)
      .filter((id) => !p.shields.includes(id) && covers(p.bonus, db.tradingPosts[id].req));
    if (qual.length === 1) {
      grantTradingPost(s, p, qual[0], db);
    } else if (qual.length > 1) {
      s.phase = 'tradingPost';
      s.pending = { tpChoices: qual };
      return;
    }
  }
  if (step <= 4 && s.config.expansions.cities && s.endAfterTurn === null && qualifiesAnyCity(s, p, db)) {
    log(s, 'city', {});
    setEndAfterTurn(s);
  }
  if (step <= 5) checkEnd(s);
  nextTurn(s, db);
}

function grantTradingPost(s, p, tpId, db) {
  p.shields.push(tpId);
  recalcPoints(s, db);
  log(s, 'tp', { tp: tpId });
}

function setEndAfterTurn(s) {
  const n = s.players.length;
  const seatIdx = (s.turnNo - 1) % n;
  s.endAfterTurn = s.turnNo + (n - 1 - seatIdx);
}

function checkEnd(s) {
  if (s.endAfterTurn !== null) return;
  if (s.config.expansions.cities) return; // 城市模式:仅城市达成触发终局
  if (s.players.some((p) => p.points >= P.WIN_POINTS)) setEndAfterTurn(s);
}

function nextTurn(s, db) {
  if (s.phase === 'finished') return;
  if (s.endAfterTurn !== null && s.turnNo >= s.endAfterTurn) {
    finish(s, db);
    return;
  }
  s.turnNo += 1;
  s.current = (s.current + 1) % s.players.length;
  s.round = Math.floor((s.turnNo - 1) / s.players.length) + 1;
  s.phase = 'action';
  s.pending = null;
  // 兜底:当前玩家无任何合法行动时自动跳过,防止死锁
  let guard = 0;
  while (enumerateActions(s, db).length === 0 && guard++ < 30) {
    log(s, 'skip', {});
    if (s.endAfterTurn !== null && s.turnNo >= s.endAfterTurn) {
      finish(s, db);
      return;
    }
    s.turnNo += 1;
    s.current = (s.current + 1) % s.players.length;
    s.round = Math.floor((s.turnNo - 1) / s.players.length) + 1;
  }
}

function finish(s, db) {
  s.phase = 'finished';
  s.pending = null;
  const byRank = (a, b) => b.points - a.points || a.cards.length - b.cards.length;
  if (s.config.expansions.cities) {
    const qualifiers = s.players.filter((p) => qualifiesAnyCity(s, p, db));
    const rest = s.players.filter((p) => !qualifiers.includes(p));
    qualifiers.sort(byRank);
    rest.sort(byRank);
    const top = qualifiers.filter(
      (p) => p.points === qualifiers[0].points && p.cards.length === qualifiers[0].cards.length
    );
    s.result = {
      reason: 'city',
      winners: top.map((p) => p.seat),
      ranking: [...qualifiers, ...rest].map((p) => ({
        seat: p.seat,
        name: p.name,
        points: p.points,
        cards: p.cards.length,
        qualified: qualifiers.includes(p)
      }))
    };
  } else {
    const sorted = [...s.players].sort(byRank);
    const top = sorted.filter((p) => p.points === sorted[0].points && p.cards.length === sorted[0].cards.length);
    s.result = {
      reason: 'prestige',
      winners: top.map((p) => p.seat),
      ranking: sorted.map((p) => ({ seat: p.seat, name: p.name, points: p.points, cards: p.cards.length }))
    };
  }
  log(s, 'end', { winners: s.result.winners });
}

// ---------------------------------------------------------------- actions
// 每个 do* 返回 null(成功)或错误码;成功时已推进回合或设置子阶段

function doTakeGems(s, p, a, db) {
  const picks = a.picks || {};
  const keys = Object.keys(picks).filter((k) => picks[k] > 0);
  if (keys.some((k) => !COLORS.includes(k) || !Number.isInteger(picks[k]) || picks[k] < 1)) return 'INVALID_ACTION';
  if (keys.some((k) => s.supply[k] < picks[k])) return 'INVALID_ACTION';

  if (keys.length === 1 && picks[keys[0]] === 2) {
    const c = keys[0];
    if (s.supply[c] < 4) return 'INVALID_ACTION';
    let bonus = null;
    if (holdsTp(s, p, 'extraOnDouble', db)) {
      const opts = COLORS.filter((x) => x !== c && s.supply[x] > 0);
      if (opts.length > 0) {
        const b = a.bonusColor;
        if (!b || !COLORS.includes(b) || b === c || s.supply[b] < 1) return 'NEED_BONUS_COLOR';
        bonus = b;
      }
    }
    s.supply[c] -= 2;
    p.tokens[c] += 2;
    log(s, 'take', { picks: { [c]: 2 } });
    if (bonus) {
      s.supply[bonus] -= 1;
      p.tokens[bonus] += 1;
      log(s, 'takeBonus', { color: bonus });
    }
  } else {
    if (keys.length < 1 || keys.length > 3) return 'INVALID_ACTION';
    if (keys.some((k) => picks[k] !== 1)) return 'INVALID_ACTION';
    const avail = availableColors(s).length;
    if (keys.length === 2 && avail > 2) return 'INVALID_ACTION';
    if (keys.length === 1 && avail > 1) return 'INVALID_ACTION';
    for (const k of keys) {
      s.supply[k] -= 1;
      p.tokens[k] += 1;
    }
    log(s, 'take', { picks });
  }
  advancePhase(s, db, 1);
  return null;
}

function doBuy(s, p, a, db) {
  const cardId = a.cardId;
  let fromReserved = false;
  if (a.from === 'reserved') {
    if (!p.reserved.some((r) => r.id === cardId)) return 'INVALID_ACTION';
    fromReserved = true;
  } else {
    let found = false;
    for (const lv of [1, 2, 3]) if (s.market[lv].includes(cardId)) found = true;
    if (!found) return 'INVALID_ACTION';
  }
  const card = db.cards[cardId];
  const pay = computePayment(p, card.cost, holdsTp(s, p, 'goldTwo', db));
  if (!pay) return 'INVALID_ACTION';

  for (const [c, v] of Object.entries(pay.colorPays)) {
    p.tokens[c] -= v;
    s.supply[c] += v;
  }
  p.tokens.gold -= pay.goldNeed;
  s.supply.gold += pay.goldNeed;

  p.cards.push(cardId);
  p.bonus[card.color] += 1;
  if (fromReserved) {
    p.reserved = p.reserved.filter((r) => r.id !== cardId);
  } else {
    for (const lv of [1, 2, 3]) {
      const i = s.market[lv].indexOf(cardId);
      if (i >= 0) s.market[lv].splice(i, 1);
    }
  }
  recalcPoints(s, db);
  log(s, 'buy', { card: cardId, gold: pay.goldNeed });

  if (!fromReserved) marketRefill(s, card.level);

  if (holdsTp(s, p, 'gemOnBuy', db) && availableColors(s).length > 0) {
    s.phase = 'bonusGem';
    s.pending = { bonusGem: true };
    return null;
  }
  advancePhase(s, db, 1);
  return null;
}

function doReserve(s, p, a, db) {
  if (p.reserved.length >= P.RESERVE_LIMIT) return 'INVALID_ACTION';
  if (a.from === 'market') {
    let found = false;
    for (const lv of [1, 2, 3]) {
      const i = s.market[lv].indexOf(a.cardId);
      if (i >= 0) {
        s.market[lv].splice(i, 1);
        marketRefill(s, lv);
        found = true;
      }
    }
    if (!found) return 'INVALID_ACTION';
    p.reserved.push({ id: a.cardId });
    log(s, 'reserve', { from: 'market', card: a.cardId });
  } else if (a.from === 'deck') {
    const lv = a.level;
    if (![1, 2, 3].includes(lv)) return 'INVALID_ACTION';
    const deck = s.decks[lv];
    if (deck.length === 0) return 'INVALID_ACTION';
    if (holdsTp(s, p, 'peekReserve', db) && deck.length >= 2) {
      const c1 = deck.pop();
      const c2 = deck.pop();
      s.phase = 'peek';
      s.pending = { peek: { level: lv, cards: [c1, c2] } };
      return null;
    }
    p.reserved.push({ id: deck.pop() });
    log(s, 'reserve', { from: 'deck', level: lv });
  } else {
    return 'INVALID_ACTION';
  }
  if (s.supply.gold > 0) {
    s.supply.gold -= 1;
    p.tokens.gold += 1;
  }
  advancePhase(s, db, 1);
  return null;
}

function doChoosePeek(s, p, a, db) {
  const peek = s.pending && s.pending.peek;
  if (!peek) return 'INVALID_ACTION';
  if (a.keepIndex !== 0 && a.keepIndex !== 1) return 'INVALID_ACTION';
  p.reserved.push({ id: peek.cards[a.keepIndex] });
  s.decks[peek.level].unshift(peek.cards[1 - a.keepIndex]); // 另一张放回牌库底
  s.pending = null;
  log(s, 'reserve', { from: 'deck', level: peek.level });
  if (s.supply.gold > 0) {
    s.supply.gold -= 1;
    p.tokens.gold += 1;
  }
  advancePhase(s, db, 1);
  return null;
}

function doDiscard(s, p, a, db) {
  const want = a.tokens || {};
  let sum = 0;
  for (const [c, v] of Object.entries(want)) {
    if ((!COLORS.includes(c) && c !== 'gold') || !Number.isInteger(v) || v < 0) return 'INVALID_ACTION';
    if (v > p.tokens[c]) return 'INVALID_ACTION';
    sum += v;
  }
  if (!s.pending || sum !== s.pending.discardCount) return 'INVALID_ACTION';
  for (const [c, v] of Object.entries(want)) {
    if (v > 0) {
      p.tokens[c] -= v;
      s.supply[c] += v;
    }
  }
  log(s, 'discard', { tokens: want, count: sum });
  s.pending = null;
  advancePhase(s, db, 2);
  return null;
}

function doChooseNoble(s, p, a, db) {
  if (!s.pending || !Array.isArray(s.pending.nobleChoices) || !s.pending.nobleChoices.includes(a.nobleId)) {
    return 'INVALID_ACTION';
  }
  const nb = s.nobles.find((x) => x.id === a.nobleId);
  nb.claimedBy = p.seat;
  p.nobles.push(a.nobleId);
  s.pending = null;
  recalcPoints(s, db);
  log(s, 'noble', { noble: a.nobleId });
  advancePhase(s, db, 3);
  return null;
}

function doChooseTp(s, p, a, db) {
  if (!s.pending || !Array.isArray(s.pending.tpChoices) || !s.pending.tpChoices.includes(a.tpId)) {
    return 'INVALID_ACTION';
  }
  s.pending = null;
  grantTradingPost(s, p, a.tpId, db);
  advancePhase(s, db, 4);
  return null;
}

function doBonusGem(s, p, a, db) {
  if (a.color == null) return 'INVALID_ACTION'; // 供应区有非金宝石时必须拿
  if (!COLORS.includes(a.color) || s.supply[a.color] < 1) return 'INVALID_ACTION';
  s.supply[a.color] -= 1;
  p.tokens[a.color] += 1;
  log(s, 'takeBonus', { color: a.color });
  s.pending = null;
  advancePhase(s, db, 1);
  return null;
}

function exec(s, seat, a, db) {
  if (s.phase === 'finished') return 'INVALID_ACTION';
  if (!a || typeof a !== 'object' || typeof a.act !== 'string') return 'BAD_REQUEST';
  if (seat !== s.current) return 'NOT_YOUR_TURN';
  const p = cur(s);

  switch (a.act) {
    case P.ACT.TAKE_GEMS:
      return s.phase === 'action' ? doTakeGems(s, p, a, db) : 'INVALID_ACTION';
    case P.ACT.BUY:
      return s.phase === 'action' ? doBuy(s, p, a, db) : 'INVALID_ACTION';
    case P.ACT.RESERVE:
      return s.phase === 'action' ? doReserve(s, p, a, db) : 'INVALID_ACTION';
    case P.ACT.CHOOSE_PEEK:
      return s.phase === 'peek' ? doChoosePeek(s, p, a, db) : 'INVALID_ACTION';
    case P.ACT.DISCARD:
      return s.phase === 'discard' ? doDiscard(s, p, a, db) : 'INVALID_ACTION';
    case P.ACT.CHOOSE_NOBLE:
      return s.phase === 'noble' ? doChooseNoble(s, p, a, db) : 'INVALID_ACTION';
    case P.ACT.CHOOSE_TP:
      return s.phase === 'tradingPost' ? doChooseTp(s, p, a, db) : 'INVALID_ACTION';
    case P.ACT.BONUS_GEM:
      return s.phase === 'bonusGem' ? doBonusGem(s, p, a, db) : 'INVALID_ACTION';
    default:
      return 'BAD_REQUEST';
  }
}

function applyAction(state, seat, action, cardDb) {
  const s = structuredClone(state);
  const err = exec(s, seat, action, cardDb);
  if (err) return { ok: false, error: err };
  return { ok: true, state: s };
}

// ---------------------------------------------------------------- view

function viewFor(state, seat) {
  const s = structuredClone(state);
  for (const p of s.players) {
    if (p.seat !== seat) p.reserved = p.reserved.map(() => ({ hidden: true }));
  }
  s.decks = { 1: state.decks[1].length, 2: state.decks[2].length, 3: state.decks[3].length };
  if (s.pending && s.pending.peek && seat !== state.current) {
    s.pending.peek = { level: s.pending.peek.level, count: 2 };
  }
  return s;
}

// ---------------------------------------------------------------- enumerate(测试/bot/兜底)

function enumerateActions(state, db) {
  const acts = [];
  if (state.phase === 'finished') return acts;
  const p = state.players[state.current];

  if (state.phase === 'discard') {
    // 贪心弃置:从数量最多的颜色弃起(含金)
    const tokens = { ...p.tokens };
    const want = {};
    let need = state.pending.discardCount;
    const order = [...COLORS, 'gold'].sort((a, b) => tokens[b] - tokens[a]);
    for (const c of order) {
      while (need > 0 && tokens[c] > 0) {
        want[c] = (want[c] || 0) + 1;
        tokens[c] -= 1;
        need -= 1;
      }
    }
    if (need === 0) acts.push({ act: P.ACT.DISCARD, tokens: want });
    return acts;
  }
  if (state.phase === 'noble') {
    for (const id of state.pending.nobleChoices) acts.push({ act: P.ACT.CHOOSE_NOBLE, nobleId: id });
    return acts;
  }
  if (state.phase === 'tradingPost') {
    for (const id of state.pending.tpChoices) acts.push({ act: P.ACT.CHOOSE_TP, tpId: id });
    return acts;
  }
  if (state.phase === 'peek') {
    acts.push({ act: P.ACT.CHOOSE_PEEK, keepIndex: 0 }, { act: P.ACT.CHOOSE_PEEK, keepIndex: 1 });
    return acts;
  }
  if (state.phase === 'bonusGem') {
    for (const c of availableColors(state)) acts.push({ act: P.ACT.BONUS_GEM, color: c });
    return acts;
  }
  if (state.phase !== 'action') return acts;

  for (const c of COLORS) {
    if (state.supply[c] >= 4) acts.push({ act: P.ACT.TAKE_GEMS, picks: { [c]: 2 } });
  }
  const avail = availableColors(state);
  const combos = [];
  if (avail.length >= 3) {
    for (let i = 0; i < avail.length; i++)
      for (let j = i + 1; j < avail.length; j++)
        for (let k = j + 1; k < avail.length; k++) combos.push([avail[i], avail[j], avail[k]]);
  } else if (avail.length === 2) {
    combos.push([avail[0], avail[1]]);
  } else if (avail.length === 1) {
    combos.push([avail[0]]);
  }
  for (const combo of combos) {
    const picks = {};
    for (const c of combo) picks[c] = 1;
    acts.push({ act: P.ACT.TAKE_GEMS, picks });
  }

  const goldTwo = state.config.expansions.tradingPosts && p.shields.some((id) => db.tradingPosts[id].effect === 'goldTwo');
  const canBuy = (cost) => !!computePayment(p, cost, goldTwo);
  for (const lv of [1, 2, 3]) {
    for (const id of state.market[lv]) {
      if (canBuy(db.cards[id].cost)) acts.push({ act: P.ACT.BUY, from: 'market', cardId: id });
      if (p.reserved.length < P.RESERVE_LIMIT) acts.push({ act: P.ACT.RESERVE, from: 'market', cardId: id });
    }
  }
  if (p.reserved.length < P.RESERVE_LIMIT) {
    for (const r of p.reserved) {
      if (canBuy(db.cards[r.id].cost)) acts.push({ act: P.ACT.BUY, from: 'reserved', cardId: r.id });
    }
    for (const lv of [1, 2, 3]) {
      if (state.decks[lv].length > 0) acts.push({ act: P.ACT.RESERVE, from: 'deck', level: lv });
    }
  }
  return acts;
}

module.exports = {
  createGame,
  applyAction,
  viewFor,
  enumerateActions,
  covers,
  computePayment,
  blankTokens,
  tokenCount,
  log
};
