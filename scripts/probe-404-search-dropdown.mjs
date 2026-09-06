#!/usr/bin/env node
/**
 * probe-404-search-dropdown — where does the 404 page's search panel land?
 * ========================================================================
 *
 * ERR-217. 404.html carries the only `.search-form` on the site that is not in
 * the header, and its results panel used to paint 155px lower than the JS asked
 * for and hang 289px below the fold. Two causes, both invisible to a unit test
 * because both live in the browser's box model:
 *
 *   1. `<section class="error-page">` is revealed by modern-effects with
 *      `transform: translateY(0)`, which is NOT `none`, so it became the
 *      containing block for the panel's `position: fixed`.
 *   2. The input sits mid-page, so "fill the space below it" was 129px and the
 *      280px floor turned into 280px of overflow.
 *
 * This probe measures, in a real browser, the four numbers that told us that:
 * the custom property the JS set, the rect the browser actually painted, the
 * panel's height, and whether its bottom crosses the fold. It also drives the
 * HEADER box on the same page as a control — that one always worked, and it
 * must keep its exact numbers.
 *
 * READ-ONLY. It navigates, types, and measures. It writes nothing.
 *
 *   npm run probe:404-search                      # live site
 *   PROBE_BASE=http://localhost:3000 npm run probe:404-search
 *
 * Exit code 0 = every assertion held.
 */

import { chromium } from 'playwright';

const BASE = process.env.PROBE_BASE || 'https://www.inkcartridges.co.nz';
const PATH_404 = process.env.PROBE_404_PATH || '/this-page-does-not-exist-probe';
const QUERY = 'lc';
const VIEWPORTS = [
    { width: 1440, height: 800 },
    { width: 1280, height: 720 },
];

