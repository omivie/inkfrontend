#!/usr/bin/env node
/**
 * Is the mobile checkout form REALLY above the fold? (ERR-224 / ERR-227)
 * =====================================================================
 *
 * ERR-224 fixed a `flex: 0 1 400px` that was written for a row and reused in a
 * column, where flex-basis sizes the vertical axis: the progress bar became
 * 400px tall to draw 52px of step pills, the 858px order summary rendered above
 * the form, and the first field anyone must fill sat 1,621px down an 844px
 * viewport. Mobile is ~64% of paid-search traffic.
 *
 * WHAT WOULD BE INVISIBLY WRONG WITHOUT THIS PROBE
 * ------------------------------------------------
 * The 21 tests in tests/mobile-checkout-fold-sep2026.test.js are, every one of
 * them, assertions about SOURCE TEXT — `assert.match(CSS, /flex-basis:\s*auto/)`
 * and its siblings. They prove a declaration is written down. They cannot prove
 * a box is the size it says, and they stay green through every one of these:
 *
 *   - a later rule, in any of eight stylesheets, re-introduces a height on
 *     .checkout-progress; the reset is still in the file, still matching
 *   - the disclosure JS throws before setupSummaryDisclosure() binds, so the
 *     summary never collapses and the form is 858px down again
 *   - the MutationObserver mirror stops firing and the collapsed bar shows a
 *     total that disagrees with #checkout-total, or shows nothing at all
 *   - a new element re-introduces the horizontal overflow that clipped `$47.92`
 *     to `$47.9` on the checkout page
 *   - the consent bar (ERR-227) covers the Continue button on a short viewport
 *
 * That is the ERR-217 shape exactly — "the old test PINNED the bug" — and it is
 * the one hazard in MEMORY.md that shipped without a live probe. The brief that
 * prompted the fix said it plainly: measure, don't eyeball. So this asks the
 * BROWSER, at a real viewport, against the deployed site.
 *
 * ── READ-ONLY. ──────────────────────────────────────────────────────────────
 * Every navigation is a GET against public pages. There is no --record and no
 * --update-baseline, deliberately: a probe that can record may be green only
 * because it just overwrote what it compared against (sweep:b2b ate a committed
 * fixture, 2026-08-12). The mode is PRINTED on every run so it can never be
 * assumed.
 *
 * There is NO ctx.route() in this file and there must never be one — a route
 * handler re-issues requests outside the browser's own enforcement and would
 * make this a measurement of the instrument, not of the site.
 *
 * Each section opens a FRESH browser context. A dirty profile (a stored consent
 * decision, a dismissed nudge, a warm cart) nearly disproved the original brief.
 *
 * It lives in scripts/, NOT inkcartridges/scripts/ — that tree is the Vercel
 * output directory and is served publicly.
 *
 * Usage:  npm run probe:mobile-checkout-fold
 *         PROBE_BASE=http://localhost:3000 npm run probe:mobile-checkout-fold
 * Exit:   0 = every assertion held
 *         1 = a measured box regressed
 *         2 = could not run (network / the page never rendered)
 */

import { chromium } from 'playwright';

const BASE = process.env.PROBE_BASE || 'https://www.inkcartridges.co.nz';
const SKU = process.env.PROBE_SKU || 'CLC37BK';
const PHONE = { width: 390, height: 844 };   // iPhone 14
const SE_FOLD = 667;                         // iPhone SE — the short one that must still work
const DESKTOP = { width: 1440, height: 900 };
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) '
    + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

