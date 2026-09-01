'use strict';

// 测试共享:种子 RNG + WS 测试客户端(带可撤销等待器)+ 视角驱动行动枚举

const P = require('../public/protocol');
const cardDb = require('../data/cards.json');
const COLORS = P.COLORS;

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Bot {
  constructor(url, name) {
    this.name = name;
    this.view = null;
    this.room = null;
    this.gameCount = 0;
    this.queue = [];
    this.waiters = [];
    this.ws = new (require('ws'))(url);
    this.ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === P.S.GAME) {
        this.view = msg.state;
        this.gameCount++;
      }
      if (msg.type === P.S.ROOM) this.room = msg;
      const w = this.waiters.find((x) => x.pred(msg));
      if (w) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(msg);
      } else if (msg.type !== P.S.GAME && msg.type !== P.S.ROOM && msg.type !== P.S.PONG) {
        this.queue.push(msg);
      }
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        const x = this.waiters[i];
        if (x.pred(null)) {
          this.waiters.splice(i, 1);
          x.resolve({ ok: true });
        }
      }
    });
  }

  opened() {
    return new Promise((r) => this.ws.on('open', r));
  }

  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }

  waitUntil(pred, timeout = 5000) {
    const hit = pred(null);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${this.name} 等待超时`)), timeout);
      this.waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  }

  addTempWaiter(pred) {
    const entry = { pred, resolve: null };
    const promise = new Promise((resolve) => {
      entry.resolve = resolve;
    });
    this.waiters.push(entry);
    return {
      promise,
      cancel: () => {
        const i = this.waiters.indexOf(entry);
        if (i >= 0) this.waiters.splice(i, 1);
      }
    };
  }

  awaitMsg(type) {
    return this.waitUntil((m) => (m ? m.type === type : false));
  }

  close() {
    this.ws.terminate();
  }

  // 只用个人视角快照 + 公开卡牌数据,枚举一批可行行动
  candidateActions(rng) {
    const v = this.view;
    const me = v.players.find((p) => p.name === this.name);
    const acts = [];
    if (v.phase === 'action') {
      const avail = COLORS.filter((c) => v.supply[c] > 0);
      const picks = {};
      for (const c of avail.slice(0, 3)) picks[c] = 1;
      if (Object.keys(picks).length) acts.push({ act: P.ACT.TAKE_GEMS, picks });
      for (const c of avail) if (v.supply[c] >= 4) acts.push({ act: P.ACT.TAKE_GEMS, picks: { [c]: 2 } });
      for (const lv of [1, 2, 3]) {
        if (v.decks[lv] > 0 && me.reserved.length < 3) acts.push({ act: P.ACT.RESERVE, from: 'deck', level: lv });
        for (const cardId of v.market[lv]) {
          const cost = cardDb.cards[cardId].cost;
          let gold = 0;
          for (const cc of COLORS) {
            const eff = Math.max(0, (cost[cc] || 0) - me.bonus[cc]);
            const deficit = eff - Math.min(me.tokens[cc], eff);
            gold += deficit;
          }
          if (gold <= me.tokens.gold) acts.push({ act: P.ACT.BUY, from: 'market', cardId });
          if (me.reserved.length < 3) acts.push({ act: P.ACT.RESERVE, from: 'market', cardId });
        }
      }
      for (const r of me.reserved) {
        if (r.hidden) continue;
        const cost = cardDb.cards[r.id].cost;
        let gold = 0;
        for (const cc of COLORS) {
          const eff = Math.max(0, (cost[cc] || 0) - me.bonus[cc]);
          const deficit = eff - Math.min(me.tokens[cc], eff);
          gold += deficit;
        }
        if (gold <= me.tokens.gold) acts.push({ act: P.ACT.BUY, from: 'reserved', cardId: r.id });
      }
    } else if (v.phase === 'discard') {
      const want = {};
      let need = v.pending.discardCount;
      const left = { ...me.tokens };
      for (const c of [...COLORS, 'gold'].sort((a, b) => left[b] - left[a])) {
        while (need > 0 && left[c] > 0) {
          want[c] = (want[c] || 0) + 1;
          left[c] -= 1;
          need -= 1;
        }
      }
      acts.push({ act: P.ACT.DISCARD, tokens: want });
    } else if (v.phase === 'noble') {
      for (const id of v.pending.nobleChoices) acts.push({ act: P.ACT.CHOOSE_NOBLE, nobleId: id });
    } else if (v.phase === 'tradingPost') {
      for (const id of v.pending.tpChoices) acts.push({ act: P.ACT.CHOOSE_TP, tpId: id });
    } else if (v.phase === 'peek') {
      acts.push({ act: P.ACT.CHOOSE_PEEK, keepIndex: rng() < 0.5 ? 0 : 1 });
    } else if (v.phase === 'bonusGem') {
      for (const c of COLORS) if (v.supply[c] > 0) acts.push({ act: P.ACT.BONUS_GEM, color: c });
    }
    return acts;
  }
}

module.exports = { Bot, mulberry32 };
