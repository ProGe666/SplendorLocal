'use strict';
/* global PROTOCOL */
const P = PROTOCOL;
const COLORS = P.COLORS;
const CN = { white: '白', blue: '蓝', green: '绿', red: '红', black: '黑', gold: '金' };
const LEVEL_CN = { 1: '一', 2: '二', 3: '三' };

let cardDb = null;
let me = loadIdentity();
let room = null;
let view = null;
let ws = null;
let reconnectDelay = 600;
let pingTimer = null;
let pendingJoinCode = new URLSearchParams(location.search).get('room');
let sel = { gems: {}, discard: {} };

// 标记关注(本房间持久化)与行动播报
let marks = new Set();
let marksLoadedFor = null;
let lastTurnNo = 0;
let logSeen = 0;
const CARD_SOLID = { white: '#f5eeda', blue: '#2e9bef', green: '#37b96b', red: '#e0483a', black: '#3c3c46' };
const TP_EFFECTS = {
  gemOnBuy: '每次购买卡牌后,额外从供应区拿 1 颗任意非金宝石(可以是刚支付出去的那颗)。',
  extraOnDouble: '同色拿 2 颗宝石时,额外再拿 1 颗其他颜色的宝石。',
  goldTwo: '购买卡牌时,每颗金币可当作 2 颗同色宝石支付(超出部分不找零;手持上限仍按 1 颗计)。',
  peekReserve: '从牌库盲抽预留时,先看牌库顶 2 张,留 1 张,另一张放回牌库底。',
  pointsPerPost: '每持有 1 个贸易站(包括它自己)得 1 点声望,可能直接触发终局。'
};

function marksKey() {
  return 'splendor.marks.' + (room ? room.code : 'x');
}
function saveMarks() {
  try {
    localStorage.setItem(marksKey(), JSON.stringify([...marks]));
  } catch {}
}
function toggleMark(cardId) {
  if (marks.has(cardId)) marks.delete(cardId);
  else marks.add(cardId);
  saveMarks();
}

let bannerTimer = null;
let bannerQueue = [];
let bannerActive = false;
// 播报队列:逐条展示,点横幅可跳过当前这条
function banner(text, cardId, warn) {
  bannerQueue.push({ text, cardId, warn });
  if (!bannerActive) nextBanner();
}
function nextBanner() {
  const item = bannerQueue.shift();
  const b = $('banner');
  if (!item) {
    bannerActive = false;
    b.classList.add('hidden');
    return;
  }
  bannerActive = true;
  b.textContent = '';
  b.classList.toggle('warn', !!item.warn);
  if (item.cardId) b.append(cardEl(item.cardId));
  b.append(el('span', 'txt', item.text));
  b.classList.remove('hidden');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(nextBanner, item.warn ? 3200 : 2400);
}

// 每份新快照:检测标记牌离场、生成行动播报、识别新一局
function onNewSnapshot(prev, cur) {
  const roomCode = room ? room.code : null;
  if (marksLoadedFor !== roomCode) {
    marksLoadedFor = roomCode;
    try {
      marks = new Set(JSON.parse(localStorage.getItem(marksKey()) || '[]'));
    } catch {
      marks = new Set();
    }
  }
  if (cur.turnNo < lastTurnNo) {
    marks.clear();
    saveMarks();
    logSeen = 0;
  }
  lastTurnNo = cur.turnNo;

  if (prev) {
    // 日志播报:标记牌被他人拿走时,合并为醒目提示
    for (const entry of cur.log.slice(logSeen)) {
      const name = ((cur.players || [])[entry.seat] || {}).name || '';
      if (entry.kind === 'buy' || (entry.kind === 'reserve' && entry.data && entry.data.card)) {
        const cardId = entry.data.card;
        const marked = marks.has(cardId) && entry.seat !== mySeat();
        marks.delete(cardId);
        const verb = entry.kind === 'buy' ? '买下了' : '预留了';
        const label = cardLabel(cardId);
        if (marked) banner(`${name} ${entry.kind === 'buy' ? '买走' : '拿走'}了你标记的${label}!`, cardId, true);
        else banner(`${name} ${verb} ${label}`, cardId);
      } else if (entry.kind === 'noble') banner(`${name} 迎来贵族来访 +3分`);
      else if (entry.kind === 'city') banner(`${name} 达成城市要求,本轮后终局!`);
      else if (entry.kind === 'start') {
        banner(`${((cur.players || [])[entry.data.seat] || {}).name || '?'} 获得先手,游戏开始!`);
      }
    }
    saveMarks();
    // 兜底:没有对应日志的标记牌离场(理论上不会发生)
    const prevIds = new Set([1, 2, 3].flatMap((lv) => prev.market[lv]));
    const curIds = new Set([1, 2, 3].flatMap((lv) => cur.market[lv]));
    for (const id of [...marks]) {
      if (prevIds.has(id) && !curIds.has(id)) {
        marks.delete(id);
        saveMarks();
        banner('你标记的牌被拿走了', id, true);
      }
    }
  }
  logSeen = cur.log.length;
}

const $ = (id) => document.getElementById(id);

function loadIdentity() {
  try {
    const raw = localStorage.getItem('splendor.identity');
    if (raw) return JSON.parse(raw);
  } catch {}
  return { playerId: null, token: null, name: '' };
}

function saveIdentity() {
  localStorage.setItem('splendor.identity', JSON.stringify(me));
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function gem(color, size) {
  return el('span', 'gem g-' + color + (size ? ' ' + size : ''));
}

function chipRow(cost, size) {
  const row = el('span', 'cost');
  for (const [c, n] of Object.entries(cost)) {
    if (c === 'any') {
      const item = el('span', 'pay-item', '任意' + n);
      row.append(item);
      continue;
    }
    const item = el('span', 'pay-item');
    item.append(gem(c, size || 'xs'), el('span', null, String(n)));
    row.append(item);
  }
  return row;
}

let toastTimer = null;
function toast(msg, isErr) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('err', !!isErr);
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}

function showScreen(name) {
  for (const id of ['screen-lobby', 'screen-room', 'screen-game']) {
    $(id).classList.toggle('hidden', id !== 'screen-' + name);
  }
  hideOverlays();
}

