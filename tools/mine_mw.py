#!/usr/bin/env python3
"""Mine the Monier-Williams Sanskrit dictionary for boy-name candidates that Claude's memory
would never surface — mechanically filtered by sound, then judged by Claude, then quality-checked.

Stages (run in order; each writes a file next to mw.txt so it can be resumed):
  parse  : mw.txt → candidates.json     (headword, spelling, syllables, gloss, score)     no API
  judge  : candidates → judged.json     (Claude decides usability + fills the name card)   API
  qa     : judged → passed.json         (second-opinion pass, same as the app's QA)        API
  post   : passed → POST /api/extras on the mini                                            no API

Usage: python3 tools/mine_mw.py <stage> [--limit N]
Needs: scratch dir with mw.txt (MW_DIR env, default ./mw), data/names.json + exclude.json + ssa.json,
.secrets/anthropic.key. Talks to the mini at RENAME_URL (default http://m2-mac-mini.local/rename).
"""
import json, os, re, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
MW_DIR = os.environ.get('MW_DIR', os.path.join(ROOT, 'mw'))
MINI = os.environ.get('RENAME_URL', 'http://m2-mac-mini.local/rename')
KEY = open(os.path.join(ROOT, '.secrets', 'anthropic.key')).read().strip()
stage = sys.argv[1] if len(sys.argv) > 1 else 'parse'
LIMIT = int(sys.argv[sys.argv.index('--limit') + 1]) if '--limit' in sys.argv else None

def norm(n): return re.sub(r'[^a-z]', '', n.lower())

# ---------------------------------------------------------------- SLP1 → plain Latin name spelling
VOWELS = set('aAiIuUfFxXeEoO')
ASPIRATE = set('KGCJWQTDPB')     # kh gh chh jh ṭh ḍh th dh ph bh — hard for Americans
RETRO = set('wWqQ')              # ṭ ṭh ḍ ḍh
LATIN = {'a': 'a', 'A': 'a', 'i': 'i', 'I': 'i', 'u': 'u', 'U': 'u', 'f': 'ri', 'F': 'ri', 'e': 'e', 'E': 'ai', 'o': 'o', 'O': 'au',
         'k': 'k', 'g': 'g', 'N': 'n', 'c': 'ch', 'j': 'j', 'Y': 'n', 'R': 'n', 't': 't', 'd': 'd', 'n': 'n', 'p': 'p', 'b': 'b', 'm': 'm',
         'y': 'y', 'r': 'r', 'l': 'l', 'v': 'v', 'S': 'sh', 'z': 'sh', 's': 's', 'h': 'h', 'M': 'm', 'H': ''}

def to_latin(slp):
    out = []
    for ch in slp:
        if ch in ASPIRATE or ch in RETRO or ch in 'xX' or ch not in LATIN:
            return None
        out.append(LATIN[ch])
    return ''.join(out)

def syllables(slp): return sum(1 for ch in slp if ch in VOWELS)

