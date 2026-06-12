/* PowerPrep — power engineering exam prep
   Vanilla JS single-page app. No dependencies. */
'use strict';

/* ===================== config ===================== */
const CONFIG = {
  examDate: '',
  passMark: 65,
  mockSize: 100,
  mockSeconds: 3 * 3600,
  sessionSize: 20,
  masteryStreak: 2,
  maxReviewRounds: 3,
  smartMinSeen: 30,                  // SMART Quiz needs this many seen questions before it has signal
  smartIntervalsH: [6, 24, 72, 168], // spaced-repetition due intervals (hours), indexed by streak
  smartUnitCap: 8,                   // max questions one unit can take in a SMART session
  // Replaced with the activated endpoint by build_app.py:
  syncEndpoint: 'https://formsubmit.co/ajax/1c50ce8374d1ea4751c9fe82de099407',
  syncEmail: 'nickhesson@gmail.com',
  storageKey: 'powerprep_v1',
  codeKey: 'powerprep_code',
};

/* Build-time branding (filled by app/build_app.py). */
const BRAND = {
  short: '4th Class · Part B',
  full: 'Fourth Class Power Engineering · Part B',
  tagline: 'Every knowledge exercise, as exam-style multiple choice.',
  itemNoun: 'knowledge-exercise questions',
};
const examLabel = () => {
  if (!CONFIG.examDate) return '';
  const dt = new Date(CONFIG.examDate + 'T08:00:00');
  return isNaN(dt) ? '' : dt.toLocaleDateString('en-CA', { month: 'long', day: 'numeric' });
};

const UNIT_ORDER = n => parseInt(String(n).replace(/\D/g, ''), 10) || 99;

/* ===================== tiny utils ===================== */
const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shuffle = (arr, rnd = Math.random) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const fmtTime = s => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? h + ':' : '') + String(m).padStart(h ? 2 : 1, '0') + ':' + String(x).padStart(2, '0'); };
const todayISO = () => new Date().toISOString().slice(0, 10);
const b64ToBytes = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));

function toast(msg, ms = 2600) {
  const el = document.createElement('div');
  el.className = 'toast'; el.textContent = msg;
  $('#toast-root').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, ms);
}

/* ===================== state ===================== */
const S = {
  bank: null,        // [{id, unit, unit_title, chapter, question, choices, correct_answer, explanation, ke_reference, ...}]
  byId: new Map(),
  units: [],         // [{unit, title, ids}]
  progress: null,
  view: 'unlock',
  session: null,     // active study session
  mock: null,        // active mock exam
  mockTicker: null,
};

function defaultProgress() {
  return {
    settings: { name: '', autoSync: true, theme: 'auto' },
    questions: {},   // id -> {a: attempts, c: correct, s: streak, last: 0|1, at: ts, g: guesses}
    sessions: [],    // {date, kind, unit, n, correct, secs}
    mocks: [],       // {date, score, n, correct, perUnit, secs}
    pendingSync: [], // payloads that failed to send
    lastSync: null,
    savedMock: null, // serialized in-progress mock
  };
}
function loadProgress() {
  try {
    const raw = localStorage.getItem(CONFIG.storageKey);
    if (raw) {
      const p = JSON.parse(raw);
      const d = defaultProgress();
      const merged = Object.assign(d, p);
      merged.settings = Object.assign(defaultProgress().settings, p.settings || {});
      if (typeof merged.questions !== 'object' || merged.questions === null) merged.questions = {};
      for (const k of ['sessions', 'mocks', 'pendingSync']) if (!Array.isArray(merged[k])) merged[k] = [];
      return merged;
    }
  } catch (e) {
    // keep the corrupted raw so it is recoverable, then start fresh
    try { localStorage.setItem(CONFIG.storageKey + '_corrupt', localStorage.getItem(CONFIG.storageKey) || ''); } catch (e2) { }
  }
  return defaultProgress();
}
let warnedStorage = false;
function save() {
  S.progress.rev = Date.now();
  try {
    mergeFromStorage();
    localStorage.setItem(CONFIG.storageKey, JSON.stringify(S.progress));
  } catch (e) {
    if (!warnedStorage) { warnedStorage = true; toast('⚠ Could not save progress — storage is full or blocked', 5000); }
  }
}
/* Another tab (or a restored frozen tab) may have written newer data: merge
   per-question by recency, union sessions/mocks, before we overwrite. */
function mergeFromStorage() {
  let stored;
  try { stored = JSON.parse(localStorage.getItem(CONFIG.storageKey) || 'null'); } catch (e) { return; }
  if (!stored || !stored.rev || stored.rev <= (S.lastSeenRev || 0)) { S.lastSeenRev = S.progress.rev; return; }
  for (const [id, st] of Object.entries(stored.questions || {})) {
    const mine = S.progress.questions[id];
    if (!mine || (st.at || 0) > (mine.at || 0)) S.progress.questions[id] = st;
  }
  const key = r => JSON.stringify(r);
  for (const k of ['sessions', 'mocks']) {
    const seen = new Set((S.progress[k] || []).map(key));
    for (const r of stored[k] || []) if (!seen.has(key(r))) S.progress[k].push(r);
  }
  if (!S.progress.savedMock && stored.savedMock) S.progress.savedMock = stored.savedMock;
  S.lastSeenRev = S.progress.rev;
}

/* ===================== crypto / bank loading ===================== */
async function decryptBank(code, payload) {
  const enc = new TextEncoder();
  const norm = code.trim().toUpperCase().replace(/\s+/g, '');
  const km = await crypto.subtle.importKey('raw', enc.encode(norm), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: b64ToBytes(payload.salt), iterations: 200000, hash: 'SHA-256' },
    km, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(payload.iv) }, key, b64ToBytes(payload.data));
  return JSON.parse(new TextDecoder().decode(plain));
}

async function fetchBankPayload() {
  let r;
  try { r = await fetch('bank.enc.json', { cache: 'no-store' }); }
  catch (e) { throw Object.assign(new Error('offline'), { network: true }); }
  if (r.ok) return { kind: 'enc', payload: await r.json() };
  if (['localhost', '127.0.0.1'].includes(location.hostname)) {
    const dev = await fetch('bank.json', { cache: 'no-store' });
    if (dev.ok) return { kind: 'plain', payload: await dev.json() };
  }
  throw new Error('Question bank not found');
}

function initBank(bank) {
  S.bank = bank;
  S.byId = new Map(bank.map(q => [q.id, q]));
  const m = new Map();
  for (const q of bank) {
    if (!m.has(q.unit)) m.set(q.unit, { unit: q.unit, title: q.unit_title, ids: [] });
    m.get(q.unit).ids.push(q.id);
  }
  S.units = [...m.values()].sort((a, b) => UNIT_ORDER(a.unit) - UNIT_ORDER(b.unit));
}

/* ===================== progress helpers ===================== */
/* Merge onto full defaults — records imported from older exports may lack newer fields (e.g. g) */
function qStat(id) { return Object.assign({ a: 0, c: 0, s: 0, last: null, at: 0, g: 0 }, S.progress.questions[id]); }
function recordAnswer(id, correct, guessed) {
  const st = S.progress.questions[id] || { a: 0, c: 0, s: 0, last: null, at: 0, g: 0 };
  st.a++; if (correct) { st.c++; st.s++; } else { st.s = 0; }
  if (guessed) st.g++;
  st.last = correct ? 1 : 0; st.at = Date.now();
  S.progress.questions[id] = st;
  save();
}
/* A question never missed counts as mastered after one correct answer.
   A question ever missed must be answered correctly twice in a row to clear. */
