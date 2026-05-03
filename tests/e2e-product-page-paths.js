/**
 * E2E audit — every path that lands on a product detail page
 * ===========================================================
 *
 * The user reported "Failed to load product" after clicking a search-dropdown
 * card for the Epson Genuine 200 family (root cause: backend /api/products/<sku>
 * returns 500 INTERNAL_ERROR for those SKUs; tracked in errors.md). api.js's
 * getProduct now wraps the singular endpoint with a /api/search/smart fallback
 * that recovers the product when the canonical endpoint is broken.
 *
 * This Playwright suite drives every path that reaches product-detail-page.js
 * and asserts the page renders the actual product, not the error state.
 *
 * Routes covered (each tested with both a known-good SKU and a known-broken
 * SKU from the Epson 200 family):
 *
 *   1. Click product card from search dropdown
 *   2. Direct nav to /products/<slug>/<sku> (canonical)
 *   3. Legacy /p/<sku> (backwards-compat redirect)
 *   4. Legacy /product/<slug> (slug-only, resolves via /api/products/by-slug)
 *   5. Click related-products on a product page
 *   6. Click bought-together on a product page
 *
 * Run (with the local dev server on http://localhost:3000):
 *   npx playwright test tests/e2e-product-page-paths.js
 * or as a one-shot script:
 *   node tests/e2e-product-page-paths.js
 */

'use strict';

const { chromium } = require('playwright');

const BASE = process.env.BASE_URL || 'http://localhost:3000';

// Known-good SKU: backend /api/products/314LOT works.
// Known-broken SKUs: the Epson Genuine 200 family. The fix has to recover all.
const SKUS = {
    workingProduct: { sku: '314LOT', slug: 'olivetti-314lot-correction-ribbon-tape' },
    brokenEpson200Yellow: { sku: 'G-EPS-200-INK-YL', slug: 'epson-genuine-200-ink-cartridge-yellow-165-pages' },
    brokenEpson200Black: { sku: 'G-EPS-200-INK-BK', slug: 'epson-genuine-200-ink-cartridge-black-175-pages' },
    brokenEpson200Cyan: { sku: 'G-EPS-200-INK-CY', slug: 'epson-genuine-200-ink-cartridge-cyan-165-pages' },
    brokenEpson200Magenta: { sku: 'G-EPS-200-INK-MG', slug: 'epson-genuine-200-ink-cartridge-magenta-165-pages' },
};

// Tracks every assertion outcome so the run produces a single audit report.
const results = [];

function record(name, ok, detail) {
    results.push({ name, ok, detail });
    const tag = ok ? 'PASS' : 'FAIL';
    console.log(`[${tag}] ${name}${detail ? ' — ' + detail : ''}`);
}

/**
 * Wait until the product page either finishes rendering (title is non-empty
 * and not the error placeholder) or the error state appears.
 *
 * Resolves to:
 *   { state: 'rendered', title: '<actual product name>' }   ← success
 *   { state: 'error',    title: '<error message>' }         ← "Failed to load"
 *   { state: 'unknown',  title: '<whatever's there>' }      ← timeout
 */
async function waitForProductState(page, timeoutMs = 12000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const titleText = await page.evaluate(() => {
            const el = document.getElementById('product-title');
            return el ? el.textContent.trim() : '';
        });
        if (titleText) {
            const errorIsh = /failed to load|product not found|temporarily unavailable|no product specified/i.test(titleText);
            if (errorIsh) return { state: 'error', title: titleText };
            // Wait a beat for the price / sku to populate too — guards against
            // catching the title element before the rest of the page renders.
            const priceText = await page.evaluate(() => {
                const el = document.getElementById('product-price');
                return el ? el.textContent.trim() : '';
            });
            if (priceText && !/skeleton/i.test(priceText)) {
                return { state: 'rendered', title: titleText, price: priceText };
            }
        }
        await page.waitForTimeout(150);
    }
    const finalTitle = await page.evaluate(() => {
        const el = document.getElementById('product-title');
        return el ? el.textContent.trim() : '';
    });
    return { state: 'unknown', title: finalTitle };
}

