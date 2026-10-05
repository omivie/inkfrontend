#!/usr/bin/env python3
"""Red-proof for tests/checkout-funnel-oct2026.test.js (ERR-305).

Each mutation re-introduces one defect the backend's §8 walk found (or a
safety rule the fix depends on). The suite must go RED for every one. Works on
a temporary copy of the repo, so the working tree (shared with other sessions)
is never touched.
Run: python3 scripts/redproof-checkout-funnel-oct2026.py
"""
import os, shutil, subprocess, sys, tempfile

C = 'inkcartridges/js/cart.js'
CO = 'inkcartridges/js/checkout-page.js'
P = 'inkcartridges/js/payment-page.js'
W = 'inkcartridges/js/cart-wallet.js'
MUTATIONS = [
 # §8.3 cart: one figure, inside the total
 (C, "label: s.is_shipping_estimate === false ? 'Total' : 'Estimated total',", "label: 'Total before shipping',"),
 (C, "        if (!(ship > 0)) return fallback;\n", "        if (!(ship >= 0)) return fallback;\n"),
 (C, "        if (rowEl) rowEl.dataset.totalSource = model.source;", "        if (rowEl) rowEl.dataset.totalSource = 'server';"),
 (C, "        return money(ship) + (tStr ? ' · free over ' + tStr : '');", "        return 'From ' + money(ship) + (tStr ? ' · free over ' + tStr : '');"),
 # §8.3 checkout: no local $12 first
 (CO, "            if (!region && !postalCode) {", "            if (false) {"),
 (CO, "                        ...(postalCode ? { postal_code: postalCode } : {}),\n", ""),
 (CO, "            this._shippingSource = 'local-fallback';", "            this._shippingSource = 'server';"),
 (CO, "            if (this._shippingSource === 'server' || this._shippingSource === 'local-fallback') return;\n", ""),
 # item 6 cart half
 (C, "            box.dataset.points = n === null ? 'absent' : 'zero';", "            box.dataset.points = '0';"),
 # §8.1 click
 (C, "    CHECKOUT_VALIDATE_CAP_MS: 700,", "    CHECKOUT_VALIDATE_CAP_MS: 1500,"),
 (C, "            const response = await API.validateCart(null, acknowledgePriceChanges);", "            const response = await API.validateCart(await Auth.getTurnstileToken(), acknowledgePriceChanges);"),
 (C, "            if (checkoutLink.getAttribute('aria-busy') === 'true') return;\n", ""),
 (P, "            payBtn.disabled = !this.paymentElementReady;", "            payBtn.disabled = !(this.paymentElementReady && (!this.isGuestCheckout || this.turnstileToken));"),
 (P, "                waiters.forEach((resolve) => resolve(this.turnstileToken));", ""),
 ('inkcartridges/css/pages.css', '    .cart-sticky-bar { display: block; }\n    .cart-sticky-bar__inner', '    .cart-sticky-bar { display: none; }\n    .cart-sticky-bar__inner'),
 # §8.4 ticks
 ('inkcartridges/html/payment.html', '<p class="pay-terms" id="pay-terms"', '<p class="pay-terms" id="pay-terms-x"'),
 # §8.5
 (P, "            if (label && label.toLowerCase() !== city.toLowerCase()) parts.push(label);", "            if (slug) parts.push(slug);"),
 ('inkcartridges/js/api.js', 'async nzpostSuggest(query, max = 8)', 'async nzpostSuggest(query, max = 5)'),
 # item 2 wallet: off, never guess, one order path
 ('inkcartridges/js/config.js', 'cartWallet: false,', 'cartWallet: true,'),
 (W, "        return this.REGIONS.includes(slug) ? slug : '';", "        return this.REGIONS.includes(slug) ? slug : 'auckland';"),
 (W, "                saveAddress: false,", "                saveAddress: true,"),
 (P, "        if (!document.getElementById('payment-form')) return;\n", ""),
]
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
TEST = 'tests/checkout-funnel-oct2026.test.js'

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
