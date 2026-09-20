#!/usr/bin/env node
/**
 * probe:mobile-cta — can a first-time guest on a phone actually TAP Add to Cart?
 * ==============================================================================
 *
 * ERR-276 · backend handoff `mobile-cta-occlusion-and-seo-FE-handoff-sep2026.md`
 *
 * WHAT WOULD BE INVISIBLY WRONG WITHOUT THIS PROBE
 * ------------------------------------------------
 * js/rewards-nudge.js turns into a different component below
 * Config.BREAKPOINTS.tablet: position() drops a `position: fixed`, full-width
 * card at --z-popover (600) under the sticky header, re-pinned on every scroll.
 * Measured on production at 390x844 it occupied y 144-392 and #add-to-cart-btn
 * sat at y 264-312, inside it. Mobile converts at 1.8% against desktop's 6.5%
 * on the same ad spend, and mobile had to be switched off for two ad groups as
 * a stop-loss while this was live.
 *
 * tests/mobile-cta-occlusion-sep2026.test.js pins the SOURCE — that the gate is
 * written down, that every path spelling is in the list, that the emitter and
 * the listener both exist. It cannot prove a thumb can reach the button, and it
 * stays green through all of these:
 *
 *   - a later CSS rule re-raises the card, or the header grows and the card
 *     with it, so the gate is right and the geometry is not
 *   - the gate throws before it runs (Config undefined, matchMedia stubbed) and
 *     the early return never happens
 *   - the nudge is suppressed correctly and something ELSE covers the button
 *   - the nudge stops appearing on desktop too, which is a silent loss of every
 *     account signup rather than a visible bug
 *
 * SO THIS PROBE ASKS THE BROWSER. And it is built around the one mistake the
 * handoff itself made, which is worth stating because it is the reusable lesson:
 *
 *   ┌──────────────────────────────────────────────────────────────────────┐
 *   │ A CONTROL THAT IS CORRECTLY HIDDEN IS NOT A CONTROL THAT IS BLOCKED. │
 *   └──────────────────────────────────────────────────────────────────────┘
 *
 * The handoff's re-measurement reported `#sticky-atc-btn` as BLOCKED by the
 * consent banner. It was not. `.sticky-atc` carries `transform: translateY(100%)`
 * until product-detail-page.js adds `.is-visible`, which it does only while
 * `.product-info__actions` is OUT of view — and the run had deliberately
 * scrolled the main button INTO view. The box it measured (y 515-582) is that
 * hidden resting position with ERR-238's `bottom: var(--consent-banner-height)`
 * lift already applied; without the lift it would have been off-screen at
 * 664-731. So a working fix was reported as a live defect, and the real blocker
 * one row above it was nearly buried under it.
 *
 * Every control here therefore reports its STATE BEFORE ITS VERDICT: display,
 * visibility, the is-visible class, aria-hidden, and whether its box is in the
 * viewport at all. A control that is hidden by design is reported NOT EXERCISED
 * — never as a pass (a skip is not a pass) and never as a failure.
 *
 * §5 is a NEGATIVE CONTROL. It injects a synthetic overlay over the button and
 * asserts this probe turns red. Six guards in this repo once sat inside a
 * 6088/0 green suite and none of them could fail (ERR-258); an occlusion check
 * that cannot report occlusion is that shape exactly, and it would be green for
 * the rest of its life.
 *
 * ENGINE HONESTY. The handoff measured WebKit. Playwright's WebKit build is not
 * installed on every machine here, and every other probe in scripts/ emulates
 * iOS with chromium + an iPhone UA. So this file TRIES webkit, falls back to
 * chromium, and PRINTS which one ran — a probe's emulation is part of its
 * measurement (ERR-238/239/240), and silently claiming Safari would make the
 * number unfalsifiable.
 *
 * ── READ-ONLY. ──────────────────────────────────────────────────────────────
 * Every navigation is a GET against public pages. Nothing is added to a cart,
 * no form is submitted, no account is touched, and no /api/search/* endpoint is
 * called, so no search_analytics row is written (ERR-254). There is no --record
 * and no --update-baseline, deliberately: a probe that can record may be green
 * only because it just overwrote what it compared against (sweep:b2b ate a
 * committed fixture, 2026-08-12). The mode is PRINTED on every run.
 *
 * The ONE write of any kind is §5's synthetic overlay, which is a DOM node in a
 * throwaway browser context that is closed immediately afterwards. It never
 * reaches the server and never outlives the section.
 *
 * There is NO ctx.route() in this file and there must never be one — a route
 * handler re-issues requests outside the browser's own enforcement and would
 * make this a measurement of the instrument rather than of the site.
 *
 * A FRESH CONTEXT PER SECTION. No cookies, no localStorage, no sessionStorage.
 * That is not tidiness: the nudge is once-per-session (sessionStorage) with a
 * 7-day dismissal cooldown (localStorage), so a reused profile would show a
 * clean screen and report this fixed when it is not.
 *
 * THE NUDGE IS SCROLL-TRIGGERED, NOT TIMED. It is absent from the DOM at 1s, 3s
 * and 6s and mounts only past `scrollThresholdPx` (600) with `delayMs` (3000)
 * already elapsed. A QA pass that loads the page and waits sees nothing wrong.
 * Every section below scrolls past that mark on purpose.
 *
 * It lives in scripts/, NOT inkcartridges/scripts/ — that tree is the Vercel
 * output directory and is served publicly (ERR-229).
 *
 * Usage:  npm run probe:mobile-cta
 *         PROBE_BASE=http://localhost:3000 npm run probe:mobile-cta
 *         PROBE_SKU=GLC3333M npm run probe:mobile-cta
 * Exit:   0 = a fresh mobile guest can tap Add to Cart, and desktop is untouched
 *         1 = a control was covered, or the gate fired on the wrong surface
 *         2 = could not run (network / the page never rendered / no browser)
 */

