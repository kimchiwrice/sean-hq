#!/usr/bin/env python3
"""
HQ Deploy Smoke Test
Runs after every deploy to verify all sites and data integrity.

Usage:
  python smoke-test.py          # Full test (network + local)
  python smoke-test.py --local  # Local data.json validation only (no network)
"""
import json, sys, os, time

RED = '\033[91m'
GREEN = '\033[92m'
GOLD = '\033[93m'
RESET = '\033[0m'
CHECK = f'{GREEN}PASS{RESET}'
CROSS = f'{RED}FAIL{RESET}'

results = []
LOCAL_ONLY = '--local' in sys.argv

def test(name, fn):
    try:
        ok, detail = fn()
        status = CHECK if ok else CROSS
        results.append(ok)
        print(f'  [{status}] {name}: {detail}')
    except Exception as e:
        results.append(False)
        print(f'  [{CROSS}] {name}: {RED}{e}{RESET}')

# ===== LOCAL VALIDATION =====
def validate_local_json():
    """Validate local data.json — no network needed"""
    script_dir = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(script_dir, 'data.json')

    if not os.path.exists(path):
        return False, f'File not found: {path}'

    raw = open(path, 'rb').read()

    # Null byte check
    nulls = [i for i, b in enumerate(raw) if b == 0]
    if nulls:
        return False, f'NULL BYTES at positions: {nulls}'

    # JSON parse
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as e:
        return False, f'JSON parse error: {e}'

    # Required keys
    required = ['stats', 'roadmap', 'deploys', 'portfolio', 'quickActions', 'tools', 'aiTools', 'hoursLog', 'systems', 'ventures', 'lastUpdated']
    missing = [k for k in required if k not in data]
    if missing:
        return False, f'Missing keys: {missing}'

    # Stats type check
    for field in ['liveSites', 'tasksDone', 'deploys']:
        val = data.get('stats', {}).get(field)
        if not isinstance(val, (int, float)):
            return False, f'stats.{field} invalid: {val}'

    # Non-empty arrays
    arrays = {k: len(data[k]) for k in ['portfolio', 'quickActions', 'tools', 'systems', 'deploys', 'ventures']}
    empty = [k for k, v in arrays.items() if v == 0]
    if empty:
        return False, f'Empty arrays: {empty}'

    # Portfolio URLs present
    for i, p in enumerate(data['portfolio']):
        for key in ['name', 'url', 'emoji', 'desc', 'tags']:
            if key not in p:
                return False, f'portfolio[{i}] missing "{key}"'

    # Roadmap structure
    for phase in ['p1', 'p2', 'p3', 'p4']:
        if phase not in data['roadmap']:
            return False, f'roadmap.{phase} missing'
        if 'progress' not in data['roadmap'][phase]:
            return False, f'roadmap.{phase}.progress missing'

    summary = f'{arrays["portfolio"]} sites, {data["stats"]["tasksDone"]} tasks, {arrays["deploys"]} deploys, updated {data["lastUpdated"]}'
    return True, summary

def check_file_size():
    """Make sure data.json isn't suspiciously small or huge"""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data.json')
    size = os.path.getsize(path)
    if size < 500:
        return False, f'{size} bytes — suspiciously small, possible truncation'
    if size > 50000:
        return False, f'{size} bytes — unusually large, check for bloat'
    return True, f'{size} bytes'

def check_index_html():
    """Validate index.html basics"""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'index.html')
    if not os.path.exists(path):
        return False, 'File not found'

    raw = open(path, 'rb').read()
    if b'\x00' in raw:
        return False, 'NULL BYTES detected'

    content = raw.decode('utf-8', errors='replace')
    checks = {
        'DOCTYPE': '<!DOCTYPE html>' in content,
        'GSAP CDN': 'gsap' in content.lower(),
        'data.json fetch': "fetch('data.json" in content or 'fetch("data.json' in content,
        'error fallback': 'Data sync failed' in content,
        'counter system': 'animateCounter' in content,
        'visibility handler': 'visibilitychange' in content,
    }
    failed = [k for k, v in checks.items() if not v]
    if failed:
        return False, f'Missing: {", ".join(failed)}'
    return True, f'All {len(checks)} checks pass ({len(content)} chars)'

# ===== NETWORK TESTS =====
def check_url(url, timeout=10):
    from urllib.request import urlopen, Request
    req = Request(url, headers={'User-Agent': 'HQ-SmokeTest/1.0'})
    r = urlopen(req, timeout=timeout)
    return r.status == 200, f'{r.status} OK'

def check_remote_json():
    from urllib.request import urlopen, Request
    req = Request(f'https://sean-hq.vercel.app/data.json?t={int(time.time())}',
                  headers={'User-Agent': 'HQ-SmokeTest/1.0'})
    raw = urlopen(req, timeout=10).read()
    if b'\x00' in raw:
        return False, 'NULL BYTES in remote data.json'
    data = json.loads(raw)
    return True, f'Remote valid — {len(data["portfolio"])} sites, {data["stats"]["tasksDone"]} tasks'

def check_portfolio_live():
    from urllib.request import urlopen, Request
    req = Request(f'https://sean-hq.vercel.app/data.json?t={int(time.time())}',
                  headers={'User-Agent': 'HQ-SmokeTest/1.0'})
    data = json.loads(urlopen(req, timeout=10).read())
    statuses = []
    all_ok = True
    for site in data['portfolio']:
        try:
            sreq = Request(site['url'], headers={'User-Agent': 'HQ-SmokeTest/1.0'})
            r = urlopen(sreq, timeout=10)
            statuses.append(f'{site["name"]}=OK')
        except Exception:
            statuses.append(f'{site["name"]}=DOWN')
            all_ok = False
    return all_ok, ' | '.join(statuses)

# ===== RUN =====
print(f'\n{GOLD}{"━" * 40}')
print(f'  HQ SMOKE TEST {"(LOCAL)" if LOCAL_ONLY else "(FULL)"}')
print(f'{"━" * 40}{RESET}\n')

print(f'{GOLD}[Local Validation]{RESET}')
test('data.json integrity', validate_local_json)
test('data.json file size', check_file_size)
test('index.html integrity', check_index_html)

if not LOCAL_ONLY:
    print(f'\n{GOLD}[Network — Live Sites]{RESET}')
    test('HQ Dashboard', lambda: check_url('https://sean-hq.vercel.app/'))
    test('Trinh Media', lambda: check_url('https://trinh-media-site.vercel.app/'))
    test('T4 Folsom', lambda: check_url('https://t4-folsom.vercel.app/'))

    print(f'\n{GOLD}[Network — Data]{RESET}')
    test('Remote data.json', check_remote_json)
    test('Portfolio sites live', check_portfolio_live)

# ===== SUMMARY =====
passed = sum(results)
total = len(results)
print(f'\n{GOLD}{"━" * 40}{RESET}')
if all(results):
    print(f'  {GREEN}ALL PASS ({passed}/{total}){RESET}')
else:
    print(f'  {RED}{total - passed} FAILED / {total} total{RESET}')
print(f'{GOLD}{"━" * 40}{RESET}\n')

sys.exit(0 if all(results) else 1)