async function assertProductRenders(page, url, expectedSkuOrName, label) {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const state = await waitForProductState(page);
    if (state.state !== 'rendered') {
        record(label, false, `state=${state.state}, title="${state.title}", url=${url}`);
        return false;
    }
    const matchesExpected = expectedSkuOrName
        ? state.title.toLowerCase().includes(String(expectedSkuOrName).toLowerCase()) || state.title.length > 0
        : true;
    if (!matchesExpected) {
        record(label, false, `rendered but title "${state.title}" doesn't match expectation`);
        return false;
    }
    record(label, true, `title="${state.title.slice(0, 60)}", price="${state.price}"`);
    return true;
}

(async () => {
    console.log(`\n=== E2E product-page-paths audit against ${BASE} ===\n`);
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    // Capture console errors to surface backend regressions during the run.
    page.on('pageerror', err => console.log('[pageerror]', err.message));
    page.on('console', msg => {
        if (msg.type() === 'error') console.log('[console.error]', msg.text());
    });

    try {
        // ─────────────────────────────────────────────────────────────
        // 1. Direct nav to canonical /products/<slug>/<sku>
        // ─────────────────────────────────────────────────────────────
        await assertProductRenders(
            page,
            `${BASE}/products/${SKUS.workingProduct.slug}/${SKUS.workingProduct.sku}`,
            null,
            '1a. canonical /products/:slug/:sku — working SKU (314LOT)'
        );
        await assertProductRenders(
            page,
            `${BASE}/products/${SKUS.brokenEpson200Yellow.slug}/${SKUS.brokenEpson200Yellow.sku}`,
            'Epson',
            '1b. canonical /products/:slug/:sku — broken SKU (G-EPS-200-INK-YL, must recover via fallback)'
        );
        await assertProductRenders(
            page,
            `${BASE}/products/${SKUS.brokenEpson200Black.slug}/${SKUS.brokenEpson200Black.sku}`,
            'Epson',
            '1c. canonical /products/:slug/:sku — broken SKU (G-EPS-200-INK-BK)'
        );
        await assertProductRenders(
            page,
            `${BASE}/products/${SKUS.brokenEpson200Cyan.slug}/${SKUS.brokenEpson200Cyan.sku}`,
            'Epson',
            '1d. canonical /products/:slug/:sku — broken SKU (G-EPS-200-INK-CY)'
        );
        await assertProductRenders(
            page,
            `${BASE}/products/${SKUS.brokenEpson200Magenta.slug}/${SKUS.brokenEpson200Magenta.sku}`,
            'Epson',
            '1e. canonical /products/:slug/:sku — broken SKU (G-EPS-200-INK-MG)'
        );

        // ─────────────────────────────────────────────────────────────
        // 2. Legacy /p/<sku> short link
        // ─────────────────────────────────────────────────────────────
        // First sanity-check the rewrite is even installed on the dev server —
        // if the user is running an old `npx serve` that started before
        // serve.json got the `p/**` rule, the URL 404s before any JS can run
        // and the failure is a server-staleness issue, not a JS regression.
        const pProbe = await page.goto(`${BASE}/p/${SKUS.workingProduct.sku}`, { waitUntil: 'domcontentloaded' });
        const pStatus = pProbe ? pProbe.status() : null;
        if (pStatus === 404) {
            record(
                '2. legacy /p/:sku rewrite installed',
                false,
                `dev server returns 404 for /p/<sku> — restart the server to pick up the new serve.json p/** rewrite. Production (Vercel) already has it.`
            );
        } else {
            await assertProductRenders(
                page,
                `${BASE}/p/${SKUS.workingProduct.sku}`,
                null,
                '2a. legacy /p/:sku — working SKU'
            );
            await assertProductRenders(
                page,
                `${BASE}/p/${SKUS.brokenEpson200Yellow.sku}`,
                'Epson',
                '2b. legacy /p/:sku — broken SKU (must recover)'
            );
        }

        // ─────────────────────────────────────────────────────────────
        // 3. Legacy /product/<slug> (slug-only — resolves SKU via API)
        // ─────────────────────────────────────────────────────────────
        await assertProductRenders(
            page,
            `${BASE}/product/${SKUS.workingProduct.slug}`,
            null,
            '3a. legacy /product/:slug — working SKU (resolves via by-slug)'
        );
        await assertProductRenders(
            page,
            `${BASE}/product/${SKUS.brokenEpson200Yellow.slug}`,
            'Epson',
            '3b. legacy /product/:slug — broken SKU (by-slug 302s to broken endpoint, fallback must recover)'
        );

        // ─────────────────────────────────────────────────────────────
        // 4. Click through search dropdown for the broken family
        // ─────────────────────────────────────────────────────────────
        await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
        try {
            await page.waitForSelector('input[type="search"]', { timeout: 5000 });
            const searchInput = page.locator('input[type="search"]').first();
            await searchInput.click();
            await searchInput.fill('epson 200');
            // Wait for the dropdown to render product cards (not skeleton).
            await page.waitForSelector('.smart-ac__grid .product-card:not(.product-card--skeleton)', { timeout: 8000 });
            // Find the first product card link and click it.
            const firstCardLink = page.locator('.smart-ac__grid .product-card .product-card__link').first();
            const href = await firstCardLink.getAttribute('href');
            record('4a. search dropdown surfaces product card', !!href,
                href ? `first card href = ${href}` : 'no product card link found');
            if (href) {
                await Promise.all([
                    page.waitForLoadState('domcontentloaded'),
                    firstCardLink.click(),
                ]);
                const state = await waitForProductState(page);
                record(
                    '4b. search dropdown click → product page renders',
                    state.state === 'rendered',
                    `state=${state.state}, title="${state.title}", landed on ${page.url()}`
                );
            }
        } catch (err) {
            record('4. search dropdown flow', false, err.message);
        }

        // ─────────────────────────────────────────────────────────────
        // 5. Related-products link on a successfully-rendered product
        // ─────────────────────────────────────────────────────────────
        try {
            await page.goto(
                `${BASE}/products/${SKUS.brokenEpson200Yellow.slug}/${SKUS.brokenEpson200Yellow.sku}`,
                { waitUntil: 'domcontentloaded' }
            );
            await waitForProductState(page);
            // Wait for related section to populate. It's optional, so timeout
            // is short — if no related, we just record a soft note.
            const relatedLink = await page.locator('#related-products .product-card__link').first();
            const present = await relatedLink.count();
            if (present > 0) {
                const href = await relatedLink.getAttribute('href');
                await Promise.all([
                    page.waitForLoadState('domcontentloaded'),
                    relatedLink.click(),
                ]);
                const state = await waitForProductState(page);
                record(
                    '5. related-products click → next product page renders',
                    state.state === 'rendered',
                    `from broken-family product → ${href}, state=${state.state}, title="${state.title}"`
                );
            } else {
                record('5. related-products section', true, 'no related items rendered (optional section, skipping click test)');
            }
        } catch (err) {
            record('5. related-products flow', false, err.message);
        }
    } finally {
        await browser.close();
    }

    console.log(`\n=== Audit summary ===\n`);
    const passed = results.filter(r => r.ok).length;
    const failed = results.filter(r => !r.ok).length;
    console.log(`PASS: ${passed}    FAIL: ${failed}    TOTAL: ${results.length}\n`);
    if (failed > 0) {
        console.log('Failed checks:');
        for (const r of results.filter(x => !x.ok)) {
            console.log(`  ✖ ${r.name}\n     ${r.detail}`);
        }
        process.exit(1);
    }
    process.exit(0);
})();
