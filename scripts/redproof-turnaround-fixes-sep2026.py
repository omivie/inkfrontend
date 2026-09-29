#!/usr/bin/env python3
"""
RED-PROOF FOR ERR-296 — THE BACKEND'S TURNAROUND DOC (2026-09-28)
=================================================================

A green suite is only worth what its ability to go red is worth (ERR-258). This
undoes each ERR-296 change one at a time — putting back the text the fix
replaced where there was one — and asserts tests/turnaround-fixes-sep2026.test.js
goes red on every undo.

It never edits a live file. Every mutation is applied to a COPY in a temp
directory: several Claude sessions work in this repo at once and a peer's commit
can deploy a half-edited file (ERR-270/272).

Usage:  python3 scripts/redproof-turnaround-fixes-sep2026.py
Exit 0 only if EVERY mutation was caught.
"""
import os, shutil, subprocess, sys, tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
TESTS = ['tests/turnaround-fixes-sep2026.test.js']
COPY = ['inkcartridges', 'tests/helpers'] + TESTS

MW = 'inkcartridges/middleware.js'
SHOP = 'inkcartridges/js/shop-page.js'
SHH = 'inkcartridges/html/shop.html'
SRCH = 'inkcartridges/js/search.js'
UTL = 'inkcartridges/js/utils.js'
CONF = 'inkcartridges/js/order-confirmation-page.js'
AUTH = 'inkcartridges/js/auth.js'
API = 'inkcartridges/js/api.js'
PDP = 'inkcartridges/js/product-detail-page.js'
CART = 'inkcartridges/js/cart.js'
CARTP = 'inkcartridges/js/cart-page.js'
CHK = 'inkcartridges/js/checkout-page.js'
VP = 'inkcartridges/js/value-pages.js'
ACC = 'inkcartridges/js/account.js'
PAGES = 'inkcartridges/css/pages.css'
COMP = 'inkcartridges/css/components.css'
SCSS = 'inkcartridges/css/search.css'
BASE = 'inkcartridges/css/base.css'
CARTH = 'inkcartridges/html/cart.html'
LOGIN = 'inkcartridges/html/account/login.html'

FONT_IMPORT = ("@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800"
               "&family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap');\n")

