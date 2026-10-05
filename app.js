'use strict';
/* Session Ledger — a local-first trading journal.
   Trades and screenshots are written to this browser first (IndexedDB), so it works offline.
   When you sign in from Settings, every change is also copied to your own Supabase database. */

// ───────────────────────── helpers ─────────────────────────
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = v => {
  if (v === '' || v == null) return null;
  const n = +String(v).trim().replace(/^(-?\d+),(\d+)$/, '$1.$2');   // accepts 31218,5 as well as 31218.5
  return isNaN(n) ? null : n;
};
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const sgn = v => v > 0 ? '+' : v < 0 ? '−' : '';
const fmtR = (r, d = 2) => r == null ? '—' : sgn(r) + Math.abs(r).toFixed(d) + 'R';
const fmtUsd = v => v == null ? '—' : sgn(v) + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = v => v == null || !isFinite(v) ? '—' : Math.round(v * 100) + '%';
const cls = v => v == null ? '' : v > 1e-9 ? 'pos' : v < -1e-9 ? 'neg' : '';
const pad2 = n => String(n).padStart(2, '0');
const isoDay = d => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
const today = () => isoDay(new Date());
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const weekday = d => d ? WD[new Date(d + 'T12:00:00').getDay()] : '';
const fmtDate = d => d ? new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
const byTime = (a, b) => ((a.date || '') + (a.time || '')).localeCompare((b.date || '') + (b.time || ''));
const plural = (n, w) => `${n} ${n === 1 ? w : /[^aeiou]y$/.test(w) ? w.slice(0, -1) + 'ies' : w + 's'}`;

// ───────────────────────── vocabulary ─────────────────────────
const ACCTS = { backtest: 'Backtest', demo: 'Demo', live: 'Live' };
const PROFILES = { '18': '18:00 reversal', london: '1:00 reversal', nyrev: '8:00 reversal', other: 'No clear profile' };
const PROFILE_ORDER = [...Object.keys(PROFILES), 'nymanip'];
const profLabel = k => PROFILES[k] || { nymanip: 'NY manipulation' }[k] || '';
const BIAS = { bull: 'Bullish', bear: 'Bearish', none: 'Neutral' };
const PREV_DIR = { up: 'Up-close', down: 'Down-close' };
const PREV_TYPE = { manip: 'Manipulation', closure: 'Closure through', inside: 'Inside / neither' };
const PREV_SIDE = { high: 'The high', low: 'The low' };
const PREV_CLOSE = { upper: 'Upper third', middle: 'Middle', lower: 'Lower third' };
const SMT_OPTS = ['ES', 'NQ', 'YM', 'None'];
const STOP_MGMT = { held: 'Left where placed', be: 'Moved to break-even', trailed: 'Trailed', widened: 'Moved away' };
const EXIT_WHY = ['Partial at target', 'Final target', 'Trailed out', 'Break-even stop', 'Stopped out', 'Manual', 'Time exit'];
const LOG_KIND = { read: 'Read', inval: 'Invalidated', flip: 'New read', entry: 'Entry', manage: 'Managed', exit: 'Exit', note: 'Note' };
const LOG_HAS_DIR = k => k === 'read' || k === 'flip';
const READ_REL = ['With the initial read', 'After the read flipped', 'No initial bias'];
const has = v => v != null && String(v).trim() !== '';
const PRE_DONE = [
  d => d.prevType && (d.prevType === 'inside' || d.prevSide), d => d.bias, d => d.profile,
  d => (d.smt || []).length, d => has(d.inval), d => has(d.draw) || has(d.planTarget),
];
const POST_DONE = [d => d.actual, d => d.biasOk, d => d.drawHit, d => d.followed === true || d.followed === false, d => has(d.lesson)];
const price = v => num(String(v ?? '').replace(/[,\s]/g, ''));   // prices are typed as 30,461.7
const ROOM = ['2R or more to the draw', 'Less than 2R to the draw'];
const countDone = (checks, d) => checks.filter(fn => fn(d)).length;
const CHECKS = [
  ['bias', 'Bias checklist done'], ['cisd15', '15m CISD confirmed'], ['sig5', '5m continuation signature'],
  ['room', '2R of room to the draw'], ['open', '9:30 did what I demanded'],
];
const MISTAKES = ['Moved stop away', 'Ignored exit rule', 'Entered early', 'Chased', 'Oversized', 'Revenge trade', 'Traded into news', 'Outside my window', 'No stop loss', 'FOMO'];
const NOTRADE_REASONS = ['No bias', 'High-impact news', '9:30 didn’t deliver', 'Profile invalid', 'Setup came too late', 'Pairs disagreed', 'No room for 2R', 'Other'];
const IMG_LABELS = ['HTF / daily', 'Setup / profile', 'Entry', 'Exit / result', 'Position', 'Other'];
const BUCKETS = ['Pre-open', '9:30–10:30', '10:30–12:00', 'After 12:00'];
const Q = {
  goodWin: ['What would you improve in the execution?', 'How could management have increased the profit?', 'What will you do to repeat this trade?'],
  badWin: ['Where did you deviate from the plan, and why?', 'How will you avoid it next time?', 'What exactly was done wrong despite the outcome?'],
  goodLoss: ['Was there a logical way to avoid this loss in the moment?', 'What did you do well despite the outcome?', 'Were your emotions controlled afterwards?'],
  badLoss: ['Where did you deviate from the plan, and why?', 'What were the warning signs?', 'Did your reaction affect the trades that followed?'],
  ntGood: ['Which conditions were missing?', 'What reinforced your confidence to stay out?'],
  ntMissed: ['What caused the miss: unprepared, or hesitation?', 'Did you see it in real time, or only afterwards?', 'What process change lets you take it next time?'],
};
const Q_LABEL = { goodWin: 'Good win', badWin: 'Bad win (rules broken)', goodLoss: 'Good loss', badLoss: 'Bad loss (rules broken)', ntGood: 'Good pass', ntMissed: 'Missed a valid trade' };

// ───────────────────────── storage ─────────────────────────
const DB = (() => {
  let db;
  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const store = (s, mode = 'readonly') => db.transaction(s, mode).objectStore(s);
  return {
    open: () => new Promise((res, rej) => {
      const r = indexedDB.open('session-ledger', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore('trades', { keyPath: 'id' });
        d.createObjectStore('images', { keyPath: 'id' }).createIndex('tradeId', 'tradeId');
        d.createObjectStore('meta', { keyPath: 'k' });
      };
      r.onsuccess = () => { db = r.result; res(); };
      r.onerror = () => rej(r.error);
    }),
    all: s => req(store(s).getAll()),
    keys: s => req(store(s).getAllKeys()),
    get: (s, k) => req(store(s).get(k)),
    // quiet = true writes locally without queueing the change for the cloud copy
    put: async (s, v, quiet) => { await req(store(s, 'readwrite').put(v)); if (!quiet) Cloud.mark(s, s === 'meta' ? v.k : v.id, 'put'); },
    del: async (s, k, quiet) => { await req(store(s, 'readwrite').delete(k)); if (!quiet) Cloud.mark(s, k, 'del'); },
    async clear(s) { for (const k of await this.keys(s)) await this.del(s, k); },
    imagesOf: id => req(store('images').index('tradeId').getAll(id)),
  };
})();

const prefs = (() => {
  let p = {};
  try { p = JSON.parse(localStorage.getItem('sl-prefs') || '{}') || {}; } catch (e) { p = {}; }
  return {
    get: (k, d) => (p[k] == null ? d : p[k]),
    set: (k, v) => { p[k] = v; try { localStorage.setItem('sl-prefs', JSON.stringify(p)); } catch (e) { /* storage unavailable */ } },
  };
})();

const DEFAULT_SETTINGS = {
  accountSize: 10000, riskPct: 0.5, testTarget: 50, expTarget: 0.3, lastBackup: null,
  instruments: [
    { name: 'US100.cash', ppl: 1 }, { name: 'US500.cash', ppl: 1 }, { name: 'US30.cash', ppl: 1 },
    { name: 'NQ', ppl: 20 }, { name: 'MNQ', ppl: 2 }, { name: 'ES', ppl: 50 }, { name: 'MES', ppl: 5 },
  ],
};
const S = { trades: [], settings: { ...DEFAULT_SETTINGS } };
const F = Object.assign({ acct: 'all', period: 'all', instr: 'all' }, prefs.get('filters', {}));

async function loadAll() {
  await DB.open();
  S.trades = await DB.all('trades');
  const m = await DB.get('meta', 'settings');
  S.settings = Object.assign({}, DEFAULT_SETTINGS, m ? m.v : {});
}
const saveSettings = () => DB.put('meta', { k: 'settings', v: S.settings });

// ───────────────────────── cloud copy ─────────────────────────
// The publishable key is meant to be public: row-level security limits every row to its owner.
const CLOUD_CFG = { url: 'https://cgvmysnxdawyjzcleito.supabase.co', key: 'sb_publishable_CZtlCTLeeBsMFg9HZjAiig_rsJDJhwp', bucket: 'ledger-shots' };

const Cloud = (() => {
  let sb = null, user = null, busy = false, again = false, timer = null, error = '';
  let outbox = {};                                   // 'trades:<id>' | 'images:<id>' | 'settings' → { op, ts }
  let st = { uid: null, seeded: false, cursor: {}, lastSync: null };
  const configured = () => !!(CLOUD_CFG.url && CLOUD_CFG.key && window.supabase);
  const saveOutbox = () => DB.put('meta', { k: 'outbox', v: outbox }, true);
  const saveState = () => DB.put('meta', { k: 'cloud', v: st }, true);
  const path = id => `${user.id}/${id}`;
  const ok = r => { if (r.error) throw r.error; return r.data; };
  const status = () => ({ configured: configured(), user, busy, error, pending: Object.keys(outbox).length, lastSync: st.lastSync, online: navigator.onLine });

  function paint() {
    const c = status(), pill = $('#sync');
    if (pill) {
      pill.hidden = !c.configured;
      const state = !c.user ? 'off' : c.busy ? 'busy' : (c.error || c.pending) ? 'wait' : 'ok';
      pill.dataset.state = state;
      const label = { off: 'Not synced', busy: 'Syncing', wait: `${c.pending} waiting`, ok: 'Synced' }[state];
      pill.innerHTML = `<i aria-hidden="true"></i><span>${label}</span>`;
      pill.title = cloudLine(c);
    }
    const line = $('#cloud-status');
    if (line && c.user) line.textContent = cloudLine(c);
  }

  async function fetchSince(table, since) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      let q = sb.from(table).select('*');
      if (since) q = q.gt('updated_at', since);
      const rows = ok(await q.order('updated_at').range(from, from + 999));
      out.push(...rows);
      if (rows.length < 1000) break;
    }
    if (out.length) st.cursor[table] = out[out.length - 1].updated_at;
    return out;
  }

  // Remote → local. A change still waiting in the outbox wins over the remote copy.
  async function pull() {
    const seen = { trades: new Set(), images: new Set(), settings: false };
    let changed = false;
    for (const r of await fetchSince('ledger_trades', st.cursor.ledger_trades)) {
      seen.trades.add(r.id);
      if (outbox['trades:' + r.id]) continue;
      if (r.deleted) await DB.del('trades', r.id, true); else await DB.put('trades', r.data, true);
      changed = true;
    }
    for (const r of await fetchSince('ledger_images', st.cursor.ledger_images)) {
      seen.images.add(r.id);
      if (outbox['images:' + r.id]) continue;
      if (r.deleted) { await DB.del('images', r.id, true); continue; }
      const local = await DB.get('images', r.id);
      if (local && local.label === r.label) continue;
      const blob = local ? local.blob : ok(await sb.storage.from(CLOUD_CFG.bucket).download(path(r.id)));
      await DB.put('images', { id: r.id, tradeId: r.trade_id, label: r.label, created: r.created, blob }, true);
      changed = true;
    }
    for (const r of await fetchSince('ledger_settings', st.cursor.ledger_settings)) {
      seen.settings = true;
      if (outbox.settings) continue;
      S.settings = Object.assign({}, DEFAULT_SETTINGS, r.data);
      await DB.put('meta', { k: 'settings', v: S.settings }, true);
      changed = true;
    }
    if (changed) {
      S.trades = await DB.all('trades');
      if (!/^#\/?(new|edit)/.test(location.hash)) route();   // never redraw over a form being filled in
    }
    return seen;
  }

  // Local → remote, one queued change at a time; a change is dropped from the queue only once it is stored.
  async function push() {
    for (const [key, item] of Object.entries(outbox)) {
      const cut = key.indexOf(':'), store = cut < 0 ? key : key.slice(0, cut), id = key.slice(cut + 1);
      const row = { user_id: user.id, id };
      if (store === 'settings') {
        ok(await sb.from('ledger_settings').upsert({ user_id: user.id, data: S.settings }, { onConflict: 'user_id' }));
      } else if (store === 'trades') {
        const t = item.op === 'del' ? null : await DB.get('trades', id);
        if (item.op === 'del' || !t) ok(await sb.from('ledger_trades').upsert({ ...row, data: null, deleted: true }, { onConflict: 'user_id,id' }));
        else if (!t.sample) ok(await sb.from('ledger_trades').upsert({ ...row, data: t, deleted: false }, { onConflict: 'user_id,id' }));
      } else if (store === 'images') {
        const im = item.op === 'del' ? null : await DB.get('images', id);
        if (im) {
          ok(await sb.storage.from(CLOUD_CFG.bucket).upload(path(id), im.blob, { upsert: true, contentType: im.blob.type || 'image/jpeg' }));
          ok(await sb.from('ledger_images').upsert({ ...row, trade_id: im.tradeId, label: im.label, created: im.created, deleted: false }, { onConflict: 'user_id,id' }));
        } else {
          await sb.storage.from(CLOUD_CFG.bucket).remove([path(id)]);
          ok(await sb.from('ledger_images').upsert({ ...row, deleted: true }, { onConflict: 'user_id,id' }));
        }
      }
      if (outbox[key] && outbox[key].ts === item.ts) delete outbox[key];
      await saveOutbox();
      paint();
    }
  }

  // First sync on this browser: take what the database has, then queue whatever only exists here.
  async function seed() {
    const seen = await pull(), ts = Date.now();
    for (const t of await DB.all('trades')) if (!t.sample && !seen.trades.has(t.id)) outbox['trades:' + t.id] = { op: 'put', ts };
    for (const id of await DB.keys('images')) if (!seen.images.has(id)) outbox['images:' + id] = { op: 'put', ts };
    if (!seen.settings) outbox.settings = { op: 'put', ts };
    st.seeded = true;
    await saveOutbox(); await saveState();
  }

  async function sync() {
    if (!sb || !user) return;
    if (!navigator.onLine) return paint();
    if (busy) { again = true; return; }
    busy = true; error = ''; paint();
    try {
      if (st.uid !== user.id) { st = { uid: user.id, seeded: false, cursor: {}, lastSync: null }; outbox = {}; }
      if (!st.seeded) await seed();
      await push();
      await pull();
      st.lastSync = Date.now();
      await saveState();
    } catch (e) {
      console.error('Cloud sync', e);
      error = e.message || String(e);
    } finally {
      busy = false; paint();
      if (again) { again = false; schedule(); }
    }
  }
  const schedule = () => { clearTimeout(timer); timer = setTimeout(sync, 1200); };

  return {
    status, sync,
    async init() {
      if (!configured()) return;
      outbox = ((await DB.get('meta', 'outbox')) || {}).v || {};
      st = Object.assign(st, ((await DB.get('meta', 'cloud')) || {}).v);
      sb = window.supabase.createClient(CLOUD_CFG.url, CLOUD_CFG.key, { auth: { flowType: 'pkce' } });
      sb.auth.onAuthStateChange((ev, session) => {
        const was = user && user.id;
        user = session ? session.user : null;
        paint();
        if (location.hash === '#settings' && was !== (user && user.id)) viewSettings();
        if (user && (ev === 'SIGNED_IN' || ev === 'INITIAL_SESSION')) setTimeout(sync, 0);   // never call the client from inside its own callback
      });
      window.addEventListener('online', sync);
      window.addEventListener('offline', paint);
      document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - (st.lastSync || 0) > 60000) sync(); });
      paint();
    },
    // Called by DB on every local write. Before the first sync nothing is queued: seed() covers it.
    mark(store, id, op) {
      if (!configured() || !st.seeded) return;
      const key = store === 'meta' ? (id === 'settings' ? 'settings' : null) : `${store}:${id}`;
      if (!key) return;
      outbox[key] = { op, ts: Date.now() };
      saveOutbox(); paint(); schedule();
    },
    signIn: email => sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } }),
    signOut: () => sb.auth.signOut(),
  };
})();

