/* Rename — talks to the Rename server on the Mac mini (same origin as the app). */
(function () {
  'use strict';
  const BASE = (document.querySelector('base') && document.querySelector('base').href) ? new URL(document.querySelector('base').href).pathname.replace(/\/$/, '') : location.pathname.replace(/\/[^/]*$/, '');
  const url = p => BASE + '/api/' + p;

  async function call(path, body, opts) {
    const r = await fetch(url(path), Object.assign({
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    }, opts || {}));
    if (!r.ok) {
      let msg = 'Server ' + r.status;
      try { const j = await r.json(); msg = j.detail || msg; } catch (e) {}
      throw new Error(msg);
    }
    return r.json();
  }

  window.API = {
    health: () => call('health'),
    state: me => call('state?me=' + encodeURIComponent(me)),
    pushVotes: (me, votes, faceoffs, reset) => call('votes', { me, votes, faceoffs, reset: !!reset }),
    addExtras: names => call('extras', { names }),
    story: (id, name) => call('stories', { id, name }),
    lookup: name => call('lookup', { name }),
    generate: (me, direction, count) => call('generate', { me, direction, count }),
    job: () => call('job'),
    dismissJob: () => call('job/dismiss', {}),
    BASE,
  };
})();