import playwright from 'playwright';

const BASE = process.env.PROBE_BASE || 'https://www.inkcartridges.co.nz';
const SKU = process.env.PROBE_SKU || 'CLC37BK';
const PHONE = { width: 390, height: 844 };     // iPhone 13/14 — the handoff's viewport
const DESKTOP = { width: 1440, height: 900 };
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) '
    + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

/** The nudge's own numbers, mirrored so the probe waits for the real trigger. */
const NUDGE_SCROLL_PX = 600;                   // CAMPAIGN.scrollThresholdPx
const NUDGE_FLOOR_MS = 3000;                   // CAMPAIGN.delayMs
const SETTLE_MS = NUDGE_FLOOR_MS + 900;        // floor + auth hydration headroom
const TAP_BUDGET_MS = 2000;                    // the handoff's definition of done
/* The card's measured height at 390x844 (handoff table + this probe's own runs:
 * y 144-392). Used ONLY to reconstruct the band on a build where the nudge is
 * correctly suppressed, so the fixed build is interrogated at the same pixel the
 * broken one failed at. Never used as a reservation or an offset. */
const NUDGE_CARD_HEIGHT_PX = 248;

let pass = 0;
const failures = [];
const notes = [];
const ok = (n, d) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}${d ? ` — ${d}` : ''}`); };
const bad = (n, d) => { failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); };
const soft = (n, d) => { notes.push(`${n} — ${d}`); console.log(`  \x1b[33m~\x1b[0m ${n}\n      ${d}`); };
const check = (n, cond, d) => (cond ? ok(n, d) : bad(n, d));
const head = (t) => console.log(`\n\x1b[1m── ${t} ──\x1b[0m`);

/* ── The measurement ──────────────────────────────────────────────────────────
 *
 * Runs in the page. Returns, for each control, everything needed to decide
 * WHETHER THE QUESTION APPLIES before deciding the answer. `verdict` is the
 * only field a caller should branch on, and it is never 'blocked' for a control
 * the site is deliberately not showing.
 */
const MEASURE = () => {
    const q = (s) => document.querySelector(s);

    const describeHit = (el) => {
        if (!el) return 'nothing';
        const id = el.id ? `#${el.id}` : '';
        const cls = String(el.className || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
        return `${el.tagName.toLowerCase()}${id}${cls ? '.' + cls : ''}`;
    };

    /** A control's state first, its reachability second. */
    const control = (sel, hostSel) => {
        const el = q(sel);
        if (!el) return { sel, present: false, verdict: 'not-rendered' };

        const host = hostSel ? q(hostSel) : el;
        const cs = getComputedStyle(el);
        const hostCs = host ? getComputedStyle(host) : cs;
        const r = el.getBoundingClientRect();

        const state = {
            sel,
            present: true,
            display: cs.display,
            visibility: cs.visibility,
            opacity: cs.opacity,
            disabled: !!el.disabled,
            hostSel: hostSel || null,
            hostDisplay: host ? hostCs.display : null,
            hostTransform: host ? hostCs.transform : null,
            hostBottom: host ? hostCs.bottom : null,
            hostZIndex: host ? hostCs.zIndex : null,
            hostIsVisibleClass: host ? host.classList.contains('is-visible') : null,
            hostAriaHidden: host ? host.getAttribute('aria-hidden') : null,
            rect: { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), width: Math.round(r.width) },
            viewportHeight: window.innerHeight,
        };

        /* NOT RENDERED AT ALL. display:none on the control or its host — the
         * `@media (max-width: 768px) { .sticky-atc { display: block } }` case
         * inverted, and on desktop this is the normal, correct state. */
        if (cs.display === 'none' || (host && hostCs.display === 'none')) {
            return { ...state, verdict: 'not-displayed' };
        }

        /* HIDDEN BY DESIGN — THE ROW THE HANDOFF MISREAD.
         * .sticky-atc is translated fully off the bottom edge until
         * product-detail-page.js adds .is-visible (it does so only while
         * .product-info__actions is out of view). Its box still has
         * coordinates, and those coordinates overlap the consent banner,
         * because that is where a bar parked below the viewport edge lives. */
        if (host && host !== el && host.classList.contains('sticky-atc')
            && !host.classList.contains('is-visible')) {
            return { ...state, verdict: 'hidden-by-design' };
        }
        if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) {
            return { ...state, verdict: 'hidden-by-design' };
        }
        if (r.width === 0 || r.height === 0) {
            return { ...state, verdict: 'zero-box' };
        }
        if (r.bottom <= 0 || r.top >= window.innerHeight) {
            return { ...state, verdict: 'offscreen' };
        }

        /* Only now is the hit-test a meaningful question. Probe the control's
         * own centre, which is where a thumb lands. */
        const x = Math.round(r.left + r.width / 2);
        const y = Math.round(r.top + r.height / 2);
        const hit = document.elementFromPoint(x, y);
        const mine = !!hit && (hit === el || el.contains(hit) || hit.contains(el));
        return {
            ...state,
            hitPoint: { x, y },
            hit: describeHit(hit),
            verdict: mine ? 'reachable' : 'blocked',
        };
    };

    /** Every fixed/sticky layer that could be in the way, with its geometry. */
    const layers = [];
    document.querySelectorAll('body *').forEach((e) => {
        const cs = getComputedStyle(e);
        if (cs.position !== 'fixed' && cs.position !== 'sticky') return;
        const r = e.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return;
        layers.push({
            el: describeHit(e),
            position: cs.position,
            zIndex: cs.zIndex,
            top: Math.round(r.top),
            bottom: Math.round(r.bottom),
            height: Math.round(r.height),
        });
    });
    layers.sort((a, b) => (Number(b.zIndex) || 0) - (Number(a.zIndex) || 0));

    const nudge = q('#rewards-nudge');
    const nudgeState = (window.RewardsNudge && window.RewardsNudge._state) || null;

    return {
        url: location.pathname + location.search,
        scrollY: Math.round(window.scrollY),
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        inlineCta: control('#add-to-cart-btn'),
        stickyCta: control('#sticky-atc-btn', '#sticky-atc'),
        nudge: {
            inDom: !!nudge,
            open: !!nudge && nudge.classList.contains('is-open'),
            card: !!nudge && nudge.classList.contains('rewards-nudge--card'),
            zIndex: nudge ? getComputedStyle(nudge).zIndex : null,
            box: nudge ? (() => { const r = nudge.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) }; })() : null,
            /* Read straight off the module rather than inferred from pixels. A
             * nudge that has simply not mounted yet looks identical to one that
             * was suppressed, and only this field tells them apart. */
            suppressed: nudgeState ? nudgeState.suppressed : null,
            postAddArmed: nudgeState ? nudgeState.postAddArmed : null,
            moduleSeen: !!nudgeState,
        },
        banner: (() => {
            const b = q('#consent-banner');
            if (!b) return { present: false };
            const r = b.getBoundingClientRect();
            return {
                present: true,
                zIndex: getComputedStyle(b).zIndex,
                top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height),
                /* UNROUNDED, on purpose. consent-banner.js reserves
                 * Math.ceil(getBoundingClientRect().height), so a 148.4px bar
                 * reserves 149px and a probe comparing against a ROUNDED 148
                 * reports a 1px drift that is not there. Compare against the
                 * same arithmetic the code uses, not against a tidier number. */
                rawHeight: r.height,
                bodyHasClass: document.body.classList.contains('has-consent-banner'),
                reservedHeight: getComputedStyle(document.body).getPropertyValue('--consent-banner-height').trim() || null,
            };
        })(),
        layers: layers.slice(0, 8),
    };
};