function cloudLine(c) {
  if (!c.user) return 'Not signed in. Entries are kept in this browser only.';
  if (c.busy) return 'Syncing…';
  const wait = c.pending ? `${plural(c.pending, 'change')} waiting` : '';
  if (c.error) return `Sync failed: ${c.error}${wait ? ' · ' + wait : ''}`;
  if (!c.online) return `Offline${wait ? ' · ' + wait : ''}`;
  if (wait) return wait;
  return c.lastSync ? `Up to date · last synced ${new Date(c.lastSync).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}` : 'Not synced yet';
}

// ───────────────────────── maths ─────────────────────────
// R of a single exit price, and the listed exits that carry both a size and a price
function exitR(t, x) {
  const e = num(t.entry), s = num(t.stop);
  const risk = e != null && s != null ? Math.abs(e - s) : 0;
  return risk && x != null ? (t.dir === 'short' ? e - x : x - e) / risk : null;
}
const exitRows = t => (t.exits || []).filter(x => num(x.pct) > 0 && num(x.price) != null);
const exitsPct = t => exitRows(t).reduce((a, x) => a + num(x.pct), 0);
const exitsAvg = t => { const p = exitsPct(t); return p ? exitRows(t).reduce((a, x) => a + num(x.pct) * num(x.price), 0) / p : null; };
// did the trade follow the pre-9:30 bias, or a read that replaced it during the session?
const readRel = t => t.kind !== 'trade' || !t.bias ? null : t.bias === 'none' ? READ_REL[2] : (t.bias === 'bull') === (t.dir !== 'short') ? READ_REL[0] : READ_REL[1];

// R available from the entry to the pre-9:30 draw; null when the draw sits behind the entry (a flipped read)
function roomR(t) {
  const e = num(t.entry), s = num(t.stop), dr = price(t.draw);
  if (t.kind !== 'trade' || e == null || s == null || dr == null || e === s) return null;
  const r = (t.dir === 'short' ? e - dr : dr - e) / Math.abs(e - s);
  return r > 0 ? r : null;
}

function tradeR(t) {
  if (!t || t.kind !== 'trade') return null;
  const o = num(t.rOverride);
  if (o != null) return o;
  const rows = exitRows(t);
  if (rows.length) {
    if (Math.abs(exitsPct(t) - 100) > 0.5) return null;   // part of the position is still open, or the sizes don't add up
    const rs = rows.map(x => exitR(t, num(x.price)));
    return rs.some(r => r == null) ? null : rows.reduce((a, x, i) => a + num(x.pct) / 100 * rs[i], 0);
  }
  const e = num(t.entry), s = num(t.stop), x = num(t.exit);
  const pts = e != null && s != null ? Math.abs(e - s) : 0;
  if (x != null && pts) return (t.dir === 'short' ? e - x : x - e) / pts;
  // no exit price: the broker P&L is enough, measured against the dollars actually at risk
  const p = num(t.pnl), z = sizeOf(t), ppl = instrPPL(t.instrument);
  const atRisk = z && pts && ppl ? z * pts * ppl : num(t.riskUsd);
  return p != null && atRisk ? p / atRisk : null;
}
// lots that risk exactly the planned dollars over the stop distance, rounded down to the 0.01 lot step
function suggestedLots(t) {
  const e = num(t.entry), s = num(t.stop), ppl = instrPPL(t.instrument), risk = num(t.riskUsd);
  const pts = e != null && s != null ? Math.abs(e - s) : 0;
  return pts && risk && ppl ? Math.floor(risk / (pts * ppl) * 100) / 100 : null;
}
const sizeOf = t => num(t.size) ?? suggestedLots(t);
// the average exit implied by the broker P&L, for trades logged without an exit price
function pnlExit(t) {
  const p = num(t.pnl), e = num(t.entry), z = sizeOf(t), ppl = instrPPL(t.instrument);
  return p != null && e != null && z && ppl ? e + (t.dir === 'short' ? -1 : 1) * p / (z * ppl) : null;
}
const shownExit = t => exitRows(t).length ? exitsAvg(t).toFixed(2) : has(t.exit) ? t.exit : pnlExit(t) != null ? pnlExit(t).toFixed(2) : '';
function tradePnl(t) {
  if (!t || t.kind !== 'trade') return null;
  const p = num(t.pnl);
  if (p != null) return p;
  const r = tradeR(t), k = num(t.riskUsd);
  return r != null && k != null ? r * k : null;
}
const outcome = r => r == null ? 'open' : r > 0.1 ? 'win' : r < -0.1 ? 'loss' : 'be';
const instrPPL = name => (S.settings.instruments.find(i => i.name === name) || {}).ppl ?? null;

function timeBucket(t) {
  if (!t.time) return null;
  const [h, m] = t.time.split(':').map(Number);
  const x = h * 60 + m;
  return x < 570 ? BUCKETS[0] : x < 630 ? BUCKETS[1] : x < 720 ? BUCKETS[2] : BUCKETS[3];
}

function stats(list) {
  const closed = list.filter(t => t.kind === 'trade' && tradeR(t) != null).sort(byTime);
  const rs = closed.map(tradeR);
  const n = rs.length;
  const wins = rs.filter(r => r > 0.1), losses = rs.filter(r => r < -0.1);
  const netR = rs.reduce((a, b) => a + b, 0);
  const gw = wins.reduce((a, b) => a + b, 0), gl = -losses.reduce((a, b) => a + b, 0);
  const pnls = closed.map(tradePnl).filter(v => v != null);
  let cum = 0, peak = 0, maxDD = 0;
  const eq = closed.map((t, i) => { cum += rs[i]; peak = Math.max(peak, cum); maxDD = Math.max(maxDD, peak - cum); return { t, r: rs[i], cum }; });
  const rated = closed.filter(t => t.followed === true || t.followed === false);
  let streak = null;
  for (let i = n - 1; i >= 0; i--) {
    const o = outcome(rs[i]);
    if (o === 'be') continue;
    if (!streak) streak = { type: o, n: 0 };
    if (o !== streak.type) break;
    streak.n++;
  }
  return {
    n, closed, netR, maxDD, eq, streak,
    wins: wins.length, losses: losses.length, be: n - wins.length - losses.length,
    winRate: n ? wins.length / n : null, exp: n ? netR / n : null,
    avgWin: wins.length ? gw / wins.length : null, avgLoss: losses.length ? -gl / losses.length : null,
    pf: gl > 0 ? gw / gl : gw > 0 ? Infinity : null,
    pnl: pnls.length ? pnls.reduce((a, b) => a + b, 0) : null,
    adherence: rated.length ? rated.filter(t => t.followed).length / rated.length : null,
  };
}

function groupBy(closed, keyFn, order, labelFn = k => k) {
  const m = new Map();
  closed.forEach(t => [].concat(keyFn(t)).forEach(k => {
    if (k == null || k === '') return;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(tradeR(t));
  }));
  const keys = order ? order.filter(k => m.has(k)) : [...m.keys()];
  return keys.map(k => {
    const rs = m.get(k), net = rs.reduce((a, b) => a + b, 0);
    return { key: k, label: labelFn(k), n: rs.length, netR: net, winRate: rs.filter(r => r > 0.1).length / rs.length };
  });
}

// how often the pre-session read was right, split by any key
function rateBy(list, keyFn, order, labelFn = k => k, okFn = t => t.biasOk === 'right') {
  const m = new Map();
  list.forEach(t => {
    const k = keyFn(t);
    if (k == null || k === '') return;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(okFn(t));
  });
  const keys = order ? order.filter(k => m.has(k)) : [...m.keys()];
  return keys.map(k => { const a = m.get(k); return { key: k, label: labelFn(k), n: a.length, rate: a.filter(Boolean).length / a.length }; });
}
function readStats(list) {
  const graded = list.filter(t => t.biasOk === 'right' || t.biasOk === 'wrong');
  const called = list.filter(t => t.profile && t.actual);
  const rated = list.filter(t => t.followed === true || t.followed === false);
  const drawn = list.filter(t => t.drawHit === 'yes' || t.drawHit === 'no');
  const rate = (a, fn) => a.length ? a.filter(fn).length / a.length : null;
  return {
    graded, called,
    bias: rate(graded, t => t.biasOk === 'right'),
    profile: rate(called, t => t.profile === t.actual),
    plan: rate(rated, t => t.followed),
    draw: rate(drawn, t => t.drawHit === 'yes'),
    bySmt: rateBy(graded, t => !(t.smt || []).length ? null : t.smt.includes('None') ? 'No SMT' : 'SMT at the level', ['SMT at the level', 'No SMT']),
    byPrev: rateBy(graded, t => t.prevType, Object.keys(PREV_TYPE), k => PREV_TYPE[k]),
    byProfile: rateBy(called, t => t.profile, PROFILE_ORDER, profLabel, t => t.profile === t.actual),
    lessons: [...list].filter(t => has(t.lesson)).sort((a, b) => byTime(b, a)).slice(0, 6),
  };
}

function filtered() {
  let list = S.trades;
  if (F.acct !== 'all') list = list.filter(t => t.acct === F.acct);
  if (F.instr !== 'all') list = list.filter(t => t.kind === 'notrade' || t.instrument === F.instr);
  if (F.period !== 'all') {
    const d = new Date(); d.setDate(d.getDate() - Number(F.period));
    const from = isoDay(d);
    list = list.filter(t => (t.date || '') >= from);
  }
  return list;
}

// ───────────────────────── UI atoms ─────────────────────────
const app = $('#app');
let cleanup = [];
const onLeave = fn => cleanup.push(fn);

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}
function seg(name, opts, val, extra = '') {
  return `<div class="seg ${extra}" role="group" data-seg="${name}">${opts.map(([v, l]) =>
    `<button type="button" data-v="${esc(v)}" aria-pressed="${String(v) === String(val)}">${esc(l)}</button>`).join('')}</div>`;
}
function chips(name, opts, selected, extra = '') {
  return `<div class="chips" data-chips="${name}">${opts.map(o =>
    `<button type="button" class="chip ${extra}" data-v="${esc(o)}" aria-pressed="${selected.includes(o)}">${esc(o)}</button>`).join('')}</div>`;
}
const kpi = (k, v, c = '', s = '') => `<div class="kpi"><div class="k">${esc(k)}</div><div class="v ${c}">${v}</div><div class="s">${s || '&nbsp;'}</div></div>`;
const tag = (text, c = '') => `<span class="tag ${c}">${esc(text)}</span>`;

function filterBar() {
  const instrs = [...new Set(S.trades.map(t => t.instrument).filter(Boolean))];
  return seg('acct', [['all', 'All'], ['backtest', 'Backtest'], ['demo', 'Demo'], ['live', 'Live']], F.acct)
    + seg('period', [['30', '30d'], ['90', '90d'], ['all', 'All time']], F.period)
    + (instrs.length > 1 ? `<select class="sel" data-filter="instr" aria-label="Instrument"><option value="all">All instruments</option>${instrs.map(i => `<option ${F.instr === i ? 'selected' : ''}>${esc(i)}</option>`).join('')}</select>` : '');
}
function bindFilters(rerender) {
  $$('.filters [data-seg] button').forEach(b => b.addEventListener('click', () => {
    F[b.parentElement.dataset.seg] = b.dataset.v; prefs.set('filters', F); rerender();
  }));
  const s = $('.filters [data-filter="instr"]');
  if (s) s.addEventListener('change', () => { F.instr = s.value; prefs.set('filters', F); rerender(); });
}
function sampleBanner() {
  return S.trades.some(t => t.sample)
    ? `<div class="banner"><span>Sample data is loaded so you can see how everything works. It’s tagged and easy to remove.</span><button type="button" id="rm-sample">Remove sample data</button></div>`
    : '';
}
function bindSampleBanner(rerender) {
  const b = $('#rm-sample');
  if (!b) return;
  b.addEventListener('click', async () => {
    for (const t of S.trades.filter(x => x.sample)) await DB.del('trades', t.id, true);
    S.trades = S.trades.filter(x => !x.sample);
    toast('Sample data removed');
    rerender();
  });
}

