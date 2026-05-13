#!/usr/bin/env python3
"""
Inlines app.js into index.html so the file opens directly in Chrome
without needing a local server.

Run after editing app.js:
    python3 build.py
"""
import re, sys, os

def read(path):
    with open(path, 'r') as f: return f.read()
def write(path, content):
    with open(path, 'w') as f: f.write(content)

src  = read('index.html')
js   = read('app.js')

# Replace (or update) any existing inline module block
pattern = r'  <script type="module">.*?</script>'
replacement = '  <script type="module">\n' + js + '\n  </script>'

if re.search(pattern, src, re.DOTALL):
    # Use a callable so re.sub doesn't process backslash escape sequences in replacement
    out = re.sub(pattern, lambda m: replacement, src, flags=re.DOTALL)
elif '<script type="module" src="app.js"></script>' in src:
    out = src.replace('<script type="module" src="app.js"></script>', replacement)
else:
    print("ERROR: couldn't find module script placeholder in index.html", file=sys.stderr)
    sys.exit(1)

write('index.html', out)
print(f"Built index.html ({len(out)//1024} KB) — open directly in Chrome, no server needed.")
