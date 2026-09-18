#!/usr/bin/env python3
"""Add a Devanagari spelling (`dev`) for every name that lacks one, via Claude structured output.

Results accumulate in data/devanagari.json ({id: "देवनागरी"}); build_pool.py applies that map,
so the spellings survive pool rebuilds. Usage: python3 tools/add_devanagari.py
"""
import json, os, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor

here = os.path.dirname(os.path.abspath(__file__))
root = os.path.join(here, '..')
key = open(os.path.join(root, '.secrets', 'anthropic.key')).read().strip()
names_path = os.path.join(root, 'data', 'names.json')
map_path = os.path.join(root, 'data', 'devanagari.json')
data = json.load(open(names_path))
dev = json.load(open(map_path)) if os.path.exists(map_path) else {}
todo = [n for n in data['names'] if n['id'] not in dev]
print('to spell:', len(todo), '| already:', len(dev))

SCHEMA = {'type': 'object', 'additionalProperties': False, 'required': ['spellings'],
          'properties': {'spellings': {'type': 'array', 'items': {'type': 'object', 'additionalProperties': False,
                         'required': ['name', 'dev'], 'properties': {'name': {'type': 'string'}, 'dev': {'type': 'string'}}}}}}

def ask(batch):
    lines = '\n'.join(f"{n['name']} — {n['say']} — {n['meaning']} ({n['root']})" for n in batch)
    body = {'model': 'claude-opus-5', 'max_tokens': 8000,
            'output_config': {'effort': 'low', 'format': {'type': 'json_schema', 'schema': SCHEMA}},
            'messages': [{'role': 'user', 'content': f"""For each boy's name below (Marathi family, Indian origin), give the standard Devanagari spelling as it would be written in Marathi — the form a Marathi text-to-speech voice should read aloud. Use the Latin spelling and the root to get vowel lengths right (e.g. Anvay → अन्वय, Kesar → केसर, Lahar → लहर, Devdar → देवदार). Output only the Devanagari word, no punctuation. One entry per name, same order, {len(batch)} entries.

{lines}"""}]}
    req = urllib.request.Request('https://api.anthropic.com/v1/messages', data=json.dumps(body).encode(),
                                 headers={'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json'})
    with urllib.request.urlopen(req, timeout=300) as r:
        j = json.load(r)
    text = ''.join(b.get('text', '') for b in j['content'] if b['type'] == 'text')
    return json.loads(text)['spellings']

B = 40
def run(i):
    for attempt in range(3):
        try: return ask(todo[i:i + B])
        except Exception as e: print('retry', i, e, flush=True); time.sleep(5)
    sys.exit('gave up')

with ThreadPoolExecutor(max_workers=5) as ex:
    for out in ex.map(run, range(0, len(todo), B)):
        for o in out:
            k = o['name'].lower().replace(' ', '')
            if o['dev'].strip(): dev[k] = o['dev'].strip()
        print(f'{len(dev)} spelled', flush=True)

json.dump(dev, open(map_path, 'w'), ensure_ascii=False, indent=0)
for n in data['names']:
    if n['id'] in dev: n['dev'] = dev[n['id']]
json.dump(data, open(names_path, 'w'), ensure_ascii=False, separators=(',', ':'))
print('done; missing:', [n['name'] for n in data['names'] if not n.get('dev')])