// ───────────────────────── dashboard ─────────────────────────
function viewDashboard() {
  if (!S.trades.length) return viewWelcome();
  const list = filtered();
  const st = stats(list);
  const rd = readStats(list);
  const nts = list.filter(t => t.kind === 'notrade');
  const month = prefs.get('calMonth', latestMonth(list));
  const pf = st.pf == null ? '—' : st.pf === Infinity ? '∞' : st.pf.toFixed(2);

  app.innerHTML = `
  ${sampleBanner()}
  <header class="page-head">
    <div><h1>Dashboard</h1><p class="sub">${plural(st.n, 'closed trade')} · ${plural(nts.length, 'no-trade day')}</p></div>
    <div class="filters">${filterBar()}</div>
  </header>

  <section class="kpis" aria-label="Key statistics">
    ${kpi('Net result', fmtR(st.netR), cls(st.netR), st.pnl != null ? `<span class="${cls(st.pnl)}">${fmtUsd(st.pnl)}</span>` : '')}
    ${kpi('Expectancy', fmtR(st.exp), cls(st.exp), 'average R per trade')}
    ${kpi('Win rate', fmtPct(st.winRate), '', `${st.wins}W · ${st.losses}L · ${st.be}BE`)}
    ${kpi('Profit factor', pf, st.pf == null ? '' : st.pf >= 1 ? 'pos' : 'neg', 'gross win ÷ gross loss')}
    ${kpi('Avg win / loss', `${st.avgWin == null ? '—' : '+' + st.avgWin.toFixed(1)} / ${st.avgLoss == null ? '—' : '−' + Math.abs(st.avgLoss).toFixed(1)}`, '', 'in R')}
    ${kpi('Max drawdown', st.maxDD ? '−' + st.maxDD.toFixed(2) + 'R' : '0.00R', st.maxDD ? 'neg' : '', 'peak to trough')}
    ${kpi('Rules followed', fmtPct(st.adherence), st.adherence == null ? '' : st.adherence >= .9 ? 'pos' : 'neg', 'target 90% or more')}
    ${kpi('Current streak', st.streak ? `${st.streak.n} ${st.streak.type === 'win' ? 'W' : 'L'}` : '—', st.streak ? (st.streak.type === 'win' ? 'pos' : 'neg') : '', st.streak ? (st.streak.type === 'win' ? 'wins in a row' : 'losses in a row') : 'breakevens ignored')}
  </section>

  <section class="row">
    <article class="card">
      <div class="card-h"><h2>Equity curve</h2><span class="muted small mono">cumulative R</span></div>
      <div class="chart" id="eq"></div>
    </article>
    <article class="card">${testCard(st)}</article>
  </section>

  <section class="row">
    <article class="card">${calendar(list, month)}</article>
    <article class="card">${bars('By weekday', groupBy(st.closed, t => weekday(t.date), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']))}</article>
  </section>

  <section class="row three">
    <article class="card">${readCard(rd)}</article>
    <article class="card">${rateBars('Bias accuracy by yesterday’s candle', rd.byPrev, 'which daily setups do you read best?')}
      <div class="rule-gap"></div>${rateBars('Bias accuracy with or without SMT', rd.bySmt)}</article>
    <article class="card">${rateBars('Profile called correctly', rd.byProfile, 'expected profile vs what happened')}</article>
  </section>

  <section class="row three">
    <article class="card">${bars('By daily profile', groupBy(st.closed, t => t.profile, PROFILE_ORDER, profLabel))}
      <div class="rule-gap"></div>${bars('Initial read vs a flipped read', groupBy(st.closed, readRel, READ_REL))}</article>
    <article class="card">${bars('By entry time (ET)', groupBy(st.closed, timeBucket, BUCKETS))}</article>
    <article class="card">${bars('By entry timeframe', groupBy(st.closed, t => t.entryTf, ['15m', '5m', '3m']))}
      <div class="rule-gap"></div>${bars('By stop handling', groupBy(st.closed, t => t.stopMgmt, Object.keys(STOP_MGMT), k => STOP_MGMT[k]))}</article>
  </section>

  <section class="row three">
    <article class="card">${bars('Rules followed vs broken', groupBy(st.closed, t => t.followed === true ? 'Followed' : t.followed === false ? 'Broken' : null, ['Followed', 'Broken']))}
      <div class="rule-gap"></div>${bars('Room at entry', groupBy(st.closed, t => { const r = roomR(t); return r == null ? null : r >= 2 ? ROOM[0] : ROOM[1]; }, ROOM))}</article>
    <article class="card">${bars('Cost of mistakes', groupBy(st.closed, t => t.mistakes || [], MISTAKES), 'net R per tag')}</article>
    <article class="card">${lessonsCard(rd.lessons)}</article>
  </section>

  <section class="row one">
    <article class="card">${recent(list)}</article>
  </section>`;

  bindFilters(viewDashboard);
  bindSampleBanner(viewDashboard);
  drawEquity($('#eq'), st.eq);
  bindCalendar(list);
  const onResize = debounce(() => { const el = $('#eq'); if (el) drawEquity(el, st.eq); }, 120);
  window.addEventListener('resize', onResize);
  onLeave(() => window.removeEventListener('resize', onResize));
}

function viewWelcome() {
  app.innerHTML = `
  <article class="card hero">
    <h1>Start your journal</h1>
    <p>Log every session, including the days you don’t trade. The statistics only become honest once the sample is big enough and the losses are in it too.</p>
    <ol>
      <li><strong>Backtest</strong> entries build your 50-trade system test.</li>
      <li><strong>Demo</strong> and <strong>Live</strong> stay separate, so real money is never mixed with replay results.</li>
      <li>Paste screenshots straight in with <span class="kbd">⌘V</span>: daily chart, profile, entry, result.</li>
    </ol>
    <div class="hero-actions">
      <a class="btn primary" href="#new">Log your first trade</a>
      <button class="btn" type="button" id="load-sample">Explore with sample data</button>
    </div>
    <p class="small muted" style="margin:18px 0 0">Your data is stored only in this browser. Export a backup from Settings regularly.</p>
  </article>`;
  $('#load-sample').addEventListener('click', loadSample);
}

async function loadSample() {
  const data = sampleData();
  for (const t of data) await DB.put('trades', t);
  S.trades.push(...data);
  F.acct = 'all'; F.period = 'all'; F.instr = 'all'; prefs.set('filters', F);
  prefs.set('calMonth', null);
  toast('Sample data loaded');
  route();
}

function latestMonth(list) {
  const last = [...list].sort(byTime).pop();
  return (last && last.date ? last.date : today()).slice(0, 7);
}

function testCard(st) {
  const T = S.settings.testTarget, E = S.settings.expTarget;
  const p = Math.min(1, st.n / T);
  let status, tone = '';
  if (st.n < T) status = `Collecting data: ${plural(T - st.n, 'trade')} to go before judging the system.`;
  else if (st.exp >= E) { status = 'Edge threshold met. Scale risk slowly.'; tone = 'pos'; }
  else if (st.exp > 0) { status = 'Positive but below target. Fix one thing, then retest.'; tone = 'warn'; }
  else { status = 'Negative expectancy. Rethink before risking money.'; tone = 'neg'; }
  return `
    <div class="card-h"><h2>System test</h2><span class="muted small">${F.acct === 'all' ? 'all accounts' : ACCTS[F.acct].toLowerCase()}</span></div>
    <div class="test-big mono">${st.n}<span class="muted">/${T}</span></div>
    <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="${T}" aria-valuenow="${st.n}"><span style="width:${(p * 100).toFixed(1)}%"></span></div>
    <dl class="test-dl">
      <div><dt>Expectancy</dt><dd class="mono ${cls(st.exp)}">${fmtR(st.exp)}</dd></div>
      <div><dt>Target</dt><dd class="mono">+${E.toFixed(2)}R</dd></div>
    </dl>
    <p class="status ${tone}">${status}</p>`;
}

function bars(title, groups, note) {
  const head = `<div class="card-h"><h2>${esc(title)}</h2>${note ? `<span class="muted small">${esc(note)}</span>` : ''}</div>`;
  if (!groups.length) return head + '<p class="empty">No data yet.</p>';
  const max = Math.max(0.5, ...groups.map(g => Math.abs(g.netR)));
  return head + `<ul class="bars">${groups.map(g => {
    const w = (Math.abs(g.netR) / max * 50).toFixed(1);
    const pos = g.netR >= 0 ? `left:50%;width:${w}%` : `right:50%;width:${w}%`;
    return `<li><span class="b-label">${esc(g.label)}</span><span class="b-meta mono muted">${g.n} · ${fmtPct(g.winRate)}</span><span class="b-track"><span class="b-fill ${cls(g.netR)}" style="${pos}"></span></span><span class="b-val mono ${cls(g.netR)}">${fmtR(g.netR, 1)}</span></li>`;
  }).join('')}</ul>`;
}

function rateBars(title, groups, note) {
  const head = `<div class="card-h"><h2>${esc(title)}</h2></div>${note ? `<p class="card-note">${esc(note)}</p>` : ''}`;
  if (!groups.length) return head + '<p class="empty">Grade a few sessions to see this.</p>';
  return head + `<ul class="bars rate">${groups.map(g => `<li><span class="b-label">${esc(g.label)}</span><span class="b-meta mono muted">n ${g.n}</span>
    <span class="b-track"><span class="b-fill ${g.rate >= .5 ? 'pos' : 'neg'}" style="left:0;width:${(g.rate * 100).toFixed(1)}%"></span></span>
    <span class="b-val mono ${g.rate >= .5 ? 'pos' : 'neg'}">${fmtPct(g.rate)}</span></li>`).join('')}</ul>`;
}

function readCard(rd) {
  const tone = v => v == null ? '' : v >= .5 ? 'pos' : 'neg';
  return `<div class="card-h"><h2>Reading the day</h2><span class="muted small">${plural(rd.graded.length, 'graded session')}</span></div>
    <div class="test-big mono ${tone(rd.bias)}">${fmtPct(rd.bias)}</div>
    <p class="small muted" style="margin:-6px 0 0">of daily biases were right</p>
    <dl class="test-dl">
      <div><dt>Profile called</dt><dd class="mono ${tone(rd.profile)}">${fmtPct(rd.profile)}</dd></div>
      <div><dt>Draw reached</dt><dd class="mono ${tone(rd.draw)}">${fmtPct(rd.draw)}</dd></div>
      <div><dt>Rules followed</dt><dd class="mono ${rd.plan == null ? '' : rd.plan >= .9 ? 'pos' : 'neg'}">${fmtPct(rd.plan)}</dd></div>
    </dl>
    <p class="status">${rd.graded.length < 20 ? `Too early to judge: ${plural(20 - rd.graded.length, 'more session')} before these numbers mean much.` : 'Enough sessions to start trusting these splits.'}</p>`;
}

function lessonsCard(items) {
  return `<div class="card-h"><h2>Latest lessons</h2><span class="muted small">one sentence per session</span></div>
  ${items.length ? `<ul class="lessons">${items.map(t => `<li><a href="#trade/${t.id}">
    <span class="mono muted small">${fmtDate(t.date)}${t.biasOk ? ` · <span class="${t.biasOk === 'right' ? 'pos' : 'neg'}">bias ${t.biasOk}</span>` : ''}</span>
    <q>${esc(t.lesson)}</q></a></li>`).join('')}</ul>` : '<p class="empty">Lessons you write after each session show up here.</p>'}`;
}

function calendar(list, ym) {
  const [y, m] = ym.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const nDays = new Date(y, m, 0).getDate();
  const lead = (first.getDay() + 6) % 7;
  const agg = {};
  list.forEach(t => {
    if (!t.date || !t.date.startsWith(ym)) return;
    const d = agg[t.date] || (agg[t.date] = { r: 0, n: 0, nt: 0 });
    if (t.kind === 'notrade') { d.nt++; return; }
    const r = tradeR(t);
    if (r != null) { d.r += r; d.n++; }
  });
  const vals = Object.values(agg);
  const maxA = Math.max(2, ...vals.map(v => Math.abs(v.r)));
  const tot = vals.reduce((a, v) => a + v.r, 0);
  const td = today();
  let cells = '';
  for (let i = 0; i < lead; i++) cells += '<span class="cal-cell blank"></span>';
  for (let d = 1; d <= nDays; d++) {
    const ds = `${ym}-${pad2(d)}`, a = agg[ds], dow = (lead + d - 1) % 7;
    let c = 'cal-cell', style = '', inner = `<span class="cal-d">${d}</span>`, attrs = 'tabindex="-1" disabled';
    if (dow > 4) c += ' wknd';
    if (a && a.n) {
      c += ' has ' + (a.r > 0.1 ? 'pos' : a.r < -0.1 ? 'neg' : 'flat');
      style = `--a:${(0.16 + 0.6 * Math.min(1, Math.abs(a.r) / maxA)).toFixed(2)}`;
      inner += `<span class="cal-r mono">${fmtR(a.r, 1)}</span>`;
      attrs = `aria-label="${fmtDate(ds)}: ${fmtR(a.r, 1)}"`;
    } else if (a && a.nt) {
      c += ' nt'; inner += '<span class="cal-r mono muted">pass</span>'; attrs = `aria-label="${fmtDate(ds)}: no-trade day"`;
    }
    if (ds === td) c += ' today';
    cells += `<button type="button" class="${c}" style="${style}" data-day="${ds}" ${attrs}>${inner}</button>`;
  }
  const label = first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  return `<div class="card-h"><h2>${label}</h2><div class="cal-nav"><span class="mono ${cls(tot)}">${fmtR(tot, 1)}</span><button type="button" class="icon-btn" data-cal="-1" aria-label="Previous month">‹</button><button type="button" class="icon-btn" data-cal="1" aria-label="Next month">›</button></div></div>
  <div class="cal-grid">${['M', 'T', 'W', 'T', 'F', 'S', 'S'].map(x => `<span class="cal-h">${x}</span>`).join('')}${cells}</div>`;
}
function bindCalendar(list) {
  $$('[data-cal]').forEach(b => b.addEventListener('click', () => {
    const [y, m] = prefs.get('calMonth', latestMonth(list)).split('-').map(Number);
    const d = new Date(y, m - 1 + Number(b.dataset.cal), 1);
    prefs.set('calMonth', d.getFullYear() + '-' + pad2(d.getMonth() + 1));
    viewDashboard();
  }));
  $$('.cal-cell[data-day]:not([disabled])').forEach(b => b.addEventListener('click', () => {
    prefs.set('tq', Object.assign(prefs.get('tq', {}), { day: b.dataset.day }));
    location.hash = '#trades';
  }));
}