const isMastered = id => { const st = qStat(id); return st.a > st.c ? st.s >= CONFIG.masteryStreak : st.c >= 1; };
const isSeen = id => qStat(id).a > 0;
function reviewQueue() {
  return S.bank.filter(q => { const st = qStat(q.id); return st.a > st.c && st.s < CONFIG.masteryStreak; })
    .sort((a, b) => qStat(a.id).at - qStat(b.id).at).map(q => q.id);
}
function unitMastery(u) {
  const total = u.ids.length;
  const mastered = u.ids.filter(isMastered).length;
  const seen = u.ids.filter(isSeen).length;
  return { total, mastered, seen, pct: total ? Math.round(100 * mastered / total) : 0 };
}
function daysToExam() {
  const d = Math.ceil((new Date(CONFIG.examDate + 'T08:00:00') - new Date()) / 86400000);
  return d;
}

/* ===================== results sync ===================== */
function buildSyncPayload(kind, detail) {
  const name = S.progress.settings.name || 'Student';
  const total = S.bank.length;
  const mastered = S.bank.filter(q => isMastered(q.id)).length;
  const seen = S.bank.filter(q => isSeen(q.id)).length;
  return {
    _subject: `PowerPrep · ${name} · ${detail.title}`,
    _template: 'box',
    student: name,
    when: new Date().toLocaleString('en-CA'),
    report: detail.text,
    cumulative: `${mastered}/${total} mastered · ${seen}/${total} seen · review queue ${reviewQueue().length}`,
    data: JSON.stringify({ kind, detail: detail.data, ts: Date.now(), name }),
  };
}
async function sendPayload(payload) {
  let r;
  try {
    r = await fetch(CONFIG.syncEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true, // survives tab close mid-flight
    });
  } catch (e) { throw Object.assign(new Error('network'), { permanent: false }); }
  if (!r.ok) {
    const retriable = r.status >= 500 || r.status === 408 || r.status === 429;
    throw Object.assign(new Error('http ' + r.status), { permanent: !retriable });
  }
  const j = await r.json().catch(() => ({}));
  if (j.success === 'false' || j.success === false) throw Object.assign(new Error('rejected'), { permanent: true });
}
function queuePayload(kind, payload) {
  payload._kind = kind;
  if (kind === 'snapshot') S.progress.pendingSync = S.progress.pendingSync.filter(p => p._kind !== 'snapshot');
  S.progress.pendingSync.push(payload);
  S.progress.pendingSync = S.progress.pendingSync.slice(-20);
  save();
}
async function syncResults(kind, detail, { silent = false } = {}) {
  if (!CONFIG.syncEndpoint.startsWith('http')) return; // not configured (dev)
  const payload = buildSyncPayload(kind, detail);
  queuePayload(kind, payload); // queue-first: nothing is lost if the tab closes mid-flight
  try {
    await sendPayload(payload);
    const i = S.progress.pendingSync.indexOf(payload);
    if (i !== -1) S.progress.pendingSync.splice(i, 1);
    S.progress.lastSync = Date.now(); save();
    if (!silent) toast('Results sent to Nick ✓');
    flushPending();
  } catch (e) {
    if (e.permanent) {
      const i = S.progress.pendingSync.indexOf(payload);
      if (i !== -1) S.progress.pendingSync.splice(i, 1);
      save();
      if (!silent) toast('Could not send results — copy your results code from Settings instead');
    } else if (!silent) toast('Offline — results saved, will retry');
  }
}
let flushing = false;
async function flushPending() {
  if (flushing || !S.progress.pendingSync.length) return;
  flushing = true;
  try {
    for (const p of S.progress.pendingSync.slice()) {
      try {
        await sendPayload(p);
        const i = S.progress.pendingSync.indexOf(p);
        if (i !== -1) S.progress.pendingSync.splice(i, 1);
        S.progress.lastSync = Date.now(); save();
      } catch (e) {
        if (e.permanent) {
          const i = S.progress.pendingSync.indexOf(p);
          if (i !== -1) S.progress.pendingSync.splice(i, 1);
          save();
        }
        // retriable: keep it and stop — connectivity is probably down
        else break;
      }
    }
  } finally { flushing = false; }
}
function resultsBlob() {
  return btoa(unescape(encodeURIComponent(JSON.stringify({
    name: S.progress.settings.name, questions: S.progress.questions,
    sessions: S.progress.sessions, mocks: S.progress.mocks, ts: Date.now(),
  }))));
}
function restoreFromBlob(text) {
  const m = String(text).trim().match(/POWERPREP:([A-Za-z0-9+/=]+)/);
  if (!m) throw new Error('not a results code');
  const data = JSON.parse(decodeURIComponent(escape(atob(m[1]))));
  if (typeof data.questions !== 'object') throw new Error('bad payload');
  let merged = 0;
  for (const [id, st] of Object.entries(data.questions || {})) {
    const mine = S.progress.questions[id];
    if (!mine || (st.at || 0) > (mine.at || 0)) { S.progress.questions[id] = st; merged++; }
  }
  const key = r => JSON.stringify(r);
  for (const k of ['sessions', 'mocks']) {
    const seen = new Set((S.progress[k] || []).map(key));
    for (const r of data[k] || []) if (!seen.has(key(r))) S.progress[k].push(r);
  }
  if (data.name && !S.progress.settings.name) S.progress.settings.name = data.name;
  save();
  return merged;
}

/* ===================== study session engine ===================== */
function pickStudyIds(kind, unit) {
  let pool;
  if (kind === 'review') {
    pool = reviewQueue();
    return pool.slice(0, CONFIG.sessionSize);
  }
  if (kind === 'unit') pool = S.units.find(u => u.unit === unit).ids.slice();
  else pool = S.bank.map(q => q.id);
  // priority: unseen first, then unmastered (oldest first), then mastered (oldest first)
  const unseen = pool.filter(id => !isSeen(id));
  const unmastered = pool.filter(id => isSeen(id) && !isMastered(id)).sort((a, b) => qStat(a).at - qStat(b).at);
  const mastered = pool.filter(isMastered).sort((a, b) => qStat(a).at - qStat(b).at);
  return shuffle(unseen).concat(unmastered, mastered).slice(0, CONFIG.sessionSize);
}

function startSession(kind, unit = null) {
  const ids = pickStudyIds(kind, unit);
  if (!ids.length) { toast('Nothing to study here — all clear!'); return; }
  S.session = {
    kind, unit,
    queue: ids, idx: 0, round: 1,
    missedThisRound: [], results: [], // {id, correct, guessed, round}
    answered: null, // per-question UI state: {sel, correct, order}
    started: Date.now(),
  };
  setView('quiz');
}

/* ===================== SMART Quiz (adaptive engine) ===================== */
/* Deterministic weighted scoring over the student's own answer history —
   spaced-repetition dueness × error rate × unit weakness. No network calls. */