let pass = 0;
const failures = [];
const notes = [];
const ok = (n, d) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}${d ? ` — ${d}` : ''}`); };
const bad = (n, d) => { failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); };
const soft = (n, d) => { notes.push(`${n} — ${d}`); console.log(`  \x1b[33m~\x1b[0m ${n}\n      ${d}`); };
const check = (n, cond, d) => (cond ? ok(n, d) : bad(n, d));

console.log('\n\x1b[1mprobe:mobile-checkout-fold — is the form actually above the fold? (ERR-224/226)\x1b[0m');
console.log('\x1b[33mMODE: READ-ONLY.\x1b[0m No --record, no --update-baseline, no ctx.route(), no writes.');
console.log(`Target: ${BASE}\n`);

/** Geometry of everything this probe cares about, read from the live DOM. */
const MEASURE = () => {
    const q = (s) => document.querySelector(s);
    const box = (s) => {
        const e = q(s);
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return {
            top: Math.round(r.top + window.scrollY),
            height: Math.round(r.height),
            width: Math.round(r.width),
            bottom: Math.round(r.bottom),
        };
    };
    // Name the offenders rather than reporting a bare number: "406 > 390" tells
    // you nothing about which element to open.
    const overflowing = [];
    document.querySelectorAll('*').forEach((e) => {
        const r = e.getBoundingClientRect();
        if (r.width > 0 && r.right > window.innerWidth + 1) {
            overflowing.push(`${e.tagName.toLowerCase()}.${String(e.className).trim().slice(0, 40)} right=${Math.round(r.right)}`);
        }
    });
    const toggle = q('#checkout-summary-toggle');
    const cta = q('#continue-to-payment-btn');
    const banner = q('#consent-banner');
    return {
        email: box('input[name="email"]'),
        progress: box('.checkout-progress'),
        sidebar: box('.checkout-sidebar'),
        toggle: box('#checkout-summary-toggle'),
        toggleDisplay: toggle ? getComputedStyle(toggle).display : null,
        toggleMinHeight: toggle ? getComputedStyle(toggle).minHeight : null,
        ariaExpanded: toggle ? toggle.getAttribute('aria-expanded') : null,
        isCollapsed: !!q('.checkout-summary.is-collapsed'),
        toggleTotal: (q('#checkout-summary-toggle-total') || {}).textContent ?? null,
        checkoutTotal: (q('#checkout-total') || {}).textContent ?? null,
        formWrapper: box('.checkout-form-wrapper'),
        cta: box('#continue-to-payment-btn'),
        // What is actually painted at the CTA's own centre? If the consent bar
        // covers it, something else answers this hit-test.
        ctaHit: (() => {
            if (!cta) return null;
            const r = cta.getBoundingClientRect();
            if (r.bottom < 0 || r.top > window.innerHeight) return 'offscreen';
            const hit = document.elementFromPoint(
                Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
            if (!hit) return null;
            return cta.contains(hit) || cta === hit ? 'cta' : `${hit.tagName.toLowerCase()}#${hit.id || ''}.${String(hit.className).trim().slice(0, 30)}`;
        })(),
        banner: box('#consent-banner'),
        bannerPresent: !!banner,
        bodyPaddingBottom: getComputedStyle(document.body).paddingBottom,
        scrollWidth: document.body.scrollWidth,
        innerWidth: window.innerWidth,
        pageHeight: document.body.scrollHeight,
        overflowing: overflowing.slice(0, 10),
    };
};