function hideOverlays() {
  $('modal').classList.add('hidden');
  $('sheet').classList.add('hidden');
  $('result').classList.add('hidden');
}

// ---------------------------------------------------------------- 连接

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    $('conn-badge').classList.add('hidden');
    reconnectDelay = 600;
    startPing();
    const name = ($('input-name').value || '').trim() || me.name || undefined;
    send({ type: P.C.HELLO, name, playerId: me.playerId || undefined, token: me.token || undefined });
  };
  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    handleMsg(msg);
  };
  ws.onclose = () => {
    stopPing();
    $('conn-badge').classList.remove('hidden');
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 8000);
  };
}

function startPing() {
  stopPing();
  pingTimer = setInterval(() => send({ type: P.C.PING }), 25000);
}
function stopPing() {
  clearInterval(pingTimer);
  pingTimer = null;
}

function handleMsg(msg) {
  switch (msg.type) {
    case P.S.WELCOME:
      me.playerId = msg.playerId;
      me.token = msg.token;
      if (msg.name) me.name = msg.name;
      saveIdentity();
      if (pendingJoinCode) {
        const code = pendingJoinCode.toUpperCase();
        pendingJoinCode = null;
        send({ type: P.C.JOIN_ROOM, code });
      }
      break;
    case P.S.ROOM:
      room = msg;
      if (msg.phase === 'lobby') {
        view = null;
        renderRoom();
        showScreen('room');
      } else if (msg.phase === 'finished') {
        if (view && view.phase === 'finished') {
          showScreen('game');
          renderGame();
        } else {
          const hadGame = !!view;
          view = null;
          renderRoom();
          showScreen('room');
          if (hadGame) toast('对局已中断,返回房间', true);
        }
      } else if (view) {
        renderGame();
      }
      break;
    case P.S.GAME: {
      const prev = view;
      view = msg.state;
      onNewSnapshot(prev, view);
      if (view.phase === 'finished' && !prev) {
        // 重连回到已结束的对局:进房间页(可从那里再开或查看结算)
        showScreen('room');
        renderRoom();
        break;
      }
      showScreen('game'); // 先切屏(会清理弹窗),再渲染(结算弹窗在此时打开,不会被清掉)
      renderGame();
      break;
    }
    case P.S.ERROR:
      toast(msg.message || '操作失败', true);
      break;
    case P.S.ROOM_CLOSED:
      room = null;
      view = null;
      showScreen('lobby');
      toast(msg.reason || '房间已关闭');
      break;
    case P.S.PONG:
      break;
  }
}

// ---------------------------------------------------------------- 大厅/房间

function mySeat() {
  return room ? room.you : -1;
}

function isHost() {
  return room && room.players.some((p) => p.seat === room.you && p.isHost);
}

function renderRoom() {
  $('room-code').textContent = room.code;
  $('room-count').textContent = room.players.length;
  const ul = $('room-players');
  ul.textContent = '';
  const host = isHost();
  room.players.forEach((p) => {
    const li = el('li');
    li.append(el('span', 'seat-dot', String(p.seat + 1)));
    li.append(el('span', null, p.name + (p.seat === room.you ? '(你)' : '')));
    if (p.isHost) li.append(el('span', 'tag', '房主'));
    if (p.isBot) li.append(el('span', 'tag bot', '机器人'));
    if (!p.connected && !p.isBot) li.append(el('span', 'tag off', '离线'));
    if (host && p.isBot && room.phase === 'lobby') {
      const rm = el('button', 'btn btn-ghost btn-mini', '移除');
      rm.addEventListener('click', () => send({ type: P.C.REMOVE_BOT, seat: p.seat }));
      li.append(rm);
    }
    ul.append(li);
  });
  $('btn-add-bot').classList.toggle('hidden', !(host && room.phase === 'lobby' && room.players.length < 4));
  const resultBtn = $('btn-last-result');
  const hasFinishedGame = room.phase === 'finished' && view && view.phase === 'finished';
  resultBtn.classList.toggle('hidden', !hasFinishedGame);
  $('btn-start').disabled = !host || room.players.length < 2;
  $('btn-start').textContent =
    room.phase === 'finished' ? '再开一局' : host ? '开始游戏' : '等待房主开始…';
  $('room-opt-cities').disabled = !host;
  $('room-opt-tp').disabled = !host;
  if (document.activeElement !== $('room-opt-cities')) $('room-opt-cities').checked = room.options.cities;
  if (document.activeElement !== $('room-opt-tp')) $('room-opt-tp').checked = room.options.tradingPosts;
}

function copyText(text, okMsg) {
  const done = () => toast(okMsg);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
  } else fallbackCopy(text, done);
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.append(ta);
  ta.select();
  try {
    document.execCommand('copy');
    done();
  } catch {}
  ta.remove();
}

// ---------------------------------------------------------------- 对局渲染

function me2() {
  return view && view.players[mySeat()];
}

function holdsEffect(effect) {
  const p = me2();
  if (!p || !view.config.expansions.tradingPosts) return false;
  return p.shields.some((id) => cardDb.tradingPosts[id].effect === effect);
}

function payPreview(cost, player, goldTwo) {
  const pays = {};
  let gold = 0;
  for (const c of COLORS) {
    const eff = Math.max(0, (cost[c] || 0) - (player.bonus[c] || 0));
    if (!eff) continue;
    const pay = Math.min(player.tokens[c] || 0, eff);
    if (pay) pays[c] = pay;
    const deficit = eff - pay;
    if (deficit > 0) gold += goldTwo ? Math.ceil(deficit / 2) : deficit;
  }
  return { pays, gold, affordable: gold <= (player.tokens.gold || 0) };
}

