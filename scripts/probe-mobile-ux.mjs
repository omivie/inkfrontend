#!/usr/bin/env node
/**
 * Does the STOREFRONT actually work on a phone? (ERR-238 …)
 * ========================================================
 *
 * Every mobile test in tests/ — mobile-parity-may2026, mobile-ux-audit-jul2026,
 * account-mobile-nav-jul2026, mobile-nav-scroll-jul2026, mobile-checkout-fold-
 * sep2026 — is a SOURCE-TEXT GREP. They prove a declaration is written down.
 * Not one of them can prove a box is the size it says, that a tap target is
 * reachable, or that the thing painted at a button's centre is that button.
 *
 * probe:mobile-checkout-fold measures real boxes, but on ONE page.
 *
 * So the phone had never been measured. What that hid, found by this probe on
 * its first run and fixed as ERR-238: FOUR elements are `position:fixed;
 * bottom:0` — .consent-banner (--z-popover, 600), .cart-sticky-bar, .sticky-atc
 * and .filter-sort-bar (--z-sticky, 200). The banner painted over the other
 * three, and the only thing lifted out of its way was #google-reviews-badge
 * (the ERR-233 fix). `body.has-consent-banner { padding-bottom }` cannot help
 * them: it reserves space in FLOW and those are FIXED — the same sentence
 * ERR-233 already had to learn once. A first-time visitor on a phone (which is
 * every ad click) could not reach Add to Cart or Checkout.
 *
 * WHAT THIS ASSERTS, per route per viewport
 * -----------------------------------------
 *   A content   the page rendered something, not an error shell
 *   B overflow  documentElement.scrollWidth <= innerWidth, offenders NAMED
 *   C tap       interactive elements clear 44x44 (WCAG 2.5.5); 44-48 is a note
 *               (--tap-min: 48px is this repo's own stricter floor)
 *   D type      input/select/textarea computed font-size >= 16px, or iOS
 *               Safari zooms on focus and the layout never comes back
 *   E overlay   each dropdown/sheet/drawer opens inside the viewport, and
 *               elementFromPoint at its primary CTA returns that CTA
 *   F stacking  no two fixed/sticky bars overlap (pages.css claimed in a
 *               comment that only one is ever present; nothing checked it,
 *               and the consent banner is the counter-example on every page)
 *
 * ── READ-ONLY. ──────────────────────────────────────────────────────────────
 * Every navigation is a GET against public pages. There is no --record and no
 * --update-baseline: a probe that can record may be green only because it just
 * overwrote what it compared against (sweep:b2b ate a committed fixture,
 * 2026-08-12). The mode is PRINTED on every run so it can never be assumed.
 *
 * There is NO ctx.route() in this file and there must never be one — a route
 * handler re-issues requests outside the browser's own enforcement and would
 * make this a measurement of the instrument, not of the site.
 *
 * A FRESH browser context per (viewport x route). A dirty profile — a stored
 * consent decision, a warm cart, a dismissed nudge, a saved recent search —
 * nearly disproved a correct brief once (ERR-224).
 *
 * It does NOT authenticate. A probe that signs in is a probe that mutates
 * session state. The gated /account pages assert the redirect to /account/login
 * and are then reported BY NAME as not exercised.
 *
 * It lives in scripts/, NOT inkcartridges/scripts/ — that tree is the Vercel
 * output directory and is served publicly (ERR-229).
 *
 * Usage:  npm run probe:mobile-ux
 *         PROBE_BASE=http://localhost:3000 npm run probe:mobile-ux
 *         PROBE_ROUTES=/cart,/shop  PROBE_VIEWPORT=se  npm run probe:mobile-ux
 * Exit:   0 = every assertion held
 *         1 = a measured regression
 *         2 = could not run (network / the site never rendered)
 */

import { chromium } from 'playwright';

const BASE = (process.env.PROBE_BASE || 'https://www.inkcartridges.co.nz').replace(/\/$/, '');
const SKU = process.env.PROBE_SKU || 'CLC37BK';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) '
    + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

// Named, not inline literals. 320 is the narrowest phone still in the stats;
// 390 is the iPhone 14 the owner reports against.
const VIEWPORTS = [
    { id: 'xs', label: '320x568 (narrowest)', width: 320, height: 568 },
    { id: 'se', label: '375x667 (iPhone SE)', width: 375, height: 667 },
    { id: 'p14', label: '390x844 (iPhone 14)', width: 390, height: 844 },
];

const TAP_STANDARD = 44;   // WCAG 2.5.5 — failing this is a defect
const TAP_ASPIRATION = 48; // --tap-min in css/base.css — failing this is a note

/* MEASURED, DELIBERATE EXCEPTIONS — reported by name every run, never hidden.
   This is not an allow-list of things we gave up on. Each entry is a control
   whose floor was measured to be unreachable for a stated geometric reason, and
   printing it on every run is the point: if the constraint ever lifts, the note
   is where that shows up. Anything not named here that misses the floor is a
   failure, full stop. */
