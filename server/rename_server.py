"""Rename server — runs on the Mac mini.

Serves the app, keeps both phones' votes in one JSON store, and does all the Claude work
(generation batches with QA + Devanagari, name lookups, deeper stories) in the background so the
phone never has to stay open. Plain FastAPI, no database: state.json with a lock and atomic writes.

Layout (APP_HOME, default ~/Apps/rename):
  app/        the static web app (index.html, app.js, data/…)
  data/       state.json (+ ssa/exclude copies come from app/data)
  secrets/    anthropic.key
  logs/       written by launchd
  backups/    nightly copies of state.json
"""
import json, os, re, threading, time, math, datetime, urllib.request, shutil, glob
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

HOME = os.environ.get('RENAME_HOME', os.path.expanduser('~/Apps/rename'))
APP_DIR = os.path.join(HOME, 'app')
DATA = os.path.join(HOME, 'data', 'state.json')
KEY_FILE = os.path.join(HOME, 'secrets', 'anthropic.key')
MODEL = 'claude-opus-5'
PEOPLE = {'abodh': 'Abodh', 'amruta': 'Amruta'}
lock = threading.RLock()

app = FastAPI(title='Rename')


# ---------------------------------------------------------------- state
def empty_state():
    return {'votes': {'abodh': {}, 'amruta': {}}, 'faceoffs': {'abodh': [], 'amruta': []}, 'extras': [], 'stories': {}, 'updated': None}

def load_state():
    try:
        with open(DATA) as f:
            return json.load(f)
    except Exception:
        return empty_state()

STATE = load_state()

def save_state():
    with lock:
        STATE['updated'] = datetime.datetime.now().isoformat(timespec='seconds')
        os.makedirs(os.path.dirname(DATA), exist_ok=True)
        tmp = DATA + '.tmp'
        with open(tmp, 'w') as f:
            json.dump(STATE, f, ensure_ascii=False)
        os.replace(tmp, DATA)

def app_json(name):
    with open(os.path.join(APP_DIR, 'data', name)) as f:
        return json.load(f)

def norm(n):
    return re.sub(r'[^a-z]', '', str(n).lower())

def merge_votes(a, b):
    out = dict(a or {})
    for k, v in (b or {}).items():
        if k not in out or (v.get('t') or 0) > (out[k].get('t') or 0):
            out[k] = v
    return out

def merge_faceoffs(a, b):
    seen, out = set(), []
    for f in (a or []) + (b or []):
        key = (f.get('a'), f.get('b'), f.get('t'))
        if key not in seen:
            seen.add(key); out.append(f)
    out.sort(key=lambda f: f.get('t') or 0)
    return out


# ---------------------------------------------------------------- claude
def api_key():
    try:
        return open(KEY_FILE).read().strip()
    except Exception:
        return ''

