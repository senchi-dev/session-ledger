'use strict';
/* MT5 import: reads the HTML history report that MT5 desktop exports (History → right-click → Report → HTML)
   and turns each closed position into a trade inside that day's session.
   The report holds three tables we use: positions (one row per position, with its final stop),
   orders (the opening order carries the stop as first placed) and deals (each partial or full close). */

const SERVER_TO_ET_H = 7;   // FTMO server time runs 7 hours ahead of New York

const mt5Num = s => { const v = String(s ?? '').replace(/[\s\u00a0]/g, ''); return v === '' || isNaN(+v) ? null : +v; };

// 'YYYY.MM.DD HH:MM:SS' in server time → New York date and time, plus the FTMO (Prague) day used for the daily loss limit
function serverTime(s) {
  const m = /^(\d{4})\.(\d\d)\.(\d\d) (\d\d):(\d\d)(?::(\d\d))?$/.exec(String(s || '').trim());
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  const et = new Date(ms - SERVER_TO_ET_H * 3600e3).toISOString(), prague = new Date(ms - 3600e3).toISOString();
  return { date: et.slice(0, 10), time: et.slice(11, 16), pragueDay: prague.slice(0, 10), raw: s.trim() };
}

async function readReport(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const enc = buf[0] === 0xff && buf[1] === 0xfe ? 'utf-16le' : buf[0] === 0xfe && buf[1] === 0xff ? 'utf-16be' : 'utf-8';
  const doc = new DOMParser().parseFromString(new TextDecoder(enc).decode(buf), 'text/html');
  // Rows are told apart by their width, which doesn't depend on the report's language.
  const pos = [], ord = [], deals = [];
  for (const tr of doc.querySelectorAll('tr')) {
    const c = [...tr.querySelectorAll('td')].map(td => td.textContent.trim());
    if (!/^\d{4}\.\d\d\.\d\d \d\d:\d\d/.test(c[0] || '')) continue;
    if (c.length === 14) pos.push(c); else if (c.length === 11) ord.push(c); else if (c.length === 15) deals.push(c);
  }
  if (!pos.length && !deals.length) throw new Error('No positions found. Export the report as HTML from the History tab.');
  const title = (doc.querySelector('title') || {}).textContent || '';
  return {
    account: (/^(\d+)/.exec(title) || [])[1] || '',
    positions: pos.map(c => ({ id: c[1], symbol: c[2], dir: c[3] === 'sell' ? 'short' : 'long', comment: c[4], volume: mt5Num(c[5]), open: mt5Num(c[6]), sl: mt5Num(c[7]), tp: mt5Num(c[8]),
      openAt: c[0], closeAt: c[9], close: mt5Num(c[10]), pnl: (mt5Num(c[11]) || 0) + (mt5Num(c[12]) || 0) + (mt5Num(c[13]) || 0) })),
    orders: new Map(ord.map(c => [c[1], { sl: mt5Num(c[6]), tp: mt5Num(c[7]), state: c[9] }])),
    deals: deals.map(c => ({ at: c[0], symbol: c[2], type: c[3], dir: c[4], volume: mt5Num(c[5]), price: mt5Num(c[6]), pnl: (mt5Num(c[9]) || 0) + (mt5Num(c[10]) || 0) + (mt5Num(c[11]) || 0) + (mt5Num(c[12]) || 0), balance: mt5Num(c[13]), comment: c[14] })),
  };
}

// How the stop moved between placement and close, seen from the trade's direction
function stopMove(dir, entry, first, last) {
  if (first == null || last == null || entry == null) return '';
  const tol = Math.max(0.01, Math.abs(entry - first) * 0.02), sgn = dir === 'long' ? 1 : -1;
  if (Math.abs(last - first) <= tol) return 'held';
  if ((last - first) * sgn < 0) return 'widened';
  const vsEntry = (last - entry) * sgn;
  return Math.abs(vsEntry) <= tol ? 'be' : vsEntry > 0 ? 'trailed' : 'tightened';
}