function needScore(id, now) {
  const st = qStat(id);
  const q = S.byId.get(id);
  if (!st.a) {
    // unseen: solid candidate in a weak unit; easier questions surface first
    return 0.6 + (5 - (q.difficulty || 3)) * 0.01;
  }
  const errRate = (st.a - st.c + 0.5) / (st.a + 1); // Laplace-smoothed miss rate
  const lastWrong = st.last === 0 ? 0.35 : 0;
  const guessRate = Math.min(1, (st.g || 0) / st.a) * 0.25;
  const hours = Math.max(0, now - st.at) / 3600000;
  const dueH = CONFIG.smartIntervalsH[Math.min(st.s, CONFIG.smartIntervalsH.length - 1)];
  const due = Math.min(1.5, hours / dueH); // 1 = exactly due for re-test
  let need = (errRate + lastWrong + guessRate) * (0.5 + 0.5 * due);
  const mastered = st.a > st.c ? st.s >= CONFIG.masteryStreak : st.c >= 1;
  if (mastered && hours < dueH) need *= 0.15; // mastered and not yet due — rest it
  return need;
}
function unitWeakness(u) {
  let a = 0, c = 0;
  for (const id of u.ids) { const st = qStat(id); a += st.a; c += st.c; }
  const acc = a ? c / a : 0.5; // no data → neutral
  const m = unitMastery(u);
  return 0.65 * (1 - acc) + 0.35 * (1 - (m.total ? m.mastered / m.total : 0));
}
function smartFocusUnits(k = 3) {
  return S.units.map(u => ({ unit: u.unit, w: unitWeakness(u) }))
    .sort((x, y) => y.w - x.w).slice(0, k).map(x => x.unit);
}
function smartReady() { return S.bank.filter(q => isSeen(q.id)).length >= CONFIG.smartMinSeen; }
function pickSmartIds() {
  const now = Date.now();
  const wByUnit = new Map(S.units.map(u => [u.unit, unitWeakness(u)]));
  const ranked = S.bank.map(q => ({
    id: q.id, unit: q.unit,
    // jitter keeps back-to-back sessions from being identical
    score: needScore(q.id, now) * (0.5 + wByUnit.get(q.unit)) * (0.9 + 0.2 * Math.random()),
  })).sort((x, y) => y.score - x.score);
  const ids = [], perUnit = {};
  for (const r of ranked) {
    if ((perUnit[r.unit] || 0) >= CONFIG.smartUnitCap) continue;
    ids.push(r.id); perUnit[r.unit] = (perUnit[r.unit] || 0) + 1;
    if (ids.length >= CONFIG.sessionSize) break;
  }
  return ids;
}
function startSmartSession() {
  if (!smartReady()) {
    if (confirm(`SMART Quiz unlocks once you've answered ${CONFIG.smartMinSeen}+ questions — it learns from your results. Start a mixed study session instead?`)) startSession('all');
    return;
  }
  const ids = pickSmartIds();
  if (!ids.length) { toast('Nothing to target — you’re all clear!'); return; }
  S.session = {
    kind: 'smart', unit: null,
    queue: ids, idx: 0, round: 1,
    missedThisRound: [], results: [],
    answered: null,
    started: Date.now(),
    focus: smartFocusUnits(),
  };
  setView('quiz');
}

function currentQ() { return S.byId.get(S.session.queue[S.session.idx]); }

function choiceOrder(q) {
  // stable shuffle per question per round so re-asks shuffle again
  const seedStr = q.id + ':' + S.session.round + ':' + S.session.started;
  let h = 2166136261;
  for (const ch of seedStr) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  const rnd = () => { h = Math.imul(h ^ (h >>> 15), 2246822519); h = Math.imul(h ^ (h >>> 13), 3266489917); return ((h ^= h >>> 16) >>> 0) / 4294967296; };
  return shuffle(['A', 'B', 'C', 'D'], rnd);
}

function answerCurrent(origKey) {
  const s = S.session; const q = currentQ();
  if (s.answered) return;
  const correct = origKey === q.correct_answer;
  s.answered = { sel: origKey, correct };
  s.results.push({ id: q.id, correct, guessed: false, round: s.round });
  recordAnswer(q.id, correct, false);
  if (!correct) s.missedThisRound.push(q.id);
  render();
}
function setGuessed(v) {
  const s = S.session; if (!s.answered) return;
  const last = s.results[s.results.length - 1];
  last.guessed = v;
  const st = qStat(last.id); st.g = Math.max(0, (st.g || 0) + (v ? 1 : -1)); S.progress.questions[last.id] = st; save();
}
function nextQuestion() {
  const s = S.session;
  if (!s || s.finishedRec || S.view !== 'quiz') return; // double-click / stale-handler guard
  s.answered = null;
  s.idx++;
  if (s.idx >= s.queue.length) {
    if (s.missedThisRound.length && s.round < CONFIG.maxReviewRounds) {
      s.queue = shuffle(s.missedThisRound); s.missedThisRound = [];
      s.idx = 0; s.round++;
      toast(`Round ${s.round}: re-asking the ${s.queue.length} you missed`);
    } else {
      finishSession(true); return;
    }
  }
  render();
}
function finishSession(completed = false) {
  const s = S.session;
  if (s.finishedRec) return;
  const secs = Math.round((Date.now() - s.started) / 1000);
  const firstRound = s.results.filter(r => r.round === 1);
  const rec = {
    date: todayISO(), kind: s.kind, unit: s.unit,
    n: firstRound.length, correct: firstRound.filter(r => r.correct).length,
    cleared: completed && s.missedThisRound.length === 0, secs,
  };
  S.progress.sessions.push(rec);
  S.progress.savedSession = null; save();
  const missedIds = [...new Set(s.results.filter(r => !r.correct).map(r => r.id))];
  const title = `${s.kind === 'review' ? 'Review session' : s.kind === 'unit' ? 'Study ' + s.unit : s.kind === 'smart' ? 'SMART Quiz' : 'Mixed study'} — ${rec.correct}/${rec.n}`;
  const lines = [
    `${title} (${fmtTime(secs)})`,
    missedIds.length ? `Missed: ${missedIds.join(', ')}` : 'No misses — cleared the session.',
    s.round > 1 ? `Needed ${s.round} rounds to clear missed questions.` : '',
  ].filter(Boolean).join('\n');
  if (S.progress.settings.autoSync) syncResults('session', { title, text: lines, data: { rec, results: s.results } }, { silent: true });
  s.finishedRec = rec; s.missedIds = missedIds;
  setView('summary');
}