function recent(list) {
  const items = [...list].sort((a, b) => byTime(b, a)).slice(0, 7);
  return `<div class="card-h"><h2>Latest entries</h2><a class="link small" href="#trades">View all</a></div>
  ${items.length ? `<ul class="recent">${items.map(t => {
    const r = tradeR(t);
    const what = t.kind === 'notrade' ? 'No-trade day' : `${esc(t.instrument)} · ${t.dir === 'short' ? 'Short' : 'Long'}${t.profile ? ' · ' + esc(profLabel(t.profile)) : ''}`;
    return `<li><a href="#trade/${t.id}"><span class="mono muted">${fmtDate(t.date)}</span><span>${what}</span><span class="mono ${cls(r)}">${t.kind === 'notrade' ? '<span class="muted">pass</span>' : fmtR(r)}</span></a></li>`;
  }).join('')}</ul>` : '<p class="empty">Nothing logged in this filter.</p>'}`;
}

function niceStep(range) {
  const raw = range / 4, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}
function drawEquity(el, eq) {
  if (!el) return;
  if (!eq.length) { el.innerHTML = '<div class="empty-chart">Close your first trade to start the curve.</div>'; return; }
  const w = Math.max(280, el.clientWidth), h = el.clientHeight || 230;
  const pl = 44, pr = 14, pt = 12, pb = 24;
  const series = [0, ...eq.map(p => p.cum)];
  let mn = Math.min(...series), mx = Math.max(...series);
  if (mx - mn < 1) { mx += .5; mn -= .5; }
  const padV = (mx - mn) * .08; mn -= padV; mx += padV;
  const N = series.length - 1;
  const X = i => pl + (w - pl - pr) * (N ? i / N : 1);
  const Y = v => pt + (mx - v) / (mx - mn) * (h - pt - pb);
  const step = niceStep(mx - mn);
  let grid = '';
  for (let v = Math.ceil(mn / step) * step; v <= mx + 1e-9; v += step) {
    const y = Y(v).toFixed(1);
    grid += `<line class="${Math.abs(v) < 1e-9 ? 'zero' : 'grid'}" x1="${pl}" x2="${w - pr}" y1="${y}" y2="${y}"/><text class="ax" x="${pl - 8}" y="${+y + 3.5}" text-anchor="end">${(v > 0 ? '+' : '') + (+v.toFixed(2))}R</text>`;
  }
  const pts = series.map((v, i) => `${X(i).toFixed(1)},${Y(v).toFixed(1)}`);
  const y0 = Y(0).toFixed(1);
  const area = `M${X(0).toFixed(1)},${y0} L${pts.join(' L')} L${X(N).toFixed(1)},${y0} Z`;
  const firstD = eq[0].t.date, lastD = eq[eq.length - 1].t.date;
  el.innerHTML = `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Equity curve: ${fmtR(eq[eq.length - 1].cum)} over ${plural(eq.length, 'trade')}">
    <defs>
      <clipPath id="clip-up"><rect x="0" y="0" width="${w}" height="${y0}"/></clipPath>
      <clipPath id="clip-dn"><rect x="0" y="${y0}" width="${w}" height="${Math.max(0, h - y0)}"/></clipPath>
    </defs>
    ${grid}
    <path class="area-pos" d="${area}" clip-path="url(#clip-up)"/>
    <path class="area-neg" d="${area}" clip-path="url(#clip-dn)"/>
    <polyline class="line" points="${pts.join(' ')}"/>
    <circle class="dot" cx="${X(N).toFixed(1)}" cy="${Y(series[N]).toFixed(1)}" r="3.5"/>
    <text class="ax" x="${pl}" y="${h - 6}">${fmtDate(firstD)}</text>
    <text class="ax" x="${w - pr}" y="${h - 6}" text-anchor="end">${fmtDate(lastD)}</text>
    <line class="cursor" x1="0" x2="0" y1="${pt}" y2="${h - pb}" visibility="hidden"/>
    <rect x="${pl}" y="0" width="${w - pl - pr}" height="${h}" fill="transparent" class="hit"/>
  </svg><div class="tip" hidden></div>`;
  const hit = $('.hit', el), tip = $('.tip', el), cur = $('.cursor', el);
  const move = ev => {
    const box = el.getBoundingClientRect();
    const x = (ev.touches ? ev.touches[0].clientX : ev.clientX) - box.left;
    const i = Math.max(1, Math.min(N, Math.round((x - pl) / (w - pl - pr) * N)));
    const p = eq[i - 1];
    cur.setAttribute('x1', X(i)); cur.setAttribute('x2', X(i)); cur.setAttribute('visibility', 'visible');
    tip.hidden = false;
    tip.style.left = Math.max(70, Math.min(w - 70, X(i))) + 'px';
    tip.style.top = Y(series[i]) + 'px';
    tip.innerHTML = `${fmtDate(p.t.date)} · ${fmtR(p.r)}<br>Total ${fmtR(p.cum)}`;
  };
  const out = () => { tip.hidden = true; cur.setAttribute('visibility', 'hidden'); };
  hit.addEventListener('mousemove', move);
  hit.addEventListener('touchmove', move, { passive: true });
  hit.addEventListener('mouseleave', out);
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ───────────────────────── trades list ─────────────────────────
function viewTrades() {
  const q = Object.assign({ text: '', out: 'all', day: '' }, prefs.get('tq', {}));
  let list = filtered();
  if (q.day) list = list.filter(t => t.date === q.day);
  if (q.out !== 'all') list = list.filter(t => q.out === 'notrade' ? t.kind === 'notrade' : t.kind === 'trade' && outcome(tradeR(t)) === q.out);
  if (q.text) {
    const s = q.text.toLowerCase();
    list = list.filter(t => [t.instrument, t.notes, profLabel(t.profile), t.lesson, t.failSign, t.planEntry, t.planStop, t.planPartial, t.planTarget, t.draw, ...(t.log || []).map(x => x.text), ...(t.mistakes || []), ...(t.reasons || []), ...Object.values(t.review || {})]
      .join(' ').toLowerCase().includes(s));
  }
  list = [...list].sort((a, b) => byTime(b, a));

  app.innerHTML = `
  ${sampleBanner()}
  <header class="page-head">
    <div><h1>Trades</h1><p class="sub">${list.length} entr${list.length === 1 ? 'y' : 'ies'}${q.day ? ` on ${fmtDate(q.day)} <button type="button" class="chip-x" id="clear-day">clear day</button>` : ''}</p></div>
    <div class="filters">${filterBar()}</div>
  </header>
  <div class="toolbar">
    <input class="search" type="search" id="tq" placeholder="Search notes, tags, instrument, review answers…" value="${esc(q.text)}" aria-label="Search entries">
    ${seg('out', [['all', 'All'], ['win', 'Wins'], ['loss', 'Losses'], ['be', 'Breakeven'], ['notrade', 'No-trade']], q.out)}
  </div>
  ${list.length ? tradeTable(list) : `<div class="card"><p class="empty" style="margin:0 0 12px">No entries match these filters.</p><a class="btn" href="#new">Log an entry</a></div>`}`;

  bindFilters(viewTrades);
  bindSampleBanner(viewTrades);
  const save = patch => { prefs.set('tq', Object.assign(q, patch)); };
  const s = $('#tq');
  s.addEventListener('input', debounce(() => { save({ text: s.value }); viewTrades(); const n = $('#tq'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }, 250));
  $$('.toolbar [data-seg="out"] button').forEach(b => b.addEventListener('click', () => { save({ out: b.dataset.v }); viewTrades(); }));
  const cd = $('#clear-day');
  if (cd) cd.addEventListener('click', () => { save({ day: '' }); viewTrades(); });
  $$('.tt tbody tr').forEach(tr => tr.addEventListener('click', () => { location.hash = '#trade/' + tr.dataset.id; }));
}

function readCell(t) {
  const b = { bull: 'Bull', bear: 'Bear', none: 'Neutral' }[t.bias];
  if (!b && !t.profile) return '<span class="muted">—</span>';
  const mark = t.biasOk === 'right' ? ' <span class="pos" title="Bias right">✓</span>' : t.biasOk === 'wrong' ? ' <span class="neg" title="Bias wrong">✗</span>' : '';
  return `<span class="muted">${esc([b, t.profile ? profLabel(t.profile).replace(' reversal', '') : ''].filter(Boolean).join(' · '))}</span>${mark}`;
}

function tradeTable(list) {
  return `<div class="card table-wrap"><table class="tt">
  <thead><tr><th>Date</th><th>Account</th><th>Instrument</th><th>Side</th><th>Read</th><th class="r">Result</th><th class="r">P&amp;L</th><th>Rules</th><th class="r">Shots</th></tr></thead>
  <tbody>${list.map(t => {
    const shots = (t.images || []).length || '';
    if (t.kind === 'notrade') {
      return `<tr class="nt" data-id="${t.id}"><td class="mono">${fmtDate(t.date)} <span class="muted">${weekday(t.date)}</span></td><td>${tag(ACCTS[t.acct] || '—')}</td>
      <td colspan="2">No-trade day${(t.reasons || []).length ? ' · ' + esc(t.reasons.join(', ')) : ''}</td><td>${readCell(t)}</td><td class="r mono">pass</td><td></td>
      <td>${t.missed ? tag('missed trade', 'bad') : tag('good pass', 'good')}</td><td class="r mono">${shots}</td></tr>`;
    }
    const r = tradeR(t), p = tradePnl(t);
    return `<tr data-id="${t.id}"><td class="mono">${fmtDate(t.date)} <span class="muted">${weekday(t.date)}${t.time ? ' ' + esc(t.time) : ''}</span></td>
    <td>${tag(ACCTS[t.acct] || '—')}</td><td>${esc(t.instrument || '—')}</td>
    <td><span class="side ${t.dir === 'short' ? 'short' : 'long'}">${t.dir === 'short' ? 'Short' : 'Long'}</span></td>
    <td>${readCell(t)}</td>
    <td class="r mono ${cls(r)}">${r == null ? '<span class="muted">open</span>' : fmtR(r)}</td><td class="r mono ${cls(p)}">${fmtUsd(p)}</td>
    <td>${t.followed === true ? tag('followed', 'good') : t.followed === false ? tag('broken', 'bad') : '<span class="muted">—</span>'}</td>
    <td class="r mono muted">${shots}</td></tr>`;
  }).join('')}</tbody></table></div>`;
}

// ───────────────────────── detail ─────────────────────────
let objectUrls = [];
const trackUrl = blob => { const u = URL.createObjectURL(blob); objectUrls.push(u); return u; };
const releaseUrls = () => { objectUrls.forEach(u => URL.revokeObjectURL(u)); objectUrls = []; };

async function viewDetail(id) {
  const t = S.trades.find(x => x.id === id);
  if (!t) { app.innerHTML = '<p class="empty">This entry doesn’t exist anymore. <a class="link" href="#trades">Back to trades</a></p>'; return; }
  const imgs = (await DB.imagesOf(id)).sort((a, b) => (t.images || []).indexOf(a.id) - (t.images || []).indexOf(b.id));
  const shots = imgs.map(i => ({ url: trackUrl(i.blob), label: i.label }));
  const r = tradeR(t), p = tradePnl(t);
  const isNT = t.kind === 'notrade';
  const title = isNT ? 'No-trade day' : `${t.instrument || 'Trade'} · ${t.dir === 'short' ? 'Short' : 'Long'}`;
  const e = num(t.entry), s = num(t.stop), tg = num(t.target) ?? (roomR(t) != null ? price(t.draw) : null);
  const stopPts = e != null && s != null ? Math.abs(e - s) : null;
  const planned = stopPts && tg != null ? (t.dir === 'short' ? e - tg : tg - e) / stopPts : null;
  const plannedTxt = planned == null ? '' : ` · ${num(t.target) != null ? 'planned' : 'room to the draw'} ${planned.toFixed(2)}R`;
  const oldChecks = Object.values(t.checks || {}).some(Boolean);
  const qk = reviewKey(t);
  const answered = qk ? Q[qk].filter(q => (t.review || {})[q]) : [];

  app.innerHTML = `
  <header class="page-head">
    <div><a class="back" href="#trades">← Trades</a><h1>${esc(title)}</h1>
      <p class="sub">${fmtDate(t.date)} · ${weekday(t.date)}${t.time ? ' · ' + esc(t.time) + ' ET' : ''} · ${esc(ACCTS[t.acct] || '')}${t.sample ? ' · sample' : ''}</p></div>
    <div class="actions"><a class="btn" href="#edit/${t.id}">Edit</a><button type="button" class="btn ghost danger" id="del">Delete</button></div>
  </header>
  <div id="confirm"></div>
  <section class="detail">
    <article class="card">
      <h2>Result</h2>
      ${isNT ? `<div class="result-big muted">pass</div><p class="small muted" style="margin:0">${t.missed ? tag('missed a valid trade', 'bad') : tag('good pass', 'good')}</p>`
        : `<div class="result-big ${cls(r)}">${r == null ? '<span class="muted">open</span>' : fmtR(r)}</div>
           <div class="mono ${cls(p)}">${fmtUsd(p)}</div>
           <p class="small muted" style="margin:10px 0 0">${r == null ? 'Add an exit price or the broker P&amp;L to close it.' : outcome(r) === 'win' ? 'Win' : outcome(r) === 'loss' ? 'Loss' : 'Breakeven'}${plannedTxt}</p>`}
    </article>
    ${isNT ? `
    <article class="card span2">
      <h2 style="margin-bottom:12px">Why no trade</h2>
      <div class="chips">${(t.reasons || []).map(x => tag(x)).join('') || '<span class="muted">No reason logged</span>'}</div>
    </article>` : `
    <article class="card">
      <h2 style="margin-bottom:12px">Execution</h2>
      <dl class="kv">
        <div><dt>Entry</dt><dd>${esc(t.entry || '—')}</dd></div>
        <div><dt>Stop</dt><dd>${esc(t.stop || '—')}</dd></div>
        <div><dt>Target</dt><dd>${esc(t.target || '—')}</dd></div>
        <div><dt>Exit${exitRows(t).length ? ' (average)' : !has(t.exit) && pnlExit(t) != null ? ' (from P&amp;L)' : ''}</dt><dd>${esc(shownExit(t) || '—')}</dd></div>
        <div><dt>Stop distance</dt><dd>${stopPts != null ? stopPts.toFixed(2) + ' pts' : '—'}</dd></div>
        <div><dt>Size</dt><dd>${sizeOf(t) != null ? esc(sizeOf(t)) + ' lots' : '—'}</dd></div>
        <div><dt>Risk</dt><dd>${num(t.riskUsd) != null ? '$' + num(t.riskUsd).toFixed(2) : '—'}</dd></div>
        <div><dt>Entry time · TF</dt><dd>${t.time ? esc(t.time) + ' ET' : '—'}${t.entryTf ? ' · ' + esc(t.entryTf) : ''}</dd></div>
      </dl>
    </article>
    <article class="card">
      <h2 style="margin-bottom:12px">Mistakes</h2>
      ${(t.mistakes || []).length ? `<div class="chips">${t.mistakes.map(m => tag(m, 'bad')).join('')}</div>` : '<p class="small muted" style="margin:0">No mistakes tagged.</p>'}
      ${oldChecks ? `<ul class="checklist" style="margin-top:14px">${CHECKS.map(([k, l]) => `<li><span class="mk ${t.checks[k] ? 'ok' : 'muted'}">${t.checks[k] ? '✓' : '·'}</span>${esc(l)}</li>`).join('')}</ul>` : ''}
    </article>`}
    <article class="card span2">${preBlock(t)}</article>
    <article class="card">${postBlock(t)}</article>
    <article class="card ${isNT ? 'span3' : 'span2'}">${logBlock(t)}</article>
    ${isNT ? '' : `<article class="card">${mgmtBlock(t)}</article>`}
    ${answered.length ? `<article class="card span2">
      <h2 style="margin-bottom:12px">Review <span class="muted">· ${esc(Q_LABEL[qk])}</span></h2>
      <div class="qa">${answered.map(q => `<div><h3>${esc(q)}</h3><p>${esc(t.review[q])}</p></div>`).join('')}</div>
    </article>` : ''}
    <article class="card ${answered.length ? '' : 'span3'}">
      <h2 style="margin-bottom:12px">Notes</h2>
      ${t.notes ? `<p class="notes">${esc(t.notes)}</p>` : '<p class="empty">No notes.</p>'}
    </article>
    <article class="card span3">
      <div class="card-h"><h2>Evidence</h2><span class="muted small">${plural(shots.length, 'screenshot')}</span></div>
      ${shots.length ? `<div class="gallery">${shots.map((s, i) => `<button type="button" data-shot="${i}"><img src="${s.url}" alt="${esc(s.label)}" loading="lazy"><span>${esc(s.label)}</span></button>`).join('')}</div>` : '<p class="empty">No screenshots attached.</p>'}
    </article>
  </section>`;

  $$('[data-shot]').forEach(b => b.addEventListener('click', () => openLightbox(shots, Number(b.dataset.shot))));
  $('#del').addEventListener('click', () => {
    $('#confirm').innerHTML = `<div class="confirm"><span>Delete this entry${shots.length ? ` and its ${plural(shots.length, 'screenshot')}` : ''}? This can’t be undone.</span><div><button type="button" class="btn ghost" id="c-no">Cancel</button><button type="button" class="btn danger solid" id="c-yes">Delete</button></div></div>`;
    $('#c-no').addEventListener('click', () => { $('#confirm').innerHTML = ''; });
    $('#c-yes').addEventListener('click', async () => {
      for (const i of imgs) await DB.del('images', i.id);
      await DB.del('trades', t.id);
      S.trades = S.trades.filter(x => x.id !== t.id);
      toast('Entry deleted');
      location.hash = '#trades';
    });
  });
}

function numbered(rows) {
  return `<ol class="read">${rows.map(([q, a], i) => `<li><span class="q-num mono">${pad2(i + 1)}</span><div><h3>${esc(q)}</h3><div class="a">${a || '<span class="muted">Not answered</span>'}</div></div></li>`).join('')}</ol>`;
}
function preBlock(t) {
  const n = countDone(PRE_DONE, t);
  const side = t.prevType !== 'inside' && t.prevSide ? (t.prevType === 'manip' ? ' of ' : ' ') + PREV_SIDE[t.prevSide].toLowerCase() : '';
  const prev = [PREV_DIR[t.prevDir], t.prevType && PREV_TYPE[t.prevType] + side, t.prevClose && 'closed in the ' + PREV_CLOSE[t.prevClose].toLowerCase()].filter(Boolean).join(' · ');
  const smt = (t.smt || []).length ? (t.smt.includes('None') ? 'No SMT' : t.smt.join(', ') + ' failed') : '';
  const plan = [['Entry trigger', t.planEntry], ['Stop', t.planStop], ['Partial', t.planPartial], ['Target', t.planTarget]].filter(([, v]) => has(v));
  return `<div class="card-h"><h2>Before 9:30</h2><span class="count mono ${n === 6 ? 'pos' : 'muted'}">${n}/6</span></div>` + numbered([
    ["Yesterday's daily", esc(prev)],
    ['Daily bias', t.bias ? `<span class="${t.bias === 'bull' ? 'pos' : t.bias === 'bear' ? 'neg' : ''}">${esc(BIAS[t.bias])}</span>` : ''],
    ['Expected profile', esc(profLabel(t.profile))],
    ['SMT at the key level', esc(smt)],
    ['Invalidation', has(t.inval) ? `<span class="mono">${esc(t.inval)}</span>` : ''],
    has(t.draw) || !plan.length ? ['Draw', has(t.draw) ? `<span class="mono">${esc(t.draw)}</span>` : '']
      : ['Plan', `<dl class="kv tight">${plan.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`],   // entries written before the draw replaced the plan
  ]);
}
function postBlock(t) {
  const n = countDone(POST_DONE, t);
  const hit = t.profile && t.actual ? (t.profile === t.actual ? tag('called it', 'good') : tag('missed', 'bad')) : '';
  return `<div class="card-h"><h2>After the session</h2><span class="count mono ${n === 5 ? 'pos' : 'muted'}">${n}/5</span></div>` + numbered([
    ['Profile that happened', t.actual ? `${esc(profLabel(t.actual))} ${hit}` : ''],
    ['Bias', t.biasOk ? `${tag(t.biasOk === 'right' ? 'Right' : 'Wrong', t.biasOk === 'right' ? 'good' : 'bad')}${t.biasOk === 'wrong' && (has(t.failSign) || t.failTime) ? `<p class="fail">${t.failTime ? `<span class="mono">${esc(t.failTime)} ET</span> · ` : ''}${esc(t.failSign || '')}</p>` : ''}` : ''],
    ['Draw', t.drawHit ? tag(t.drawHit === 'yes' ? 'Reached' : 'Not reached', t.drawHit === 'yes' ? 'good' : 'bad') : ''],
    ['Followed my rules', t.followed === true ? tag('Yes', 'good') : t.followed === false ? tag('No', 'bad') : ''],
    ['Lesson', has(t.lesson) ? `<q class="lesson">${esc(t.lesson)}</q>` : ''],
  ]);
}

function logBlock(t) {
  const rows = t.log || [];
  const dir = x => LOG_HAS_DIR(x.kind) && BIAS[x.dir] ? `<span class="${x.dir === 'bull' ? 'pos' : x.dir === 'bear' ? 'neg' : 'muted'}">${esc(BIAS[x.dir])}</span>` : '';
  return `<div class="card-h"><h2>How the day unfolded</h2><span class="muted small">${plural(rows.length, 'step')}</span></div>` + (rows.length
    ? `<ol class="tl">${rows.map((x, i) => `<li><span class="tl-t mono">${pad2(i + 1)}</span><div><div class="tl-k">${tag(LOG_KIND[x.kind] || LOG_KIND.note, x.kind === 'inval' ? 'bad' : '')}${dir(x)}</div>${has(x.text) ? `<p>${esc(x.text)}</p>` : ''}</div></li>`).join('')}</ol>`
    : `<p class="empty">No steps logged. <a class="link" href="#edit/${t.id}">Add them</a></p>`);
}
function mgmtBlock(t) {
  const rows = exitRows(t), pct = exitsPct(t), size = num(t.size), rel = readRel(t), r = tradeR(t);
  return `<h2 style="margin-bottom:12px">Management</h2>
    <dl class="kv">
      <div><dt>Stop loss</dt><dd class="sans">${t.stopMgmt ? tag(STOP_MGMT[t.stopMgmt], t.stopMgmt === 'widened' ? 'bad' : '') : '—'}</dd></div>
      <div><dt>Traded</dt><dd class="sans">${rel ? tag(rel) : '—'}</dd></div>
    </dl>
    ${rows.length ? `<table class="ex"><tbody>${rows.map(x => { const xr = exitR(t, num(x.price)); return `<tr><td class="mono">${num(x.pct)}%${size ? ` <span class="muted">· ${(size * num(x.pct) / 100).toFixed(2)} lots</span>` : ''}</td><td class="mono">${esc(x.price)}</td><td class="mono ${cls(xr)}">${fmtR(xr)}</td><td class="muted">${esc(x.why || '')}</td></tr>`; }).join('')}</tbody></table>
      <p class="small muted" style="margin:10px 0 0">${Math.abs(pct - 100) <= 0.5 ? `Fully closed · blended ${fmtR(r)}` : pct < 100 ? `${pct}% closed · ${(100 - pct).toFixed(0)}% still open` : `Exits add up to ${pct}%: check the sizes`}</p>`
      : '<p class="empty" style="margin-top:12px">No partials logged: one exit for the whole position.</p>'}`;
}

function reviewKey(d) {
  if (d.kind === 'notrade') return d.missed ? 'ntMissed' : 'ntGood';
  const o = outcome(tradeR(d));
  if (o === 'open') return null;
  const good = d.takeAgain !== 'no';
  return o === 'loss' ? (good ? 'goodLoss' : 'badLoss') : (good ? 'goodWin' : 'badWin');
}

// lightbox
const LB = { shots: [], i: 0 };
function openLightbox(shots, i) {
  LB.shots = shots; LB.i = i;
  const lb = $('#lightbox');
  lb.hidden = false;
  showShot();
  $('.lb-close', lb).focus();
}
function showShot() {
  const lb = $('#lightbox'), s = LB.shots[LB.i];
  $('img', lb).src = s.url; $('img', lb).alt = s.label;
  $('figcaption', lb).textContent = `${s.label} · ${LB.i + 1}/${LB.shots.length}`;
  $('.lb-prev', lb).hidden = $('.lb-next', lb).hidden = LB.shots.length < 2;
}
const closeLightbox = () => { $('#lightbox').hidden = true; };
$('.lb-close').addEventListener('click', closeLightbox);
$('.lb-prev').addEventListener('click', () => { LB.i = (LB.i - 1 + LB.shots.length) % LB.shots.length; showShot(); });
$('.lb-next').addEventListener('click', () => { LB.i = (LB.i + 1) % LB.shots.length; showShot(); });
$('#lightbox').addEventListener('click', e => { if (e.target.id === 'lightbox') closeLightbox(); });

// ───────────────────────── form ─────────────────────────
async function viewForm(id) {
  const existing = id ? S.trades.find(t => t.id === id) : null;
  if (id && !existing) { app.innerHTML = '<p class="empty">Entry not found.</p>'; return; }
  const st = S.settings;
  const d = existing ? structuredClone(existing) : {
    id: uid(), kind: 'trade', acct: prefs.get('lastAcct', 'backtest'), date: today(), time: '',
    instrument: prefs.get('lastInstr', (st.instruments[0] || {}).name || ''), dir: 'long', bias: '', profile: '', prevType: '', prevSide: '', smt: [], inval: '', draw: '',
    actual: '', biasOk: '', drawHit: '', failSign: '', failTime: '', lesson: '',
    entry: '', stop: '', target: '', exit: '', size: '', riskUsd: +(st.accountSize * st.riskPct / 100).toFixed(2), pnl: '', rOverride: '',
    followed: null, mistakes: [], reasons: [], missed: false, review: {}, notes: '', images: [], created: Date.now(),
  };
  d.mistakes = d.mistakes || []; d.reasons = d.reasons || []; d.review = d.review || {}; d.smt = d.smt || [];
  d.exits = d.exits || []; d.log = d.log || [];
  const imgs = existing ? (await DB.imagesOf(id)).sort((a, b) => (d.images || []).indexOf(a.id) - (d.images || []).indexOf(b.id)) : [];
  const form = { d, imgs: imgs.map(i => ({ ...i, url: trackUrl(i.blob) })), removed: [] };
  const instOpts = [...new Set([...st.instruments.map(i => i.name), d.instrument].filter(Boolean))];

  app.innerHTML = `
  <header class="page-head">
    <div><a class="back" href="${existing ? '#trade/' + d.id : '#dashboard'}">← ${existing ? 'Entry' : 'Dashboard'}</a><h1>${existing ? 'Edit entry' : 'New entry'}</h1></div>
    ${seg('kind', [['trade', 'Trade'], ['notrade', 'No-trade day']], d.kind)}
  </header>
  <form id="f" class="form ${d.kind === 'notrade' ? 'is-notrade' : ''}" autocomplete="off" novalidate>
    <div class="form-main">
      <section class="card fs">
        <h2>Context</h2>
        <div class="fgrid">
          <div class="fld wide"><span>Account</span>${seg('acct', Object.entries(ACCTS), d.acct)}</div>
          <label class="fld"><span>Date</span><input type="date" data-f="date" value="${esc(d.date)}" required></label>
          <label class="fld tr-only"><span>Entry time (ET)</span><input type="time" data-f="time" value="${esc(d.time)}"></label>
          <label class="fld tr-only"><span>Instrument</span><select data-f="instrument">${instOpts.map(i => `<option ${i === d.instrument ? 'selected' : ''}>${esc(i)}</option>`).join('')}</select></label>
          <div class="fld tr-only"><span>Direction</span>${seg('dir', [['long', 'Long'], ['short', 'Short']], d.dir, 'pn')}</div>
        </div>
      </section>

      <section class="card fs">
        <div class="sec-h"><div><h2>Before 9:30</h2><p class="sec-sub">Write it before the open. Don’t rewrite it after the fact. <a class="link" href="#playbook">Playbook</a></p></div><span class="count mono" id="pre-n"></span></div>
        <ol class="qs">
          ${qrow(1, 'How did yesterday’s daily candle engage its level?', `<div class="q-subs">
            <div class="q-sub"><span>Type</span>${seg('prevType', Object.entries(PREV_TYPE), d.prevType)}</div>
            <div class="q-sub" id="q-side" ${d.prevType === 'inside' ? 'hidden' : ''}><span>Level engaged</span>${seg('prevSide', Object.entries(PREV_SIDE), d.prevSide)}</div></div>`)}
          ${qrow(2, 'Daily bias', seg('bias', Object.entries(BIAS), d.bias, 'pn'))}
          ${qrow(3, 'Profile expected', seg('profile', Object.entries(PROFILES), d.profile))}
          ${qrow(4, 'SMT at the key level: which index failed?', chips('smt', SMT_OPTS, d.smt))}
          ${qrow(5, 'Invalidation level', `<input class="q-in mono" type="text" inputmode="decimal" data-f="inval" value="${esc(d.inval)}" placeholder="One price, e.g. 30,461.7">`)}
          ${qrow(6, 'Draw: the level you expect price to reach', `<input class="q-in mono" type="text" inputmode="decimal" data-f="draw" value="${esc(d.draw || '')}" placeholder="One price, e.g. 30,091.1">`)}
        </ol>
      </section>

      <section class="card fs">
        <div class="sec-h"><div><h2>How the day unfolded</h2><p class="sec-sub">One line per change of mind or action, in the order it happened. A read that got invalidated stays where it is; add the new one under it.</p></div></div>
        <div class="lines" id="log"></div>
        <button type="button" class="btn small" id="log-add">Add a step</button>
      </section>

      <section class="card fs tr-only">
        <h2>Execution</h2>
        <div class="fgrid">
          <div class="fld wide"><span>Entry timeframe</span>${seg('entryTf', [['15m', '15m'], ['5m', '5m'], ['3m', '3m']], d.entryTf || '')}</div>
          ${numField('entry', 'Entry price', d.entry)}
          ${numField('stop', 'Stop loss', d.stop)}
          ${numField('target', 'Target', d.target, 'Leave empty to use the draw')}
          ${numField('exit', 'Exit price (average)', d.exit, 'Or skip it and enter the broker P&L. Not used once exits are listed under Management')}
          ${numField('riskUsd', 'Risk ($)', d.riskUsd, `${st.riskPct}% of $${Number(st.accountSize).toLocaleString('en-US')}`)}
          ${numField('size', 'Size (lots)', d.size, 'Calculated from risk and stop; type it only if you traded a different size')}
          ${numField('pnl', 'P&L from broker ($)', d.pnl, 'Enough on its own to close the trade')}
          ${has(d.rOverride) ? numField('rOverride', 'Result in R (manual)', d.rOverride, 'Clear it to use the exits instead') : ''}
        </div>
      </section>

      <section class="card fs tr-only">
        <div class="sec-h"><div><h2>Management</h2><p class="sec-sub">What you did with the stop, and every exit with its size. The result is worked out from the exits.</p></div></div>
        <div class="stack">
          <div class="fld"><span>Stop loss</span>${seg('stopMgmt', Object.entries(STOP_MGMT), d.stopMgmt || '')}</div>
          <div><p class="sub-h">Exits</p>
            <div class="lines" id="exits"></div>
            <div class="line-foot"><button type="button" class="btn small" id="exit-add">Add an exit</button><span class="hint" id="exit-sum"></span></div>
          </div>
        </div>
      </section>

      <section class="card fs tr-only">
        <div class="sec-h"><div><h2>Mistakes</h2><p class="sec-sub">Tag what you did wrong, if anything. Each tag is costed on the dashboard.</p></div></div>
        ${chips('mistakes', MISTAKES, d.mistakes, 'bad')}
      </section>

      <section class="card fs nt-only">
        <h2>Why no trade</h2>
        <div class="stack">
          <div><p class="sub-h">Conditions that were missing</p>${chips('reasons', NOTRADE_REASONS, d.reasons)}</div>
          <div class="fld"><span>Did I miss a valid trade?</span>${seg('missed', [['no', 'No, good pass'], ['yes', 'Yes, I missed one']], d.missed ? 'yes' : 'no', 'pn')}</div>
        </div>
      </section>

      <section class="card fs">
        <div class="sec-h"><div><h2>After the session</h2><p class="sec-sub">Fill this in during your review, with a cool head.</p></div><span class="count mono" id="post-n"></span></div>
        <ol class="qs">
          ${qrow(1, 'The profile that actually happened', seg('actual', Object.entries(PROFILES), d.actual))}
          ${qrow(2, 'Was the bias right?', `${seg('biasOk', [['right', 'Right'], ['wrong', 'Wrong']], d.biasOk, 'pn')}
            <div class="q-fail" id="q-fail" ${d.biasOk === 'wrong' ? '' : 'hidden'}>
              <input class="q-in" type="text" data-f="failSign" value="${esc(d.failSign)}" placeholder="First sign it was failing">
              <input class="q-in q-time mono" type="time" data-f="failTime" value="${esc(d.failTime)}" aria-label="When (ET)">
            </div>`)}
          ${qrow(3, 'Was the draw reached?', seg('drawHit', [['yes', 'Reached'], ['no', 'Not reached']], d.drawHit || '', 'pn'))}
          ${qrow(4, 'Did I follow my rules?', seg('followed', [['yes', 'Yes'], ['no', 'No']], d.followed === true ? 'yes' : d.followed === false ? 'no' : '', 'pn'))}
          ${qrow(5, 'One sentence of lesson. Only one.', `<input class="q-in" type="text" maxlength="180" data-f="lesson" value="${esc(d.lesson)}" placeholder="The one thing to remember from today">`)}
        </ol>
      </section>

      <section class="card fs">
        <h2>Notes</h2>
        <textarea data-f="notes" rows="5" placeholder="What did you see, what did you do, what will you change?">${esc(d.notes)}</textarea>
      </section>

      <section class="card fs">
        <h2>Evidence</h2>
        <div class="drop" id="drop" tabindex="0">Drop screenshots here, paste with <span class="kbd">⌘V</span>, or <label class="link">browse<input type="file" id="file" accept="image/*" multiple hidden></label></div>
        <div class="thumbs" id="thumbs"></div>
      </section>
    </div>

    <aside class="form-side">
      <div class="card preview" id="preview"></div>
      <button class="btn primary big" type="submit">Save entry</button>
      <p class="small muted" style="margin:0;text-align:center"><span class="kbd">⌘</span> <span class="kbd">S</span> saves</p>
    </aside>
  </form>`;

  const f = $('#f');
  const refresh = () => {
    $('#preview').innerHTML = previewHTML(d);
    const sz = $('[data-f="size"]', f), lots = suggestedLots(d);
    if (sz) sz.placeholder = lots != null ? lots.toFixed(2) + ' (calculated)' : '';
    const pn = countDone(PRE_DONE, d), qn = countDone(POST_DONE, d);
    $('#pre-n').textContent = pn + '/6'; $('#pre-n').classList.toggle('pos', pn === 6);
    $('#post-n').textContent = qn + '/5'; $('#post-n').classList.toggle('pos', qn === 5);
  };
  // exits: size, price and reason per partial
  const exitMeta = () => {
    $$('#exits .line').forEach((row, i) => { const r = exitR(d, num(d.exits[i].price)); const el = $('.line-r', row); el.textContent = fmtR(r); el.className = 'line-r mono ' + cls(r); });
    const pct = exitsPct(d), n = exitRows(d).length;
    $('#exit-sum').textContent = !n ? 'No partials? Leave this empty and use the exit price above.' : Math.abs(pct - 100) <= 0.5 ? `100% closed · blended ${fmtR(tradeR(d))}` : pct < 100 ? `${pct}% closed · ${(100 - pct).toFixed(0)}% still open` : `Sizes add up to ${pct}%: they should total 100%`;
  };
  const renderExits = () => {
    $('#exits').innerHTML = (d.exits.length ? '<div class="line-head"><span>% of position</span><span>Exit price</span><span>Reason</span><span>Result</span></div>' : '') + d.exits.map((x, i) => `<div class="line exit" data-i="${i}">
      <input type="number" step="any" inputmode="decimal" data-x="pct" value="${esc(x.pct ?? '')}" placeholder="% of position" aria-label="Percent of the position closed">
      <input type="number" step="any" inputmode="decimal" data-x="price" value="${esc(x.price ?? '')}" placeholder="Exit price" aria-label="Exit price">
      <select data-x="why" aria-label="Reason for this exit">${EXIT_WHY.map(w => `<option ${w === x.why ? 'selected' : ''}>${w}</option>`).join('')}</select>
      <span class="line-r mono"></span>
      <button type="button" class="icon-btn" data-rm-line aria-label="Remove this exit">×</button></div>`).join('');
    exitMeta();
  };
  $('#exit-add').addEventListener('click', () => {
    const left = Math.max(0, 100 - d.exits.reduce((a, x) => a + (num(x.pct) || 0), 0));
    d.exits.push({ pct: d.exits.length ? left || '' : 50, price: '', why: d.exits.length ? 'Final target' : 'Partial at target' });
    renderExits(); refresh();
    $('#exits .line:last-child [data-x="price"]').focus();
  });
  $('#exits').addEventListener('input', e => {
    const row = e.target.closest('.line'), k = e.target.dataset.x;
    if (!row || !k) return;
    d.exits[+row.dataset.i][k] = e.target.value;
    exitMeta(); refresh();
  });
  $('#exits').addEventListener('click', e => {
    if (!e.target.closest('[data-rm-line]')) return;
    d.exits.splice(+e.target.closest('.line').dataset.i, 1);
    renderExits(); refresh();
  });

  // the day's timeline: reads, invalidations, entries, management
  const renderLog = () => {
    $('#log').innerHTML = d.log.map((x, i) => `<div class="line log" data-i="${i}">
      <select data-l="kind" aria-label="Kind of step">${Object.entries(LOG_KIND).map(([k, l]) => `<option value="${k}" ${k === x.kind ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <select data-l="dir" aria-label="Direction of the read" ${LOG_HAS_DIR(x.kind) ? '' : 'disabled'}><option value="">Direction</option>${Object.entries(BIAS).map(([k, l]) => `<option value="${k}" ${LOG_HAS_DIR(x.kind) && k === x.dir ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <input type="text" data-l="text" value="${esc(x.text || '')}" placeholder="${x.kind === 'inval' ? 'What invalidated it' : LOG_HAS_DIR(x.kind) ? 'What you saw, and why' : 'What you did'}" aria-label="Description">
      <button type="button" class="icon-btn" data-rm-line aria-label="Remove this step">×</button></div>`).join('');
  };
  $('#log-add').addEventListener('click', () => {
    const NEXT = { read: 'inval', inval: 'flip', flip: 'entry', entry: 'manage', manage: 'exit', exit: 'note', note: 'note' };
    const last = d.log[d.log.length - 1];
    d.log.push(last ? { kind: NEXT[last.kind], dir: '', text: '' } : { kind: 'read', dir: d.bias || '', text: '' });
    renderLog();
    $('#log .line:last-child [data-l="text"]').focus();
  });
  $('#log').addEventListener('input', e => {
    const row = e.target.closest('.line'), k = e.target.dataset.l;
    if (!row || !k) return;
    d.log[+row.dataset.i][k] = e.target.value;
    if (k === 'kind') renderLog();
  });
  $('#log').addEventListener('click', e => {
    if (!e.target.closest('[data-rm-line]')) return;
    d.log.splice(+e.target.closest('.line').dataset.i, 1);
    renderLog();
  });

  const renderThumbs = () => {
    $('#thumbs').innerHTML = form.imgs.map((im, i) => `<figure class="thumb"><img src="${im.url}" alt="${esc(im.label)}">
      <figcaption><select data-img="${i}" aria-label="Screenshot label">${IMG_LABELS.map(l => `<option ${l === im.label ? 'selected' : ''}>${l}</option>`).join('')}</select>
      <button type="button" class="icon-btn" data-rm="${i}" aria-label="Remove screenshot">×</button></figcaption></figure>`).join('');
  };

  // segmented controls
  $$('[data-seg]').forEach(g => g.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    const k = g.dataset.seg, v = b.dataset.v;
    $$('button', g).forEach(x => x.setAttribute('aria-pressed', String(x === b)));
    if (k === 'followed') d.followed = v === 'yes';
    else if (k === 'missed') d.missed = v === 'yes';
    else d[k] = v;
    if (k === 'prevType') $('#q-side').hidden = v === 'inside';
    if (k === 'stopMgmt' && v === 'widened' && !d.mistakes.includes(MISTAKES[0])) {   // moving the stop away is always a tagged mistake
      d.mistakes.push(MISTAKES[0]);
      $$('[data-chips="mistakes"] button', f).forEach(x => x.setAttribute('aria-pressed', String(d.mistakes.includes(x.dataset.v))));
    }
    if (k === 'dir') exitMeta();
    if (k === 'biasOk') $('#q-fail').hidden = v !== 'wrong';
    if (k === 'kind') f.classList.toggle('is-notrade', v === 'notrade');
    refresh();
  }));
  $$('[data-chips]').forEach(g => g.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    const name = g.dataset.chips, v = b.dataset.v, on = d[name].includes(v);
    let next = on ? d[name].filter(x => x !== v) : [...d[name], v];
    if (name === 'smt' && !on) next = v === 'None' ? ['None'] : next.filter(x => x !== 'None');
    d[name] = next;
    $$('button', g).forEach(x => x.setAttribute('aria-pressed', String(next.includes(x.dataset.v))));
    refresh();
  }));
  $$('[data-f]', f).forEach(inp => inp.addEventListener('input', () => { d[inp.dataset.f] = inp.value; if (inp.dataset.f === 'entry' || inp.dataset.f === 'stop') exitMeta(); refresh(); }));

  // screenshots
  const addFiles = async files => {
    const list = [...files].filter(x => x.type && x.type.startsWith('image/'));
    if (!list.length) return;
    for (const file of list) {
      const blob = await compress(file);
      form.imgs.push({ id: uid(), blob, url: trackUrl(blob), label: IMG_LABELS[Math.min(form.imgs.length, 3)], isNew: true });
    }
    renderThumbs();
    toast(plural(list.length, 'screenshot') + ' added');
  };
  $('#file').addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });
  const drop = $('#drop');
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => addFiles(e.dataTransfer.files));
  const onPaste = e => {
    const files = [...(e.clipboardData || {}).items || []].filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean);
    if (files.length) { e.preventDefault(); addFiles(files); }
  };
  document.addEventListener('paste', onPaste);
  onLeave(() => document.removeEventListener('paste', onPaste));
  $('#thumbs').addEventListener('change', e => {
    const s = e.target.closest('[data-img]');
    if (s) { const im = form.imgs[+s.dataset.img]; im.label = s.value; im.dirty = true; }
  });
  $('#thumbs').addEventListener('click', e => {
    const b = e.target.closest('[data-rm]');
    if (!b) return;
    const [im] = form.imgs.splice(+b.dataset.rm, 1);
    if (!im.isNew) form.removed.push(im.id);
    renderThumbs();
  });

  const submit = async e => { if (e) e.preventDefault(); await saveForm(form); };
  f.addEventListener('submit', submit);
  const onKey = e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); submit(); } };
  document.addEventListener('keydown', onKey);
  onLeave(() => document.removeEventListener('keydown', onKey));

  renderThumbs();
  renderExits();
  renderLog();
  refresh();
}

