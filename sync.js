/* Rename — two-phone sync through a private GitHub repo (AbodhGawande/rename-data).
   Each person owns one file (votes-abodh.json / votes-amruta.json), so writes never conflict
   between the two of you. Shared files (extra-names.json, stories.json) are read-merge-written. */
(function () {
  'use strict';

  const API = 'https://api.github.com';
  const OWNER = 'AbodhGawande';
  const REPO = 'rename-data';

  function headers(token) {
    return {
      'Authorization': 'Bearer ' + token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    };
  }
  function b64decode(s) {
    const bin = atob(s.replace(/\n/g, ''));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    bytes.forEach(b => { bin += String.fromCharCode(b); });
    return btoa(bin);
  }

  async function getFile(token, path) {
    const r = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${path}?t=${Date.now()}`, { headers: headers(token), cache: 'no-store' });
    if (r.status === 404) return { json: null, sha: null };
    if (!r.ok) throw new Error(`GitHub ${r.status} reading ${path}`);
    const j = await r.json();
    let json = null;
    try { json = JSON.parse(b64decode(j.content)); } catch (e) { json = null; }
    return { json, sha: j.sha };
  }

  async function putFile(token, path, obj, sha, message) {
    const body = { message, content: b64encode(JSON.stringify(obj, null, 1)) };
    if (sha) body.sha = sha;
    const r = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${path}`, { method: 'PUT', headers: headers(token), body: JSON.stringify(body) });
    if (r.status === 409 || r.status === 422) throw Object.assign(new Error('conflict'), { conflict: true });
    if (!r.ok) throw new Error(`GitHub ${r.status} writing ${path}`);
    return (await r.json()).content.sha;
  }

  async function putWithRetry(token, path, mergeFn, message) {
    for (let i = 0; i < 3; i++) {
      const cur = await getFile(token, path);
      const next = mergeFn(cur.json);
      if (next === null) return cur.json; // nothing to write
      try { await putFile(token, path, next, cur.sha, message); return next; }
      catch (e) { if (!e.conflict || i === 2) throw e; }
    }
  }

  async function check(token) {
    const r = await fetch(`${API}/repos/${OWNER}/${REPO}`, { headers: headers(token), cache: 'no-store' });
    if (r.status === 401) throw new Error('Token rejected (401). Paste it again?');
    if (r.status === 404) throw new Error('Token has no access to rename-data (404). Give it Contents: read & write on that repo.');
    if (!r.ok) throw new Error('GitHub ' + r.status);
    const j = await r.json();
    if (!j.permissions || !j.permissions.push) throw new Error('Token can read but not write — needs Contents: Read and write.');
    return true;
  }

  // Merge two vote maps: newest timestamp wins per name.
  function mergeVotes(a, b) {
    const out = Object.assign({}, a || {});
    Object.keys(b || {}).forEach(id => {
      if (!out[id] || (b[id].t || 0) > (out[id].t || 0)) out[id] = b[id];
    });
    return out;
  }
  function mergeById(a, b) {
    const m = Object.create(null);
    (a || []).forEach(x => { m[x.id] = x; });
    (b || []).forEach(x => { if (!m[x.id]) m[x.id] = x; });
    return Object.values(m);
  }

  /* state: { me, partner, votes, faceoffs, extras, stories }
     returns: { partnerVotes, partnerFaceoffs, extras, stories, secrets } */
  async function syncAll(token, state, onStep) {
    const step = s => { try { onStep && onStep(s); } catch (e) {} };
    const out = {};
    step('Sending your votes…');
    const mine = await putWithRetry(token, `votes-${state.me}.json`, remote => {
      const merged = { votes: mergeVotes(remote && remote.votes, state.votes), faceoffs: mergeFaceoffs(remote && remote.faceoffs, state.faceoffs), updated: new Date().toISOString(), who: state.me };
      // skip the write when nothing changed
      if (remote && JSON.stringify(remote.votes) === JSON.stringify(merged.votes) && JSON.stringify(remote.faceoffs) === JSON.stringify(merged.faceoffs)) return null;
      return merged;
    }, `${state.me}: votes`);
    out.votes = mine ? mine.votes : state.votes;
    out.faceoffs = mine ? mine.faceoffs : state.faceoffs;

    step(`Fetching ${state.partner}'s votes…`);
    const p = await getFile(token, `votes-${state.partner}.json`);
    out.partnerVotes = (p.json && p.json.votes) || {};
    out.partnerFaceoffs = (p.json && p.json.faceoffs) || [];

    step('Sharing new names…');
    const ex = await putWithRetry(token, 'extra-names.json', remote => {
      const merged = mergeById(remote && remote.names, state.extras);
      if (remote && merged.length === (remote.names || []).length) return null;
      return { names: merged, updated: new Date().toISOString() };
    }, `${state.me}: extra names`);
    out.extras = ex ? ex.names : state.extras;

    const st = await putWithRetry(token, 'stories.json', remote => {
      const merged = Object.assign({}, (remote && remote.stories) || {}, state.stories || {});
      if (remote && Object.keys(merged).length === Object.keys(remote.stories || {}).length) return null;
      return { stories: merged };
    }, `${state.me}: stories`);
    out.stories = st ? st.stories : (state.stories || {});

    const sec = await getFile(token, 'secrets.json');
    out.secrets = sec.json || {};
    return out;
  }

  function mergeFaceoffs(a, b) {
    const seen = new Set();
    const out = [];
    [...(a || []), ...(b || [])].forEach(f => {
      const k = f.a + '|' + f.b + '|' + f.t;
      if (!seen.has(k)) { seen.add(k); out.push(f); }
    });
    out.sort((x, y) => (x.t || 0) - (y.t || 0));
    return out;
  }

  window.Sync = { check, syncAll, getFile, putFile, OWNER, REPO };
})();