const TAP_TRADEOFFS = {
    'product-card__qty-input': {
        why: 'the number box between the stepper\'s − and + buttons. ERR-218 measured that a '
            + 'single row holding three 44px targets plus an Add button does not fit at 375px; '
            + 'width taken here comes straight off the two buttons people actually press.',
    },
    'product-card__qty-btn': {
        // Measured on production: 44px at 375 and 390, 34-39px at 320. The
        // constraint is the CARD, not the control — at 320 a split card is
        // ~124px and three 44px targets plus an Add button is 132px before any
        // gaps. So this is a trade ONLY where the geometry makes it one, and it
        // stays a hard failure at every width where the room exists.
        viewports: ['xs'],
        why: 'the compact stepper\'s − and + inside a ~124px card at 320px. Three 44px targets '
            + 'plus an Add button is 132px before gaps, so the row cannot hold them. Measured at '
            + '44px on 375 and 390 — this is not a trade at any width where the room exists.',
    },
};

/* ── Routes ────────────────────────────────────────────────────────────────
   `ready` is an OPTIONAL extra selector for the JS-driven pages. Every route
   also has to satisfy the generic content gate (A). A bare networkidle is
   unusable here: /checkout and /payment hold SDK connections open forever. */
const ROUTES = [
    { path: '/', name: 'home', ready: '.hero__title' },
    { path: '/shop', name: 'shop', ready: '#level-brands:not([hidden]) a, #level-brands:not([hidden]) button' },
    { path: '/ink-cartridges', name: 'ink-cartridges', ready: '#level-brands:not([hidden]) a, #level-brands:not([hidden]) button' },
    { path: '/toner-cartridges', name: 'toner-cartridges', ready: '#level-brands:not([hidden]) a, #level-brands:not([hidden]) button' },
    { path: '/search?q=lc57', name: 'search', ready: '.product-card, .drilldown-box' },
    { path: '/ribbons', name: 'ribbons', ready: '#level-brands:not([hidden]) a, #level-brands:not([hidden]) button' },
    // These three are empty shells without a cart line, and an empty cart cannot
    // exercise the sticky checkout bar — which is the thing ERR-238 is about.
    // Seeded THROUGH THE REAL UI (never by writing storage), same as the fold probe.
    { path: '/cart', name: 'cart', needsCart: true },
    { path: '/checkout', name: 'checkout', ready: '#checkout-form', needsCart: true },
    { path: '/payment', name: 'payment', needsCart: true },
    { path: '/quote', name: 'quote' },
    { path: '/business', name: 'business' },
    { path: '/contact', name: 'contact' },
    { path: '/track-order', name: 'track-order' },
    { path: '/about', name: 'about' },
    { path: '/faq', name: 'faq' },
    { path: '/genuine-vs-compatible', name: 'genuine-vs-compatible' },
    { path: '/terms', name: 'terms' },
    { path: '/privacy', name: 'privacy' },
    { path: '/returns', name: 'returns' },
    { path: '/shipping', name: 'shipping' },
    { path: '/account/login', name: 'account/login' },
    { path: '/account/forgot-password', name: 'account/forgot-password' },
    // Gated: assert the redirect, then say the signed-in layout was NOT measured.
    { path: '/account', name: 'account', gated: true },
    { path: '/account/orders', name: 'account/orders', gated: true },
    { path: '/account/addresses', name: 'account/addresses', gated: true },
    { path: '/account/printers', name: 'account/printers', gated: true },
];

/* ── Overlays ──────────────────────────────────────────────────────────────
   Each is opened by a real click/type, never by adding a class. `panel` is the
   thing that must fit; `cta` is the control whose centre must answer the
   hit-test; `scrolls` means the panel owns overflow-y and is allowed to extend
   past the fold (its own scrolling reaches the rest). */
const OVERLAYS = [
    {
        id: 'nav-drawer', routes: ['home', 'shop', 'cart', 'contact'],
        trigger: '.nav-toggle', panel: '#nav-menu.is-open',
        cta: '#nav-menu .nav-menu__link', scrolls: true,
    },
    {
        id: 'brands-mega', routes: ['home', 'shop'],
        trigger: '.nav-toggle', then: '.nav-mega-toggle',
        panel: '#brands-mega:not([hidden])', cta: '#brands-mega a', scrolls: true,
    },
    {
        id: 'ribbons-mega', routes: ['home'],
        trigger: '.nav-toggle', then: '.nav-ribbons-toggle',
        panel: '#ribbons-mega:not([hidden])', cta: '#ribbons-mega a', scrolls: true,
    },
    {
        id: 'search-dropdown', routes: ['home', 'shop'],
        type: { sel: '#search-input', text: 'lc57' },
        panel: '.smart-ac-dropdown', cta: '.smart-ac__view-all', scrolls: true,
    },
    {
        id: 'filter-sort-sheet', routes: ['search'],
        trigger: '#filter-sort-open', panel: '#filter-sort-sheet:not([hidden])',
        cta: '#filter-sort-sheet .btn--primary, #filter-sort-sheet .filter-sort-sheet__foot .btn', scrolls: true,
    },
    {
        id: 'checkout-summary', routes: ['checkout'],
        trigger: '#checkout-summary-toggle', panel: '.checkout-summary:not(.is-collapsed)',
        cta: '#continue-to-payment-btn', scrolls: true,
    },
];

