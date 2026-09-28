#!/usr/bin/env python3
"""
Red-proof for tests/post-deploy-fixes-sep2026.test.js (backend post-deploy
check 2026-09-28, ERR-293). Each entry breaks ONE shipped behaviour in a COPY
of the tree, runs the suite, and restores it — a guard that stays green under
its own mutation cannot fail (ERR-258).

    python3 scripts/redproof-post-deploy-fixes.py      # expect: caught N, missed 0

Never edits a live file: every mutation is applied to a COPY of inkcartridges/
and tests/ in a temp directory, which is deleted afterwards.
"""
import os, shutil, subprocess, sys, tempfile
M = [
 # §1 /review
 ("inkcartridges/js/config.js", "        guestReviews: true,", "        guestReviews: false,"),
 ("inkcartridges/js/review-page.js", "return d && d.already_existed === true", "return d && d.already_existed === 'never'"),
 ("inkcartridges/js/review-page.js", "/^https:\\/\\//.test(item.image_url)", "/./.test(item.image_url)"),
 ("inkcartridges/js/review-page.js", "src=\"${Security.escapeAttr(item.image_url)}\"", "src=\"${item.image_url}\""),
 ("inkcartridges/js/review-page.js", "if (!on) {", "if (false) {"),
 ("inkcartridges/js/review-page.js", "        const heading = data.order_number\n", "        const heading = false\n"),
 # §2 PDP desktop
 ("inkcartridges/js/product-detail-page.js", "info && info.source === 'compatible'\n", "info\n"),
 ("inkcartridges/js/product-detail-page.js", "${more > 0 ? ` +${more} more` : ''}`", "`"),
 ("inkcartridges/js/product-detail-page.js", "if (strip) strip.hidden = !strip.querySelector('.product-headline__line:not([hidden])');", ""),
 ("inkcartridges/js/product-detail-page.js", "const entry = ladder && ladder.entry;", "const entry = ladder && ladder.best;"),
 ("inkcartridges/js/product-detail-page.js", "if (!label || !Number.isFinite(entry.businessPrice))", "if (!label)"),
 ("inkcartridges/js/product-detail-page.js", "            this.renderVolumeSummary(null);   // never carry a previous product's line\n", ""),
 ("inkcartridges/js/product-detail-page.js", "{ el.hidden = true; el.innerHTML = ''; this._setHeadline('product-headline-fit', ''); return; }", "{ el.hidden = true; el.innerHTML = ''; return; }"),
 ("inkcartridges/css/pages.css", "    .product-info > #compat-disclaimer,\n    .product-info > #volume-pricing {\n        order: 1;", "    .product-info > #compat-disclaimer,\n    .product-info > #volume-pricing {\n        order: 0;"),
 ("inkcartridges/css/pages.css", ".product-headline,\n.volume-pricing-summary { display: none; }", ""),
 ("inkcartridges/css/pages.css", "    #product-fit .product-fit__summary { display: none; }\n", ""),
 # §3 card +N
 ("inkcartridges/js/utils.js", "const rest = Math.max(Number.isFinite(count) ? count : 0, names.length) - shown.length;", "const rest = names.length - shown.length;"),
 ("inkcartridges/js/utils.js", "const rest = Math.max(Number.isFinite(count) ? count : 0, names.length) - shown.length;", "const rest = (Number.isFinite(count) ? count : names.length) - names.length;"),
 ("inkcartridges/js/shop-page.js", "PrinterName.fitsLine(product.compatible_printers, product.compatible_printers_count)", "PrinterName.fitsLine(product.compatible_printers)"),
 ("inkcartridges/js/products.js", "PrinterName.fitsLine(product.compatible_printers, product.compatible_printers_count)", "PrinterName.fitsLine(product.compatible_printers)"),
 # §4 countdown scope
 ("inkcartridges/js/utils.js", "for same-day dispatch${this.scope(deliveryEstimate)}`;", "for same-day dispatch`;"),
 ("inkcartridges/js/utils.js", "/auckland metro/i.test(promise) ? ' (Auckland metro)' : '';", "true ? ' (Auckland metro)' : '';"),
]
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
TEST = 'tests/post-deploy-fixes-sep2026.test.js'

def run_in(tmp):
    r = subprocess.run(["node", "--test", TEST], cwd=tmp, capture_output=True, text=True)
    return "ℹ fail 0" in r.stdout

tmp = tempfile.mkdtemp(prefix="redproof-postdeploy-")
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