/* ── THE WORST-CASE SCROLL, WHICH IS THE WHOLE POINT ──────────────────────────
 *
 * The first version of this probe scrolled to a fixed offset (threshold + 120)
 * and reported the inline button REACHABLE on a production build that was
 * definitively broken. It was not wrong about that pixel; it was asking at the
 * wrong pixel.
 *
 * The nudge is `position: fixed`, so it occupies a CONSTANT BAND of the
 * viewport — measured live at y 144-392 on a 390x844 phone. #add-to-cart-btn is
 * in normal flow, so it travels UP THROUGH that band as the page scrolls. It is
 * therefore unreachable for a window of roughly 250px of scroll and perfectly
 * reachable on either side of it. Measured on production 2026-09-20: the button
 * sits at document y 1271, so it is covered for scrollY 927-1127, and the
 * handoff's own reading (button at viewport y 264, i.e. scrollY 1007) lands
 * squarely inside that window.
 *
 * An arbitrary offset therefore samples a lottery. This computes the offset that
 * puts the button in the MIDDLE of the band and asks there — the one position
 * where the answer is not luck.
 *
 * When the nudge is correctly suppressed there is no band to read, so the band
 * it WOULD have occupied is reconstructed from the sticky header, which is what
 * position() anchors to (`header.bottom + 8`). Testing the fixed build at the
 * same place as the broken one is the only way the two runs compare.
 */
