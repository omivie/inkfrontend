#!/usr/bin/env python3
"""
RED-PROOF — backend response of 2026-10-06 (BF-094/096/101 + GA4/Ads off /admin)
==============================================================================

A green suite is only worth what its ability to go red is worth (ERR-258). Each
mutation undoes ONE decision made for the 6 Oct backend response, on a COPY in
a temp directory (several Claude sessions share this tree), and the suite that
pins it must go red. The BF-095, BF-099 and BF-100 mutations live in their
areas' own red-proofs (redproof-business-apply-sep2026.py,
redproof-ad-clicks-to-orders.py, redproof-checkout-funnel-oct2026.py).

Usage:  python3 scripts/redproof-backend-response-6oct-2026.py
Exit 0 only if EVERY mutation was caught.
"""
import os, shutil, subprocess, sys, tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
TESTS = ['tests/backend-response-6oct-2026.test.js',
         'tests/fe-master-checklist-oct2026.test.js',
         'tests/turnaround-fixes-sep2026.test.js',
         'tests/round2-backend-response-sep2026.test.js',
         'tests/consent-mode-sep2026.test.js']

G = 'inkcartridges/js/gtag.js'
ADM = 'inkcartridges/html/admin/index.html'
U = 'inkcartridges/js/utils.js'
S = 'inkcartridges/js/shop-page.js'
SR = 'inkcartridges/js/service-row.js'

MUTATIONS = [
 # GA4 + Ads off /admin
 (G, "if (!(typeof location !== 'undefined' && String(location.pathname || '').startsWith('/admin'))) {\n    gtag('config'", "if (true) {\n    gtag('config'"),
 (ADM, '    <link rel="icon" type="image/png" href="/favicon.png">', '    <script src="/js/gtag.js?v=x"></script>\n    <link rel="icon" type="image/png" href="/favicon.png">'),
 # BF-094: backend name wins; absence is loud, raw, never re-cased
 (U, "if (typeof p.display_name === 'string' && p.display_name.trim()) return p.display_name.trim();", ""),
 (U, "            this._warned = true;\n", ""),
 (U, "        if (raw && !this._warned && typeof DebugLog !== 'undefined') {", "        if (false) {"),
 # BF-096: one request, honest failure
 (S, "const resp = await API.searchPrinters(q).catch(() => null);", "const resp = await Promise.all([API.searchPrinters(q), API.searchPrinters(q.replace(/-/g, ' '))]).then((a) => a[0]).catch(() => null);"),
 (S, "                if (!answered) {", "                if (false) {"),
 # BF-101: tax_invoice gate, site delivery_label fallback
 (SR, "if (ti.emailed_with_every_order === true && tiLabel) {", "if (tiLabel) {"),
 (SR, "const label = s(d.label) || s(t.shipping_promise && t.shipping_promise.delivery_label);", "const label = s(d.label);"),
]

def run(tree):
    return subprocess.run(['node', '--test', *TESTS], cwd=tree, capture_output=True, text=True).returncode

tmp = tempfile.mkdtemp()
tree = os.path.join(tmp, 'repo')
os.makedirs(tree)
for rel in ['inkcartridges', 'tests']:
    shutil.copytree(os.path.join(ROOT, rel), os.path.join(tree, rel))
try:
    assert run(tree) == 0, 'suite must be GREEN on the unmutated copy first'
    red = 0
    for f, old, new in MUTATIONS:
        p = os.path.join(tree, f)
        src = open(p).read()
        if src.count(old) != 1:
            print(f'STALE   {f}: anchor found {src.count(old)}x: {old[:60]!r}'); continue
        open(p, 'w').write(src.replace(old, new))
        rc = run(tree)
        open(p, 'w').write(src)
        ok = rc != 0
        red += ok
        print(f"{'RED  ' if ok else 'GREEN!'}  {f}: {old[:70]!r}")
    print(f'\n{red}/{len(MUTATIONS)} mutations turned the suite red')
    sys.exit(0 if red == len(MUTATIONS) else 1)
finally:
    shutil.rmtree(tmp)