def claude(body, timeout=600, headers=None):
    key = api_key()
    if not key:
        raise RuntimeError('No Anthropic key on the server (secrets/anthropic.key)')
    req = urllib.request.Request('https://api.anthropic.com/v1/messages', data=json.dumps(body).encode(),
                                 headers={'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            j = json.load(r)
    except urllib.error.HTTPError as e:
        try:
            msg = json.load(e).get('error', {}).get('message', '')
        except Exception:
            msg = ''
        raise RuntimeError(f'Claude API {e.code} {msg}'.strip())
    if j.get('stop_reason') == 'refusal':
        raise RuntimeError('Claude declined this request')
    text = ''.join(b.get('text', '') for b in j.get('content', []) if b.get('type') == 'text')
    if j.get('stop_reason') == 'max_tokens':
        raise RuntimeError(f'Claude ran out of room (max_tokens) after {len(text)} chars')
    return text, j.get('stop_reason')

def claude_json(body, timeout=600, tries=2, headers=None):
    """Structured-output call; a malformed/cut-off body is retried once instead of failing the batch."""
    last = None
    for _ in range(tries):
        text, stop = claude(body, timeout, headers)
        try:
            return json.loads(text)
        except ValueError as e:
            last = RuntimeError(f'Bad JSON from Claude ({stop}, {len(text)} chars): {e}')
    raise last

CRITERIA = """The child is a BOY born in 2025 in the USA to Marathi (Maharashtrian) Indian immigrant parents (born 1985 and 1991). He will grow up in the USA. Surname: Gawande. His current first name is Aarush; the parents are choosing a new first name.
Hard criteria for every suggestion:
1. Indian origin — Sanskrit, Marathi, Prakrit/Pali, Hindi usage. Never South-Indian-specific (no Tamil/Telugu/Kannada/Malayalam-specific names or forms).
2. Easy for non-Indian Americans to pronounce correctly from the spelling: prefer 2–3 syllables; avoid aspirated clusters (bh/dh/gh/chh/jh), retroflex-dependent sounds, and "th" that Americans read as English "th"; avoid names that read as an English word or invite a bad nickname.
3. Unique — not currently popular among Indian-American babies; avoid the trendy -aan/-aansh endings.
4. Not an older-generation name common for Indian men born 1950–1995.
5. Real, meaningful. A coined name must be built from genuine Sanskrit/Marathi parts with a defensible meaning and must be labelled tradition "coined". Never invent a meaning. Boys' names only."""

NAME_SCHEMA = {
    'type': 'object', 'additionalProperties': False, 'required': ['names'],
    'properties': {'names': {'type': 'array', 'items': {
        'type': 'object', 'additionalProperties': False,
        'required': ['name', 'dev', 'alt', 'say', 'syllables', 'meaning', 'root', 'origin', 'category', 'themes', 'sayability', 'say_note', 'tradition', 'region', 'collisions', 'nicknames', 'confidence', 'note'],
        'properties': {
            'name': {'type': 'string', 'description': 'Standard Latin spelling, capitalised'},
            'dev': {'type': 'string', 'description': 'The name in Devanagari as written in Marathi, e.g. अन्वय'},
            'alt': {'type': 'array', 'items': {'type': 'string'}},
            'say': {'type': 'string', 'description': 'US-friendly respelling, stressed syllable in CAPS, e.g. UN-vay'},
            'syllables': {'type': 'integer'},
            'meaning': {'type': 'string'}, 'root': {'type': 'string'},
            'origin': {'type': 'string', 'enum': ['Sanskrit', 'Marathi', 'Prakrit', 'Pali', 'Hindi', 'Coined']},
            'category': {'type': 'string', 'enum': ['nature', 'virtue', 'epic', 'marathi', 'sky', 'music', 'knowledge', 'light', 'sound', 'art', 'spirit', 'short', 'coined']},
            'themes': {'type': 'array', 'items': {'type': 'string'}},
            'sayability': {'type': 'integer', 'description': '1-10; 10 = any American says it right first time'},
            'say_note': {'type': 'string'},
            'tradition': {'type': 'string', 'enum': ['traditional', 'rare-traditional', 'coined']},
            'region': {'type': 'string', 'enum': ['pan-Indian', 'north-west', 'marathi']},
            'collisions': {'type': 'string'}, 'nicknames': {'type': 'array', 'items': {'type': 'string'}},
            'confidence': {'type': 'string', 'enum': ['high', 'medium']}, 'note': {'type': 'string'},
        }}}},
}
QA_SCHEMA = {
    'type': 'object', 'additionalProperties': False, 'required': ['verdicts'],
    'properties': {'verdicts': {'type': 'array', 'items': {
        'type': 'object', 'additionalProperties': False,
        'required': ['name', 'gender', 'south_specific', 'trending', 'old_generation', 'meaning_ok', 'note'],
        'properties': {'name': {'type': 'string'}, 'gender': {'type': 'string', 'enum': ['boy', 'unisex', 'girl']},
                       'south_specific': {'type': 'boolean'}, 'trending': {'type': 'boolean'}, 'old_generation': {'type': 'boolean'},
                       'meaning_ok': {'type': 'boolean'}, 'note': {'type': 'string'}}}}},
}

def all_names():
    pool = app_json('names.json')['names']
    return pool + STATE['extras']

def name_line(n, v):
    tags = f" ({', '.join(v['tags'])})" if v.get('tags') else ''
    note = f' — note: "{v["note"]}"' if v.get('note') else ''
    return f"{n['name']} [{n.get('meaning', '')}]{tags}{note}"

def profile(me):
    partner = 'amruta' if me == 'abodh' else 'abodh'
    by = {n['id']: n for n in all_names()}
    def pick(who, kind, limit=None):
        vs = STATE['votes'].get(who, {})
        rows = [name_line(by[i], v) for i, v in vs.items() if v.get('v') == kind and i in by]
        return '; '.join(rows[-limit:] if limit else rows) or '—'
    lines = [f"{PEOPLE[me]} LOVES: {pick(me, 'love')}", f"{PEOPLE[me]} likes: {pick(me, 'like')}", f"{PEOPLE[me]} passed on: {pick(me, 'dislike', 60)}",
             f"{PEOPLE[partner]} LOVES: {pick(partner, 'love')}", f"{PEOPLE[partner]} likes: {pick(partner, 'like')}", f"{PEOPLE[partner]} passed on: {pick(partner, 'dislike', 40)}"]
    return '\n'.join(lines)

def score_extra(n, ssa):
    c24 = int(ssa.get(n['id'], 0))
    n['us'] = {'c24': c24, 'c10': None, 'rank24': None, 'trend': 'flat'}
    n['unique'] = 100 if c24 == 0 else max(5, round(100 - 22 * math.log2(1 + c24 / 4)))

def to_extra(o, me):
    nid = norm(o['name'])
    trad = o.get('tradition', 'traditional')
    return {
        'id': nid, 'name': o['name'].strip(), 'dev': o.get('dev', ''), 'alt': (o.get('alt') or [])[:4], 'say': o.get('say', ''), 'syllables': int(o.get('syllables') or 2),
        'meaning': o.get('meaning', ''), 'root': o.get('root', ''), 'origin': o.get('origin', 'Sanskrit'), 'category': o.get('category', 'coined'),
        'themes': [str(t).lower() for t in (o.get('themes') or [])][:3], 'sayability': max(10, min(100, int(o.get('sayability') or 7) * 10)),
        'say_note': o.get('say_note', ''), 'tradition': trad, 'region': o.get('region', 'pan-Indian'), 'collisions': o.get('collisions', ''),
        'nicknames': (o.get('nicknames') or [])[:4], 'confidence': o.get('confidence', 'medium'), 'note': o.get('note', ''),
        'us': None, 'unique': None, 'fresh': {'coined': 90, 'rare-traditional': 80}.get(trad, 60), 'generated': int(time.time() * 1000), 'by': PEOPLE.get(me, me),
    }

DEEP_MODEL = 'claude-fable-5-1'   # thinks for a long time, but in tests returned 25/25 new, richer names

def _gen_call(user, deep=False):
    system = 'You are a thoughtful Sanskrit- and Marathi-literate naming consultant helping two Indian-American parents. You are honest about etymology and never invent meanings.'
    if deep:
        # Fable cannot switch thinking off and needs a big budget (~50k thinking tokens per batch).
        body = {'model': DEEP_MODEL, 'max_tokens': 64000, 'fallbacks': 'default', 'output_config': {'effort': 'low', 'format': {'type': 'json_schema', 'schema': NAME_SCHEMA}},
                'system': system, 'messages': [{'role': 'user', 'content': user}]}
        return claude_json(body, timeout=1700, headers={'anthropic-beta': 'server-side-fallback-2026-07-01'})['names']
    return claude_json({'model': MODEL, 'max_tokens': 20000, 'thinking': {'type': 'disabled'}, 'output_config': {'effort': 'low', 'format': {'type': 'json_schema', 'schema': NAME_SCHEMA}},
                        'system': system, 'messages': [{'role': 'user', 'content': user}]})['names']

def generate_batch(me, direction, count, angle, deep=False):
    """Ask for `count` names; anything already taken is sent back for replacement (twice), so the
    batch delivers new names instead of quietly shrinking."""
    names = all_names()
    exclude = set(app_json('exclude.json'))
    existing = ', '.join(sorted(n['name'] for n in names))
    base = f"""{CRITERIA}

WHAT THE PARENTS HAVE TOLD US SO FAR (their swipes, with the reasons they tapped):
{profile(me)}
{('SPECIAL REQUEST FROM THE PARENTS: ' + direction) if direction else ''}
Lean this batch toward {angle}.
Suggest {count} NEW boy names that fit all five criteria and lean into what they love (sound, endings, syllable count, meanings), steering away from what they passed on. Be creative: lesser-known Sanskrit vocabulary, Marathi words, ragas, nakshatras, rivers, sages, honest coinages.
Do NOT suggest any name already in this list (or a spelling variant of one): {existing}
Also NEVER suggest any of these (too common, older-generation, South-Indian-specific, or already rejected): {', '.join(sorted(exclude))}
Return exactly {count} names. Be honest about confidence; a coinage must say how it was built in "note"."""
    have = {n['id'] for n in names} | exclude
    out, taken = [], []
    arr = _gen_call(base, deep)
    for round_ in range(3):
        for o in arr:
            if not isinstance(o, dict) or not o.get('name'):
                continue
            nid = norm(o['name'])
            if not nid or nid in have or any(norm(a) in have for a in (o.get('alt') or [])):
                taken.append(o['name']); continue
            have.add(nid)
            out.append(to_extra(o, me))
        missing = count - len(out)
        if missing <= 0 or round_ == 2 or not taken:
            break
        # Send the rejects back and ask for different ones.
        arr = _gen_call(base + f"""

Your previous answer included these names, which are ALREADY TAKEN and must not appear again: {', '.join(taken)}.
Now give {missing} DIFFERENT names (not those, not anything in the lists above). Return exactly {missing} names.""", deep)
        taken = []
    return out

def qa_batch(cands):
    """Second opinion on a batch of generated names; returns the ones that pass."""
    if not cands:
        return []
    lines = '\n'.join(f"{n['name']} — {n['meaning']} ({n['root']})" for n in cands)
    verdict_doc = claude_json({'model': MODEL, 'max_tokens': 12000, 'thinking': {'type': 'disabled'}, 'output_config': {'effort': 'low', 'format': {'type': 'json_schema', 'schema': QA_SCHEMA}},
                      'messages': [{'role': 'user', 'content': f"""You are checking candidate first names for a BOY born 2025 in the USA to Marathi parents. For EACH name give a strict, honest verdict:
- gender: 'girl' if used for girls in India, 'unisex' if commonly both, else 'boy'.
- south_specific: true only if usage is clearly Tamil/Telugu/Kannada/Malayalam-specific.
- trending: true if currently popular among Indian-American or urban-Indian boys born 2015-2025.
- old_generation: true if it was a common name for Indian men born 1950-1995.
- meaning_ok: false if the stated meaning or root is wrong or invented.
One verdict per name, same order, {len(cands)} verdicts.

{lines}"""}]})
    verdicts = {norm(v['name']): v for v in verdict_doc['verdicts']}
    keep = []
    for n in cands:
        v = verdicts.get(n['id'])
        if v and (v['gender'] == 'girl' or v['south_specific'] or v['trending'] or v['old_generation'] or not v['meaning_ok']):
            continue
        if v and v['gender'] == 'unisex':
            n['note'] = (n['note'] + ' · ' if n['note'] else '') + 'used for girls too'
        keep.append(n)
    return keep


# ---------------------------------------------------------------- generation job (one at a time, in a thread)
JOB = {'status': 'idle', 'text': '', 'added': 0, 'started': None, 'finished': None, 'error': ''}
ANGLES = ['short, crisp 2-syllable names with clean sounds', 'nature, sky, light and music words',
          'Marathi-heritage words and lesser-known epic/sage names', 'fresh coinages and rare Sanskrit vocabulary',
          'virtues, wisdom and knowledge words with soft endings', 'rivers, mountains, seasons and weather',
          'Vedic and Buddhist/Jain vocabulary for peace, awareness and light', 'art, dance, poetry and sound words']

def run_job(me, direction, count, deep=False):
    """Angled batches, two at a time, until `count` NEW names have actually been added (or the
    angles run out twice). Each batch is generated, quality-checked, scored and saved as it finishes."""
    from concurrent.futures import ThreadPoolExecutor
    ssa = app_json('ssa.json')
    per = 25
    progress = {'added': 0, 'failed': 0, 'done': 0, 'target': count}
    JOB['target'] = count

    def one(i):
        if progress['added'] >= count:
            return
        angle = ANGLES[i % len(ANGLES)]
        out = None
        for attempt in range(2):
            try:
                out = generate_batch(me, direction, per, angle, deep); break
            except Exception as e:
                JOB['error'] = str(e)
                if re.search(r'429|rate|overloaded|529', str(e), re.I):
                    JOB['text'] = 'Rate limit — waiting a minute…'; time.sleep(65)
        if out is None:
            progress['failed'] += 1; progress['done'] += 1; return
        try:
            out = qa_batch(out)
        except Exception as e:
            JOB['error'] = 'QA skipped: ' + str(e)
        with lock:
            have = {n['id'] for n in all_names()}
            fresh = [n for n in out if n['id'] not in have]
            for n in fresh:
                score_extra(n, ssa)
            STATE['extras'].extend(fresh)
            progress['added'] += len(fresh); progress['done'] += 1
            JOB['added'] = progress['added']
            JOB['text'] = f"{progress['added']} new so far · target {count}"
        save_state()

    try:
        JOB['text'] = ('Deep search (Fable) — ' if deep else 'Working… ') + f'target {count} new names'
        max_batches = len(ANGLES) * 2
        i = 0
        while progress['added'] < count and i < max_batches:
            with ThreadPoolExecutor(max_workers=2) as ex:
                list(ex.map(one, [i, i + 1]))
            i += 2
        JOB['status'] = 'done'
        JOB['text'] = f"Added {progress['added']} new names" + (f" · {progress['failed']} batch(es) failed" if progress['failed'] else '')
    except Exception as e:
        JOB['status'] = 'failed'; JOB['error'] = str(e); JOB['text'] = 'Failed: ' + str(e)
    JOB['finished'] = datetime.datetime.now().isoformat(timespec='seconds')


# ---------------------------------------------------------------- API
@app.get('/api/health')
def health():
    return {'ok': True, 'app': 'rename', 'key': bool(api_key()), 'updated': STATE.get('updated'), 'job': JOB['status']}

@app.get('/api/state')
def get_state(me: str = 'abodh'):
    partner = 'amruta' if me == 'abodh' else 'abodh'
    with lock:
        return {'me': me, 'votes': STATE['votes'].get(me, {}), 'faceoffs': STATE['faceoffs'].get(me, []),
                'partnerVotes': STATE['votes'].get(partner, {}), 'partnerFaceoffs': STATE['faceoffs'].get(partner, []),
                'extras': STATE['extras'], 'stories': STATE['stories'], 'job': JOB, 'updated': STATE.get('updated')}

@app.post('/api/votes')
async def post_votes(req: Request):
    b = await req.json()
    me = b.get('me')
    if me not in PEOPLE:
        raise HTTPException(400, 'who?')
    with lock:
        STATE['votes'][me] = merge_votes(STATE['votes'].get(me, {}), b.get('votes') or {})
        STATE['faceoffs'][me] = merge_faceoffs(STATE['faceoffs'].get(me, []), b.get('faceoffs') or [])
        if b.get('reset'):   # explicit "clear my votes" from that phone
            STATE['votes'][me] = {}; STATE['faceoffs'][me] = []
    save_state()
    return get_state(me)

@app.post('/api/extras')
async def post_extras(req: Request):
    b = await req.json()
    ssa = app_json('ssa.json')
    with lock:
        have = {n['id']: n for n in STATE['extras']}
        pool = {n['id'] for n in app_json('names.json')['names']}
        for n in b.get('names') or []:
            nid = norm(n.get('id') or n.get('name', ''))
            if not nid or nid in pool:
                continue
            if n.get('unique') is None:
                n['id'] = nid; score_extra(n, ssa)
            if nid not in have:
                STATE['extras'].append(n); have[nid] = n
    save_state()
    return {'extras': STATE['extras']}

@app.post('/api/stories')
async def post_story(req: Request):
    b = await req.json()
    nid = norm(b.get('id', ''))
    if b.get('text'):
        with lock:
            STATE['stories'][nid] = b['text']
        save_state()
        return {'text': b['text']}
    n = b.get('name') or {}
    user = f"""Tell two Indian-American parents (Marathi, living in the USA) about the boy's name "{n.get('name')}" ({n.get('say')}), meaning "{n.get('meaning')}", root: {n.get('root')}. Their surname is Gawande.
Cover, in short plain paragraphs with these bold headings: **Meaning & roots** (be honest about certainty; say if it is a modern coinage), **In India** (where and how it is used, any famous bearers or literary/mythological context), **In America** (how people will say and spell it, likely nicknames, any awkward echoes with English words, how "{n.get('name')} Gawande" flows and the initials), **Verdict** (two sentences: what kind of family this name suits and one honest caveat). Keep the whole thing under 220 words. No preamble."""
    try:
        text, _ = claude({'model': MODEL, 'max_tokens': 3000, 'output_config': {'effort': 'low'}, 'messages': [{'role': 'user', 'content': user}]}, timeout=180)
    except Exception as e:
        raise HTTPException(502, str(e))
    with lock:
        STATE['stories'][nid] = text
    save_state()
    return {'text': text}

@app.post('/api/lookup')
async def lookup(req: Request):
    b = await req.json()
    name = (b.get('name') or '').strip()
    if not name:
        raise HTTPException(400, 'name?')
    one = {'type': 'object', 'additionalProperties': False, 'required': ['names'], 'properties': {'names': NAME_SCHEMA['properties']['names']}}
    try:
        text, _ = claude({'model': MODEL, 'max_tokens': 3000, 'output_config': {'effort': 'low', 'format': {'type': 'json_schema', 'schema': one}},
                          'messages': [{'role': 'user', 'content': f'{CRITERIA}\n\nThe parents found the boy\'s name "{name}" themselves. Fill in its details honestly (exactly one entry). If the meaning is uncertain say so in note and set confidence "medium". If it breaks one of the criteria (too common, older generation, South-Indian-specific, girl\'s name), say which in "collisions" — do not refuse.'}]}, timeout=180)
        o = json.loads(text)['names'][0]
    except Exception as e:
        raise HTTPException(502, str(e))
    return o

@app.post('/api/generate')
async def generate(req: Request):
    b = await req.json()
    if JOB['status'] == 'running':
        return JOB
    JOB.update({'status': 'running', 'text': 'Starting…', 'added': 0, 'started': datetime.datetime.now().isoformat(timespec='seconds'), 'finished': None, 'error': '', 'deep': bool(b.get('deep'))})
    t = threading.Thread(target=run_job, args=(b.get('me', 'abodh'), (b.get('direction') or '').strip(), int(b.get('count') or 100), bool(b.get('deep'))), daemon=True)
    t.start()
    return JOB

@app.get('/api/job')
def job():
    return JOB

@app.post('/api/job/dismiss')
def dismiss():
    if JOB['status'] != 'running':
        JOB.update({'status': 'idle', 'text': '', 'added': 0, 'error': ''})
    return JOB


# ---------------------------------------------------------------- backups (called by launchd daily) + static app
@app.post('/api/backup')
def backup():
    os.makedirs(os.path.join(HOME, 'backups'), exist_ok=True)
    dst = os.path.join(HOME, 'backups', datetime.datetime.now().strftime('state-%Y-%m-%d.json'))
    shutil.copy(DATA, dst)
    old = sorted(glob.glob(os.path.join(HOME, 'backups', 'state-*.json')))[:-60]
    for f in old:
        os.remove(f)
    return {'saved': dst}

class NoCacheStatic(StaticFiles):
    async def get_response(self, path, scope):
        r = await super().get_response(path, scope)
        if path.endswith(('.html', '.js', '.css', '.json', '.webmanifest')) or path in ('', '.'):
            r.headers['Cache-Control'] = 'no-cache'
        return r

app.mount('/', NoCacheStatic(directory=APP_DIR, html=True), name='app')