const WORST_CASE_SCROLL = (fallbackCardHeight) => {
    const cta = document.querySelector('#add-to-cart-btn');
    if (!cta) return null;
    const nudge = document.querySelector('#rewards-nudge');
    let bandTop;
    let bandHeight;
    if (nudge && nudge.getBoundingClientRect().height > 0) {
        const nr = nudge.getBoundingClientRect();
        bandTop = nr.top;
        bandHeight = nr.height;
    } else {
        const header = document.querySelector('.site-header');
        const hb = header ? header.getBoundingClientRect().bottom : 0;
        bandTop = Math.max(hb + 8, 12);      // EDGE_MARGIN / position()'s own arithmetic
        bandHeight = fallbackCardHeight;
    }
    const bandCentre = bandTop + bandHeight / 2;
    const r = cta.getBoundingClientRect();
    const ctaCentreFromTop = r.top + r.height / 2;
    return {
        scrollTo: Math.max(0, Math.round(window.scrollY + ctaCentreFromTop - bandCentre)),
        band: { top: Math.round(bandTop), bottom: Math.round(bandTop + bandHeight), reconstructed: !nudge },
    };
};

/** Print a control the way a human reads it: state, then verdict. */
function describeControl(label, c) {
    if (!c.present) { console.log(`    ${label.padEnd(14)} not in the DOM`); return; }
    const bits = [`display=${c.display}`];
    if (c.hostSel) {
        bits.push(`host ${c.hostSel} display=${c.hostDisplay}`);
        if (c.hostIsVisibleClass !== null) bits.push(`is-visible=${c.hostIsVisibleClass}`);
        if (c.hostAriaHidden !== null) bits.push(`aria-hidden=${c.hostAriaHidden}`);
        if (c.hostBottom) bits.push(`bottom=${c.hostBottom}`);
        if (c.hostZIndex) bits.push(`z=${c.hostZIndex}`);
    }
    console.log(`    ${label.padEnd(14)} y ${c.rect.top}-${c.rect.bottom} (${c.rect.height}px) · ${bits.join(' · ')}`);
    console.log(`    ${''.padEnd(14)} verdict: \x1b[1m${c.verdict}\x1b[0m${c.hit ? ` (elementFromPoint at its own centre -> ${c.hit})` : ''}`);
}

