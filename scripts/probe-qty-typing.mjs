#!/usr/bin/env node
/**
 * probe-qty-typing — can a shopper actually TYPE a quantity?
 * ==========================================================
 *
 * ERR-228. The quantity stepper is emitted INSIDE the card's wrapping
 * <a class="product-card__link">. QtyStepper.bind cancelled clicks on the two
 * buttons and nothing else, so a click on the number box between them was
 * never cancelled, the anchor performed its default action, and the shopper
 * landed on the product page instead of in the box. Measured on the live
 * dropdown AND on the /search grid — the grid has no mousedown blur-guard at
 * all, which is what proved the guard innocent and the component guilty.
 *
 * WHY A PROBE. Every question here is about what a browser does with a click:
 * whether an anchor navigates, where focus lands, what the button says
 * afterwards. None of it is greppable — ERR-224 shipped 21 green source-grep
 * tests over a layout that was wrong on screen, and ERR-218 itself verified
 * "+ does not navigate" and never once clicked the box. So this clicks the
 * real box in a real browser and reads the URL back.
 *
 * THE POSITIVE CONTROL IS NOT OPTIONAL. A guard that cancels every click in
 * the card would pass checks 1-6 and break the whole grid, so the probe also
 * clicks a card TITLE and requires that it still navigates. A green run means
 * the box is typeable AND the card is still a link (ERR-181/186: a test can
 * pass for the wrong reason).
 *
 * READ-ONLY. It navigates, clicks the stepper, types digits and reads boxes.
 * It NEVER clicks Add to Cart, so no cart is ever written.
 *
 *   npm run probe:qty-typing
 *   PROBE_BASE=http://localhost:3000 npm run probe:qty-typing
 *
 * Exit code 0 = every assertion held.
 */

import { chromium } from 'playwright';

const BASE = (process.env.PROBE_BASE || 'https://www.inkcartridges.co.nz').replace(/\/$/, '');
const QUERY = process.env.PROBE_QUERY || 'ribbon';
const VIEWPORT = { width: 1440, height: 900 };

// /shop paints skeleton cards for a long time headless and never painted a
// stepper in measurement, so the grid surface is exercised through the search
// results page. Locally, `npx serve` does not apply vercel.json's rewrites, so
// the raw template is the fallback — the probe REPORTS which one it used.
const GRID_PATHS = [
    `/search?q=${encodeURIComponent(QUERY)}`,
    `/html/shop.html?q=${encodeURIComponent(QUERY)}`,
];

const QTY = '.product-card__qty-input';
const DROPDOWN_QTY = `.smart-ac__list ${QTY}`;
const CTA = '.product-card__add-btn, .product-card__cart-btn';

const results = [];
function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}
function unproven(name, detail) {
    results.push({ name, ok: false, unproven: true, detail });
    console.log(`  ⚠️  UNPROVEN: ${name}${detail ? ` — ${detail}` : ''}`);
}

const activeDesc = (page) => page.evaluate(() => {
    const a = document.activeElement;
    if (!a) return 'none';
    return a.tagName.toLowerCase() + (a.className ? '.' + String(a.className).trim().split(/\s+/).join('.') : '');
});

/** The CTA belonging to the same buy row as `qtyLocator`. */
const ctaOf = (scopeSel) => `${scopeSel} .product-card__buy :is(${CTA})`;

console.log(`\n\x1b[1mprobe-qty-typing\x1b[0m — ${BASE}  ·  query "${QUERY}"`);
console.log('  MODE: READ-ONLY (no Add to Cart is ever clicked, no cart is written)\n');

const browser = await chromium.launch();
let gridPathUsed = null;