/* ===================== mock exam engine ===================== */
function mockQuotas() {
  const total = S.bank.length;
  const raw = S.units.map(u => ({ unit: u.unit, exact: u.ids.length / total * CONFIG.mockSize }));
  const quotas = raw.map(r => ({ unit: r.unit, q: Math.max(4, Math.floor(r.exact)), frac: r.exact - Math.floor(r.exact) }));
  let sum = quotas.reduce((s, x) => s + x.q, 0);
  const order = quotas.slice().sort((a, b) => b.frac - a.frac);
  let i = 0;
  while (sum < CONFIG.mockSize) { order[i % order.length].q++; sum++; i++; }
  while (sum > CONFIG.mockSize) { const c = order.slice().reverse().find(x => x.q > 4); c.q--; sum--; }
  return Object.fromEntries(quotas.map(x => [x.unit, x.q]));
}
function startMock() {
  const quotas = mockQuotas();
  const qs = [];
  for (const u of S.units) {
    // least-recently-seen first so retakes get fresh questions
    const sorted = shuffle(u.ids).sort((a, b) => qStat(a).at - qStat(b).at);
    qs.push(...sorted.slice(0, quotas[u.unit]));
  }
  S.mock = {
    qs: shuffle(qs), answers: {}, flags: {}, idx: 0,
    started: Date.now(), deadline: Date.now() + CONFIG.mockSeconds * 1000,
    submitted: false, orders: {},
  };
  persistMock();
  setView('mock');
  startTicker();
}
function persistMock() {
  const m = S.mock;
  S.progress.savedMock = m && !m.submitted ? { qs: m.qs, answers: m.answers, flags: m.flags, idx: m.idx, started: m.started, deadline: m.deadline } : null;
  save();
}
function resumeMock() {
  const sm = S.progress.savedMock;
  if (!sm) return;
  if (!Array.isArray(sm.qs) || sm.qs.some(id => !S.byId.has(id))) {
    // question bank was updated since this mock started — it can't resume
    S.progress.savedMock = null; save();
    toast('That exam used an older question set — start a fresh mock');
    setView('home'); return;
  }
  S.mock = Object.assign({ submitted: false, orders: {} }, sm);
  if (S.mock.deadline <= Date.now()) {
    toast('Time expired while you were away — exam submitted');
    setView('mock'); submitMock(); return;
  }
  setView('mock');
  startTicker();
}
function startTicker() {
  clearInterval(S.mockTicker);
  S.mockTicker = setInterval(() => {
    if (!S.mock || S.mock.submitted) { clearInterval(S.mockTicker); return; }
    const left = (S.mock.deadline - Date.now()) / 1000;
    const el = $('#mock-timer');
    if (el) { el.textContent = fmtTime(left); el.classList.toggle('low', left < 600); }
    if (left <= 0) { toast('Time is up — exam submitted'); submitMock(); }
  }, 500);
}
function mockOrder(q) {
  const m = S.mock;
  if (!m.orders[q.id]) {
    let h = 0; for (const c of (q.id + m.started)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    const rnd = () => { h = (h * 1664525 + 1013904223) >>> 0; return h / 4294967296; };
    m.orders[q.id] = shuffle(['A', 'B', 'C', 'D'], rnd);
  }
  return m.orders[q.id];
}
function submitMock() {
  const m = S.mock; if (!m || m.submitted) return;
  clearInterval(S.mockTicker);
  m.submitted = true;
  const secs = Math.round((Date.now() - m.started) / 1000);
  let correct = 0;
  const perUnit = {};
  const missed = [];
  for (const id of m.qs) {
    const q = S.byId.get(id);
    const sel = m.answers[id] || null;
    const ok = sel === q.correct_answer;
    if (ok) correct++; else missed.push(id);
    const pu = perUnit[q.unit] || (perUnit[q.unit] = { n: 0, c: 0 });
    pu.n++; if (ok) pu.c++;
    recordAnswer(id, ok, false); // misses flow into the review queue
  }
  const score = Math.round(100 * correct / m.qs.length);
  const rec = { date: todayISO(), score, n: m.qs.length, correct, perUnit, secs: Math.min(secs, CONFIG.mockSeconds) };
  S.progress.mocks.push(rec);
  S.progress.savedMock = null; save();
  m.rec = rec; m.missed = missed;
  const unitLines = S.units.filter(u => perUnit[u.unit]).map(u => `${u.unit}: ${perUnit[u.unit].c}/${perUnit[u.unit].n}`).join(' · ');
  const title = `Mock exam — ${score}% (${correct}/${m.qs.length})`;
  const text = [
    `${title} in ${fmtTime(rec.secs)} — ${score >= CONFIG.passMark ? 'PASS' : 'BELOW PASS MARK'} (need ${CONFIG.passMark}%)`,
    unitLines,
    missed.length ? `Missed: ${missed.join(', ')}` : 'Perfect score!',
  ].join('\n');
  if (S.progress.settings.autoSync) syncResults('mock', { title, text, data: { rec, answers: m.answers, missed } }, { silent: true });
  setView('mockResults');
}

/* ===================== views ===================== */
function setView(v, arg = null) {
  S.view = v; S.viewArg = arg;
  window.scrollTo({ top: 0 });
  render();
}

const ICONS = {
  bolt: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13 2 4.5 14H11l-1.5 8L18 10h-6.5L13 2z"/></svg>',
  book: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
  redo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 2.6-6.4"/><path d="M3 4v5h5"/></svg>',
  exam: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>',
  chev: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>',
  flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  target: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/></svg>',
};

function topbar({ showNav = true } = {}) {
  const d = daysToExam();
  const dd = d >= 0 ? `${d} day${d === 1 ? '' : 's'} to exam` : 'Exam date passed';
  return `<header class="topbar">
    <div class="brand"><span class="logo">${ICONS.bolt}</span><span>PowerPrep<small>${BRAND.short}</small></span></div>
    <div class="spacer"></div>
    ${showNav ? `${CONFIG.examDate ? `<span class="countdown-chip">${dd}</span>` : ''}
    <button class="icon-btn" data-act="settings" aria-label="Settings">${ICONS.gear}</button>` : ''}
  </header>`;
}

/* ---------- unlock ---------- */
function viewUnlock(err = '', busy = false) {
  return `${topbar({ showNav: false })}
  <div class="unlock-wrap"><div class="card unlock">
    <div class="logo-lg">${ICONS.bolt}</div>
    <h1>PowerPrep</h1>
    <p class="sub">${BRAND.full}<br>${BRAND.tagline}</p>
    <form id="unlock-form">
      <input id="code-input" type="text" inputmode="text" autocomplete="off" autocapitalize="characters"
        placeholder="ACCESS CODE" aria-label="Access code" ${busy ? 'disabled' : ''}>
      <button class="btn primary lg block" type="submit" ${busy ? 'disabled' : ''}>${busy ? 'Unlocking…' : 'Unlock'}</button>
      <div class="err">${esc(err)}</div>
    </form>
  </div></div>`;
}

/* ---------- name prompt ---------- */
function viewName() {
  return `${topbar({ showNav: false })}
  <div class="unlock-wrap"><div class="card unlock">
    <div class="logo-lg">${ICONS.bolt}</div>
    <h1>Welcome!</h1>
    <p class="sub">What's your name? It's attached to your practice results so Nick can follow your progress.</p>
    <form id="name-form">
      <input id="name-input" type="text" autocomplete="given-name" placeholder="Your name" aria-label="Your name" style="font-family:var(--font);letter-spacing:0">
      <button class="btn primary lg block" type="submit">Start studying</button>
    </form>
  </div></div>`;
}

/* ---------- home ---------- */
function viewHome() {
  const total = S.bank.length;
  const mastered = S.bank.filter(q => isMastered(q.id)).length;
  const seen = S.bank.filter(q => isSeen(q.id)).length;
  const queue = reviewQueue();
  const pct = total ? mastered / total : 0;
  const r = 52, circ = 2 * Math.PI * r;
  const lastMock = S.progress.mocks[S.progress.mocks.length - 1];
  const name = S.progress.settings.name;
  const sync = S.progress.pendingSync.length ? `<span class="sync-chip fail"><span class="dot"></span>${S.progress.pendingSync.length} result(s) waiting to send</span>`
    : S.progress.lastSync ? `<span class="sync-chip ok"><span class="dot"></span>Results synced</span>` : '';
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  const installTip = isIOS && !standalone && !S.progress.settings.installTipDismissed
    ? `<section class="card install-tip"><b>📲 Add to Home Screen</b>
       <p class="small muted mt" style="margin-top:6px">Tap the Share button, then “Add to Home Screen.” This keeps your progress safe — Safari can delete website data after 7 days of non-use, but installed apps are protected.</p>
       <button class="btn ghost" data-act="dismissInstallTip" style="margin-top:8px">Got it</button></section>` : '';

  const unitRows = S.units.map(u => {
    const m = unitMastery(u);
    return `<button class="unit-row" data-act="unit" data-unit="${u.unit}">
      <span class="unit-no">${u.unit}</span>
      <span class="unit-meta"><b>${esc(u.title)}</b>
        <span class="bar"><i style="width:${m.pct}%"></i></span></span>
      <span class="unit-pct">${m.mastered}/${m.total}</span>
      <span class="chev">${ICONS.chev}</span>
    </button>`;
  }).join('');

  return `${topbar()}
  ${installTip}
  <section class="card hero">
    <div class="ring-wrap">
      <svg width="120" height="120" viewBox="0 0 120 120" aria-hidden="true">
        <circle class="ring-bg" cx="60" cy="60" r="${r}" fill="none" stroke-width="11"/>
        <circle class="ring-val" cx="60" cy="60" r="${r}" fill="none" stroke-width="11"
          stroke-dasharray="${circ}" stroke-dashoffset="${circ * (1 - pct)}"/>
      </svg>
      <div class="ring-center"><div><b>${Math.round(pct * 100)}%</b><span>mastered</span></div></div>
    </div>
    <div class="hero-body">
      <h2>${name ? `Keep going, ${esc(name)}.` : 'Welcome back.'}</h2>
      <p class="muted">Master all ${total} ${BRAND.itemNoun}${CONFIG.examDate ? ' before ' + examLabel() : ''}. Miss one and it comes back until you beat it ${CONFIG.masteryStreak} times in a row.</p>
      <div class="hero-stats">
        <div class="stat"><b>${mastered}</b><span>mastered</span></div>
        <div class="stat"><b>${seen}</b><span>seen</span></div>
        <div class="stat"><b>${queue.length}</b><span>to review</span></div>
        <div class="stat"><b>${lastMock ? lastMock.score + '%' : '—'}</b><span>last mock</span></div>
      </div>
      ${sync ? `<div class="mt">${sync}</div>` : ''}
    </div>
  </section>

  <div class="section-title">Practice</div>
  <button class="action-card mb" data-act="smartQuiz">
    <span class="ic purple">${ICONS.target}</span>
    <span class="ac-body"><b>SMART Quiz</b><span>${smartReady()
      ? 'Built from your results — targets ' + esc(smartFocusUnits().join(' · '))
      : 'Learns your weak spots — adapts after ' + CONFIG.smartMinSeen + ' answered questions'}</span></span>
    <span class="chev">${ICONS.chev}</span>
  </button>
  <div class="grid-2">
    <button class="action-card" data-act="review" ${queue.length ? '' : 'disabled'}>
      <span class="ic red">${ICONS.redo}</span>
      <span class="ac-body"><b>Review missed questions</b><span>Questions you got wrong come back until you beat them</span></span>
      ${queue.length ? `<span class="badge">${queue.length}</span>` : ''}
      <span class="chev">${ICONS.chev}</span>
    </button>
    <button class="action-card" data-act="smart">
      <span class="ic blue">${ICONS.book}</span>
      <span class="ac-body"><b>Smart study</b><span>${seen < total ? 'Prioritizes questions you haven’t seen yet' : 'Mixed review across all units'}</span></span>
      <span class="chev">${ICONS.chev}</span>
    </button>
  </div>
  <div class="grid-2 mt">
    ${S.progress.savedMock ? `<button class="action-card" data-act="resumeMock">
      <span class="ic amber">${ICONS.exam}</span>
      <span class="ac-body"><b>Resume mock exam</b><span>You have an exam in progress</span></span>
      <span class="chev">${ICONS.chev}</span></button>`
      : `<button class="action-card" data-act="mock">
      <span class="ic amber">${ICONS.exam}</span>
      <span class="ac-body"><b>Mock exam</b><span>${CONFIG.mockSize} questions · 3 hours · real SOPEEC format</span></span>
      <span class="chev">${ICONS.chev}</span></button>`}
    <button class="action-card" data-act="history">
      <span class="ic green">${ICONS.check}</span>
      <span class="ac-body"><b>My results</b><span>${S.progress.mocks.length} mock${S.progress.mocks.length === 1 ? '' : 's'} · ${S.progress.sessions.length} study session${S.progress.sessions.length === 1 ? '' : 's'}</span></span>
      <span class="chev">${ICONS.chev}</span>
    </button>
  </div>

  <div class="section-title">Units</div>
  ${unitRows}`;
}

/* ---------- quiz (study session) ---------- */
function viewQuiz() {
  const s = S.session; const q = currentQ();
  const order = choiceOrder(q);
  const dispKeys = ['A', 'B', 'C', 'D'];
  const a = s.answered;
  const choices = order.map((orig, i) => {
    let cls = 'choice';
    if (a) {
      if (orig === q.correct_answer) cls += ' correct';
      else if (orig === a.sel) cls += ' wrong';
      else cls += ' dim';
    }
    return `<button class="${cls}" data-choice="${orig}" ${a ? 'disabled' : ''}>
      <span class="key">${dispKeys[i]}</span><span>${esc(q.choices[orig])}</span>
    </button>`;
  }).join('');

  const fb = a ? `<div class="feedback ${a.correct ? 'good' : 'bad'}" role="status">
      <div class="fb-head">${a.correct ? '✓ Correct' : '✗ Not quite'}</div>
      <div class="fb-exp">${esc(q.explanation)}</div>
      <div class="fb-ref">${esc(q.unit)} · ${esc(q.chapter)} · KE ${esc(q.ke_reference)}</div>
      <label class="guess-toggle"><input type="checkbox" id="guess-cb"> I guessed on this one</label>
    </div>` : '';

  const kindLabel = s.kind === 'review' ? 'Review' : s.kind === 'unit' ? s.unit + ' study' : s.kind === 'smart' ? 'SMART Quiz' : 'Mixed study';
  const focusPill = s.kind === 'smart' && s.focus && s.focus.length ? `<span class="pill">Focus: ${esc(s.focus.join(' · '))}</span>` : '';
  return `${topbar()}
  <div class="quiz-top">
    <button class="icon-btn" data-act="quitQuiz" aria-label="End session">${ICONS.back}</button>
    <div class="q-progress"><i style="width:${(s.idx) / s.queue.length * 100}%"></i></div>
    <span class="q-count">${s.idx + 1}/${s.queue.length}</span>
  </div>
  <section class="card">
    <div class="q-tagline">
      <span class="pill">${esc(kindLabel)}</span>
      ${focusPill}
      ${s.round > 1 ? `<span class="pill review">Round ${s.round} — beat your misses</span>` : ''}
      <span class="pill">${esc(q.unit)}</span>
    </div>
    <div class="q-stem">${esc(q.question)}</div>
    <div class="choices">${choices}</div>
    ${fb}
    <div class="quiz-actions">
      ${a ? `<button class="btn primary lg" data-act="next">${s.idx + 1 >= s.queue.length && !s.missedThisRound.length ? 'Finish' : 'Next question'} →</button>` : ''}
    </div>
  </section>
  <p class="center small muted mt">Tip: press 1–4 to answer, Enter for next</p>`;
}

/* ---------- session summary ---------- */
function viewSummary() {
  const s = S.session; const rec = s.finishedRec;
  const pct = rec.n ? Math.round(100 * rec.correct / rec.n) : 0;
  const cls = pct >= 80 ? 'score-good' : pct >= CONFIG.passMark ? 'score-warn' : 'score-bad';
  const queue = reviewQueue();
  return `${topbar()}
  <section class="card summary-hero">
    <div class="big ${cls}">${rec.correct}/${rec.n}</div>
    <div class="lbl">${pct}% on first attempt${s.round > 1 ? ` · cleared misses in ${s.round} rounds` : ''}</div>
    <div class="sum-grid">
      <div class="cell"><b>${fmtTime(rec.secs)}</b><span>time</span></div>
      <div class="cell"><b>${s.missedIds.length}</b><span>missed</span></div>
      <div class="cell"><b>${queue.length}</b><span>in review queue</span></div>
    </div>
    <div class="quiz-actions mt-lg">
      ${queue.length ? `<button class="btn lg" data-act="review">Review missed</button>` : ''}
      <button class="btn primary lg" data-act="home">Done</button>
    </div>
  </section>`;
}

/* ---------- mock exam ---------- */
function viewMock() {
  const m = S.mock;
  const q = S.byId.get(m.qs[m.idx]);
  const order = mockOrder(q);
  const dispKeys = ['A', 'B', 'C', 'D'];
  const sel = m.answers[q.id];
  const choices = order.map((orig, i) =>
    `<button class="choice ${sel === orig ? 'selected' : ''}" data-mchoice="${orig}">
      <span class="key">${dispKeys[i]}</span><span>${esc(q.choices[orig])}</span>
    </button>`).join('');
  const answered = Object.keys(m.answers).length;
  const grid = m.qs.map((id, i) => {
    let cls = 'nav-cell';
    const states = [];
    if (m.answers[id]) { cls += ' answered'; states.push('answered'); }
    if (m.flags[id]) { cls += ' flagged'; states.push('flagged'); }
    if (i === m.idx) { cls += ' current'; states.push('current'); }
    return `<button class="${cls}" data-goto="${i}" aria-label="Question ${i + 1}${states.length ? ', ' + states.join(', ') : ''}">${i + 1}</button>`;
  }).join('');
  return `<div class="mock-bar mock-bar-top">
    <span class="mock-timer" id="mock-timer">${fmtTime((m.deadline - Date.now()) / 1000)}</span>
    <div class="spacer" style="flex:1"></div>
    <span class="small muted">${answered}/${m.qs.length} answered</span>
    <button class="btn" data-act="submitMockAsk">Submit</button>
  </div>
  <section class="card">
    <div class="q-tagline"><span class="pill">Question ${m.idx + 1} of ${m.qs.length}</span><span class="pill">${esc(q.unit)}</span></div>
    <div class="q-stem">${esc(q.question)}</div>
    <div class="choices">${choices}</div>
    <div class="quiz-actions">
      <button class="btn" data-act="mockPrev" ${m.idx === 0 ? 'disabled' : ''}>← Previous</button>
      <button class="btn ${m.flags[q.id] ? 'primary' : ''}" data-act="mockFlag">${ICONS.flag} ${m.flags[q.id] ? 'Flagged' : 'Flag'}</button>
      <button class="btn primary" data-act="mockNext" ${m.idx === m.qs.length - 1 ? 'disabled' : ''}>Next →</button>
    </div>
  </section>
  <div class="section-title">Navigator</div>
  <section class="card"><div class="nav-grid">${grid}</div></section>`;
}

function viewMockResults() {
  const m = S.mock; const rec = m.rec;
  const pass = rec.score >= CONFIG.passMark;
  const rows = S.units.filter(u => rec.perUnit[u.unit]).map(u => {
    const pu = rec.perUnit[u.unit];
    const p = Math.round(100 * pu.c / pu.n);
    const col = p >= 80 ? 'var(--good)' : p >= CONFIG.passMark ? 'var(--warn)' : 'var(--bad)';
    return `<tr><td><b>${u.unit}</b></td><td>${esc(u.title)}</td>
      <td style="white-space:nowrap">${pu.c}/${pu.n}</td>
      <td><div class="mini-bar"><i style="width:${p}%;background:${col}"></i></div></td></tr>`;
  }).join('');
  const grid = m.qs.map((id, i) => {
    const q = S.byId.get(id);
    const ok = m.answers[id] === q.correct_answer;
    return `<button class="nav-cell ${ok ? 'right' : 'missed'}" data-reviewq="${i}">${i + 1}</button>`;
  }).join('');
  return `${topbar()}
  <section class="card summary-hero">
    <div class="big ${pass ? 'score-good' : 'score-bad'}">${rec.score}%</div>
    <div class="lbl">${pass ? 'PASS' : 'Below pass mark'} — ${rec.correct}/${rec.n} correct · pass mark ${CONFIG.passMark}%</div>
    <div class="sum-grid">
      <div class="cell"><b>${fmtTime(rec.secs)}</b><span>time used</span></div>
      <div class="cell"><b>${m.missed.length}</b><span>missed</span></div>
      <div class="cell"><b>${reviewQueue().length}</b><span>in review queue</span></div>
    </div>
    <div class="quiz-actions mt-lg">
      <button class="btn lg" data-act="review" ${m.missed.length || reviewQueue().length ? '' : 'disabled'}>Review missed</button>
      <button class="btn primary lg" data-act="home">Done</button>
    </div>
  </section>
  <div class="section-title">By unit</div>
  <section class="card"><table class="unit-table">
    <tr><th>Unit</th><th></th><th>Score</th><th style="width:30%"></th></tr>${rows}
  </table></section>
  <div class="section-title">Questions — tap any to review</div>
  <section class="card"><div class="nav-grid">${grid}</div></section>`;
}

function viewMockReviewQ() {
  const m = S.mock;
  const i = S.viewArg;
  const q = S.byId.get(m.qs[i]);
  const sel = m.answers[q.id] || null;
  const order = mockOrder(q);
  const dispKeys = ['A', 'B', 'C', 'D'];
  const choices = order.map((orig, k) => {
    let cls = 'choice';
    if (orig === q.correct_answer) cls += ' correct';
    else if (orig === sel) cls += ' wrong';
    else cls += ' dim';
    return `<button class="${cls}" disabled><span class="key">${dispKeys[k]}</span><span>${esc(q.choices[orig])}</span></button>`;
  }).join('');
  return `${topbar()}
  <div class="back-row"><button class="icon-btn" data-act="backToMockResults" aria-label="Back">${ICONS.back}</button>
  <h2>Question ${i + 1} ${sel === q.correct_answer ? '· correct ✓' : sel ? '· missed' : '· unanswered'}</h2></div>
  <section class="card">
    <div class="q-tagline"><span class="pill">${esc(q.unit)}</span><span class="pill">${esc(q.chapter)}</span></div>
    <div class="q-stem">${esc(q.question)}</div>
    <div class="choices">${choices}</div>
    <div class="feedback ${sel === q.correct_answer ? 'good' : 'bad'}">
      <div class="fb-exp">${esc(q.explanation)}</div>
      <div class="fb-ref">KE ${esc(q.ke_reference)}</div>
    </div>
  </section>`;
}

/* ---------- unit detail ---------- */
function viewUnit() {
  const u = S.units.find(x => x.unit === S.viewArg);
  const m = unitMastery(u);
  const chapters = {};
  for (const id of u.ids) {
    const q = S.byId.get(id);
    (chapters[q.chapter] || (chapters[q.chapter] = [])).push(id);
  }
  const chRows = Object.entries(chapters).map(([ch, ids]) => {
    const done = ids.filter(isMastered).length;
    return `<div class="switch-row"><div class="sw-label"><b>${esc(ch)}</b><span>${done}/${ids.length} mastered</span></div></div>`;
  }).join('');
  return `${topbar()}
  <div class="back-row"><button class="icon-btn" data-act="home" aria-label="Back">${ICONS.back}</button>
  <h2>${u.unit} — ${esc(u.title)}</h2></div>
  <section class="card">
    <div class="hero-stats" style="margin-top:0">
      <div class="stat"><b>${m.total}</b><span>questions</span></div>
      <div class="stat"><b>${m.seen}</b><span>seen</span></div>
      <div class="stat"><b>${m.mastered}</b><span>mastered</span></div>
    </div>
    <div class="quiz-actions mt-lg">
      <button class="btn primary lg block" data-act="studyUnit" data-unit="${u.unit}">Study ${u.unit} (${Math.min(CONFIG.sessionSize, m.total)} questions)</button>
    </div>
  </section>
  <div class="section-title">Chapters</div>
  <section class="card">${chRows}</section>`;
}

/* ---------- history ---------- */
function viewHistory() {
  const mocks = S.progress.mocks.slice().reverse();
  const sessions = S.progress.sessions.slice(-25).reverse();
  const mockRows = mocks.length ? mocks.map(r =>
    `<tr><td>${r.date}</td><td><b class="${r.score >= CONFIG.passMark ? 'score-good' : 'score-bad'}">${r.score}%</b></td><td>${r.correct}/${r.n}</td><td>${fmtTime(r.secs)}</td></tr>`).join('')
    : '<tr><td colspan="4" class="muted">No mock exams yet</td></tr>';
  const kindNames = { all: 'Mixed study', review: 'Review', smart: 'SMART Quiz' };
  const sesRows = sessions.length ? sessions.map(r =>
    `<tr><td>${r.date}</td><td>${esc(r.kind === 'unit' ? r.unit : (kindNames[r.kind] || r.kind))}</td><td>${r.correct}/${r.n}</td><td>${r.cleared ? '✓ cleared' : '—'}</td></tr>`).join('')
    : '<tr><td colspan="4" class="muted">No sessions yet</td></tr>';
  return `${topbar()}
  <div class="back-row"><button class="icon-btn" data-act="home" aria-label="Back">${ICONS.back}</button><h2>My results</h2></div>
  <div class="section-title">Mock exams</div>
  <section class="card"><table class="unit-table"><tr><th>Date</th><th>Score</th><th>Correct</th><th>Time</th></tr>${mockRows}</table></section>
  <div class="section-title">Study sessions</div>
  <section class="card"><table class="unit-table"><tr><th>Date</th><th>Type</th><th>First-try</th><th>Misses cleared</th></tr>${sesRows}</table></section>`;
}

/* ---------- settings ---------- */
function viewSettings() {
  const p = S.progress.settings;
  return `${topbar({ showNav: false })}
  <div class="back-row"><button class="icon-btn" data-act="home" aria-label="Back">${ICONS.back}</button><h2>Settings</h2></div>
  <section class="card">
    <div class="field"><label for="set-name">Your name (shown on results)</label>
      <input type="text" id="set-name" value="${esc(p.name)}"></div>
    <div class="field"><label for="set-theme">Appearance</label>
      <select id="set-theme">
        <option value="auto" ${p.theme === 'auto' ? 'selected' : ''}>Match device</option>
        <option value="light" ${p.theme === 'light' ? 'selected' : ''}>Light</option>
        <option value="dark" ${p.theme === 'dark' ? 'selected' : ''}>Dark</option>
      </select></div>
    <div class="switch-row">
      <div class="sw-label"><b>Auto-send results to Nick</b><span>Sends a summary after each session and mock exam</span></div>
      <label class="switch"><input type="checkbox" id="set-sync" ${p.autoSync ? 'checked' : ''}><i></i></label>
    </div>
  </section>
  <div class="section-title">Message Nick</div>
  <section class="card">
    <div class="field"><label for="fb-text">Feedback, confusing questions, anything</label>
      <textarea id="fb-text" rows="3" style="width:100%;padding:11px 13px;border-radius:10px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);font:inherit"></textarea></div>
    <button class="btn primary" data-act="sendFeedback">Send message</button>
  </section>
  <div class="section-title">Data</div>
  <section class="card">
    <div class="switch-row"><div class="sw-label"><b>Send my full results now</b><span>${S.progress.lastSync ? 'Last sent ' + new Date(S.progress.lastSync).toLocaleString('en-CA') : 'Never sent yet'}</span></div>
      <button class="btn" data-act="syncNow">Send</button></div>
    <div class="switch-row"><div class="sw-label"><b>Copy results code</b><span>Backup you can paste into a text message</span></div>
      <button class="btn" data-act="copyBlob">Copy</button></div>
    <div class="switch-row"><div class="sw-label" style="flex:1"><b>Restore from results code</b><span>Paste a code that starts with POWERPREP:</span>
      <input type="text" id="restore-input" placeholder="POWERPREP:…" style="width:100%;margin-top:8px;padding:10px 12px;border-radius:10px;border:1px solid var(--border);background:var(--surface-2);color:var(--text);font-size:16px;font-family:var(--mono)"></div>
      <button class="btn" data-act="restoreBlob">Restore</button></div>
    <div class="switch-row"><div class="sw-label"><b>Reset all progress</b><span>Cannot be undone</span></div>
      <button class="btn danger" data-act="resetAll">Reset</button></div>
  </section>
  <p class="center small muted mt">PowerPrep · ${S.bank ? S.bank.length : 0} questions${CONFIG.examDate ? ' · ' + examLabel() + ' exam' : ''}</p>`;
}

/* ===================== render + events ===================== */
function applyTheme() {
  const t = S.progress ? S.progress.settings.theme : 'auto';
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
}

function render() {
  applyTheme();
  const views = {
    unlock: viewUnlock, name: viewName, home: viewHome, quiz: viewQuiz, summary: viewSummary,
    mock: viewMock, mockResults: viewMockResults, mockReviewQ: viewMockReviewQ,
    unit: viewUnit, history: viewHistory, settings: viewSettings,
  };
  $('#app').innerHTML = views[S.view]();
  if (S.view === 'unlock') {
    const f = $('#unlock-form');
    if (f) f.addEventListener('submit', onUnlockSubmit);
    const inp = $('#code-input'); if (inp) inp.focus();
  }
  if (S.view === 'name') {
    $('#name-form').addEventListener('submit', e => {
      e.preventDefault();
      const v = $('#name-input').value.trim();
      S.progress.settings.name = v || 'Student';
      save(); setView('home');
    });
    $('#name-input').focus();
  }
  if (S.view === 'settings') {
    $('#set-name').addEventListener('change', e => { S.progress.settings.name = e.target.value.trim(); save(); });
    $('#set-theme').addEventListener('change', e => { S.progress.settings.theme = e.target.value; save(); applyTheme(); });
    $('#set-sync').addEventListener('change', e => { S.progress.settings.autoSync = e.target.checked; save(); });
  }
  if (S.view === 'quiz') {
    const cb = $('#guess-cb');
    if (cb) cb.addEventListener('change', e => setGuessed(e.target.checked));
    // keep keyboard/screen-reader flow intact across the innerHTML re-render
    const next = $('[data-act="next"]');
    if (next) next.focus();
  }
}

async function onUnlockSubmit(e) {
  e.preventDefault();
  const code = $('#code-input').value;
  if (!code.trim()) return;
  $('#app').innerHTML = viewUnlock('', true);
  try {
    const { kind, payload } = await fetchBankPayload();
    const bank = kind === 'enc' ? await decryptBank(code, payload) : payload;
    try { localStorage.setItem(CONFIG.codeKey, code.trim()); } catch (e) { /* private mode — still usable this session */ }
    initBank(bank);
    afterUnlock();
  } catch (err) {
    const msg = err && err.network
      ? 'Couldn’t reach the question bank — check your internet connection and try again.'
      : 'That code didn’t work — double-check it and try again.';
    $('#app').innerHTML = viewUnlock(msg);
    $('#unlock-form').addEventListener('submit', onUnlockSubmit);
    $('#code-input').focus();
  }
}

function afterUnlock() {
  flushPending();
  if (!S.progress.settings.name) setView('name');
  else setView('home');
}

document.addEventListener('click', e => {
  const t = e.target.closest('[data-act],[data-choice],[data-mchoice],[data-goto],[data-reviewq],[data-unit].unit-row');
  if (!t) return;
  if (t.dataset.choice && S.view === 'quiz') { answerCurrent(t.dataset.choice); return; }
  if (t.dataset.mchoice && S.view === 'mock') {
    const m = S.mock; const q = S.byId.get(m.qs[m.idx]);
    m.answers[q.id] = m.answers[q.id] === t.dataset.mchoice ? undefined : t.dataset.mchoice;
    if (!m.answers[q.id]) delete m.answers[q.id];
    persistMock(); render(); return;
  }
  if (t.dataset.goto !== undefined && S.view === 'mock') { S.mock.idx = +t.dataset.goto; persistMock(); window.scrollTo({ top: 0 }); render(); return; }
  if (t.dataset.reviewq !== undefined) { setView('mockReviewQ', +t.dataset.reviewq); return; }
  switch (t.dataset.act) {
    case 'home': S.session = null; setView('home'); break;
    case 'settings': setView('settings'); break;
    case 'history': setView('history'); break;
    case 'unit': setView('unit', t.dataset.unit); break;
    case 'studyUnit': startSession('unit', t.dataset.unit); break;
    case 'smart': startSession('all'); break;
    case 'smartQuiz': startSmartSession(); break;
    case 'review': startSession('review'); break;
    case 'next': nextQuestion(); break;
    case 'quitQuiz':
      if (S.session.results.length === 0 || confirm('End this session? Your answers so far are saved.')) {
        if (S.session.results.length) finishSession(); else { S.session = null; setView('home'); }
      }
      break;
    case 'mock': if (confirm(`Start a ${CONFIG.mockSize}-question mock exam? The 3-hour timer starts now.`)) startMock(); break;
    case 'resumeMock': resumeMock(); break;
    case 'mockPrev': S.mock.idx--; persistMock(); render(); break;
    case 'mockNext': S.mock.idx++; persistMock(); render(); break;
    case 'mockFlag': { const q = S.byId.get(S.mock.qs[S.mock.idx]); S.mock.flags[q.id] = !S.mock.flags[q.id]; persistMock(); render(); break; }
    case 'submitMockAsk': {
      const n = Object.keys(S.mock.answers).length;
      const blank = S.mock.qs.length - n;
      if (confirm(`Submit exam?${blank ? ` ${blank} question(s) are unanswered.` : ''}`)) submitMock();
      break;
    }
    case 'backToMockResults': setView('mockResults'); break;
    case 'syncNow': {
      const detail = { title: 'Progress snapshot', text: 'Manual full sync from settings.', data: { questions: S.progress.questions, sessions: S.progress.sessions, mocks: S.progress.mocks } };
      syncResults('snapshot', detail); break;
    }
    case 'sendFeedback': {
      const txt = $('#fb-text').value.trim();
      if (!txt) { toast('Write a message first'); break; }
      syncResults('feedback', { title: 'Message from ' + (S.progress.settings.name || 'student'), text: txt, data: { message: txt } });
      $('#fb-text').value = '';
      break;
    }
    case 'copyBlob':
      navigator.clipboard.writeText('POWERPREP:' + resultsBlob()).then(() => toast('Copied — paste it to Nick'), () => toast('Could not copy'));
      break;
    case 'restoreBlob': {
      const v = $('#restore-input').value;
      if (!v.trim()) { toast('Paste a results code first'); break; }
      try { const n = restoreFromBlob(v); toast(`Restored — ${n} question record(s) merged`); setView('home'); }
      catch (e) { toast('That doesn’t look like a valid results code'); }
      break;
    }
    case 'dismissInstallTip':
      S.progress.settings.installTipDismissed = true; save(); render();
      break;
    case 'resetAll':
      if (confirm('Really erase ALL progress? This cannot be undone.') && confirm('Last chance — erase everything?')) {
        const name = S.progress.settings.name;
        S.progress = defaultProgress(); S.progress.settings.name = name; save();
        toast('Progress reset'); setView('home');
      }
      break;
  }
});

document.addEventListener('keydown', e => {
  if (e.target.matches('input,textarea,select')) return;
  if (S.view === 'quiz') {
    const s = S.session;
    if (!s.answered && ['1', '2', '3', '4'].includes(e.key)) {
      const q = currentQ(); const order = choiceOrder(q);
      answerCurrent(order[+e.key - 1]);
    } else if (s.answered && e.key === 'Enter') { e.preventDefault(); nextQuestion(); }
  } else if (S.view === 'mock') {
    if (['1', '2', '3', '4'].includes(e.key)) {
      const m = S.mock; const q = S.byId.get(m.qs[m.idx]);
      m.answers[q.id] = mockOrder(q)[+e.key - 1]; persistMock(); render();
    } else if (e.key === 'ArrowRight' && S.mock.idx < S.mock.qs.length - 1) { S.mock.idx++; persistMock(); render(); }
    else if (e.key === 'ArrowLeft' && S.mock.idx > 0) { S.mock.idx--; persistMock(); render(); }
  }
});

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
window.addEventListener('online', flushPending);
// a frozen/background tab may resume after another tab wrote newer progress
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && S.progress) { mergeFromStorage(); if (['home', 'history'].includes(S.view)) render(); }
});
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

/* ===================== boot ===================== */
(async function boot() {
  S.progress = loadProgress();
  applyTheme();
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  let savedCode = null;
  try { savedCode = localStorage.getItem(CONFIG.codeKey); } catch (e) { }
  try {
    const { kind, payload } = await fetchBankPayload();
    if (kind === 'plain') { initBank(payload); afterUnlock(); return; }
    if (savedCode) {
      try { initBank(await decryptBank(savedCode, payload)); afterUnlock(); return; }
      catch (e) { try { localStorage.removeItem(CONFIG.codeKey); } catch (e2) { } }
    }
    setView('unlock');
  } catch (e) {
    $('#app').innerHTML = `${topbar({ showNav: false })}<div class="card center" style="padding:40px"><h2>Can't load questions</h2><p class="muted mt">Check your internet connection and refresh.</p></div>`;
  }
})();