/**
 * Land on the PDP as a brand-new guest, let the nudge's floor elapse, then
 * scroll past its threshold — which is the only way to make it mount.
 */
async function openPdp(ctx, { scrollTo = NUDGE_SCROLL_PX + 120 } = {}) {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/p/${SKU}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('#add-to-cart-btn', { timeout: 30000 });
    await page.waitForTimeout(SETTLE_MS);
    await page.evaluate((y) => window.scrollTo(0, y), scrollTo);
    await page.waitForTimeout(1200);           // let onReflow re-pin and the card open
    return page;
}

/**
 * Move to the scroll position where the buy button sits inside the band the
 * nudge occupies (or would occupy). Returns what it aimed at, so the run can
 * PRINT the position rather than leave the reader guessing which pixel failed.
 */
async function scrollToWorstCase(page) {
    const plan = await page.evaluate(WORST_CASE_SCROLL, NUDGE_CARD_HEIGHT_PX);
    if (!plan) return null;
    await page.evaluate((y) => window.scrollTo(0, y), plan.scrollTo);
    await page.waitForTimeout(900);            // onReflow re-pins on the next frame
    return plan;
}

/**
 * Poll until the inline Add to Cart answers its own hit-test, or the budget
 * runs out. Returns the elapsed ms, or null if it never became reachable.
 */
async function timeToReachable(page, budgetMs) {
    const started = Date.now();
    for (;;) {
        const m = await page.evaluate(MEASURE);
        if (m.inlineCta.verdict === 'reachable') return { ms: Date.now() - started, measurement: m };
        if (Date.now() - started > budgetMs) return { ms: null, measurement: m };
        await page.waitForTimeout(100);
    }
}

/* ── Engine selection, stated out loud ────────────────────────────────────── */

async function launchEngine() {
    // WebKit first: the handoff measured Safari, and 70 of 81 mobile checkouts
    // were iOS Safari. Fall back rather than fail — an unmeasured P0 is worse
    // than one measured on the wrong engine, as long as the engine is PRINTED.
    if (playwright.webkit) {
        try {
            const browser = await playwright.webkit.launch();
            return { browser, engine: 'webkit', emulatesIos: false };
        } catch (err) {
            soft('WebKit is not installed — falling back to chromium + iPhone UA',
                `${String(err.message).split('\n')[0]}. Install it with \`npx playwright install webkit\` `
                + 'to measure the engine 70 of 81 mobile checkouts actually use. '
                + 'The geometry below is chromium\'s, emulating iOS.');
        }
    }
    const browser = await playwright.chromium.launch();
    return { browser, engine: 'chromium', emulatesIos: true };
}

console.log('\n\x1b[1mprobe:mobile-cta — can a fresh mobile guest tap Add to Cart? (ERR-276)\x1b[0m');
console.log('\x1b[33mMODE: READ-ONLY.\x1b[0m No --record, no --update-baseline, no ctx.route(), no cart writes.');
console.log('The only DOM write is §5\'s synthetic overlay, in a context closed immediately after.');
console.log(`Target: ${BASE}   SKU: ${SKU}   Phone: ${PHONE.width}x${PHONE.height}   Desktop: ${DESKTOP.width}x${DESKTOP.height}`);

