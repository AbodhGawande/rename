#!/usr/bin/env python3
"""Merge the generated name buckets into data/names.json.

Inputs (scratchpad, produced by Claude Code agents):
  pool/*.json         name buckets (arrays of name objects)
  pool/exclusions.json  old_generation / trending_indian_us / south_indian_specific / south_patterns
  ssa_boys.json       {name: {"y": {year: count}, "r24": rank}} from SSA national data (boys, 2010-2024)

Usage: python3 tools/build_pool.py <scratchpad-dir>
"""
import glob, json, os, re, sys, math, datetime

src = sys.argv[1]
here = os.path.dirname(os.path.abspath(__file__))
out_path = os.path.join(here, '..', 'data', 'names.json')

exc = json.load(open(os.path.join(src, 'pool', 'exclusions.json')))
ssa = json.load(open(os.path.join(src, 'ssa_boys.json')))

# The seed exclusions used in every generation prompt, as a belt-and-braces guard.
SEED = """Aarav Vihaan Arjun Reyansh Aditya Ishaan Krish Rohan Aryan Advik Dev Neil Kabir Vivaan Ayaan Rishi Arnav
Shaurya Kian Viraj Rudra Atharv Aarush Avyaan Ahaan Nirvaan Yash Dhruv Om Shiv Veer Ved Vir Anay Shrey Aayan Rian Ryan
Nikhil Rahul Raj Sai Samar Sahil Zayan Arav Ayush Agastya Reyan Jay Jai Ishan Kiaan Ivaan Vihan""".split()

def norm(n):
    return re.sub(r'[^a-z]', '', n.lower())

# Pan-Indian names the south-specific list caught by mistake.
KEEP = {'manu', 'pavan', 'tarak'}
excluded = set()
for key in ('old_generation', 'trending_indian_us', 'south_indian_specific'):
    for n in exc.get(key, []):
        excluded.add(norm(n))
for n in SEED:
    excluded.add(norm(n))
excluded -= KEEP
south_patterns = [p.lower() for p in exc.get('south_patterns', []) if len(p) >= 4]

names = {}
order = ['short', 'nature', 'light', 'virtues', 'sky', 'marathi', 'epics', 'coined']
files = sorted(glob.glob(os.path.join(src, 'pool', '*.json')),
               key=lambda f: order.index(os.path.basename(f)[:-5]) if os.path.basename(f)[:-5] in order else 99)
dropped = {'excluded': 0, 'south_pattern': 0, 'common_us': 0, 'dupe': 0, 'bad': 0}
for f in files:
    if f.endswith('exclusions.json'):
        continue
    try:
        arr = json.load(open(f))
    except Exception as e:
        print('BAD FILE', f, e); continue
    for o in arr:
        try:
            n = o['name'].strip()
            key = norm(n)
            if not key or not (2 <= len(key) <= 12):
                dropped['bad'] += 1; continue
            if key in excluded or any(norm(a) in excluded for a in o.get('alt', [])):
                dropped['excluded'] += 1; continue
            if any(key.endswith(p) for p in south_patterns) and o.get('region') != 'marathi':
                dropped['south_pattern'] += 1; continue
            if key in names:
                # merge alternates, keep the first (buckets ordered by quality of fit)
                names[key]['alt'] = sorted(set(names[key]['alt']) | set(o.get('alt', [])))
                dropped['dupe'] += 1; continue
            s = ssa.get(key, {})
            yrs = s.get('y', {})
            c24 = int(yrs.get('2024', 0))
            c10 = sum(int(yrs.get(str(y), 0)) for y in range(2015, 2025))
            if c24 >= 80:
                dropped['common_us'] += 1; continue
            # uniqueness: 100 when SSA never lists it (<5 babies/yr), sliding down with 2024 count
            unique = 100 if c24 == 0 else max(5, round(100 - 22 * math.log2(1 + c24 / 4)))
            say = max(1, min(10, int(o.get('sayability', 7)))) * 10
            trad = o.get('tradition', 'traditional')
            fresh = {'coined': 90, 'rare-traditional': 80, 'traditional': 60}.get(trad, 60)
            trend = 'rising' if c24 > 1.5 * max(1, int(yrs.get('2015', 0))) and c24 >= 10 else ('falling' if c24 * 1.5 < int(yrs.get('2015', 0)) else 'flat')
            names[key] = {
                'id': key,
                'name': n[0].upper() + n[1:],
                'alt': [a for a in o.get('alt', []) if norm(a) != key][:4],
                'say': o.get('say', ''),
                'syllables': int(o.get('syllables', 2)),
                'meaning': o.get('meaning', ''),
                'root': o.get('root', ''),
                'origin': o.get('origin', 'Sanskrit'),
                'category': o.get('category', 'other'),
                'themes': [t.lower() for t in o.get('themes', [])][:3],
                'sayability': say,
                'say_note': o.get('say_note', ''),
                'tradition': trad,
                'region': o.get('region', 'pan-Indian'),
                'collisions': o.get('collisions', '') or '',
                'nicknames': o.get('nicknames', [])[:4],
                'confidence': o.get('confidence', 'medium'),
                'note': o.get('note', '') or '',
                'us': {'c24': c24, 'c10': c10, 'rank24': s.get('r24'), 'trend': trend},
                'unique': unique,
                'fresh': fresh,
            }
        except Exception as e:
            dropped['bad'] += 1
            print('bad row', e, o)

# Apply Claude's QA verdicts (tools/qa_pool.py) if they exist.
qa_path = os.path.join(here, '..', 'data', 'qa.json')
if os.path.exists(qa_path):
    qa = json.load(open(qa_path))
    for key in list(names):
        v = qa.get(key)
        if not v: continue
        if v['gender'] == 'girl' or v['south_specific'] or v['trending'] or (v['old_generation'] and v.get('common_then', False)) or not v['meaning_ok']:
            del names[key]; dropped['qa'] = dropped.get('qa', 0) + 1; excluded.add(key)
        elif v['gender'] == 'unisex' and 'used for girls too' not in names[key]['note']:
            names[key]['note'] = (names[key]['note'] + ' · ' if names[key]['note'] else '') + 'used for girls too'

# Devanagari spellings (tools/add_devanagari.py) for the Marathi-voice button.
dev_path = os.path.join(here, '..', 'data', 'devanagari.json')
if os.path.exists(dev_path):
    dev = json.load(open(dev_path))
    for key, n in names.items():
        if key in dev: n['dev'] = dev[key]

# The same exclusions (lists + QA drops), shipped to the phone so Claude's on-device suggestions get filtered too.
json.dump(sorted(excluded), open(os.path.join(here, '..', 'data', 'exclude.json'), 'w'), separators=(',', ':'))

arr = sorted(names.values(), key=lambda x: x['name'])
data = {
    'version': datetime.datetime.now().strftime('%Y-%m-%d'),
    'count': len(arr),
    'names': arr,
}
os.makedirs(os.path.dirname(out_path), exist_ok=True)
json.dump(data, open(out_path, 'w'), ensure_ascii=False, separators=(',', ':'))
print('wrote', len(arr), 'names ->', out_path)
print('dropped', dropped)
cats = {}
for x in arr:
    cats[x['category']] = cats.get(x['category'], 0) + 1
print('categories', cats)
print('with SSA presence:', sum(1 for x in arr if x['us']['c24'] > 0))
