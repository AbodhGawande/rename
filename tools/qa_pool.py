#!/usr/bin/env python3
"""Second-opinion pass over data/names.json using Claude (structured output).

Flags names that are feminine/unisex-leaning, South-Indian-specific, currently trending among
Indian-American babies, older-generation, or whose stated meaning is doubtful. Writes the verdicts
to data/qa.json and removes the hard fails from data/names.json (keeps a backup).

Usage: python3 tools/qa_pool.py   (reads the key from .secrets/anthropic.key)
"""
import json, os, sys, time, urllib.request

here = os.path.dirname(os.path.abspath(__file__))
root = os.path.join(here, '..')
key = open(os.path.join(root, '.secrets', 'anthropic.key')).read().strip()
data = json.load(open(os.path.join(root, 'data', 'names.json')))
qa_path = os.path.join(root, 'data', 'qa.json')
verdicts = json.load(open(qa_path)) if os.path.exists(qa_path) else {}
# unchecked names, plus old-generation flags that predate the common_then question
names = [n for n in data['names'] if n['id'] not in verdicts or (verdicts[n['id']].get('old_generation') and 'common_then' not in verdicts[n['id']])]
print('to check:', len(names), '| already checked:', len(verdicts))

SCHEMA = {
    'type': 'object', 'additionalProperties': False, 'required': ['verdicts'],
    'properties': {'verdicts': {'type': 'array', 'items': {
        'type': 'object', 'additionalProperties': False,
        'required': ['name', 'gender', 'south_specific', 'trending', 'old_generation', 'common_then', 'meaning_ok', 'note'],
        'properties': {
            'name': {'type': 'string'},
            'gender': {'type': 'string', 'enum': ['boy', 'unisex', 'girl']},
            'south_specific': {'type': 'boolean'},
            'trending': {'type': 'boolean', 'description': 'popular among Indian-American / urban-India boys born 2015-2025'},
            'old_generation': {'type': 'boolean', 'description': 'used for Indian men born 1950-1995 at all'},
            'common_then': {'type': 'boolean', 'description': 'true only if it was a genuinely COMMON name of that era'},
            'meaning_ok': {'type': 'boolean', 'description': 'the stated meaning/root is accurate'},
            'note': {'type': 'string', 'description': 'one short phrase only when something is flagged, else empty'},
        }}}},
}

def ask(batch):
    lines = '\n'.join(f"{n['name']} — {n['meaning']} ({n['root']})" for n in batch)
    body = {
        'model': 'claude-opus-5', 'max_tokens': 16000,
        'output_config': {'effort': 'medium', 'format': {'type': 'json_schema', 'schema': SCHEMA}},
        'messages': [{'role': 'user', 'content': f"""You are checking a list of candidate first names for a BOY born 2025 in the USA to Marathi parents. For EACH name below give a verdict. Be strict and honest:
- gender: 'girl' if the name is used for girls in India, 'unisex' if commonly both, else 'boy'.
- south_specific: true only if usage is clearly Tamil/Telugu/Kannada/Malayalam-specific (pan-Indian Sanskrit names are false).
- trending: true if it is currently popular among Indian-American or urban-Indian boys born 2015-2025 (Aarav/Vihaan tier or the next tier down).
- old_generation: true if it was used for Indian men born 1950-1995 at all.
- common_then: true only if it was a genuinely COMMON name of that era (many men carry it); a rare classic is fine.
- meaning_ok: false if the stated meaning or root is wrong or invented.
Return one verdict per name, same order, {len(batch)} verdicts.

{lines}"""}],
    }
    req = urllib.request.Request('https://api.anthropic.com/v1/messages', data=json.dumps(body).encode(),
                                 headers={'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=600) as r:
        j = json.load(r)
    text = ''.join(b.get('text', '') for b in j['content'] if b['type'] == 'text')
    return json.loads(text)['verdicts']

B = 50
from concurrent.futures import ThreadPoolExecutor

def run(i):
    batch = names[i:i + B]
    for attempt in range(3):
        try:
            return ask(batch)
        except Exception as e:
            print('retry', i, e, flush=True); time.sleep(5)
    sys.exit('gave up')

with ThreadPoolExecutor(max_workers=5) as ex:
    for vs in ex.map(run, range(0, len(names), B)):
        for v in vs:
            verdicts[v['name'].lower().replace(' ', '')] = v
        print(f'{len(verdicts)}/{len(names)}', flush=True)

json.dump(verdicts, open(qa_path, 'w'), ensure_ascii=False, indent=1)
keep, drop = [], []
for n in data['names']:
    v = verdicts.get(n['id'])
    if not v:
        keep.append(n); continue
    hard = v['gender'] == 'girl' or v['south_specific'] or v['trending'] or (v['old_generation'] and v.get('common_then', False)) or not v['meaning_ok']
    if hard:
        drop.append((n['name'], v)); continue
    if v['gender'] == 'unisex':
        n['note'] = (n['note'] + ' · ' if n['note'] else '') + 'used for girls too'
    keep.append(n)
json.dump(data, open(os.path.join(root, 'data', 'names.before-qa.json'), 'w'), ensure_ascii=False, separators=(',', ':'))
data['names'] = keep; data['count'] = len(keep)
json.dump(data, open(os.path.join(root, 'data', 'names.json'), 'w'), ensure_ascii=False, separators=(',', ':'))
print(f'kept {len(keep)}, dropped {len(drop)}:')
for name, v in drop:
    why = [k for k in ('south_specific', 'trending', 'old_generation') if v[k]] + (['girl'] if v['gender'] == 'girl' else []) + ([] if v['meaning_ok'] else ['meaning'])
    print(' -', name, ','.join(why), '·', v['note'])