function qrow(n, q, ctrl) {
  return `<li class="q-row"><span class="q-num mono">${pad2(n)}</span><div class="q-body"><p class="q-title">${q}</p><div class="q-ctrl">${ctrl}</div></div></li>`;
}
function numField(k, label, v, hint = '') {
  return `<label class="fld"><span>${esc(label)}</span><input type="number" step="any" inputmode="decimal" data-f="${k}" value="${esc(v ?? '')}">${hint ? `<span class="hint">${esc(hint)}</span>` : ''}</label>`;
}

function sessionPV(d) {
  const pn = countDone(PRE_DONE, d), qn = countDone(POST_DONE, d);
  const bar = (n, of) => `<span class="pv-dots">${Array.from({ length: of }, (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('')}</span>`;
  return `<div class="pv-session"><div><span class="small muted">Before 9:30</span>${bar(pn, 6)}</div><div><span class="small muted">After the session</span>${bar(qn, 5)}</div></div>`;
}

function previewHTML(d) {
  return previewCore(d) + sessionPV(d);
}
function previewCore(d) {
  if (d.kind === 'notrade') {
    return `<h2>Summary</h2><div class="pv-big mono muted">pass</div>
      <p class="small muted" style="margin:8px 0 0">${fmtDate(d.date)} · ${weekday(d.date)}. No-trade days count toward your routine and discipline, not your P&amp;L.</p>`;
  }
  const e = num(d.entry), s = num(d.stop), tg = num(d.target) ?? (roomR(d) != null ? price(d.draw) : null);
  const stopPts = e != null && s != null ? Math.abs(e - s) : null;
  const planned = stopPts && tg != null ? (d.dir === 'short' ? e - tg : tg - e) / stopPts : null;
  const ppl = instrPPL(d.instrument), risk = num(d.riskUsd);
  const lots = suggestedLots(d);
  const r = tradeR(d), p = tradePnl(d);
  let warn = '';
  if (e != null && s != null && ((d.dir === 'long' && s >= e) || (d.dir === 'short' && s <= e))) warn = `Your stop is on the wrong side of entry for a ${d.dir}.`;
  else if (exitRows(d).length && exitsPct(d) > 100.5) warn = `Exits add up to ${exitsPct(d)}% of the position.`;
  else if (planned != null && planned < 2) warn = `${num(d.target) != null ? 'Planned reward' : 'Room to the draw'} is ${planned.toFixed(2)}R, below the 2R baseline.`;
  return `<h2>Live preview</h2>
    <dl class="kv">
      <div><dt>Stop distance</dt><dd>${stopPts != null ? stopPts.toFixed(2) + ' pts' : '—'}</dd></div>
      <div><dt>${num(d.target) != null ? 'Planned' : 'Room to the draw'}</dt><dd>${planned != null ? planned.toFixed(2) + 'R' : '—'}</dd></div>
      <div><dt>Suggested size</dt><dd>${lots != null ? lots.toFixed(2) + ' lots' : '—'}</dd></div>
      <div><dt>Risk</dt><dd>${risk != null ? '$' + risk.toFixed(2) : '—'}</dd></div>
    </dl>
    <div class="pv-result"><span class="small muted">Result</span><span class="pv-big mono ${cls(r)}">${r == null ? `<span class="muted">${exitRows(d).length && exitsPct(d) < 99.5 ? exitsPct(d) + '% closed' : 'open'}</span>` : fmtR(r)}</span><span class="mono ${cls(p)}">${fmtUsd(p)}</span></div>
    ${warn ? `<p class="pv-warn">${esc(warn)}</p>` : ''}`;
}

