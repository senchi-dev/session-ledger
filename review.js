'use strict';
/* Review: rule versions, the FTMO tracker, the weekly review and the checkpoint report.
   Everything here reads the same sessions and trade rows as the dashboard; nothing is stored apart
   from versions, weekly decisions and the last checkpoint, which live in settings (and so sync). */

// ───────────────────────── rule versions ─────────────────────────
// A version starts on a date; every session from that date on belongs to it, so results before and after a rule change stay apart.
const versions = () => {
  const v = (S.settings.versions || []).slice().sort((a, b) => a.from.localeCompare(b.from));
  return v.length ? v : [{ n: 1, from: '', change: 'Starting rules' }];
};
const versionOf = date => { let n = 1; for (const v of versions()) if (!v.from || (date || '') >= v.from) n = v.n; return n; };
const currentVersion = () => versions()[versions().length - 1];   // the latest recorded, possibly starting in the future
const activeVersion = () => versionOf(today());                    // the one today's sessions belong to
async function addVersion(change, from) {
  const list = S.settings.versions && S.settings.versions.length ? S.settings.versions : [{ n: 1, from: '', change: 'Starting rules' }];
  list.push({ n: Math.max(...list.map(v => v.n)) + 1, from, change: change.trim() });
  S.settings.versions = list;
  await saveSettings();
}
const nextDay = d => { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + 1); return isoDay(x); };

// ───────────────────────── margins ─────────────────────────
// ±2 standard errors: roughly the range the true value sits in
function meanRange(rs) {
  const n = rs.length;
  if (!n) return null;
  const m = rs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(rs.reduce((a, r) => a + (r - m) ** 2, 0) / (n - 1)) : 0;
  const e = 2 * sd / Math.sqrt(n);
  return { n, m, lo: m - e, hi: m + e };
}
function rateRange(k, n) {
  if (!n) return null;
  const p = k / n, e = 2 * Math.sqrt(p * (1 - p) / n);
  return { n, p, lo: Math.max(0, p - e), hi: Math.min(1, p + e) };
}
const fmtRange = (r, f) => r ? `${f(r.lo)} to ${f(r.hi)}` : '—';

// ───────────────────────── FTMO tracker ─────────────────────────
const FTMO_PHASES = { challenge: ['Challenge', 10], verification: ['Verification', 5], funded: ['Funded', 0] };
function ftmoCard() {
  const f = S.settings.ftmo || {}, snap = f.snap;
  if (!snap) return '';
  const initial = num(f.initial) ?? snap.initial ?? 10000, [label, targetPct] = FTMO_PHASES[f.phase || 'challenge'];
  const bal = snap.balance, todayPrague = new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10);   // the FTMO day starts at 18:00 New York
  const dayStart = snap.day === todayPrague ? snap.dayStart : bal;
  const dailyFloor = dayStart - initial * 0.05, maxFloor = initial * 0.9, target = initial * (1 + targetPct / 100);
  const prog = targetPct ? Math.max(0, Math.min(1, (bal - initial) / (target - initial))) : null;
  const usd = v => '$' + Math.round(v).toLocaleString('en-US');
  return `<article class="card ftmo">
    <div class="card-h"><h2>FTMO ${esc(label)}</h2><span class="muted small">from your MT5 import · ${esc(snap.at.slice(0, 16).replace(/\./g, '-'))} server</span></div>
    <div class="ftmo-grid">
      <div><div class="k">Balance</div><div class="v mono ${cls(bal - initial)}">${usd(bal)}</div><div class="s">${fmtUsd(bal - initial)} since the start</div></div>
      ${targetPct ? `<div><div class="k">Profit target ${usd(target)}</div><div class="progress"><span style="width:${(prog * 100).toFixed(1)}%"></span></div><div class="s">${usd(Math.max(0, target - bal))} to go</div></div>` : ''}
      <div><div class="k">Room today</div><div class="v mono ${bal - dailyFloor < initial * 0.02 ? 'neg' : ''}">${usd(bal - dailyFloor)}</div><div class="s">before the daily floor at ${usd(dailyFloor)}</div></div>
      <div><div class="k">Room overall</div><div class="v mono ${bal - maxFloor < initial * 0.03 ? 'neg' : ''}">${usd(bal - maxFloor)}</div><div class="s">before the ${usd(maxFloor)} floor</div></div>
      <div><div class="k">Trading days</div><div class="v mono ${snap.days >= 4 ? 'pos' : ''}">${snap.days}</div><div class="s">minimum 4</div></div>
    </div>
    <p class="small muted" style="margin:12px 0 0">Closed trades only: an open position’s floating loss also counts toward FTMO’s limits.</p>
  </article>`;
}