/* The primary conversion CTA per route — the thing a shopper MUST be able to
   press. Measured with the consent banner showing, because that is the state
   every first-time visitor (every ad click) is in. */
const PRIMARY_CTA = {
    home: '.hero__cta .btn--primary, #hero-cta-primary',
    cart: '.cart-sticky-bar .btn, #checkout-btn, .cart-summary__checkout',
    checkout: '#continue-to-payment-btn',
    search: '.product-card__add-btn',
    shop: '#level-brands a, #level-brands button',
};

let pass = 0;
const failures = [];
const notes = [];
const matrix = [];   // { route, viewport, letter, state } for the coverage grid
const ok = (n, d) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}${d ? ` — ${d}` : ''}`); };
const bad = (n, d) => { failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); };
const soft = (n, d) => { notes.push(`${n} — ${d}`); console.log(`  \x1b[33m~\x1b[0m ${n}\n      ${d}`); };
const check = (n, cond, d) => (cond ? ok(n, d) : bad(n, d));
const mark = (route, vp, letter, state) => matrix.push({ route, vp, letter, state });

const ROUTE_FILTER = (process.env.PROBE_ROUTES || '').split(',').map((s) => s.trim()).filter(Boolean);
const VP_FILTER = (process.env.PROBE_VIEWPORT || '').split(',').map((s) => s.trim()).filter(Boolean);
const routes = ROUTE_FILTER.length ? ROUTES.filter((r) => ROUTE_FILTER.includes(r.path) || ROUTE_FILTER.includes(r.name)) : ROUTES;
const viewports = VP_FILTER.length ? VIEWPORTS.filter((v) => VP_FILTER.includes(v.id)) : VIEWPORTS;

console.log('\n\x1b[1mprobe:mobile-ux — does the storefront work on a phone? (ERR-238)\x1b[0m');
console.log('\x1b[33mMODE: READ-ONLY.\x1b[0m No --record, no --update-baseline, no ctx.route(), no writes, no sign-in.');
console.log(`Target: ${BASE}`);
console.log(`Routes: ${routes.length}   Viewports: ${viewports.map((v) => v.id).join(', ')}\n`);

/* ── The one measurement closure ───────────────────────────────────────────
   Serialized once and run per state, so a page costs one round trip, not
   forty. `opts.overlay` narrows the overlay-specific reads. */
const MEASURE = (opts) => {
    const TAP_STANDARD = opts.tapStandard;
    const TAP_ASPIRATION = opts.tapAspiration;

    const describe = (e) => {
        if (!e) return null;
        const cls = String(e.className || '').trim().split(/\s+/).slice(0, 3).join('.');
        return `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}${cls ? `.${cls}` : ''}`;
    };
    const rectOf = (e) => {
        const r = e.getBoundingClientRect();
        return {
            top: Math.round(r.top), left: Math.round(r.left),
            right: Math.round(r.right), bottom: Math.round(r.bottom),
            width: Math.round(r.width), height: Math.round(r.height),
        };
    };
    const visible = (e) => {
        if (e.closest('[hidden]')) return false;
        const s = getComputedStyle(e);
        if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse') return false;
        if (parseFloat(s.opacity) === 0) return false;
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
    };

    /* B — overflow. Report BOTH widths: the fold probe reads body.scrollWidth,
       which misses overflow from a fixed/absolute child. A disagreement between
       the two is itself the finding. */
    const overflowing = [];
    document.querySelectorAll('*').forEach((e) => {
        if (!visible(e)) return;
        const r = e.getBoundingClientRect();
        if (r.right > window.innerWidth + 1 || r.left < -1) {
            // The culprit is usually the ancestor that failed to clip, so name it too.
            let owner = e.parentElement;
            while (owner && owner !== document.body) {
                const pr = owner.getBoundingClientRect();
                if (pr.right <= window.innerWidth + 1 && pr.left >= -1) break;
                owner = owner.parentElement;
            }
            overflowing.push({
                el: describe(e), rect: rectOf(e),
                containedBy: describe(owner) || 'body',
            });
        }
    });

    /* C — tap targets. Box first; then hit-slop, which is the objective form of
       "or a parent provides it": if the four points 22px out from the centre all
       still resolve to this element, the effective target clears the floor
       whatever the CSS box says. WCAG 2.5.8 exempts inline links in running
       text — exempt them, and COUNT the exemptions so it is a number, not a
       silence. */
    const tapFail = [];
    const tapSoft = [];
    let tapChecked = 0;
    let tapInlineExempt = 0;
    const interactive = document.querySelectorAll(
        'a[href], button, input:not([type=hidden]), select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])');
    interactive.forEach((e) => {
        if (!visible(e) || e.disabled) return;
        const s = getComputedStyle(e);
        if (e.tagName === 'A' && (s.display === 'inline' || e.getClientRects().length > 1)) {
            tapInlineExempt++;
            return;
        }
        tapChecked++;
        const r = e.getBoundingClientRect();
        if (r.width >= TAP_ASPIRATION && r.height >= TAP_ASPIRATION) return;
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        // Sample strictly INSIDE the required area. A point exactly on the
        // boundary is ambiguous — elementFromPoint may legitimately return the
        // ancestor — so a target that is exactly 44px would fail a check that
        // probes at exactly 22px out. Measure the area, not its edge.
        const slop = (TAP_STANDARD / 2) - 1;
        const pts = [[cx - slop, cy], [cx + slop, cy], [cx, cy - slop], [cx, cy + slop]];
        const covered = pts.every(([x, y]) => {
            if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false;
            const hit = document.elementFromPoint(Math.round(x), Math.round(y));
            return !!hit && (e === hit || e.contains(hit) || hit.contains(e));
        });
        if (covered) return;
        /* A form control's associated `<label for=...>` is a real target: clicking
           it activates the control. So a 24px checkbox beside a 44px label
           CONFORMS, and reporting it would be reporting a defect that is not
           there. This is not an exemption list — it is the actual rule, and it
           only applies when a visible label of the right size really exists and
           really points at this element. `<input>` cannot carry a ::after hit
           area of its own (it is a replaced element), so for checkboxes and
           radios the label is the ONLY way this is ever satisfied. */
        if (e.id) {
            const label = document.querySelector(`label[for="${CSS.escape(e.id)}"]`);
            if (label && visible(label)) {
                const lr = label.getBoundingClientRect();
                if (lr.width >= TAP_STANDARD && lr.height >= TAP_STANDARD) return;
            }
        }
        const entry = {
            el: describe(e), rect: rectOf(e),
            minHeight: s.minHeight, minWidth: s.minWidth,
        };
        if (r.width < TAP_STANDARD || r.height < TAP_STANDARD) tapFail.push(entry);
        else tapSoft.push(entry);
    });

    /* D — 16px floor on text entry. Below it, iOS Safari zooms the page on
       focus and never zooms back; every field after the first is then off the
       side of a viewport the shopper cannot restore. */
    const smallType = [];
    document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea')
        .forEach((e) => {
            if (!visible(e)) return;
            const px = parseFloat(getComputedStyle(e).fontSize);
            if (px < 16) smallType.push({ el: describe(e), fontSize: `${px}px` });
        });
    const vp = document.querySelector('meta[name="viewport"]');
    const viewportContent = vp ? vp.getAttribute('content') : null;

    /* F — fixed/sticky stacking. Everything painted at a fixed position, with
       its z-index, so an overlap report can say whether layering is even an
       available move (ERR-233: a third party held INT_MAX). */
    const fixedEls = [];
    document.querySelectorAll('*').forEach((e) => {
        if (!visible(e)) return;
        const s = getComputedStyle(e);
        if (s.position !== 'fixed' && s.position !== 'sticky') return;
        const r = e.getBoundingClientRect();
        if (r.width < 40 || r.height < 8) return;
        // Only the outermost fixed box; children inherit the parent's placement.
        if (e.parentElement && e.parentElement.closest) {
            let p = e.parentElement;
            let nested = false;
            while (p && p !== document.body) {
                const ps = getComputedStyle(p);
                if (ps.position === 'fixed' || ps.position === 'sticky') { nested = true; break; }
                p = p.parentElement;
            }
            if (nested) return;
        }
        fixedEls.push({ el: describe(e), rect: rectOf(e), z: s.zIndex, position: s.position });
    });

    /* The hit-test, in the fold probe's exact shape. */
    const hitOf = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return { present: false };
        /* An IN-FLOW control at the bottom of a long page is not "covered" just
           because a docked bar happens to be over that part of the viewport —
           the shopper scrolls and it is there. `body.has-consent-banner`
           reserves flow space precisely so that scroll always exists. What
           matters is whether the control can be brought out from under the bar
           AT ALL, so bring it out and then ask.
           A FIXED control gets no such courtesy: it has nowhere to scroll to,
           which is exactly why .sticky-atc under the consent banner (ERR-238)
           was a real dead end and this is not. */
        const isFixed = getComputedStyle(el).position === 'fixed'
            || !!el.closest('.sticky-atc, .cart-sticky-bar, .filter-sort-bar, .consent-banner');
        if (!isFixed) {
            // Just under the sticky header, not `block: 'center'`. Centring is not
            // enough on a short viewport: at 320x568 the consent bar is 166px, and
            // the centre of the screen can still be inside it. 140px from the top
            // clears a bottom bar of any height this site produces.
            const y = window.scrollY + el.getBoundingClientRect().top - 140;
            window.scrollTo(0, Math.max(0, y));
        }
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return { present: true, rect: rectOf(el), offscreen: 'zero-size' };
        if (r.bottom < 0 || r.top > window.innerHeight) return { present: true, rect: rectOf(el), offscreen: 'outside-fold' };
        const hit = document.elementFromPoint(
            Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
        if (!hit) return { present: true, rect: rectOf(el), hit: null };
        const isSelf = el === hit || el.contains(hit);
        return {
            present: true, rect: rectOf(el), self: isSelf,
            hit: describe(hit),
            hitZ: getComputedStyle(hit).zIndex,
            hitPosition: getComputedStyle(hit).position,
        };
    };

    const main = document.querySelector('#main-content') || document.body;
    return {
        url: location.pathname + location.search,
        title: document.title,
        textLength: (main.innerText || '').trim().length,
        priceCount: ((document.body.innerText || '').match(/\$\d+\.\d{2}/g) || []).length,
        errorVisible: Array.from(document.querySelectorAll('[role="alert"], .drilldown-error, .error-state'))
            .filter(visible).map(describe),
        htmlScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        overflowing: overflowing.slice(0, 8),
        overflowCount: overflowing.length,
        tapFail: tapFail.slice(0, 8),
        tapFailCount: tapFail.length,
        tapSoft: tapSoft.slice(0, 5),
        tapSoftCount: tapSoft.length,
        tapChecked,
        tapInlineExempt,
        smallType: smallType.slice(0, 8),
        smallTypeCount: smallType.length,
        viewportContent,
        fixedEls,
        consentPresent: !!document.querySelector('#consent-banner'),
        bodyPaddingBottom: getComputedStyle(document.body).paddingBottom,
        primaryCta: opts.cta ? hitOf(opts.cta) : null,
        overlayPanel: opts.panel ? hitOf(opts.panel) : null,
        overlayCta: opts.overlayCta ? hitOf(opts.overlayCta) : null,
        overlayScrolls: opts.panel ? (() => {
            const p = document.querySelector(opts.panel);
            if (!p) return null;
            const s = getComputedStyle(p);
            return { overflowY: s.overflowY, scrollHeight: p.scrollHeight, clientHeight: p.clientHeight };
        })() : null,
    };
};

/** Poll for a condition rather than sleeping a guessed number of ms. */
async function until(page, fn, { tries = 24, gap = 500, arg } = {}) {
    for (let i = 0; i < tries; i++) {
        try { if (await page.evaluate(fn, arg)) return true; } catch (_) { /* mid-navigation */ }
        await page.waitForTimeout(gap);
    }
    return false;
}


/** Put one line in the cart THROUGH THE REAL UI, never by writing storage.
 *  Returns null on success, or the reason it could not — a cart that will not
 *  seed is reported by name, never swallowed into "the page did not render". */
async function seedCart(page) {
    try {
        await page.goto(`${BASE}/p/${SKU}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('#add-to-cart-btn', { timeout: 30000 });
        await page.waitForTimeout(2500);
        await page.evaluate(() => document.querySelector('#add-to-cart-btn').click());
        // Poll rather than sleep a guessed interval: the write lands ~1s after the
        // click on a warm backend and later on a cold Render start, and a probe
        // that fails on its own timing teaches nothing about the site.
        for (let i = 0; i < 20; i++) {
            await page.waitForTimeout(750);
            const stored = await page.evaluate(() => localStorage.getItem('inkcartridges_cart'));
            if (stored && stored !== '[]') return null;
        }
        return `the cart did not seed within 15s from /p/${SKU} — the add-to-cart path itself may be broken`;
    } catch (e) {
        return `could not seed the cart — ${e.message.split('\n')[0]}`;
    }
}