NEG = re.compile(r'\b(kill|death|dead|demon|disease|enemy|poison|sin\b|hell|evil|pain|fear|ugly|cruel|wound|blood|corpse|curse|ill\b|sick|thief|vomit|excrement|urine|dung|filth|snake|serpent|weapon|arrow|sword|slaughter|war\b|battle|hate|anger|wrath|grief|sorrow|misery|dirt|hunger|greed|lust|adultery|prostitute|hostile|violent|defect|deformed|dwarf|bald|blind|deaf|dumb|lame|fever|leprosy|mad\b|insane|drunk|liquor|gambl|cheat|fraud|beggar|slave|low\b|outcast|barbarian|foolish|stupid|idiot|wicked|vile|harsh|rough|bitter|sour|rotten|stink|smell|fart|penis|vulva|testicle|anus|womb|menstru|obscene|rape|widow|barren|eunuch|castrat|thorn|jackal|crow\b|owl\b|ass\b|donkey|pig\b|hog\b|rat\b|mouse|worm|insect|fly\b|louse|bug\b|mosquito|leech|frog|lizard|scorpion)\b', re.I)
POS = re.compile(r'\b(light|sun|moon|star|sky|dawn|ray|bright|shining|radiant|brilliant|splendo|lustre|glow|flame|fire|gold|jewel|gem|pearl|lotus|flower|blossom|tree|forest|river|ocean|sea|wave|cloud|rain|wind|breeze|mountain|peak|earth|spring|joy|delight|happy|bliss|calm|peace|serene|gentle|kind|noble|brave|hero|valiant|strong|mighty|firm|steady|wise|wisdom|knowledge|learned|clever|skilful|pure|clean|true|truth|honest|faithful|friend|beloved|dear|charming|handsome|beautiful|lovely|fragrant|sweet|melod|song|music|sound|voice|tone|note|poem|poet|verse|art|dance|leader|chief|king|prince|lord|excellent|best|foremost|supreme|victor|success|prosper|wealth|fortune|lucky|auspicious|blessed|sacred|holy|divine|immortal|eternal|free|liberat|swift|quick|young|new|fresh|first|honour|glory|fame|praise|worthy|generous|bounti|giver|protector|guardian|guide|path|way\b|journey|traveller|scholar|sage|seer|teacher|student|singer|player|craftsman|builder|maker|creator)\b', re.I)

def parse():
    pool = json.load(open(os.path.join(ROOT, 'data', 'names.json')))['names']
    exclude = set(json.load(open(os.path.join(ROOT, 'data', 'exclude.json'))))
    ssa = json.load(open(os.path.join(ROOT, 'data', 'ssa.json')))
    taken = {n['id'] for n in pool} | exclude
    try:
        st = json.load(urllib.request.urlopen(MINI + '/api/state?me=abodh', timeout=10))
        taken |= {n['id'] for n in st['extras']}
    except Exception as e:
        print('warning: could not read mini extras:', e)
    cands, seen = [], set()
    with open(os.path.join(MW_DIR, 'mw.txt'), encoding='utf-8') as f:
        entry = None
        for line in f:
            if line.startswith('<L>'):
                m = re.search(r'<k1>([^<]+)<k2>', line)
                entry = {'k1': m.group(1) if m else None, 'body': ''}
            elif line.startswith('<LEND>'):
                if entry and entry['k1']:
                    consider(entry, cands, seen, taken, ssa)
                entry = None
            elif entry is not None:
                entry['body'] += line
    cands.sort(key=lambda c: -c['score'])
    json.dump(cands, open(os.path.join(MW_DIR, 'candidates.json'), 'w'), ensure_ascii=False, indent=0)
    print(f'{len(cands)} candidates → candidates.json; top 40:', ', '.join(c['name'] for c in cands[:40]))

def consider(entry, cands, seen, taken, ssa):
    k1 = entry['k1']
    if not re.fullmatch(r'[a-zA-Z]+', k1) or not (2 <= syllables(k1) <= 3):
        return
    lex = re.findall(r'<lex>([^<]+)</lex>', entry['body'])
    lexs = ' '.join(lex)
    if not lex or re.search(r'\bf\.|ind\.|f\)', lexs) and 'm.' not in lexs and 'mfn.' not in lexs:
        return
    if not re.search(r'\bm\.|mfn\.|\bn\.', lexs):
        return
    latin = to_latin(k1)
    if not latin or not (4 <= len(latin) <= 8) or latin[-1] in 'h' or 'ii' in latin or 'uu' in latin:
        return
    if latin[0] == 'ri' or latin.endswith(('ii', 'aa')):
        return
    nid = norm(latin)
    if nid in taken or nid in seen or int(ssa.get(nid, 0)) >= 80:
        return
    gloss = re.sub(r'<[^>]+>', '', entry['body'].split('¦', 1)[-1]).strip()
    gloss = re.sub(r'\s+', ' ', gloss)[:220]
    if not gloss or NEG.search(gloss) or re.search(r'\b(name of a|N\. of a)\b.*(demon|Rākṣasa|Asura|Dānava|serpent|Nāga)', gloss):
        return
    if re.match(r'^\(', gloss) or len(gloss) < 12:
        return
    score = len(POS.findall(gloss)) * 3 + (2 if 'mfn.' in lexs or ' m.' in ' ' + lexs else 0) + (1 if len(latin) <= 6 else 0) + (1 if syllables(k1) == 2 else 0)
    if re.search(r'\bname of\b|\bN\. of\b', gloss, re.I):
        score += 1   # named things (rivers, sages, plants) are good name material
    if score < 3:
        return
    seen.add(nid)
    cands.append({'k1': k1, 'name': latin[0].upper() + latin[1:], 'id': nid, 'syl': syllables(k1), 'lex': lexs[:30], 'gloss': gloss, 'score': score})

