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
        await page.goto(`${BASE_URL}/products/brother-compatible-lc233-ink-cartridge-black/C-BRO-LC233-INK-BK`);
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
});