function cardEl(cardId, opts = {}) {
  const card = cardDb.cards[cardId];
  const div = el(
    'div',
    `card c-${card.color}` +
      (opts.big ? ' big' : '') +
      (opts.mini ? ' mini' : '') +
      (opts.hand ? ' hand' : '') +
      (opts.mine ? ' mine-reserved' : '') +
      (opts.marked || marks.has(cardId) ? ' marked' : '')
  );
  div.append(el('span', 'pts' + (card.points ? '' : ' zero'), String(card.points)));
  const cost = el('div', 'cost');
  for (const [c, n] of Object.entries(card.cost)) {
    if (c === 'any') {
      cost.append(el('span', 'cost-item any', `任意${n}张`));
      continue;
    }
    const item = el('span', 'cost-item');
    item.append(gem(c));
    item.append(el('span', 'n', String(n)));
    cost.append(item);
  }
  div.append(cost);
  const bar = el('span', 'card-color-bar');
  bar.style.background = CARD_SOLID[card.color];
  div.append(bar);
  return div;
}

function cardLabel(cardId) {
  const c = cardDb.cards[cardId];
  return `${LEVEL_CN[c.level]}级${CN[c.color]}卡${c.points ? '·' + c.points + '分' : ''}`;
}

function logText(entry) {
  const name = (view.players[entry.seat] || {}).name || '?';
  const d = entry.data || {};
  switch (entry.kind) {
    case 'start':
      return `${(view.players[d.seat] || {}).name || '?'} 获得先手,游戏开始`;
    case 'take':
      return `${name} 拿了 ${Object.entries(d.picks).map(([c, n]) => CN[c] + '×' + n).join(' ')}`;
    case 'takeBonus':
      return `${name} 获得附赠 ${CN[d.color]}宝石`;
    case 'buy':
      return `${name} 买下${cardLabel(d.card)}${d.gold ? '(用金×' + d.gold + ')' : ''}`;
    case 'reserve':
      return d.from === 'deck' ? `${name} 盲抽预留了一张${LEVEL_CN[d.level]}级卡` : `${name} 预留了${cardLabel(d.card)}`;
    case 'discard':
      return `${name} 弃置了 ${d.count} 个宝石`;
    case 'noble':
      return `${name} 迎来贵族来访 +3分`;
    case 'tp':
      return `${name} 获得贸易站「${cardDb.tradingPosts[d.tp].name}」`;
    case 'city':
      return `${name} 达成了城市要求,本轮结束后终局!`;
    case 'skip':
      return `${name} 无合法行动,跳过`;
    case 'end':
      return '对局结束';
    default:
      return '';
  }
}

function renderGame() {
  const myTurn = view.current === mySeat();
  const cur = view.players[view.current];

  // 顶栏
  const topbar = $('topbar');
  topbar.textContent = '';
  const row = el('div', 'topbar-row');
  let finishedTitle = '对局结束';
  if (view.phase === 'finished' && view.result) {
    const names = view.result.winners.map((s) => view.players[s].name).join('、');
    finishedTitle = `对局结束 · ${names} 获胜!`;
  }
  const title = el(
    'div',
    'topbar-title' + (myTurn && view.phase !== 'finished' ? ' my-turn' : ''),
    view.phase === 'finished' ? finishedTitle : myTurn ? '轮到你了' : `等待 ${cur.name} 行动…`
  );
  let mode = view.config.expansions.cities ? '城市模式' : '经典15分制';
  if (view.config.expansions.tradingPosts) mode += ' · 贸易站';
  const sub = el('div', 'topbar-sub', `第 ${view.round} 轮 · ${mode}`);
  const browse = el('button', 'btn btn-ghost btn-mini', '查看明牌');
  browse.addEventListener('click', openBrowser);
  const menu = el('button', 'btn btn-ghost btn-mini', '⋯');
  menu.addEventListener('click', openGameMenu);
  row.append(title, sub, browse, menu);
  topbar.append(row);
  if (view.log.length) {
    topbar.append(el('div', 'log-line', logText(view.log[view.log.length - 1])));
  }

  renderOpponents();
  renderGoals();
  renderSupply();
  renderMarket();
  renderSelf();
  renderActionbar();

  if (view.phase === 'finished') renderResult();
  else renderPendingSheet();

  // 看牌浏览器保持打开时,随快照刷新列表(保留滚动位置)
  if (!$('browser').classList.contains('hidden')) openBrowser();
}

function renderOpponents() {
  const box = $('opponents');
  box.textContent = '';
  for (const p of view.players) {
    if (p.seat === mySeat()) continue;
    const card = el('div', 'opp' + (p.seat === view.current && view.phase !== 'finished' ? ' turn' : ''));

    const row1 = el('div', 'opp-row1');
    row1.append(el('span', 'opp-name', p.name));
    row1.append(el('span', 'opp-points', String(p.points)));
    const rp = room.players.find((x) => x.seat === p.seat);
    if (rp && rp.isBot) row1.append(el('span', 'tag bot', '机器人'));
    else if (rp && !rp.connected) row1.append(el('span', 'opp-offline', '离线'));
    if (p.nobles.length) row1.append(el('span', 'tag', `贵族${p.nobles.length}`));
    if (p.shields.length) row1.append(el('span', 'tag', `特权${p.shields.length}`));
    card.append(row1);

    const lineB = el('div', 'opp-line');
    lineB.append(el('span', 'opp-label', '折扣'));
    let anyBonus = false;
    for (const c of COLORS) {
      if (p.bonus[c]) {
        anyBonus = true;
        const pip = el('span', 'pip');
        const g = gem(c);
        g.append(el('span', 'gem-num sm', String(p.bonus[c])));
        pip.append(g);
        lineB.append(pip);
      }
    }
    if (!anyBonus) lineB.append(el('span', 'opp-none', '—'));
    card.append(lineB);

    const lineT = el('div', 'opp-line');
    lineT.append(el('span', 'opp-label', '手持'));
    let anyToken = false;
    for (const c of [...COLORS, 'gold']) {
      if (p.tokens[c] > 0) {
        anyToken = true;
        const pip = el('span', 'pip');
        const g = gem(c);
        g.append(el('span', 'gem-num sm', String(p.tokens[c])));
        pip.append(g);
        lineT.append(pip);
      }
    }
    if (!anyToken) lineT.append(el('span', 'opp-none', '无'));
    lineT.append(el('span', 'opp-reserved', `预留${p.reserved.length}`));
    card.append(lineT);

    box.append(card);
  }
}