# ---------------------------------------------------------------- Claude stages
SCHEMA = {'type': 'object', 'additionalProperties': False, 'required': ['names'], 'properties': {'names': {'type': 'array', 'items': {
    'type': 'object', 'additionalProperties': False,
    'required': ['candidate', 'usable', 'why_not', 'name', 'dev', 'say', 'syllables', 'meaning', 'root', 'origin', 'category', 'themes', 'sayability', 'say_note', 'tradition', 'region', 'collisions', 'nicknames', 'confidence', 'note'],
    'properties': {
        'candidate': {'type': 'string', 'description': 'the candidate spelling exactly as given'},
        'usable': {'type': 'boolean', 'description': 'true only if this would work as a modern boy\'s first name for this family'},
        'why_not': {'type': 'string', 'description': 'short reason when not usable, else empty'},
        'name': {'type': 'string', 'description': 'best Latin spelling for use in the USA (may drop a final -a if that is how such names are used, e.g. Devdar)'},
        'dev': {'type': 'string'}, 'say': {'type': 'string'}, 'syllables': {'type': 'integer'}, 'meaning': {'type': 'string'}, 'root': {'type': 'string'},
        'origin': {'type': 'string', 'enum': ['Sanskrit', 'Marathi', 'Prakrit', 'Pali', 'Hindi', 'Coined']},
        'category': {'type': 'string', 'enum': ['nature', 'virtue', 'epic', 'marathi', 'sky', 'music', 'knowledge', 'light', 'sound', 'art', 'spirit', 'short', 'coined']},
        'themes': {'type': 'array', 'items': {'type': 'string'}}, 'sayability': {'type': 'integer'}, 'say_note': {'type': 'string'},
        'tradition': {'type': 'string', 'enum': ['traditional', 'rare-traditional', 'coined']}, 'region': {'type': 'string', 'enum': ['pan-Indian', 'north-west', 'marathi']},
        'collisions': {'type': 'string'}, 'nicknames': {'type': 'array', 'items': {'type': 'string'}}, 'confidence': {'type': 'string', 'enum': ['high', 'medium']}, 'note': {'type': 'string'},
    }}}}}