const browser = await chromium.launch();
let fatal = null;

try {
    /* ── 0. Positive control ───────────────────────────────────────────────
       If the homepage is not up, nothing this probe says afterwards means
       anything, and that is exit 2 (could not run), never exit 1. */
    {
        const ctx = await browser.newContext({
            viewport: { width: 390, height: 844 }, userAgent: IPHONE_UA,
            isMobile: true, hasTouch: true, deviceScaleFactor: 3,
        });
        const page = await ctx.newPage();
        try {
            await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
            const alive = await until(page, () => !!document.querySelector('.site-header')
                && (document.querySelector('#main-content')?.innerText || '').trim().length > 200);
            if (!alive) throw new Error('the homepage never rendered a header + main content');
            ok('positive control: the homepage renders on a phone');
        } catch (e) {
            await ctx.close();
            throw new Error(`positive control failed — ${e.message}`);
        }
        await ctx.close();
    }

    for (const vp of viewports) {
        console.log(`\n\x1b[1m── ${vp.label} ──────────────────────────────────────\x1b[0m`);

        for (const route of routes) {
            const label = `${vp.id} ${route.name}`;
            const ctx = await browser.newContext({
                viewport: { width: vp.width, height: vp.height }, userAgent: IPHONE_UA,
                isMobile: true, hasTouch: true, deviceScaleFactor: 3,
            });
            const page = await ctx.newPage();
            let m = null;
            try {
                if (route.needsCart) {
                    const why = await seedCart(page);
                    if (why) {
                        bad(`${label} \u00b7 A the page could be reached with a cart`, why);
                        ['B', 'C', 'D'].forEach((l) => {
                            soft(`${label} \u00b7 ${l} not exercised`, 'the cart could not be seeded, so this page was never measured with a line in it');
                            mark(route.name, vp.id, l, '~');
                        });
                        await ctx.close();
                        continue;
                    }
                }
                await page.goto(`${BASE}${route.path}`, { waitUntil: 'domcontentloaded', timeout: 60000 });

                if (route.gated) {
                    const landed = await until(page, () => location.pathname.indexOf('/account/login') !== -1, { tries: 16 });
                    check(`${label} · gated page redirects to the login screen`, landed,
                        landed ? 'anonymous visitor sent to /account/login'
                            : `stayed on ${await page.evaluate(() => location.pathname)} — a gated page rendered to an anonymous visitor`);
                    // The signed-in layout is the thing that was NOT measured. Say so.
                    soft(`${label} · the signed-in layout was not exercised`,
                        'this probe never authenticates (a probe that signs in mutates session state) — '
                        + `${route.path} was measured only as a redirect`);
                    ['A', 'B', 'C', 'D'].forEach((l) => mark(route.name, vp.id, l, '~'));
                    await ctx.close();
                    continue;
                }

                /* 120, and the number is measured rather than round. The
                   shortest legitimate page on the site is /account/forgot-password
                   at 159 characters of main content ("Reset Your Password …
                   Remember your password? Sign in") — a complete, correct page.
                   The first version of this gate used 200 and failed it, which is
                   a probe reporting a defect it invented. An empty or errored
                   shell renders well under 120, so the gap still separates them. */
                const MIN_MAIN_CHARS = 120;
                const rendered = await until(page, ({ sel, min }) => {
                    const main = document.querySelector('#main-content') || document.body;
                    const hasText = (main.innerText || '').trim().length > min;
                    return hasText && (!sel || !!document.querySelector(sel));
                }, { tries: 30, arg: { sel: route.ready || null, min: MIN_MAIN_CHARS } }).catch(() => false);

                // Re-evaluate with the route's own extra selector.
                const readyOk = route.ready
                    ? await until(page, (sel) => !!document.querySelector(sel), { tries: 24 })
                        .then((r) => r, () => false)
                        .catch(() => false)
                    : true;
                void readyOk;

                m = await page.evaluate(MEASURE, {
                    tapStandard: TAP_STANDARD, tapAspiration: TAP_ASPIRATION,
                    cta: PRIMARY_CTA[route.name] || null, panel: null, overlayCta: null,
                });

                /* A — content */
                if (!rendered || m.textLength < MIN_MAIN_CHARS || m.errorVisible.length) {
                    bad(`${label} · A the page rendered`,
                        m.errorVisible.length
                            ? `visible error state: ${m.errorVisible.join(', ')}`
                            : `only ${m.textLength} chars of main content`);
                    mark(route.name, vp.id, 'A', 'x');
                    // Measuring tap targets on an error shell measures the error shell.
                    ['B', 'C', 'D'].forEach((l) => {
                        soft(`${label} · ${l} not exercised`, 'the page did not render');
                        mark(route.name, vp.id, l, '~');
                    });
                    await ctx.close();
                    continue;
                }
                ok(`${label} · A the page rendered`, `${m.textLength} chars, ${m.priceCount} prices`);
                mark(route.name, vp.id, 'A', '.');

                /* B — horizontal overflow */
                const overflows = m.htmlScrollWidth > m.innerWidth + 1;
                if (overflows) {
                    const names = m.overflowing.map((o) => `${o.el} [${o.rect.left}…${o.rect.right}] inside ${o.containedBy}`).join('; ');
                    bad(`${label} · B no horizontal overflow`,
                        `documentElement.scrollWidth ${m.htmlScrollWidth} > ${m.innerWidth} `
                        + `(body ${m.bodyScrollWidth}); ${m.overflowCount} offender(s): ${names || 'none named — the overflow is in a scroll container'}`);
                    mark(route.name, vp.id, 'B', 'x');
                } else {
                    ok(`${label} · B no horizontal overflow`, `${m.htmlScrollWidth} <= ${m.innerWidth}`);
                    mark(route.name, vp.id, 'B', '.');
                }

                /* C — tap targets */
                const tradeKey = (el) => Object.keys(TAP_TRADEOFFS).find((k) => {
                    if (!el.includes(k)) return false;
                    const t = TAP_TRADEOFFS[k];
                    return !t.viewports || t.viewports.includes(vp.id);
                });
                const traded = m.tapFail.filter((t) => tradeKey(t.el));
                const realFails = m.tapFail.filter((t) => !tradeKey(t.el));
                traded.forEach((t) => {
                    soft(`${label} · C ${t.el} is under the floor by design`,
                        `${t.rect.width}x${t.rect.height} — ${TAP_TRADEOFFS[tradeKey(t.el)].why}`);
                });
                if (realFails.length) {
                    const names = realFails.map((t) => `${t.el} ${t.rect.width}x${t.rect.height}`).join('; ');
                    bad(`${label} · C tap targets clear ${TAP_STANDARD}px`,
                        `${realFails.length} of ${m.tapChecked} below WCAG 2.5.5: ${names}`);
                    mark(route.name, vp.id, 'C', 'x');
                } else {
                    ok(`${label} · C tap targets clear ${TAP_STANDARD}px`,
                        `${m.tapChecked} checked, ${m.tapInlineExempt} inline links exempt (WCAG 2.5.8)`);
                    mark(route.name, vp.id, 'C', '.');
                }
                if (m.tapSoftCount) {
                    soft(`${label} · C ${m.tapSoftCount} target(s) between ${TAP_STANDARD} and ${TAP_ASPIRATION}px`,
                        `clears WCAG, misses this repo's own --tap-min: ${m.tapSoft.map((t) => `${t.el} ${t.rect.width}x${t.rect.height}`).join('; ')}`);
                }

                /* D — 16px type floor */
                if (m.smallTypeCount) {
                    bad(`${label} · D text inputs are at least 16px`,
                        `${m.smallTypeCount} below the iOS zoom floor: ${m.smallType.map((s) => `${s.el} ${s.fontSize}`).join('; ')}`);
                    mark(route.name, vp.id, 'D', 'x');
                } else {
                    ok(`${label} · D text inputs are at least 16px`);
                    mark(route.name, vp.id, 'D', '.');
                }
                if (m.viewportContent && /user-scalable\s*=\s*no|maximum-scale\s*=\s*1(?!\d)/.test(m.viewportContent)) {
                    bad(`${label} · D pinch-zoom is not disabled`, `viewport meta: ${m.viewportContent}`);
                }

                /* F — fixed/sticky stacking, and the primary CTA hit-test */
                const bars = m.fixedEls.filter((f) => f.position === 'fixed');
                const overlaps = [];
                for (let i = 0; i < bars.length; i++) {
                    for (let j = i + 1; j < bars.length; j++) {
                        const a = bars[i].rect; const b = bars[j].rect;
                        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
                        const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
                        if (ox > 8 && oy > 8) {
                            overlaps.push(`${bars[i].el} (z${bars[i].z}) over/under ${bars[j].el} (z${bars[j].z}) — ${ox}x${oy}px`);
                        }
                    }
                }
                if (overlaps.length) {
                    bad(`${label} · F fixed bars do not overlap`, overlaps.join('; '));
                    mark(route.name, vp.id, 'F', 'x');
                } else if (bars.length > 1) {
                    ok(`${label} · F fixed bars do not overlap`, `${bars.length} fixed: ${bars.map((b) => b.el).join(', ')}`);
                    mark(route.name, vp.id, 'F', '.');
                }

                if (m.primaryCta) {
                    if (!m.primaryCta.present) {
                        soft(`${label} · E the primary CTA was not exercised`,
                            `no element matched ${PRIMARY_CTA[route.name]} at this viewport`);
                    } else if (m.primaryCta.offscreen) {
                        soft(`${label} · E the primary CTA was not hit-tested`,
                            `${m.primaryCta.offscreen} — it is reachable by scrolling, which this check cannot adjudicate`);
                    } else {
                        check(`${label} · E the primary CTA answers its own hit-test`, m.primaryCta.self,
                            m.primaryCta.self
                                ? `${PRIMARY_CTA[route.name]} is what is painted at its own centre${m.consentPresent ? ' (with the consent banner showing)' : ''}`
                                : `covered by ${m.primaryCta.hit} (position:${m.primaryCta.hitPosition}, z-index:${m.primaryCta.hitZ})`
                                  + `${m.consentPresent ? ' — the consent banner is showing, which is the state every first-time visitor is in' : ''}`);
                    }
                }

                /* E — overlays */
                for (const ov of OVERLAYS.filter((o) => o.routes.includes(route.name))) {
                    const oLabel = `${label} · E ${ov.id}`;
                    try {
                        /* From the top, every time. The primary-CTA check above
                           scrolls the page, the mobile mega panels are relocated
                           INSIDE the nav drawer (mega-nav.js#moveIntoNav) so they
                           move with it, and a panel measured from an arbitrary
                           scroll offset reports a geometry nobody would ever see.
                           Measured: without this the ribbons panel came back at
                           top:-435 in a 667px viewport, which is the probe's own
                           previous step, not a defect. */
                        await page.evaluate(() => window.scrollTo(0, 0));
                        await page.waitForTimeout(300);
                        if (ov.type) {
                            const has = await page.$(ov.type.sel);
                            if (!has) {
                                soft(`${oLabel} was not exercised`, `trigger ${ov.type.sel} is absent at ${vp.width}px`);
                                continue;
                            }
                            await page.click(ov.type.sel);
                            await page.type(ov.type.sel, ov.type.text, { delay: 60 });
                        } else {
                            const t = await page.$(ov.trigger);
                            if (!t || !(await t.isVisible())) {
                                soft(`${oLabel} was not exercised`, `trigger ${ov.trigger} absent or hidden at ${vp.width}px`);
                                continue;
                            }
                            await t.click();
                            if (ov.then) {
                                await page.waitForTimeout(250);
                                const t2 = await page.$(ov.then);
                                if (!t2 || !(await t2.isVisible())) {
                                    soft(`${oLabel} was not exercised`, `second trigger ${ov.then} absent or hidden`);
                                    continue;
                                }
                                await t2.click();
                            }
                        }
                        const opened = await page.waitForSelector(ov.panel, { state: 'visible', timeout: 8000 })
                            .then(() => true, () => false);
                        if (!opened) {
                            // The trigger existed and did nothing. That is a regression, not an absence.
                            bad(`${oLabel} opens`, `the trigger was clicked and ${ov.panel} never became visible`);
                            continue;
                        }
                        const om = await page.evaluate(MEASURE, {
                            tapStandard: TAP_STANDARD, tapAspiration: TAP_ASPIRATION,
                            cta: null, panel: ov.panel, overlayCta: ov.cta,
                        });
                        const pr = om.overlayPanel.rect;
                        const fitsX = pr.left >= -1 && pr.right <= om.innerWidth + 1;
                        const fitsY = ov.scrolls ? pr.top >= -1 : (pr.top >= -1 && pr.bottom <= om.innerHeight + 1);
                        check(`${oLabel} opens inside the viewport`, fitsX && fitsY,
                            fitsX && fitsY
                                ? `${pr.width}x${pr.height} at (${pr.left},${pr.top})${ov.scrolls ? ' — scrolls internally' : ''}`
                                : `panel [${pr.left}…${pr.right}] x [${pr.top}…${pr.bottom}] in a ${om.innerWidth}x${om.innerHeight} viewport`);
                        if (!om.overlayCta.present) {
                            soft(`${oLabel} CTA was not hit-tested`, `no element matched ${ov.cta} inside the open panel`);
                        } else if (om.overlayCta.offscreen) {
                            soft(`${oLabel} CTA was not hit-tested`, `${om.overlayCta.offscreen} — reachable only by scrolling the panel`);
                        } else {
                            check(`${oLabel} CTA answers its own hit-test`, om.overlayCta.self,
                                om.overlayCta.self ? `${ov.cta} is painted at its own centre`
                                    : `covered by ${om.overlayCta.hit} (position:${om.overlayCta.hitPosition}, z-index:${om.overlayCta.hitZ})`);
                        }
                        if (om.htmlScrollWidth > om.innerWidth + 1) {
                            bad(`${oLabel} does not cause horizontal overflow`,
                                `scrollWidth ${om.htmlScrollWidth} > ${om.innerWidth}: `
                                + om.overflowing.map((o) => `${o.el} [${o.rect.left}…${o.rect.right}]`).join('; '));
                        }
                        const oFails = om.tapFail.filter((t) => !tradeKey(t.el));
                        if (oFails.length > realFails.length) {
                            bad(`${oLabel} tap targets clear ${TAP_STANDARD}px`,
                                `${oFails.length - realFails.length} new offender(s): `
                                + oFails.map((t) => `${t.el} ${t.rect.width}x${t.rect.height}`).join('; '));
                        }
                    } catch (e) {
                        soft(`${oLabel} was not exercised`, `the probe could not drive it — ${e.message.split('\n')[0]}`);
                    }
                }
            } catch (e) {
                bad(`${label} · A the page rendered`, `navigation failed — ${e.message.split('\n')[0]}`);
                ['B', 'C', 'D'].forEach((l) => {
                    soft(`${label} · ${l} not exercised`, 'the page did not load');
                    mark(route.name, vp.id, l, '~');
                });
            }
            await ctx.close();
        }
    }
} catch (err) {
    fatal = err;
} finally {
    await browser.close();
}

/* ── Coverage matrix ───────────────────────────────────────────────────────
   So a reader can see at a glance that e.g. tap targets never ran on six
   routes. A silent absence is the thing this whole file exists to prevent. */
if (matrix.length) {
    console.log('\n\x1b[1mCoverage  ( . held   x failed   ~ not exercised )\x1b[0m');
    const routeNames = [...new Set(matrix.map((r) => r.route))];
    const header = ['route'.padEnd(26), ...viewports.map((v) => v.id.padEnd(6))].join('');
    console.log(`  ${header}`);
    for (const rn of routeNames) {
        const cells = viewports.map((v) => {
            const rows = matrix.filter((r) => r.route === rn && r.vp === v.id);
            if (!rows.length) return '     '.padEnd(6);
            return rows.map((r) => r.state).join('').padEnd(6);
        });
        console.log(`  ${rn.padEnd(26)}${cells.join('')}`);
    }
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
console.log('\x1b[32mEvery public page and overlay measured clean on a phone.\x1b[0m');
process.exit(0);