const { browser, engine, emulatesIos } = await launchEngine();
console.log(`\x1b[1mEngine: ${engine}\x1b[0m${emulatesIos ? ' (emulating iOS via UA + isMobile + hasTouch)' : ' (real WebKit)'}`);
console.log(`Nudge trigger mirrored from CAMPAIGN: floor ${NUDGE_FLOOR_MS}ms, then scrollY >= ${NUDGE_SCROLL_PX}px\n`);

const phoneCtx = () => browser.newContext({
    viewport: PHONE,
    userAgent: emulatesIos ? IPHONE_UA : undefined,
    isMobile: emulatesIos ? true : undefined,
    hasTouch: true,
    deviceScaleFactor: 3,
});

let fatal = null;
try {
    /* ══ §1 the definition of done ══════════════════════════════════════════ */
    head('§1 PDP, phone, brand-new guest — is Add to Cart tappable?');
    {
        const ctx = await phoneCtx();
        const page = await openPdp(ctx);
        const plan = await scrollToWorstCase(page);
        if (plan) {
            console.log(`  worst case: scrollY ${plan.scrollTo} puts #add-to-cart-btn inside the band `
                + `y ${plan.band.top}-${plan.band.bottom}${plan.band.reconstructed ? ' (reconstructed from the header — no nudge mounted)' : ' (the mounted nudge)'}`);
        } else {
            soft('could not compute the worst-case scroll', '#add-to-cart-btn was not in the DOM');
        }
        const { ms, measurement: m } = await timeToReachable(page, TAP_BUDGET_MS);

        console.log(`  at ${m.url}  scrollY=${m.scrollY}  viewport=${m.innerWidth}x${m.innerHeight}`);
        console.log(`  fixed/sticky layers, highest z first:`);
        for (const l of m.layers) console.log(`    z=${String(l.zIndex).padEnd(7)} ${l.el.padEnd(46)} y ${l.top}-${l.bottom} (${l.height}px)`);
        describeControl('inline ATC', m.inlineCta);
        describeControl('sticky ATC', m.stickyCta);
        console.log(`    nudge          inDom=${m.nudge.inDom} open=${m.nudge.open} card=${m.nudge.card} z=${m.nudge.zIndex}`
            + `${m.nudge.box ? ` y ${m.nudge.box.top}-${m.nudge.box.bottom}` : ''}`);
        console.log(`    nudge module   suppressed=${m.nudge.suppressed} postAddArmed=${m.nudge.postAddArmed}`);

        check('an Add-to-Cart control is tappable within 2s, dismissing nothing',
            ms !== null,
            ms !== null
                ? `reachable after ${ms}ms`
                : `#add-to-cart-btn verdict "${m.inlineCta.verdict}"`
                  + (m.inlineCta.hit ? `, covered by ${m.inlineCta.hit}` : '')
                  + ` — the definition of done in the handoff is a tap within ${TAP_BUDGET_MS}ms `
                  + 'as a first-time guest, without dismissing anything');

        check('the rewards nudge is not painted over the buy button',
            !(m.nudge.inDom && m.nudge.open && m.inlineCta.verdict === 'blocked'),
            m.nudge.inDom
                ? `nudge is in the DOM (open=${m.nudge.open}) and the button reports "${m.inlineCta.verdict}"`
                : 'nudge never mounted on this surface');

        check('the module says it suppressed itself, rather than merely not having mounted',
            m.nudge.moduleSeen && m.nudge.suppressed === true,
            m.nudge.moduleSeen
                ? `RewardsNudge._state.suppressed = ${m.nudge.suppressed}`
                : 'window.RewardsNudge was not found — js/rewards-nudge.js did not load on this page');

        check('the ask was MOVED, not deleted: the post-add trigger is armed',
            m.nudge.postAddArmed === true,
            `RewardsNudge._state.postAddArmed = ${m.nudge.postAddArmed}. If this is false the nudge `
            + 'is simply gone on mobile, which is a silent loss of every mobile account signup.');

        await ctx.close();
    }

    /* ══ §2 the sticky bar, measured in the state where the question applies ══ */
    head('§2 the sticky bar — and the state the handoff measured it in');
    {
        const ctx = await phoneCtx();
        // Scroll far enough that .product-info__actions leaves the viewport, which
        // is the ONLY state in which product-detail-page.js shows this bar.
        const page = await openPdp(ctx, { scrollTo: 2600 });
        const m = await page.evaluate(MEASURE);

        console.log(`  scrollY=${m.scrollY}  banner present=${m.banner.present}`
            + `${m.banner.present ? ` z=${m.banner.zIndex} y ${m.banner.top}-${m.banner.bottom} (${m.banner.height}px)` : ''}`);
        if (m.banner.present) {
            console.log(`  body.has-consent-banner=${m.banner.bodyHasClass}  --consent-banner-height=${m.banner.reservedHeight || 'unset'}`);
        }
        describeControl('sticky ATC', m.stickyCta);

        if (!m.banner.present) {
            soft('the consent banner was not showing — the stacking question was not asked',
                'this context is fresh, so the banner should be up. Either it was dismissed, or '
                + 'consent-banner.js did not run. Nothing was proved about the lift.');
        } else if (m.stickyCta.verdict === 'hidden-by-design' || m.stickyCta.verdict === 'not-displayed') {
            soft('the sticky bar was not shown, so it could not be covered',
                `verdict "${m.stickyCta.verdict}" (is-visible=${m.stickyCta.hostIsVisibleClass}, `
                + `transform=${m.stickyCta.hostTransform}). THIS IS THE STATE THE HANDOFF MEASURED AND `
                + 'reported as BLOCKED. A hidden control is not an occluded one — nothing failed here, '
                + 'and nothing passed either.');
        } else {
            check('the VISIBLE sticky bar is clear of the consent banner (ERR-238 lift holds)',
                m.stickyCta.verdict === 'reachable',
                m.stickyCta.verdict === 'reachable'
                    ? `lifted to bottom=${m.stickyCta.hostBottom} against a ${m.banner.height}px banner`
                    : `verdict "${m.stickyCta.verdict}", covered by ${m.stickyCta.hit}. `
                      + 'body.has-consent-banner .sticky-atc { bottom: var(--consent-banner-height) } '
                      + 'is the rule that should prevent this (css/components.css).');

            const expectedReserve = `${Math.ceil(m.banner.rawHeight)}px`;
            check('the lift is the MEASURED banner height, not a constant',
                m.banner.reservedHeight === expectedReserve,
                `--consent-banner-height=${m.banner.reservedHeight || 'unset'}, expected ${expectedReserve} `
                + `from a banner measuring ${m.banner.rawHeight.toFixed(2)}px. consent-banner.js reserves `
                + 'Math.ceil(rect.height) and keeps it live with a ResizeObserver; a stale value is how '
                + '17px of the ERR-233 collision came straight back.');
        }
        await ctx.close();
    }

    /* ══ §3 desktop must be untouched ═══════════════════════════════════════ */
    head('§3 desktop — the nudge must still work exactly as before');
    {
        const ctx = await browser.newContext({ viewport: DESKTOP });
        const page = await ctx.newPage();
        await page.goto(`${BASE}/p/${SKU}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('#add-to-cart-btn', { timeout: 30000 });
        await page.waitForTimeout(SETTLE_MS);
        await page.evaluate((y) => window.scrollTo(0, y), NUDGE_SCROLL_PX + 120);
        await page.waitForTimeout(2000);
        const m = await page.evaluate(MEASURE);

        console.log(`  viewport=${m.innerWidth}x${m.innerHeight}  scrollY=${m.scrollY}`);
        console.log(`    nudge          inDom=${m.nudge.inDom} open=${m.nudge.open} card=${m.nudge.card} suppressed=${m.nudge.suppressed}`);
        describeControl('inline ATC', m.inlineCta);

        check('the gate did NOT fire on desktop', m.nudge.suppressed === false,
            `RewardsNudge._state.suppressed = ${m.nudge.suppressed}. The fix is scoped to narrow `
            + 'viewports; suppressing it here would quietly delete desktop account signups, which '
            + 'is the failure mode with no symptom.');

        check('the desktop nudge is NOT in card mode', !m.nudge.card,
            `rewards-nudge--card present = ${m.nudge.card} at ${m.innerWidth}px. The card is the `
            + 'full-width fixed layout that causes the occlusion; above the tablet breakpoint the '
            + 'nudge must stay anchored to the Account button.');

        if (!m.nudge.inDom) {
            soft('the desktop nudge did not mount during this run',
                'it is once-per-session and has a 7-day dismissal cooldown, but this context is '
                + 'fresh, so the likelier cause is that the scroll trigger had not fired yet. '
                + `suppressed=${m.nudge.suppressed} is the field that actually answers §3, and it did.`);
        }
        await ctx.close();
    }

    /* ══ §4 the browsing surfaces keep their nudge ══════════════════════════ */
    head('§4 the gate is narrow — a browsing page on a phone still gets the nudge');
    {
        const ctx = await phoneCtx();
        const page = await ctx.newPage();
        await page.goto(`${BASE}/ink-cartridges`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(SETTLE_MS);
        await page.evaluate((y) => window.scrollTo(0, y), NUDGE_SCROLL_PX + 120);
        await page.waitForTimeout(1500);
        const m = await page.evaluate(MEASURE);

        console.log(`  at ${m.url}  suppressed=${m.nudge.suppressed} inDom=${m.nudge.inDom} open=${m.nudge.open}`);
        check('/ink-cartridges is NOT on the suppression list',
            m.nudge.moduleSeen && m.nudge.suppressed === false,
            m.nudge.moduleSeen
                ? `suppressed=${m.nudge.suppressed}. The gate is deliberately scoped to the buying `
                  + 'path (/products, /product, /ribbon, /cart, /checkout, /payment). If a browsing '
                  + 'page is being suppressed, narrowSkipPaths has a prefix that is too greedy.'
                : 'window.RewardsNudge not found on this page');
        await ctx.close();
    }

    /* ══ §5 NEGATIVE CONTROL — prove this probe can go red ══════════════════ */
    head('§5 negative control — can this probe detect an occlusion at all?');
    {
        const ctx = await phoneCtx();
        const page = await openPdp(ctx);
        await scrollToWorstCase(page);

        const before = await page.evaluate(MEASURE);
        if (before.inlineCta.verdict !== 'reachable') {
            soft('the negative control could not run',
                `#add-to-cart-btn was "${before.inlineCta.verdict}" before the overlay went in, so `
                + 'covering it proves nothing. Fix §1 first.');
        } else {
            const after = await page.evaluate(() => {
                const cta = document.querySelector('#add-to-cart-btn');
                const r = cta.getBoundingClientRect();
                const veil = document.createElement('div');
                veil.id = 'probe-synthetic-occluder';
                veil.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;`
                    + `width:${r.width}px;height:${r.height}px;z-index:2147483647;background:transparent;`;
                document.body.appendChild(veil);
                return true;
            });
            const m = await page.evaluate(MEASURE);
            describeControl('inline ATC', m.inlineCta);
            check('a synthetic overlay makes this probe report BLOCKED',
                after && m.inlineCta.verdict === 'blocked'
                    && String(m.inlineCta.hit).includes('probe-synthetic-occluder'),
                `verdict "${m.inlineCta.verdict}", hit "${m.inlineCta.hit}". If this passes while an `
                + 'element is demonstrably on top of the button, every green run in §1 is green '
                + 'because the check is dead, not because the button is reachable (ERR-258).');
        }
        await ctx.close();
    }
} catch (err) {
    fatal = err;
} finally {
    await browser.close();
}

console.log('\n────────────────────────────────────────────────────────');
console.log(`Engine: ${engine}${emulatesIos ? ' (iOS emulation)' : ''}`);
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
console.log('\x1b[32mA first-time guest on a phone can tap Add to Cart, and desktop is unchanged.\x1b[0m');
process.exit(0);
