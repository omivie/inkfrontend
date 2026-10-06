#!/usr/bin/env python3
"""
RED-PROOF FOR ERR-297 — /business APPLY
=======================================

A green suite is only worth what its ability to go red is worth (ERR-258). Each
mutation below undoes one decision in the Apply flow, on a COPY in a temp
directory (several Claude sessions share this tree; a peer's commit can deploy a
half-edited file, ERR-270/272), and asserts the suite goes red.

Usage:  python3 scripts/redproof-business-apply-sep2026.py
Exit 0 only if EVERY mutation was caught.
"""
import os, shutil, subprocess, sys, tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
TESTS = ['tests/business-apply-sep2026.test.js',
         'tests/business-centre-aug2026.test.js',
         'tests/legal-pages.test.js']
COPY = ['inkcartridges', 'tests/helpers'] + TESTS

BJ = 'inkcartridges/js/business.js'
BP = 'inkcartridges/js/business-page.js'
LP = 'inkcartridges/js/login-page.js'
SEC = 'inkcartridges/js/security.js'
HTML = 'inkcartridges/html/business.html'

M = [
 # can_apply absent is UNKNOWN — reading it as false locks every prospect out
 (BJ, "const canApply = typeof d.can_apply === 'boolean' ? d.can_apply : null;", "const canApply = d.can_apply === true;"),
 # an outage is not an answer about the application
 (BJ, "if (!this._statusDegraded) this._apply = { status: 'personal', canApply: null };", "this._apply = { status: 'personal', canApply: null };"),
 # sign-out must forget it
 (BJ, "        this._statusPromise = null;\n        this._apply = null;", "        this._statusPromise = null;"),
 # rejected resubmits via /reapply
 (BP, "this._applyEndpoint = reapply ? '/api/business/reapply' : '/api/business/apply';", "this._applyEndpoint = '/api/business/apply';"),
 # pending shows no form
 (BP, "            if (status === 'pending') {", "            if (false) {"),
 # suspended/closed/false: talk to us
 (BP, "if (status === 'suspended' || status === 'closed' || canApply === false) {", "if (status === 'suspended' || status === 'closed') {"),
 # unknown must be LOUD
 (BP, "warn('[BusinessPage] /api/business/status has no can_apply", "void ('[BusinessPage] /api/business/status has no can_apply"),
 # blank optionals are left out
 (BP, "                if (!v) continue;\n                if (name === 'nzbn')", "                if (name === 'nzbn')"),
 (BP, "if (body.nzbn && !/^\\d{13}$/.test(body.nzbn))", "if (false)"),
 # a refused POST re-reads status
 (BP, "if (apply && (apply.status === 'pending' || apply.canApply === false)) { this.renderApply(apply); return; }", ""),
 # rate limit, both shapes
 (BP, "res = { ok: false, error: e && e.message, code: e && e.code };", "res = { ok: false, error: e && e.message };"),
 (BP, "            if (res && res.code === 'RATE_LIMITED') {", "            if (false) {"),
 # BF-095 (2026-10-06): the 409 codes decide the panel, never a re-read that can fail
 (BP, "            if (res && res.code === 'APPLICATION_PENDING') {", "            if (false) {"),
 (BP, "            if (res && res.code === 'ALREADY_APPROVED') {", "            if (false) {"),
 # the limiter is per ACCOUNT now (after sign-in), not per connection
 (BP, "online application from your account today", "online application from this connection today"),
 # a failed ladder says so
 # an outage must not read as "the programme is off"
 (BP, "            if (!res || !res.ok || !ready) {", "            if (false) {"),
 # degraded keeps the open page, guesses nothing
 (BP, "                show('business-denied', true);\n                this.renderOpen();\n                this.renderApply('degraded');", "                return;"),
 # the redirect survives sign-up
 (LP, "                        rememberRedirect(new URLSearchParams(window.location.search));\n", ""),
 (LP, "                if (savedRedirect !== undefined) return savedRedirect;\n", ""),
 (LP, "&& Date.now() - saved.at >= 0 && Date.now() - saved.at < REDIRECT_TTL_MS;", ";"),
 # safeRedirect judges what the browser follows
 (SEC, ".replace(/\\\\/g, '/')", ""),
 (SEC, "trimmed.replace(/[\\t\\n\\r]/g, '')", "trimmed"),
 # page wiring
 (HTML, '<form id="business-apply-form" class="contact-form business-apply__form" novalidate hidden>', '<form id="business-apply-form" class="contact-form business-apply__form" action="/api/business/apply" novalidate hidden>'),
 (HTML, '<option value="1000_2500">', '<option value="1000_to_2500">'),
]


def fresh_tree(work):
    shutil.rmtree(work, ignore_errors=True)
    for rel in COPY:
        src, dst = os.path.join(ROOT, rel), os.path.join(work, rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        (shutil.copytree if os.path.isdir(src) else shutil.copy)(src, dst)

def run(work, show=False):
    r = subprocess.run(['node', '--test', *TESTS], cwd=work, capture_output=True, text=True)
    if show and r.returncode != 0:
        print('\n'.join(l for l in (r.stdout + r.stderr).splitlines() if 'Error' in l or '✖' in l)[:3000])
    return r.returncode

base = tempfile.mkdtemp(prefix='redproof-business-apply-')
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