async function compress(file) {
  try {
    const bmp = await createImageBitmap(file);
    const sc = Math.min(1, 2200 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * sc); c.height = Math.round(bmp.height * sc);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    let blob = await new Promise(r => c.toBlob(r, 'image/webp', 0.88));
    if (!blob || blob.type !== 'image/webp') blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
    return blob && blob.size < file.size ? blob : file;
  } catch (e) { return file; }
}

async function saveForm(form) {
  const d = form.d;
  if (!d.date) return toast('Add a date first');
  if (d.kind === 'trade' && !d.instrument) return toast('Pick an instrument');
  try {
    for (const id of form.removed) await DB.del('images', id);
    for (const im of form.imgs) {
      if (im.isNew || im.dirty) await DB.put('images', { id: im.id, tradeId: d.id, blob: im.blob, label: im.label, created: im.created || Date.now() });
    }
    d.images = form.imgs.map(i => i.id);
    if (d.kind === 'trade' && !has(d.size) && suggestedLots(d) != null) d.size = suggestedLots(d);
    d.exits = (d.exits || []).filter(x => has(x.pct) || has(x.price));
    d.log = (d.log || []).filter(x => has(x.text)).map(({ time, ...x }) => x);   // steps stay in the order they were written
    d.updated = Date.now();
    await DB.put('trades', d);
    const i = S.trades.findIndex(t => t.id === d.id);
    if (i >= 0) S.trades[i] = d; else S.trades.push(d);
    prefs.set('lastAcct', d.acct);
    if (d.instrument) prefs.set('lastInstr', d.instrument);
    toast('Saved');
    location.hash = '#trade/' + d.id;
  } catch (err) {
    console.error(err);
    toast('Could not save: browser storage may be full');
  }
}