try {
    // ───────────────────────────────────────────────────────────────────────
    // Surface 1 — the header search dropdown
    // ───────────────────────────────────────────────────────────────────────
    {
        console.log('\x1b[1m  the header search dropdown\x1b[0m');
        const ctx = await browser.newContext({ viewport: VIEWPORT });
        const page = await ctx.newPage();
        await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
        const search = page.locator('form input[type=search], form input[name=q], .search-input').first();
        await search.click();
        await search.type(QUERY, { delay: 60 });

        let painted = true;
        try {
            await page.waitForSelector(DROPDOWN_QTY, { timeout: 25000 });
        } catch {
            painted = false;
        }

        if (!painted) {
            unproven('the dropdown never painted a quantity box',
                `"${QUERY}" returned no cards with a stepper at ${BASE}. This is NOT a pass — `
                + 'set PROBE_QUERY to a query you know returns products.');
        } else {
            const qty = page.locator(DROPDOWN_QTY).first();
            const urlBefore = page.url();
            const box = await qty.boundingBox();
            console.log(`     box ${Math.round(box.width)}×${Math.round(box.height)}px at `
                + `(${Math.round(box.x)}, ${Math.round(box.y)})`);

            await qty.click();
            await page.waitForTimeout(600);

            const urlAfter = page.url();
            check('clicking the quantity box does NOT navigate',
                urlAfter === urlBefore,
                urlAfter === urlBefore ? `still ${urlAfter}` : `went to ${urlAfter}`);

            if (urlAfter === urlBefore) {
                check('the caret lands in the quantity box',
                    (await activeDesc(page)).includes('product-card__qty-input'),
                    `activeElement = ${await activeDesc(page)}`);
                check('the panel stays open',
                    await page.evaluate(() => !!document.querySelector('.smart-ac-dropdown.is-open')));

                await page.keyboard.type('12');
                await page.waitForTimeout(400);
                check('a typed quantity sticks', (await qty.inputValue()) === '12',
                    `value = ${await qty.inputValue()}`);

                const cta = page.locator(ctaOf('.smart-ac__list')).first();
                const label = (await cta.innerText()).trim();
                const aria = (await cta.getAttribute('aria-label')) || '';
                check('the button relabels to the typed quantity', label === 'Add 12', `"${label}"`);
                check('the accessible name is not abbreviated',
                    /\b12\b/.test(aria) && aria.length > label.length, `"${aria}"`);

                check('the search box is untouched by the digits',
                    (await search.inputValue()) === QUERY, `"${await search.inputValue()}"`);

                await page.locator('.smart-ac__list .product-card__qty-btn[data-step=up]').first().click();
                await page.waitForTimeout(300);
                check('+ still steps from the typed value',
                    (await qty.inputValue()) === '13', `value = ${await qty.inputValue()}`);
                check('+ does not navigate either', page.url() === urlBefore, page.url());

                await qty.click();
                await page.keyboard.press('Escape');
                await page.waitForTimeout(300);
                const after = await activeDesc(page);
                check('Escape hands focus back to the search input',
                    !after.includes('product-card__qty-input'), `activeElement = ${after}`);

                // POSITIVE CONTROL — the card must still be a link.
                const link = page.locator('.smart-ac__list .product-card__link').first();
                const href = await link.getAttribute('href');
                await link.click();
                await page.waitForLoadState('domcontentloaded').catch(() => {});
                await page.waitForTimeout(1200);
                check('POSITIVE CONTROL: clicking the card still opens the product page',
                    page.url() !== urlBefore && page.url().includes(String(href).split('?')[0]),
                    `${page.url()}`);
            }
        }
        await ctx.close();
        console.log('');
    }

    // ───────────────────────────────────────────────────────────────────────
    // Surface 2 — the search results grid (shop-page.js renderer)
    // ───────────────────────────────────────────────────────────────────────
    {
        console.log('\x1b[1m  the search results grid\x1b[0m');
        const ctx = await browser.newContext({ viewport: VIEWPORT });
        const page = await ctx.newPage();

        for (const path of GRID_PATHS) {
            await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
            const ok = await page.waitForSelector(`${QTY}`, { timeout: 30000 }).then(() => true).catch(() => false);
            if (ok) { gridPathUsed = path; break; }
        }

        if (!gridPathUsed) {
            unproven('the results grid never painted a quantity box',
                `tried ${GRID_PATHS.join(' and ')} at ${BASE}. This is NOT a pass — the grid is `
                + 'the surface that failed WITHOUT a blur-guard, which is what proves the '
                + 'component is the cause.');
        } else {
            console.log(`     using ${gridPathUsed}`);
            const qty = page.locator(QTY).first();
            await qty.scrollIntoViewIfNeeded();
            const urlBefore = page.url();

            await qty.click();
            await page.waitForTimeout(600);
            const urlAfter = page.url();
            check('clicking the quantity box does NOT navigate (grid)',
                urlAfter === urlBefore,
                urlAfter === urlBefore ? `still ${urlAfter}` : `went to ${urlAfter}`);

            if (urlAfter === urlBefore) {
                check('the caret lands in the quantity box (grid)',
                    (await activeDesc(page)).includes('product-card__qty-input'),
                    `activeElement = ${await activeDesc(page)}`);
                await page.keyboard.press('ControlOrMeta+a');
                await page.keyboard.type('12');
                await page.waitForTimeout(400);
                check('a typed quantity sticks (grid)', (await qty.inputValue()) === '12',
                    `value = ${await qty.inputValue()}`);
                const cta = page.locator('.product-card__buy').first().locator(CTA).first();
                const label = (await cta.innerText()).trim();
                check('the button relabels to the typed quantity (grid)', label === 'Add 12', `"${label}"`);

                // POSITIVE CONTROL on this surface too.
                const link = page.locator('.product-card__link').first();
                await link.click();
                await page.waitForLoadState('domcontentloaded').catch(() => {});
                await page.waitForTimeout(1200);
                check('POSITIVE CONTROL: the grid card still opens the product page (grid)',
                    page.url() !== urlBefore, page.url());
            }
        }
        await ctx.close();
        console.log('');
    }
} finally {
    await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
    console.log('FAILED:');
    failed.forEach((f) => console.log(`  - ${f.unproven ? '[UNPROVEN] ' : ''}${f.name}${f.detail ? ` (${f.detail})` : ''}`));
    process.exit(1);
}
console.log('\x1b[32mThe quantity box takes a caret, keeps its digits, and the card is still a link.\x1b[0m\n');