function renderGoals() {
  const box = $('goals');
  box.textContent = '';
  if (view.config.expansions.cities) {
    for (const ct of view.cities) {
      const city = cardDb.cities[ct.id];
      const t = el('div', 'city');
      t.append(el('span', 'pts', String(city.points)));
      t.append(el('span', 'cname', city.name));
      t.append(chipRow(city.req, 'xs'));
      t.addEventListener('click', () => openGoalModal('city', ct.id));
      box.append(t);
    }
  } else {
    for (const nb of view.nobles) {
      const noble = cardDb.nobles[nb.id];
      const t = el('div', 'noble');
      t.append(el('span', 'pts', '3'));
      t.append(chipRow(noble.req, 'xs'));
      if (nb.claimedBy !== null && nb.claimedBy !== undefined) {
        t.append(el('span', 'tag', (view.players[nb.claimedBy] || {}).name || '?'));
      }
      t.addEventListener('click', () => openGoalModal('noble', nb.id));
      box.append(t);
    }
  }
  if (view.config.expansions.tradingPosts) {
    for (const tp of view.tradingPosts) {
      const def = cardDb.tradingPosts[tp.id];
      const t = el('div', 'tp');
      const owners = view.players.filter((p) => p.shields.includes(tp.id));
      if (owners.length) t.classList.add('done');
      t.append(el('span', null, def.name));
      t.append(chipRow(def.req, 'xs'));
      const ow = el('span', 'tp-owners');
      for (const o of owners) ow.append(el('span', 'tag', o.name.slice(0, 3)));
      t.append(ow);
      t.addEventListener('click', () => openGoalModal('tp', tp.id));
      box.append(t);
    }
  }
}

// 目标详情弹窗:贸易站 / 贵族 / 城市
function openGoalModal(kind, id) {
  const box = $('modal-box');
  box.textContent = '';
  if (kind === 'tp') {
    const def = cardDb.tradingPosts[id];
    box.append(el('div', 'modal-title', `贸易站 · ${def.name}`));
    box.append(el('div', 'modal-sub', '解锁条件(回合结束自动检查,免费获得,每回合限 1 个)'));
    const pay = el('div', 'pay-row');
    pay.append(chipRow(def.req, 'sm'));
    box.append(pay);
    box.append(el('div', 'goal-effect', TP_EFFECTS[def.effect] || ''));
    const holders = view.players.filter((p) => p.shields.includes(id));
    box.append(
      el('div', 'modal-sub', holders.length ? `当前持有:${holders.map((p) => p.name).join('、')}` : '尚无人获得(多人可同时持有)')
    );
  } else if (kind === 'noble') {
    const def = cardDb.nobles[id];
    box.append(el('div', 'modal-title', '贵族'));
    box.append(el('div', 'modal-sub', '回合结束时,若你已购卡的颜色满足要求,贵族自动来访 +3 分'));
    const pay = el('div', 'pay-row');
    pay.append(chipRow(def.req, 'sm'));
    box.append(pay);
    box.append(el('div', 'goal-effect', '无需支付任何费用;同一回合同时满足多位贵族时,只能选择一位来访。'));
    const nb = view.nobles.find((x) => x.id === id);
    if (nb && nb.claimedBy !== null && nb.claimedBy !== undefined) {
      box.append(el('div', 'modal-sub', `已被 ${(view.players[nb.claimedBy] || {}).name || '?'} 迎接`));
    }
  } else {
    const def = cardDb.cities[id];
    box.append(el('div', 'modal-title', `城市 · ${def.name}`));
    box.append(el('div', 'modal-sub', `达成条件(回合结束自动检查):声望 ≥ ${def.points} 分,且卡色满足要求`));
    const pay = el('div', 'pay-row');
    pay.append(chipRow(def.req, 'sm'));
    box.append(pay);
    box.append(
      el('div', 'goal-effect', '城市模式取代 15 分终局:有人达成城市要求后,本轮结束即终局;同轮多人达成则比声望分,再比卡数。')
    );
  }
  const close = el('button', 'btn btn-ghost btn-big', '关闭');
  close.addEventListener('click', () => $('modal').classList.add('hidden'));
  box.append(close);
  $('modal').classList.remove('hidden');
}

function availableColors() {
  return COLORS.filter((c) => view.supply[c] > 0);
}

function myActionPhase() {
  return view.phase === 'action' && view.current === mySeat();
}

function renderSupply() {
  const box = $('supply');
  box.textContent = '';
  const pickable = myActionPhase();
  for (const c of [...COLORS, 'gold']) {
    const wrap = el('div', 'supply-gem' + (pickable && c !== 'gold' ? ' pickable' : ''));
    if (view.supply[c] === 0) wrap.classList.add('zero');
    if (sel.gems[c]) wrap.classList.add('selected');
    const g = gem(c, 'lg');
    g.append(el('span', 'gem-num', String(view.supply[c])));
    if (pickable && c !== 'gold') {
      g.addEventListener('click', () => toggleGem(c));
      g.style.cursor = 'pointer';
    }
    wrap.append(g);
    if (sel.gems[c]) wrap.append(el('span', 'sel-mark', '×' + sel.gems[c]));
    box.append(wrap);
  }
}

function toggleGem(c) {
  const cur = sel.gems[c] || 0;
  const keys = Object.keys(sel.gems);
  if (cur === 1) {
    if (keys.length === 1 && view.supply[c] >= 4) sel.gems[c] = 2;
    else delete sel.gems[c];
  } else if (cur === 2) {
    delete sel.gems[c];
  } else {
    if (keys.length >= 3) {
      delete sel.gems[keys[0]];
    }
    sel.gems[c] = 1;
  }
  renderSupply();
  renderActionbar();
}

function selSummary() {
  return Object.entries(sel.gems).map(([c, n]) => CN[c] + '×' + n).join(' ');
}

function confirmTakeGems() {
  const keys = Object.keys(sel.gems);
  if (!keys.length) return;
  const isDouble = keys.length === 1 && sel.gems[keys[0]] === 2;
  const action = { act: P.ACT.TAKE_GEMS, picks: { ...sel.gems } };
  if (isDouble && holdsEffect('extraOnDouble')) {
    const opts = COLORS.filter((x) => x !== keys[0] && view.supply[x] > 0);
    if (opts.length > 0) {
      chooseBonusGemSheet(opts, (color) => {
        send({ type: P.C.ACTION, action: { ...action, bonusColor: color } });
        resetSel();
      });
      return;
    }
  }
  send({ type: P.C.ACTION, action });
  resetSel();
}

