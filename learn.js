/* Rename — taste learner.
   A small, explainable online logistic model over hand-made name features.
   Every vote nudges feature weights; reasons chips nudge the matching features harder.
   Weights are stored per person and synced, so the partner's phone can show "what Amruta likes". */
(function () {
  'use strict';

  const VOWELS = 'aeiou';

  function endsWithAny(s, list) { return list.find(x => s.endsWith(x)); }

  // Features are strings so they can be explained ("ends with -ay", "3 syllables", "theme: sky").
  function features(n) {
    const f = [];
    const s = n.id;
    f.push('syl:' + Math.min(4, n.syllables));
    f.push('len:' + (s.length <= 4 ? 'short' : s.length <= 6 ? 'medium' : 'long'));
    f.push('start:' + s[0]);
    f.push('startv:' + (VOWELS.includes(s[0]) ? 'vowel' : 'consonant'));
    f.push('end:' + s.slice(-2));
    f.push('endv:' + (VOWELS.includes(s.slice(-1)) ? 'vowel' : 'consonant'));
    f.push('cat:' + n.category);
    f.push('origin:' + n.origin);
    f.push('trad:' + n.tradition);
    (n.themes || []).forEach(t => f.push('theme:' + t));
    if (/sh/.test(s)) f.push('has:sh');
    if (/v/.test(s)) f.push('has:v');
    if (/y/.test(s)) f.push('has:y');
    if (/r/.test(s)) f.push('has:r');
    if (/aa|ee|oo/.test(s)) f.push('has:doublevowel');
    f.push('unique:' + (n.unique >= 90 ? 'veryrare' : n.unique >= 60 ? 'rare' : 'known'));
    f.push('say:' + (n.sayability >= 80 ? 'easy' : n.sayability >= 60 ? 'ok' : 'tricky'));
    return f;
  }

  // Reason chips → the features they speak about (so "too long" mostly moves length/syllable weights).
  const REASON_FOCUS = {
    'Too common': ['unique:'], 'Hard to say': ['say:', 'has:sh', 'has:doublevowel'], 'Sounds old': ['trad:', 'cat:'],
    'Not my sound': ['start:', 'end:', 'endv:', 'startv:'], 'Meaning': ['theme:', 'cat:'], 'Too long': ['syl:', 'len:'],
    'Too short': ['syl:', 'len:'], 'Ending': ['end:', 'endv:'], 'Sounds like a girl\'s name': ['end:', 'endv:'],
    'Sound': ['start:', 'end:', 'endv:', 'startv:'], 'Easy to say': ['say:'], 'Short & crisp': ['syl:', 'len:'],
    'Unique': ['unique:'], 'Feels modern': ['trad:', 'cat:'], 'Marathi feel': ['origin:', 'cat:'], 'Strong': ['end:', 'has:r'],
    'Soft': ['endv:', 'startv:'],
  };
  const REASONS = {
    dislike: ['Too common', 'Hard to say', 'Sounds old', 'Not my sound', 'Meaning', 'Too long', 'Too short', 'Ending', 'Sounds like a girl\'s name'],
    like: ['Sound', 'Meaning', 'Easy to say', 'Short & crisp', 'Unique', 'Feels modern', 'Marathi feel', 'Strong', 'Soft'],
  };

  function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

  // Rebuild weights from the full vote history (cheap: a few hundred votes × ~20 features).
  function train(names, votes) {
    const w = Object.create(null);
    const byId = Object.create(null);
    names.forEach(n => { byId[n.id] = n; });
    const items = Object.keys(votes).map(id => ({ id, v: votes[id] })).filter(x => byId[x.id] && x.v.v !== 'skip')
      .sort((a, b) => (a.v.t || 0) - (b.v.t || 0));
    const lr = 0.35;
    for (let epoch = 0; epoch < 3; epoch++) {
      for (const it of items) {
        const n = byId[it.id];
        const fs = features(n);
        const y = it.v.v === 'dislike' ? 0 : 1;
        const weight = it.v.v === 'love' ? 2 : 1;
        let z = 0; fs.forEach(f => { z += (w[f] || 0); });
        const p = sigmoid(z);
        const g = (y - p) * lr * weight;
        const focus = new Set();
        (it.v.tags || []).forEach(t => (REASON_FOCUS[t] || []).forEach(p => focus.add(p)));
        fs.forEach(f => {
          const boosted = [...focus].some(pref => f.startsWith(pref)) ? 2.2 : 1;
          w[f] = (w[f] || 0) + g * boosted;
        });
      }
    }
    return w;
  }

  function score(w, n) {
    let z = 0; features(n).forEach(f => { z += (w[f] || 0); });
    return z; // log-odds; ~0 when nothing learned
  }

  // Human labels for explanation.
  function label(f) {
    const [k, v] = f.split(':');
    switch (k) {
      case 'syl': return v + (v === '1' ? ' syllable' : ' syllables');
      case 'len': return v + ' names';
      case 'start': return 'starts with ' + v.toUpperCase();
      case 'startv': return 'starts with a ' + v;
      case 'end': return 'ends in -' + v;
      case 'endv': return 'ends in a ' + v;
      case 'cat': return v + ' names';
      case 'origin': return v + ' origin';
      case 'trad': return v.replace('-', ' ') + ' names';
      case 'theme': return 'theme: ' + v;
      case 'has': return v === 'doublevowel' ? 'double vowels (aa/ee/oo)' : 'the sound “' + v + '”';
      case 'unique': return v === 'veryrare' ? 'very rare names' : v === 'rare' ? 'rare names' : 'better-known names';
      case 'say': return v === 'easy' ? 'easy-to-say names' : v === 'ok' ? 'moderately easy names' : 'tricky-to-say names';
    }
    return f;
  }

  function explain(w, names, votes, limit) {
    // Only explain features seen in at least 3 voted names — avoids one-off noise.
    const seen = Object.create(null);
    const byId = Object.create(null); names.forEach(n => { byId[n.id] = n; });
    Object.keys(votes).forEach(id => { const n = byId[id]; if (n && votes[id].v !== 'skip') features(n).forEach(f => { seen[f] = (seen[f] || 0) + 1; }); });
    const rows = Object.keys(w).filter(f => seen[f] >= 3).map(f => ({ f, w: w[f], label: label(f), n: seen[f] }));
    rows.sort((a, b) => Math.abs(b.w) - Math.abs(a.w));
    return rows.slice(0, limit || 12);
  }

  window.Learn = { features, train, score, explain, label, REASONS, REASON_FOCUS };
})();
