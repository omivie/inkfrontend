#!/usr/bin/env python3
"""
RED-PROOF FOR ERR-299 — THE BUILD ON THE BACKEND'S ROUND-2 ANSWER (2026-09-29)
=============================================================================

BF-088/089/090/091/092/093 each retired a frontend workaround. A retirement is a
behaviour change (ERR-158), so every one is pinned, and this proves each pin can
go red: it puts the workaround (or the bug it hid) back, one at a time, and
asserts the suites fail.

It never edits a live file. Every mutation is applied to a COPY in a temp
directory, because several Claude sessions work in this repo at once and a
peer's commit can deploy a half-edited file (ERR-270/272).

Usage:  python3 scripts/redproof-round2-sep2026.py
Exit 0 only if EVERY mutation was caught.
"""
import os, shutil, subprocess, sys, tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
COPY = ['inkcartridges', 'scripts', 'sql', 'tests/helpers', 'package.json', 'errors.md']
TESTS = ['tests/round2-backend-response-sep2026.test.js',
         'tests/best-sellers-sep2026.test.js',
         'tests/admin-analytics-wiring.test.js',
         'tests/four-replies-backend-response-sep2026.test.js',
         'tests/pdp-related-sku-prefix-jul2026.test.js',
         'tests/pdp-related-select-columns-aug2026.test.js',
         'tests/brand-category-menu-sep2026.test.js',
         'tests/product-codes.test.js']
COPY += TESTS

API = 'inkcartridges/js/api.js'
SHOP = 'inkcartridges/js/shop-page.js'
PDP = 'inkcartridges/js/product-detail-page.js'
UTL = 'inkcartridges/js/utils.js'
INK = 'inkcartridges/js/ink-finder.js'
AAPI = 'inkcartridges/js/admin/api.js'
BSU = 'inkcartridges/js/admin/utils/best-sellers.js'
BSP = 'inkcartridges/js/admin/pages/best-sellers.js'
FLT = 'inkcartridges/js/admin/filters.js'
APP = 'inkcartridges/js/admin/app.js'
DSH = 'inkcartridges/js/admin/pages/dashboard.js'

M = [
 # BF-089 — one row per product; the server's facts are mapped
 (BSU, "      soldAs: sale.filter(x => x !== sku),", "      soldAs: [],"),
 (BSU, "      inCatalog: r.pack_type != null,", "      inCatalog: true,"),
 (BSU, "    if (sku) seen.set(sku, (seen.get(sku) || 0) + 1);", ""),
 (BSU, "      brand: r.brand || null,", "      brand: null,"),
 (BSP, "${p.soldAs.length ? `<div class=\"cell-muted\" style=\"font-size:11px\" title=\"Order lines carry the SKU at the time of sale\">sold as ${esc(p.soldAs.join(', '))}</div>` : ''}", ""),
 # BF-090 — a refusal is shown, never read as "no sales"
 (AAPI, "      return { error: res.code === 'VALIDATION_FAILED' && res.message", "      return { items: [], error: res.code === 'VALIDATION_FAILED' && res.message"),
 (AAPI, "        ? resp.details.map(d => d?.message || String(d)).join('; ')", "        ? null"),
 (BSP, "<div class=\"admin-empty__text\">${esc(_data?.error || 'The sales ranking could not be loaded.')}</div>", "<div class=\"admin-empty__text\">The sales ranking could not be loaded.</div>"),
 (DSH, "esc(data?.error || 'Top product data unavailable')", "'Top product data unavailable'"),
 (DSH, "const DASH_CACHE_SCHEMA = 4;", "const DASH_CACHE_SCHEMA = 3;"),
 (BSP, "FilterState.setVisibleFilters(['period', 'brands', 'suppliers', 'statuses', 'categories']);", "FilterState.setVisibleFilters(['period', 'brands']);"),
 (FLT, "if (visible && visible.includes('categories'))", "if (!visible || visible.includes('categories'))"),
 (APP, "    FilterState.setOptions('categories', CATEGORY_OPTIONS);\n", ""),
 (BSU, "  { value: 'CON-INK', label: 'Ink' },", "  { value: 'ink', label: 'Ink' },"),
 # BF-088 — no chip-count read, no manual layer
 (API, "const truncated = this._detectTruncatedChips(primary, params);\n        return this._repairTruncatedSeries",
       "const truncated = this._detectTruncatedChips(primary, params); await fetch('https://x.supabase.co/rest/v1/product_code_chip_counts?select=code').catch(() => null);\n        return this._repairTruncatedSeries"),
 # BF-091 — hide a 0/absent tile directly; a failed request keeps them all
 (SHOP, "                        if (box) box.hidden = true;\n                        continue;", "                        continue;"),
 # a failed request read as "every brand has 0" would hide the whole grid
 (SHOP, "                if (!byBrand || typeof byBrand !== 'object') continue;\n                for (const brandId of chunk) {",
        "                if (!byBrand || typeof byBrand !== 'object') byBrand = Object.fromEntries(chunk.map((b) => [b, {}]));\n                for (const brandId of chunk) {"),
 # BF-092 — the server-resolved rail
 (PDP, "            retail_price: c.retail_price ?? c.sale_price ?? null,", "            retail_price: c.retail_price ?? null,"),
 (PDP, "            brand: typeof c.brand === 'string' ? { name: c.brand } : (c.brand || null),", "            brand: c.brand,"),
 (PDP, "        return { failed: list === null || curated, cards: [] };", "        return { failed: list === null, cards: [] };"),
 (PDP, "                    if (curated.failed) {\n                        fetchFailed = true;", "                    if (curated.failed) {\n                        void 0;"),
 (PDP, "cards: list.filter(c => c && c.sku).map(c => ({", "cards: list.slice().reverse().filter(c => c && c.sku).map(c => ({"),
 # BF-093 — display_name first, the mirror only as the fallback
 (UTL, "        if (typeof p.display_name === 'string' && p.display_name.trim()) return p.display_name.trim();\n", ""),
 (UTL, "            .map((p) => this.of(p))", "            .map((p) => this.display(p.full_name || ''))"),
 (PDP, "            const labelOf = (p) => PrinterName.of(p);", "            const labelOf = (p) => p.full_name;"),
 (PDP, "                    const shown = m.display_name || m.full_name;", "                    const shown = m.full_name;"),
 (PDP, "                let label = p.display_name || p.full_name || p.name", "                let label = p.full_name || p.name"),
 (SHOP, "this.state.printerName = (typeof PrinterName !== 'undefined' && printerData && PrinterName.of(printerData))", "this.state.printerName = (false)"),
 (SHOP, "PrinterName.of(p) : (p.full_name || '')", "p.full_name : (p.full_name || '')"),
 (INK, "            if (d.startsWith(prefix) && d.length > prefix.length) return d.slice(prefix.length);", ""),
 (INK, "                    name: modelLabel(m),", "                    name: m.model_name,"),
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

base = tempfile.mkdtemp(prefix='redproof-round2-')
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
