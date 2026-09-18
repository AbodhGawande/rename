/* Rename — Claude generation. Runs straight from the phone with the family's own API key.
   Two jobs: (1) "More names like the ones we love" — 20 fresh candidates that fit the criteria
   and the learned taste; (2) the deeper story of one name. */
(function () {
  'use strict';

  const URL = 'https://api.anthropic.com/v1/messages';
  const MODEL = 'claude-opus-5';

  const CRITERIA = `The child is a BOY born in 2025 in the USA to Marathi (Maharashtrian) Indian immigrant parents (born 1985 and 1991). He will grow up in the USA. Surname: Gawande. His current first name is Aarush; the parents are choosing a new first name.
Hard criteria for every suggestion:
1. Indian origin — Sanskrit, Marathi, Prakrit/Pali, Hindi usage. Never South-Indian-specific (no Tamil/Telugu/Kannada/Malayalam-specific names or forms).
2. Easy for non-Indian Americans to pronounce correctly from the spelling: prefer 2–3 syllables; avoid aspirated clusters (bh/dh/gh/chh/jh), retroflex-dependent sounds, and "th" that Americans read as English "th"; avoid names that read as an English word or invite a bad nickname.
3. Unique — not currently popular among Indian-American babies (nothing like Aarav, Vihaan, Arjun, Reyansh, Aditya, Ishaan, Krish, Rohan, Aryan, Advik, Dev, Neil, Kabir, Vivaan, Ayaan, Rishi, Arnav, Shaurya, Kian, Viraj, Rudra, Atharv, Aarush, Avyaan, Ahaan, Nirvaan, Yash, Dhruv, Om, Shiv, Veer, Ved, Vir, Anay, Shrey, Aayan, Rian, Nikhil, Sai, Samar, Sahil, Zayan, Ayush, Agastya, Reyan, Jay, Ishan, Kiaan, Ivaan, Advait, Ansh, Arin, Avi, Rehan, Ruhan, Shaan, Viaan, Yuvan, Vedant, Vansh, or their spelling variants; avoid the trendy -aan/-aansh endings).
4. Not an older-generation name common for Indian men born 1950–1995 (Rajesh, Sachin, Amol, Nilesh, Prashant, Mahesh, Sunil, Anil, Sandeep, Vikas, Amit, Rohit, Nitin, Sagar, Swapnil, Ganesh, Abhijit, Prasad, Tushar, Kiran, Vishal, Deepak, Manoj, Santosh, Ajay, Vijay, Sanjay, Pravin, Girish, Ashish, Sameer, Yogesh, Umesh, Milind, Makarand, Mandar, Kedar, Abhishek, Anand, and that whole generation).
5. Real, meaningful. A coined name must be built from genuine Sanskrit/Marathi parts with a defensible meaning and must be labelled tradition "coined". Never invent a meaning.`;

  const SCHEMA = `Each element must have exactly these keys:
{"name":"Anvay","alt":["Anvai"],"say":"UN-vay","syllables":2,"meaning":"connection, harmony","root":"Sanskrit anvaya (अन्वय)","origin":"Sanskrit","category":"nature","themes":["sky","light"],"sayability":8,"say_note":"reads as written; stress on first syllable","tradition":"traditional","region":"pan-Indian","collisions":"","nicknames":["Anu"],"confidence":"high","note":""}
origin ∈ Sanskrit|Marathi|Prakrit|Pali|Hindi|Coined · category ∈ nature|virtue|epic|marathi|sky|music|knowledge|light|sound|art|spirit|short|coined · sayability 1–10 (10 = any American says it right first time) · tradition ∈ traditional|rare-traditional|coined · region ∈ pan-Indian|north-west|marathi · confidence ∈ high|medium · collisions = awkward English word/nickname/initial issues or "" (initials will be <first letter>.G.).`;

  function nameLine(n, v) {
    const tags = (v && v.tags && v.tags.length) ? ` (${v.tags.join(', ')})` : '';
    const note = (v && v.note) ? ` — note: "${v.note}"` : '';
    return `${n.name} [${n.meaning}]${tags}${note}`;
  }

  function buildProfile(ctx) {
    const { names, votes, partnerVotes, me, partner, explain } = ctx;
    const byId = Object.create(null); names.forEach(n => { byId[n.id] = n; });
    const pick = (vs, kind) => Object.keys(vs).filter(id => vs[id].v === kind && byId[id]).map(id => nameLine(byId[id], vs[id]));
    const lines = [];
    lines.push(`${me} LOVES: ${pick(votes, 'love').join('; ') || '—'}`);
    lines.push(`${me} likes: ${pick(votes, 'like').join('; ') || '—'}`);
    lines.push(`${me} passed on: ${pick(votes, 'dislike').slice(-60).join('; ') || '—'}`);
    if (partnerVotes && Object.keys(partnerVotes).length) {
      lines.push(`${partner} LOVES: ${pick(partnerVotes, 'love').join('; ') || '—'}`);
      lines.push(`${partner} likes: ${pick(partnerVotes, 'like').join('; ') || '—'}`);
      lines.push(`${partner} passed on: ${pick(partnerVotes, 'dislike').slice(-40).join('; ') || '—'}`);
    }
    if (explain && explain.length) {
      lines.push('Learned tendencies (from ' + me + "'s swipes): " + explain.map(r => (r.w > 0 ? '+ ' : '− ') + r.label).join(', '));
    }
    return lines.join('\n');
  }

  async function call(apiKey, body, signal) {
    const r = await fetch(URL, {
      method: 'POST', signal,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      let msg = 'Claude API ' + r.status;
      try { const j = await r.json(); msg = (j.error && j.error.message) || msg; } catch (e) {}
      throw new Error(msg);
    }
    const j = await r.json();
    if (j.stop_reason === 'refusal') throw new Error('Claude declined this request.');
    return (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  }

  function extractJSON(text) {
    const a = text.indexOf('['), b = text.lastIndexOf(']');
    if (a < 0 || b < a) throw new Error('No JSON array in reply');
    return JSON.parse(text.slice(a, b + 1));
  }

  /* ctx: { apiKey, names, votes, partnerVotes, me, partner, explain, count, direction } */
  async function generate(ctx, signal) {
    const existing = ctx.names.map(n => n.name).sort().join(', ');
    const count = ctx.count || 20;
    const user = `${CRITERIA}

WHAT THE PARENTS HAVE TOLD US SO FAR (their swipes, with the reasons they tapped):
${buildProfile(ctx)}
${ctx.direction ? '\nSPECIAL REQUEST FROM THE PARENTS: ' + ctx.direction + '\n' : ''}
Suggest ${count} NEW boy names that fit all five criteria and lean into what they love (sound, endings, syllable count, meanings), steering away from what they passed on. Be creative: look in lesser-known Sanskrit vocabulary, Marathi words, ragas, nakshatras, rivers, sages, and honest coinages. Mix a few surprising directions in with the safe bets.
Do NOT suggest any name already in this list (or a spelling variant of one): ${existing}

Reply with ONLY a JSON array of ${count} objects, no prose, no markdown fence. ${SCHEMA}`;
    const text = await call(ctx.apiKey, {
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: 'high' },
      system: 'You are a thoughtful Sanskrit- and Marathi-literate naming consultant helping two Indian-American parents. You are honest about etymology and never invent meanings.',
      messages: [{ role: 'user', content: user }],
    }, signal);
    const arr = extractJSON(text);
    const have = new Set(ctx.names.map(n => n.id));
    const out = [];
    for (const o of arr) {
      if (!o || typeof o.name !== 'string') continue;
      const id = o.name.toLowerCase().replace(/[^a-z]/g, '');
      if (!id || have.has(id)) continue;
      have.add(id);
      out.push({
        id, name: o.name.trim(), alt: (o.alt || []).slice(0, 4), say: o.say || '', syllables: +o.syllables || 2,
        meaning: o.meaning || '', root: o.root || '', origin: o.origin || 'Sanskrit', category: o.category || 'coined',
        themes: (o.themes || []).map(t => String(t).toLowerCase()).slice(0, 3), sayability: Math.max(10, Math.min(100, (+o.sayability || 7) * 10)),
        say_note: o.say_note || '', tradition: o.tradition || 'coined', region: o.region || 'pan-Indian', collisions: o.collisions || '',
        nicknames: (o.nicknames || []).slice(0, 4), confidence: o.confidence || 'medium', note: o.note || '',
        us: null, unique: null, fresh: o.tradition === 'coined' ? 90 : o.tradition === 'rare-traditional' ? 80 : 60,
        generated: Date.now(), by: ctx.me,
      });
    }
    return out;
  }

  async function story(apiKey, n, signal) {
    const user = `Tell two Indian-American parents (Marathi, living in the USA) about the boy's name "${n.name}" (${n.say}), meaning "${n.meaning}", root: ${n.root}. Their surname is Gawande.
Cover, in short plain paragraphs with these bold headings: **Meaning & roots** (be honest about certainty; say if it is a modern coinage), **In India** (where and how it is used, any famous bearers or literary/mythological context), **In America** (how people will say and spell it, likely nicknames, any awkward echoes with English words, how "${n.name} Gawande" flows and the initials), **Verdict** (two sentences: what kind of family this name suits and one honest caveat). Keep the whole thing under 220 words. No preamble.`;
    return call(apiKey, {
      model: MODEL, max_tokens: 2000, output_config: { effort: 'medium' },
      messages: [{ role: 'user', content: user }],
    }, signal);
  }

  window.Claude = { generate, story, MODEL };
})();