function resetSel() {
  sel.gems = {};
  sel.discard = {};
  renderSupply();
  renderSelf();
}

function renderMarket() {
  const box = $('market');
  box.textContent = '';
  for (const lv of [3, 2, 1]) {
    const row = el('div', 'mkt-row');
    const deck = el('div', 'deck' + (view.decks[lv] === 0 ? ' empty' : ''));
    deck.append(el('span', 'lv', String(lv)));
    deck.append(el('span', null, `剩${view.decks[lv]}`));
    if (myActionPhase()) {
      deck.addEventListener('click', () => {
        if (me2().reserved.length >= P.RESERVE_LIMIT) {
          toast('预留已满 3 张', true);
          return;
        }
        if (view.decks[lv] === 0) return;
        send({ type: P.C.ACTION, action: { act: P.ACT.RESERVE, from: 'deck', level: lv } });
      });
    }
    row.append(deck);
    for (const cardId of view.market[lv]) {
      const me_ = me2();
      const pay = payPreview(cardDb.cards[cardId].cost, me_, holdsEffect('goldTwo'));
      const c = cardEl(cardId);
      if (myActionPhase() && pay.affordable) c.classList.add('can-buy');
      c.addEventListener('click', () => openCardModal(cardId, 'market'));
      row.append(c);
    }
    while (row.children.length < 5) row.append(el('div'));
    box.append(row);
  }
}

function renderSelf() {
  const box = $('self');
  box.textContent = '';
  const p = me2();
  if (!p) return;
  const panel = el('div', 'self-panel');

  // 头部:我 + 分数 + 折扣 + 手持 + 特权
  const head = el('div', 'self-head');
  const nameRow = el('div', 'self-name-row');
  nameRow.append(el('span', 'self-name', '我'));
  const scoreBits = [];
  if (p.score.cards) scoreBits.push('卡' + p.score.cards);
  if (p.score.nobles) scoreBits.push('贵族' + p.score.nobles);
  if (p.score.tradingPosts) scoreBits.push('特权' + p.score.tradingPosts);
  const pts = el('span', 'self-points', String(p.points));
  if (scoreBits.length) pts.title = scoreBits.join(' + ');
  nameRow.append(pts);
  head.append(nameRow);

  const bonus = el('span', 'self-bonus');
  bonus.append(el('span', 'opp-label', '折扣'));
  for (const c of COLORS) {
    if (p.bonus[c]) {
      const pip = el('span', 'pip');
      const g = gem(c);
      g.append(el('span', 'gem-num sm', String(p.bonus[c])));
      pip.append(g);
      bonus.append(pip);
    }
  }
  head.append(bonus);

  const tokens = el('div', 'self-tokens');
  tokens.append(el('span', 'opp-label', '手持'));
  const discardMode = view.phase === 'discard' && view.current === mySeat();
  for (const c of [...COLORS, 'gold']) {
    const n = p.tokens[c];
    if (!n) continue;
    const wrap = el('div', 'my-token' + (discardMode ? ' pickable' : '') + (sel.discard[c] ? ' selected' : ''));
    const g = gem(c);
    g.append(el('span', 'gem-num sm', String(n - (sel.discard[c] || 0))));
    if (discardMode) {
      g.addEventListener('click', () => {
        const next = (sel.discard[c] || 0) + 1;
        sel.discard[c] = next > p.tokens[c] ? 0 : next; // 循环选择,可撤销
        renderSelf();
        renderPendingSheet();
      });
      g.style.cursor = 'pointer';
    }
    wrap.append(g);
    tokens.append(wrap);
  }
  head.append(tokens);

  if (p.shields.length) {
    const shields = el('div', 'shield-row');
    for (const id of p.shields) {
      shields.append(el('span', 'shield-chip', cardDb.tradingPosts[id].name));
    }
    head.append(shields);
  }
  panel.append(head);
  box.append(panel);

  // 预留牌展示区(独立一排):已购卡以"五色+数量"汇总在上方折扣徽章中
  const handBox = $('self-hand');
  handBox.textContent = '';
  if (p.reserved.length > 0) {
    handBox.append(el('span', 'opp-label hand-label', '预留'));
    for (const r of p.reserved) {
      if (r.hidden) continue;
      const pay = payPreview(cardDb.cards[r.id].cost, p, holdsEffect('goldTwo'));
      const c = cardEl(r.id, { hand: true, mine: true });
      if (myActionPhase() && pay.affordable) c.classList.add('can-buy');
      if (view.phase === 'finished') c.style.pointerEvents = 'none';
      else c.addEventListener('click', () => openCardModal(r.id, 'reserved'));
      handBox.append(c);
    }
  }
}

// ---------------------------------------------------------------- 卡片详情弹窗

