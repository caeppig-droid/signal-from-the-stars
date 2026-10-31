/* ==========================================================
   Signal from the Stars — script.js
   Client-side only. Multiplayer via PeerJS (WebRTC).

   This file has two halves:
   - SHARED CORE (same in every game in the template bank): question
     model and grading, question sets, import/export, Teacher Mode,
     networking, whiteboard and class report.
   - GAME (unique to this game): the star map, station parts, the
     alien message, random events and Team Power.

   Architecture
   - The HOST's browser is the single source of truth (variable `H`).
   - Every change on the host calls broadcast(), which sends each peer
     its own snapshot ({t:'state', s}) with a rising `rev`. Clients only
     send requests ({t:'join'|'scan'|'answer'}) and render snapshots.
   - Students never receive other students' answers, and nobody gets
     the correct answer until the reveal. Each snapshot is built for
     its recipient (withPrivate), so a student only sees their own
     answer and result.
   - Messages bigger than CHUNK characters are sent in small pieces.
   ========================================================== */
(() => {
  'use strict';

  /* =========================================================
     CONFIG
     ========================================================= */
  // ▼▼▼ CHANGE THIS before publishing. Students can't see it on screen,
  // but anyone who opens the page source can read it.
  const TEACHER_PIN = 'CHANGE-ME';
  // ▲▲▲

  const GAME_NAME = 'Signal from the Stars';
  const FILE_SLUG = 'signal-from-the-stars';
  const PEER_PREFIX = 'signal-stars-v1-';
  // Every storage key starts with this game's name, so games on the same
  // GitHub Pages site never overwrite each other's data.
  const STORE_SETS = 'signalStars.sets.v1';
  const STORE_NAME = 'signalStars.name';
  const STORE_REPORT = 'signalStars.report.v1';
  const STORE_MSG = 'signalStars.message.v1';
  const SESS_TOKEN = 'signalStars.token';
  const SESS_ROOM = 'signalStars.room';
  // Read only (never written): Escape the Island's saved question sets.
  const ISLAND_SETS = 'escapeIsland.sets.v1';
  const ISLAND_LIST = 'escapeIsland.questions.v2';

  const TARGET_OPTIONS = [6, 8, 10, 12];   // parts to repair (teacher's choice)
  const DEFAULT_TARGET = 10;
  // Star map size and number of hidden surprises for each game length.
  const GRID = { 6: { tiles: 16, cols: 4 }, 8: { tiles: 20, cols: 5 }, 10: { tiles: 25, cols: 5 }, 12: { tiles: 30, cols: 5 } };
  const EXTRA_PARTS = 3;                   // spare parts hidden beyond the target
  const EVENT_TILES = { 6: { off: 0, sometimes: 2, often: 3 }, 8: { off: 0, sometimes: 2, often: 4 }, 10: { off: 0, sometimes: 3, often: 5 }, 12: { off: 0, sometimes: 3, often: 6 } };
  // Questions a set needs for roughly a 9 in 10 chance to finish (found by simulation).
  const QUESTIONS_FOR = { 6: 13, 8: 17, 10: 21, 12: 26 };
  const POWER_STEPS = 3;                   // strong rounds needed to fill Team Power
  const POWER_SHARE = 2 / 3;               // "strong round": at least this share correct

  const MAX_PLAYERS = 8;
  const SCAN_MS = 1100;        // radar sweep before a tile flips
  const FOUND_MS = 1500;       // look at the flipped tile before the question
  const EVENT_MS = 3800;       // how long a surprise is shown
  const REVEAL_MS = 8000;      // auto-continue delay after the reveal
  const PING_MS = 4000;        // heartbeat interval (both directions)
  const STALE_MS = 20000;      // silence longer than this = disconnected
  const RECONNECT_MS = 30000;  // how long a student keeps trying to reconnect
  const CHUNK = 12000;         // max characters per network message
  const ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no look-alikes (0/O, 1/I)
  const DEFAULT_MESSAGE = 'Greetings Earth friends! You fixed our signal!';

  const PARTS = [
    { e: '📡', n: 'Antenna' }, { e: '🔋', n: 'Power cell' }, { e: '🖥️', n: 'Computer' },
    { e: '🛰️', n: 'Satellite' }, { e: '🔭', n: 'Telescope' }, { e: '⚙️', n: 'Gears' }
  ];
  const EVENTS = {
    alien:  { emoji: '👽', title: 'Friendly alien!', good: true },
    junk:   { emoji: '☄️', title: 'Space junk!', good: false },
    flare:  { emoji: '☀️', title: 'Solar flare!', good: false },
    rocket: { emoji: '🚀', title: 'Supply rocket!', good: true }
  };
  const COLORS = ['#e4572e', '#2b7fb8', '#7b4fd8', '#d6336c', '#2f8f4e', '#d98200', '#0f8b8d', '#8d5524'];

  /* =========================================================
     SHARED CORE — small utilities
     ========================================================= */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function uid(len = 8) {
    let s = '';
    while (s.length < len) s += Math.random().toString(36).slice(2);
    return s.slice(0, len);
  }
  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }
  const safeStore = (area) => ({
    get(k, d = null) { try { const v = window[area].getItem(k); return v === null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { window[area].setItem(k, v); return true; } catch (e) { return false; } },
    del(k) { try { window[area].removeItem(k); } catch (e) { /* ignore */ } }
  });
  const local = safeStore('localStorage');
  const session = safeStore('sessionStorage');

  let toastTimer = null;
  function toast(msg, ms = 3400) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }
  function showScreen(name) {
    const was = $('#screen-' + name).classList.contains('hidden');
    ['home', 'lobby', 'game'].forEach(n => $('#screen-' + n).classList.toggle('hidden', n !== name));
    if (was) window.scrollTo(0, 0);
  }
  const cleanText = (s, max) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max);
  const cleanName = (s) => cleanText(s, 14);
  const initial = (name) => (name || '?').trim().charAt(0).toUpperCase() || '?';
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* =========================================================
     SHARED CORE — question model
     Every question is one of these (stored in localStorage and in
     exported files, the same shape in every game of the bank):
       choice: { type, q, a, wrong: [1–3] }
       tf:     { type, q, a: 'True' | 'False' }
       typed:  { type, q, accept: [1–6] }
       bank:   { type, q: 'The [sun] is a [star].', decoys: [0–6] }
       order:  { type, q, items: [3–6 in the correct order] }
       match:  { type, q, pairs: [[left, right], 2–6] }
       sort:   { type, q, groups: [{ name, items: [...] }, 2–4] }
     A teacher edits each question as one "row": Type, Question,
     Answer 1 … Answer 6 (the same columns as the spreadsheet template).
     ========================================================= */
  const TYPES = ['choice', 'tf', 'typed', 'bank', 'order', 'match', 'sort'];
  const TYPE_LABEL = {
    choice: 'Multiple choice', tf: 'True/False', typed: 'Type the answer', bank: 'Word bank',
    order: 'Put in order', match: 'Match', sort: 'Sort'
  };
  const LETTERS = ['A', 'B', 'C', 'D'];

  function typeFromLabel(s) {
    const k = String(s || '').toLowerCase().replace(/[^a-z]/g, '');
    const map = {
      multiplechoice: 'choice', choice: 'choice', mc: 'choice',
      truefalse: 'tf', tf: 'tf', trueorfalse: 'tf',
      typetheanswer: 'typed', typed: 'typed', type: 'typed', typein: 'typed', fillin: 'typed', fillintheblank: 'typed', shortanswer: 'typed',
      wordbank: 'bank', bank: 'bank', dragwords: 'bank',
      putinorder: 'order', order: 'order', ordering: 'order', sequence: 'order',
      match: 'match', matching: 'match',
      sort: 'sort', sorting: 'sort', categories: 'sort'
    };
    return map[k] || null;
  }

  // Lowercase, tidy spaces, straighten quotes, drop punctuation at the ends.
  function norm(s) {
    return String(s == null ? '' : s).normalize('NFKC').toLowerCase()
      .replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"')
      .replace(/\s+/g, ' ').trim()
      .replace(/^[\s"'.,!?;:]+|[\s"'.,!?;:]+$/g, '');
  }
  function asNumber(s) {
    const t = String(s).replace(/\s/g, '');
    if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return parseFloat(t.replace(/,/g, ''));
    if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(t)) return parseFloat(t);
    return null;
  }
  function typedMatches(input, accept) {
    const ni = norm(input);
    if (!ni) return false;
    const nn = asNumber(ni);
    return accept.some(a => {
      const na = norm(a);
      if (na === ni) return true;
      const an = asNumber(na);
      return nn !== null && an !== null && Math.abs(nn - an) < 1e-9;
    });
  }
  const BLANK_RE = /\[([^\[\]]+)\]/g;
  const blanksOf = (q) => Array.from(String(q).matchAll(BLANK_RE)).map(m => cleanText(m[1], 40));
  const blankDisplay = (q) => String(q).replace(BLANK_RE, '____');

  // Build a clean question from a row. Returns { q } or { error } in plain words.
  function buildQuestion(type, qText, answers, id) {
    if (!TYPES.includes(type)) return { error: 'Pick a question type.' };
    const max = type === 'bank' ? 250 : 200;
    const q = cleanText(qText, max);
    const ans = (answers || []).map(a => cleanText(a, 120)).filter(Boolean);
    if (!q) return { error: 'Type the question.' };
    const out = { id: id || uid(), type, q };
    const uniq = (list) => { const seen = new Set(); return list.filter(x => { const k = norm(x); if (!k || seen.has(k)) return false; seen.add(k); return true; }); };

    if (type === 'choice') {
      const a = cleanText(ans[0], 80);
      if (!a) return { error: 'Type the correct answer in Answer 1.' };
      const wrong = uniq([a].concat(ans.slice(1).map(w => cleanText(w, 80)))).slice(1, 4);
      if (!wrong.length) return { error: 'Add at least one wrong answer (Answer 2), different from the correct one.' };
      return { q: Object.assign(out, { a, wrong }) };
    }
    if (type === 'tf') {
      const v = norm(ans[0]);
      if (v === 'true' || v === 't' || v === 'yes') return { q: Object.assign(out, { a: 'True' }) };
      if (v === 'false' || v === 'f' || v === 'no') return { q: Object.assign(out, { a: 'False' }) };
      return { error: 'Answer 1 must be True or False.' };
    }
    if (type === 'typed') {
      const accept = uniq(ans.map(a => cleanText(a, 60))).slice(0, 6);
      if (!accept.length) return { error: 'Type at least one accepted answer.' };
      return { q: Object.assign(out, { accept }) };
    }
    if (type === 'bank') {
      const blanks = blanksOf(q);
      if (!blanks.length) return { error: 'Put [square brackets] around each answer word in the sentence, like: The [sun] is a [star].' };
      if (blanks.length > 6) return { error: 'Use 6 blanks or fewer.' };
      if (blanks.some(b => !b)) return { error: 'One of the [brackets] is empty.' };
      const bl = new Set(blanks.map(norm));
      const decoys = uniq(ans.map(a => cleanText(a, 40))).filter(d => !bl.has(norm(d))).slice(0, 6);
      return { q: Object.assign(out, { decoys }) };
    }
    if (type === 'order') {
      const items = ans.map(a => cleanText(a, 60)).slice(0, 6);
      if (items.length < 3) return { error: 'Put in order needs 3 to 6 items, typed in the correct order.' };
      if (uniq(items).length !== items.length) return { error: 'Each item must be different.' };
      return { q: Object.assign(out, { items }) };
    }
    if (type === 'match') {
      const pairs = [];
      for (const a of ans.slice(0, 6)) {
        const i = a.indexOf('=');
        if (i < 0) return { error: 'Type each pair as left = right, for example: cat = kitten.' };
        const l = cleanText(a.slice(0, i), 60), r = cleanText(a.slice(i + 1), 60);
        if (!l || !r) return { error: 'Each pair needs something on both sides of the = sign.' };
        pairs.push([l, r]);
      }
      if (pairs.length < 2) return { error: 'Match needs 2 to 6 pairs.' };
      if (uniq(pairs.map(p => p[0])).length !== pairs.length || uniq(pairs.map(p => p[1])).length !== pairs.length) return { error: 'Each left side and each right side must be different.' };
      return { q: Object.assign(out, { pairs }) };
    }
    // sort
    const groups = [];
    for (const a of ans.slice(0, 4)) {
      const i = a.indexOf(':');
      if (i < 0) return { error: 'Type each group as Group name: item, item, item.' };
      const name = cleanText(a.slice(0, i), 30);
      const items = a.slice(i + 1).split(/[,;]/).map(x => cleanText(x, 40)).filter(Boolean);
      if (!name || !items.length) return { error: 'Each group needs a name and at least one item.' };
      groups.push({ name, items });
    }
    if (groups.length < 2) return { error: 'Sort needs 2 to 4 groups.' };
    const all = groups.flatMap(g => g.items);
    if (all.length > 12) return { error: 'Use 12 items or fewer in all.' };
    if (uniq(all).length !== all.length) return { error: 'Each item must be different (an item can only belong to one group).' };
    if (uniq(groups.map(g => g.name)).length !== groups.length) return { error: 'Each group needs a different name.' };
    return { q: Object.assign(out, { groups }) };
  }

  // The row a teacher sees for a stored question (also used to re-check stored data).
  function toRow(x) {
    const t = x.type;
    let ans = [];
    if (t === 'choice') ans = [x.a].concat(x.wrong || []);
    else if (t === 'tf') ans = [x.a];
    else if (t === 'typed') ans = (x.accept || []).slice();
    else if (t === 'bank') ans = (x.decoys || []).slice();
    else if (t === 'order') ans = (x.items || []).slice();
    else if (t === 'match') ans = (x.pairs || []).map(p => p[0] + ' = ' + p[1]);
    else if (t === 'sort') ans = (x.groups || []).map(g => g.name + ': ' + (g.items || []).join(', '));
    return { type: t, q: x.q, ans };
  }

  // Accepts this game's questions and Escape the Island's { q, a, wrong }.
  function normalizeQuestion(x) {
    if (!x || typeof x !== 'object') return null;
    try {
      if (TYPES.includes(x.type)) {
        const r = toRow(x);
        return buildQuestion(r.type, r.q, r.ans, x.id).q || null;
      }
      const q = x.q || x.question, a = x.a || x.answer;
      if (typeof q !== 'string' || typeof a !== 'string') return null;
      const wrong = Array.isArray(x.wrong) ? x.wrong : [];
      const res = buildQuestion('choice', q, [a].concat(wrong));
      if (res.q) return res.q;
      return buildQuestion('typed', q, String(a).split('|')).q || null;   // no wrong answers: students type it
    } catch (e) { return null; }
  }

  // Plain-text summary of the correct answer (Teacher Mode list and reports).
  function keySummary(x) {
    if (x.type === 'choice') return x.a + '  (wrong: ' + x.wrong.join(', ') + ')';
    if (x.type === 'tf') return x.a;
    if (x.type === 'typed') return x.accept.join(' or ');
    if (x.type === 'bank') return blanksOf(x.q).join(', ') + (x.decoys.length ? '  (extra: ' + x.decoys.join(', ') + ')' : '');
    if (x.type === 'order') return x.items.join(' → ');
    if (x.type === 'match') return x.pairs.map(p => p[0] + ' = ' + p[1]).join('; ');
    return x.groups.map(g => g.name + ': ' + g.items.join(', ')).join('; ');
  }

  /* ----- Asking and grading (host only) -----
     prepare() splits a question into what students may see (pub) and
     the answer key the host keeps (key). */
  function prepare(x) {
    const base = { type: x.type };
    if (x.type === 'choice') {
      const opts = shuffle([{ t: x.a, ok: true }].concat(x.wrong.map(t => ({ t, ok: false }))));
      return { pub: Object.assign(base, { text: x.q, choices: opts.map(o => o.t) }), key: { idx: opts.findIndex(o => o.ok) } };
    }
    if (x.type === 'tf') {
      return { pub: Object.assign(base, { text: x.q, choices: ['True', 'False'] }), key: { idx: x.a === 'True' ? 0 : 1 } };
    }
    if (x.type === 'typed') return { pub: Object.assign(base, { text: x.q }), key: { accept: x.accept.slice() } };
    if (x.type === 'bank') {
      const answers = blanksOf(x.q);
      const parts = [];
      let last = 0, b = 0;
      for (const m of x.q.matchAll(BLANK_RE)) {
        if (m.index > last) parts.push(x.q.slice(last, m.index));
        parts.push({ b: b++ });
        last = m.index + m[0].length;
      }
      if (last < x.q.length) parts.push(x.q.slice(last));
      const chips = shuffle(answers.concat(x.decoys));
      return { pub: Object.assign(base, { text: blankDisplay(x.q), parts, chips, blanks: answers.length }), key: { answers } };
    }
    if (x.type === 'order') {
      let items = shuffle(x.items);
      for (let i = 0; i < 5 && items.every((t, k) => t === x.items[k]); i++) items = shuffle(x.items);
      return { pub: Object.assign(base, { text: x.q, items }), key: { correct: x.items.slice() } };
    }
    if (x.type === 'match') {
      const lefts = x.pairs.map(p => p[0]);
      const chips = shuffle(x.pairs.map(p => p[1]));
      return { pub: Object.assign(base, { text: x.q, lefts, chips }), key: { home: chips.map(c => x.pairs.findIndex(p => p[1] === c)), pairs: x.pairs.map(p => p.slice()) } };
    }
    const bins = x.groups.map(g => g.name);
    const chips = shuffle(x.groups.flatMap(g => g.items));
    return { pub: Object.assign(base, { text: x.q, bins, chips }), key: { home: chips.map(c => x.groups.findIndex(g => g.items.includes(c))), groups: x.groups.map(g => ({ name: g.name, items: g.items.slice() })) } };
  }

  const isPerm = (arr, n) => Array.isArray(arr) && arr.length === n && arr.every(v => Number.isInteger(v) && v >= 0 && v < n) && new Set(arr).size === n;

  // Checks that an answer has the right shape. Returns a clean copy or null.
  function validAnswer(pub, a) {
    if (!a || typeof a !== 'object') return null;
    if (pub.type === 'choice' || pub.type === 'tf') return Number.isInteger(a.choice) && a.choice >= 0 && a.choice < pub.choices.length ? { choice: a.choice } : null;
    if (pub.type === 'typed') { const t = cleanText(a.text, 80); return t ? { text: t } : null; }
    if (pub.type === 'bank') {
      const f = a.fill;
      if (!Array.isArray(f) || f.length !== pub.blanks || !f.every(v => Number.isInteger(v) && v >= 0 && v < pub.chips.length) || new Set(f).size !== f.length) return null;
      return { fill: f.slice() };
    }
    if (pub.type === 'order') return isPerm(a.order, pub.items.length) ? { order: a.order.slice() } : null;
    if (pub.type === 'match') return isPerm(a.place, pub.chips.length) ? { place: a.place.slice() } : null;
    if (pub.type === 'sort') {
      const p = a.place;
      if (!Array.isArray(p) || p.length !== pub.chips.length || !p.every(v => Number.isInteger(v) && v >= 0 && v < pub.bins.length)) return null;
      return { place: p.slice() };
    }
    return null;
  }

  // Returns { ok, score (0–1), detail (per blank/slot/item), text (what they answered) }.
  function grade(pub, key, a) {
    if (pub.type === 'choice' || pub.type === 'tf') {
      const ok = a.choice === key.idx;
      return { ok, score: ok ? 1 : 0, text: pub.choices[a.choice] };
    }
    if (pub.type === 'typed') {
      const ok = typedMatches(a.text, key.accept);
      return { ok, score: ok ? 1 : 0, text: a.text };
    }
    if (pub.type === 'bank') {
      const detail = a.fill.map((c, i) => norm(pub.chips[c]) === norm(key.answers[i]));
      return mark(detail, a.fill.map(c => pub.chips[c]).join(', '));
    }
    if (pub.type === 'order') {
      const detail = a.order.map((it, k) => pub.items[it] === key.correct[k]);
      return mark(detail, a.order.map(it => pub.items[it]).join(' → '));
    }
    if (pub.type === 'match') {
      const detail = a.place.map((l, c) => l === key.home[c]);
      const txt = pub.lefts.map((l, li) => l + ' = ' + pub.chips[a.place.indexOf(li)]).join('; ');
      return mark(detail, txt);
    }
    const detail = a.place.map((b, c) => b === key.home[c]);
    const txt = pub.bins.map((name, bi) => name + ': ' + pub.chips.filter((_, c) => a.place[c] === bi).join(', ')).join('; ');
    return mark(detail, txt);
  }
  function mark(detail, text) {
    const right = detail.filter(Boolean).length;
    return { ok: right === detail.length, score: detail.length ? right / detail.length : 0, detail, text };
  }

  // What the class sees at the reveal (sent to everyone only then).
  function revealKey(pub, key) {
    if (pub.type === 'choice' || pub.type === 'tf') return { idx: key.idx, text: pub.choices[key.idx] };
    if (pub.type === 'typed') return { accept: key.accept.slice(), text: key.accept.join(' or ') };
    if (pub.type === 'bank') return { answers: key.answers.slice(), text: key.answers.join(', ') };
    if (pub.type === 'order') return { correct: key.correct.slice(), text: key.correct.join(' → ') };
    if (pub.type === 'match') return { home: key.home.slice(), text: key.pairs.map(p => p[0] + ' = ' + p[1]).join('; ') };
    return { home: key.home.slice(), text: key.groups.map(g => g.name + ': ' + g.items.join(', ')).join('; ') };
  }

  /* ----- Sample questions (all seven types) ----- */
  const SAMPLE_ROWS = [
    ['choice', 'What is 7 x 8?', ['56', '54', '63', '48']],
    ['choice', 'Which planet is called the Red Planet? 🔴', ['Mars', 'Venus', 'Jupiter', 'Saturn']],
    ['choice', 'How many legs does a spider have? 🕷️', ['8', '6', '10', '4']],
    ['choice', 'Which word is a noun?', ['rocket', 'quickly', 'jump', 'bright']],
    ['choice', 'What do plants need from the sun to make food?', ['Sunlight', 'Wind', 'Sand', 'Snow']],
    ['choice', 'What is the capital city of Colorado?', ['Denver', 'Boulder', 'Aurora', 'Pueblo']],
    ['tf', 'The Sun is a star. ☀️', ['True']],
    ['tf', 'The Moon makes its own light.', ['False']],
    ['tf', '10 is an odd number.', ['False']],
    ['tf', 'Water freezes at 32 degrees Fahrenheit. 🧊', ['True']],
    ['typed', 'What is 9 + 6?', ['15', 'fifteen']],
    ['typed', 'How many minutes are in one hour?', ['60', 'sixty']],
    ['typed', 'What planet do we live on? 🌍', ['Earth', 'the Earth', 'planet Earth']],
    ['typed', 'What is the plural of "mouse"?', ['mice']],
    ['typed', '🍎🍎🍎 + 🍎🍎 = ?', ['5', 'five']],
    ['bank', 'The [Sun] is a [star] at the center of our solar system.', ['moon', 'planet']],
    ['bank', 'Astronauts wear a [helmet] so they can [breathe] in space.', ['hat', 'sleep']],
    ['bank', 'A [noun] names a person, place, or thing. A [verb] shows action.', ['adjective']],
    ['order', 'Put the planets in order, starting closest to the Sun.', ['Mercury', 'Venus', 'Earth', 'Mars']],
    ['order', 'Put the numbers in order from smallest to largest.', ['199', '245', '452', '524']],
    ['order', 'Put the life cycle of a butterfly in order.', ['Egg', 'Caterpillar', 'Chrysalis', 'Butterfly']],
    ['match', 'Match each animal to its baby.', ['cat = kitten', 'dog = puppy', 'cow = calf', 'frog = tadpole']],
    ['match', 'Match each shape to its number of sides.', ['triangle = 3', 'square = 4', 'pentagon = 5', 'hexagon = 6']],
    ['sort', 'Sort these into living and nonliving things.', ['Living: tree, dog, mushroom', 'Nonliving: rock, water, rocket']],
    ['sort', 'Sort the numbers into even and odd.', ['Even: 4, 10, 16', 'Odd: 7, 13, 21']],
    ['sort', 'Is each word a noun or a verb?', ['Noun: planet, astronaut, star', 'Verb: fly, orbit, shine']]
  ];
  const sampleQuestions = () => SAMPLE_ROWS.map(([t, q, a]) => buildQuestion(t, q, a).q).filter(Boolean);

  /* =========================================================
     SHARED CORE — question sets (localStorage)
     Stored under STORE_SETS as { v: 1, sets: [{ id, name, questions }],
     editId, gameId }. Future versions get a NEW key (…sets.v2) and copy
     from this one, never changing it, so rolling back is always safe.
     ========================================================= */
  let questions = [];      // the set open in Teacher Mode
  let editSetId = null;
  let editSetName = '';

  function writeSets(d) {
    if (!local.set(STORE_SETS, JSON.stringify(d))) toast('Could not save. This browser\'s storage may be full or turned off.', 5000);
  }
  function readSets() {
    try {
      const raw = local.get(STORE_SETS);
      if (raw) {
        const d = JSON.parse(raw);
        if (d && Array.isArray(d.sets)) {
          d.sets = d.sets.filter(x => x && x.id).map(x => ({
            id: String(x.id), name: cleanText(x.name, 40) || 'Question set',
            questions: (Array.isArray(x.questions) ? x.questions : []).map(normalizeQuestion).filter(Boolean)
          }));
          if (d.sets.length) {
            if (!d.sets.some(x => x.id === d.gameId)) d.gameId = d.sets[0].id;
            if (!d.sets.some(x => x.id === d.editId)) d.editId = d.sets[0].id;
            d.v = 1;
            return d;
          }
        }
      }
    } catch (e) { /* fall through to first-run setup */ }
    const first = { id: uid(6), name: 'Sample questions', questions: sampleQuestions() };
    const d = { v: 1, sets: [first], editId: first.id, gameId: first.id };
    writeSets(d);
    return d;
  }
  function loadQuestions() {
    const d = readSets();
    const es = d.sets.find(x => x.id === editSetId) || d.sets.find(x => x.id === d.editId) || d.sets[0];
    editSetId = es.id;
    editSetName = es.name;
    questions = es.questions;
  }
  function saveQuestions() {
    const d = readSets();
    const es = d.sets.find(x => x.id === editSetId);
    if (!es) return;
    es.questions = questions;
    d.editId = editSetId;
    writeSets(d);
  }
  const setsSummary = () => readSets().sets.map(x => ({ id: x.id, name: x.name, total: x.questions.length }));
  function chosenSet() {
    const d = readSets();
    return d.sets.find(x => x.id === (H && H.setId)) || d.sets.find(x => x.id === d.gameId) || d.sets[0];
  }
  function uniqueSetName(d, base) {
    let n = cleanText(base, 40) || 'Question set', i = 2;
    while (d.sets.some(x => x.name.toLowerCase() === n.toLowerCase())) n = cleanText(base, 34) + ' (' + (i++) + ')';
    return n;
  }

  // Copies Escape the Island's sets into this game. Island data is only read, never changed.
  function copyFromIsland() {
    const found = [];
    try {
      const raw = local.get(ISLAND_SETS);
      if (raw) {
        const d = JSON.parse(raw);
        if (d && Array.isArray(d.sets)) d.sets.forEach(s => found.push({ name: s.name, questions: s.questions }));
      }
      if (!found.length) {
        const list = JSON.parse(local.get(ISLAND_LIST, 'null'));
        if (Array.isArray(list)) found.push({ name: 'My questions', questions: list });
      }
    } catch (e) { /* ignore */ }
    if (!found.length) { toast('No Escape the Island questions were found in this browser. They have to be saved on this same device and browser.', 6000); return; }
    const d = readSets();
    let sets = 0, qs = 0;
    found.forEach(s => {
      const list = (Array.isArray(s.questions) ? s.questions : []).map(normalizeQuestion).filter(Boolean);
      if (!list.length) return;
      d.sets.push({ id: uid(6), name: uniqueSetName(d, cleanText(s.name, 26) + ' (Island)'), questions: list });
      sets++; qs += list.length;
    });
    writeSets(d);
    loadQuestions();
    renderTeacher();
    toast(sets ? 'Copied ' + plural(sets, 'set') + ' (' + plural(qs, 'question') + ') from Escape the Island.' : 'The Escape the Island sets were empty.', 5000);
  }

  /* =========================================================
     SHARED CORE — network state and chunked messages
     ========================================================= */
  const net = {
    role: null,        // 'host' | 'client'
    peer: null,
    code: '',
    conns: {},         // host: peerId -> DataConnection
    hostConn: null,    // client: connection to host
    me: { pid: null, name: '' },
    leaving: false
  };
  function getToken() {
    let t = session.get(SESS_TOKEN);
    if (!t) { t = uid(16); session.set(SESS_TOKEN, t); }
    return t;
  }
  function randomCode() {
    let c = '';
    for (let i = 0; i < 4; i++) c += ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)];
    return c;
  }
  // Sends a message, splitting anything large into small pieces.
  function sendMsg(conn, msg) {
    if (!conn || !conn.open) return;
    try {
      const json = JSON.stringify(msg);
      if (json.length <= CHUNK) { conn.send(msg); return; }
      const id = uid(6), n = Math.ceil(json.length / CHUNK);
      for (let i = 0; i < n; i++) conn.send({ t: 'part', id, i, n, d: json.slice(i * CHUNK, (i + 1) * CHUNK) });
    } catch (e) { /* ignore: the heartbeat notices dead connections */ }
  }
  // Puts pieces back together. `box` holds partial messages for one sender.
  function receivePart(box, m, deliver) {
    if (!Number.isInteger(m.n) || m.n < 1 || m.n > 200 || !Number.isInteger(m.i) || m.i < 0 || m.i >= m.n || typeof m.d !== 'string' || typeof m.id !== 'string') return;
    if (!box.cur || box.cur.id !== m.id) box.cur = { id: m.id, n: m.n, parts: [], got: 0 };
    const c = box.cur;
    if (c.n !== m.n || c.parts[m.i] !== undefined) return;
    c.parts[m.i] = m.d;
    c.got++;
    if (c.got === c.n) {
      box.cur = null;
      let msg = null;
      try { msg = JSON.parse(c.parts.join('')); } catch (e) { /* ignore */ }
      if (msg && typeof msg === 'object' && msg.t !== 'part') deliver(msg);
    }
  }

  /* =========================================================
     HOST — authoritative state
     ========================================================= */
  let H = null;

  function initHostState(hostName) {
    H = {
      rev: 0,
      phase: 'lobby',          // lobby | scan | scanning | found | event | question | reveal | won | lost
      players: [],             // { pid, name, color, connected }
      turn: 0,
      tiles: [],               // { kind: part|event|empty, open, by }   kinds are HOST ONLY until opened
      cols: 5,
      target: DEFAULT_TARGET,
      nextTarget: DEFAULT_TARGET,
      events: 'sometimes',
      power: true,
      meter: 0,
      big: false,
      repaired: [],            // part index for each repaired part
      deck: [], used: [], totalQ: 0, asked: 0,
      current: null,           // { id, num, pub, key, src }  key is HOST ONLY
      answers: {},             // pid -> answer
      grades: {},              // pid -> grade      HOST ONLY
      reveal: null,
      scan: { seq: 0, idx: -1, pid: null },
      found: null,             // what the last scan uncovered
      event: null, eventBag: [], lastEvent: null,
      message: '', order: [],  // alien message and the order its letters decode
      log: [],
      autoContinue: true,
      projector: true,         // hide student names on the host's own screen
      hostName, hostPlays: true,
      peerToPid: {}, lastSeen: {}, boxes: {},
      setId: null,
      board: null, paused: false,
      timer: null
    };
    H.players.push({ pid: 'host', name: hostName, color: COLORS[0], connected: true });
    H.message = cleanText(local.get(STORE_MSG, DEFAULT_MESSAGE), 60) || DEFAULT_MESSAGE;
  }

  const hostLog = (msg) => { H.log.push(msg); if (H.log.length > 30) H.log.shift(); };
  const currentPlayer = () => H.players[H.turn] || null;
  const nextColor = () => COLORS.find(c => !H.players.some(p => p.color === c)) || COLORS[H.players.length % COLORS.length];
  function uniqueName(name) {
    const base = name || 'Astronaut';
    let n = base, i = 2;
    while (H.players.some(p => p.name.toLowerCase() === n.toLowerCase())) n = base.slice(0, 11) + ' ' + (i++);
    return n;
  }
  const inQuestion = () => (H.phase === 'question' || H.phase === 'reveal') && H.current;
  const partName = (i) => PARTS[i % PARTS.length].e + ' ' + PARTS[i % PARTS.length].n;

  // The alien message with only the decoded letters showing.
  function maskedMessage() {
    const shown = H.phase === 'won' ? H.order.length : Math.round(H.order.length * Math.min(1, H.repaired.length / H.target));
    const open = new Set(H.order.slice(0, shown));
    return Array.from(H.message.toUpperCase()).map((ch, i) => (/[\p{L}\p{N}]/u.test(ch) && !open.has(i) ? '•' : ch)).join('');
  }

  // Public snapshot: no answers and no answer key (until the reveal).
  function snapshot() {
    const cur = currentPlayer();
    const gs = chosenSet();
    const inQ = inQuestion();
    return {
      rev: H.rev,
      phase: H.phase,
      code: net.code,
      hostName: H.hostName,
      hostPlays: H.hostPlays,
      autoContinue: H.autoContinue,
      paused: H.paused,
      big: H.big,
      power: H.power,
      meter: H.meter,
      events: H.events,
      players: H.players.map(p => ({ pid: p.pid, name: p.name, color: p.color, connected: p.connected, isHost: p.pid === 'host' })),
      turnPid: cur ? cur.pid : null,
      cols: H.cols,
      tiles: H.tiles.map(t => (t.open ? { k: t.kind, p: t.part, ev: t.ev, by: t.by } : null)),
      target: H.target,
      nextTarget: H.nextTarget,
      repaired: H.repaired.slice(),
      msg: H.phase === 'lobby' ? '' : maskedMessage(),
      deckLeft: H.deck.length,
      totalQ: H.totalQ,
      setName: gs.name,
      qCount: gs.questions.length,
      scan: Object.assign({}, H.scan),
      found: H.found,
      event: H.phase === 'event' ? H.event : null,
      question: inQ ? Object.assign({ id: H.current.id, num: H.current.num }, H.current.pub) : null,
      answered: inQ ? Object.keys(H.answers) : [],     // who has answered, never what
      reveal: H.phase === 'reveal' ? H.reveal : null,
      boardShared: !!H.board,
      log: H.log.slice(-6)
    };
  }

  // Each player only ever receives THEIR OWN answer (and result, after the reveal).
  function withPrivate(base, pid) {
    const s = Object.assign({}, base, { mine: null });
    if (pid && inQuestion() && has(H.answers, pid)) {
      s.mine = { ans: H.answers[pid] };
      if (H.phase === 'reveal') { const g = H.grades[pid]; s.mine.ok = g.ok; s.mine.score = g.score; s.mine.detail = g.detail || null; }
    }
    return s;
  }

  // Extra details only the host's own screen gets.
  function hostExtra() {
    const extra = { sets: setsSummary(), setId: chosenSet().id, projector: H.projector };
    if (inQuestion()) {
      extra.picks = {};
      Object.keys(H.answers).forEach(pid => { extra.picks[pid] = { text: H.grades[pid].text, ok: H.grades[pid].ok }; });
      extra.keyText = revealKey(H.current.pub, H.current.key).text;
      if (H.phase === 'reveal' && H.revealCount) extra.revealCount = H.revealCount;
    }
    return extra;
  }

  function broadcast() {
    H.rev++;
    const base = snapshot();
    Object.values(net.conns).forEach(c => sendMsg(c, { t: 'state', s: withPrivate(base, H.peerToPid[c.peer]) }));
    applyState(withPrivate(base, 'host'), hostExtra());
  }
  function sendToAll(msg) { Object.values(net.conns).forEach(c => sendMsg(c, msg)); }

  function advanceTurn() {
    const n = H.players.length;
    for (let i = 1; i <= n; i++) {
      const idx = (H.turn + i) % n;
      if (H.players[idx].connected) { H.turn = idx; return; }
    }
  }

  /* =========================================================
     GAME — star map, parts, surprises, Team Power (host side)
     ========================================================= */
  function buildTiles() {
    const g = GRID[H.target];
    const parts = H.target + EXTRA_PARTS;
    const evs = EVENT_TILES[H.target][H.events] || 0;
    const kinds = [];
    for (let i = 0; i < g.tiles; i++) kinds.push(i < parts ? 'part' : i < parts + evs ? 'event' : 'empty');
    H.cols = g.cols;
    H.tiles = shuffle(kinds).map(kind => ({ kind, open: false, by: null }));
  }

  function hostStart() {
    const cs = chosenSet();
    if (!cs.questions.length) { toast('The set "' + cs.name + '" has no questions yet. Add some in Teacher Mode.'); return; }
    if (!H.players.some(p => p.connected)) { toast('Wait for at least one player to join.'); return; }
    clearTimeout(H.timer);
    H.setId = cs.id;
    H.target = H.nextTarget;
    H.deck = shuffle(cs.questions.map(q => Object.assign({}, q, { id: uid() })));
    H.totalQ = H.deck.length;
    H.used = [];
    H.asked = 0;
    H.repaired = [];
    H.meter = 0;
    buildTiles();
    const letters = [];
    Array.from(H.message.toUpperCase()).forEach((ch, i) => { if (/[\p{L}\p{N}]/u.test(ch)) letters.push(i); });
    H.order = shuffle(letters);
    H.turn = Math.max(0, H.players.findIndex(p => p.connected));
    H.current = null; H.answers = {}; H.grades = {}; H.reveal = null;
    H.found = null; H.event = null; H.paused = false;
    H.eventBag = shuffle(Object.keys(EVENTS)); H.lastEvent = null;
    H.scan = { seq: H.scan.seq, idx: -1, pid: null };
    H.log = [];
    startReport(cs.name);
    hostClearBoard();
    H.phase = 'scan';
    hostLog('Mission started! Scan the star map for station parts.');
    broadcast();
  }

  // The player whose turn it is may scan; the host may also scan for anyone.
  function hostScan(callerPid, idx) {
    if (H.phase !== 'scan') return;
    const p = currentPlayer();
    if (!p || (callerPid !== p.pid && callerPid !== 'host')) return;
    if (!Number.isInteger(idx) || idx < 0 || idx >= H.tiles.length || H.tiles[idx].open) return;
    H.scan = { seq: H.scan.seq + 1, idx, pid: p.pid };
    H.phase = 'scanning';
    broadcast();
    clearTimeout(H.timer);
    H.timer = setTimeout(hostOpenTile, SCAN_MS);
  }

  function hostOpenTile() {
    if (H.phase !== 'scanning') return;
    const t = H.tiles[H.scan.idx], p = currentPlayer();
    const who = p ? p.name : 'The crew';
    t.open = true;
    t.by = H.scan.pid;
    let evType = null;
    if (t.kind === 'part') {
      t.part = H.repaired.length % PARTS.length;
      if (H.repaired.length < H.target) H.repaired.push(t.part);
      H.found = { kind: 'part', part: t.part, name: who };
      hostLog(who + ' found a ' + partName(t.part) + '!');
    } else if (t.kind === 'event') {
      evType = pickEvent();
      t.ev = EVENTS[evType].emoji;
      H.found = { kind: 'event', name: who };
    } else {
      H.found = { kind: 'empty', name: who };
      hostLog(who + ' found stardust.');
    }
    H.phase = 'found';
    broadcast();
    clearTimeout(H.timer);
    H.timer = setTimeout(() => {
      if (H.phase !== 'found') return;
      if (evType) {
        H.event = applyEvent(evType);
        hostLog(H.event.text);
        H.phase = 'event';
        broadcast();
        H.timer = setTimeout(hostAskQuestion, EVENT_MS);
      } else hostAskQuestion();
    }, FOUND_MS);
  }

  // Surprises come from a shuffled bag so every kind shows up before any repeats,
  // and only ones that can't end the game by themselves are picked.
  function pickEvent() {
    const ok = { alien: H.repaired.length < H.target, junk: true, flare: H.deck.length >= 3, rocket: H.used.length >= 1 };
    const fromBag = () => H.eventBag.find(k => ok[k] && k !== H.lastEvent) || H.eventBag.find(k => ok[k]);
    let pick = fromBag();
    if (!pick) { H.eventBag = shuffle(Object.keys(EVENTS)); pick = fromBag() || 'junk'; }
    if (H.eventBag.includes(pick)) H.eventBag.splice(H.eventBag.indexOf(pick), 1);
    H.lastEvent = pick;
    return pick;
  }

  function applyEvent(type) {
    const meta = EVENTS[type];
    let text = '';
    if (type === 'alien') {
      const part = H.repaired.length % PARTS.length;
      H.repaired.push(part);
      text = 'A friendly alien floated by with a spare ' + partName(part) + '. One more part repaired!';
    } else if (type === 'junk') {
      const spots = H.tiles.map((t, i) => i).filter(i => !H.tiles[i].open && H.tiles[i].kind !== 'part');
      if (H.repaired.length && spots.length) {
        const part = H.repaired.pop();
        H.tiles[spots[Math.floor(Math.random() * spots.length)]].kind = 'part';
        text = 'Space junk knocked the ' + partName(part) + ' loose! It floated to another spot on the map. Find it again!';
      } else text = 'Space junk bounced off the station shield. Phew, nothing was lost!';
    } else if (type === 'flare') {
      H.deck.splice(-2, 2);
      text = 'A solar flare scrambled the signal: 2 fewer questions left.';
    } else {
      let k = 0;
      while (k < 2 && H.used.length) {
        const q = H.used.splice(Math.floor(Math.random() * H.used.length), 1)[0];
        H.deck.splice(Math.floor(Math.random() * (H.deck.length + 1)), 0, q);
        k++;
      }
      text = 'A supply rocket brought more time: ' + plural(k, 'question') + ' added back.';
    }
    return { id: H.scan.seq, type, emoji: meta.emoji, title: meta.title, good: meta.good, text };
  }

  function hostAskQuestion() {
    if (H.phase !== 'found' && H.phase !== 'event') return;
    clearTimeout(H.timer);
    const q = H.deck.pop();
    if (!q) { H.phase = H.repaired.length >= H.target ? 'won' : 'lost'; broadcast(); return; }
    H.used.push(q);
    const prep = prepare(q);
    H.asked++;
    H.current = { id: q.id + '-' + H.asked, num: H.asked, pub: prep.pub, key: prep.key, src: q };
    H.answers = {}; H.grades = {}; H.reveal = null;
    H.phase = 'question';
    broadcast();
    checkQuestionDone();
  }

  function hostAnswer(pid, msg) {
    if (H.phase !== 'question' || !H.current || !msg || msg.qid !== H.current.id) return;
    if (!H.players.some(p => p.pid === pid) || has(H.answers, pid)) return;
    const a = validAnswer(H.current.pub, msg.a);
    if (!a) return;
    H.answers[pid] = a;
    H.grades[pid] = grade(H.current.pub, H.current.key, a);
    if (!checkQuestionDone()) broadcast();
  }

  // Everyone who is connected must answer before the reveal.
  function checkQuestionDone() {
    if (H.phase !== 'question') return false;
    if (H.players.filter(p => p.connected).every(p => has(H.answers, p.pid))) { resolveQuestion(); return true; }
    return false;
  }

  function resolveQuestion() {
    if (H.phase !== 'question' || !H.current) return;
    const who = Object.keys(H.answers);
    const right = who.filter(pid => H.grades[pid].ok).length;
    let power = false, bonus = null;
    if (H.power && who.length && right / who.length >= POWER_SHARE) {
      power = true;
      H.meter++;
      if (H.meter >= POWER_STEPS) {
        H.meter = 0;
        if (H.repaired.length < H.target) {
          bonus = H.repaired.length % PARTS.length;
          H.repaired.push(bonus);
          hostLog('Team Power! The crew repaired a bonus ' + partName(bonus) + '.');
        }
      }
    }
    // The count of who got it right stays on the host: with a small group, students could work out who missed it.
    H.reveal = { key: revealKey(H.current.pub, H.current.key), power, bonus };
    H.revealCount = { right, total: who.length };
    recordQuestion();
    H.phase = 'reveal';
    hostLog(who.length ? 'Answers revealed.' : 'Nobody answered.');
    broadcast();
    clearTimeout(H.timer);
    if (H.autoContinue && !H.paused) H.timer = setTimeout(hostContinue, REVEAL_MS);
  }

  function hostContinue() {
    if (H.phase !== 'reveal') return;
    clearTimeout(H.timer);
    H.paused = false;
    hostClearBoard();
    if (H.repaired.length >= H.target) {
      H.phase = 'won';
      hostLog('The antenna is fixed. Message received!');
    } else if (!H.deck.length) {
      H.phase = 'lost';
      hostLog('The signal window closed.');
    } else {
      advanceTurn();
      H.phase = 'scan';
      H.current = null; H.answers = {}; H.grades = {}; H.reveal = null; H.found = null; H.event = null;
    }
    broadcast();
  }

  /* ----- Lobby and Host-control settings ----- */
  function hostSetHostPlays(v) {
    if (H.phase !== 'lobby') return;
    H.hostPlays = !!v;
    const there = H.players.some(p => p.pid === 'host');
    if (v && !there) H.players.unshift({ pid: 'host', name: H.hostName, color: nextColor(), connected: true });
    if (!v && there) H.players = H.players.filter(p => p.pid !== 'host');
    broadcast();
  }
  function hostSetQuestionSet(id) {
    const d = readSets();
    if (!d.sets.some(x => x.id === id)) return;
    H.setId = id;
    d.gameId = id;
    writeSets(d);
    broadcast();
  }
  function hostSetTarget(v) { v = Number(v); if (TARGET_OPTIONS.includes(v)) { H.nextTarget = v; broadcast(); } }
  function hostSetEvents(v) { if (has(EVENT_TILES[6], v)) { H.events = v; broadcast(); } }

  /* ----- Whiteboard sharing (host) ----- */
  function hostPause() {
    if (!H || H.paused || !inQuestion()) return;
    H.paused = true;
    if (H.phase === 'reveal') clearTimeout(H.timer);
    broadcast();
  }
  function hostShareBoard(strokes) {
    if (!H || !strokes.length) return 'empty';
    const board = { id: uid(6), strokes };
    if (JSON.stringify(board).length > 400000) return 'toolarge';
    H.board = board;
    sendToAll({ t: 'board', board });
    broadcast();
    return 'ok';
  }
  function hostClearBoard() { if (H && H.board) { H.board = null; sendToAll({ t: 'board', board: null }); } }
  function hostHideBoard() { if (!H) return; H.board = null; sendToAll({ t: 'board', board: null }); broadcast(); }

  /* =========================================================
     SHARED CORE — host connections and heartbeat
     ========================================================= */
  function onHostConnection(conn) {
    net.conns[conn.peer] = conn;
    H.boxes[conn.peer] = {};
    conn.on('data', (msg) => {
      if (msg && msg.t === 'part') receivePart(H.boxes[conn.peer] || (H.boxes[conn.peer] = {}), msg, m => hostOnMessage(conn, m));
      else hostOnMessage(conn, msg);
    });
    conn.on('close', () => hostOnClose(conn));
    conn.on('error', () => hostOnClose(conn));
  }

  function hostOnMessage(conn, msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'join') return hostJoin(conn, msg);
    const pid = H.peerToPid[conn.peer];
    if (!pid) return;                         // must join first
    H.lastSeen[pid] = Date.now();
    const who = H.players.find(x => x.pid === pid);
    if (who && !who.connected) { who.connected = true; hostLog(who.name + ' is back.'); broadcast(); }
    if (msg.t === 'ping') return;
    if (msg.t === 'scan') return hostScan(pid, msg.idx);
    if (msg.t === 'answer') return hostAnswer(pid, msg);
  }

  function hostJoin(conn, msg) {
    const token = String(msg.token || '').slice(0, 40);
    if (!token || token === 'host') return;
    let p = H.players.find(x => x.pid === token);
    if (!p) {
      if (H.players.length >= MAX_PLAYERS) {
        sendMsg(conn, { t: 'reject', reason: 'This room is full (8 players max).' });
        setTimeout(() => { try { conn.close(); } catch (e) { /* ignore */ } }, 400);
        return;
      }
      p = { pid: token, name: uniqueName(cleanName(msg.name)), color: nextColor(), connected: true };
      H.players.push(p);
      hostLog(p.name + ' joined the crew.');
    } else {
      // The same player coming back (refresh or dropped connection): close their old connection.
      Object.keys(H.peerToPid).forEach(peerId => {
        if (H.peerToPid[peerId] === token && peerId !== conn.peer) {
          delete H.peerToPid[peerId];
          const old = net.conns[peerId];
          delete net.conns[peerId];
          try { old && old.close(); } catch (e) { /* ignore */ }
        }
      });
      if (!p.connected) hostLog(p.name + ' is back.');
      p.connected = true;
    }
    H.peerToPid[conn.peer] = token;
    H.lastSeen[token] = Date.now();
    sendMsg(conn, { t: 'welcome', pid: token });
    if (H.board) sendMsg(conn, { t: 'board', board: H.board });
    broadcast();
  }

  function hostOnClose(conn) {
    if (net.conns[conn.peer] === conn) delete net.conns[conn.peer];
    delete H.boxes[conn.peer];
    const pid = H.peerToPid[conn.peer];
    if (!pid) return;
    delete H.peerToPid[conn.peer];
    if (Object.values(H.peerToPid).includes(pid)) return;   // already reconnected
    hostMarkOffline(pid);
  }

  // For real closes AND heartbeat timeouts (tab closed, lid shut, Wi-Fi dropped).
  function hostMarkOffline(pid) {
    const idx = H.players.findIndex(p => p.pid === pid);
    if (idx < 0 || pid === 'host') return;
    const p = H.players[idx];
    if (!p.connected) return;
    if (H.phase === 'lobby') {
      H.players.splice(idx, 1);
      Object.keys(H.peerToPid).forEach(k => { if (H.peerToPid[k] === pid) delete H.peerToPid[k]; });
      broadcast();
      return;
    }
    p.connected = false;
    hostLog(p.name + ' lost connection.');
    if (H.phase === 'scan' && currentPlayer() && currentPlayer().pid === pid) advanceTurn();
    if (H.phase === 'question') { if (!checkQuestionDone()) broadcast(); return; }
    broadcast();
  }

  function hostHeartbeat() {
    if (!H) return;
    const now = Date.now();
    Object.values(net.conns).forEach(c => sendMsg(c, { t: 'hb' }));
    H.players.forEach(p => {
      if (p.pid !== 'host' && p.connected && now - (H.lastSeen[p.pid] || 0) > STALE_MS) hostMarkOffline(p.pid);
    });
  }

  /* =========================================================
     SHARED CORE — creating and joining a room
     ========================================================= */
  function homeMsg(text, isError = true) {
    const m = $('#homeMsg');
    m.textContent = text || '';
    m.classList.toggle('error', !!text && isError);
  }
  function setBusy(b) { $$('#screen-home button').forEach(x => { x.disabled = b; }); }
  function peerAvailable() {
    if (typeof window.Peer === 'undefined') {
      homeMsg('The multiplayer library did not load. Check your internet connection, or ask whether your network blocks cdn.jsdelivr.net.');
      return false;
    }
    return true;
  }
  // Tests point the game at a local PeerJS server with ?peerhost=localhost&peerport=9000.
  function peerOptions() {
    const p = new URLSearchParams(window.location.search);
    const o = { debug: 1 };
    if (p.get('peerhost')) { o.host = p.get('peerhost'); o.port = Number(p.get('peerport') || 9000); o.path = '/'; o.secure = false; }
    if (p.get('peerhost')) window.__net = net;   // test hook, only with a local test server
    return o;
  }
  // When the connection server drops (common on school Wi-Fi), reconnect. Open games keep working.
  function watchSignaling(peer) {
    peer.on('disconnected', () => {
      if (net.leaving) return;
      setTimeout(() => { if (!net.leaving && peer.disconnected && !peer.destroyed) { try { peer.reconnect(); } catch (e) { /* ignore */ } } }, 1500);
    });
  }

  let hostBeat = null;
  function startHosting(name) {
    if (!peerAvailable()) return;
    setBusy(true);
    homeMsg('Creating your room…', false);
    loadQuestions();
    const attempt = (n) => {
      const code = randomCode();
      const peer = new window.Peer(PEER_PREFIX + code, peerOptions());
      let opened = false;
      const timer = setTimeout(() => {
        if (!opened) { try { peer.destroy(); } catch (e) { /* ignore */ } setBusy(false); homeMsg('Could not reach the connection server. Check your internet and try again.'); }
      }, 15000);
      peer.on('open', () => {
        if (opened) return;            // 'open' fires again after a reconnect
        opened = true;
        clearTimeout(timer);
        net.peer = peer; net.role = 'host'; net.code = code; net.me = { pid: 'host', name };
        initHostState(name);
        H.setId = readSets().gameId;
        setBusy(false);
        homeMsg('');
        broadcast();
        hostBeat = setInterval(hostHeartbeat, PING_MS);
      });
      peer.on('connection', (conn) => { if (H) onHostConnection(conn); });
      watchSignaling(peer);
      peer.on('error', (err) => {
        if (!opened) {
          clearTimeout(timer);
          try { peer.destroy(); } catch (e) { /* ignore */ }
          if (err.type === 'unavailable-id' && n < 6) { attempt(n + 1); return; }
          setBusy(false);
          homeMsg('Could not create a room (' + (err.type || 'error') + '). Try again.');
        } else console.warn('Peer error', err);
      });
    };
    attempt(0);
  }

  /* ----- Client side ----- */
  const clientBox = {};
  let lastRev = -1;
  let lastHostMsg = 0;
  let clientBeat = null;
  let reconnecting = null;      // { since, timer } while trying to get back in

  function joinRoom(rawCode, name, quiet) {
    if (!peerAvailable()) return;
    const code = String(rawCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length !== 4) { homeMsg('Enter the 4-character room code.'); return; }
    setBusy(true);
    homeMsg((quiet ? 'Rejoining room ' : 'Looking for room ') + code + '…', false);
    const peer = new window.Peer(undefined, peerOptions());
    net.peer = peer; net.role = 'client'; net.code = code; net.me = { pid: getToken(), name };
    let connected = false;
    const fail = (text) => {
      try { peer.destroy(); } catch (e) { /* ignore */ }
      net.peer = null; net.hostConn = null; net.role = null;
      setBusy(false);
      if (quiet) session.del(SESS_ROOM);
      homeMsg(text);
    };
    const timer = setTimeout(() => { if (!connected) fail('Could not reach that room. Check the code and try again.'); }, 14000);
    peer.on('open', () => {
      if (connected || net.hostConn) return;
      connectToHost(() => { connected = true; clearTimeout(timer); });
    });
    watchSignaling(peer);
    peer.on('error', (err) => {
      if (!connected) {
        clearTimeout(timer);
        fail(err.type === 'peer-unavailable' ? 'Room ' + code + ' was not found. Check the code with your teacher.' : 'Connection problem (' + (err.type || 'error') + '). Try again.');
      } else if (reconnecting && err.type === 'peer-unavailable') {
        // The host's room is gone: keep trying until the reconnect window ends.
      } else console.warn('Peer error', err);
    });
  }

  function connectToHost(onOpen) {
    const conn = net.peer.connect(PEER_PREFIX + net.code, { reliable: true, serialization: 'json' });
    net.hostConn = conn;
    conn.on('open', () => {
      if (net.hostConn !== conn) return;
      session.set(SESS_ROOM, net.code);
      sendMsg(conn, { t: 'join', name: net.me.name, token: net.me.pid });
      lastHostMsg = Date.now();
      endReconnect();
      if (onOpen) onOpen();
      if (!clientBeat) {
        clientBeat = setInterval(() => {
          if (net.leaving || net.role !== 'client') return;
          if (net.hostConn && net.hostConn.open) sendMsg(net.hostConn, { t: 'ping' });
          if (!reconnecting && Date.now() - lastHostMsg > STALE_MS) startReconnect();
        }, PING_MS);
      }
    });
    conn.on('data', (msg) => {
      if (net.hostConn !== conn) return;
      if (msg && msg.t === 'part') receivePart(clientBox, msg, onClientData);
      else onClientData(msg);
    });
    conn.on('close', () => { if (net.hostConn === conn) startReconnect(); });
    conn.on('error', () => { if (net.hostConn === conn) startReconnect(); });
  }

  // A student whose connection drops keeps trying for RECONNECT_MS before giving up.
  function startReconnect() {
    if (net.leaving || net.role !== 'client') return;
    if (!S) { setBusy(false); homeMsg('Lost connection to the room.'); return; }
    if (reconnecting) return;
    reconnecting = { since: Date.now(), timer: null };
    $('#reconnectBar').classList.remove('hidden');
    const tryOnce = () => {
      if (!reconnecting || net.leaving) return;
      if (Date.now() - reconnecting.since > RECONNECT_MS) { endReconnect(); onHostLost(); return; }
      try {
        if (net.peer.destroyed) { onHostLost(); endReconnect(); return; }
        if (net.peer.disconnected) net.peer.reconnect();
        else {
          try { net.hostConn && net.hostConn.close(); } catch (e) { /* ignore */ }
          connectToHost();
        }
      } catch (e) { /* try again shortly */ }
      reconnecting.timer = setTimeout(tryOnce, 4000);
    };
    tryOnce();
  }
  function endReconnect() {
    if (reconnecting) clearTimeout(reconnecting.timer);
    reconnecting = null;
    $('#reconnectBar').classList.add('hidden');
  }
  function onHostLost() {
    if (net.leaving || net.role !== 'client') return;
    if (!S) { setBusy(false); homeMsg('Lost connection to the room.'); return; }
    session.del(SESS_ROOM);
    $('#lostHostModal').classList.remove('hidden');
  }

  function onClientData(msg) {
    if (!msg || typeof msg !== 'object') return;
    lastHostMsg = Date.now();
    if (msg.t === 'hb' || msg.t === 'welcome') return;
    if (msg.t === 'board') { boardData = msg.board ? cleanBoard(msg.board) : null; boardChanged(true); return; }
    if (msg.t === 'state' && msg.s && Number.isInteger(msg.s.rev)) {
      if (msg.s.rev <= lastRev) return;      // stale or duplicate
      lastRev = msg.s.rev;
      setBusy(false);
      homeMsg('');
      applyState(msg.s, {});
    } else if (msg.t === 'reject') {
      net.leaving = true;
      try { net.peer && net.peer.destroy(); } catch (e) { /* ignore */ }
      net.peer = null; net.hostConn = null; net.role = null; net.leaving = false;
      session.del(SESS_ROOM);
      setBusy(false);
      showScreen('home');
      homeMsg(msg.reason || 'Could not join that room.');
    }
  }

  /* ----- Player actions (same path for host and students) ----- */
  const myPid = () => net.me.pid;
  function actScan(idx) {
    if (net.role === 'host') hostScan('host', idx);
    else sendMsg(net.hostConn, { t: 'scan', idx });
  }
  function actAnswer(qid, a) {
    if (net.role === 'host') hostAnswer('host', { qid, a });
    else sendMsg(net.hostConn, { t: 'answer', qid, a });
  }
  function leaveGame() {
    if (net.role === 'host' && S && S.phase !== 'lobby' && !window.confirm('Leaving ends the game for everyone. Leave anyway?')) return;
    net.leaving = true;
    session.del(SESS_ROOM);
    try { net.peer && net.peer.destroy(); } catch (e) { /* ignore */ }
    window.location.href = window.location.pathname + window.location.search.replace(/([?&])room=[^&]*&?/, '$1').replace(/[?&]$/, '');
  }

  /* =========================================================
     RENDERING (the same for host and students, driven by snapshots)
     ========================================================= */
  let S = null;            // latest snapshot
  let S_extra = {};        // host-only extras
  let prevMsg = '';
  let seenEvent = null;
  let lastScanSeq = -1;

  function applyState(s, extra) {
    const prev = S;
    S = s;
    S_extra = extra || {};
    document.body.classList.toggle('big', !!s.big);
    if (s.phase === 'lobby') {
      showScreen('lobby');
      $('#qModal').classList.add('hidden');
      $('#endModal').classList.add('hidden');
      $('#eventSplash').classList.add('hidden');
      renderLobby();
      return;
    }
    showScreen('game');
    renderGame(prev);
  }

  function avatar(p) {
    const a = el('span', 'avatar', initial(p.name));
    a.style.background = p.color;
    a.setAttribute('aria-hidden', 'true');
    return a;
  }

  function fillSetSelect(sel, row) {
    const sets = S_extra.sets || [];
    row.classList.toggle('hidden', sets.length < 2);
    sel.replaceChildren();
    sets.forEach(x => { const o = el('option', '', x.name + ' (' + x.total + ')'); o.value = x.id; sel.append(o); });
    sel.value = S_extra.setId || '';
  }

  function renderLobby() {
    $('#roomCode').textContent = S.code;
    const isHost = net.role === 'host';
    const ul = $('#lobbyPlayers');
    ul.replaceChildren();
    S.players.forEach(p => {
      const li = el('li');
      li.append(avatar(p), el('span', '', p.name + (p.isHost ? ' (host)' : '') + (p.pid === myPid() ? ' (you)' : '')));
      ul.append(li);
    });
    if (!S.players.length) ul.append(el('li', '', 'Nobody yet. Share the code!'));
    const fac = $('#lobbyFacilitator');
    fac.classList.toggle('hidden', S.hostPlays);
    fac.textContent = S.hostPlays ? '' : S.hostName + ' is running the game.';
    $('#lobbyHostControls').classList.toggle('hidden', !isHost);
    $('#lobbyWaiting').classList.toggle('hidden', isHost);
    if (!isHost) return;
    fillSetSelect($('#optSet'), $('#optSetRow'));
    $('#optTarget').value = String(S.nextTarget);
    $('#optEvents').value = S.events;
    $('#optPower').value = S.power ? 'on' : 'off';
    $('#optBig').checked = !!S.big;
    $('#optHostPlays').checked = S.hostPlays;
    $('#optAutoContinue').checked = S.autoContinue;
    if (document.activeElement !== $('#optMessage')) $('#optMessage').value = H.message;
    const need = QUESTIONS_FOR[S.nextTarget];
    const qc = $('#lobbyQCount');
    const players = S.players.filter(p => p.connected).length;
    qc.textContent = '"' + S.setName + '": ' + plural(S.qCount, 'question') + ' ready. ' +
      (S.qCount < need ? 'Heads up: ' + S.nextTarget + ' parts works best with about ' + need + ' or more questions, so the team may run out. You can still play, or pick fewer parts.' : '') +
      (players ? '' : ' Waiting for players to join.');
    qc.classList.toggle('warn', S.qCount < need);
    $('#startBtn').disabled = !players || !S.qCount;
  }

  /* ----- Game screen ----- */
  function renderGame(prev) {
    $('#roomChip').textContent = S.code;
    renderDecoder();
    renderMap(prev);
    renderPanel();
    renderBanner();
    renderEvent();
    renderQuestion(prev);
    renderEnd(prev);
    updateBoardBtn();
    renderWbPanel();
  }

  function renderDecoder() {
    const msg = S.msg || '';
    const box = $('#message');
    box.replaceChildren();
    const chars = Array.from(msg);
    const old = Array.from(prevMsg);
    let word = el('span', 'word');
    chars.forEach((ch, i) => {
      if (ch === ' ') { if (word.childNodes.length) box.append(word); word = el('span', 'word'); return; }
      const hidden = ch === '•';
      const letter = /[\p{L}\p{N}]/u.test(ch);
      const t = el('span', 'ltr' + (hidden ? '' : letter ? ' on' : ' punct'), hidden ? '' : ch);
      if (letter && old[i] === '•') t.classList.add('new');
      word.append(t);
    });
    if (word.childNodes.length) box.append(word);
    const letters = chars.filter(c => c === '•' || /[\p{L}\p{N}]/u.test(c));
    const decoded = letters.filter(c => c !== '•').length;
    const pct = letters.length ? Math.round(decoded / letters.length * 100) : 0;
    box.setAttribute('aria-label', 'Alien message, ' + pct + ' percent decoded: ' + msg.replace(/•/g, '_'));
    $('#decoderText').textContent = pct >= 100 ? 'Message received!' : 'Signal ' + pct + '% decoded';
    const bars = Math.round(pct / 20);
    $$('#signalBars i').forEach((b, i) => b.classList.toggle('on', i < bars));
    prevMsg = msg;
  }

  function canScan() {
    if (!S || S.phase !== 'scan') return false;
    return S.turnPid === myPid() || net.role === 'host';
  }

  function renderMap(prev) {
    const map = $('#starMap');
    map.style.setProperty('--cols', S.cols);
    map.style.setProperty('--rows', Math.ceil(S.tiles.length / S.cols));
    if (map.children.length !== S.tiles.length) {
      map.replaceChildren();
      S.tiles.forEach((t, i) => {
        const b = el('button', 'tile');
        b.type = 'button';
        b.dataset.idx = i;
        b.addEventListener('click', () => {
          if (!canScan() || S.tiles[i]) return;
          $$('#starMap .tile').forEach(x => x.classList.remove('can'));
          actScan(i);
        });
        map.append(b);
      });
    }
    const can = canScan();
    S.tiles.forEach((t, i) => {
      const b = map.children[i];
      const wasOpen = prev && prev.tiles && prev.tiles.length === S.tiles.length && prev.tiles[i];
      b.className = 'tile';
      b.replaceChildren();
      const scanning = S.phase === 'scanning' && S.scan.idx === i;
      if (!t) {
        if (can) b.classList.add('can');
        if (scanning) b.classList.add('scanning');
        b.setAttribute('aria-label', 'Unscanned tile ' + (i + 1) + (can ? '. Tap to scan.' : ''));
        b.disabled = !can && !scanning;
        return;
      }
      b.disabled = true;
      let ico = '✨', lbl = 'Stardust';
      if (t.k === 'part') { b.classList.add('part'); ico = PARTS[t.p % PARTS.length].e; lbl = PARTS[t.p % PARTS.length].n; }
      else if (t.k === 'event') { b.classList.add('event'); ico = t.ev || '❓'; lbl = 'Surprise'; }
      else b.classList.add('empty');
      if (!wasOpen && prev && prev.phase !== 'lobby') b.classList.add('flip');
      b.append(el('span', 't-ico', ico), el('span', 't-lbl', lbl));
      const p = S.players.find(x => x.pid === t.by);
      if (p) { const w = el('span', 'who', initial(p.name)); w.style.background = p.color; w.setAttribute('aria-hidden', 'true'); b.append(w); }
      b.setAttribute('aria-label', 'Tile ' + (i + 1) + ': ' + lbl + (p ? ', scanned by ' + p.name : ''));
    });
  }

  function renderBanner() {
    const b = $('#turnBanner');
    const cur = S.players.find(p => p.pid === S.turnPid);
    const mine = S.turnPid === myPid();
    let text = '';
    b.classList.toggle('mine', S.phase === 'scan' && mine);
    if (S.phase === 'scan') {
      if (mine) text = 'Your turn! Tap a dark tile to scan it.';
      else if (cur) text = cur.name + ' is choosing a tile…' + (net.role === 'host' ? ' (You can tap one for them.)' : '');
      else text = 'Tap a tile to scan.';
    } else if (S.phase === 'scanning') text = '📡 Scanning…';
    else if (S.phase === 'found' && S.found) {
      text = S.found.kind === 'part' ? S.found.name + ' found a ' + PARTS[S.found.part % PARTS.length].e + ' ' + PARTS[S.found.part % PARTS.length].n + '!'
        : S.found.kind === 'event' ? 'A surprise!' : 'Just stardust this time.';
    } else if (S.phase === 'event') text = 'A surprise!';
    else if (S.phase === 'question') text = 'Everyone answer the question!';
    else if (S.phase === 'reveal') text = 'Let\'s see how the crew did…';
    else if (S.phase === 'won') text = 'Message received! 🎉';
    else if (S.phase === 'lost') text = 'The signal window closed.';
    b.textContent = text;
  }

  function renderPanel() {
    const slots = $('#partSlots');
    if (slots.children.length !== S.target) {
      slots.replaceChildren();
      for (let i = 0; i < S.target; i++) slots.append(el('div', 'slot'));
    }
    Array.from(slots.children).forEach((d, i) => {
      const p = S.repaired[i];
      const on = p !== undefined;
      if (on && !d.classList.contains('on')) { d.classList.add('on'); d.textContent = PARTS[p % PARTS.length].e; }
      if (!on && d.classList.contains('on')) { d.classList.remove('on'); d.textContent = ''; }
      if (on) d.textContent = PARTS[p % PARTS.length].e;
    });
    $('#partCount').textContent = Math.min(S.repaired.length, S.target);
    $('#partTotal').textContent = S.target;

    $('#powerCard').classList.toggle('hidden', !S.power);
    $$('#powerMeter i').forEach((m, i) => m.classList.toggle('on', i < S.meter));

    $('#deckLeft').textContent = S.deckLeft;
    const pct = S.totalQ ? Math.min(100, S.deckLeft / S.totalQ * 100) : 0;
    $('#deckBar').style.width = pct + '%';
    $('#deckBar').classList.toggle('low', S.deckLeft <= 3);

    const ul = $('#playerList');
    ul.replaceChildren();
    const inQ = S.phase === 'question';
    S.players.forEach(p => {
      const li = el('li', (p.pid === S.turnPid ? 'turn ' : '') + (p.connected ? '' : 'off'));
      li.append(avatar(p), el('span', '', p.name + (p.pid === myPid() ? ' (you)' : '')));
      let tag = '';
      if (!p.connected) tag = 'away';
      else if (inQ) tag = S.answered.includes(p.pid) ? '✓ answered' : 'thinking…';
      else if (p.pid === S.turnPid && S.phase === 'scan') tag = 'scanning';
      if (tag) li.append(el('span', 'tag' + (tag.startsWith('✓') ? ' done' : ''), tag));
      ul.append(li);
    });
    if (!S.hostPlays) ul.append(el('li', 'off', S.hostName + ' (host, not playing)'));

    const log = $('#logList');
    log.replaceChildren();
    S.log.slice().reverse().forEach(t => log.append(el('li', '', t)));

    const isHost = net.role === 'host';
    $('#hostControls').classList.toggle('hidden', !isHost);
    if (isHost) {
      $('#hcAutoContinue').checked = S.autoContinue;
      $('#hcProjector').checked = !!S_extra.projector;
      fillSetSelect($('#hcSet'), $('#hcSetRow'));
      $('#hcTarget').value = String(S.nextTarget);
      $('#hcEvents').value = S.events;
      $('#hcNext').disabled = S.phase !== 'reveal';
    }
  }

  function renderEvent() {
    const sp = $('#eventSplash');
    if (S.phase !== 'event' || !S.event) { sp.classList.add('hidden'); return; }
    if (seenEvent === S.event.id && !sp.classList.contains('hidden')) return;
    seenEvent = S.event.id;
    $('#eventEmoji').textContent = S.event.emoji;
    $('#eventTitle').textContent = S.event.title;
    $('#eventText').textContent = S.event.text;
    $('#eventCard').classList.toggle('good', S.event.good);
    sp.classList.remove('hidden');
  }

  function renderEnd(prev) {
    const m = $('#endModal');
    const over = S.phase === 'won' || S.phase === 'lost';
    if (!over) { m.classList.add('hidden'); return; }
    const won = S.phase === 'won';
    const firstTime = !prev || prev.phase !== S.phase;
    $('#endIcon').textContent = won ? '📡' : '🌌';
    $('#endTitle').textContent = won ? 'Signal restored!' : 'The signal window closed';
    $('#endMsg').textContent = won ? 'Your crew repaired every part. Here is the message from the stars:' : 'So close! Here is the part of the message you decoded:';
    const em = $('#endMessage');
    em.replaceChildren(...Array.from($('#message').childNodes).map(n => n.cloneNode(true)));
    $('#endStats').textContent = 'Parts repaired: ' + Math.min(S.repaired.length, S.target) + ' of ' + S.target + ' · Questions answered: ' + (S.totalQ ? S.totalQ - S.deckLeft : 0);
    const isHost = net.role === 'host';
    $('#endHostOpts').classList.toggle('hidden', !isHost);
    $('#playAgainBtn').classList.toggle('hidden', !isHost);
    $('#endReportBtn').classList.toggle('hidden', !isHost);
    $('#endWaiting').classList.toggle('hidden', isHost);
    if (isHost) {
      fillSetSelect($('#endSet'), $('#endSetRow'));
      $('#endTarget').value = String(S.nextTarget);
      $('#endEvents').value = S.events;
    }
    m.classList.remove('hidden');
    $('#qModal').classList.add('hidden');
    if (won && firstTime) launchConfetti();
  }

  function launchConfetti() {
    if (reduceMotion()) return;
    const box = $('#confetti');
    box.replaceChildren();
    const colors = ['#ffd23f', '#2ee6a8', '#ff6f59', '#5ec8ff', '#b88cff'];
    for (let i = 0; i < 90; i++) {
      const c = el('i');
      c.style.left = Math.random() * 100 + 'vw';
      c.style.background = colors[i % colors.length];
      c.style.animationDuration = (2.2 + Math.random() * 2) + 's';
      c.style.animationDelay = Math.random() * .8 + 's';
      box.append(c);
    }
    setTimeout(() => box.replaceChildren(), 5200);
  }

  /* =========================================================
     SHARED CORE — the question card (all seven types)
     ========================================================= */
  const HOW = {
    choice: 'Pick one answer.',
    tf: 'Is it true or false?',
    typed: 'Type your answer, then lock it in.',
    bank: 'Tap a word, then tap a blank. You can also drag words.',
    order: 'Tap an item, then tap its spot (1 is first). You can also drag.',
    match: 'Tap an answer, then tap where it matches. You can also drag.',
    sort: 'Tap an item, then tap its group. You can also drag.'
  };
  const PLACE_TYPES = ['bank', 'order', 'match', 'sort'];
  let qView = { qid: null, choice: null, text: '', place: [], selected: -1, sent: false, bodyKey: '' };

  const amPlayer = () => !!S && S.players.some(p => p.pid === myPid());
  function canAnswer() {
    return !!S && S.phase === 'question' && !!S.question && amPlayer() && !S.mine && !qView.sent;
  }

  function placeFromAnswer(pub, ans) {
    const n = pub.type === 'order' ? pub.items.length : pub.chips.length;
    const place = Array(n).fill(-1);
    if (!ans) return place;
    if (pub.type === 'bank') ans.fill.forEach((c, z) => { place[c] = z; });
    else if (pub.type === 'order') ans.order.forEach((it, z) => { place[it] = z; });
    else ans.place.forEach((z, i) => { place[i] = z; });
    return place;
  }
  function zoneCount(pub) {
    return pub.type === 'bank' ? pub.blanks : pub.type === 'order' ? pub.items.length : pub.type === 'match' ? pub.lefts.length : pub.bins.length;
  }
  function answerFromPlace(pub, place) {
    const zones = [...Array(zoneCount(pub)).keys()];
    if (pub.type === 'bank') return { fill: zones.map(z => place.indexOf(z)) };
    if (pub.type === 'order') return { order: zones.map(z => place.indexOf(z)) };
    return { place: place.slice() };
  }
  function placeReady(pub, place) {
    if (pub.type === 'sort') return place.every(z => z >= 0);
    return [...Array(zoneCount(pub)).keys()].every(z => place.includes(z));
  }
  // Right/wrong marks for each item, from the student's own result.
  function itemMarks(pub, mine) {
    if (!mine || !mine.detail) return null;
    const marks = Array((pub.type === 'order' ? pub.items : pub.chips).length).fill(null);
    if (pub.type === 'bank') mine.ans.fill.forEach((c, z) => { marks[c] = mine.detail[z]; });
    else if (pub.type === 'order') mine.ans.order.forEach((it, z) => { marks[it] = mine.detail[z]; });
    else mine.detail.forEach((ok, i) => { marks[i] = ok; });
    return marks;
  }

  function renderQuestion(prev) {
    const m = $('#qModal');
    const show = (S.phase === 'question' || S.phase === 'reveal') && S.question;
    if (!show) { m.classList.add('hidden'); qView.qid = null; stopSpeaking(); return; }
    const pub = S.question;
    if (qView.qid !== pub.id) {
      qView = { qid: pub.id, choice: null, text: '', place: PLACE_TYPES.includes(pub.type) ? placeFromAnswer(pub, null) : [], selected: -1, sent: false, bodyKey: '' };
      stopSpeaking();
    }
    if (S.mine) qView.sent = false;   // the host confirmed it; S.mine is now the truth
    const isHost = net.role === 'host';
    const reveal = S.phase === 'reveal' ? S.reveal : null;
    const locked = !canAnswer();

    $('#qMeta').textContent = 'Question ' + pub.num + ' · ' + TYPE_LABEL[pub.type] + (S.paused ? ' · Paused by teacher' : '');
    const f = S.found;
    $('#qFound').textContent = !f ? '' : f.kind === 'part' ? f.name + ' found a ' + PARTS[f.part % PARTS.length].e + ' ' + PARTS[f.part % PARTS.length].n + '! Now everyone answers:'
      : f.kind === 'event' ? 'After that surprise, everyone answers:' : f.name + ' found stardust. Everyone answers:';
    $('#qText').textContent = pub.type === 'bank' ? 'Fill in the blanks.' : pub.text;
    $('#qHow').textContent = locked ? '' : HOW[pub.type];
    $('#qRead').classList.toggle('hidden', !('speechSynthesis' in window));

    // Rebuild the answer area only when something important changes, so typing is never interrupted.
    const key = pub.id + '|' + S.phase + '|' + locked + '|' + (S.mine ? 'm' : '') + '|' + (reveal ? 'r' : '');
    if (qView.bodyKey !== key) { qView.bodyKey = key; buildBody(pub, locked, reveal); }

    const answeredN = S.answered.length;
    const need = S.players.filter(p => p.connected).length;
    $('#qAnswerArea').classList.toggle('hidden', locked);
    updateSubmit();
    const wait = $('#qWait');
    if (S.phase === 'question' && (S.mine || qView.sent)) { wait.textContent = 'Answer locked in! Waiting for ' + Math.max(0, need - answeredN) + ' more…'; wait.classList.remove('hidden'); }
    else if (S.phase === 'question' && !amPlayer()) { wait.textContent = 'Answers in: ' + answeredN + ' of ' + need; wait.classList.remove('hidden'); }
    else wait.classList.add('hidden');

    const prog = $('#qProgress');
    prog.replaceChildren();
    if (S.phase === 'question') {
      S.players.filter(p => p.connected).forEach(p => prog.append(el('li', S.answered.includes(p.pid) ? 'done' : '', (S.answered.includes(p.pid) ? '✓ ' : '… ') + p.name)));
    }

    renderHostView($('#qHostView'));
    renderReveal(pub, reveal);

    $('#qWhiteboard').classList.toggle('hidden', !isHost);
    $('#qSkip').classList.toggle('hidden', !(isHost && S.phase === 'question'));
    $('#qContinue').classList.toggle('hidden', !(isHost && S.phase === 'reveal'));
    const wasHidden = m.classList.contains('hidden');
    m.classList.remove('hidden');
    if (wasHidden && !locked) {
      const first = pub.type === 'typed' ? $('#qBody input') : null;
      if (first && window.matchMedia('(pointer: fine)').matches) setTimeout(() => first.focus(), 60);
    }
  }

  function buildBody(pub, locked, reveal) {
    const body = $('#qBody');
    body.replaceChildren();
    const mine = S.mine;
    if (pub.type === 'choice' || pub.type === 'tf') {
      const wrap = el('div', 'choices' + (pub.type === 'tf' ? ' tf-row' : ''));
      wrap.setAttribute('role', 'group');
      wrap.setAttribute('aria-label', 'Answer choices');
      const picked = mine ? mine.ans.choice : qView.choice;
      pub.choices.forEach((txt, i) => {
        const b = el('button', 'choice');
        b.type = 'button';
        if (pub.type === 'choice') b.append(el('span', 'letter', LETTERS[i]));
        b.append(el('span', '', txt));
        if (picked === i) b.classList.add('sel');
        if (reveal) {
          if (reveal.key.idx === i) b.classList.add('correct');
          else if (picked === i) b.classList.add('wrong');
        }
        b.disabled = locked;
        b.setAttribute('aria-pressed', String(picked === i));
        b.addEventListener('click', () => { if (!canAnswer()) return; qView.choice = i; qView.bodyKey = ''; renderQuestion(); });
        wrap.append(b);
      });
      body.append(wrap);
      return;
    }
    if (pub.type === 'typed') {
      const inp = el('input', 'typed-input');
      inp.type = 'text';
      inp.maxLength = 80;
      inp.autocomplete = 'off';
      inp.spellcheck = false;
      inp.setAttribute('aria-label', 'Your answer');
      inp.placeholder = 'Type your answer';
      inp.value = mine ? mine.ans.text : qView.text;
      inp.disabled = locked;
      if (reveal && mine) inp.style.borderColor = mine.ok ? 'var(--good)' : 'var(--bad)';
      inp.addEventListener('input', () => { qView.text = inp.value; updateSubmit(); });
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submitAnswer(); } });
      body.append(inp);
      return;
    }
    const place = mine ? placeFromAnswer(pub, mine.ans) : qView.place;
    renderPlace(body, pub, place, { locked, marks: reveal ? itemMarks(pub, mine) : null });
  }

  /* ----- Tap-to-place and drag (word bank, order, match, sort) ----- */
  let drag = null;           // { i, x, y, ghost, moved }
  let suppressClick = false;

  function renderPlace(body, pub, place, opts) {
    const items = pub.type === 'order' ? pub.items : pub.chips;
    const cap1 = pub.type !== 'sort';
    const chip = (i) => {
      const b = el('button', 'chip', items[i]);
      b.type = 'button';
      b.dataset.item = i;
      if (qView.selected === i && !opts.locked) b.classList.add('sel');
      if (opts.marks && opts.marks[i] === true) { b.classList.add('ok'); b.textContent = '✓ ' + items[i]; }
      if (opts.marks && opts.marks[i] === false) { b.classList.add('no'); b.textContent = '✗ ' + items[i]; }
      b.disabled = opts.locked;
      b.setAttribute('aria-pressed', String(qView.selected === i));
      if (!opts.locked) {
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          if (suppressClick) { suppressClick = false; return; }
          const sel = qView.selected;
          if (sel >= 0 && sel !== i && qView.place[i] >= 0) {
            // Something is already picked up: tapping an item in a spot means "put it here".
            moveItem(pub, sel, qView.place[i]);
            qView.selected = -1;
          } else qView.selected = sel === i ? -1 : i;
          redrawPlace();
        });
        b.addEventListener('pointerdown', (e) => startDrag(e, i, b));
      }
      return b;
    };
    const zone = (z, cls, label) => {
      const d = el('button', 'zone ' + cls);
      d.type = 'button';
      d.dataset.zone = z;
      d.setAttribute('aria-label', label);
      if (qView.selected >= 0 && !opts.locked) d.classList.add('ready');
      d.disabled = opts.locked;
      place.forEach((pz, i) => { if (pz === z) d.append(chip(i)); });
      if (!opts.locked) d.addEventListener('click', () => {
        if (suppressClick) { suppressClick = false; return; }
        if (qView.selected >= 0) { moveItem(pub, qView.selected, z); qView.selected = -1; redrawPlace(); }
        else if (cap1) { const occ = place.indexOf(z); if (occ >= 0) { qView.selected = occ; redrawPlace(); } }
      });
      return d;
    };
    const tray = el('div', 'tray');
    tray.dataset.tray = '1';
    tray.append(el('span', 'tray-label', pub.type === 'bank' ? 'Word choices' : opts.locked ? '' : 'Tap or drag these'));
    place.forEach((z, i) => { if (z < 0) tray.append(chip(i)); });
    if (!opts.locked) tray.addEventListener('click', () => {
      if (qView.selected >= 0 && place[qView.selected] >= 0) { moveItem(pub, qView.selected, -1); qView.selected = -1; redrawPlace(); }
    });

    if (pub.type === 'bank') {
      const s = el('div', 'sentence');
      pub.parts.forEach(part => {
        if (typeof part === 'string') s.append(document.createTextNode(part));
        else s.append(zone(part.b, 'blank', 'Blank ' + (part.b + 1)));
      });
      body.append(s, tray);
    } else if (pub.type === 'order') {
      const list = el('div', 'order-list');
      pub.items.forEach((_, z) => {
        const row = el('div', 'order-row');
        row.append(el('span', 'order-num', String(z + 1)), zone(z, '', 'Spot ' + (z + 1)));
        list.append(row);
      });
      body.append(tray, list);
    } else if (pub.type === 'match') {
      const list = el('div', 'match-list');
      pub.lefts.forEach((l, z) => {
        const row = el('div', 'match-row');
        row.append(el('div', 'match-left', l), zone(z, '', 'Match for ' + l));
        list.append(row);
      });
      body.append(tray, list);
    } else {
      const bins = el('div', 'bins');
      pub.bins.forEach((name, z) => {
        const d = zone(z, 'bin', 'Group ' + name);
        const items = el('div', 'bin-items');
        Array.from(d.querySelectorAll('.chip')).forEach(c => items.append(c));
        d.prepend(el('span', 'bin-name', name));
        d.append(items);
        bins.append(d);
      });
      body.append(tray, bins);
    }
  }

  function redrawPlace() {
    if (!S || !S.question) return;
    $('#qBody').replaceChildren();
    renderPlace($('#qBody'), S.question, qView.place, { locked: !canAnswer(), marks: null });
    updateSubmit();
  }

  function moveItem(pub, i, z) {
    const place = qView.place;
    if (z < 0) { place[i] = -1; return; }
    if (pub.type !== 'sort') {
      const occ = place.findIndex((v, k) => v === z && k !== i);
      if (occ >= 0) place[occ] = place[i];      // swap with whatever was there
    }
    place[i] = z;
  }

  function startDrag(e, i, chipEl) {
    if (e.button > 0 || !canAnswer()) return;
    drag = { i, x: e.clientX, y: e.clientY, ghost: null, chipEl, over: null };
    try { chipEl.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    chipEl.addEventListener('pointermove', onDragMove);
    chipEl.addEventListener('pointerup', onDragEnd);
    chipEl.addEventListener('pointercancel', onDragEnd);
  }
  function dropTarget(x, y) {
    const t = document.elementFromPoint(x, y);
    return t ? t.closest('[data-zone], [data-tray]') : null;
  }
  function onDragMove(e) {
    if (!drag) return;
    if (!drag.ghost) {
      if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) < 8) return;
      drag.ghost = drag.chipEl.cloneNode(true);
      drag.ghost.classList.add('drag-ghost');
      document.body.append(drag.ghost);
    }
    drag.ghost.style.left = (e.clientX - 30) + 'px';
    drag.ghost.style.top = (e.clientY - 24) + 'px';
    const t = dropTarget(e.clientX, e.clientY);
    if (drag.over && drag.over !== t) drag.over.classList.remove('over');
    if (t) t.classList.add('over');
    drag.over = t;
  }
  function onDragEnd(e) {
    const d = drag;
    drag = null;
    if (!d) return;
    d.chipEl.removeEventListener('pointermove', onDragMove);
    d.chipEl.removeEventListener('pointerup', onDragEnd);
    d.chipEl.removeEventListener('pointercancel', onDragEnd);
    if (!d.ghost) return;                      // a plain tap: the click handler takes over
    d.ghost.remove();
    if (d.over) d.over.classList.remove('over');
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    if (e.type === 'pointercancel' || !canAnswer()) return;
    const t = dropTarget(e.clientX, e.clientY);
    if (!t) return;
    moveItem(S.question, d.i, t.dataset.zone !== undefined ? Number(t.dataset.zone) : -1);
    qView.selected = -1;
    redrawPlace();
  }

  function updateSubmit() {
    if (!S || !S.question) return;
    const pub = S.question;
    let ready = false;
    if (pub.type === 'choice' || pub.type === 'tf') ready = qView.choice !== null;
    else if (pub.type === 'typed') ready = !!cleanText(qView.text, 80);
    else ready = placeReady(pub, qView.place);
    $('#qSubmit').disabled = !ready || !canAnswer();
    $('#qReset').classList.toggle('hidden', !PLACE_TYPES.includes(pub.type) || !canAnswer());
  }

  function submitAnswer() {
    if (!canAnswer()) return;
    const pub = S.question;
    let a = null;
    if (pub.type === 'choice' || pub.type === 'tf') { if (qView.choice !== null) a = { choice: qView.choice }; }
    else if (pub.type === 'typed') { const t = cleanText(qView.text, 80); if (t) a = { text: t }; }
    else if (placeReady(pub, qView.place)) a = answerFromPlace(pub, qView.place);
    if (!a) return;
    qView.sent = true;
    qView.bodyKey = '';
    actAnswer(pub.id, a);
    if (net.role !== 'host') renderQuestion();
  }

  // Host's own view: the answer key and who answered what (hidden in projector-safe mode).
  function renderHostView(box) {
    box.replaceChildren();
    const isHost = net.role === 'host';
    box.classList.toggle('hidden', !isHost);
    if (!isHost || !S.question) return;
    const reveal = S.phase === 'reveal';
    const tog = el('button', 'btn small ghost', S_extra.projector ? '👁 Show names and answers' : '🔒 Hide names (projector-safe)');
    tog.type = 'button';
    tog.className += ' pv-toggle';
    tog.addEventListener('click', hostOnly(() => { H.projector = !H.projector; broadcast(); }));
    box.append(tog);
    if (S_extra.projector) {
      box.append(el('div', '', 'Projector-safe is on: student names and answers are hidden on this screen.'));
      return;
    }
    if (!reveal && !amPlayer() && S_extra.keyText) box.append(el('div', 'key', 'Answer: ' + S_extra.keyText));
    const picks = S_extra.picks || {};
    const showMarks = reveal || !amPlayer();
    const ul = el('ul');
    S.players.forEach(p => {
      const li = el('li');
      const pk = picks[p.pid];
      li.append(el('strong', '', p.name + ': '));
      if (!pk) li.append(el('span', '', p.connected ? 'no answer yet' : 'away'));
      else {
        if (showMarks) li.append(el('span', pk.ok ? 'ok' : 'no', pk.ok ? '✓ ' : '✗ '));
        li.append(el('span', '', pk.text));
      }
      ul.append(li);
    });
    box.append(el('h4', '', 'Who answered what (only you see this)'), ul);
  }

  function correctAnswerNode(pub, key) {
    const box = el('div', 'ans-box');
    if (pub.type === 'bank') {
      const s = el('div');
      pub.parts.forEach(part => { if (typeof part === 'string') s.append(document.createTextNode(part)); else s.append(el('u', '', key.answers[part.b])); });
      box.append(s);
    } else if (pub.type === 'order') {
      const ol = el('ol');
      key.correct.forEach(t => ol.append(el('li', '', t)));
      box.append(ol);
    } else if (pub.type === 'match') {
      pub.lefts.forEach((l, z) => box.append(el('div', '', l + ' → ' + pub.chips[key.home.indexOf(z)])));
    } else if (pub.type === 'sort') {
      pub.bins.forEach((b, z) => box.append(el('div', '', b + ': ' + pub.chips.filter((_, i) => key.home[i] === z).join(', '))));
    } else box.textContent = pub.type === 'typed' ? key.accept.join('  or  ') : key.text;
    return box;
  }

  let countdownFor = null;
  function renderReveal(pub, reveal) {
    const box = $('#qReveal');
    if (!reveal) { box.classList.add('hidden'); countdownFor = null; return; }
    box.classList.remove('hidden');
    const v = $('#qVerdict');
    const mine = S.mine;
    v.className = 'q-verdict';
    if (mine) {
      if (mine.ok) { v.textContent = '✅ You got it!'; v.classList.add('good'); }
      else if (mine.detail && mine.score > 0) { v.textContent = '⭐ You got ' + Math.round(mine.score * mine.detail.length) + ' of ' + mine.detail.length + ' right!'; v.classList.add('bad'); }
      else { v.textContent = '💫 Not this time. Here is the answer:'; v.classList.add('bad'); }
    } else v.textContent = amPlayer() ? 'You didn\'t answer this one.' : 'Answer';
    const c = $('#qCorrect');
    c.replaceChildren(el('span', '', pub.type === 'typed' ? 'Accepted answer:' : 'Correct answer:'), correctAnswerNode(pub, reveal.key));
    // Only the host sees how many got it, and only with projector-safe off.
    const rc = S_extra.revealCount;
    let team = net.role === 'host' && !S_extra.projector && rc && rc.total ? 'Team: ' + rc.right + ' of ' + rc.total + ' got it (only you see this).' : '';
    if (reveal.power) team += reveal.bonus !== null && reveal.bonus !== undefined ? '  ⚡ Team Power full! Bonus part: ' + PARTS[reveal.bonus % PARTS.length].e + ' ' + PARTS[reveal.bonus % PARTS.length].n + '!' : '  ⚡ Team Power +1!';
    $('#qTeam').textContent = team;
    const cd = $('#qCountdown');
    const run = S.autoContinue && !S.paused;
    cd.classList.toggle('hidden', !run);
    if (run && countdownFor !== pub.id) {
      countdownFor = pub.id;
      cd.classList.remove('run');
      cd.style.setProperty('--dur', REVEAL_MS / 1000 + 's');
      void cd.offsetWidth;
      cd.classList.add('run');
    }
    if (!run) countdownFor = null;
  }

  /* ----- Read aloud (uses the device's built-in voice, no internet needed) ----- */
  function speakText(pub) {
    const parts = [];
    if (pub.type === 'bank') {
      parts.push('Fill in the blanks.', pub.parts.map(p => (typeof p === 'string' ? p : ' blank ')).join(''), 'Word choices: ' + pub.chips.join(', ') + '.');
    } else {
      parts.push(pub.text.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' '));
      if (pub.type === 'choice') pub.choices.forEach((c, i) => parts.push(LETTERS[i] + '. ' + c + '.'));
      if (pub.type === 'tf') parts.push('True, or false?');
      if (pub.type === 'order') parts.push('Put these in order: ' + pub.items.join(', ') + '.');
      if (pub.type === 'match') parts.push('Match these: ' + pub.lefts.join(', ') + '. With: ' + pub.chips.join(', ') + '.');
      if (pub.type === 'sort') parts.push('Groups: ' + pub.bins.join(', ') + '. Items: ' + pub.chips.join(', ') + '.');
    }
    return parts.join(' ');
  }
  function speak() {
    if (!('speechSynthesis' in window) || !S || !S.question) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(speakText(S.question));
      u.rate = 0.9;
      window.speechSynthesis.speak(u);
    } catch (e) { toast('Read aloud is not available on this device.'); }
  }
  function stopSpeaking() { try { if ('speechSynthesis' in window) window.speechSynthesis.cancel(); } catch (e) { /* ignore */ } }

  /* =========================================================
     SHARED CORE — PIN and Teacher Mode
     ========================================================= */
  let pinFails = 0, pinLockedUntil = 0, pinPurpose = 'teacher', pendingHostName = '';
  let editingId = null;

  function openPin(purpose = 'teacher', hostName = '') {
    if (!$('#teacherModal').classList.contains('hidden') || !$('#pinModal').classList.contains('hidden')) return;
    pinPurpose = purpose;
    pendingHostName = hostName;
    $('#pinTitle').textContent = purpose === 'host' ? 'Teacher PIN needed to host' : 'Teacher mode';
    const wait = Math.ceil((pinLockedUntil - Date.now()) / 1000);
    $('#pinMsg').textContent = wait > 0 ? 'Too many tries. Wait ' + wait + ' seconds.' : '';
    $('#pinMsg').classList.toggle('error', wait > 0);
    $('#pinInput').value = '';
    $('#pinModal').classList.remove('hidden');
    setTimeout(() => $('#pinInput').focus(), 30);
  }
  function closePin() { $('#pinModal').classList.add('hidden'); $('#pinInput').value = ''; pinPurpose = 'teacher'; pendingHostName = ''; }
  function submitPin() {
    const now = Date.now();
    if (now < pinLockedUntil) {
      $('#pinMsg').textContent = 'Too many tries. Wait ' + Math.ceil((pinLockedUntil - now) / 1000) + ' seconds.';
      $('#pinMsg').classList.add('error');
      return;
    }
    if ($('#pinInput').value.trim() === TEACHER_PIN) {
      pinFails = 0;
      const purpose = pinPurpose, name = pendingHostName;
      closePin();
      if (purpose === 'host') startHosting(name); else openTeacher();
    } else {
      pinFails++;
      $('#pinInput').value = '';
      $('#pinMsg').classList.add('error');
      if (pinFails >= 5) { pinFails = 0; pinLockedUntil = now + 30000; $('#pinMsg').textContent = 'Too many tries. Wait 30 seconds.'; }
      else $('#pinMsg').textContent = 'That PIN is not right.';
      $('#pinInput').focus();
    }
  }

  function openTeacher() {
    loadQuestions();
    editingId = null;
    resetForm();
    renderTeacher();
    $('#teacherModal').classList.remove('hidden');
  }
  function closeTeacher() {
    $('#teacherModal').classList.add('hidden');
    if (H && H.phase === 'lobby') broadcast();
  }

  /* ----- The add/edit form: one "row" per question, like the template ----- */
  const FORM = {
    choice: { q: 'Question', hint: 'Answer 1 is the correct answer. Add 1 to 3 wrong answers. Students see them in a mixed-up order.', labels: ['Correct answer', 'Wrong answer', 'Wrong answer (optional)', 'Wrong answer (optional)'] },
    tf: { q: 'Statement', hint: 'Students decide whether the statement is true or false.', labels: [] },
    typed: { q: 'Question', hint: 'Students type their answer. Capital letters, extra spaces and end punctuation don\'t matter, and numbers are checked as numbers (4.0 = 4). Spelling must match one of your accepted answers, so list other spellings you\'ll accept.', labels: ['Accepted answer', 'Also accept (optional)', 'Also accept (optional)', 'Also accept (optional)', 'Also accept (optional)', 'Also accept (optional)'] },
    bank: { q: 'Sentence: put [brackets] around each answer word', hint: 'Example: The [sun] is a [star]. Each bracketed word becomes a blank, and its word goes in the word bank. Add extra decoy words below if you like.', labels: ['Extra word (optional)', 'Extra word (optional)', 'Extra word (optional)', 'Extra word (optional)'] },
    order: { q: 'Question', hint: 'Type 3 to 6 items in the CORRECT order. Students see them mixed up.', labels: ['1st', '2nd', '3rd', '4th (optional)', '5th (optional)', '6th (optional)'] },
    match: { q: 'Question', hint: 'Type each pair as left = right, for example: cat = kitten. Students drag the right sides to match the left sides.', labels: ['Pair', 'Pair', 'Pair (optional)', 'Pair (optional)', 'Pair (optional)', 'Pair (optional)'], ph: 'cat = kitten' },
    sort: { q: 'Question', hint: 'Type each group as Group name: item, item, item (2 to 4 groups, up to 12 items in all).', labels: ['Group', 'Group', 'Group (optional)', 'Group (optional)'], ph: 'Mammals: dog, whale, bat' }
  };

  function drawFormFields(type, values) {
    const f = FORM[type];
    $('#tQLabel').textContent = f.q;
    $('#tHint').textContent = f.hint;
    const box = $('#tAnswers');
    box.replaceChildren();
    if (type === 'tf') {
      const lab = el('label', 'select-row');
      lab.append(el('span', '', 'The statement is'));
      const s = el('select');
      s.id = 'tTF';
      ['True', 'False'].forEach(v => { const o = el('option', '', v); o.value = v; s.append(o); });
      s.value = values[0] === 'False' ? 'False' : 'True';
      lab.append(s);
      box.append(lab);
      return;
    }
    f.labels.forEach((label, i) => {
      const inp = el('input', type === 'choice' && i === 0 ? 'good' : '');
      inp.type = 'text';
      inp.maxLength = 120;
      inp.placeholder = f.ph || label;
      inp.setAttribute('aria-label', label + ' ' + (i + 1));
      inp.value = values[i] || '';
      box.append(inp);
    });
  }
  // Reads whatever answer fields are on screen right now.
  function formValues() {
    const tf = $('#tTF');
    if (tf) return [tf.value];
    return $$('#tAnswers input').map(i => i.value);
  }
  function resetForm() {
    editingId = null;
    $('#tForm').classList.remove('editing');
    $('#tFormTitle').textContent = 'Add a question';
    $('#tSave').textContent = 'Add question';
    $('#tCancelEdit').classList.add('hidden');
    $('#tQ').value = '';
    drawFormFields($('#tType').value, []);
  }
  function startEdit(q) {
    const r = toRow(q);
    editingId = q.id;
    $('#tType').value = r.type;
    $('#tQ').value = r.q;
    drawFormFields(r.type, r.ans);
    $('#tForm').classList.add('editing');
    $('#tFormTitle').textContent = 'Edit question';
    $('#tSave').textContent = 'Save changes';
    $('#tCancelEdit').classList.remove('hidden');
    $('#tForm').scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
    $('#tQ').focus();
  }
  function saveForm() {
    const res = buildQuestion($('#tType').value, $('#tQ').value, formValues(), editingId || undefined);
    if (res.error) { toast(res.error, 5000); return; }
    if (editingId) {
      const i = questions.findIndex(x => x.id === editingId);
      if (i >= 0) questions[i] = res.q; else questions.push(res.q);
      toast('Saved.');
    } else { questions.push(res.q); toast('Question added.'); }
    saveQuestions();
    const keepType = $('#tType').value;
    resetForm();
    $('#tType').value = keepType;
    drawFormFields(keepType, []);
    renderTeacher();
    $('#tQ').focus();
  }

  function renderSetPicker() {
    const d = readSets();
    const sel = $('#tSet');
    sel.replaceChildren();
    d.sets.forEach(x => { const o = el('option', '', x.name + ' (' + x.questions.length + ')'); o.value = x.id; sel.append(o); });
    sel.value = editSetId;
    $('#tSetDelete').disabled = d.sets.length < 2;
  }

  function renderTeacher() {
    renderSetPicker();
    const n = questions.length;
    const cnt = $('#tCount');
    cnt.textContent = '"' + editSetName + '": ' + plural(n, 'question') + ' saved.' +
      (n < QUESTIONS_FOR[DEFAULT_TARGET] ? ' Tip: a standard 10-part game works best with about ' + QUESTIONS_FOR[10] + ' or more questions. A short 6-part game needs about ' + QUESTIONS_FOR[6] + ', and a long 12-part game about ' + QUESTIONS_FOR[12] + '.' : '');
    cnt.classList.toggle('warn', n < QUESTIONS_FOR[DEFAULT_TARGET]);
    const list = $('#tList');
    list.replaceChildren();
    if (!n) { list.append(el('li', 't-empty', 'No questions in this set yet. Add one above, or import a file.')); return; }
    questions.forEach((q, i) => {
      const li = el('li', 'trow');
      const main = el('div', 't-main');
      const top = el('div', 't-q');
      top.append(el('span', 't-type', TYPE_LABEL[q.type]), document.createTextNode((i + 1) + '. ' + q.q));
      main.append(top, el('div', 't-a', 'Answer: ' + keySummary(q)));
      const btns = el('div', 'tbtns');
      const edit = el('button', 'btn small ghost', 'Edit'); edit.type = 'button';
      edit.addEventListener('click', () => startEdit(q));
      const del = el('button', 'btn small ghost danger', 'Delete'); del.type = 'button';
      del.setAttribute('aria-label', 'Delete question ' + (i + 1));
      del.addEventListener('click', () => {
        if (!window.confirm('Delete this question?\n\n' + q.q)) return;
        questions = questions.filter(x => x.id !== q.id);
        if (editingId === q.id) resetForm();
        saveQuestions(); renderTeacher();
      });
      btns.append(edit, del);
      li.append(main, btns);
      list.append(li);
    });
  }

  /* ----- Question sets: new, rename, duplicate, delete ----- */
  function newSet() {
    const name = window.prompt('Name your new question set (for example, Space vocabulary):');
    if (name === null) return;
    const n = cleanText(name, 40);
    if (!n) { toast('Type a name for the set.'); return; }
    const d = readSets();
    if (d.sets.some(x => x.name.toLowerCase() === n.toLowerCase())) { toast('You already have a set with that name.'); return; }
    const created = { id: uid(6), name: n, questions: [] };
    d.sets.push(created);
    writeSets(d);
    editSetId = created.id;
    loadQuestions(); resetForm(); renderTeacher();
  }
  function renameSet() {
    const name = window.prompt('New name for this set:', editSetName);
    if (name === null) return;
    const n = cleanText(name, 40);
    if (!n) { toast('Type a name for the set.'); return; }
    const d = readSets();
    if (d.sets.some(x => x.id !== editSetId && x.name.toLowerCase() === n.toLowerCase())) { toast('You already have a set with that name.'); return; }
    const es = d.sets.find(x => x.id === editSetId);
    if (!es) return;
    es.name = n;
    writeSets(d);
    loadQuestions(); renderTeacher();
  }
  function duplicateSet() {
    const d = readSets();
    const src = d.sets.find(x => x.id === editSetId);
    if (!src) return;
    const copy = { id: uid(6), name: uniqueSetName(d, cleanText(src.name, 32) + ' (copy)'), questions: src.questions.map(q => Object.assign(JSON.parse(JSON.stringify(q)), { id: uid() })) };
    d.sets.push(copy);
    writeSets(d);
    editSetId = copy.id;
    loadQuestions(); resetForm(); renderTeacher();
    toast('Copied. Edit the copy to make a different version.');
  }
  function deleteSet() {
    const d = readSets();
    if (d.sets.length < 2) { toast('You need at least one set.'); return; }
    const es = d.sets.find(x => x.id === editSetId);
    if (!es || !window.confirm('Delete the set "' + es.name + '" and its ' + plural(es.questions.length, 'question') + '? This cannot be undone.')) return;
    d.sets = d.sets.filter(x => x.id !== es.id);
    if (d.gameId === es.id) d.gameId = d.sets[0].id;
    d.editId = d.sets[0].id;
    writeSets(d);
    editSetId = d.sets[0].id;
    loadQuestions(); resetForm(); renderTeacher();
  }

  /* ----- Bulk add, export, import ----- */
  // Turns one pasted or CSV row into a question. Accepts this game's template
  // columns (Type, Question, Answer 1–6) or Escape the Island's (Question, Correct, Wrong 1–3).
  function rowToQuestion(cells) {
    const c = cells.map(x => String(x == null ? '' : x));
    const t = typeFromLabel(c[0]);
    if (t) return buildQuestion(t, c[1], c.slice(2, 8));
    return buildQuestion('choice', c[0], c.slice(1, 5));
  }

  function bulkAdd() {
    const ta = $('#tBulk');
    let added = 0;
    const errs = [];
    ta.value.split(/\r?\n/).forEach((line, i) => {
      if (!line.trim()) return;
      let res;
      // Rows copied as raw table text: | Type | Question | Answer 1 | ... |
      if (/^\s*\|/.test(line)) {
        const cells = line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
        if (cells.every(c => /^:?-{2,}:?$/.test(c) || !c)) return;            // the |---|---| line
        if (/^type$/i.test(cells[0]) && /^question/i.test(cells[1] || '')) return;   // header row
        res = rowToQuestion(cells);
        if (res.q) { questions.push(res.q); added++; } else errs.push('Line ' + (i + 1) + ': ' + res.error);
        return;
      }
      if (line.includes('\t') && /^type$/i.test(line.split('\t')[0].trim()) && /^question/i.test((line.split('\t')[1] || '').trim())) return;   // header row
      if (line.includes('\t')) res = rowToQuestion(line.split('\t'));
      else if (line.includes('=>')) {
        const parts = line.split('=>');
        res = buildQuestion('choice', parts[0], parts.slice(1).join('=>').split('|'));
      } else res = { error: 'Use tabs between columns, or question => correct | wrong.' };
      if (res.q) { questions.push(res.q); added++; } else errs.push('Line ' + (i + 1) + ': ' + res.error);
    });
    saveQuestions();
    if (!errs.length) ta.value = '';
    renderTeacher();
    toast(plural(added, 'question') + ' added.' + (errs.length ? ' ' + plural(errs.length, 'line') + ' skipped. ' + errs.slice(0, 2).join(' ') : ''), errs.length ? 9000 : 3400);
  }

  function downloadBlob(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = el('a'); a.href = url; a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'questions';

  // The same file format works in every game of the template bank.
  function exportQuestions() {
    const data = {
      format: 'classroom-question-set', version: 1, game: FILE_SLUG, name: editSetName,
      questions: questions.map(q => { const c = JSON.parse(JSON.stringify(q)); delete c.id; return c; })
    };
    downloadBlob(FILE_SLUG + '-' + slug(editSetName) + '.json', JSON.stringify(data, null, 2), 'application/json');
  }

  // Small CSV reader: quoted fields, commas or semicolons, line breaks inside quotes, and a BOM.
  function parseCsv(text) {
    text = text.replace(/^\ufeff/, '');
    const firstLine = text.split(/\r?\n/, 1)[0];
    const delim = firstLine.split(';').length > firstLine.split(',').length ? ';' : ',';
    const rows = [];
    let row = [], field = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
        else field += ch;
      } else if (ch === '"' && field === '') inQ = true;
      else if (ch === delim) { row.push(field); field = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(field); rows.push(row); row = []; field = '';
      } else field += ch;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  function importCsvText(text) {
    const rows = parseCsv(text);
    const head = (rows[0] || []).map(c => String(c).trim().toLowerCase());
    const hasHead = head[0] === 'type' || (head[0] || '').indexOf('question') === 0;
    const checkCol = head.indexOf('check');
    let added = 0;
    const errs = [];
    rows.slice(hasHead ? 1 : 0).forEach((r, i) => {
      if (r.every(c => !String(c).trim())) return;                   // blank row
      const line = i + (hasHead ? 2 : 1);
      const check = checkCol >= 0 ? String(r[checkCol] || '').trim() : '';
      if (check && check !== 'OK') { errs.push('Row ' + line + ': ' + check); return; }   // the template flagged it
      const cells = checkCol >= 0 ? r.slice(0, checkCol) : r;
      const res = rowToQuestion(cells);
      if (res.q) { questions.push(res.q); added++; } else errs.push('Row ' + line + ': ' + res.error);
    });
    saveQuestions();
    renderTeacher();
    toast(plural(added, 'question') + ' imported.' + (errs.length ? ' ' + plural(errs.length, 'row') + ' skipped. ' + errs.slice(0, 2).join(' ') : ''), errs.length ? 9000 : 4000);
  }

  function importJsonText(text) {
    const data = JSON.parse(text);
    const list = Array.isArray(data) ? data : data && Array.isArray(data.questions) ? data.questions : null;
    if (!list) throw new Error('no questions');
    let added = 0, skipped = 0;
    list.forEach(item => { const q = normalizeQuestion(item); if (q) { q.id = uid(); questions.push(q); added++; } else skipped++; });
    saveQuestions();
    renderTeacher();
    toast(plural(added, 'question') + ' imported.' + (skipped ? ' ' + plural(skipped, 'item') + ' could not be read and were skipped.' : ''), 5000);
  }

  function importQuestions(file) {
    if (!file) return;
    const isCsv = /\.csv$/i.test(file.name) || file.type === 'text/csv';
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result);
      if (isCsv) {
        // Older Excel CSV files are Windows-1252, not UTF-8. If accents look broken, read again.
        if (text.indexOf('\ufffd') >= 0) {
          const again = new FileReader();
          again.onload = () => { try { importCsvText(String(again.result)); } catch (e) { toast('That CSV file could not be read.'); } };
          again.readAsText(file, 'windows-1252');
          return;
        }
        try { importCsvText(text); } catch (e) { toast('That CSV file could not be read.'); }
        return;
      }
      try { importJsonText(text); } catch (e) { toast('That file could not be read. Use a .json file exported from this game, or a .csv from the template.', 6000); }
    };
    reader.readAsText(file);
  }

  /* =========================================================
     SHARED CORE — whiteboard
     Drawings are vector strokes in a 1200x720 space: crisp on any
     screen, small to send, and checked on arrival.
     ========================================================= */
  const wb = { strokes: [], color: '#1f2350', width: 6, erase: false, cur: null };
  let boardData = null;     // the teacher's drawing (students)

  function cleanBoard(b) {
    if (!b || !Array.isArray(b.strokes)) return null;
    const out = [];
    b.strokes.slice(0, 400).forEach(st => {
      if (!st || !Array.isArray(st.p)) return;
      let pts = st.p.slice(0, 6000).map(Number).filter(Number.isFinite).map(v => Math.max(-50, Math.min(1250, v)));
      if (pts.length < 2) return;
      if (pts.length % 2) pts = pts.slice(0, -1);
      out.push({ c: /^#[0-9a-f]{6}$/i.test(st.c) ? st.c : '#000000', w: Math.min(80, Math.max(1, Number(st.w) || 6)), p: pts });
    });
    return { id: String(b.id || '').slice(0, 20), strokes: out };
  }
  function drawStroke(ctx, st) {
    const p = st.p;
    ctx.strokeStyle = st.c; ctx.fillStyle = st.c; ctx.lineWidth = st.w;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (p.length < 4) { ctx.beginPath(); ctx.arc(p[0], p[1], st.w / 2, 0, Math.PI * 2); ctx.fill(); return; }
    ctx.beginPath();
    ctx.moveTo(p[0], p[1]);
    for (let i = 2; i < p.length - 2; i += 2) ctx.quadraticCurveTo(p[i], p[i + 1], (p[i] + p[i + 2]) / 2, (p[i + 1] + p[i + 3]) / 2);
    ctx.lineTo(p[p.length - 2], p[p.length - 1]);
    ctx.stroke();
  }
  function drawStrokes(ctx, strokes, w, h) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    strokes.forEach(st => drawStroke(ctx, st));
  }
  function wbRedraw() { const c = $('#wbCanvas'); drawStrokes(c.getContext('2d'), wb.strokes, c.width, c.height); }
  function wbSyncTools() {
    $$('#wbColors .wb-swatch').forEach(b => b.classList.toggle('active', !wb.erase && b.dataset.color === wb.color));
    $$('#wbSizes .wb-size').forEach(b => b.classList.toggle('active', Number(b.dataset.w) === wb.width));
    $('#wbEraser').classList.toggle('active', wb.erase);
    $('#wbEraser').setAttribute('aria-pressed', String(wb.erase));
  }
  function openWhiteboard() {
    if (net.role !== 'host' || !S || S.phase === 'lobby') return;
    hostPause();
    $('#wbModal').classList.remove('hidden');
    wbRedraw();
    renderWbPanel();
  }
  function closeWb() { $('#wbModal').classList.add('hidden'); }
  function renderWbPanel() {
    if (net.role !== 'host' || $('#wbModal').classList.contains('hidden') || !S) return;
    $('#wbHide').classList.toggle('hidden', !S.boardShared);
    $('#wbShow').textContent = S.boardShared ? 'Update what the class sees' : 'Show to class';
    const q = $('#wbQ');
    if (!S.question) { q.textContent = 'No question on screen right now.'; $('#wbPicks').replaceChildren(); return; }
    q.textContent = S.question.text;
    renderHostView($('#wbPicks'));
    $('#wbPicks').classList.remove('hidden');
  }
  // A new turn clears the board for everyone, including the host's own canvas.
  function boardChanged(open) {
    if (net.role !== 'client') return;
    if (boardData && open) openBoardView();
    if (!boardData) $('#boardModal').classList.add('hidden');
    updateBoardBtn();
  }
  function openBoardView() {
    const c = $('#boardCanvas');
    drawStrokes(c.getContext('2d'), boardData.strokes, c.width, c.height);
    $('#boardModal').classList.remove('hidden');
    updateBoardBtn();
  }
  function closeBoardView() { $('#boardModal').classList.add('hidden'); updateBoardBtn(); }
  function updateBoardBtn() {
    const show = net.role === 'client' && !!boardData && $('#boardModal').classList.contains('hidden') && !!S && S.phase !== 'lobby';
    $('#showBoardBtn').classList.toggle('hidden', !show);
  }

  function initWhiteboard() {
    const c = $('#wbCanvas');
    const pt = e => {
      const r = c.getBoundingClientRect();
      return [Math.round((e.clientX - r.left) * c.width / r.width), Math.round((e.clientY - r.top) * c.height / r.height)];
    };
    c.addEventListener('pointerdown', e => {
      if (e.button > 0) return;
      e.preventDefault();
      if (wb.strokes.length >= 300) { toast('That is a lot of strokes. Undo or clear to keep drawing.'); return; }
      try { c.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      wb.cur = { c: wb.erase ? '#ffffff' : wb.color, w: wb.erase ? wb.width * 3 : wb.width, p: pt(e) };
      wb.strokes.push(wb.cur);
      wbRedraw();
    });
    c.addEventListener('pointermove', e => {
      if (!wb.cur) return;
      const p = wb.cur.p, n = pt(e), lx = p[p.length - 2], ly = p[p.length - 1];
      if (Math.abs(n[0] - lx) + Math.abs(n[1] - ly) < 3 || p.length > 6000) return;
      const ctx = c.getContext('2d');
      ctx.strokeStyle = wb.cur.c; ctx.lineWidth = wb.cur.w; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(n[0], n[1]); ctx.stroke();
      p.push(n[0], n[1]);
    });
    const end = () => { if (wb.cur) { wb.cur = null; wbRedraw(); } };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    $$('#wbColors .wb-swatch').forEach(b => b.addEventListener('click', () => { wb.color = b.dataset.color; wb.erase = false; wbSyncTools(); }));
    $$('#wbSizes .wb-size').forEach(b => b.addEventListener('click', () => { wb.width = Number(b.dataset.w); wbSyncTools(); }));
    $('#wbEraser').addEventListener('click', () => { wb.erase = !wb.erase; wbSyncTools(); });
    $('#wbUndo').addEventListener('click', () => { wb.strokes.pop(); wbRedraw(); });
    $('#wbClear').addEventListener('click', () => { wb.strokes = []; wbRedraw(); });
    $('#wbShow').addEventListener('click', () => {
      const r = hostShareBoard(wb.strokes.map(st => ({ c: st.c, w: st.w, p: st.p.slice() })));
      if (r === 'empty') toast('Draw something first.');
      else if (r === 'toolarge') toast('That drawing is too detailed to send. Undo or clear some strokes.');
      else toast('Shown to the class.');
    });
    $('#wbHide').addEventListener('click', () => { hostHideBoard(); toast('Hidden from the class.'); });
    $('#wbClose').addEventListener('click', closeWb);
    wbSyncTools();
  }

  /* =========================================================
     SHARED CORE — class report
     One report per game, recorded on the host's device only.
     ========================================================= */
  let report = null;   // { id, started, room, set, entries: [{ n, t, type, q, a, rows: [{ name, ans, ok, score }] }] }

  function loadReport() {
    try {
      const r = JSON.parse(local.get(STORE_REPORT, 'null'));
      if (r && Array.isArray(r.entries)) return r;
    } catch (e) { /* ignore */ }
    return null;
  }
  function saveReport() { if (report) local.set(STORE_REPORT, JSON.stringify(report)); }
  function startReport(setName) { report = { id: uid(6), started: Date.now(), room: net.code, set: setName || '', entries: [] }; saveReport(); }

  function recordQuestion() {
    if (!H.current) return;
    if (!report) startReport(chosenSet().name);
    const pub = H.current.pub;
    const rows = H.players.filter(p => p.connected || has(H.answers, p.pid)).map(p => {
      const g = H.grades[p.pid];
      return g ? { name: p.name, ans: g.text, ok: g.ok, score: Math.round(g.score * 100) } : { name: p.name, ans: null, ok: null, score: null };
    });
    report.entries.push({ n: H.current.num, t: Date.now(), type: TYPE_LABEL[pub.type], q: pub.text, a: revealKey(pub, H.current.key).text, rows });
    saveReport();
  }

  function reportStats(r) {
    const byName = {}, students = [];
    r.entries.forEach(e => e.rows.forEach(row => {
      let st = byName[row.name];
      if (!st) { st = { name: row.name, answered: 0, correct: 0 }; byName[row.name] = st; students.push(st); }
      if (row.ans !== null) { st.answered++; if (row.ok) st.correct++; }
    }));
    students.forEach(st => { st.pct = st.answered ? Math.round(st.correct / st.answered * 100) : null; });
    const qs = r.entries.map(e => {
      const given = e.rows.filter(x => x.ans !== null);
      const correct = given.filter(x => x.ok).length;
      const wrong = {}, label = {};
      given.filter(x => !x.ok).forEach(x => { const k = norm(x.ans); wrong[k] = (wrong[k] || 0) + 1; label[k] = label[k] || x.ans; });
      const common = Object.keys(wrong).sort((a, b) => wrong[b] - wrong[a]).slice(0, 2).map(k => label[k] + ' (' + wrong[k] + ')').join('; ');
      return { n: e.n, type: e.type || '', q: e.q, a: e.a, answered: given.length, correct, pct: given.length ? Math.round(correct / given.length * 100) : null, common };
    });
    return { students, qs };
  }
  const pctText = (v) => (v === null ? '–' : v + '%');

  function fillTable(table, head, rows, pctCol) {
    table.replaceChildren();
    const thead = el('thead'), hr = el('tr');
    head.forEach(h => hr.append(el('th', '', h)));
    thead.append(hr);
    const tbody = el('tbody');
    rows.forEach(r => {
      const tr = el('tr');
      r.forEach((v, i) => {
        const td = el('td', '', String(v));
        if (i === pctCol) { const n = parseInt(v, 10); if (!isNaN(n) && n < 60) td.className = 'low'; }
        tr.append(td);
      });
      tbody.append(tr);
    });
    table.append(thead, tbody);
  }
  function renderReport() {
    const ok = !!(report && report.entries.length);
    $('#rBody').classList.toggle('hidden', !ok);
    $('#rEmpty').classList.toggle('hidden', ok);
    ['#rDownload', '#rSummary', '#rDelete'].forEach(sel => { $(sel).disabled = !ok; });
    $('#rMeta').textContent = ok ? new Date(report.started).toLocaleString() + ' · Room ' + report.room + (report.set ? ' · Question set: ' + report.set : '') + ' · ' + plural(report.entries.length, 'question') + ' asked' : '';
    if (!ok) return;
    const { students, qs } = reportStats(report);
    fillTable($('#rStudents'), ['Student', 'Answered', 'Correct', 'Percent'], students.map(st => [st.name, st.answered, st.correct, pctText(st.pct)]), 3);
    fillTable($('#rQuestions'), ['#', 'Type', 'Question', 'Correct answer', 'Answered', 'Correct', 'Percent', 'Most common wrong answers'],
      qs.map(q => [q.n, q.type, q.q, q.a, q.answered, q.correct, pctText(q.pct), q.common || '–']), 6);
  }
  function openReport() { if (!report) report = loadReport(); renderReport(); $('#reportModal').classList.remove('hidden'); }
  function closeReport() { $('#reportModal').classList.add('hidden'); }

  // Names and answers are typed by students, so guard against spreadsheet formulas.
  function csvCell(v) {
    let s = v == null ? '' : String(v);
    if (/^[=+@\t\r]/.test(s) || /^-(?![\d.])/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function downloadCsv(name, rows) {
    downloadBlob(name, '\ufeff' + rows.map(r => r.map(csvCell).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
  }
  function dateStamp() {
    const d = new Date(report.started), z = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate());
  }
  function downloadAnswers() {
    const rows = [['Date and time', 'Question set', 'Question #', 'Type', 'Student', 'Question', "Student's answer", 'Correct answer', 'Result', 'Parts correct (%)']];
    report.entries.forEach(e => e.rows.forEach(r => {
      rows.push([new Date(e.t).toLocaleString(), report.set, e.n, e.type, r.name, e.q, r.ans === null ? '' : r.ans, e.a,
        r.ans === null ? 'No answer' : (r.ok ? 'Correct' : 'Incorrect'), r.score === null || r.score === undefined ? '' : r.score]);
    }));
    downloadCsv(FILE_SLUG + '-answers-' + dateStamp() + '.csv', rows);
  }
  function downloadSummary() {
    const { students, qs } = reportStats(report);
    const rows = [
      [GAME_NAME + ' class summary', new Date(report.started).toLocaleString(), 'Room ' + report.room, 'Question set: ' + report.set],
      [], ['Student totals'], ['Student', 'Questions answered', 'Correct', 'Percent correct']
    ];
    students.forEach(st => rows.push([st.name, st.answered, st.correct, pctText(st.pct)]));
    rows.push([], ['Question results (under 60% correct are marked NEEDS REVIEW)'], ['Question #', 'Type', 'Question', 'Correct answer', 'Students answered', 'Correct', 'Percent correct', 'Most common wrong answers', 'Flag']);
    qs.forEach(q => rows.push([q.n, q.type, q.q, q.a, q.answered, q.correct, pctText(q.pct), q.common, q.pct !== null && q.pct < 60 ? 'NEEDS REVIEW' : '']));
    downloadCsv(FILE_SLUG + '-summary-' + dateStamp() + '.csv', rows);
  }

  /* =========================================================
     WIRING
     ========================================================= */
  function copyText(text, okMsg) {
    const fallback = () => {
      const t = el('textarea'); t.value = text;
      document.body.append(t); t.select();
      try { document.execCommand('copy'); toast(okMsg); } catch (e) { toast('Copy failed. Select and copy it by hand.'); }
      t.remove();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => toast(okMsg), fallback);
    else fallback();
  }
  const hostOnly = (fn) => (...args) => { if (net.role === 'host' && H) fn(...args); };

  function init() {
    loadQuestions();
    report = loadReport();

    const params = new URLSearchParams(window.location.search);
    $('#nameInput').value = local.get(STORE_NAME, '') || '';
    const fromLink = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    $('#codeInput').value = fromLink || session.get(SESS_ROOM, '') || '';
    const readName = () => {
      const n = cleanName($('#nameInput').value);
      if (!n) { homeMsg('Type your name first.'); $('#nameInput').focus(); return null; }
      local.set(STORE_NAME, n);
      return n;
    };
    $('#hostBtn').addEventListener('click', () => { const n = readName(); if (n) openPin('host', n); });
    $('#joinBtn').addEventListener('click', () => { const n = readName(); if (n) joinRoom($('#codeInput').value, n); });
    $('#codeInput').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });
    $('#codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('#joinBtn').click(); });
    $('#nameInput').addEventListener('keydown', e => { if (e.key === 'Enter') ($('#codeInput').value ? $('#joinBtn') : $('#hostBtn')).click(); });

    // Lobby
    $('#copyCodeBtn').addEventListener('click', () => copyText(net.code, 'Room code copied.'));
    $('#copyLinkBtn').addEventListener('click', () => copyText(window.location.origin + window.location.pathname + '?room=' + net.code, 'Join link copied.'));
    $('#startBtn').addEventListener('click', hostOnly(hostStart));
    $('#optHostPlays').addEventListener('change', hostOnly(e => hostSetHostPlays(e.target.checked)));
    $('#optAutoContinue').addEventListener('change', hostOnly(e => { H.autoContinue = e.target.checked; broadcast(); }));
    $('#optBig').addEventListener('change', hostOnly(e => { H.big = e.target.checked; broadcast(); }));
    $('#optPower').addEventListener('change', hostOnly(e => { H.power = e.target.value === 'on'; broadcast(); }));
    $('#optMessage').addEventListener('change', hostOnly(e => {
      H.message = cleanText(e.target.value, 60) || DEFAULT_MESSAGE;
      local.set(STORE_MSG, H.message);
      e.target.value = H.message;
    }));
    ['#optSet', '#hcSet', '#endSet'].forEach(s => $(s).addEventListener('change', hostOnly(e => hostSetQuestionSet(e.target.value))));
    ['#optTarget', '#hcTarget', '#endTarget'].forEach(s => $(s).addEventListener('change', hostOnly(e => hostSetTarget(e.target.value))));
    ['#optEvents', '#hcEvents', '#endEvents'].forEach(s => $(s).addEventListener('change', hostOnly(e => hostSetEvents(e.target.value))));
    $('#lobbyLeaveBtn').addEventListener('click', leaveGame);

    // Game
    $('#leaveBtn').addEventListener('click', leaveGame);
    $('#hcAutoContinue').addEventListener('change', hostOnly(e => {
      H.autoContinue = e.target.checked;
      clearTimeout(H.timer);
      if (H.autoContinue && H.phase === 'reveal' && !H.paused) H.timer = setTimeout(hostContinue, REVEAL_MS);
      broadcast();
    }));
    $('#hcProjector').addEventListener('change', hostOnly(e => { H.projector = e.target.checked; broadcast(); }));
    $('#hcNext').addEventListener('click', hostOnly(hostContinue));
    $('#restartBtn').addEventListener('click', hostOnly(() => {
      if (window.confirm('Restart with a new star map and fresh questions? This also starts a new class report, so download the current one first if you need it.')) hostStart();
    }));

    // Question card
    $('#qSubmit').addEventListener('click', submitAnswer);
    $('#qReset').addEventListener('click', () => { if (!canAnswer()) return; qView.place = qView.place.map(() => -1); qView.selected = -1; redrawPlace(); });
    $('#qRead').addEventListener('click', speak);
    document.addEventListener('keydown', e => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = e.target && e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (!canAnswer() || $('#qModal').classList.contains('hidden')) return;
      if (!$('#wbModal').classList.contains('hidden') || !$('#boardModal').classList.contains('hidden')) return;
      const pub = S.question;
      if (pub.type !== 'choice' && pub.type !== 'tf') return;
      const k = String(e.key).toLowerCase();
      const idx = pub.type === 'tf' ? ['t', 'f'].indexOf(k) : Math.max('abcd'.indexOf(k), '1234'.indexOf(k));
      if (k.length === 1 && idx >= 0 && idx < pub.choices.length) { qView.choice = idx; qView.bodyKey = ''; renderQuestion(); }
      else if (e.key === 'Enter' && tag !== 'BUTTON' && qView.choice !== null) submitAnswer();
    });
    $('#qWhiteboard').addEventListener('click', openWhiteboard);
    $('#hcWhiteboard').addEventListener('click', openWhiteboard);
    $('#boardClose').addEventListener('click', closeBoardView);
    $('#showBoardBtn').addEventListener('click', () => { if (boardData) openBoardView(); });
    $('#qSkip').addEventListener('click', hostOnly(resolveQuestion));
    $('#qContinue').addEventListener('click', hostOnly(hostContinue));
    initWhiteboard();

    // Report
    $('#hcReport').addEventListener('click', openReport);
    $('#endReportBtn').addEventListener('click', openReport);
    $('#tReport').addEventListener('click', openReport);
    $('#rClose').addEventListener('click', closeReport);
    $('#rDownload').addEventListener('click', () => { if (report && report.entries.length) downloadAnswers(); });
    $('#rSummary').addEventListener('click', () => { if (report && report.entries.length) downloadSummary(); });
    $('#rDelete').addEventListener('click', () => {
      if (!window.confirm('Delete this report from this device? This cannot be undone.')) return;
      report = null; local.del(STORE_REPORT); renderReport();
    });

    // End card
    $('#playAgainBtn').addEventListener('click', hostOnly(hostStart));
    $('#endLeaveBtn').addEventListener('click', leaveGame);
    $('#lostHostBtn').addEventListener('click', () => { net.leaving = true; session.del(SESS_ROOM); window.location.reload(); });

    // Teacher Mode: Alt+Shift+T (Ctrl+Shift+T also works where the browser allows it) or triple-click the corner
    document.addEventListener('keydown', e => {
      if (e.shiftKey && e.code === 'KeyT' && (e.ctrlKey || e.altKey)) { e.preventDefault(); openPin(); }
      if (e.key === 'Escape') {
        if (!$('#pinModal').classList.contains('hidden')) closePin();
        else if (!$('#reportModal').classList.contains('hidden')) closeReport();
        else if (!$('#teacherModal').classList.contains('hidden')) closeTeacher();
        else if (!$('#wbModal').classList.contains('hidden')) closeWb();
        else if (!$('#boardModal').classList.contains('hidden')) closeBoardView();
      }
    });
    let corner = [];
    $('#hotCorner').addEventListener('click', () => {
      const now = Date.now();
      corner = corner.filter(t => now - t < 1500).concat(now);
      if (corner.length >= 3) { corner = []; openPin(); }
    });
    $('#pinOk').addEventListener('click', submitPin);
    $('#pinCancel').addEventListener('click', closePin);
    $('#pinInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submitPin(); } });
    $('#tClose').addEventListener('click', closeTeacher);
    $('#tSet').addEventListener('change', e => { editSetId = e.target.value; loadQuestions(); resetForm(); renderTeacher(); });
    $('#tSetNew').addEventListener('click', newSet);
    $('#tSetRename').addEventListener('click', renameSet);
    $('#tSetDup').addEventListener('click', duplicateSet);
    $('#tSetDelete').addEventListener('click', deleteSet);
    $('#tType').addEventListener('change', () => {
      // Keep typed answers when switching between types, but don't carry True/False over.
      const vals = $('#tTF') ? [] : formValues();
      drawFormFields($('#tType').value, $('#tType').value === 'tf' ? [] : vals);
    });
    $('#tForm').addEventListener('submit', e => { e.preventDefault(); saveForm(); });
    $('#tCancelEdit').addEventListener('click', resetForm);
    $('#tBulkBtn').addEventListener('click', bulkAdd);
    $('#tExport').addEventListener('click', exportQuestions);
    $('#tImport').addEventListener('change', e => { importQuestions(e.target.files[0]); e.target.value = ''; });
    $('#tIsland').addEventListener('click', copyFromIsland);
    $('#tSamples').addEventListener('click', () => {
      if (!window.confirm('Add ' + SAMPLE_ROWS.length + ' sample questions (one of every type) to "' + editSetName + '"?')) return;
      questions = questions.concat(sampleQuestions());
      saveQuestions(); renderTeacher();
    });
    $('#tClear').addEventListener('click', () => {
      if (!window.confirm('Delete ALL questions in "' + editSetName + '"? This cannot be undone.')) return;
      questions = []; saveQuestions(); resetForm(); renderTeacher();
    });
    resetForm();

    // Close connections cleanly when a tab closes, so the host notices right away.
    window.addEventListener('pagehide', e => {
      if (e.persisted || !net.peer) return;
      net.leaving = true;
      try { net.peer.destroy(); } catch (err) { /* ignore */ }
    });
    // Protect a running game from an accidental tab close on the host.
    window.addEventListener('beforeunload', e => {
      if (net.role === 'host' && S && !['lobby', 'won', 'lost'].includes(S.phase) && !net.leaving) { e.preventDefault(); e.returnValue = ''; }
    });

    showScreen('home');

    // A student who refreshes goes straight back into their room as the same player.
    const room = session.get(SESS_ROOM, '');
    const name = cleanName(local.get(STORE_NAME, ''));
    if (room && name && session.get(SESS_TOKEN) && (!fromLink || fromLink === room)) setTimeout(() => joinRoom(room, name, true), 50);
  }

  init();
})();
