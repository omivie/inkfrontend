// Live multi-surface check: hits localhost:3000 with a fresh Chromium, walks
// each route to a product, and reports whether the product family appears.
//
// Surfaces tested per product:
//   1. /search?q=<series> via the smart-search page
//   2. /shop?brand=X&category=Y&code=<series> chip drilldown
//   3. /products/<slug>/<sku> direct PDP load (one representative SKU)
//
// We don't need pixel-perfect screenshots — what we want is: does the SKU we
// expect actually appear in the cards container? If not, log it.

import { chromium } from 'playwright';

const TARGETS = [
    {
        label: 'Canon PGI650 series (the user-reported regression)',
        series: 'PGI650',
        chipUrl: '/shop?brand=canon&category=ink&code=PGI650',
        searchQuery: '650',
        expectInChip:    ['CPGI650BK', 'CPGI650KCMY', 'GPGI650BK', 'GPGI650XLBK', 'G-CAN-PGI650XL-INK-VP-2PK'],
        expectInSearch:  ['GPGI650BK', 'CPGI650BK', 'GPGI650XLBK'],
        pdp: { sku: 'CPGI650KCMY', slug: 'pgi650kcmy-compatible-ink-cartridge-for-canon-pgi650-cli651-kcmy-4-pack-300-pages' },
    },
    {
        label: 'HP 02 — mixed singles + KCMY pack',
        series: '02',
        chipUrl: '/shop?brand=hp&category=ink&code=02',
        searchQuery: 'HP 02',
        expectInChip:   ['C02CMY', 'C02KCMY'],
        expectInSearch: ['C02CMY', 'C02KCMY'],
    },
    {
        label: 'Canon CLI671XL — singles + CMY/KCMY packs',
        series: 'CLI671XL',
        chipUrl: '/shop?brand=canon&category=ink&code=CLI671XL',
        searchQuery: 'CLI671XL',
        expectInChip:   ['CCLI671XLBK', 'CCLI671XLCY', 'CCLI671CMY', 'CCLI671KCMY'],
        expectInSearch: ['CCLI671XLBK', 'CCLI671CMY'],
    },
    {
        label: 'Brother LC133 — common Brother family',
        series: 'LC133',
        chipUrl: '/shop?brand=brother&category=ink&code=LC133',
        searchQuery: 'LC133',
        expectInChip:   ['CLC133BK', 'CLC133CY'],
        expectInSearch: ['CLC133BK'],
    },
    {
        label: 'Epson 73N — compatible-only family',
        series: '73N',
        chipUrl: '/shop?brand=epson&category=ink&code=73N',
        searchQuery: '73N',
        expectInChip:   ['C73NBK', 'CT073CMY'],
        expectInSearch: ['C73NBK'],
    },
    {
        label: 'Canon PGI650 — sanity for series=650 short query',
        series: '650-short',
        chipUrl: null,
        searchQuery: '650',
        expectInChip:   [],
        expectInSearch: ['GPGI650BK', 'GPGI650XLBK', 'CPGI650BK'],
    },
];

const BASE = 'http://localhost:3000';

