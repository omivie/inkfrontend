#!/usr/bin/env python3
"""
RED-PROOF FOR tests/tier-multiplier-approval-sep2026.test.js (ERR-281)
=====================================================================

A green suite is only worth what its ability to go red is worth (ERR-258). This
breaks the approval-gated pricing panel one way at a time and asserts that the
suite notices each break.

It never edits a live file. Every mutation is applied to a COPY of the files the
test reads, in a temp directory, because several Claude sessions work in this
repo at once and a peer's commit can deploy a half-edited file (ERR-270/272).

Usage:  python3 scripts/redproof-tier-approval.py
Exit 0 only if EVERY mutation was caught.
"""
import os, shutil, subprocess, sys, tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
COPY = ['inkcartridges/js/admin', 'inkcartridges/css/admin.css', 'inkcartridges/package.json',
        'tests/tier-multiplier-approval-sep2026.test.js', 'tests/helpers',
        'scripts/probe-tier-approval.mjs', 'package.json', 'errors.md',
        'backend-docs/inbox/tier-multiplier-approval-backend-contract-sep2026.md']
TEST = 'tests/tier-multiplier-approval-sep2026.test.js'

# (file, original text, mutated text). Each must appear exactly once.
M = [
 ('inkcartridges/js/admin/utils/tierProposal.js', "  if (row.blocked_by_no_decrease) return { kind: 'keeps', price: cur, engine: next };\n", ""),
 ('inkcartridges/js/admin/utils/tierProposal.js', "if (!live || !(k in live) || !sameMult(v, live[k])) out[k] = Number(v);", "out[k] = Number(v);"),
 ('inkcartridges/js/admin/utils/tierProposal.js', "} else if (prev != null && !(Number(max) > prev)) {", "} else if (false) {"),
 ('inkcartridges/js/admin/utils/tierProposal.js', "  if (elapsedMs >= POLL_MAX_MS) return { stop: true, outcome: 'timeout' };\n", ""),
 ('inkcartridges/js/admin/api.js', "      const body = { confirm: true };\n      if (notes) body.notes = notes;\n      const resp = await window.API.post(`/api/admin/pricing/tier-multipliers/proposals/${encodeURIComponent(id)}/approve`", "      const body = { confirm: false };\n      if (notes) body.notes = notes;\n      const resp = await window.API.post(`/api/admin/pricing/tier-multipliers/proposals/${encodeURIComponent(id)}/approve`"),
 ('inkcartridges/js/admin/api.js', "          if (resp.code === 'NOT_FOUND') return { missing: true, id: jobId };\n", ""),
 ('inkcartridges/js/admin/api.js', "      if (!resp || resp.ok === false) throw invoiceError(resp, 'Could not file the offset proposal');\n", ""),
 ('inkcartridges/js/admin/api.js', "      if (!resp || resp.ok === false) throw invoiceError(resp, 'Simulation failed');", "      if (resp && resp.ok === false) { const err = new Error(resp.error?.message || resp.error); err.code = resp.error?.code; throw err; }"),
 ('inkcartridges/js/admin/pages/cc2-pricing.js', "const approveDisabled = !pending || d.stale || !owner;", "const approveDisabled = !pending || !owner;"),
 ('inkcartridges/js/admin/pages/cc2-pricing.js', "Toast.success('Proposed. It is awaiting approval, and no price has moved.');", "Toast.success('Saved — prices are repricing.');"),
 ('inkcartridges/js/admin/pages/cc2-pricing.js', "  if (_state.validation.some((e) => e.reason !== 'no_change')) return;\n", ""),
 ('inkcartridges/js/admin/pages/cc-profit.js', "Toast.success('Offset proposed. It is awaiting approval in Site Health → Pricing, and no price has moved.');", "Toast.success('Saved');"),
 ('scripts/probe-tier-approval.mjs', "const job = await api('GET',", "await fetch(API_BASE + '/api/admin/pricing/tier-multipliers', { method: 'PUT' });\nconst job = await api('GET',"),
]


def fresh_tree(work):
    shutil.rmtree(work, ignore_errors=True)
    for rel in COPY:
        src, dst = os.path.join(ROOT, rel), os.path.join(work, rel)
        if not os.path.exists(src):
            continue
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        (shutil.copytree if os.path.isdir(src) else shutil.copy)(src, dst)

def run(work):
    return subprocess.run(['node', '--test', TEST], cwd=work, capture_output=True, text=True).returncode

base = tempfile.mkdtemp(prefix='redproof-tier-')
work = os.path.join(base, 'tree')
try:
    fresh_tree(work)
    if run(work) != 0:
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
