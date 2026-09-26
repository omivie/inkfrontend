#!/usr/bin/env python3
"""
Red-proof for tests/conversion-fixes-sep2026.test.js (conversion handoff
2026-09-23 / 2026-09-27). Each entry breaks ONE shipped behaviour in the real
file, runs the suite, and restores the file in a `finally` — a guard that
stays green under its own mutation cannot fail (ERR-258).

    python3 scripts/redproof-conversion-fixes.py      # expect: caught N, missed 0

Never edits a live file: every mutation is applied to a COPY of inkcartridges/
and tests/ in a temp directory, which is deleted afterwards.
"""
import os, shutil, subprocess, sys, tempfile
M = [
 ("inkcartridges/middleware.js", "      redirect: 'manual',\n", ""),
 ("inkcartridges/middleware.js", "if (response.status >= 300 && response.status < 400)", "if (false)"),
 ("inkcartridges/middleware.js", "else if ([...url.searchParams.keys()].length === 0) prerenderPath = '/api/prerender/shop';", ""),
 ("inkcartridges/middleware.js", "const target = new URL(location, url);", "const target = new URL(location, BACKEND);"),
 ("inkcartridges/js/utils.js", "const points = Math.floor((cents * loyalty.pointsPerDollar) / 100);", "const points = Math.round((cents * loyalty.pointsPerDollar) / 100);"),
 ("inkcartridges/js/utils.js", "return sec && typeof sec === 'object' && sec.active === true ? sec : null;", "return sec && typeof sec === 'object' ? sec : null;"),
 ("inkcartridges/js/utils.js", "        else target.hidden = true;", ""),
 ("inkcartridges/js/utils.js", "        OFFICEJET: 'OfficeJet',", ""),
 ("inkcartridges/js/product-detail-page.js", "            if (eligible === false) {", "            if (eligible !== true) {"),
 ("inkcartridges/js/product-detail-page.js", "const unit = rung ? rung.businessPrice : this._unitPrice;", "const unit = this._unitPrice;"),
 ("inkcartridges/js/cart.js", "        if (!(ship > 0)) return 'Calculated at checkout';", "        if (!(ship >= 0)) return 'Calculated at checkout';"),
 ("inkcartridges/js/cart.js", "            if (!window.matchMedia(`(min-width: ${tablet}px)`).matches) return;", ""),
 ("inkcartridges/js/checkout-page.js", "                a.target = '_blank';", ""),
 ("inkcartridges/js/shop-page.js", "const shelf = list.filter(hasImg).slice(0, this.POPULAR_ROW_LIMIT);", "const shelf = list.slice(0, this.POPULAR_ROW_LIMIT);"),
 ("inkcartridges/js/shop-page.js", "if (p === '/toner-cartridges') return 'Toner Cartridges NZ — Genuine & Compatible';", ""),
 ("inkcartridges/js/pdp-prefetch.js", "if (params.get('printer_slug')) return null;", ""),
 ("inkcartridges/js/pdp-prefetch.js", "? 'https://api.inkcartridges.co.nz'", "? 'https://www.inkcartridges.co.nz'"),
 ("inkcartridges/js/value-pages.js", ".map(t => `${Number(t.min_quantity)}+ ${pct(Number(t.discount_percent))} off`)", ".map(t => `${Number(t.min_quantity)}+ —`)"),
 ("inkcartridges/js/config.js", "        guestCartEmail: false,", "        guestCartEmail: true,"),
 ("inkcartridges/js/review-page.js", "if (!Number.isInteger(r) || r < 1 || r > 5)", "if (!Number.isInteger(r) || r < 1)"),
 ("inkcartridges/html/checkout.html", "Human support Mon–Fri, 9am–5pm", "Human support 8am–8pm, 7 days"),
 ("inkcartridges/css/layout.css", "    min-height: 32px;\n    background: var(--cyan-light);", "    position: fixed;\n    min-height: 32px;\n    background: var(--cyan-light);"),
 ("inkcartridges/js/main.js", "        if (header.matches(':focus-within')) return false;\n", ""),
 ("inkcartridges/js/business.js", "${Security.escapeHtml(this.breakLabel(entry))} price</span>", "Bulk price</span>"),
]
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
TEST = 'tests/conversion-fixes-sep2026.test.js'

def run_in(tmp):
    r = subprocess.run(["node", "--test", TEST], cwd=tmp, capture_output=True, text=True)
    return "ℹ fail 0" in r.stdout

tmp = tempfile.mkdtemp(prefix="redproof-conv-")
try:
    # A COPY of what the suite reads — never the live tree (ERR-270/272: a
    # peer's commit can deploy a half-edited file).
    shutil.copytree(os.path.join(ROOT, "inkcartridges"), os.path.join(tmp, "inkcartridges"),
                    ignore=shutil.ignore_patterns("node_modules", "assets"))
    shutil.copytree(os.path.join(ROOT, "tests"), os.path.join(tmp, "tests"))
    assert run_in(tmp), "the suite must be GREEN on the unmutated copy first"
    caught = 0; missed = []
    for f, old, new in M:
        p = os.path.join(tmp, f)
        src = open(p).read()
        if src.count(old) != 1:
            missed.append((f, "NOT FOUND ONCE: " + old[:50])); continue
        open(p, "w").write(src.replace(old, new))
        try:
            red = not run_in(tmp)
        finally:
            open(p, "w").write(src)
        if red: caught += 1
        else: missed.append((f, old[:60]))
    print(f"caught {caught}, missed {len(missed)}")
    for m in missed: print("MISSED", m)
    sys.exit(1 if missed else 0)
finally:
    shutil.rmtree(tmp, ignore_errors=True)
