#!/usr/bin/env python3
"""Red-proof for tests/ad-clicks-to-orders-oct2026.test.js (ERR-302).

Each mutation re-introduces one defect the suite claims to catch. The suite
must go RED for every one. Works on a temporary copy of the repo, so the
working tree (shared with other sessions) is never touched.
Run: python3 scripts/redproof-ad-clicks-to-orders.py
"""
import os, shutil, subprocess, sys, tempfile

MUTATIONS = [
 # §7 remarketing
 ("inkcartridges/js/gtag.js", "gtag('event', name, { send_to: ADS.TAG_ID, items });", "gtag('event', name, { items });"),
 ("inkcartridges/js/gtag.js", "const id = typeof raw === 'string' ? raw.trim() : '';", "const id = typeof raw === 'string' ? raw.trim().toUpperCase() : '';"),
 ("inkcartridges/js/gtag.js", "if (!items.length) return { sent: false, reason: 'no-sku' };", ""),
 ("inkcartridges/js/gtag.js", "            AdsRemarketing.event('add_to_cart', [sku]);\n", ""),
 ("inkcartridges/js/order-confirmation-page.js", "if (typeof AdsRemarketing !== 'undefined') AdsRemarketing.event('purchase', order.items);", ""),
 ("inkcartridges/js/order-confirmation-page.js", "if (adsItems.length) conversion.items = adsItems;", ""),
 ("inkcartridges/js/product-detail-page.js", "AdsRemarketing.event('view_item', [this.product]);", ""),
 # §6 reviews link
 ("inkcartridges/js/utils.js", "return u.protocol === 'https:' && okHost", "return okHost"),
 ("inkcartridges/js/utils.js", "/^(www\\.|maps\\.|search\\.)?google\\.(com|co\\.nz)$/", "/google\\./"),
 ("inkcartridges/js/footer.js", "      el.dataset.reviewsLink = 'absent';\n", ""),
 ("inkcartridges/js/footer.js", "    renderGoogleReviewsLink();\n", ""),
 ("inkcartridges/js/footer.js", 'rel="noopener noreferrer">See our reviews on Google', '>See our reviews on Google'),
 # §4 cart reminder
 ("inkcartridges/html/cart.html", 'id="cart-guest-email-consent" name="cart-guest-email-consent">', 'id="cart-guest-email-consent" name="cart-guest-email-consent" checked>'),
 ("inkcartridges/js/cart.js", "        box.checked = false;\n        root.hidden = false;", "        root.hidden = false;"),
 ("inkcartridges/js/cart.js", "                if (!sentFor) { say(''); return; }\n", ""),
 # BF-099: untick withdraws; failure stays loud; events serialize
 ("inkcartridges/js/cart.js", "const resp = await API.withdrawGuestContact();", "const resp = { ok: true };"),
 ("inkcartridges/js/cart.js", "                if (ok) sentFor = null;\n", "                sentFor = null;\n"),
 ("inkcartridges/js/cart.js", "say(ok ? this.WITHDRAWN_COPY : this.WITHDRAW_FAILED_COPY);", "say(this.WITHDRAWN_COPY);"),
 ("inkcartridges/js/cart.js", "            const run = () => sync(ticked, value, valid);", "            const run = () => sync(box.checked, (email.value || '').trim(), email.checkValidity());"),
 ("inkcartridges/js/api.js", "{ guest_session_id: guestSessionId, consent: false }", "{ guest_session_id: guestSessionId, consent: false, email: '' }"),
 ("inkcartridges/js/cart.js", "            if (!ok) sentFor = null;\n", ""),
 ("inkcartridges/js/cart.js", "                return { bound: false, reason: 'signed-in' };", "                this._wire(root, box, email, status || null); return { bound: false, reason: 'signed-in' };"),
 ("inkcartridges/js/cart.js", "                ok = !!(resp && resp.ok);\n            } catch (_) { ok = false; }", "                ok = !!(resp && resp.ok);\n            } catch (_) { ok = true; }"),
 ("inkcartridges/js/cart-page.js", "        GuestCartEmail.bind({", "        void ({"),
 ("inkcartridges/js/checkout-page.js", "            GuestCartEmail.bind({", "            void ({"),
]
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
TEST = 'tests/ad-clicks-to-orders-oct2026.test.js'

def run(tree):
    return subprocess.run(['node', '--test', TEST], cwd=tree, capture_output=True, text=True).returncode

tmp = tempfile.mkdtemp()
tree = os.path.join(tmp, 'repo')
shutil.copytree(ROOT, tree, ignore=shutil.ignore_patterns('node_modules', '.git', '.playwright-mcp'))
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