function openCardModal(cardId, from) {
  const card = cardDb.cards[cardId];
  const p = me2();
  const goldTwo = holdsEffect('goldTwo');
  const pay = payPreview(card.cost, p, goldTwo);
  const box = $('modal-box');
  box.textContent = '';

  box.append(el('div', 'modal-title', `${LEVEL_CN[card.level]}级发展卡`));
  const wrap = el('div', 'modal-card-wrap');
  wrap.append(cardEl(cardId, { big: true }));
  box.append(wrap);

  const colorRow = el('div', 'modal-sub color-row');
  colorRow.append(gem(card.color, 'sm'));
  colorRow.append(el('span', null, `${CN[card.color]}色卡 · 买下后你每次支付${CN[card.color]}色成本 -1`));
  box.append(colorRow);

  const payRow = el('div', 'pay-row');
  const effAll = {};
  for (const c of COLORS) {
    const eff = Math.max(0, (card.cost[c] || 0) - p.bonus[c]);
    if (eff > 0) effAll[c] = eff;
  }
  if (Object.keys(effAll).length === 0) {
    payRow.append(el('span', 'pay-item', '折扣已覆盖,免费获得!'));
  } else {
    for (const [c, n] of Object.entries(effAll)) {
      const item = el('span', 'pay-item');
      item.append(gem(c, 'sm'), el('span', null, String(n)));
      payRow.append(item);
    }
    if (pay.gold > 0) {
      const g = el('span', 'pay-item gold-pay');
      g.append(gem('gold', 'sm'), el('span', null, `金×${pay.gold}${goldTwo ? '(每枚当2)' : ''}`));
      payRow.append(g);
    }
  }
  box.append(payRow);

  const canAct = myActionPhase();
  const btnRow = el('div', 'stack');
  if (canAct) {
    const buy = el('button', 'btn btn-primary', '购买');
    buy.disabled = !pay.affordable;
    buy.addEventListener('click', () => {
      send({ type: P.C.ACTION, action: { act: P.ACT.BUY, from, cardId } });
      $('modal').classList.add('hidden');
    });
    btnRow.append(buy);
    if (from === 'market') {
      const res = el('button', 'btn btn-ghost', '预留(+1金)');
      res.disabled = p.reserved.length >= P.RESERVE_LIMIT;
      res.addEventListener('click', () => {
        send({ type: P.C.ACTION, action: { act: P.ACT.RESERVE, from: 'market', cardId } });
        $('modal').classList.add('hidden');
      });
      btnRow.append(res);
    }
  }
  if (from === 'market') {
    const mk = el('button', 'btn btn-ghost', marks.has(cardId) ? '★ 取消标记' : '☆ 标记关注');
    mk.addEventListener('click', () => {
      toggleMark(cardId);
      mk.textContent = marks.has(cardId) ? '★ 取消标记' : '☆ 标记关注';
      renderMarket();
    });
    btnRow.append(mk);
  }
  const close = el('button', 'btn btn-ghost', '关闭');
  close.addEventListener('click', () => $('modal').classList.add('hidden'));
  btnRow.append(close);
  box.append(btnRow);

  $('modal').classList.remove('hidden');
}

// ---------------------------------------------------------------- 操作条

function renderActionbar() {
  const bar = $('actionbar');
  bar.textContent = '';
  if (view.phase === 'finished') {
    if (isHost()) {
      const again = el('button', 'btn btn-primary', '再来一局');
      again.addEventListener('click', () => send({ type: P.C.START_GAME }));
      const back = el('button', 'btn btn-ghost', '回房间');
      back.addEventListener('click', () => {
        renderRoom();
        showScreen('room');
      });
      bar.append(again, back);
    } else {
      bar.append(el('span', 'actionbar-hint', '对局结束,等待房主再开一局'));
    }
    return;
  }
  if (view.phase !== 'action') {
    const phaseNames = {
      discard: '弃置多余宝石',
      noble: '选择来访贵族',
      tradingPost: '选择贸易站特权',
      peek: '盲抽二选一',
      bonusGem: '选择奖励宝石'
    };
    if (view.current !== mySeat()) {
      bar.append(el('span', 'actionbar-hint', `等待 ${view.players[view.current].name} ${phaseNames[view.phase] || '处理选择'}…`));
      return;
    }
    bar.append(el('span', 'actionbar-hint', `请在弹窗中${phaseNames[view.phase] || '完成选择'}`));
    const reopen = el('button', 'btn btn-ghost', '重新打开选择');
    reopen.addEventListener('click', () => {
      $('sheet').classList.add('hidden');
      renderPendingSheet();
      if ($('sheet').classList.contains('hidden')) toast('弹窗暂时不可用,请稍候或刷新页面', true);
    });
    bar.append(reopen);
    return;
  }
  if (view.current !== mySeat()) {
    bar.append(el('span', 'actionbar-hint', `等待 ${view.players[view.current].name} 行动…`));
    return;
  }
  const keys = Object.keys(sel.gems);
  if (keys.length) {
    const ok = el('button', 'btn btn-primary', `拿 ${selSummary()}`);
    ok.addEventListener('click', confirmTakeGems);
    const cancel = el('button', 'btn btn-ghost', '取消');
    cancel.addEventListener('click', () => {
      resetSel();
      renderActionbar();
    });
    bar.append(ok, cancel);
  } else {
    bar.append(el('span', 'actionbar-hint', '点选宝石拿取 / 点卡查看购买与预留'));
  }
}

// ---------------------------------------------------------------- 对局菜单

function openGameMenu() {
  openSheet((box) => {
    box.append(el('div', 'modal-title', '对局菜单'));
    const playing = room && room.phase === 'playing';

    if (isHost() && playing) {
      const abandon = el('button', 'btn btn-primary btn-big', '作废本局,回房间重开');
      abandon.addEventListener('click', () => {
        send({ type: P.C.ABANDON_GAME });
        $('sheet').classList.add('hidden');
      });
      box.append(abandon);
      box.append(el('div', 'modal-sub', '玩家与机器人保留,回房间后可换模块重新开局'));
    }

    if (playing) {
      const leave = el('button', 'btn btn-ghost btn-big', '暂时离开(保留座位)');
      leave.addEventListener('click', () => {
        send({ type: P.C.LEAVE_ROOM });
        $('sheet').classList.add('hidden');
        room = null;
        view = null;
        showScreen('lobby');
        toast('已离线,重新打开邀请链接即可回到本局');
      });
      box.append(leave);
      box.append(el('div', 'modal-sub', '离开后本局保留,重新打开邀请链接(或刷新后自动)即可继续'));
    }

    if (isHost()) {
      const closeBtn = el('button', 'btn btn-danger btn-big', '解散房间(所有人回大厅)');
      closeBtn.addEventListener('click', () => {
        send({ type: P.C.CLOSE_ROOM });
        $('sheet').classList.add('hidden');
      });
      box.append(closeBtn);
      box.append(el('div', 'modal-sub', '房间与对局全部结束,房码作废'));
    }
  });
}

// ---------------------------------------------------------------- 全屏看牌