// ───────────────────────── playbook ─────────────────────────
const PLAYBOOK = [
  { n: '01', when: 'Before Asia', title: 'Daily bias: context', items: [
    'Mark the relevant highs and lows of the last 30 daily candles.',
    ['How did yesterday engage them?', ['<b>Manipulation</b> → reversal. Trade away from the swing.', '<b>Closure through</b> → continuation.', '<b>Range</b> → neutral. No trade.']],
    'Write down the <b>draw</b> and the <b>invalidation</b>: 50% of yesterday’s range.',
  ] },
  { n: '02', when: '18:00 → 8:00', title: 'Profile: 18:00 prints, 1:00 confirms, 8:00 executes', items: [
    '<b>18:00 · Asia</b>: context only. Did it make the opposing extreme at a 1H+ POI?',
    ['<b>1:00 · London</b>: confirmation. Did it make the extreme, or hold away from the Asia one?', ['<b>Kill check</b>: London already expanded most of the way to the draw → no trade.']],
    ['<b>8:00 · New York</b>: execution. Name the profile:', [
      '<b>18:00 or 1:00 reversal</b>: the extreme is in. Wait for a <b>breakthrough</b>: a continuation signature on the pullback.',
      '<b>8:00 reversal</b>: the extreme isn’t in yet. Wait for a <b>reversal</b>: NY runs the level into a POI, then a CISD confirms.']],
    'The profile answers “breakthrough or reversal?” before 9:30.',
  ] },
  { n: '03', when: 'After 9:30', title: 'Entry: two confirmations', items: [
    ['<b>CISD #1 · 15m</b>, at the POI. Confirms the reversal.', ['18:00 and 1:00 profiles: already happened overnight.', '8:00 profile: happens in NY.']],
    ['<b>CISD #2 · 15m, 5m or 3m</b>, after 9:30, on the pullback: the closure through the opposing candles. <b>This is the entry.</b>', ['Pick the timeframe by how fast price is moving: faster move → lower timeframe.', 'A lower timeframe gives a tighter stop for the same setup.']],
    '<b>Stop</b> beyond the swing · <b>partial</b> at 2R.',
    'Only when <b>bias and profile agree</b>. Otherwise, no trade.',
  ] },
];
const PB_TF = [['Daily', 'bias'], ['7H', 'profile'], ['15m', 'reversal CISD'], ['15m · 5m · 3m', 'entry CISD']];
const PB_KILL = [
  'The opposing run goes through <b>50% of yesterday’s range</b> (low → high). Bullish: the low of day stays above it. Bearish: the high of day stays below it.',
  'A <b>15m close through the high or low of the day</b> your trade depends on.',
  '<b>London exhausted the range</b> toward the draw.',
];
function pbList(items) {
  return `<ul class="pb-list">${items.map(it => Array.isArray(it) ? `<li>${it[0]}${pbList(it[1])}</li>` : `<li>${it}</li>`).join('')}</ul>`;
}
function viewPlaybook() {
  app.innerHTML = `
  <header class="page-head">
    <div><h1>Playbook</h1><p class="sub">AM framework · the order to think in, every morning</p></div>
    <a class="btn" href="#new">Start today’s entry</a>
  </header>
  <section class="pb-tf" aria-label="Timeframes">${PB_TF.map(([t, j]) => `<div><span class="mono">${t}</span><span class="muted">${j}</span></div>`).join('<span class="pb-arrow" aria-hidden="true">→</span>')}</section>
  <section class="pb">
    ${PLAYBOOK.map(s => `<article class="card pb-step">
      <div class="pb-h"><span class="pb-n mono">${s.n}</span><div><p class="pb-when">${s.when}</p><h2>${s.title}</h2></div></div>
      ${pbList(s.items)}
    </article>`).join('')}
    <article class="card pb-step pb-kill">
      <div class="pb-h"><span class="pb-n mono">✕</span><div><p class="pb-when">Any one → no trade</p><h2>Invalidations</h2></div></div>
      ${pbList(PB_KILL)}
      <p class="pb-foot">Log the entry timeframe on every trade. The dashboard shows results per timeframe.</p>
    </article>
  </section>`;
}