const results = [];
function check(name, ok, detail) {
    results.push({ name, ok, detail });
    console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function measure(page, formSelector) {
    return page.evaluate((sel) => {
        const form = document.querySelector(sel);
        if (!form) return { missing: true };
        const input = form.querySelector('input[type=search]');
        const dd = form.querySelector('.smart-ac-dropdown');
        if (!dd) return { missing: true };
        const cs = getComputedStyle(dd);
        const r = dd.getBoundingClientRect();
        const ir = input.getBoundingClientRect();
        const header = document.querySelector('.site-header');
        const hr = header ? header.getBoundingClientRect() : null;
        const round = (n) => Math.round(n);
        // Hit-test the panel's own top-left interior: if something else answers,
        // the panel is painted under it (the header wins at z-index 200 vs 50).
        const hit = document.elementFromPoint(round(r.left + 40), round(r.top + 8));
        return {
            open: dd.classList.contains('is-open'),
            placement: dd.classList.contains('is-above') ? 'above' : 'below',
            hasGrid: !!dd.querySelector('.smart-ac__grid'),
            cards: dd.querySelectorAll('.product-card').length,
            varTop: dd.style.getPropertyValue('--smart-ac-top') || null,
            varBottom: dd.style.getPropertyValue('--smart-ac-bottom') || null,
            varMaxHeight: dd.style.getPropertyValue('--smart-ac-max-height') || null,
            position: cs.position,
            textAlign: cs.textAlign,
            rect: { top: round(r.top), left: round(r.left), width: round(r.width), height: round(r.height), bottom: round(r.bottom) },
            input: { top: round(ir.top), bottom: round(ir.bottom) },
            headerBottom: hr ? round(hr.bottom) : 0,
            viewport: { w: window.innerWidth, h: window.innerHeight },
            hitTop: hit ? `${hit.tagName}.${String(hit.className).slice(0, 40)}` : null,
            hitIsPanel: hit ? dd.contains(hit) || dd === hit : false,
        };
    }, formSelector);
}

const browser = await chromium.launch();
try {
    for (const vp of VIEWPORTS) {
        const ctx = await browser.newContext({ viewport: vp });
        const page = await ctx.newPage();
        // No ctx.route() anywhere in this file — a route handler re-issues
        // requests outside the browser's own enforcement and would make this a
        // measurement of the instrument (ERR-155 family).
        await page.goto(BASE + PATH_404, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2500); // trending fetch + reveal + safety net

        console.log(`\n── ${vp.width}x${vp.height} — ${BASE}${PATH_404} ─────────────`);

        // ── The in-page box: the one that was broken ──────────────────────
        await page.locator('#error-search-input').pressSequentially(QUERY, { delay: 40 });
        await page.waitForTimeout(1400);
        const big = await measure(page, '.search-form--large');

        if (big.missing) {
            check('404 in-page box has a dropdown', false, 'form or dropdown not found');
        } else {
            console.log(`     JS asked: top=${big.varTop} bottom=${big.varBottom} max-height=${big.varMaxHeight} (${big.placement})`);
            console.log(`     painted:  top=${big.rect.top} height=${big.rect.height} bottom=${big.rect.bottom} (fold ${big.viewport.h})`);
            const anchorVar = big.placement === 'above' ? big.varBottom : big.varTop;
            const anchorPainted = big.placement === 'above'
                ? big.viewport.h - big.rect.bottom
                : big.rect.top;
            check('panel paints where the JS put it (no containing-block trap)',
                Math.abs(parseInt(anchorVar, 10) - anchorPainted) <= 1,
                `asked ${anchorVar}, painted ${anchorPainted}px`);
            check('panel bottom is inside the viewport',
                big.rect.bottom <= big.viewport.h,
                `bottom ${big.rect.bottom} vs fold ${big.viewport.h}`);
            check('panel top is inside the viewport',
                big.rect.top >= 0, `top ${big.rect.top}`);
            check('panel clears the sticky header',
                big.rect.top >= big.headerBottom - 1,
                `top ${big.rect.top} vs header bottom ${big.headerBottom}`);
            check('the header is not painting over the panel',
                big.hitIsPanel === true, `hit test found ${big.hitTop}`);
            check('the panel actually has results in it',
                big.cards > 0, `${big.cards} cards`);
            check('text is left-aligned, like every other instance',
                big.textAlign === 'left', `text-align: ${big.textAlign}`);
        }

        // ── The header box on the SAME page: the control ──────────────────
        await page.locator('#error-search-input').fill('');
        await page.locator('#search-input').pressSequentially(QUERY, { delay: 40 });
        await page.waitForTimeout(1400);
        const nav = await measure(page, '.search-form--nav');
        if (nav.missing) {
            check('header control box has a dropdown', false, 'not found');
        } else {
            console.log(`     control:  top=${nav.varTop} height=${nav.rect.height} bottom=${nav.rect.bottom} (${nav.placement})`);
            check('header box still places BELOW (unchanged behaviour)',
                nav.placement === 'below', nav.placement);
            check('header box paints where the JS put it',
                Math.abs(parseInt(nav.varTop, 10) - nav.rect.top) <= 1,
                `asked ${nav.varTop}, painted ${nav.rect.top}px`);
            // The CAP is what positionDropdown owns; the rendered height is the
            // content's, and it is legitimately shorter when the results do not
            // fill the cap. Assert the cap, and that the box respects it.
            check('header box is capped at the space below the input',
                Math.abs(parseInt(nav.varMaxHeight, 10) - (nav.viewport.h - nav.rect.top - 16)) <= 1,
                `cap ${nav.varMaxHeight}, space below top ${nav.viewport.h - nav.rect.top - 16}px, rendered ${nav.rect.height}`);
            check('header box stays inside the viewport',
                nav.rect.bottom <= nav.viewport.h,
                `bottom ${nav.rect.bottom} vs fold ${nav.viewport.h}`);
        }

        // ── Routing: the panel is only useful if it goes somewhere ───────
        if (vp.width === 1440) {
            await page.locator('#search-input').fill('');
            await page.locator('#error-search-input').pressSequentially(QUERY, { delay: 40 });
            await page.waitForTimeout(1400);
            const href = await page.evaluate(() => {
                const card = document.querySelector('.search-form--large .smart-ac-dropdown .product-card__link, .search-form--large .smart-ac-dropdown .product-card a');
                return card ? card.getAttribute('href') : null;
            });
            check('a result card in the in-page panel links to a product',
                !!href && /^\/(products?|p)\//.test(href), href || 'no link found');

            await page.locator('#error-search-input').press('Enter');
            await page.waitForTimeout(800);
            check('Enter from the in-page box goes to the results page',
                page.url().includes(`/search?q=${QUERY}`), page.url());
        }

        await ctx.close();
    }
} finally {
    await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
    console.log('FAILED:');
    failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ''}`));
    process.exit(1);
}