// ───────────────────────── review page ─────────────────────────
const mondayOf = d => { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return isoDay(x); };
const addDays = (d, n) => { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + n); return isoDay(x); };

function viewReview(tab, arg) {
  const body = tab === 'checkpoint' ? checkpointHTML(arg) : weekHTML(arg);
  app.innerHTML = `
  ${sampleBanner()}
  <header class="page-head">
    <div><h1>Review</h1><p class="sub">${tab === 'checkpoint' ? 'What your numbers say so far, and the one change to make.' : 'The week in one page, and the one change for next week.'}</p></div>
    <div class="seg" role="group"><a class="btn ${tab === 'checkpoint' ? 'ghost' : ''}" href="#review/week">Week</a><a class="btn ${tab === 'checkpoint' ? '' : 'ghost'}" href="#review/checkpoint">Checkpoint</a></div>
  </header>
  ${body}`;
  bindSampleBanner(() => viewReview(tab, arg));
  if (tab === 'checkpoint') bindCheckpoint(); else bindWeek(arg);
}

// ── week
function weekHTML(arg) {
  const mon = mondayOf(arg || today()), sun = addDays(mon, 6);
  const sess = S.sessions.filter(s => s.date >= mon && s.date <= sun).sort((a, b) => a.date.localeCompare(b.date));
  const rows = sess.flatMap(rowsOf), st = stats(rows), rd = readStats(sess);
  const mistakes = groupBy(st.closed, t => t.mistakes || [], MISTAKES);
  const fails = sess.flatMap(s => (s.log || []).filter(x => x.kind === 'inval' && has(x.text)).map(x => ({ s, text: x.text })));
  const lessons = sess.filter(s => has(s.lesson));
  const notes = S.settings.weekly || {}, prev = notes[addDays(mon, -7)], mine = notes[mon] || {};
  return `
  <div class="week-nav"><a class="icon-btn" href="#review/week/${addDays(mon, -7)}" aria-label="Previous week">‹</a>
    <h2>${fmtDate(mon)} – ${fmtDate(sun)}</h2><a class="icon-btn" href="#review/week/${addDays(mon, 7)}" aria-label="Next week">›</a></div>
  ${!sess.length ? '<article class="card"><p class="empty" style="margin:0">No session logged this week.</p></article>' : `
  <section class="kpis" aria-label="This week">
    ${kpi('Net result', fmtR(st.netR), cls(st.netR), st.pnl != null ? `<span class="${cls(st.pnl)}">${fmtUsd(st.pnl)}</span>` : '')}
    ${kpi('Trades', String(st.n), '', `${st.wins}W · ${st.losses}L · ${st.be}BE`)}
    ${kpi('Bias right', fmtPct(rd.bias), rd.bias == null ? '' : rd.bias >= .5 ? 'pos' : 'neg', plural(rd.graded.length, 'graded session'))}
    ${kpi('Rules followed', fmtPct(rd.plan), rd.plan == null ? '' : rd.plan >= .9 ? 'pos' : 'neg', 'sessions')}
  </section>
  <section class="row">
    <article class="card">
      <h2 style="margin-bottom:12px">Sessions</h2>
      <ul class="week-days">${sess.map(s => { const tr = rowsOf(s).filter(t => t.kind === 'trade'), rs = tr.map(tradeR).filter(r => r != null), net = rs.reduce((a, b) => a + b, 0);
        return `<li><a href="#trade/${s.id}"><span class="mono muted">${weekday(s.date)} ${fmtDate(s.date).replace(/ \d{4}$/, '')}</span>
          <span>${s.bias ? `<span class="${s.bias === 'bull' ? 'pos' : s.bias === 'bear' ? 'neg' : ''}">${esc(BIAS[s.bias])}</span>` : '<span class="muted">no read</span>'}${s.biasOk ? ` ${s.biasOk === 'right' ? '<span class="pos">✓</span>' : '<span class="neg">✗</span>'}` : ''}${s.followed === false ? ' ' + tag('rules broken', 'bad') : ''}</span>
          <span class="mono ${cls(net)}">${tr.length ? (rs.length ? fmtR(net) : 'open') + ` <span class="muted">· ${plural(tr.length, 'trade')}</span>` : '<span class="muted">no trade</span>'}</span></a></li>`; }).join('')}</ul>
    </article>
    <article class="card">${bars('Mistakes this week', mistakes, 'net R per tag')}</article>
  </section>
  <section class="row">
    <article class="card">
      <h2 style="margin-bottom:12px">What failed</h2>
      ${fails.length ? `<ul class="plain">${fails.map(x => `<li><span class="mono muted">${weekday(x.s.date)}</span> ${esc(x.text)}</li>`).join('')}</ul>` : '<p class="empty" style="margin:0">No invalidation logged in the timelines this week.</p>'}
      ${lessons.length ? `<div class="rule-gap"></div><p class="sub-h">Lessons</p><ul class="plain">${lessons.map(s => `<li><span class="mono muted">${weekday(s.date)}</span> <q class="lesson">${esc(s.lesson)}</q></li>`).join('')}</ul>` : ''}
    </article>
    <article class="card">
      <h2 style="margin-bottom:12px">One change for next week</h2>
      ${prev && has(prev.change) ? `<p class="small muted" style="margin:0 0 10px">Last week you chose: <q class="lesson">${esc(prev.change)}</q></p>` : ''}
      <textarea id="wk-change" rows="3" placeholder="The single thing you’ll do differently next week">${esc(mine.change || '')}</textarea>
      <div class="set-actions"><button type="button" class="btn" id="wk-rule" ${has(mine.change) ? '' : 'disabled'}>Make it a rule change from ${fmtDate(addDays(mon, 7))}</button></div>
      <p class="small muted" style="margin:10px 0 0">A rule change starts a new version, so the dashboard and checkpoint can compare before and after.</p>
    </article>
  </section>`}`;
}
function bindWeek(arg) {
  const ta = $('#wk-change');
  if (!ta) return;
  const mon = mondayOf(arg || today());
  const save = debounce(async () => { S.settings.weekly = { ...(S.settings.weekly || {}), [mon]: { change: ta.value } }; await saveSettings(); }, 500);
  ta.addEventListener('input', () => { $('#wk-rule').disabled = !has(ta.value); save(); });
  $('#wk-rule').addEventListener('click', async () => {
    await addVersion(ta.value, addDays(mon, 7));
    toast(`Version ${currentVersion().n} starts ${fmtDate(addDays(mon, 7))}`);
  });
}