// Positions → trades. Closing deals are matched to their position by symbol, side and time window;
// the deal at the position's close time is always its last one, earlier ones fill the remaining volume (partials).
function reportTrades(rep) {
  const outs = rep.deals.filter(d => d.dir === 'out').map(d => ({ ...d, used: false }));
  const list = [...rep.positions].sort((a, b) => a.closeAt.localeCompare(b.closeAt));
  return list.map(p => {
    const side = p.dir === 'long' ? 'sell' : 'buy';
    const cand = outs.filter(d => !d.used && d.symbol === p.symbol && d.type === side && d.at >= p.openAt && d.at <= p.closeAt);
    const mine = [];
    let left = p.volume;
    const last = cand.find(d => d.at === p.closeAt);
    if (last) { mine.push(last); left -= last.volume; }
    for (const d of cand) if (d !== last && left > 1e-6 && d.volume <= left + 1e-6) { mine.push(d); left -= d.volume; }
    mine.forEach(d => { d.used = true; });
    mine.sort((a, b) => a.at.localeCompare(b.at));

    const o = rep.orders.get(p.id) || {};
    const first = o.sl ?? p.sl, move = stopMove(p.dir, p.open, first, p.sl);
    const why = (d, i) => {
      if (/^\[sl/.test(d.comment)) return move === 'trailed' ? 'Trailed out' : move === 'be' ? 'Break-even stop' : 'Stopped out';
      if (/^\[tp/.test(d.comment)) return i < mine.length - 1 ? 'Partial at target' : 'Final target';
      return 'Manual';
    };
    const exits = mine.length > 1 ? mine.map((d, i) => ({ pct: +(d.volume / p.volume * 100).toFixed(2), price: d.price, why: why(d, i) })) : [];
    const ppl = instrPPL(p.symbol);
    const t = serverTime(p.openAt);
    return {
      mt5: p.id, comment: p.comment, date: t.date, time: t.time, instrument: p.symbol, dir: p.dir, entryTf: '',
      entry: p.open, stop: first ?? '', target: p.tp ?? o.tp ?? '', exit: exits.length ? '' : p.close, exits,
      size: p.volume, riskUsd: first != null && ppl ? +(Math.abs(p.open - first) * p.volume * ppl).toFixed(2) : '', pnl: +p.pnl.toFixed(2),
      stopMgmt: move, mistakes: move === 'widened' ? [MISTAKES[0]] : [], takeAgain: '', review: {},
      finalStop: p.sl, closedBy: mine.length ? why(mine[mine.length - 1], mine.length - 1) : '',
    };
  });
}

// What FTMO's limits are measured from: the balance now, and at the start of the current FTMO day
function reportSnapshot(rep) {
  const ds = rep.deals.filter(d => d.balance != null);
  if (!ds.length) return null;
  const lastDeal = ds[ds.length - 1], day = serverTime(lastDeal.at).pragueDay;
  const before = ds.filter(d => serverTime(d.at).pragueDay < day);
  const deposit = rep.deals.find(d => d.type === 'balance');
  return {
    account: rep.account, at: lastDeal.at, day, balance: lastDeal.balance,
    dayStart: before.length ? before[before.length - 1].balance : (deposit ? deposit.balance : lastDeal.balance),
    initial: deposit ? deposit.balance : null,
    days: [...new Set(rep.deals.filter(d => d.dir === 'in').map(d => serverTime(d.at).pragueDay))].length,
  };
}

// A trade typed in by hand before importing: same day, instrument and side, and the closest entry price within
// a hundredth of a percent. Each hand-logged trade can be claimed by one position only.
function handLogged(t, claimed) {
  let best = null;
  for (const s of S.sessions) {
    if (s.date !== t.date || s.sample) continue;
    for (const x of s.trades || []) {
      if (x.mt5 || claimed.has(x.id) || x.instrument !== t.instrument || x.dir !== t.dir) continue;
      const e = num(x.entry), gap = e == null ? Infinity : Math.abs(e - t.entry);
      if (gap <= Math.max(0.3, t.entry * 0.0001) && (!best || gap < best.gap)) best = { s, x, gap };
    }
  }
  if (best) claimed.add(best.x.id);
  return best;
}

function viewImport() {
  const known = new Set(S.sessions.flatMap(s => (s.trades || []).map(t => t.mt5).filter(Boolean)));
  let rows = [], snap = null, acct = prefs.get('importAcct', 'live');
  app.innerHTML = `
  <header class="page-head">
    <div><a class="back" href="#trades">← Trades</a><h1>Import from MT5</h1>
      <p class="sub">In MT5 desktop: History tab → right-click → Report → HTML. Export the whole history each time: trades already imported are skipped.</p></div>
  </header>
  <section class="card">
    <label class="drop" id="imp-drop" tabindex="0">Drop the report here, or <span class="link">choose the file</span><input type="file" id="imp-file" accept=".html,.htm,text/html" hidden></label>
    <div id="imp-out"></div>
  </section>`;

  const out = $('#imp-out');
  const render = () => {
    const fresh = rows.filter(r => !r.known);
    if (!fresh.length) { out.innerHTML = `<p class="empty" style="margin-top:16px">Nothing new: all ${plural(rows.length, 'position')} in this report are already in the journal.</p>`; return; }
    const picked = fresh.filter(r => r.on).length;
    out.innerHTML = `
      <div class="imp-head">
        <div class="fld"><span>Import into the account</span>${seg('imp-acct', Object.entries(ACCTS), acct)}</div>
        <p class="small muted">${plural(fresh.length, 'new position')}${rows.length > fresh.length ? ` · ${rows.length - fresh.length} already imported` : ''} · times converted to New York</p>
      </div>
      <div class="table-wrap"><table class="tt imp">
        <thead><tr><th></th><th>Date (ET)</th><th>Instrument</th><th>Side</th><th class="r">Size</th><th class="r">Entry</th><th class="r">Stop placed → final</th><th>Stop</th><th class="r">R</th><th class="r">P&amp;L</th><th>Note</th></tr></thead>
        <tbody>${fresh.map(r => { const t = r.t, rr = tradeR({ ...t, kind: 'trade' }); return `<tr class="${r.on ? '' : 'off'}">
          <td><input type="checkbox" data-pick="${rows.indexOf(r)}" ${r.on ? 'checked' : ''} aria-label="Import this position"></td>
          <td class="mono">${fmtDate(t.date)} <span class="muted">${t.time}</span></td><td>${esc(t.instrument)}</td>
          <td><span class="side ${t.dir}">${t.dir === 'short' ? 'Short' : 'Long'}</span></td><td class="r mono">${t.size}</td><td class="r mono">${t.entry}</td>
          <td class="r mono">${t.stop === '' ? '—' : t.stop}${t.finalStop != null && t.finalStop !== t.stop ? ` → ${t.finalStop}` : ''}</td>
          <td>${t.stopMgmt ? tag(STOP_MGMT[t.stopMgmt], t.stopMgmt === 'widened' ? 'bad' : '') : ''}</td>
          <td class="r mono ${cls(rr)}">${fmtR(rr)}</td><td class="r mono ${cls(t.pnl)}">${fmtUsd(t.pnl)}</td>
          <td class="small">${r.match ? `<span class="pos">updates your logged trade</span>` : ''}${t.exits.length ? `${r.match ? ' · ' : ''}${t.exits.length} exits` : ''}${t.comment && !/^VTM/.test(t.comment) ? `<span class="muted"> ${esc(t.comment)}</span>` : ''}</td></tr>`; }).join('')}</tbody></table></div>
      <div class="set-actions"><button type="button" class="btn primary" id="imp-go" ${picked ? '' : 'disabled'}>Import ${plural(picked, 'trade')}</button>
        <span class="small muted">Untick anything that isn’t a journal trade, such as an expert advisor’s position or a scratch.</span></div>`;
    $$('[data-seg="imp-acct"] button', out).forEach(b => b.addEventListener('click', () => { acct = b.dataset.v; prefs.set('importAcct', acct); render(); }));
    $$('[data-pick]', out).forEach(c => c.addEventListener('change', () => { rows[+c.dataset.pick].on = c.checked; render(); }));
    $('#imp-go').addEventListener('click', run);
  };

  const run = async () => {
    const pick = rows.filter(r => !r.known && r.on);
    const touched = new Map();
    for (const { t, match } of pick) {
      const { date, comment, finalStop, closedBy, ...trade } = t;
      if (match) {   // keep the read, mistakes and review typed by hand; MT5 is right about the numbers
        const s = touched.get(match.s.id) || structuredClone(match.s), x = s.trades.find(y => y.id === match.x.id);
        Object.assign(x, { mt5: trade.mt5, time: trade.time, entry: trade.entry, stop: trade.stop, exit: trade.exit, exits: trade.exits, size: trade.size, riskUsd: trade.riskUsd, pnl: trade.pnl, target: has(x.target) ? x.target : trade.target });
        if (!x.stopMgmt) x.stopMgmt = trade.stopMgmt;
        if (trade.stopMgmt === 'widened' && !(x.mistakes || []).includes(MISTAKES[0])) x.mistakes = [...(x.mistakes || []), MISTAKES[0]];
        touched.set(s.id, s);
        continue;
      }
      let s = [...touched.values()].find(y => y.date === date && y.acct === acct) || S.sessions.find(y => y.date === date && y.acct === acct && !y.sample);
      s = s ? (touched.get(s.id) || structuredClone(s)) : { v: 2, id: uid(), date, acct, prevType: '', prevSide: '', bias: '', profile: '', smt: [], inval: '', draw: '', log: [], trades: [],
        actual: '', biasOk: '', drawHit: '', followed: null, lesson: '', reasons: [], missed: false, review: {}, images: [], created: Date.now() };
      s.trades.push({ id: uid(), ...trade });
      touched.set(s.id, s);
    }
    for (const s of touched.values()) {
      s.trades.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
      s.updated = Date.now();
      await DB.put('trades', s);
      const i = S.sessions.findIndex(y => y.id === s.id);
      if (i >= 0) S.sessions[i] = s; else S.sessions.push(s);
    }
    rebuild();
    if (snap) { S.settings.ftmo = { ...(S.settings.ftmo || {}), snap }; await saveSettings(); }
    toast(`Imported ${plural(pick.length, 'trade')} into ${plural(touched.size, 'session')}`);
    location.hash = '#trades';
  };

  const load = async file => {
    try {
      const rep = await readReport(file);
      snap = reportSnapshot(rep);
      const claimed = new Set();
      rows = reportTrades(rep).map(t => ({ t, known: known.has(t.mt5), match: known.has(t.mt5) ? null : handLogged(t, claimed), on: true }));
      render();
    } catch (e) {
      console.error(e);
      out.innerHTML = `<p class="pv-warn" style="margin-top:16px">${esc('Could not read this file: ' + e.message)}</p>`;
    }
  };
  $('#imp-file').addEventListener('change', e => { if (e.target.files[0]) load(e.target.files[0]); e.target.value = ''; });
  const drop = $('#imp-drop');
  ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', e => { if (e.dataTransfer.files[0]) load(e.dataTransfer.files[0]); });
}

// ───────────────────────── screenshots ─────────────────────────
// A screenshot of MT5's Trade or History tab is read in the browser with Tesseract.js (loaded on first use,
// nothing leaves the device). Each row with a date and buy/sell becomes a trade. Columns are found by meaning,
// not position: prices close to the entry are stop, target and exit; small numbers are volume, swap and profit.
let ocrLib = null;
const loadOcr = () => ocrLib || (ocrLib = new Promise((res, rej) => {
  const s = document.createElement('script');
  s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
  s.onload = () => res(window.Tesseract);
  s.onerror = () => { ocrLib = null; rej(new Error('the text reader could not load; check the connection')); };
  document.head.appendChild(s);
}));

async function ocrLines(file) {
  const T = await loadOcr();
  const bmp = await createImageBitmap(file);
  const k = bmp.width < 2600 ? 3 : 2;   // small text reads better enlarged
  const c = document.createElement('canvas');
  c.width = bmp.width * k; c.height = bmp.height * k;
  const g = c.getContext('2d');
  g.drawImage(bmp, 0, 0, c.width, c.height);
  const img = g.getImageData(0, 0, c.width, c.height), px = img.data;
  let sum = 0;
  for (let i = 0; i < px.length; i += 4) sum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
  const dark = sum / (px.length / 4) < 128;   // dark theme: invert so text is dark on light
  for (let i = 0; i < px.length; i += 4) {
    let v = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    if (dark) v = 255 - v;
    v = v > 170 ? 255 : v < 110 ? 0 : v;
    px[i] = px[i + 1] = px[i + 2] = v;
  }
  g.putImageData(img, 0, 0);
  const worker = await T.createWorker('eng');
  try {
    await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
    const { data } = await worker.recognize(c);
    return data.text.split('\n');
  } finally { await worker.terminate(); }
}

const OCR_DT = /(\d{4})[.\-\/](\d{2})[.\-\/](\d{2})\s*(\d{2})[:.](\d{2})(?:[:.](\d{2}))?/g;
const ocrNums = s => (s.replace(OCR_DT, ' ').match(/[-−]?\d+(?:\.\d+)?/g) || []).map(x => +x.replace('−', '-'));
const matchInstrument = sym => (S.settings.instruments.find(i => i.name.toLowerCase() === String(sym).toLowerCase()) || {}).name || sym;

function parseShotLine(raw) {
  const text = raw.replace(/[|]/g, ' ').replace(/(\d),(\d{2}\b)/g, '$1.$2');
  const dts = [...text.matchAll(OCR_DT)];
  const side = /\b(buy|sell)\b/i.exec(text);
  if (!dts.length || !side) return null;
  const stamp = m => `${m[1]}.${m[2]}.${m[3]} ${m[4]}:${m[5]}:${m[6] || '00'}`;
  const ticket = (text.replace(OCR_DT, ' ').match(/\b\d{7,10}\b/) || [])[0] || '';
  const sym = (text.match(/\b([a-z]{2,6}\d{0,4}\.[a-z]{2,6}|[a-z]{2,4}\d{2,4})\b/i) || [])[1] || '';
  const after = text.slice(side.index + side[0].length);
  const dt2 = [...after.matchAll(OCR_DT)][0];   // a close time means a closed position (History tab)
  const A = ocrNums(dt2 ? after.slice(0, dt2.index) : after), B = dt2 ? ocrNums(after.slice(dt2.index + dt2[0].length)) : [];
  if (A.length < 2) return null;
  const size = A[0], entry = A[1], near = x => Math.abs(x - entry) / entry < 0.05;
  const dir = side[1].toLowerCase() === 'sell' ? 'short' : 'long';
  const nearA = A.slice(2).filter(near), farA = A.slice(2).filter(x => !near(x));
  const open = !dt2;
  let exit = '', pnl = '';
  if (open) nearA.pop();   // the Trade tab ends with the current price and the floating profit
  else {
    exit = B.find(near) ?? '';
    const money = B.filter(x => !near(x));   // commission, swap, profit
    pnl = money.length ? +money.reduce((a, b) => a + b, 0).toFixed(2) : '';
  }
  const below = nearA.filter(x => x < entry), above = nearA.filter(x => x > entry);
  const stop = (dir === 'long' ? below[0] : above[0]) ?? '', target = (dir === 'long' ? above[0] : below[0]) ?? '';
  const t = serverTime(stamp(dts[0]));
  const instrument = matchInstrument(sym), ppl = instrPPL(instrument);
  return {
    mt5: ticket, date: t.date, time: t.time, instrument, dir, entryTf: '', entry, stop, target, exit, exits: [], size,
    riskUsd: stop !== '' && ppl ? +(Math.abs(entry - stop) * size * ppl).toFixed(2) : '', pnl, open,
    stopMgmt: '', mistakes: [], takeAgain: '', review: {},
  };
}

// Trades for one session date, from either an MT5 HTML report or a screenshot of the trade rows
async function mt5TradesFor(file, date) {
  if (/\.html?$/i.test(file.name) || file.type === 'text/html') {
    const rep = await readReport(file);
    const day = reportTrades(rep).filter(t => t.date === date);
    return { trades: day, snap: reportSnapshot(rep), note: day.length ? '' : `No position opened on ${fmtDate(date)} in this report.` };
  }
  if (!/^image\//.test(file.type)) throw new Error('drop an .html report or an image');
  const rows = (await ocrLines(file)).map(parseShotLine).filter(Boolean);
  if (!rows.length) return { trades: [], note: 'No trade row recognised. Crop to the rows of the Trade or History tab and try again.' };
  const same = rows.filter(t => t.date === date);
  // the screenshot was dropped into this session on purpose: if its date was misread, keep the rows anyway
  return same.length ? { trades: same, note: rows.length > same.length ? `${plural(rows.length - same.length, 'row')} from another day ignored.` : '' }
    : { trades: rows, note: `The screenshot reads ${fmtDate(rows[0].date)}, not ${fmtDate(date)}: check the trades.` };
}