/** Put one line in the cart THROUGH THE REAL UI, never by writing storage. */
async function seedCart(page) {
    await page.goto(`${BASE}/p/${SKU}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('#add-to-cart-btn', { timeout: 30000 });
    await page.waitForTimeout(2500);
    await page.evaluate(() => {
        const qty = document.querySelector('#quantity');
        if (qty) { qty.value = '8'; qty.dispatchEvent(new Event('change', { bubbles: true })); }
        document.querySelector('#add-to-cart-btn').click();
    });
    await page.waitForTimeout(3000);
    const stored = await page.evaluate(() => localStorage.getItem('inkcartridges_cart'));
    if (!stored || stored === '[]') throw new Error('cart did not seed — the add-to-cart path itself is broken');
}

/** /checkout never reaches networkidle: the payment SDKs hold connections open
 *  and page.goto times out at 60s. Wait for the field we are here to measure. */
async function openCheckout(page) {
    await page.goto(`${BASE}/checkout`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('input[name="email"]', { timeout: 30000 });
    await page.waitForTimeout(4500); // totals resolve, disclosure binds, observer fires
}

const browser = await chromium.launch();
let fatal = null;
try {
    /* ── 1. MOBILE, the state a shopper actually lands in ────────────────── */
    {
        const ctx = await browser.newContext({
            viewport: PHONE, userAgent: IPHONE_UA, isMobile: true, hasTouch: true, deviceScaleFactor: 3,
        });
        const page = await ctx.newPage();
        await seedCart(page);
        await openCheckout(page);
        const m = await page.evaluate(MEASURE);

        console.log(`── ${PHONE.width}x${PHONE.height} ${BASE}/checkout — collapsed (default) ──`);
        if (!m.email) {
            bad('the email field exists at all', 'input[name="email"] not found — page did not render');
        } else {
            check('the first field is above the iPhone SE fold', m.email.top < SE_FOLD,
                `email top = ${m.email.top}px (must be < ${SE_FOLD}; was 1621 before ERR-224)`);
            check('and above this viewport’s own fold', m.email.top < PHONE.height,
                `email top = ${m.email.top}px vs fold ${PHONE.height}`);
        }
        check('the progress bar is its content height, not a flex-basis',
            !!m.progress && m.progress.height <= 140,
            `.checkout-progress = ${m.progress ? m.progress.height : '?'}px (was 400px; 52px of pills + 24px padding = 100px)`);
        check('the order summary is collapsed on arrival',
            !!m.sidebar && m.sidebar.height <= 160,
            `.checkout-sidebar = ${m.sidebar ? m.sidebar.height : '?'}px (was 858px expanded)`);
        check('the summary carries is-collapsed', m.isCollapsed === true, `is-collapsed = ${m.isCollapsed}`);
        check('the toggle reports collapsed to assistive tech', m.ariaExpanded === 'false',
            `aria-expanded = ${m.ariaExpanded}`);
        check('the toggle clears a 44px touch target',
            !!m.toggleMinHeight && parseInt(m.toggleMinHeight, 10) >= 44,
            `min-height = ${m.toggleMinHeight}`);

        // The ERR-224 mirror invariant. The collapsed bar shows a number the
        // shopper will be charged; a fifth writer of that number is how two
        // totals start disagreeing, which is why it is a MutationObserver.
        if (m.checkoutTotal && m.checkoutTotal.trim()) {
            check('the collapsed total equals #checkout-total exactly',
                (m.toggleTotal || '').trim() === m.checkoutTotal.trim(),
                `bar "${(m.toggleTotal || '').trim()}" vs summary "${m.checkoutTotal.trim()}"`);
        } else {
            soft('the collapsed total could not be compared', 'pricing had not resolved — not a pass');
        }

        check('no horizontal overflow', m.scrollWidth <= m.innerWidth,
            `body.scrollWidth ${m.scrollWidth} vs viewport ${m.innerWidth} (was 406 vs 390, clipping "$47.92")`);
        if (m.overflowing.length) bad('nothing paints past the right edge', m.overflowing.join('\n      '));
        else ok('nothing paints past the right edge');

        /* The consent bar (ERR-227) is fixed to the bottom. The one thing it
           must never do is sit on the Continue button. */
        console.log('\n── the consent bar must not cover anything ──');
        if (!m.bannerPresent) {
            soft('the consent bar was not rendered', 'not yet deployed here, or a decision is already stored — consent checks did not run');
        } else {
            check('the bar reserves its own height on <body>',
                parseInt(m.bodyPaddingBottom, 10) >= (m.banner ? m.banner.height : 1) - 1,
                `body padding-bottom ${m.bodyPaddingBottom} vs bar ${m.banner ? m.banner.height : '?'}px`);
            check('the bar is a slim strip, not an interstitial',
                !!m.banner && m.banner.height <= PHONE.height * 0.3,
                `bar = ${m.banner ? m.banner.height : '?'}px, ${Math.round(((m.banner ? m.banner.height : 0) / PHONE.height) * 100)}% of the viewport`);
            check('the first field is still above the fold with the bar showing',
                !!m.email && m.email.top < SE_FOLD, `email top = ${m.email ? m.email.top : '?'}px`);
        }

        /* Scroll the CTA into view and hit-test it: does the button answer at
           its own centre, or does the bar? */
        await page.evaluate(() => {
            const b = document.querySelector('#continue-to-payment-btn');
            if (b) b.scrollIntoView({ block: 'center' });
        });
        await page.waitForTimeout(600);
        const cta = await page.evaluate(MEASURE);
        if (!cta.cta) soft('the Continue button was not found', 'could not hit-test the CTA');
        else check('the Continue button is what answers at its own centre', cta.ctaHit === 'cta',
            `elementFromPoint returned "${cta.ctaHit}"`);

        /* ── expanded ── */
        await page.evaluate(() => {
            const t = document.querySelector('#checkout-summary-toggle');
            if (t) t.click();
        });
        await page.waitForTimeout(800);
        const ex = await page.evaluate(MEASURE);
        console.log('\n── expanded by tap ──');
        check('expanding reports itself to assistive tech', ex.ariaExpanded === 'true',
            `aria-expanded = ${ex.ariaExpanded}`);
        check('expanding really reveals the summary', !ex.isCollapsed && !!ex.sidebar && ex.sidebar.height > 300,
            `.checkout-sidebar = ${ex.sidebar ? ex.sidebar.height : '?'}px`);
        check('still no horizontal overflow when expanded', ex.scrollWidth <= ex.innerWidth,
            `${ex.scrollWidth} vs ${ex.innerWidth}`);
        await ctx.close();
    }

    /* ── 2. DESKTOP — the mobile fix must not have leaked upward ─────────── */
    {
        const ctx = await browser.newContext({ viewport: DESKTOP });
        const page = await ctx.newPage();
        await seedCart(page);
        await openCheckout(page);
        const d = await page.evaluate(MEASURE);

        console.log(`\n── ${DESKTOP.width}x${DESKTOP.height} ${BASE}/checkout — desktop regression ──`);
        check('the email field is where it has always been',
            !!d.email && Math.abs(d.email.top - 329) <= 60, `email top = ${d.email ? d.email.top : '?'}px (baseline 329)`);
        check('the mobile toggle is hidden', d.toggleDisplay === 'none', `display = ${d.toggleDisplay}`);
        check('a desktop shopper can never reach a collapsed summary', d.isCollapsed === false,
            `is-collapsed = ${d.isCollapsed}`);
        check('the layout is still two columns',
            !!d.formWrapper && !!d.sidebar && d.formWrapper.width + d.sidebar.width < DESKTOP.width,
            `form ${d.formWrapper ? d.formWrapper.width : '?'}px + sidebar ${d.sidebar ? d.sidebar.width : '?'}px`);
        check('no horizontal overflow on desktop', d.scrollWidth <= d.innerWidth,
            `${d.scrollWidth} vs ${d.innerWidth}`);
        await ctx.close();
    }

    /* ── 3. /ink-cartridges — the nudge must not greet a first-time visitor ── */
    {
        const ctx = await browser.newContext({
            viewport: PHONE, userAgent: IPHONE_UA, isMobile: true, hasTouch: true,
        });
        const page = await ctx.newPage();
        await page.goto(`${BASE}/ink-cartridges`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(7000); // well past the 3s dwell floor

        const nudge = () => document.querySelector('.rewards-nudge');
        const before = await page.evaluate(() => {
            const n = document.querySelector('.rewards-nudge');
            return {
                present: !!n && !n.hidden,
                cards: document.querySelectorAll('.product-card').length,
                scrollWidth: document.body.scrollWidth,
                innerWidth: window.innerWidth,
            };
        });
        console.log(`\n── ${PHONE.width}x${PHONE.height} ${BASE}/ink-cartridges — first load ──`);
        check('no nudge before the visitor has scrolled anything', before.present === false,
            `after a 7s dwell at scrollY 0, .rewards-nudge present = ${before.present}`);
        check('there are products on screen to look at', before.cards > 0, `${before.cards} cards rendered`);
        check('no horizontal overflow on the listing page', before.scrollWidth <= before.innerWidth,
            `${before.scrollWidth} vs ${before.innerWidth}`);

        await page.evaluate(() => window.scrollTo(0, 900));
        await page.waitForTimeout(2500);
        const after = await page.evaluate(() => {
            const n = document.querySelector('.rewards-nudge');
            const r = n ? n.getBoundingClientRect() : null;
            return { present: !!n && !n.hidden, width: r ? Math.round(r.width) : 0, height: r ? Math.round(r.height) : 0 };
        });
        if (after.present) {
            ok('the nudge still arrives after a real scroll', `${after.width}x${after.height}`);
            check('and it stays inside the viewport', after.width <= PHONE.width - 16,
                `${after.width}px wide in a ${PHONE.width}px viewport`);
        } else {
            // Not a failure: a signed-in visitor, a cooldown, or a paused campaign
            // all legitimately suppress it. But say so BY NAME — a skip is not a pass.
            soft('the nudge did not appear after scrolling',
                'campaign disabled, cooldown active, or visitor treated as signed in — the scroll gate itself was NOT exercised');
        }
        await ctx.close();
    }
} catch (err) {
    fatal = err;
} finally {
    await browser.close();
}

console.log('\n────────────────────────────────────────────────────────');
if (fatal) {
    console.log(`\x1b[31mCOULD NOT RUN\x1b[0m — ${fatal.message}`);
    process.exit(2);
}
console.log(`${pass} passed, ${failures.length} failed, ${notes.length} not exercised`);
if (notes.length) {
    console.log('\n\x1b[33mNot exercised (a skip is not a pass):\x1b[0m');
    notes.forEach((n) => console.log(`  ~ ${n}`));
}
if (failures.length) {
    console.log('\n\x1b[31mFailures:\x1b[0m');
    failures.forEach((f) => console.log(`  ✗ ${f}`));
    process.exit(1);
}
console.log('\x1b[32mThe mobile checkout form is above the fold and nothing covers the CTA.\x1b[0m');
process.exit(0);
