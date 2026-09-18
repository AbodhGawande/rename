#!/usr/bin/env python3
"""Bump the app version and stamp the build time. Run before every deploy:  python3 tools/stamp.py"""
import re, os, datetime
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
app = open(os.path.join(root, 'app.js')).read()
sw = open(os.path.join(root, 'sw.js')).read()
v = int(re.search(r'const APP_VERSION = (\d+);', app).group(1)) + 1
stamp = datetime.datetime.now().astimezone().strftime('%b %-d, %Y · %-I:%M %p %Z')
app = re.sub(r'const APP_VERSION = \d+;', f'const APP_VERSION = {v};', app)
app = re.sub(r"const APP_BUILT = '[^']*';", f"const APP_BUILT = '{stamp}';", app)
sw = re.sub(r'const VERSION = \d+;', f'const VERSION = {v};', sw)
open(os.path.join(root, 'app.js'), 'w').write(app); open(os.path.join(root, 'sw.js'), 'w').write(sw)
print(f'v{v} · {stamp}')
