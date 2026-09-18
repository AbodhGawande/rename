/* Rename — main app. Plain JS, no build step. */
(function () {
  'use strict';
  const APP_VERSION = 5;
  const APP_BUILT = 'Sep 18, 2026 · 8:43 AM CDT';
  const PEOPLE = { abodh: 'Abodh', amruta: 'Amruta' };
  const SURNAME = 'Gawande';
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---------- storage ----------
  const LS = {
    get(k, d) { try { const v = localStorage.getItem('rename.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('rename.' + k, JSON.stringify(v)); } catch (e) {} },
  };

  const S = {
    me: LS.get('me', null),
    votes: LS.get('votes', {}),            // id -> {v:'like'|'dislike'|'love'|'skip', t, tags:[], note}
    partnerVotes: LS.get('partnerVotes', {}),
    faceoffs: LS.get('faceoffs', []),      // {a, b, w, t}
    partnerFaceoffs: LS.get('partnerFaceoffs', []),
    extras: LS.get('extras', []),          // Claude-generated names (pool schema)
    stories: LS.get('stories', {}),        // id -> markdown-ish text
    settings: Object.assign({ accent: 'sky', token: '', apiKey: '', maxSyl: 4, minSay: 50, hideCoined: false, hideKnown: false, letter: '', voiceUS: '', voiceIN: '', lastSync: 0 }, LS.get('settings', {})),
    pool: [], ssa: {}, exclude: [], names: [], byId: {},
    weights: {}, partnerWeights: {},
    queue: [], history: [], tab: 'discover', listSeg: 'both', faceoffPair: null, generating: false, syncing: false,
  };
  const partnerOf = me => (me === 'abodh' ? 'amruta' : 'abodh');
  const save = () => { LS.set('votes', S.votes); LS.set('faceoffs', S.faceoffs); LS.set('extras', S.extras); LS.set('stories', S.stories); LS.set('settings', S.settings); LS.set('partnerVotes', S.partnerVotes); LS.set('partnerFaceoffs', S.partnerFaceoffs); };

  // ---------- data ----------
  async function loadData() {
    const r = await fetch('data/names.json', { cache: 'no-cache' }).catch(() => null);
    if (r && r.ok) { const j = await r.json(); S.pool = j.names; LS.set('poolCache', j); }
    else { const c = LS.get('poolCache', null); S.pool = c ? c.names : []; }
    const s = await fetch('data/ssa.json', { cache: 'force-cache' }).catch(() => null);
    if (s && s.ok) S.ssa = await s.json();
    const x = await fetch('data/exclude.json', { cache: 'no-cache' }).catch(() => null);
    if (x && x.ok) S.exclude = await x.json();
    rebuildNames();
  }
  function rebuildNames() {
    const banned = new Set(S.exclude || []);
    S.extras = S.extras.filter(n => !banned.has(n.id) && !S.pool.some(p => p.id === n.id));
    S.extras.forEach(n => { if (n.unique == null) scoreExtra(n); });
    S.names = S.pool.concat(S.extras);
    S.byId = {}; S.names.forEach(n => { S.byId[n.id] = n; });
    retrain();
  }
  function scoreExtra(n) {
    const c24 = +(S.ssa[n.id] || 0);
    n.us = { c24, c10: null, rank24: null, trend: 'flat' };
    n.unique = c24 === 0 ? 100 : Math.max(5, Math.round(100 - 22 * Math.log2(1 + c24 / 4)));
  }
  function retrain() {
    S.weights = Learn.train(S.names, S.votes);
    S.partnerWeights = Learn.train(S.names, S.partnerVotes);
  }

  // ---------- ranking ----------
  let jitter = {};
  function passesFilters(n) {
    const f = S.settings;
    if (n.syllables > f.maxSyl) return false;
    if (n.sayability < f.minSay) return false;
    if (f.hideCoined && n.tradition === 'coined') return false;
    if (f.hideKnown && n.unique < 50) return false;
    if (f.letter && n.id[0] !== f.letter.toLowerCase()) return false;
    return true;
  }
  function baseScore(n) {
    const pv = S.partnerVotes[n.id];
    const pboost = pv ? ({ love: 28, like: 14, dislike: -18, skip: 0 }[pv.v] || 0) : 0;
    const learned = 22 * Math.tanh(Learn.score(S.weights, n) / 2);
    const fresh = n.generated ? 12 : 0; // Claude's new suggestions surface quickly
    if (jitter[n.id] == null) jitter[n.id] = Math.random() * 14;
    return 0.34 * n.unique + 0.34 * n.sayability + 0.12 * n.fresh + learned + pboost + fresh + jitter[n.id];
  }
  function buildQueue(keepIds) {
    const voted = S.votes;
    const fresh = [], skipped = [];
    S.names.forEach(n => {
      if (!passesFilters(n)) return;
      const v = voted[n.id];
      if (!v) fresh.push(n); else if (v.v === 'skip') skipped.push(n);
    });
    const scored = (fresh.length ? fresh : skipped).map(n => ({ n, s: baseScore(n) })).sort((a, b) => b.s - a.s).map(x => x.n);
    // Diversity: avoid three of the same category in a row.
    const out = []; const kept = (keepIds || []).map(id => S.byId[id]).filter(n => n && passesFilters(n) && (!voted[n.id] || voted[n.id].v === 'skip'));
    kept.forEach(n => out.push(n));
    const rest = scored.filter(n => !kept.includes(n));
    while (rest.length) {
      let i = 0;
      const l1 = out[out.length - 1], l2 = out[out.length - 2];
      if (l1 && l2 && l1.category === l2.category) { const j = rest.findIndex(n => n.category !== l1.category); if (j > 0) i = j; }
      out.push(rest.splice(i, 1)[0]);
    }
    S.queue = out;
  }

  // ---------- UI helpers ----------
  function toast(msg, action, fn) {
    const t = $('#toast');
    t.innerHTML = esc(msg) + (action ? `<button id="toastAct">${esc(action)}</button>` : '');
    t.classList.add('on');
    if (action) $('#toastAct').onclick = () => { t.classList.remove('on'); fn && fn(); };
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), action ? 4200 : 2200);
  }
  function grade(v) { return v >= 75 ? 'good' : v >= 50 ? 'mid' : 'low'; }
  function usText(n) {
    if (!n.us) return 'US data pending';
    if (!n.us.c24) return 'Not in US baby-name data (fewer than 5 boys a year)';
    return `${n.us.c24} US boys named this in 2024${n.us.rank24 ? ' (#' + n.us.rank24.toLocaleString() + ')' : ''}${n.us.trend === 'rising' ? ' · rising' : n.us.trend === 'falling' ? ' · falling' : ''}`;
  }
  function initials(n) { return n.name[0].toUpperCase() + '.G.'; }
  // Two voices: how an American reads the spelling, and how it sounds in Marathi (Devanagari in,
  // Marathi voice if the phone has one, else Hindi — same script, near-identical for a name).
  let voices = [];
  function loadVoices() { try { voices = speechSynthesis.getVoices() || []; } catch (e) {} }
  if ('speechSynthesis' in window) { loadVoices(); speechSynthesis.addEventListener('voiceschanged', loadVoices); }
  function speak(text, lang, voice, rate, retry) {
    try {
      const u = new SpeechSynthesisUtterance(text); u.lang = lang; u.rate = rate; if (voice) u.voice = voice;
      let started = false; u.onstart = () => { started = true; };
      // Some engines silently drop an utterance with an explicit voice; fall back to lang-only once.
      const fallback = () => { if (!started && !retry) speak(text, lang, null, rate, true); };
      u.onerror = fallback;
      speechSynthesis.cancel(); speechSynthesis.speak(u);
      setTimeout(() => { if (!started && !speechSynthesis.speaking) fallback(); }, 1200);
    } catch (e) { toast('Speech is not available here'); }
  }
  // Voice choice: a voice picked in Settings wins; otherwise the best-quality one we can spot by name
  // (Premium > Enhanced > plain). For the Indian button Hindi is preferred over Marathi because the
  // Marathi voice on iPhones is the robotic compact one and the Hindi premium voice reads Devanagari well.
  const quality = v => (/premium/i.test(v.name) ? 3 : /enhanced/i.test(v.name) ? 2 : /siri/i.test(v.name) ? 2 : 1);
  function pickVoice(kind) {
    const wanted = S.settings[kind === 'us' ? 'voiceUS' : 'voiceIN'];
    if (wanted) { const v = voices.find(x => x.name + '|' + x.lang === wanted); if (v) return v; }
    const pool = kind === 'us'
      ? voices.filter(x => /^en[-_]US/i.test(x.lang)).concat(voices.filter(x => /^en/i.test(x.lang)))
      : voices.filter(x => /^hi/i.test(x.lang)).concat(voices.filter(x => /^mr/i.test(x.lang)));
    return pool.sort((a, b) => quality(b) - quality(a))[0];
  }
  function sayUS(n) { speak((n.say || n.name).replace(/-/g, ' ').toLowerCase(), 'en-US', pickVoice('us'), 0.85); }
  function sayIN(n) {
    if (!voices.length) loadVoices();
    const v = pickVoice('in');
    speak(n.dev || n.name, v ? v.lang : 'hi-IN', v, 0.8);
  }
  function voiceOptions(kind) {
    const list = kind === 'us' ? voices.filter(x => /^en/i.test(x.lang)) : voices.filter(x => /^(hi|mr)/i.test(x.lang));
    const cur = pickVoice(kind);
    return list.map(v => `<option value="${esc(v.name + '|' + v.lang)}" ${cur && cur.name === v.name && cur.lang === v.lang ? 'selected' : ''}>${esc(v.name)} · ${esc(v.lang)}</option>`).join('');
  }
  const sayIt = sayUS;
  function sayRowHTML(n, cls) {
    return `<div class="sayrow ${cls || ''}"><button class="saybtn" data-say="us">${ICON.sound} English</button><button class="saybtn" data-say="in">${ICON.sound} Marathi</button></div>`;
  }
  function wireSayRow(scope, n) {
    $$('.saybtn', scope).forEach(b => {
      b.addEventListener('pointerdown', e => e.stopPropagation());
      b.onclick = e => { e.stopPropagation(); if (b.dataset.say === 'us') sayUS(n); else sayIN(n); };
    });
  }
  const ICON = {
    nope: $('.deckbtns .nope').innerHTML, like: $('.deckbtns .like').innerHTML, love: $('.deckbtns .love').innerHTML,
    sound: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14"/></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.8 5.7L19.5 9.5l-5.7 1.8L12 17l-1.8-5.7L4.5 9.5l5.7-1.8zM5 16l.9 2.6L8.5 19.5l-2.6.9L5 23l-.9-2.6L1.5 19.5l2.6-.9zM19 14l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z"/></svg>',
  };
  // Each category wears one of Aarush's shapes.
  const SHAPES = {
    circle: '<circle r="22"/>', triangle: '<polygon points="0,-24 24,18 -24,18"/>', square: '<rect x="-20" y="-20" width="40" height="40" rx="7"/>',
    star: '<polygon points="0,-25 8,-8 26,-8 12,3 17,21 0,11 -17,21 -12,3 -26,-8 -8,-8"/>', hexagon: '<polygon points="0,-24 21,-12 21,12 0,24 -21,12 -21,-12"/>',
    diamond: '<polygon points="0,-25 25,0 0,25 -25,0"/>', pentagon: '<polygon points="0,-24 23,-7 14,21 -14,21 -23,-7"/>', sparkle: '<polygon points="0,-26 6,-6 26,0 6,6 0,26 -6,6 -26,0 -6,-6"/>',
  };
  const CAT_SHAPE = { nature: ['circle', '#34d399'], virtue: ['triangle', '#fbbf24'], epic: ['pentagon', '#fb7185'], marathi: ['diamond', '#f97316'], sky: ['star', '#38bdf8'], music: ['hexagon', '#a78bfa'], knowledge: ['square', '#38bdf8'], light: ['sparkle', '#fbbf24'], sound: ['circle', '#a78bfa'], art: ['triangle', '#fb7185'], spirit: ['hexagon', '#34d399'], short: ['square', '#34d399'], coined: ['diamond', '#a78bfa'] };
  function shapeIcon(cat) { const [s, c] = CAT_SHAPE[cat] || ['circle', '#38bdf8']; return `<svg class="shapeglyph" viewBox="-30 -30 60 60" fill="${c}">${SHAPES[s]}</svg>`; }
  function markHTML(v, who) {
    const k = v ? v.v : 'none';
    const sym = { like: '♥', love: '★', dislike: '✕', skip: '…', none: '·' }[k];
    return `<span class="mark ${k}" title="${esc(who)}">${sym}</span>`;
  }

  // ---------- Deck ----------
  function cardHTML(n, pos) {
    const pv = S.partnerVotes[n.id];
    const partnerLine = pv && (pv.v === 'like' || pv.v === 'love') ? `<span class="partner">${PEOPLE[S.partner]} ${pv.v === 'love' ? 'loves' : 'likes'} this</span>` : '';
    return `<article class="card glass ${pos}" data-id="${n.id}">
      <div class="cat"><span class="catchip ${n.generated ? 'new' : ''}">${shapeIcon(n.category)}${n.generated ? ' new · ' : ''}${esc(n.category)}</span>${partnerLine}</div>
      <div class="namebox">
        <div class="name">${esc(n.name)}</div>
        ${n.dev ? `<div class="dev">${esc(n.dev)}</div>` : ''}
        <div class="say">say <b>${esc(n.say)}</b></div>
        ${sayRowHTML(n)}
        <div class="meaning">${esc(n.meaning)}</div>
        <div class="fullname">${esc(n.name)} ${SURNAME} · ${initials(n)} · ${n.syllables} syl · ${esc(n.origin)}</div>
      </div>
      <div class="stats">
        <div class="stat"><div class="v ${grade(n.unique)}">${n.unique}</div><div class="k">Unique</div></div>
        <div class="stat"><div class="v ${grade(n.sayability)}">${n.sayability}</div><div class="k">Easy to say</div></div>
        <div class="stat"><div class="v">${n.us && n.us.c24 ? n.us.c24 : '<5'}</div><div class="k">US boys/yr</div></div>
      </div>
      <div class="stamp like">Later</div><div class="stamp nope">Back</div>
    </article>`;
  }
  function renderDeck() {
    const deck = $('#deck');
    const top = S.queue.slice(0, 3);
    if (!top.length) {
      const voted = Object.keys(S.votes).length;
      deck.innerHTML = `<div class="empty glass"><div class="big">That's every name.</div><p class="muted">${S.settings.letter ? `Every ${S.settings.letter} name has been rated. ` : ''}You've been through ${voted} names. Ask Claude for a fresh batch in the Taste tab, loosen the filters in Settings, or head to Face-off.</p></div>`;
    } else {
      deck.innerHTML = top.map((n, i) => cardHTML(n, i === 0 ? 'top' : 'behind' + i)).reverse().join('');
      attachDrag($('.card.top'));
      wireSayRow($('.card.top'), top[0]);
    }
    const voted = Object.values(S.votes).filter(v => v.v !== 'skip').length;
    $('#progress').innerHTML = `<b>${voted}</b> rated · <b>${S.queue.length}</b> to go · ${S.names.length} names` + (S.settings.letter ? `<span class="letterchip">only ${S.settings.letter}<button id="clearLetter" title="Show all letters">✕</button></span>` : '');
    if (S.settings.letter) $('#clearLetter').onclick = () => { S.settings.letter = ''; save(); refreshAll(); toast('Showing every letter again'); };
    updateBadges();
  }
  function attachDrag(card) {
    if (!card) return;
    let x0 = 0, y0 = 0, dx = 0, dy = 0, dragging = false, moved = false, pid = null;
    const like = $('.stamp.like', card), nope = $('.stamp.nope', card);
    card.addEventListener('pointerdown', e => {
      if (e.button) return; pid = e.pointerId; x0 = e.clientX; y0 = e.clientY; dx = dy = 0; dragging = true; moved = false;
      card.setPointerCapture(pid); card.classList.add('dragging');
    });
    card.addEventListener('pointermove', e => {
      if (!dragging) return; dx = e.clientX - x0; dy = e.clientY - y0;
      if (Math.abs(dx) > 6 || Math.abs(dy) > 6) moved = true;
      const rot = dx / 18;
      card.style.transform = `translate(${dx}px, ${dy}px) rotate(${rot}deg)`;
      like.style.opacity = Math.max(0, Math.min(1, dx / 90));
      nope.style.opacity = Math.max(0, Math.min(1, -dx / 90));
    });
    const end = e => {
      if (!dragging) return; dragging = false; card.classList.remove('dragging');
      try { card.releasePointerCapture(pid); } catch (err) {}
      if (!moved) { card.style.transform = ''; openDetail(card.dataset.id); return; }
      // Gestures only move through the deck: right = skip for now, left = bring back the previous card.
      // Verdicts (pass / like / love) are the buttons, so a careless flick never judges a name.
      if (dx > 100) return flyOff(card, 'skip');
      if (dx < -100) { if (S.history.length) { flyOff(card, 'back'); } else { card.style.transform = ''; like.style.opacity = nope.style.opacity = 0; toast('Nothing to go back to'); } return; }
      card.style.transform = ''; like.style.opacity = nope.style.opacity = 0;
    };
    card.addEventListener('pointerup', end); card.addEventListener('pointercancel', end);
  }
  function flyOff(card, kind) {
    const id = card.dataset.id;
    const right = kind === 'like' || kind === 'skip', left = kind === 'dislike' || kind === 'back';
    const tx = right ? '120vw' : left ? '-120vw' : '0', ty = kind === 'love' ? '-120vh' : '10vh';
    card.style.transition = 'transform .4s ease-in, opacity .4s';
    card.style.transform = `translate(${tx}, ${ty}) rotate(${right ? 20 : left ? -20 : 0}deg)`;
    card.style.opacity = '0';
    setTimeout(() => (kind === 'back' ? undo() : vote(id, kind)), 160);
  }
  function vote(id, kind, fromDetail) {
    const prev = S.votes[id] ? Object.assign({}, S.votes[id]) : null;
    S.history.push({ id, prev });
    if (S.history.length > 50) S.history.shift();
    S.votes[id] = { v: kind, t: Date.now(), tags: [], note: prev && prev.note || '' };
    save(); retrain();
    buildQueue(S.queue.slice(1, 3).map(n => n.id).filter(x => x !== id));
    if (!fromDetail) { renderDeck(); if (kind !== 'skip') showReasons(id, kind); else hideReasons(); }
    scheduleSync();
  }
  function undo() {
    const h = S.history.pop(); if (!h) { toast('Nothing to undo'); return; }
    if (h.prev) S.votes[h.id] = h.prev; else delete S.votes[h.id];
    save(); retrain(); buildQueue([h.id].concat(S.queue.slice(0, 2).map(n => n.id))); renderDeck(); hideReasons();
    toast('Undone: ' + S.byId[h.id].name);
  }

  // Reasons sheet
  function showReasons(id, kind) {
    const box = $('#reasons'); const n = S.byId[id];
    const list = Learn.REASONS[kind === 'dislike' ? 'dislike' : 'like'];
    $('#reasonsTitle').textContent = (kind === 'dislike' ? 'Why not ' : kind === 'love' ? 'What you love about ' : 'What you like about ') + n.name + '?';
    $('#reasonChips').innerHTML = list.map(r => `<button class="chip ${kind === 'dislike' ? 'bad' : ''}" data-r="${esc(r)}">${esc(r)}</button>`).join('');
    $$('#reasonChips .chip').forEach(c => c.onclick = () => {
      c.classList.toggle('on');
      const v = S.votes[id]; if (!v) return;
      v.tags = $$('#reasonChips .chip.on').map(x => x.dataset.r); save(); retrain(); scheduleSync();
    });
    box.classList.add('on');
    clearTimeout(showReasons._t); showReasons._t = setTimeout(hideReasons, 6000);
  }
  function hideReasons() { $('#reasons').classList.remove('on'); }
  $('#reasonsDone').onclick = hideReasons;

  // ---------- Sheet (detail / settings) ----------
  function openSheet(html, cls) {
    const b = $('#sheetBody'); b.className = 'body ' + (cls || ''); b.innerHTML = html;
    $('#sheetwrap').classList.add('on'); b.scrollTop = 0; // after display:block, or the reset is ignored
  }
  function closeSheet() { $('#sheetwrap').classList.remove('on'); }
  $('#sheetDim').onclick = closeSheet;
  (function sheetSwipe() {
    const sh = $('#sheet'); let y0 = null;
    sh.addEventListener('touchstart', e => { y0 = $('#sheetBody').scrollTop <= 0 ? e.touches[0].clientY : null; }, { passive: true });
    sh.addEventListener('touchmove', e => { if (y0 != null && e.touches[0].clientY - y0 > 90) { y0 = null; closeSheet(); } }, { passive: true });
  })();

  function openDetail(id) {
    const n = S.byId[id]; if (!n) return;
    const my = S.votes[id], pv = S.partnerVotes[id];
    const both = my && pv && ['like', 'love'].includes(my.v) && ['like', 'love'].includes(pv.v);
    const partnerLine = pv ? `<b>${PEOPLE[S.partner]}</b> ${({ like: 'likes this', love: 'loves this ★', dislike: 'passed on this', skip: 'skipped this' })[pv.v]}${pv.tags && pv.tags.length ? ' — ' + esc(pv.tags.join(', ')) : ''}${pv.note ? ' · “' + esc(pv.note) + '”' : ''}` : `${PEOPLE[S.partner]} hasn't seen this yet`;
    const story = S.stories[id];
    openSheet(`
      <div class="dname">${esc(n.name)}</div>
      ${n.dev ? `<div class="dev" style="text-align:center">${esc(n.dev)}</div>` : ''}
      <div class="dsay">say <b>${esc(n.say)}</b></div>
      ${sayRowHTML(n, 'center')}
      <div class="dfull">${esc(n.name)} ${SURNAME} · ${initials(n)}${n.alt && n.alt.length ? ' · also spelled ' + esc(n.alt.join(', ')) : ''}</div>
      <div class="votes">
        <button class="nope ${my && my.v === 'dislike' ? 'on' : ''}" data-v="dislike">${ICON.nope}</button>
        <button class="like ${my && my.v === 'like' ? 'on' : ''}" data-v="like">${ICON.like}</button>
        <button class="love ${my && my.v === 'love' ? 'on' : ''}" data-v="love">${ICON.love}</button>
      </div>
      <div class="partnerline">${both ? '<b>You both like this one ♥</b><br>' : ''}${partnerLine}</div>
      <div class="tags" style="justify-content:center">
        <span class="tag">${shapeIcon(n.category)}${esc(n.category)}</span>
        <span class="tag ${grade(n.unique) === 'good' ? 'good' : grade(n.unique) === 'mid' ? 'warn' : 'bad'}">Unique ${n.unique}</span>
        <span class="tag ${grade(n.sayability) === 'good' ? 'good' : grade(n.sayability) === 'mid' ? 'warn' : 'bad'}">Easy to say ${n.sayability}</span>
        <span class="tag">${n.syllables} syllable${n.syllables > 1 ? 's' : ''}</span>
        <span class="tag">${esc(n.tradition.replace('-', ' '))}</span>
        <span class="tag">${esc(n.region)}</span>
        ${n.generated ? '<span class="tag acc">✦ suggested by Claude</span>' : ''}
      </div>
      <div class="field"><div class="eyebrow">Meaning</div><div class="val serif">${esc(n.meaning)}</div></div>
      <div class="field"><div class="eyebrow">Root</div><div class="val">${esc(n.root)} · ${esc(n.origin)}${n.confidence === 'medium' ? ' <span class="tag warn">meaning: medium confidence</span>' : ''}</div></div>
      ${n.note ? `<div class="field"><div class="eyebrow">Context</div><div class="val">${esc(n.note)}</div></div>` : ''}
      <div class="field"><div class="eyebrow">Saying it in the US</div><div class="val">${esc(n.say_note || '—')}</div>${n.collisions ? `<div class="val" style="color:var(--gold);margin-top:4px">⚠︎ ${esc(n.collisions)}</div>` : ''}</div>
      <div class="field"><div class="eyebrow">How common in the US</div><div class="val">${esc(usText(n))}</div></div>
      ${n.nicknames && n.nicknames.length ? `<div class="field"><div class="eyebrow">Nicknames</div><div class="tags">${n.nicknames.map(x => `<span class="tag">${esc(x)}</span>`).join('')}</div></div>` : ''}
      ${n.themes && n.themes.length ? `<div class="field"><div class="eyebrow">Themes</div><div class="tags">${n.themes.map(x => `<span class="tag acc">${esc(x)}</span>`).join('')} <span class="tag">${esc(n.category)}</span></div></div>` : ''}
      <div class="field"><div class="eyebrow">Why it was suggested to you</div><div class="val small muted" id="whyLine"></div></div>
      <div class="field"><div class="eyebrow">Your note (${PEOPLE[S.me]})</div><textarea class="note" id="noteBox" placeholder="e.g. Aai suggested this / sounds great with Gawande">${esc(my && my.note || '')}</textarea></div>
      <div class="field"><div class="eyebrow">The deeper story</div>
        <div id="storyBox" class="val small">${story ? fmtStory(story) : ''}</div>
        <button class="btn ghost" id="storyBtn" style="margin-top:8px">${ICON.spark} ${story ? 'Ask Claude again' : 'Ask Claude about ' + esc(n.name)}</button>
      </div>
    `, 'detail');
    wireSayRow($('#sheetBody'), n);
    $$('.detail .votes button').forEach(b => b.onclick = () => {
      const kind = b.dataset.v;
      if (my && my.v === kind) { delete S.votes[id]; save(); retrain(); } else { vote(id, kind, true); }
      buildQueue(S.queue.slice(0, 3).map(x => x.id)); renderDeck(); renderList(); openDetail(id); scheduleSync();
    });
    $('#noteBox').oninput = e => {
      if (!S.votes[id]) S.votes[id] = { v: 'skip', t: Date.now(), tags: [] };
      S.votes[id].note = e.target.value; S.votes[id].t = Date.now(); save(); scheduleSync();
    };
    // why line: top learned features that fire for this name
    const fs = Learn.features(n).map(f => ({ f, w: S.weights[f] || 0 })).filter(x => Math.abs(x.w) > 0.15).sort((a, b) => Math.abs(b.w) - Math.abs(a.w)).slice(0, 4);
    const ratedN = Object.values(S.votes).filter(v => v.v !== 'skip').length;
    $('#whyLine').textContent = ratedN < 6 ? 'Ranked on uniqueness and ease of saying for now — your taste kicks in after a few more swipes.' : fs.length ? fs.map(x => (x.w > 0 ? '+ ' : '− ') + Learn.label(x.f)).join(' · ') : 'A neutral pick for you — ranked on uniqueness and ease.';
    $('#storyBtn').onclick = async () => {
      const key = S.settings.apiKey; if (!key) { toast('Add your Claude key in Settings first'); return; }
      const btn = $('#storyBtn'); btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Asking Claude…';
      try { const t = await Claude.story(key, n); S.stories[id] = t; save(); $('#storyBox').innerHTML = fmtStory(t); btn.innerHTML = ICON.spark + ' Ask Claude again'; scheduleSync(); }
      catch (e) { toast('Claude: ' + e.message); btn.innerHTML = ICON.spark + ' Try again'; }
      btn.disabled = false;
    };
  }
  function fmtStory(t) { return esc(t).replace(/\*\*(.+?)\*\*/g, '<b style="color:var(--accent)">$1</b>').replace(/\*(.+?)\*/g, '<i>$1</i>').replace(/\n\n/g, '<br><br>').replace(/\n/g, '<br>'); }

  // ---------- Shortlist ----------
  const SEGS = [['both', 'Both ♥'], ['mine', 'Mine'], ['partner', 'Theirs'], ['loved', 'Loved ★'], ['passed', 'Passed']];
  function listSets() {
    const liked = v => v && (v.v === 'like' || v.v === 'love');
    const ids = S.names.map(n => n.id);
    return {
      both: ids.filter(id => liked(S.votes[id]) && liked(S.partnerVotes[id])),
      mine: ids.filter(id => liked(S.votes[id])),
      partner: ids.filter(id => liked(S.partnerVotes[id])),
      loved: ids.filter(id => (S.votes[id] && S.votes[id].v === 'love') || (S.partnerVotes[id] && S.partnerVotes[id].v === 'love')),
      passed: ids.filter(id => S.votes[id] && S.votes[id].v === 'dislike'),
    };
  }
  function renderList() {
    const sets = listSets();
    $('#listSeg').innerHTML = SEGS.map(([k, l]) => `<button class="${S.listSeg === k ? 'on' : ''}" data-k="${k}">${k === 'partner' ? PEOPLE[S.partner] + "'s" : l}<span class="n">${sets[k].length}</span></button>`).join('');
    $$('#listSeg button').forEach(b => b.onclick = () => { S.listSeg = b.dataset.k; renderList(); });
    const ids = sets[S.listSeg].slice().sort((a, b) => ((S.votes[b] || S.partnerVotes[b] || {}).t || 0) - ((S.votes[a] || S.partnerVotes[a] || {}).t || 0));
    if (!ids.length) {
      const msg = { both: `Names you both like land here. ${Object.keys(S.partnerVotes).length ? 'Keep swiping — no overlap yet.' : 'Connect sync in Settings so ' + PEOPLE[S.partner] + "'s swipes arrive."}`, mine: 'Swipe right on a name and it appears here.', partner: `${PEOPLE[S.partner]}'s likes show up after a sync.`, loved: 'Swipe up (or tap ★) for the ones you truly love.', passed: 'Names you passed on, in case you change your mind.' }[S.listSeg];
      $('#list').innerHTML = `<div class="empty glass"><p class="muted">${msg}</p></div>`; return;
    }
    $('#list').innerHTML = ids.map(id => { const n = S.byId[id]; return `<div class="row glass" data-id="${id}">${shapeIcon(n.category)}<div class="rn">${esc(n.name)}<small>${esc(n.say)} · ${esc(n.meaning)}</small></div><div class="marks">${markHTML(S.votes[id], PEOPLE[S.me])}${markHTML(S.partnerVotes[id], PEOPLE[S.partner])}</div></div>`; }).join('');
    $$('#list .row').forEach(r => r.onclick = () => openDetail(r.dataset.id));
  }
  function updateBadges() {
    const b = listSets().both.length; const el = $('#bothBadge'); el.style.display = b ? 'grid' : 'none'; el.textContent = b;
  }

  // ---------- Face-off (Elo over everything both of you compared) ----------
  function candidates() {
    const sets = listSets();
    return sets.both.length >= 2 ? sets.both : sets.mine;
  }
  function ratings(list) {
    const r = {}, games = {};
    list.forEach(f => {
      r[f.a] = r[f.a] || 1500; r[f.b] = r[f.b] || 1500; games[f.a] = (games[f.a] || 0) + 1; games[f.b] = (games[f.b] || 0) + 1;
      const ea = 1 / (1 + Math.pow(10, (r[f.b] - r[f.a]) / 400));
      const sa = f.w === f.a ? 1 : 0;
      r[f.a] += 32 * (sa - ea); r[f.b] += 32 * ((1 - sa) - (1 - ea));
    });
    return { r, games };
  }
  function pickPair(c) {
    const { r, games } = ratings(S.faceoffs.concat(S.partnerFaceoffs));
    const pool = c.slice().sort((a, b) => (games[a] || 0) - (games[b] || 0));
    const a = pool[0];
    const rest = pool.slice(1).sort((x, y) => Math.abs((r[x] || 1500) - (r[a] || 1500)) - Math.abs((r[y] || 1500) - (r[a] || 1500)));
    // among the closest few, prefer ones we haven't faced against a
    const faced = new Set(S.faceoffs.filter(f => f.a === a || f.b === a).map(f => (f.a === a ? f.b : f.a)));
    const b = rest.find(x => !faced.has(x)) || rest[0];
    return Math.random() < 0.5 ? [a, b] : [b, a];
  }
  function renderFaceoff() {
    const c = candidates(); const box = $('#faceoff');
    const { r, games } = ratings(S.faceoffs.concat(S.partnerFaceoffs));
    const board = c.slice().sort((a, b) => (r[b] || 1500) - (r[a] || 1500));
    if (c.length < 2) {
      box.innerHTML = `<h2 class="title">Face-off</h2><div class="empty glass"><div class="big">Need two contenders.</div><p class="muted">Face-off pits your shortlist against itself, two names at a time, until a clear favourite emerges. Like at least two names first.</p></div>`; return;
    }
    if (!S.faceoffPair || !c.includes(S.faceoffPair[0]) || !c.includes(S.faceoffPair[1])) S.faceoffPair = pickPair(c);
    const [a, b] = S.faceoffPair; const na = S.byId[a], nb = S.byId[b];
    const total = S.faceoffs.length + S.partnerFaceoffs.length;
    const opt = n => `<button class="opt glass" data-id="${n.id}"><div style="margin-bottom:6px">${shapeIcon(n.category).replace('shapeglyph', 'shapeglyph big')}</div><div class="name">${esc(n.name)}</div><div class="m">${esc(n.meaning)}</div><div class="s">${esc(n.say)} · ${n.name} ${SURNAME}</div></button>`;
    box.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:baseline"><h2 class="title" style="margin-bottom:4px">Which one?</h2><span class="mini">${listSets().both.length >= 2 ? 'from Both ♥' : 'from your likes'} · ${total} rounds</span></div>
      <div class="vs">${opt(na)}<div class="mid">versus<button id="skipPair">skip this pair</button></div>${opt(nb)}</div>
      <div class="panel glass" style="margin:12px 0 96px"><div class="eyebrow" style="margin-bottom:8px">Standings</div>
        ${board.slice(0, 6).map((id, i) => `<div class="row" style="padding:6px 0;margin:0;background:none;border:0;box-shadow:none"><div class="rank m${i + 1}">${i + 1}</div><div class="rn" style="font-size:19px">${esc(S.byId[id].name)}</div><div class="elo">${Math.round(r[id] || 1500)} · ${games[id] || 0} rounds</div></div>`).join('')}
      </div>`;
    $$('#faceoff .opt').forEach(o => o.onclick = () => {
      const w = o.dataset.id; S.faceoffs.push({ a, b, w, t: Date.now() }); save(); scheduleSync();
      o.style.transform = 'scale(1.04)'; setTimeout(() => { S.faceoffPair = pickPair(c); renderFaceoff(); }, 180);
    });
    $('#skipPair').onclick = () => { S.faceoffPair = pickPair(c); renderFaceoff(); };
  }

  // ---------- Taste ----------
  function renderTaste() {
    const rated = Object.values(S.votes).filter(v => v.v !== 'skip');
    const likes = rated.filter(v => v.v !== 'dislike').length;
    const mine = Learn.explain(S.weights, S.names, S.votes, 10);
    const theirs = Learn.explain(S.partnerWeights, S.names, S.partnerVotes, 6);
    const bars = rows => rows.length ? `<div class="bars">${rows.map(r => `<div class="bar"><span class="k">${esc(r.label)}</span><span class="t"><i class="${r.w < 0 ? 'neg' : ''}" style="width:${Math.min(50, Math.abs(r.w) * 18)}%;${r.w < 0 ? 'left:auto;right:50%' : ''}"></i></span><span class="v">${r.w > 0 ? '+' : ''}${r.w.toFixed(1)}</span></div>`).join('')}</div>` : '<p class="muted small">Not enough swipes yet — rate 10 or so names and the pattern appears here.</p>';
    const genOK = !!S.settings.apiKey;
    $('#taste').innerHTML = `
      <h2 class="title">Your taste</h2>
      <div class="panel glass"><div class="kv">
        <div class="stat"><div class="v">${rated.length}</div><div class="k">Rated</div></div>
        <div class="stat"><div class="v">${rated.length ? Math.round(100 * likes / rated.length) : 0}%</div><div class="k">Liked</div></div>
        <div class="stat"><div class="v good">${listSets().both.length}</div><div class="k">Both ♥</div></div>
      </div></div>
      <div class="panel glass"><h3>What ${PEOPLE[S.me]} leans toward</h3>${bars(mine)}</div>
      ${Object.keys(S.partnerVotes).length ? `<div class="panel glass"><h3>What ${PEOPLE[S.partner]} leans toward</h3>${bars(theirs)}</div>` : ''}
      <div class="panel glass"><h3>${ICON.spark} Ask Claude for more</h3>
        <p class="muted small" style="margin:0 0 10px">Claude reads both of your swipes and reasons, then invents 20 new names in that direction — checked against real US baby-name counts. They show up in Discover with a ✦.</p>
        <input class="text" id="direction" placeholder="Optional steer, e.g. “more Marathi words”, “2 syllables only”, “names about the sky”" style="margin-bottom:10px">
        <button class="btn primary" id="genBtn" ${genOK ? '' : 'disabled'}>${S.generating ? '<span class="spin"></span> Claude is thinking…' : ICON.spark + ' Generate 20 new names'}</button>
        ${genOK ? '' : '<div class="status">Add your Claude API key in Settings to enable this.</div>'}
        <div class="status" id="genStatus">${S.extras.length ? S.extras.length + ' Claude-suggested names in the pool so far.' : ''}</div>
      </div>
      <div class="panel glass"><h3>How names are ranked</h3><p class="muted small" style="margin:0">Every name starts with a score from <b>uniqueness</b> (real Social Security counts — how many US boys got the name in 2024) and <b>ease of saying</b> for non-Indian Americans, plus a little for freshness. Your swipes train a small model on syllables, endings, sounds, themes and origins — that pushes names you'd probably like to the front. ${PEOPLE[S.partner]}'s likes get a boost too, so you converge instead of drifting apart.</p></div>
      <div style="height:20px"></div>`;
    if (genOK) $('#genBtn').onclick = () => generateMore($('#direction').value.trim());
  }
  async function generateMore(direction) {
    if (S.generating) return; S.generating = true; renderTaste(); $('#syncBtn').classList.add('busy');
    try {
      const out = await Claude.generate({ apiKey: S.settings.apiKey, names: S.names, exclude: S.exclude, votes: S.votes, partnerVotes: S.partnerVotes, me: PEOPLE[S.me], partner: PEOPLE[S.partner], explain: Learn.explain(S.weights, S.names, S.votes, 8), count: 20, direction });
      out.forEach(scoreExtra);
      S.extras = S.extras.concat(out); save(); rebuildNames(); buildQueue([]); renderDeck();
      toast(`Claude added ${out.length} new names — see Discover`);
      scheduleSync(0);
    } catch (e) { toast('Claude: ' + e.message); }
    S.generating = false; $('#syncBtn').classList.remove('busy'); renderTaste();
  }

  // ---------- Browse by letter ----------
  function openAZ() {
    const counts = {};
    S.names.forEach(n => { const L = n.name[0].toUpperCase(); counts[L] = (counts[L] || 0) + 1; });
    const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
    openSheet(`<h2 class="title">Browse by letter</h2>
      <p class="muted small" style="margin:0 0 12px">Tap a letter to see every name that starts with it${S.settings.letter ? ` · currently swiping only <b>${S.settings.letter}</b>` : ''}.</p>
      <div class="azgrid">${letters.map(L => `<button data-l="${L}" ${counts[L] ? '' : 'disabled'} class="${S.settings.letter === L ? 'on' : ''}">${L}<small>${counts[L] || '—'}</small></button>`).join('')}</div>
      ${S.settings.letter ? '<button class="btn ghost" id="azAll" style="margin-top:14px">Swipe every letter again</button>' : ''}`);
    $$('.azgrid button').forEach(b => b.onclick = () => openLetter(b.dataset.l));
    if ($('#azAll')) $('#azAll').onclick = () => { S.settings.letter = ''; save(); refreshAll(); openAZ(); };
  }
  function openLetter(L) {
    const list = S.names.filter(n => n.name[0].toUpperCase() === L).sort((a, b) => a.name.localeCompare(b.name));
    const only = S.settings.letter === L;
    openSheet(`<button class="backlink" id="azBack">‹ All letters</button>
      <h2 class="title" style="margin-top:0">${L} <span class="muted" style="font-size:16px">· ${list.length} names</span></h2>
      <button class="btn ${only ? 'primary' : ''}" id="azOnly" style="margin-bottom:12px">${only ? '✓ Swiping only ' + L + ' — tap to show all letters' : 'Swipe only ' + L + ' names in Discover'}</button>
      ${list.map(n => `<div class="row glass" data-id="${n.id}">${shapeIcon(n.category)}<div class="rn">${esc(n.name)}${n.dev ? ' <span class="muted" style="font-size:15px">' + esc(n.dev) + '</span>' : ''}<small>${esc(n.say)} · ${esc(n.meaning)}</small></div><div class="marks">${markHTML(S.votes[n.id], PEOPLE[S.me])}${markHTML(S.partnerVotes[n.id], PEOPLE[S.partner])}</div></div>`).join('')}`);
    $('#azBack').onclick = openAZ;
    $('#azOnly').onclick = () => { S.settings.letter = only ? '' : L; save(); refreshAll(); showTab('discover'); closeSheet(); toast(only ? 'Showing every letter' : 'Discover now shows only ' + L + ' names'); };
    $$('#sheetBody .row').forEach(r => r.onclick = () => openDetail(r.dataset.id));
  }
  $('#azBtn').onclick = openAZ;

  // ---------- Settings ----------
  function openSettings() {
    const st = S.settings;
    openSheet(`
      <h2 class="title">Settings</h2>
      <div class="panel glass"><div class="eyebrow" style="margin-bottom:8px">This phone belongs to</div>
        <div class="who">${Object.keys(PEOPLE).map(k => `<button class="${S.me === k ? 'on' : ''}" data-me="${k}">${PEOPLE[k]}<small>${k === S.me ? 'you' : 'switch'}</small></button>`).join('')}</div></div>
      <div class="panel glass">
        <div class="setting"><div class="l"><b>Accent</b><span>The glow colour.</span></div><div class="swatches">${['sky', 'violet', 'mint', 'rose', 'gold'].map(a => `<button class="swatch ${st.accent === a ? 'on' : ''}" data-a="${a}" style="background:${({ sky: '#38bdf8', violet: '#a78bfa', mint: '#34d399', rose: '#fb7185', gold: '#fbbf24' })[a]}"></button>`).join('')}</div></div>
        <div class="setting"><div class="l"><b>Max syllables</b><span>Hide longer names from Discover.</span></div><div class="stepper"><button data-s="-1">−</button><b id="sylVal">${st.maxSyl}</b><button data-s="1">+</button></div></div>
        <div class="setting"><div class="l"><b>Min “easy to say”</b><span>Hide names below this score.</span></div><div class="stepper"><button data-e="-10">−</button><b id="sayVal">${st.minSay}</b><button data-e="10">+</button></div></div>
        <div class="setting"><div class="l"><b>Hide coined names</b><span>Only names with a traditional track record.</span></div><button class="toggle ${st.hideCoined ? 'on' : ''}" id="tCoined"></button></div>
        <div class="setting"><div class="l"><b>Hide better-known names</b><span>Only names under ~25 US boys a year.</span></div><button class="toggle ${st.hideKnown ? 'on' : ''}" id="tKnown"></button></div>
      </div>
      <div class="panel glass"><h3>Sync with ${PEOPLE[S.partner]}</h3>
        <p class="muted small" style="margin:0 0 8px">Votes travel through the private GitHub repo <b>${Sync.OWNER}/${Sync.REPO}</b>. Paste a fine-grained token with <b>Contents: read &amp; write</b> on that one repo.</p>
        <input class="text" id="tokenBox" type="password" placeholder="github_pat_…" value="${esc(st.token)}" autocapitalize="off" autocomplete="off">
        <div class="status" id="tokenStatus">${st.lastSync ? 'Last synced ' + new Date(st.lastSync).toLocaleString() : 'Not connected yet'}</div>
        <div class="btnrow" style="margin-top:10px"><button class="btn" id="tokenTest">Connect &amp; sync</button></div>
      </div>
      <div class="panel glass"><h3>Claude</h3>
        <p class="muted small" style="margin:0 0 8px">Your Anthropic API key powers “Ask Claude for more” and the deeper stories. It stays on this phone.</p>
        <input class="text" id="keyBox" type="password" placeholder="sk-ant-…" value="${esc(st.apiKey)}" autocapitalize="off" autocomplete="off">
        <div class="status" id="keyStatus">${st.apiKey ? 'Key saved · model ' + Claude.MODEL : 'No key yet'}</div>
      </div>
      <div class="panel glass"><h3>Voices</h3>
        <p class="muted small" style="margin:0 0 8px">Which of the phone's voices the two buttons use. Download better ones under Settings → Accessibility → Spoken Content → Voices, then reopen the app.</p>
        <div class="setting"><div class="l"><b>Marathi button</b><span>Reads the Devanagari. Hindi premium voice recommended.</span></div></div>
        <select class="text" id="voiceIN" style="margin:-4px 0 10px">${voiceOptions('in') || '<option>No Hindi/Marathi voice found</option>'}</select>
        <div class="setting"><div class="l"><b>English button</b><span>Reads the respelling the American way.</span></div></div>
        <select class="text" id="voiceUS" style="margin:-4px 0 4px">${voiceOptions('us') || '<option>No English voice found</option>'}</select>
        <div class="btnrow" style="margin-top:8px"><button class="btn ghost" id="voiceTestIN">▶ Test Marathi</button><button class="btn ghost" id="voiceTestUS">▶ Test English</button></div>
      </div>
      <div class="panel glass"><h3>Backup</h3>
        <div class="btnrow"><button class="btn ghost" id="exportBtn">Copy backup</button><button class="btn ghost" id="importBtn">Paste backup</button></div>
        <div class="status">A backup is a text blob of your votes, notes and Claude names. Deleting the app from the Home Screen deletes its data — copy a backup first.</div>
        <button class="btn danger" id="resetBtn" style="margin-top:10px">Clear my votes on this phone</button>
      </div>
      <p class="mini" style="text-align:center">Rename v${APP_VERSION} · built ${APP_BUILT}<br>${S.pool.length} names in the pool · for ${PEOPLE.abodh} &amp; ${PEOPLE.amruta}</p>
      <div style="height:10px"></div>
    `);
    $$('.who button', $('#sheetBody')).forEach(b => b.onclick = () => { setMe(b.dataset.me); openSettings(); });
    $$('.swatch').forEach(b => b.onclick = () => { S.settings.accent = b.dataset.a; applyAccent(); save(); openSettings(); });
    $$('[data-s]').forEach(b => b.onclick = () => { S.settings.maxSyl = Math.max(1, Math.min(5, S.settings.maxSyl + +b.dataset.s)); $('#sylVal').textContent = S.settings.maxSyl; save(); refreshAll(); });
    $$('[data-e]').forEach(b => b.onclick = () => { S.settings.minSay = Math.max(10, Math.min(100, S.settings.minSay + +b.dataset.e)); $('#sayVal').textContent = S.settings.minSay; save(); refreshAll(); });
    $('#tCoined').onclick = e => { S.settings.hideCoined = !S.settings.hideCoined; e.target.classList.toggle('on'); save(); refreshAll(); };
    $('#tKnown').onclick = e => { S.settings.hideKnown = !S.settings.hideKnown; e.target.classList.toggle('on'); save(); refreshAll(); };
    $('#tokenBox').onchange = e => { S.settings.token = e.target.value.trim(); save(); };
    $('#keyBox').onchange = e => { S.settings.apiKey = e.target.value.trim(); save(); $('#keyStatus').textContent = S.settings.apiKey ? 'Key saved · model ' + Claude.MODEL : 'No key yet'; };
    $('#tokenTest').onclick = async () => {
      S.settings.token = $('#tokenBox').value.trim(); save();
      const s = $('#tokenStatus'); s.className = 'status';
      if (!S.settings.token) { s.textContent = 'Paste a token first.'; return; }
      s.innerHTML = '<span class="spin"></span> Checking…';
      try { await Sync.check(S.settings.token); await doSync(); s.className = 'status ok'; s.textContent = 'Connected · synced just now'; }
      catch (e) { s.className = 'status err'; s.textContent = e.message; }
    };
    $('#voiceIN').onchange = e => { S.settings.voiceIN = e.target.value; save(); };
    $('#voiceUS').onchange = e => { S.settings.voiceUS = e.target.value; save(); };
    const demo = S.queue[0] || S.names[0] || { name: 'Anvay', say: 'UN-vay', dev: 'अन्वय' };
    $('#voiceTestIN').onclick = () => sayIN(demo);
    $('#voiceTestUS').onclick = () => sayUS(demo);
    $('#exportBtn').onclick = async () => {
      const blob = JSON.stringify({ rename: APP_VERSION, me: S.me, votes: S.votes, faceoffs: S.faceoffs, extras: S.extras, stories: S.stories, settings: Object.assign({}, S.settings, { token: '', apiKey: '' }) });
      try { await navigator.clipboard.writeText(blob); toast('Backup copied — paste it somewhere safe'); }
      catch (e) { openSheet(`<h2 class="title">Backup</h2><textarea class="note" style="min-height:200px">${esc(blob)}</textarea><p class="mini">Select all and copy.</p>`); }
    };
    $('#importBtn').onclick = () => {
      openSheet(`<h2 class="title">Paste backup</h2><textarea class="note" id="impBox" style="min-height:160px" placeholder="Paste the backup text here"></textarea><button class="btn primary" id="impGo" style="margin-top:10px">Restore</button>`);
      $('#impGo').onclick = () => {
        try {
          const j = JSON.parse($('#impBox').value); if (!j.rename) throw new Error('not a Rename backup');
          S.votes = Object.assign({}, S.votes, j.votes || {}); S.faceoffs = S.faceoffs.concat(j.faceoffs || []); S.extras = S.extras.concat((j.extras || []).filter(x => !S.byId[x.id])); S.stories = Object.assign({}, S.stories, j.stories || {});
          save(); rebuildNames(); buildQueue([]); refreshAll(); closeSheet(); toast('Backup restored');
        } catch (e) { toast('Could not read that: ' + e.message); }
      };
    };
    $('#resetBtn').onclick = () => {
      openSheet(`<h2 class="title">Clear my votes?</h2><p class="muted">This wipes ${PEOPLE[S.me]}'s swipes, notes and face-offs on this phone. ${S.settings.token ? 'The next sync will also clear them in the shared repo.' : ''}</p><div class="btnrow"><button class="btn ghost" id="noReset">Keep</button><button class="btn danger" id="yesReset">Clear</button></div>`);
      $('#noReset').onclick = openSettings;
      $('#yesReset').onclick = () => { S.votes = {}; S.faceoffs = []; S.history = []; save(); retrain(); buildQueue([]); refreshAll(); closeSheet(); toast('Cleared'); resetWritten = true; };
    };
  }
  let resetWritten = false;
  function applyAccent() { document.documentElement.dataset.accent = S.settings.accent; }
  function setMe(me) {
    if (me === S.me) return;
    // Swapping identity on one phone: my votes become the partner's and vice versa.
    const v = S.votes, f = S.faceoffs; S.votes = S.partnerVotes; S.partnerVotes = v; S.faceoffs = S.partnerFaceoffs; S.partnerFaceoffs = f;
    S.me = me; S.partner = partnerOf(me); LS.set('me', me); save(); retrain(); buildQueue([]); refreshAll();
    $('#whoLabel').textContent = PEOPLE[me];
  }

  // ---------- Sync orchestration ----------
  let syncTimer = null;
  function scheduleSync(ms) { if (!S.settings.token) return; clearTimeout(syncTimer); syncTimer = setTimeout(doSync, ms == null ? 4000 : ms); }
  async function doSync() {
    if (!S.settings.token || S.syncing) return; S.syncing = true; $('#syncBtn').classList.add('busy');
    try {
      const res = await Sync.syncAll(S.settings.token, { me: S.me, partner: S.partner, votes: S.votes, faceoffs: S.faceoffs, extras: S.extras, stories: S.stories });
      if (resetWritten) resetWritten = false;
      S.votes = res.votes; S.faceoffs = res.faceoffs; S.partnerVotes = res.partnerVotes; S.partnerFaceoffs = res.partnerFaceoffs; S.stories = res.stories;
      const before = S.extras.length; S.extras = res.extras; if (S.extras.length !== before) { rebuildNames(); }
      if (res.secrets && res.secrets.anthropicKey && !S.settings.apiKey) { S.settings.apiKey = res.secrets.anthropicKey; }
      S.settings.lastSync = Date.now(); save(); retrain(); buildQueue(S.queue.slice(0, 3).map(n => n.id)); refreshAll(true);
    } catch (e) { toast('Sync: ' + e.message); }
    S.syncing = false; $('#syncBtn').classList.remove('busy');
  }
  $('#syncBtn').onclick = () => { if (!S.settings.token) { openSettings(); toast('Connect sync first'); } else { doSync(); toast('Syncing…'); } };

  // ---------- Tabs / refresh ----------
  function showTab(t) {
    S.tab = t; $$('nav.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
    $$('.screen').forEach(s => s.classList.toggle('on', s.id === 's-' + t));
    hideReasons();
    if (t === 'shortlist') renderList(); if (t === 'faceoff') renderFaceoff(); if (t === 'taste') renderTaste();
  }
  $$('nav.tabs button').forEach(b => b.onclick = () => showTab(b.dataset.tab));
  function refreshAll(keepDeck) {
    if (!keepDeck) buildQueue(S.queue.slice(0, 3).map(n => n.id));
    renderDeck(); if (S.tab === 'shortlist') renderList(); if (S.tab === 'faceoff') renderFaceoff(); if (S.tab === 'taste') renderTaste();
  }
  $('#settingsBtn').onclick = openSettings;
  $('#undoBtn').onclick = undo;
  $$('.deckbtns [data-vote]').forEach(b => b.onclick = () => { const c = $('.card.top'); if (!c) return; if (b.dataset.vote === 'skip') vote(c.dataset.id, 'skip'); else flyOff(c, b.dataset.vote); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.settings.token && Date.now() - S.settings.lastSync > 60000) doSync(); });
  // Keyboard (Mac preview / iPad keyboard)
  document.addEventListener('keydown', e => {
    if ($('#sheetwrap').classList.contains('on') || /INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
    const c = $('.card.top'); if (!c || S.tab !== 'discover') return;
    if (e.key === 'ArrowRight') flyOff(c, 'skip'); else if (e.key === 'ArrowLeft') undo(); else if (e.key === 'l') flyOff(c, 'like'); else if (e.key === 'x') flyOff(c, 'dislike'); else if (e.key === 's') flyOff(c, 'love'); else if (e.key === 'Enter') openDetail(c.dataset.id);
  });

  // ---------- Onboarding + boot ----------
  function onboard() {
    const o = $('#onboard'); o.style.display = 'flex'; let pick = null;
    $('#onboardWho').innerHTML = Object.keys(PEOPLE).map(k => `<button data-me="${k}">${PEOPLE[k]}</button>`).join('');
    $$('#onboardWho button').forEach(b => b.onclick = () => { pick = b.dataset.me; $$('#onboardWho button').forEach(x => x.classList.toggle('on', x === b)); $('#onboardGo').disabled = false; });
    $('#onboardGo').onclick = () => { S.me = pick; S.partner = partnerOf(pick); LS.set('me', pick); $('#whoLabel').textContent = PEOPLE[pick]; o.style.display = 'none'; buildQueue([]); renderDeck(); };
  }
  async function boot() {
    applyAccent();
    await loadData();
    if (!S.me) onboard(); else { S.partner = partnerOf(S.me); $('#whoLabel').textContent = PEOPLE[S.me]; buildQueue([]); renderDeck(); if (S.settings.token) doSync(); }
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
      let reloaded = false; navigator.serviceWorker.addEventListener('controllerchange', () => { if (!reloaded) { reloaded = true; location.reload(); } });
    }
    // A setup link (#setup=…) from Abodh's Mac pre-fills the tokens once, then is removed from the URL.
    if (location.hash.startsWith('#setup=')) {
      try { const j = JSON.parse(atob(decodeURIComponent(location.hash.slice(7)))); if (j.token) S.settings.token = j.token; if (j.apiKey) S.settings.apiKey = j.apiKey; if (j.me && PEOPLE[j.me]) { S.me = j.me; S.partner = partnerOf(j.me); LS.set('me', j.me); $('#whoLabel').textContent = PEOPLE[j.me]; $('#onboard').style.display = 'none'; buildQueue([]); renderDeck(); } save(); history.replaceState(null, '', location.pathname); toast('Set up ✓ — syncing'); doSync(); } catch (e) {}
    }
  }
  window.__rename = S;
  boot();
})();