M = [
 # §1 middleware
 (MW, "    return prerenderUnavailable();\n  }\n}", "    return;\n  }\n}"),
 (MW, "if (response.status >= 500) return prerenderUnavailable();", ""),
 (MW, "      signal: AbortSignal.timeout(PRERENDER_TIMEOUT_MS),\n", ""),
 (MW, "      'Cache-Control': 'no-store',\n      'X-Robots-Tag': 'noindex',", "      'Cache-Control': 'public, s-maxage=3600',\n      'X-Robots-Tag': 'noindex',"),
 # §2 finder + alias
 (SHOP, "return new URLSearchParams(search || '').get('from') === 'finder';", "return true;"),
 (SHOP, "if (!smartData || (smartData.matched_printer && smartData.matched_printer.name)) return false;", "if (!smartData) return false;"),
 (SHOP, "<strong>We couldn't match that printer.</strong>", "No printer found. Press Find to search every product."),
 (SHH, '<input type="hidden" name="from" value="finder">\n', ""),
 (SHOP, "Search ${Security.escapeHtml(toLabel)}</a>", "See every ${Security.escapeHtml(toLabel)} result</a>"),
 # §3 typeahead
 (SRCH, "alias_suggestion: data.alias_suggestion || null,", ""),
 # §4
 (UTL, "(ADS|DCP|FAX|HL|MFC|PT|QL)", "(DCP|FAX|HL|MFC|PT|QL)"),
 # §5
 (CONF, "? apiOrder.business_account_offer === true\n                    : null,", "? apiOrder.business_account_offer === true\n                    : false,"),
 (CONF, "bizOffer.hidden = order.businessAccountOffer !== true;", "bizOffer.hidden = !order.businessAccountOffer && order.businessAccountOffer !== null;"),
 (CONF, "Array.isArray(data.user.identities) && data.user.identities.length === 0", "false"),
 (CONF, "if (!password || password.length < 8)", "if (!password)"),
 (AUTH, "if (metadata && typeof metadata === 'object') options.data = metadata;", ""),
 # §6
 (API, "if (!active) return 0;", ""),
 (API, "return Math.round((v - calculateGST(v)) * 100) / 100;", "return Math.round(v * 100) / 100;"),
 (API, "} catch (_) { active = false; }", "} catch (_) { active = true; }"),
 (CART, "if (typeof decorateExGst === 'function') decorateExGst(cartItems);", ""),
 # §7
 (VP, "if (brand) params.brand = brand;", ""),
 (VP, ".filter(b => b && b.show_on_shop === true &&", ".filter(b => b &&"),
 (VP, "return /^[a-z0-9][a-z0-9-]{0,40}$/.test(b) ? b : '';", "return b;"),
 # §8
 (ACC, "if (typeof sku !== 'string' || !sku.trim()) { missingSku++; return; }", "if (typeof sku !== 'string' || !sku.trim()) { return; }"),
 (ACC, "const qty = Math.max(1, Math.floor(Number(item.quantity)) || 1);", "const qty = 1;"),
 # §9
 (CARTP, "    form.hidden = isGuest;\n", ""),
 (CHK, "                formRow.hidden = true;\n", ""),
 (CARTH, "<span>Total before shipping</span>", "<span>Total</span>"),
 (CART, "const turnstileToken = await this._takeTurnstileToken();", "const turnstileToken = typeof Auth !== 'undefined' ? await Auth.getTurnstileToken() : null;"),
 (CART, "        this._turnstilePrefetch = null;\n        if (!pre ||", "        if (!pre ||"),
 (CART, "            return await Promise.race([pre.promise, cap]);", "            return await pre.promise;"),
 # §10 CSS
 (PAGES, "font-size: 0.75rem; /* 12px floor on cards (ERR-296): was 0.62rem, 9.9px */", "font-size: 0.62rem;"),
 (SCSS, "font-size: 12px; /* 12px floor on cards (ERR-296): was 10px */", "font-size: 10px;"),
 (COMP, "    max-width: 120px;\n", ""),
 (COMP, "        top: calc(env(safe-area-inset-top, 0px) + 12px);\n        bottom: auto;", "        bottom: 12px;"),
 (PAGES, "body:has(.site-header--hidden) .filter-sort-bar:not(:focus-within) {", "body.never .filter-sort-bar {"),
 # §11 fonts
 (BASE, "/* Web fonts load from", FONT_IMPORT + "/* Web fonts load from"),
 # §12
 (PDP, '<a href="/quote">Buying for several printers? Get a quote</a>', 'Buying for several printers?'),
 # the line appears twice (sign-in + register) — both are unhidden together
 (LOGIN, '<p class="auth-form__points" data-value-prop-scope hidden>', '<p class="auth-form__points" data-value-prop-scope>', 2),
 # §2 separator-intolerant printer search (found while building)
 (SHOP, "return spaced && spaced !== raw ? [raw, spaced] : [raw];", "return [raw];"),
 (SHOP, "if (!key || seen.has(key)) continue;", "if (!key) continue;"),
 (SHOP, "finderSpellings(q).map((s) => API.searchPrinters(s)", "[q].map((s) => API.searchPrinters(s)"),
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
    try:
        r = subprocess.run(['node', '--test', *TESTS], cwd=work, capture_output=True, text=True, timeout=240)
    except subprocess.TimeoutExpired:
        print('  (suite HUNG — a hang is not a green run; counted red)')
        return 124
    if show and r.returncode != 0:
        print('\n'.join(l for l in (r.stdout + r.stderr).splitlines() if 'Error' in l or '✖' in l)[:3000])
    return r.returncode

base = tempfile.mkdtemp(prefix='redproof-turnaround-')
work = os.path.join(base, 'tree')
try:
    fresh_tree(work)
    if run(work, show=True) != 0:
        print('control run is RED on the unmutated copy: fix the suite first'); sys.exit(2)
    caught = 0
    for m in M:
        f, a, b = m[:3]
        want = m[3] if len(m) > 3 else 1
        fresh_tree(work)
        p = os.path.join(work, f)
        src = open(p).read()
        if src.count(a) != want:
            print('ANCHOR MOVED  ' + f + ': ' + a.strip()[:70]); continue
        open(p, 'w').write(src.replace(a, b))
        red = run(work) != 0
        caught += red
        print(('caught  ' if red else 'MISSED  ') + os.path.basename(f) + ': ' + a.strip().splitlines()[0][:70])
    print(f'{caught}/{len(M)} mutations caught')
    sys.exit(0 if caught == len(M) else 1)
finally:
    shutil.rmtree(base, ignore_errors=True)
