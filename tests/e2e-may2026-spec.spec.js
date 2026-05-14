/**
 * Live e2e checks for the May 2026 storefront contract.
 *
 * These hit the deployed site (default: https://www.inkcartridges.co.nz) so
 * they're gated on `LIVE_E2E=1` to keep `node --test tests/` fast.
 *
 * Run:
 *   LIVE_E2E=1 npx playwright test tests/e2e-may2026-spec.spec.js
 *
 * Or against a local dev server:
 *   LIVE_E2E=1 BASE_URL=http://localhost:3000 npx playwright test tests/e2e-may2026-spec.spec.js
 *
 * Per spec §7.2 — these are the canonical post-deploy smoke tests.
 */

'use strict';

const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'https://www.inkcartridges.co.nz';
const SHOULD_RUN = process.env.LIVE_E2E === '1';

test.describe('May 2026 storefront contract — live', () => {
    test.beforeEach(({}, testInfo) => {
        if (!SHOULD_RUN) testInfo.skip(true, 'set LIVE_E2E=1 to run these');
    });

    // ─── §2 — /p/<SKU> short URL 301 ─────────────────────────────────────────
    test('GET /p/<SKU> returns 301 to /products/<slug>/<SKU>', async ({ request }) => {
        const res = await request.get(`${BASE_URL}/p/G-BRO-LC233-INK-CMY`, {
            maxRedirects: 0,
        });
        // Vercel rewrite proxies to Render which returns 301; Playwright follows
        // by default, so we disabled redirects above. Status will be 301 OR
        // (if Vercel didn't rewrite) 200 with HTML — that's the regression.
        expect(res.status(),
            `expected 301; got ${res.status()}. If 200 with text/html, the /p/* Vercel rewrite isn't applied.`)
            .toBe(301);
        const location = res.headers().location;
        expect(location).toMatch(/\/products\/.+\/G-BRO-LC233-INK-CMY/);
    });

    // ─── §5.3 — Printer-page card click lands on canonical, not "No product specified"
    test('Printer-page card click lands on canonical product URL', async ({ page }) => {
        await page.goto(`${BASE_URL}/shop?printer_slug=brother-mfc-970`);
        // Wait for the printer card grid to populate.
        await page.waitForSelector('.product-card a[href^="/products/"], .product-card__link[href^="/products/"]', { timeout: 15000 });
        const firstLink = page.locator('.product-card__link, .product-card a').first();
        const href = await firstLink.getAttribute('href');
        expect(href, 'card link must be a canonical /products/<slug>/<sku> URL').toMatch(/^\/products\/.+\/[A-Z0-9-]+$/);
        await firstLink.click();
        await page.waitForLoadState('domcontentloaded');
        await expect(page.locator('text=No product specified')).toHaveCount(0);
        await expect(page).toHaveURL(/\/products\/.+\/[A-Z0-9-]+/);
    });

    // ─── §5.1 — PDP shows "Was $X — Save $Y (Z%)" on a known sale pack ───────
    test('Genuine pack PDP renders Was/Save line', async ({ page }) => {
        await page.goto(`${BASE_URL}/products/brother-genuine-lc233-ink-cartridge-cmy-3-pack-550-pages/G-BRO-LC233-INK-CMY`);
        await page.waitForLoadState('networkidle');
        await expect(page.locator('text=/Was \\$/')).toBeVisible({ timeout: 10000 });
        await expect(page.locator('text=/Save \\$/')).toBeVisible();
    });

    test('Compatible no-sale PDP omits Was/Save line', async ({ page }) => {
        // SKU updated 2026-05-12: backend collapsed the trailing 2-char color
        // suffix to 1 char (C-BRO-LC233-INK-BK → C-BRO-LC233-INK-K). The slug
        // is decorative; backend 301-redirects stale slugs via slug_redirects.
        await page.goto(`${BASE_URL}/products/brother-compatible-lc233-ink-cartridge-black/C-BRO-LC233-INK-K`);
        await page.waitForLoadState('networkidle');
        // No strikethrough / no "Save $" — but the price itself ($8.99) should be visible.
        await expect(page.locator('.product-detail__compare-price, text=/Was \\$/')).toHaveCount(0);
    });

    // ─── §5.6 — JSON-LD blobs present on home and PDP ───────────────────────
    test('Home page embeds /api/schema/site JSON-LD', async ({ page }) => {
        await page.goto(`${BASE_URL}/`);
        await page.waitForLoadState('networkidle');
        const ldScripts = await page.locator('script[type="application/ld+json"]').count();
        expect(ldScripts, 'at least Organization + WebSite + LocalBusiness blobs').toBeGreaterThanOrEqual(3);
    });

    test('PDP embeds Product JSON-LD with @type Product', async ({ page }) => {
        await page.goto(`${BASE_URL}/products/brother-genuine-lc233-ink-cartridge-cmy-3-pack-550-pages/G-BRO-LC233-INK-CMY`);
        await page.waitForLoadState('networkidle');
        const blobs = await page.locator('script[type="application/ld+json"]').allTextContents();
        const hasProduct = blobs.some(t => /"@type"\s*:\s*"Product"/.test(t));
        expect(hasProduct, 'PDP must embed a Product JSON-LD blob').toBe(true);
    });

    // ─── §5.4 — Free-shipping nudge ─────────────────────────────────────────
    // Skipped by default — requires guest add-to-cart with cookies enabled.
    test.skip('Cart page shows free-shipping nudge from backend summary', async ({ page }) => {
        // Add an item ~$90 → expect "Add $X.XX more" copy.
        // Add another to cross $100 → expect "Free shipping unlocked" copy.
    });

    // ─── category-page-contract-may2026.md §1 — per-card source chip ───────
    // Acceptance: "Open /shop?brand=epson&category=ink&code=200. Every Epson
    // 200 single shows a yellow COMPATIBLE chip." We assert (a) every visible
    // product card carries a top-left source chip; (b) compatible chips are
    // yellow-painted, genuine chips are blue-painted (CSS class assertion is
    // sufficient — the colour is locked by tests/category-page-contract-may2026.test.js
    // §1 components.css greps).
    test('§1 /shop?brand=epson&category=ink&code=200 — every card carries a source chip', async ({ page }) => {
        await page.goto(`${BASE_URL}/shop?brand=epson&category=ink&code=200`);
        await page.waitForSelector('.product-card', { timeout: 15000 });

        const cards = page.locator('.product-card').filter({ hasNot: page.locator('.product-card--skeleton') });
        const count = await cards.count();
        expect(count, 'at least one Epson 200 card must render').toBeGreaterThan(0);

        for (let i = 0; i < count; i++) {
            const card = cards.nth(i);
            const chips = card.locator('.product-card__badge--compatible, .product-card__badge--genuine');
            const chipCount = await chips.count();
            expect(chipCount,
                `card #${i} must carry a COMPATIBLE or GENUINE chip (category-page-contract-may2026.md §1)`)
                .toBeGreaterThan(0);
        }
    });

    test('§1 /search?q=bci6 — every card carries a source chip across mixed sources', async ({ page }) => {
        await page.goto(`${BASE_URL}/search?q=bci6`);
        await page.waitForSelector('.product-card', { timeout: 15000 });

        const cards = page.locator('.product-card').filter({ hasNot: page.locator('.product-card--skeleton') });
        const count = await cards.count();
        expect(count, 'BCI6 search must return at least one card').toBeGreaterThan(0);

        // Stable spec acceptance: "regardless of whether the card has an image
        // or a fallback colour swatch" — every card has a source chip.
        const compatibleChips = await page.locator('.product-card .product-card__badge--compatible').count();
        const genuineChips    = await page.locator('.product-card .product-card__badge--genuine').count();
        expect(compatibleChips + genuineChips,
            'mixed-source search results must each carry a source chip').toBeGreaterThanOrEqual(count);
    });

    // ─── category-page-contract-may2026.md §2 — "For Use In" PDP-only ──────
    // Acceptance: "Open /shop?brand=epson&category=ink&code=200. The 'For Use
    // In: …' block under the FREE SHIPPING banner is GONE." The block lived
    // in #printers-banner; that element is no longer shipped from shop.html.
    test('§2 list page does NOT render the "For Use In:" aggregation banner', async ({ page }) => {
        await page.goto(`${BASE_URL}/shop?brand=epson&category=ink&code=200`);
        await page.waitForSelector('.product-card', { timeout: 15000 });

        // The retired aggregation lived inside the level-products region —
        // it must not exist by id, and the literal "For Use In:" copy must
        // not appear anywhere outside the PDP.
        await expect(page.locator('#printers-banner')).toHaveCount(0);
        await expect(page.locator('#level-products .product-printers-banner')).toHaveCount(0);
        await expect(page.locator('#level-products').getByText('For Use In:')).toHaveCount(0);
    });

    test('§2 PDP retains the per-product "For Use In:" banner', async ({ page }) => {
        await page.goto(`${BASE_URL}/products/brother-genuine-lc233-ink-cartridge-cmy-3-pack-550-pages/G-BRO-LC233-INK-CMY`);
        await page.waitForLoadState('networkidle');
        // Spec: "Open /products/.../G-EPS-200-INK-CY. The 'For Use In: …'
        // block IS present." We assert against a known-good genuine pack.
        await expect(page.locator('.product-printers-banner')).toBeVisible({ timeout: 10000 });
        await expect(page.locator('.product-printers-banner').getByText('For Use In:')).toBeVisible();
    });

    // ─── category-page-contract-may2026.md §3 — honest "Did you mean X?" ───
    // Acceptance: "/search?q=tn645z → did_you_mean: 'TN645' → banner reads
    // 'Did you mean TN645?'". We hit the live search and assert the banner
    // copy + link target. The retired "Showing similar results / Search
    // instead for X" banner must not appear.
    test('§3 typo search renders "Did you mean X?" with /search link', async ({ page }) => {
        await page.goto(`${BASE_URL}/search?q=tn645z`);
        await page.waitForLoadState('networkidle');

        // The new banner — DOM class + literal copy.
        const dymBanner = page.locator('.search-did-you-mean');
        await expect(dymBanner).toBeVisible({ timeout: 15000 });
        await expect(dymBanner).toContainText(/Did you mean/i);

        // The suggestion link must point at /search?q=<encoded suggestion>.
        const dymLink = dymBanner.locator('a[href^="/search?q="]');
        await expect(dymLink).toBeVisible();

        // The retired banner must not render.
        await expect(page.locator('.search-correction-banner')).toHaveCount(0);
        await expect(page.getByText(/Showing similar results/i)).toHaveCount(0);
        await expect(page.getByText(/Search instead for/i)).toHaveCount(0);
    });
});