function openBrowser() {
  if (!view) return;
  const box = $('browser-box');
  const keepScroll = box.scrollTop;
  box.textContent = '';
  const head = el('div', 'browser-head');
  head.append(el('div', 'modal-title', '场上明牌一览'));
  const decks = el('div', 'browser-decks');
  for (const lv of [1, 2, 3]) decks.append(el('span', null, `${LEVEL_CN[lv]}级牌库剩 ${view.decks[lv]}`));
  head.append(decks);
  const close = el('button', 'btn btn-ghost btn-mini', '关闭');
  close.addEventListener('click', () => {
    $('browser').classList.add('hidden');
    renderPendingSheet(); // 关闭明牌后,若有待选择弹窗则自动恢复
  });
  head.append(close);
  box.append(head);
  box.append(
    el(
      'div',
      'modal-sub',
      '翻看场上所有明牌。轮到你时,点卡片可以直接购买或预留;平时也能随时打开研究。'
    )
  );
  const grid = el('div', 'browser-grid');
  const me_ = me2();
  for (const lv of [3, 2, 1]) {
    for (const cardId of view.market[lv]) {
      const c = cardEl(cardId);
      if (me_ && myActionPhase()) {
        const pay = payPreview(cardDb.cards[cardId].cost, me_, holdsEffect('goldTwo'));
        if (pay.affordable) c.classList.add('can-buy');
      }
      c.addEventListener('click', () => openCardModal(cardId, 'market'));
      grid.append(c);
    }
  }
  box.append(grid);
  box.scrollTop = keepScroll || 0;
  $('browser').classList.remove('hidden');
}

// ---------------------------------------------------------------- 底部抽屉

function openSheet(builder, opts = {}) {
  const box = $('sheet-box');
  box.textContent = '';
  builder(box);
  if (!opts.noClose) {
    const x = el('button', 'sheet-close', '×');
    x.title = '暂时收起,可从底部操作条重新打开';
    x.addEventListener('click', () => $('sheet').classList.add('hidden'));
    box.append(x);
  }
  $('sheet').classList.remove('hidden');
}

function chooseBonusGemSheet(colors, onPick) {
  openSheet((box) => {
    box.append(el('div', 'modal-title', '选择附赠的宝石'));
    box.append(el('div', 'modal-sub', '贸易站特权:同色拿2后可额外拿1颗其他颜色'));
    const grid = el('div', 'choice-grid');
    for (const c of colors) {
      const item = el('div', 'choice-item');
      item.append(gem(c, 'lg'));
      item.append(el('span', null, CN[c]));
      item.addEventListener('click', () => {
        $('sheet').classList.add('hidden');
        onPick(c);
      });
      grid.append(item);
    }
    box.append(grid);
  });
}

function renderPendingSheet() {
  const p = me2();
  if (view.phase === 'finished' || !p || view.current !== mySeat()) {
    $('sheet').classList.add('hidden');
    return;
  }
  if (view.phase === 'discard') {
    const need = view.pending.discardCount;
    const got = Object.values(sel.discard).reduce((a, b) => a + b, 0);
    openSheet((box) => {
      box.append(el('div', 'modal-title', `弃置 ${need} 个宝石`));
      box.append(el('div', 'modal-sub', '宝石超过 10 个,点击下方自己的宝石选择弃置'));
      const ok = el('button', 'btn btn-primary btn-big', `弃置 ${got}/${need}`);
      ok.disabled = got !== need;
      ok.addEventListener('click', () => {
        send({ type: P.C.ACTION, action: { act: P.ACT.DISCARD, tokens: { ...sel.discard } } });
        sel.discard = {};
      });
      box.append(ok);
    });
  } else if (view.phase === 'noble') {
    openSheet((box) => {
      box.append(el('div', 'modal-title', '选择一位来访的贵族'));
      const grid = el('div', 'choice-grid');
      for (const id of view.pending.nobleChoices) {
        const item = el('div', 'choice-item');
        item.append(el('span', 'pts', '3分'));
        item.append(chipRow(cardDb.nobles[id].req, 'xs'));
        item.addEventListener('click', () => {
          send({ type: P.C.ACTION, action: { act: P.ACT.CHOOSE_NOBLE, nobleId: id } });
        });
        grid.append(item);
      }
      box.append(grid);
    });
  } else if (view.phase === 'tradingPost') {
    openSheet((box) => {
      box.append(el('div', 'modal-title', '选择一个贸易站特权'));
      box.append(el('div', 'modal-sub', '每回合只能获得一个'));
      const grid = el('div', 'choice-grid');
      for (const id of view.pending.tpChoices) {
        const def = cardDb.tradingPosts[id];
        const item = el('div', 'choice-item');
        item.append(el('span', null, def.name));
        item.append(chipRow(def.req, 'xs'));
        item.addEventListener('click', () => {
          send({ type: P.C.ACTION, action: { act: P.ACT.CHOOSE_TP, tpId: id } });
        });
        grid.append(item);
      }
      box.append(grid);
    });
  } else if (view.phase === 'peek') {
    const peek = view.pending.peek;
    openSheet((box) => {
      box.append(el('div', 'modal-title', '盲抽预览:保留一张'));
      box.append(el('div', 'modal-sub', `先知商会:从${LEVEL_CN[peek.level]}级牌库抽两张,留一张,另一张放回牌库底`));
      const grid = el('div', 'choice-grid');
      grid.style.gridTemplateColumns = '1fr 1fr';
      peek.cards.forEach((cardId, idx) => {
        const item = el('div', 'choice-item');
        const c = cardEl(cardId);
        c.style.pointerEvents = 'none';
        item.append(c);
        item.addEventListener('click', () => {
          send({ type: P.C.ACTION, action: { act: P.ACT.CHOOSE_PEEK, keepIndex: idx } });
        });
        grid.append(item);
      });
      box.append(grid);
    });
  } else if (view.phase === 'bonusGem') {
    openSheet((box) => {
      box.append(el('div', 'modal-title', '买牌奖励:拿 1 颗宝石'));
      box.append(el('div', 'modal-sub', '宝石商会特权:购买卡后额外拿 1 颗非金宝石(数字为当前剩余)'));
      const grid = el('div', 'choice-grid');
      for (const c of availableColors()) {
        const item = el('div', 'choice-item');
        const g = gem(c, 'lg');
        g.append(el('span', 'gem-num', String(view.supply[c])));
        item.append(g);
        item.append(el('span', null, CN[c]));
        item.addEventListener('click', () => {
          send({ type: P.C.ACTION, action: { act: P.ACT.BONUS_GEM, color: c } });
        });
        grid.append(item);
      }
      box.append(grid);
      const peekBtn = el('button', 'btn btn-ghost', '先看看场上明牌');
      peekBtn.addEventListener('click', () => {
        $('sheet').classList.add('hidden');
        openBrowser();
      });
      box.append(peekBtn);
    }, { noClose: true });
  } else {
    $('sheet').classList.add('hidden');
  }
}