async function getCardSkus(page) {
    return page.evaluate(() => {
        const cards = document.querySelectorAll('.product-card');
        return Array.from(cards).map(c => {
            // Cards expose data-sku, or the link's pathname terminator.
            const sku = c.getAttribute('data-sku')
                || c.getAttribute('data-product-sku')
                || c.querySelector('[data-sku]')?.getAttribute('data-sku');
            if (sku) return sku;
            const a = c.querySelector('a[href*="/products/"], a[href*="/p/"]');
            if (a) {
                const href = a.getAttribute('href');
                const m = href && href.match(/\/(?:products\/[^/]+\/|p\/)([^/?#]+)/);
                if (m) return decodeURIComponent(m[1]);
            }
            // Fallback: the visible name often starts with the SKU on
            // compatible cards (e.g. "PGI650KCMY Compatible Ink…").
            const title = c.querySelector('.product-card__title')?.textContent?.trim();
            return title ? title.split(/\s+/)[0] : null;
        }).filter(Boolean);
    });
}

async function waitForCardsOrEmpty(page) {
    // Wait until either at least one product card renders OR the empty state
    // shows, whichever comes first. 8s ceiling.
    await page.waitForFunction(() => {
        if (document.querySelectorAll('.product-card').length > 0) return true;
        const empty = document.getElementById('drilldown-empty');
        if (empty && !empty.hidden) return true;
        const recovery = document.getElementById('search-recovery');
        if (recovery) return true;
        return false;
    }, { timeout: 8000 }).catch(() => null);
    // Tiny settle so card-bind events finish (no specific signal exposed).
    await page.waitForTimeout(250);
}

const report = [];

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
const page = await ctx.newPage();

for (const t of TARGETS) {
    const outcome = { label: t.label, series: t.series, surfaces: {} };

    if (t.searchQuery) {
        await page.goto(`${BASE}/search?q=${encodeURIComponent(t.searchQuery)}`, { waitUntil: 'load' });
        await waitForCardsOrEmpty(page);
        const skus = await getCardSkus(page);
        const skuSet = new Set(skus.map(s => s.toUpperCase()));
        const found = t.expectInSearch.filter(s => {
            const u = s.toUpperCase();
            return skuSet.has(u) || skus.some(x => x.toUpperCase().startsWith(u));
        });
        const missing = t.expectInSearch.filter(s => !found.includes(s));
        outcome.surfaces.search = {
            url: `/search?q=${t.searchQuery}`,
            cards: skus.length,
            found,
            missing,
            sample: skus.slice(0, 6),
        };
    }

    if (t.chipUrl) {
        await page.goto(`${BASE}${t.chipUrl}`, { waitUntil: 'load' });
        await waitForCardsOrEmpty(page);
        const skus = await getCardSkus(page);
        const skuSet = new Set(skus.map(s => s.toUpperCase()));
        const found = t.expectInChip.filter(s => {
            const u = s.toUpperCase();
            return skuSet.has(u) || skus.some(x => x.toUpperCase().startsWith(u));
        });
        const missing = t.expectInChip.filter(s => !found.includes(s));
        outcome.surfaces.chip = {
            url: t.chipUrl,
            cards: skus.length,
            found,
            missing,
            sample: skus.slice(0, 6),
        };
    }

    if (t.pdp) {
        const url = `${BASE}/products/${t.pdp.slug}/${t.pdp.sku}`;
        await page.goto(url, { waitUntil: 'load' });
        const sku = await page.evaluate(() => {
            const el = document.querySelector('[data-product-sku], [data-sku], .product-detail__sku, h1');
            return el ? el.textContent.trim().slice(0, 80) : null;
        });
        outcome.surfaces.pdp = { url: `/products/${t.pdp.slug}/${t.pdp.sku}`, sku };
    }

    report.push(outcome);
}

await browser.close();

// Final report
let pass = 0, fail = 0;
for (const r of report) {
    console.log(`\n=== ${r.label} ===`);
    for (const [k, v] of Object.entries(r.surfaces)) {
        if (v.missing && v.missing.length > 0) {
            fail++;
            console.log(`  [MISS] ${k.padEnd(6)} ${v.url} — cards=${v.cards} missing=${v.missing.join(', ')}`);
            console.log(`         sample: ${(v.sample || []).join(', ')}`);
        } else if (v.found) {
            pass++;
            console.log(`  [OK]   ${k.padEnd(6)} ${v.url} — cards=${v.cards} found=${v.found.join(', ')}`);
        } else if (v.sku) {
            pass++;
            console.log(`  [OK]   ${k.padEnd(6)} ${v.url} — pdp loaded: ${v.sku}`);
        }
    }
}

console.log(`\n========== SUMMARY: ${pass} passed, ${fail} missed ==========`);
process.exit(fail === 0 ? 0 : 1);