// ── checkpoint
function checkpointHTML(arg) {
  const vs = versions(), ver = +(arg || activeVersion());
  const sess = S.sessions.filter(s => versionOf(s.date) === ver && (F.acct === 'all' || s.acct === F.acct));
  const rows = sess.flatMap(rowsOf), st = stats(rows), rd = readStats(sess);
  const rs = st.closed.map(tradeR), all = meanRange(rs);
  const fol = meanRange(st.closed.filter(t => t.followed === true).map(tradeR)), brk = meanRange(st.closed.filter(t => t.followed === false).map(tradeR));
  const graded = rd.graded.length;
  const reads = [
    ['Bias', rateRange(rd.graded.filter(s => s.biasOk === 'right').length, graded)],
    ['Profile', rateRange(rd.called.filter(s => s.profile === s.actual).length, rd.called.length)],
    ['Draw', rateRange(sess.filter(s => s.drawHit === 'yes').length, sess.filter(s => s.drawHit === 'yes' || s.drawHit === 'no').length)],
  ];
  const weakest = reads.filter(([, r]) => r && r.n >= 10).sort((a, b) => a[1].p - b[1].p)[0];
  const leaks = groupBy(st.closed, t => t.mistakes || [], MISTAKES).filter(g => g.netR < 0).sort((a, b) => a.netR - b.netR).slice(0, 3);
  const dims = [
    ['Profile', t => t.profile, PROFILE_ORDER, profLabel], ['Entry time', timeBucket, BUCKETS], ['Entry timeframe', t => t.entryTf, ['15m', '5m', '3m']],
    ['Stop handling', t => t.stopMgmt, Object.keys(STOP_MGMT), k => STOP_MGMT[k]], ['Room at entry', t => { const r = roomR(t); return r == null ? null : r >= 2 ? ROOM[0] : ROOM[1]; }, ROOM],
    ['Yesterday', t => t.prevType, Object.keys(PREV_TYPE), k => PREV_TYPE[k]], ['Read', readRel, READ_REL], ['Weekday', t => weekday(t.date), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']],
  ];
  const splits = dims.flatMap(([d, fn, order, lab]) => groupBy(st.closed, fn, order, lab).filter(g => g.n >= 10).map(g => ({ ...g, d, exp: g.netR / g.n })));
  splits.sort((a, b) => b.exp - a.exp);
  const best = splits.slice(0, 2), worst = splits.length > 2 ? splits.slice(-2).reverse() : [];
  const signs = sess.flatMap(s => (s.log || []).filter(x => x.kind === 'inval' && has(x.text)).map(x => x.text)).concat(sess.filter(s => s.biasOk === 'wrong' && has(s.lesson)).map(s => s.lesson));
  const done = (S.settings.checkpoints || {})[ver];

  const verdict = !all || all.n < 30 ? ['muted', `Too early: ${all ? all.n : 0} of 30 trades before expectancy says anything.`]
    : all.lo > 0 ? ['pos', 'Positive so far: even the low end of the range is above zero.']
    : all.hi < 0 ? ['neg', 'Losing as traded: even the high end of the range is below zero.']
    : ['muted', 'Not distinguishable from zero yet. Keep collecting before changing the system itself.'];
  const discipline = fol && brk && fol.n >= 5 && brk.n >= 3
    ? (fol.m > 0 && brk.m < fol.m ? 'Followed trades do better than broken ones: the rules work, keeping them is the job.' : fol.m <= 0 ? 'Even trades that followed the rules lose: the read or the rules need work, not only discipline.' : 'Broken-rule trades did as well as followed ones in this sample. Treat it as luck, not permission.')
    : 'Not enough followed and broken trades to compare yet.';

  return `
  <div class="cp-bar">
    <div class="filters">${seg('acct', [['all', 'All'], ['backtest', 'Backtest'], ['demo', 'Demo'], ['live', 'Live']], F.acct)}
      ${vs.length > 1 ? `<select class="sel" id="cp-ver" aria-label="Rule version">${vs.map(v => `<option value="${v.n}" ${v.n === ver ? 'selected' : ''}>Version ${v.n}${v.from ? ' · from ' + fmtDate(v.from) : ''}</option>`).join('')}</select>` : ''}</div>
    <p class="small muted">${plural(sess.length, 'session')} · ${plural(st.n, 'closed trade')} in version ${ver}${done ? ` · last checkpoint at ${plural(done.sessions, 'session')}` : ''}</p>
  </div>
  <section class="row">
    <article class="card">
      <h2 style="margin-bottom:6px">1 · Does the system make money?</h2>
      <div class="test-big mono ${cls(all && all.m)}">${all ? fmtR(all.m) : '—'}<span class="small muted"> per trade</span></div>
      <p class="small muted" style="margin:0 0 10px">Likely range: ${fmtRange(all, v => fmtR(v))} over ${all ? plural(all.n, 'trade') : '0 trades'}</p>
      <p class="status ${verdict[0]}">${verdict[1]}</p>
    </article>
    <article class="card">
      <h2 style="margin-bottom:12px">2 · System or discipline?</h2>
      <dl class="kv">
        <div><dt>Rules followed</dt><dd class="${cls(fol && fol.m)}">${fol ? fmtR(fol.m) + ' · ' + fol.n : '—'}</dd></div>
        <div><dt>Rules broken</dt><dd class="${cls(brk && brk.m)}">${brk ? fmtR(brk.m) + ' · ' + brk.n : '—'}</dd></div>
      </dl>
      <p class="status">${discipline}</p>
    </article>
  </section>
  <section class="row">
    <article class="card">
      <h2 style="margin-bottom:12px">3 · Which part of the read is weakest?</h2>
      <dl class="kv">${reads.map(([k, r]) => `<div><dt>${k} right</dt><dd class="${r && r.n >= 10 ? (r.p >= .5 ? 'pos' : 'neg') : ''}">${r ? fmtPct(r.p) : '—'} <span class="muted small">${r ? `${fmtPct(r.lo)}–${fmtPct(r.hi)} · ${r.n}` : ''}</span></dd></div>`).join('')}</dl>
      <p class="status">${weakest ? `Weakest: <b>${weakest[0].toLowerCase()}</b>. ${weakest[0] === 'Bias' ? 'Direction is the problem; profiles and entries can’t fix that.' : weakest[0] === 'Profile' ? 'Direction is fine more often than timing: the profile call is where days go wrong.' : 'Direction holds but targets are too far: aim at nearer draws.'}` : 'Each part needs 10 graded sessions before comparing.'}</p>
    </article>
    <article class="card">
      <h2 style="margin-bottom:12px">4 · What costs the most R?</h2>
      ${leaks.length ? `<ul class="plain">${leaks.map(g => `<li>${tag(g.label, 'bad')} <span class="mono neg">${fmtR(g.netR, 1)}</span> <span class="muted small">over ${plural(g.n, 'trade')}</span></li>`).join('')}</ul>` : '<p class="empty" style="margin:0">No mistake has cost R in this version.</p>'}
    </article>
  </section>
  <section class="row">
    <article class="card">
      <h2 style="margin-bottom:12px">5 · Where it works, where it doesn’t</h2>
      ${splits.length ? `<ul class="plain">${best.map(g => `<li><span class="pos">▲</span> ${esc(g.d)}: <b>${esc(g.label)}</b> <span class="mono pos">${fmtR(g.exp)}</span> <span class="muted small">per trade · ${g.n}</span></li>`).join('')}
        ${worst.map(g => `<li><span class="neg">▼</span> ${esc(g.d)}: <b>${esc(g.label)}</b> <span class="mono ${cls(g.exp)}">${fmtR(g.exp)}</span> <span class="muted small">per trade · ${g.n}</span></li>`).join('')}</ul>
        <p class="small muted" style="margin:10px 0 0">Hypotheses to check on the next batch, not conclusions.</p>` : '<p class="empty" style="margin:0">Groups need 10 trades each before they’re compared.</p>'}
    </article>
    <article class="card">
      <h2 style="margin-bottom:12px">6 · Failure signs and lessons</h2>
      ${signs.length ? `<ul class="plain">${signs.slice(-8).reverse().map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p class="empty" style="margin:0">Invalidations from the timelines and lessons from wrong days appear here.</p>'}
    </article>
  </section>
  <section class="row one">
    <article class="card">
      <h2 style="margin-bottom:12px">The one change</h2>
      <textarea id="cp-change" rows="2" placeholder="One rule to add, remove or change. Only one."></textarea>
      <div class="set-actions">
        <button type="button" class="btn primary" id="cp-rule" disabled>Start version ${Math.max(...vs.map(v => v.n)) + 1} from ${fmtDate(nextDay(today()))}</button>
        <button type="button" class="btn" id="cp-done">${done ? 'Mark reviewed again' : 'Mark this checkpoint as reviewed'}</button>
      </div>
      <p class="small muted" style="margin:10px 0 0">No change is a valid answer when the sample is still small.</p>
    </article>
  </section>`;
}
function bindCheckpoint() {
  $$('.cp-bar [data-seg="acct"] button').forEach(b => b.addEventListener('click', () => { F.acct = b.dataset.v; prefs.set('filters', F); route(); }));
  const vs = $('#cp-ver');
  if (vs) vs.addEventListener('change', () => { location.hash = '#review/checkpoint/' + vs.value; });
  const ta = $('#cp-change'), go = $('#cp-rule');
  ta.addEventListener('input', () => { go.disabled = !has(ta.value); });
  go.addEventListener('click', async () => { await addVersion(ta.value, nextDay(today())); toast(`Version ${currentVersion().n} starts ${fmtDate(nextDay(today()))}`); route(); });
  $('#cp-done').addEventListener('click', async () => {
    const v = versionOf(today());
    S.settings.checkpoints = { ...(S.settings.checkpoints || {}), [v]: { sessions: S.sessions.filter(s => versionOf(s.date) === v && !s.sample).length, at: today() } };
    await saveSettings(); toast('Checkpoint marked as reviewed'); route();
  });
}

// Dashboard banner: a checkpoint is due every 20 sessions of the current version
function checkpointDue() {
  const v = activeVersion(), n = S.sessions.filter(s => versionOf(s.date) === v && !s.sample).length;
  const last = ((S.settings.checkpoints || {})[v] || {}).sessions || 0;
  return n >= 20 && n - last >= 20 ? n : 0;
}