// ───────────────────────── settings ─────────────────────────
async function viewSettings() {
  const st = S.settings;
  const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null;
  let usage = '';
  if (navigator.storage && navigator.storage.estimate) {
    const est = await navigator.storage.estimate();
    usage = `${(est.usage / 1048576).toFixed(1)} MB used`;
  }
  const cloud = Cloud.status();
  app.innerHTML = `
  <header class="page-head"><div><h1>Settings</h1><p class="sub">${plural(S.trades.length, 'entry')} stored in this browser${usage ? ' · ' + usage : ''}</p></div></header>
  <section class="row even">
    <article class="card">
      <h2 style="margin-bottom:14px">Account &amp; risk</h2>
      <div class="set-grid">
        ${setField('accountSize', 'Account size ($)', st.accountSize)}
        ${setField('riskPct', 'Risk per trade (%)', st.riskPct)}
        ${setField('testTarget', 'System test size (trades)', st.testTarget)}
        ${setField('expTarget', 'Expectancy target (R)', st.expTarget)}
      </div>
      <p class="small muted" style="margin:14px 0 0">New entries pre-fill risk as <span class="mono">$${(st.accountSize * st.riskPct / 100).toFixed(2)}</span>.</p>
    </article>
    <article class="card">
      <div class="card-h"><h2>Instruments</h2><span class="muted small">$ per point for 1 lot</span></div>
      <table class="inst-table"><tbody>${st.instruments.map((i, k) => `<tr><td><input data-inst="${k}" data-k="name" value="${esc(i.name)}" aria-label="Instrument name"></td><td style="width:120px"><input data-inst="${k}" data-k="ppl" type="number" step="any" value="${esc(i.ppl)}" aria-label="Dollars per point per lot"></td><td style="width:40px"><button type="button" class="icon-btn" data-rm-inst="${k}" aria-label="Remove ${esc(i.name)}">×</button></td></tr>`).join('')}</tbody></table>
      <div class="set-actions"><button type="button" class="btn" id="add-inst">Add instrument</button></div>
      <p class="small muted" style="margin:12px 0 0">US100.cash at FTMO: contract size 1, so $1 per point per lot.</p>
    </article>
    ${cloudCard(cloud)}
    <article class="card">
      <h2 style="margin-bottom:12px">Backup</h2>
      <p class="set-note">${cloud.user ? 'Your journal is copied to your database. A full backup file is a second copy you hold yourself, screenshots included.' : 'Your journal lives only in this browser. Clearing site data or switching device loses it. A full backup includes your screenshots.'}</p>
      <p class="small muted" style="margin:0">Last backup: ${st.lastBackup ? new Date(st.lastBackup).toLocaleString('en-GB') : 'never'}${persisted === true ? ' · persistent storage on' : ''}</p>
      <div class="set-actions">
        <button type="button" class="btn primary" id="exp-json">Export full backup</button>
        <button type="button" class="btn" id="exp-csv">Export trades (CSV)</button>
        <label class="btn">Import backup<input type="file" id="imp" accept="application/json,.json" hidden></label>
        ${persisted === false ? '<button type="button" class="btn ghost" id="persist">Protect storage</button>' : ''}
      </div>
    </article>
    <article class="card">
      <h2 style="margin-bottom:12px">Erase everything</h2>
      <p class="set-note">Deletes every entry and screenshot from this browser${cloud.user ? ' and from your database' : ''}. Export a backup first.</p>
      <div class="set-actions"><input class="search" id="erase-txt" placeholder="Type ERASE to confirm" aria-label="Type ERASE to confirm"><button type="button" class="btn danger" id="erase" disabled>Erase</button></div>
    </article>
  </section>`;

  $$('[data-set]').forEach(inp => inp.addEventListener('change', async () => {
    const v = num(inp.value);
    if (v == null || v < 0) { toast('Enter a positive number'); return; }
    st[inp.dataset.set] = v; await saveSettings(); toast('Saved'); viewSettings();
  }));
  $$('[data-inst]').forEach(inp => inp.addEventListener('change', async () => {
    const i = st.instruments[+inp.dataset.inst];
    i[inp.dataset.k] = inp.dataset.k === 'ppl' ? (num(inp.value) ?? 1) : inp.value.trim();
    await saveSettings(); toast('Saved');
  }));
  $$('[data-rm-inst]').forEach(b => b.addEventListener('click', async () => { st.instruments.splice(+b.dataset.rmInst, 1); await saveSettings(); viewSettings(); }));
  $('#add-inst').addEventListener('click', async () => { st.instruments.push({ name: 'New instrument', ppl: 1 }); await saveSettings(); viewSettings(); });
  $('#exp-json').addEventListener('click', exportJSON);
  $('#exp-csv').addEventListener('click', exportCSV);
  $('#imp').addEventListener('change', async e => { const file = e.target.files[0]; if (file) await importJSON(file); e.target.value = ''; });
  const cin = $('#cloud-in');
  if (cin) cin.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = $('button', cin), line = $('#cloud-status');
    btn.disabled = true; line.textContent = 'Sending…';
    const { error } = await Cloud.signIn($('#cloud-email').value.trim());
    btn.disabled = false;
    line.textContent = error ? 'Could not send the link: ' + error.message : 'Link sent. Open it in this same browser to finish signing in.';
  });
  const csync = $('#cloud-sync');
  if (csync) csync.addEventListener('click', () => Cloud.sync());
  const cout = $('#cloud-out');
  if (cout) cout.addEventListener('click', async () => { await Cloud.signOut(); toast('Signed out. Entries stay in this browser.'); });
  const p = $('#persist');
  if (p) p.addEventListener('click', async () => { const ok = await navigator.storage.persist(); toast(ok ? 'Storage protected' : 'The browser declined; keep exporting backups'); viewSettings(); });
  const et = $('#erase-txt'), eb = $('#erase');
  et.addEventListener('input', () => { eb.disabled = et.value.trim() !== 'ERASE'; });
  eb.addEventListener('click', async () => {
    await DB.clear('trades'); await DB.clear('images');
    S.trades = [];
    toast('Everything erased');
    location.hash = '#dashboard';
  });
}
function cloudCard(c) {
  if (!c.configured) return '';
  if (!c.user) return `<article class="card">
      <h2 style="margin-bottom:12px">Cloud sync</h2>
      <p class="set-note">Sign in to keep a copy of every entry and screenshot in your own database, and to open the journal on another device. Entries still save in this browser first, so it works offline.</p>
      <form class="set-actions" id="cloud-in"><input class="search" type="email" id="cloud-email" placeholder="you@example.com" autocomplete="email" required aria-label="Email address"><button class="btn primary">Email me a sign-in link</button></form>
      <p class="small muted" id="cloud-status" style="margin:12px 0 0"></p>
    </article>`;
  return `<article class="card">
      <div class="card-h"><h2>Cloud sync</h2><span class="muted small">${esc(c.user.email)}</span></div>
      <p class="set-note">Every entry saves in this browser first, then copies to your database. Only your account can read it.</p>
      <p class="small muted" id="cloud-status" style="margin:0">${esc(cloudLine(c))}</p>
      <div class="set-actions"><button type="button" class="btn primary" id="cloud-sync">Sync now</button><button type="button" class="btn ghost" id="cloud-out">Sign out</button></div>
    </article>`;
}
const setField = (k, label, v) => `<label class="fld"><span>${esc(label)}</span><input type="number" step="any" data-set="${k}" value="${esc(v)}"></label>`;

function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const blobToDataURL = b => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });

async function exportJSON() {
  const imgs = await DB.all('images');
  const images = [];
  for (const i of imgs) images.push({ id: i.id, tradeId: i.tradeId, label: i.label, created: i.created, data: await blobToDataURL(i.blob) });
  const payload = { app: 'session-ledger', version: 1, exportedAt: new Date().toISOString(), settings: S.settings, trades: S.trades, images };
  download(`session-ledger-${today()}.json`, new Blob([JSON.stringify(payload)], { type: 'application/json' }));
  S.settings.lastBackup = Date.now();
  await saveSettings();
  toast('Backup exported');
  if (location.hash === '#settings') viewSettings();
}

function exportCSV() {
  const cols = ['date', 'time', 'kind', 'acct', 'instrument', 'dir', 'entryTf', 'prevType', 'prevSide', 'bias', 'profile', 'smt', 'inval', 'draw', 'actual', 'biasOk', 'drawHit', 'failSign', 'failTime', 'lesson', 'entry', 'stop', 'target', 'exit', 'stopMgmt', 'exits', 'log', 'size', 'riskUsd', 'R', 'roomR', 'pnlUsd', 'followed', 'mistakes', 'reasons', 'missed', 'notes'];
  const q = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const rows = [...S.trades].sort(byTime).map(t => cols.map(c => {
    if (c === 'R') { const r = tradeR(t); return r == null ? '' : r.toFixed(3); }
    if (c === 'roomR') { const r = roomR(t); return r == null ? '' : r.toFixed(2); }
    if (c === 'pnlUsd') { const p = tradePnl(t); return p == null ? '' : p.toFixed(2); }
    if (c === 'mistakes' || c === 'reasons' || c === 'smt') return (t[c] || []).join('; ');
    if (c === 'profile' || c === 'actual') return profLabel(t[c]);
    if (c === 'exit') return shownExit(t);
    if (c === 'stopMgmt') return STOP_MGMT[t.stopMgmt] || '';
    if (c === 'exits') return exitRows(t).map(x => `${x.pct}% @ ${x.price}${x.why ? ' (' + x.why + ')' : ''}`).join('; ');
    if (c === 'log') return (t.log || []).map(x => [LOG_KIND[x.kind], LOG_HAS_DIR(x.kind) ? BIAS[x.dir] : '', x.text].filter(Boolean).join(' · ')).join(' | ');
    return t[c];
  }).map(q).join(','));
  download(`session-ledger-trades-${today()}.csv`, new Blob([cols.join(',') + '\n' + rows.join('\n')], { type: 'text/csv' }));
  toast('CSV exported');
}

async function importJSON(file) {
  try {
    const p = JSON.parse(await file.text());
    if (p.app !== 'session-ledger' || !Array.isArray(p.trades)) throw new Error('Not a Session Ledger backup');
    for (const t of p.trades) await DB.put('trades', t);
    for (const i of p.images || []) {
      const blob = await (await fetch(i.data)).blob();
      await DB.put('images', { id: i.id, tradeId: i.tradeId, label: i.label, created: i.created, blob });
    }
    S.trades = await DB.all('trades');
    toast(`Imported ${plural(p.trades.length, 'entry')}`);
    viewSettings();
  } catch (e) {
    console.error(e);
    toast('Import failed: ' + e.message);
  }
}

// ───────────────────────── sample data ─────────────────────────
function sampleData() {
  let seed = 20260929 % 2147483646;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const pick = a => a[Math.floor(rnd() * a.length)];
  const out = [];
  const LESSONS = ['The 15m close decides, not the story.', 'Waited for the CISD instead of anticipating it. Keep doing that.',
    'A read against yesterday’s candle needs more proof than one SMT.', 'Took the partial at 2R and let the runner work.', 'Stop stays where it was placed.',
    'No 9:30 delivery means no trade. Walked away on time.', 'Checked the feed before reading 7H candles.'];
  // pre/post-session read
  const session = (bias, good, draw = '') => {
    const x = { prevType: pick(['manip', 'manip', 'closure', 'inside']), prevSide: pick(['high', 'low']), bias, draw };
    const pRight = (x.prevType === 'inside' ? 0.45 : 0.64) + (good ? 0.12 : -0.12);
    const ok = rnd() < pRight;
    const exp = pick(['18', 'london', 'london', 'nyrev']);
    Object.assign(x, {
      profile: exp, smt: [pick(['ES', 'NQ', 'YM', 'None'])], inval: String(30000 + Math.round(rnd() * 900)),
      drawHit: bias === 'none' ? '' : rnd() < (ok ? 0.6 : 0.12) ? 'yes' : 'no',
      actual: ok && rnd() < 0.8 ? exp : pick(['18', 'london', 'nyrev', 'other']), biasOk: ok ? 'right' : 'wrong',
      failSign: ok ? '' : pick(['15m closed through the invalidation', 'Correlated index confirmed the high', '9:30 expanded the wrong way']),
      failTime: ok ? '' : pick(['08:45', '09:35', '09:50', '10:15']), lesson: rnd() < 0.7 ? pick(LESSONS) : '',
    });
    return x;
  };
  const d = new Date(); d.setDate(d.getDate() - 84);
  while (out.length < 34 && isoDay(d) < today()) {
    d.setDate(d.getDate() + 1);
    const dow = d.getDay();
    if (dow === 0 || dow === 6 || rnd() < 0.42) continue;
    const ds = isoDay(d);
    if (rnd() < 0.16) {
      const missed = rnd() < 0.2;
      out.push({ id: uid(), sample: true, kind: 'notrade', acct: 'backtest', date: ds, time: '', ...session(pick(['bull', 'bear', 'none']), !missed), followed: !missed, reasons: [pick(NOTRADE_REASONS)], missed, review: {}, notes: 'Sample entry.', images: [], mistakes: [], created: Date.now() });
      continue;
    }
    const dir = rnd() < 0.6 ? 'long' : 'short';
    const entry = 30000 + Math.round(rnd() * 900);
    const stopPts = 25 + Math.round(rnd() * 45);
    const followed = rnd() < 0.8;
    const roll = rnd();
    let R = roll < 0.46 ? -1 : roll < 0.54 ? 0 : roll < 0.84 ? 2 : 1 + rnd() * 2.4;
    if (!followed && R > 0) R = R * 0.4 - 0.6;
    const hh = rnd() < 0.25 ? 8 : rnd() < 0.8 ? 9 : 11;
    const mm = hh === 9 ? 31 + Math.floor(rnd() * 28) : Math.floor(rnd() * 59);
    const px = r => +(dir === 'long' ? entry + r * stopPts : entry - r * stopPts).toFixed(2);
    const runner = R > 2.2;   // took half off at 2R and let the rest run
    out.push({
      id: uid(), sample: true, kind: 'trade', acct: 'backtest', date: ds, time: `${pad2(hh)}:${pad2(mm)}`,
      instrument: 'US100.cash', dir, entryTf: pick(['5m', '5m', '15m', '3m']), ...session(dir === 'long' ? 'bull' : 'bear', R > 0, String(px(pick([1.4, 2.2, 2.6, 3.1, 3.8])))),
      entry, stop: dir === 'long' ? entry - stopPts : entry + stopPts, target: dir === 'long' ? entry + 2 * stopPts : entry - 2 * stopPts,
      exit: runner ? '' : px(R), exits: runner ? [{ pct: 50, price: px(2), why: 'Partial at target' }, { pct: 50, price: px(2 * R - 2), why: 'Trailed out' }] : [],
      stopMgmt: !followed && R < 0 ? 'widened' : runner ? 'trailed' : R === 0 ? 'be' : 'held',
      log: [{ kind: 'read', dir: dir === 'long' ? 'bull' : 'bear', text: 'London made the extreme and held away from it.' }, { kind: 'entry', dir: '', text: 'CISD on the pullback.' }],
      size: +(50 / stopPts).toFixed(2), riskUsd: 50, pnl: '', rOverride: '',
      followed, mistakes: followed ? [] : [pick(MISTAKES.slice(0, 6))], reasons: [], missed: false, review: {},
      notes: 'Sample entry.', images: [], created: Date.now(),
    });
  }
  return out;
}

// ───────────────────────── theme ─────────────────────────
const THEMES = ['system', 'light', 'dark'];
const THEME_ICON = { system: '◐', light: '☀', dark: '☾' };
function applyTheme(t) {
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  const b = $('#theme');
  b.textContent = THEME_ICON[t];
  b.setAttribute('aria-label', `Theme: ${t}. Click to change.`);
  b.title = `Theme: ${t}`;
}
$('#theme').addEventListener('click', () => {
  const t = THEMES[(THEMES.indexOf(prefs.get('theme', 'system')) + 1) % THEMES.length];
  prefs.set('theme', t); applyTheme(t);
  if ((location.hash || '#dashboard').startsWith('#dashboard')) viewDashboard();
});

// ───────────────────────── router ─────────────────────────
async function route() {
  cleanup.forEach(fn => fn()); cleanup = [];
  releaseUrls();
  closeLightbox();
  const [view, id] = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('/');
  $$('.nav a').forEach(a => { if (a.dataset.nav === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  if (view === 'trades') viewTrades();
  else if (view === 'new') await viewForm(null);
  else if (view === 'edit') await viewForm(id);
  else if (view === 'trade') await viewDetail(id);
  else if (view === 'settings') await viewSettings();
  else if (view === 'playbook') viewPlaybook();
  else viewDashboard();
  window.scrollTo(0, 0);
}

document.addEventListener('keydown', e => {
  if (!$('#lightbox').hidden) {
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowRight') $('.lb-next').click();
    if (e.key === 'ArrowLeft') $('.lb-prev').click();
    return;
  }
  const typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) || document.activeElement.isContentEditable;
  if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === 'n') { location.hash = '#new'; }
});

(async function init() {
  applyTheme(prefs.get('theme', 'system'));
  try {
    await loadAll();
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  } catch (e) {
    app.innerHTML = `<article class="card hero"><h1>Storage unavailable</h1><p>This browser blocked local storage (private window or blocked site data). The journal needs it to keep your entries.</p></article>`;
    return;
  }
  if (new URLSearchParams(location.search).has('demo') && !S.trades.length) await loadSample();
  window.addEventListener('hashchange', route);
  route();
  Cloud.init().catch(e => console.error('Cloud init', e));
})();
