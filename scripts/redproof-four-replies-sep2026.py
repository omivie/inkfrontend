#!/usr/bin/env python3
"""
RED-PROOF FOR ERR-294 — THE BUILD ON THE BACKEND'S ANSWER TO OUR FOUR 2026-09-28 REPLIES
======================================================================================

A green suite is only worth what its ability to go red is worth (ERR-258). This
undoes each change one at a time — putting back the exact text the fix replaced
where there was one — and asserts that the suite goes red on every undo.

It never edits a live file. Every mutation is applied to a COPY in a temp
directory, because several Claude sessions work in this repo at once and a
peer's commit can deploy a half-edited file (ERR-270/272).

Usage:  python3 scripts/redproof-four-replies-sep2026.py
Exit 0 only if EVERY mutation was caught.
"""
import os, shutil, subprocess, sys, tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
# The six suites read across the web root, scripts/ and sql/ (backend-move §0
# scans every file for the old host), so the copy is the whole of each.
COPY = ['inkcartridges', 'scripts', 'sql', 'tests/helpers', 'package.json', 'errors.md']
TESTS = ['tests/four-replies-backend-response-sep2026.test.js',
         'tests/backend-move-sep2026.test.js',
         'tests/product-codes.test.js',
         'tests/conversion-fixes-sep2026.test.js',
         'tests/post-deploy-fixes-sep2026.test.js',
         'tests/for-use-in-cutover-sep2026.test.js']
COPY += TESTS

PDP = 'inkcartridges/js/product-detail-page.js'
API = 'inkcartridges/js/api.js'
SHOP = 'inkcartridges/js/shop-page.js'
SEO = 'inkcartridges/js/seo-meta.js'
UTL = 'inkcartridges/js/utils.js'
IMP = 'inkcartridges/js/admin/utils/importStatus.js'
GIA = 'inkcartridges/js/admin/pages/genuine-image-audit.js'
VJ = 'inkcartridges/vercel.json'
RIB = 'inkcartridges/html/ribbons.html'
SHH = 'inkcartridges/html/shop.html'

M = [
 # §A — the retired reads stay retired
 # (ERR-299 deleted the manual layer; the mutant re-adds a read to the hook.)
 (API, "const truncated = this._detectTruncatedChips(primary, params);\n        return this._repairTruncatedSeries",
       "const truncated = this._detectTruncatedChips(primary, params); await fetch('https://x.supabase.co/rest/v1/product_code_visitors?select=code').catch(() => null);\n        return this._repairTruncatedSeries"),
 (PDP, "                    if (typeof DebugLog !== 'undefined' && DebugLog.warn) {\n                        DebugLog.warn('[PDP] product row lacks",
       "                    if (false) {\n                        DebugLog.warn('[PDP] product row lacks"),
 # §B
 (SHH, "<!-- The two sources sit SIDE BY SIDE", "<div id=\"color-packs-section\"></div><!-- The two sources sit SIDE BY SIDE"),
 # §C
 (PDP, "this._forUseInPromise = this._fetchForUseIn(this.product.sku || sku);", "this._forUseInPromise = this._fetchForUseIn(sku);"),
 (PDP, "if (out.failed && !out.final) out = await ask();", "if (out.failed) out = await ask();"),
 # §D
 (SHOP, "                    if (key) {\n                        const n = counts[key];", "                    if (false) {\n                        const n = counts[key];"),
 (SHOP, "                        if (box) box.hidden = true;\n                        continue;", "                        continue;"),
 # ERR-299: the confirming read is retired — putting it back must go red.
 (SHOP, "                        if (box) box.hidden = true;\n                        continue;",
        "                        API.getCategoryTotal(brandId, cat.apiCategory);\n                        if (box) box.hidden = true;\n                        continue;"),
 # §E
 (SEO, "if ((surface === 'printer' || codePage) && head.h1) {", "if (false) {"),   # anchor widened by ERR-300 (code pages), re-pointed 2026-10-06
 (SEO, "PRERENDER_CACHE_PREFIX: 'ic_seo_pr_v2:',", "PRERENDER_CACHE_PREFIX: 'ic_seo_pr_v1:',"),
 (SHOP, "this.elements.title.textContent = mirrored || name || 'Compatible Ink & Toner';", "this.elements.title.textContent = name || 'Compatible Ink & Toner';"),
 (SHOP, "this.state.printerName = (typeof PrinterName !== 'undefined' && printerData && PrinterName.of(printerData))",
        "this.state.printerName = (false)"),
 # §F
 (SHOP, "if (alias) products = alias.rows;", ""),
 (SHOP, "&& !smartData?.did_you_mean\n                        && !alias;", "&& !smartData?.did_you_mean;"),
 (SHOP, "${Security.escapeHtml(alias.note)}", "${alias.note}"),
 # §G
 (VJ, '"has": [{ "type": "query", "key": "search" }],', '"has": [{ "type": "query", "key": "zzsearch" }],'),
 (VJ, '{ "source": "/([^/]+)-toner-cartridge-([^/]+)", "destination": "/shop?search=$1+$2", "permanent": true }',
      '{ "source": "/([^/]+)-toner-cartridge-([^/]+)", "destination": "/shop?search=$2", "permanent": true }'),
 (SHOP, "if ((brand && category && code) || this.state.level === 'search-results') {", "if (brand && category && code) {"),
 # §H
 # (the casing-mirror mutations went with the mirror, 2026-10-06 BF-094)
 (PDP, "PrinterName.withoutBrand(cleaned, group.brand)", "cleaned"),
 (PDP, "const showModel = info.manufacturer_part_number && info.source !== 'compatible';", "const showModel = info.manufacturer_part_number;"),
 # §I
 (SHOP, "            .replace(/^(compatible|genuine|original)\\s+/i, '');", "            ;"),
 (SHOP, "this.elements.compatibleTitleText.textContent = sectionTitleText(`${brandName} ${productType}`);",
        "this.elements.compatibleTitleText.textContent = `${brandName} Compatible ${productType}`;"),
 (RIB, "Choose your ribbon brand</h2>", "Typewriter &amp; Printer Ribbons</h2>"),
 # §J
 (IMP, "${r.status === 'failed' ? `<div class=\"cc2-infra__runreason\">${esc(failureReason(r) || 'No reason recorded.')}</div>` : ''}", ""),
 (IMP, "reasons.push(why ? `The latest run failed: ${why}` : 'The latest run failed, and it recorded no reason.');", "reasons.push('The latest run failed.');"),
 (GIA, "(b.slug || b.id || '')", "(b.slug || b.name || '')"),
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
        print('\n'.join(l for l in (r.stdout + r.stderr).splitlines() if 'Error' in l or '✖' in l)[:3000])
    return r.returncode

base = tempfile.mkdtemp(prefix='redproof-four-replies-')
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
