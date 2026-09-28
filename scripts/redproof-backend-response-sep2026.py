#!/usr/bin/env python3
"""
RED-PROOF FOR THE 2026-09-28 BUILD ON THE BACKEND'S ANSWER TO OUR FOUR REPLIES (ERR-291)
=====================================================================================

A green suite is only worth what its ability to go red is worth (ERR-258). This
undoes each change one at a time, putting back the exact line the fix replaced
where there was one, and asserts that the suite goes red on every undo.

The tier-approval half has its own red-proof: scripts/redproof-tier-approval.py.

It never edits a live file. Every mutation is applied to a COPY in a temp
directory, because several Claude sessions work in this repo at once and a
peer's commit can deploy a half-edited file (ERR-270/272).

Usage:  python3 scripts/redproof-backend-response-sep2026.py
Exit 0 only if EVERY mutation was caught.
"""
import os, shutil, subprocess, sys, tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
COPY = ['inkcartridges/js', 'inkcartridges/css', 'inkcartridges/html', 'inkcartridges/package.json',
        'tests/helpers', 'scripts/probe-bundle-response-sep2026.mjs', 'scripts/probe-tier-approval.mjs',
        'package.json', 'errors.md', 'backend-docs/inbox/fe-replies-round-backend-response-sep2026.md']
TESTS = ['tests/backend-response-fe-replies-sep2026.test.js',
         'tests/admin-invoice-portal-link-sep2026.test.js',
         'tests/image-audit-restore-legacy-sep2026.test.js',
         'tests/admin-products-fallback-filters-sep2026.test.js',
         'tests/code-yield-grouping-may2026.test.js']
COPY += TESTS

API = 'inkcartridges/js/admin/api.js'
IMP = 'inkcartridges/js/admin/utils/importStatus.js'
INV = 'inkcartridges/js/admin/pages/invoices.js'
GIA = 'inkcartridges/js/admin/pages/genuine-image-audit.js'
PRD = 'inkcartridges/js/admin/pages/products.js'
REV = 'inkcartridges/js/admin/pages/product-review.js'
LCK = 'inkcartridges/js/admin/pages/site-lock.js'
UTL = 'inkcartridges/js/utils.js'
PRB = 'scripts/probe-bundle-response-sep2026.mjs'

# (file, fixed text, the broken text). Each fixed text must appear exactly once.
M = [
 # BF-070 h — import health
 (IMP, "  if (latest.status === 'failed') { worse('bad'); reasons.push('The latest run failed.'); }\n", ""),
 (IMP, "  if (failed.length && latest.status !== 'failed') {", "  if (false) {"),
 (IMP, "  const lastReal = [latest, ...runs].find((r) => r && !r.dry_run) || null;", "  const lastReal = latest;"),
 (IMP, "  if (!data || typeof data !== 'object') return null;", "  if (!data || typeof data !== 'object') data = {};"),
 (IMP, "<tbody>${(f.runs.length ? f.runs : [l]).map((r) => runRowHtml(r, esc)).join('')}</tbody>", "<tbody>${runRowHtml(l, esc)}</tbody>"),
 # BF-070 g — invoices
 (INV, "  return want === 'linked' ? 'true' : want === 'unlinked' ? 'false' : '';", "  return want;"),
 (INV, "linked: linkedParam(_portalFilter) }", "}"),
 (API, "      if (!resp || resp.ok === false) throw invoiceError(resp, 'The invoice list request was refused');\n", ""),
 (API, "      if (filters.linked === 'true' || filters.linked === 'false') params.set('linked', filters.linked);", "      if (filters.linked) params.set('portal', filters.linked);"),
 # BF-070 d + the brand 404 — image audit
 (GIA, "  { key: 'watermark_hold', label: 'Watermark hold' },\n", ""),
 (GIA, "    const val = (typeof b === 'object' && b.slug) ? b.slug : name;", "    const val = (typeof b === 'object' && b.id) ? b.id : name;"),
 (GIA, "  _listFailed = data === null;", "  _listFailed = false;"),
 # BF-070 c — brand on /api/admin/products
 (PRD, "      return { ...filters, brand: hit.id };", "      return { ...filters, brand: (hit && hit.slug) || name };"),
 (REV, "        ${_brands.map(b => `<option value=\"${esc(b.slug)}\">${esc(b.name)}</option>`).join('')}", "        ${_brands.map(b => `<option value=\"${esc(b.name)}\">${esc(b.name)}</option>`).join('')}"),
 (API, "      if (!resp || resp.ok === false) throw invoiceError(resp, 'The review queue request was refused');\n", ""),
 (REV, "import { AdminAPI, FilterState, icon, esc } from '../app.js';", "import { AdminAPI, FilterState, icon, esc, updateReviewBadge } from '../app.js';"),
 # BF-069 — the admin copy
 (LCK, "    : 'Site unlocked. Shoppers see it within about a minute.');", "    : 'Site unlocked — open to all visitors.');"),
 # BF-070 e — yield tier
 (UTL, "        return backendTier >= 0 ? backendTier : detected;", "        return Math.max(backendTier, detected);"),
 (PRB, "  const detectorTier = (p) => ProductSort.yieldTier({ ...p, yield_tier: undefined });", "  const detectorTier = (p) => ProductSort.yieldTier(p);"),
]


def fresh_tree(work):
    shutil.rmtree(work, ignore_errors=True)
    for rel in COPY:
        src, dst = os.path.join(ROOT, rel), os.path.join(work, rel)
        if not os.path.exists(src):
            continue
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        (shutil.copytree if os.path.isdir(src) else shutil.copy)(src, dst)

def run(work, show=False):
    r = subprocess.run(['node', '--test', *TESTS], cwd=work, capture_output=True, text=True)
    if show and r.returncode != 0:
        print('\n'.join(l for l in (r.stdout + r.stderr).splitlines() if 'not ok' in l or 'Error' in l or '✖' in l)[:3000])
    return r.returncode

base = tempfile.mkdtemp(prefix='redproof-backend-response-')
work = os.path.join(base, 'tree')
try:
    fresh_tree(work)
    if run(work, show=True) != 0:
        print('control run is RED on the unmutated copy: fix the suite first'); sys.exit(2)
    caught = 0
    for f, a, b in M:
        fresh_tree(work)
        p = os.path.join(work, f)
        src = open(p).read()
        if src.count(a) != 1:
            print('ANCHOR MOVED  ' + f + ': ' + a.strip()[:70]); continue
        open(p, 'w').write(src.replace(a, b))
        red = run(work) != 0
        caught += red
        print(('caught  ' if red else 'MISSED  ') + os.path.basename(f) + ': ' + a.strip().splitlines()[0][:70])
    print(f'{caught}/{len(M)} mutations caught')
    sys.exit(0 if caught == len(M) else 1)
finally:
    shutil.rmtree(base, ignore_errors=True)