// ---------------------------------------------------------------- 结算

function renderResult() {
  const box = $('result-box');
  box.textContent = '';
  const r = view.result;
  const closeX = el('button', 'btn btn-ghost btn-mini result-close', '× 关闭');
  closeX.addEventListener('click', () => $('result').classList.add('hidden'));
  box.append(closeX);
  box.append(el('div', 'modal-title', r.winners.length > 1 ? '共享胜利!' : `${view.players[r.winners[0]].name} 获胜!`));
  box.append(el('div', 'modal-sub', r.reason === 'city' ? '城市模式:率先达成城市要求' : '经典模式:声望分最高'));

  const rank = el('div', 'result-rank');
  r.ranking.forEach((item, i) => {
    const p = view.players[item.seat];
    const li = el('div', 'rank-item' + (r.winners.includes(item.seat) ? ' winner' : ''));
    li.append(el('span', 'rank-pos', String(i + 1)));
    li.append(el('span', 'rank-name', p.name + (item.seat === mySeat() ? '(你)' : '')));
    const detail = el('span', 'rank-detail');
    detail.append(el('div', 'rank-pts', String(item.points) + '分'));
    const bits = [`卡${item.cards}张`];
    if (p.score.nobles) bits.push(`贵族${p.nobles.length}`);
    if (p.score.tradingPosts) bits.push(`特权${p.shields.length}`);
    if (item.qualified) bits.push('达成城市');
    detail.append(el('div', null, bits.join(' · ')));
    li.append(detail);
    rank.append(li);
  });
  box.append(rank);

  const btns = el('div', 'stack');
  if (isHost()) {
    const again = el('button', 'btn btn-primary btn-big', '再来一局');
    again.addEventListener('click', () => {
      send({ type: P.C.START_GAME });
      $('result').classList.add('hidden');
    });
    btns.append(again);
    const back = el('button', 'btn btn-ghost', '回房间调整模块');
    back.addEventListener('click', () => {
      $('result').classList.add('hidden');
      renderRoom();
      showScreen('room');
    });
    btns.append(back);
    btns.append(el('div', 'modal-sub', '再来一局沿用当前玩家与机器人;想换模块先回房间'));
  } else {
    btns.append(el('div', 'modal-sub', '等待房主再开一局'));
    const back = el('button', 'btn btn-ghost btn-big', '回房间');
    back.addEventListener('click', () => {
      $('result').classList.add('hidden');
      renderRoom();
      showScreen('room');
    });
    btns.append(back);
  }
  box.append(btns);
  $('result').classList.remove('hidden');
}

// ---------------------------------------------------------------- 初始化

function init() {
  if (me.name) $('input-name').value = me.name;
  const savedCode = new URLSearchParams(location.search).get('room');
  if (savedCode) $('input-code').value = savedCode.toUpperCase();
  history.replaceState(null, '', '/');

  $('input-code').addEventListener('input', (e) => {
    e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
  });

  $('btn-create').addEventListener('click', () => {
    const name = $('input-name').value.trim();
    if (!name) return toast('请先输入昵称', true);
    me.name = name;
    saveIdentity();
    send({ type: P.C.HELLO, name, playerId: me.playerId, token: me.token });
    send({
      type: P.C.CREATE_ROOM,
      options: { cities: $('opt-cities').checked, tradingPosts: $('opt-tp').checked }
    });
  });

  $('btn-join').addEventListener('click', () => {
    const code = $('input-code').value.trim();
    if (code.length !== 4) return toast('请输入 4 位房码', true);
    const name = $('input-name').value.trim();
    if (name && name !== me.name) {
      me.name = name;
      saveIdentity();
      send({ type: P.C.HELLO, name, playerId: me.playerId, token: me.token });
    } else if (!name && !me.name) {
      return toast('请先输入昵称', true);
    }
    send({ type: P.C.JOIN_ROOM, code });
  });

  $('input-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('btn-join').click();
  });

  $('btn-copy-link').addEventListener('click', () => {
    copyText(`${location.origin}/?room=${room.code}`, '邀请链接已复制,发给朋友吧');
  });
  $('btn-copy-code').addEventListener('click', () => {
    copyText(room.code, '房码已复制');
  });

  $('btn-start').addEventListener('click', () => send({ type: P.C.START_GAME }));
  $('btn-last-result').addEventListener('click', () => {
    showScreen('game');
    renderGame();
  });
  $('btn-add-bot').addEventListener('click', () => send({ type: P.C.ADD_BOT }));
  $('btn-leave').addEventListener('click', () => {
    send({ type: P.C.LEAVE_ROOM });
    room = null;
    view = null;
    showScreen('lobby');
  });

  const optChange = () => {
    if (!isHost()) return;
    send({
      type: P.C.UPDATE_OPTIONS,
      options: { cities: $('room-opt-cities').checked, tradingPosts: $('room-opt-tp').checked }
    });
  };
  $('room-opt-cities').addEventListener('change', optChange);
  $('room-opt-tp').addEventListener('change', optChange);

  $('modal').addEventListener('click', (e) => {
    if (e.target === $('modal')) $('modal').classList.add('hidden');
  });
  $('browser').addEventListener('click', (e) => {
    if (e.target === $('browser')) {
      $('browser').classList.add('hidden');
      renderPendingSheet();
    }
  });

  fetch('/data/cards.json')
    .then((r) => r.json())
    .then((db) => {
      cardDb = db;
      connect();
    })
    .catch(() => toast('加载卡牌数据失败,请刷新', true));
}

init();