def claude(body, timeout=600):
    req = urllib.request.Request('https://api.anthropic.com/v1/messages', data=json.dumps(body).encode(),
                                 headers={'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        j = json.load(r)
    return ''.join(b.get('text', '') for b in j['content'] if b['type'] == 'text')

CRITERIA = open(os.path.join(ROOT, 'server', 'rename_server.py')).read().split('CRITERIA = """')[1].split('"""')[0]

def judge_batch(batch):
    lines = '\n'.join(f"{c['name']} (Sanskrit {c['k1']}; {c['lex']}) — {c['gloss']}" for c in batch)
    text = claude({'model': 'claude-opus-5', 'max_tokens': 20000, 'thinking': {'type': 'disabled'}, 'output_config': {'effort': 'low', 'format': {'type': 'json_schema', 'schema': SCHEMA}},
                   'messages': [{'role': 'user', 'content': f"""{CRITERIA}

Below are Sanskrit dictionary words (Monier-Williams) that passed a mechanical sound filter. They are NOT established names — that is the point: the parents want names nobody else has, built from real vocabulary. For EACH one decide honestly whether it would work as a modern boy's first name for this family, and if usable fill in the name card. Reject anything with an awkward, weak, funny or negative meaning, anything that is really a grammatical form, anything that sounds feminine, anything an American would mangle, or anything too close to a common name. Be selective — roughly a third should pass. Keep "root" as "Sanskrit <word> (<Devanagari>)". tradition = "rare-traditional" (it is a real word) unless it is genuinely used as a name. One entry per candidate, same order, {len(batch)} entries.

{lines}"""}]})
    return json.loads(text)['names']

def judge():
    cands = json.load(open(os.path.join(MW_DIR, 'candidates.json')))
    if LIMIT: cands = cands[:LIMIT]
    out_path = os.path.join(MW_DIR, 'judged.json')
    done = json.load(open(out_path)) if os.path.exists(out_path) else {}
    todo = [c for c in cands if c['id'] not in done]
    print(f'judging {len(todo)} candidates ({len(done)} already)')
    B = 40
    def run(i):
        b = todo[i:i + B]
        for attempt in range(3):
            try: return b, judge_batch(b)
            except Exception as e: print('retry', i, e, flush=True); time.sleep(10)
        return b, []
    with ThreadPoolExecutor(max_workers=3) as ex:
        for b, res in ex.map(run, range(0, len(todo), B)):
            by = {norm(r['candidate']): r for r in res}
            for c in b:
                r = by.get(c['id'])
                if r: done[c['id']] = r
            json.dump(done, open(out_path, 'w'), ensure_ascii=False, indent=0)
            usable = sum(1 for r in res if r['usable'])
            print(f'{len(done)}/{len(cands)} judged · this batch {usable}/{len(res)} usable', flush=True)
    usable = [r for r in done.values() if r['usable']]
    print(f'usable so far: {len(usable)}:', ', '.join(r['name'] for r in usable[:60]))

def qa():
    sys.path.insert(0, os.path.join(ROOT, 'server'))
    os.environ.setdefault('RENAME_HOME', os.path.join(MW_DIR, 'fakehome'))
    import rename_server as R
    R.KEY_FILE = os.path.join(ROOT, '.secrets', 'anthropic.key')
    judged = json.load(open(os.path.join(MW_DIR, 'judged.json')))
    ssa = json.load(open(os.path.join(ROOT, 'data', 'ssa.json')))
    exclude = set(json.load(open(os.path.join(ROOT, 'data', 'exclude.json'))))
    cards = []
    for r in judged.values():
        if not r['usable']: continue
        n = R.to_extra(r, 'dictionary'); n['by'] = 'Monier-Williams'; n['source'] = 'mw'
        if n['id'] in exclude or int(ssa.get(n['id'], 0)) >= 80: continue
        R.score_extra(n, ssa); cards.append(n)
    print('cards to QA:', len(cards))
    passed = []
    for i in range(0, len(cards), 40):
        for attempt in range(3):
            try: passed += R.qa_batch(cards[i:i + 40]); break
            except Exception as e: print('retry', i, e); time.sleep(10)
        print(f'{min(i + 40, len(cards))}/{len(cards)} checked · {len(passed)} passed', flush=True)
    json.dump(passed, open(os.path.join(MW_DIR, 'passed.json'), 'w'), ensure_ascii=False, indent=0)
    print('passed:', ', '.join(n['name'] for n in passed))

def post():
    passed = json.load(open(os.path.join(MW_DIR, 'passed.json')))
    req = urllib.request.Request(MINI + '/api/extras', data=json.dumps({'names': passed}).encode(), headers={'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as r:
        j = json.load(r)
    print('mini now has', len(j['extras']), 'extras')

{'parse': parse, 'judge': judge, 'qa': qa, 'post': post}[stage]()
