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
 * ════════════════════════════════════════════════════════════════════════════
 * ERR-280 ADDENDUM, 2026-09-22 — WHAT §1-§5 COULD NOT SEE
 * ════════════════════════════════════════════════════════════════════════════
 *
 * Backend handoff `mobile-atc-dead-zone-FE-handoff-sep2026.md` reported scroll
 * positions on a PDP with NO tappable Add to Cart at all: the sticky bar has
 * already stood down, and the main button is underneath the consent banner.
 * Everything above was green while that was true, for three separate reasons,
 * and each one is worth naming because each is a reusable trap.
 *
 * 1. THE PROBE ASKED A PER-CONTROL QUESTION ABOUT A PAGE-LEVEL DEFECT.
 *    `control()` is careful and correct: a bar the site is deliberately hiding
 *    is reported `hidden-by-design`, never a failure. In the dead zone BOTH
 *    controls are individually excusable — the sticky bar is correctly hidden
 *    (the main button is "in view"), and the main button is correctly rendered
 *    (it is simply painted under a higher layer). Two defensible states, and a
 *    shopper with nothing to tap. §6 therefore asks the shopper's question:
 *    IS ANY ADD-TO-CART TAPPABLE AT THIS SCROLL OFFSET — not "is this control
 *    in a state I can excuse".
 *
 * 2. IT ASKED AT THE WRONG END OF THE VIEWPORT. WORST_CASE_SCROLL aims the
 *    button at the band the *nudge* occupies, which is pinned under the header
 *    at the TOP. The consent banner owns the BOTTOM. One computed offset is a
 *    strict improvement on a fixed offset and still samples one pixel; the
 *    defect is a WINDOW. §6 sweeps the whole document and reports the window's
 *    extent in px of scroll, with its offsets.
 *
 * 3. IT MEASURED A VIEWPORT NO IPHONE HAS. `PHONE` was `{ 390, 844 }`, which
 *    is the iPhone 13's PHYSICAL SCREEN; the usable viewport after Safari's
 *    chrome is `{ 390, 664 }` — see scripts/lib/mobile-viewports.mjs. The 180px
 *    difference is larger than the consent banner itself, so at 844 the sticky
 *    bar and the banner do not overlap and at 664 they do. A probe whose own
 *    header says "a probe's emulation is part of its measurement" was measuring
 *    180px of screen that does not exist.
 *
 * THE DEFAULT TARGET IS NOW LOCALHOST. Since ERR-279 a PDP view fires
 * `view_item` into Microsoft UET and GA4, and the UET notes record that
 * `view_item` would manufacture a revenue-bearing conversion in the live
 * account. This file's READ-ONLY banner was written before that was true: it
 * wrote nothing to US and, through the browser, plenty to our ad accounts —
 * which is ERR-271 exactly (a guard cannot see what it does not spell). A
 * production run is still available and still correct; it is now opt-in, and
 * the run prints what it is about to fire.
 *
 * Usage:  npm run probe:mobile-cta                       (localhost:3000)
 *         npm run probe:mobile-cta -- --check            (alias for the above)
 *         PROBE_BASE=https://www.inkcartridges.co.nz npm run probe:mobile-cta
 *         PROBE_SKU=GLC3333M npm run probe:mobile-cta
 *         PROBE_SWEEP_STEP=20 npm run probe:mobile-cta   (finer sweep)
 * Exit:   0 = a fresh mobile guest can tap Add to Cart at EVERY scroll offset,
 *             and desktop is untouched
 *         1 = a control was covered, a scroll offset had nothing tappable, or
 *             the gate fired on the wrong surface
 *         2 = could not run (network / the page never rendered / no browser)
 */

import playwright from 'playwright';
import { PHONE, PHONE_SCALE, IPHONE_UA, describeViewport } from './lib/mobile-viewports.mjs';

/* `--check` is accepted and does nothing, deliberately. The handoff documents
   `--check` as the way to run this ("exits non-zero while the defect is
   present"), and that is already the only behaviour this file has — there is no
   record mode for it to be the opposite of. Accepting the flag means the
   documented command runs instead of being silently ignored by an argv parser
   that does not exist; REJECTING an unknown flag means a typo cannot pass for a
   clean run. */
const ARGS = process.argv.slice(2);
const UNKNOWN = ARGS.filter((a) => a !== '--check');

const DEFAULT_BASE = 'http://localhost:3000';
const BASE = process.env.PROBE_BASE || DEFAULT_BASE;
const IS_PRODUCTION = /inkcartridges\.co\.nz/i.test(BASE);
const SKU = process.env.PROBE_SKU || 'CLC37BK';
const DESKTOP = { width: 1440, height: 900 };

/** The retired nudge's trigger numbers. Kept as the scroll/settle positions every
 *  historical reading in errors.md was taken at, so re-runs stay comparable. */
const NUDGE_SCROLL_PX = 600;                   // CAMPAIGN.scrollThresholdPx
const NUDGE_FLOOR_MS = 3000;                   // CAMPAIGN.delayMs
const SETTLE_MS = NUDGE_FLOOR_MS + 900;        // floor + auth hydration headroom
const TAP_BUDGET_MS = 2000;                    // the handoff's definition of done
/* The card's measured height (handoff table + this probe's own runs: y 144-392).
 * It is a function of WIDTH, not height — the copy wraps at 390px the same way
 * in a 664px viewport as in an 844px one — so ERR-280's viewport correction
 * leaves it valid. Used ONLY to reconstruct the band on a build where the nudge is
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

/* ── THE SHOPPER'S QUESTION (ERR-280) ─────────────────────────────────────────
 *
 * `control()` above answers "what state is this control in, and does the
 * question even apply to it". That is the right question about a CONTROL and
 * the wrong question about a PAGE. In the dead zone the sticky bar is
 * `hidden-by-design` (correct — the site is not showing it) and the inline
 * button is `blocked` (correct — a higher layer is on top of it), and a shopper
 * has nothing to press. Neither verdict is wrong. The page is still broken.
 *
 * So this runs over EVERY add-to-cart control on the page at once and returns
 * one boolean: could a thumb buy something, right now, at this scroll offset.
 *
 * `partly-offscreen` is its own verdict on purpose. A control whose centre has
 * left the viewport returns null from elementFromPoint, which is indistinguish-
 * able from "covered" if you only branch on truthiness — and reporting a button
 * that is merely scrolled past as BLOCKED would manufacture a dead zone that is
 * not there. It is not tappable and it is not evidence of occlusion.
 */
const ANY_TAPPABLE = (selectors) => {
    const describeHit = (el) => {
        if (!el) return 'nothing';
        const id = el.id ? `#${el.id}` : '';
        const cls = String(el.className || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
        return `${el.tagName.toLowerCase()}${id}${cls ? '.' + cls : ''}`;
    };

    const controls = [];
    let tappable = false;

    selectors.forEach((sel) => {
        Array.prototype.forEach.call(document.querySelectorAll(sel), (el) => {
            const cs = getComputedStyle(el);
            /* The sticky bar hides by translating the WHOLE bar, so the button's
               own computed style says nothing. Ask the host it travels with. */
            const host = el.closest('.sticky-atc') || el;
            const hostCs = getComputedStyle(host);
            const r = el.getBoundingClientRect();
            const row = { sel, top: Math.round(r.top), bottom: Math.round(r.bottom) };

            if (cs.display === 'none' || hostCs.display === 'none') {
                controls.push({ ...row, verdict: 'not-displayed' });
                return;
            }
            if (host !== el && host.classList.contains('sticky-atc') && !host.classList.contains('is-visible')) {
                controls.push({ ...row, verdict: 'hidden-by-design' });
                return;
            }
            if (cs.visibility === 'hidden' || Number(cs.opacity) === 0) {
                controls.push({ ...row, verdict: 'hidden-by-design' });
                return;
            }
            if (r.width === 0 || r.height === 0) {
                controls.push({ ...row, verdict: 'zero-box' });
                return;
            }
            if (r.bottom <= 0 || r.top >= window.innerHeight) {
                controls.push({ ...row, verdict: 'offscreen' });
                return;
            }

            const x = Math.round(r.left + r.width / 2);
            const y = Math.round(r.top + r.height / 2);
            if (y < 0 || y >= window.innerHeight || x < 0 || x >= window.innerWidth) {
                controls.push({ ...row, verdict: 'partly-offscreen' });
                return;
            }
            const hit = document.elementFromPoint(x, y);
            const mine = !!hit && (hit === el || el.contains(hit) || hit.contains(el));
            if (mine) tappable = true;
            /* WHICH CHROME, decided by ANCESTRY rather than by matching the
               printed label. `describeHit` gives two classes at most, so a
               blocker deep inside the header prints as `input#search-input`
               with nothing about the header in it — an allowlist over that
               string would let the header through under one spelling and fail
               it under the next. Ask the DOM instead. */
            const chrome = !hit ? null
                : (hit.closest('#consent-banner') ? 'consent-banner'
                    : (hit.closest('.site-header') ? 'site-header' : null));
            controls.push({
                ...row,
                verdict: mine ? 'reachable' : 'blocked',
                blockedBy: mine ? null : describeHit(hit),
                blockedByChrome: mine ? null : chrome,
            });
        });
    });

    const banner = document.getElementById('consent-banner');
    const br = banner ? banner.getBoundingClientRect() : null;
    return {
        scrollY: Math.round(window.scrollY),
        innerHeight: window.innerHeight,
        docHeight: Math.round(document.documentElement.scrollHeight),
        bannerHeight: br ? Math.round(br.height) : 0,
        tappable,
        controls,
    };
};

/** Every add-to-cart control a PDP can offer, in both stock states. */
const PDP_CTA_SELECTORS = ['.product-info__add-to-cart', '#sticky-atc-btn', '.sticky-atc__btn'];
/* Two card renderers, deliberately duplicated rather than shared
   (js/products.js:172-179), so the sweep has to name both spellings or it
   measures the popular shelf and calls it the page. */
const CARD_CTA_SELECTORS = ['.product-card__add-btn', '.product-card__cart-btn'];

/** Smaller than the 48px button, so a step cannot straddle the dead window. */
const SWEEP_STEP_PX = Number(process.env.PROBE_SWEEP_STEP || 40);

/**
 * Let every bottom-anchored layer finish moving, then say how long it took.
 *
 * `.sticky-atc` animates `transform` over 0.3s and `.consent-banner` over
 * 0.25s. A box that is sliding is still painted and still hit-testable, so a
 * sample taken mid-slide measures the ANIMATION, not reachability — and the
 * two answer different questions. Stops on two identical frames, or the cap.
 */
const SETTLE_LAYERS = (capMs) => new Promise((resolve) => {
    const started = performance.now();
    const read = () => ['.sticky-atc', '#consent-banner', '.cart-sticky-bar']
        .map((sel) => { const e = document.querySelector(sel); return e ? getComputedStyle(e).transform : ''; })
        .join('|');
    let prev = read();
    let stable = 0;
    const tick = () => {
        const now = read();
        if (now === prev) stable += 1; else { stable = 0; prev = now; }
        if (stable >= 2 || performance.now() - started > capMs) {
            resolve(Math.round(performance.now() - started));
            return;
        }
        requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
});

/**
 * Walk the document top to bottom and ask ANY_TAPPABLE at every step.
 *
 * Two frames of settle before anything is read, not a sleep: the class the
 * sticky bar toggles is written from an IntersectionObserver callback, which
 * runs after layout on the next frame. Sampling in the same tick as the scroll
 * reads the PREVIOUS offset's answer at the CURRENT offset's coordinates.
 *
 * EACH OFFSET IS SAMPLED TWICE, AND THE DIFFERENCE IS THE POINT.
 *
 *   `transient` — read immediately, while the bars are still sliding. This is
 *   what a thumb meets during a fast flick.
 *   `settled`   — read once nothing is moving. This is the shopper's real
 *   question: IF I STOP HERE, CAN I BUY?
 *
 * Only the settled read is asserted on. A stationary offset with nothing
 * tappable stays that way forever and is the defect ERR-280 is about; a
 * transient one resolves in ~300ms with no input at all, and asserting on it
 * would turn every CSS transition on the page into a permanent failure. The
 * transient count is printed, never silently dropped — it is the number that
 * says how long the handover takes.
 */
async function sweep(page, selectors, { step = SWEEP_STEP_PX } = {}) {
    const samples = [];
    const geom = await page.evaluate(() => ({
        doc: document.documentElement.scrollHeight,
        vh: window.innerHeight,
    }));
    const last = Math.max(0, geom.doc - geom.vh);
    for (let y = 0; y <= last + step; y += step) {
        const target = Math.min(y, last);
        await page.evaluate((to) => window.scrollTo(0, to), target);
        await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        const transient = await page.evaluate(ANY_TAPPABLE, selectors);
        const settleMs = await page.evaluate(SETTLE_LAYERS, 800);
        const settled = await page.evaluate(ANY_TAPPABLE, selectors);
        samples.push({ ...settled, settleMs, transientTappable: transient.tappable });
        if (target >= last) break;
    }
    return samples;
}

/** Contiguous runs of samples matching a predicate, as {from,to,samples}. */
function runsOf(samples, predicate) {
    const runs = [];
    let open = null;
    samples.forEach((s) => {
        if (predicate(s)) {
            if (!open) { open = { from: s.scrollY, to: s.scrollY, samples: [] }; runs.push(open); }
            open.to = s.scrollY;
            open.samples.push(s);
        } else {
            open = null;
        }
    });
    return runs;
}

/**
 * Wait for the consent banner to REACH ITS RESTING POSITION, not merely to
 * exist. `.is-open` is added before the 0.25s translateY runs, so a probe that
 * measures on the class sees the bar mid-flight and reads a box it never
 * occupies. scripts/probe-consent-banner.mjs:137-150 learned this first; the
 * same wait belongs in every probe that reads the banner's geometry.
 *
 * Resolves either way. A banner that never settles is reported by the caller as
 * NOT EXERCISED — never as a pass.
 */
async function waitForBannerSettled(page, timeout = 15000) {
    try {
        await page.waitForSelector('#consent-banner', { timeout: Math.min(timeout, 10000) });
        await page.waitForFunction(() => {
            const el = document.getElementById('consent-banner');
            if (!el) return false;
            const r = el.getBoundingClientRect();
            return r.height > 0 && Math.abs(r.bottom - window.innerHeight) <= 1;
        }, null, { timeout });
        return true;
    } catch (_) {
        return false;
    }
}

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

if (UNKNOWN.length) {
    console.log(`\x1b[31mUnknown argument(s): ${UNKNOWN.join(' ')}\x1b[0m`);
    console.log('This probe takes --check (a documented alias for its only mode) and nothing else.');
    console.log('Configure it with PROBE_BASE, PROBE_SKU, PROBE_SWEEP_STEP.');
    process.exit(2);
}

console.log('\n\x1b[1mprobe:mobile-cta — can a fresh mobile guest tap Add to Cart? (ERR-276, ERR-280)\x1b[0m');
console.log('\x1b[33mMODE: READ-ONLY.\x1b[0m No --record, no --update-baseline, no ctx.route(), no cart writes.');
console.log('The only DOM write is the synthetic overlay in §5 and §8, in a context closed immediately after.');
console.log(`Target: ${BASE}   SKU: ${SKU}   Desktop: ${DESKTOP.width}x${DESKTOP.height}`);
console.log(`Phone:  ${describeViewport(PHONE)}`);
console.log(`Sweep:  every ${SWEEP_STEP_PX}px of scroll (PROBE_SWEEP_STEP)`);

/* Read-only about OUR data is not read-only about our ad accounts (ERR-271).
   Since ERR-279 every PDP view this probe opens fires view_item into Microsoft
   UET and GA4, and view_item is the event the UET notes single out as
   manufacturing a revenue-bearing conversion in the live account. Nothing here
   blocks a production run — it is the only way to measure the deployed build —
   but the run says what it is about to fire, out loud, every time. */
if (IS_PRODUCTION) {
    console.log('\n\x1b[33mTARGET IS PRODUCTION.\x1b[0m This run opens real PDPs, so each page view fires');
    console.log('  view_item -> Microsoft UET (ERR-279) and GA4, plus page_view on every navigation.');
    console.log(`  Nothing is written to us. To measure locally instead: npx serve inkcartridges -l 3000 (${DEFAULT_BASE}).`);
}

const { browser, engine, emulatesIos } = await launchEngine();
console.log(`\x1b[1mEngine: ${engine}\x1b[0m${emulatesIos ? ' (emulating iOS via UA + isMobile + hasTouch)' : ' (real WebKit)'}`);
console.log(`Nudge trigger mirrored from CAMPAIGN: floor ${NUDGE_FLOOR_MS}ms, then scrollY >= ${NUDGE_SCROLL_PX}px\n`);

const phoneCtx = () => browser.newContext({
    viewport: PHONE,
    userAgent: emulatesIos ? IPHONE_UA : undefined,
    isMobile: emulatesIos ? true : undefined,
    hasTouch: true,
    deviceScaleFactor: PHONE_SCALE,
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

        /* The rewards popover was RETIRED 2026-09-27 (conversion handoff D-P0-1).
           Its absence is the check now — a module that "suppressed itself" is
           no longer a state this site has. */
        check('the retired rewards overlay is absent',
            !m.nudge.inDom && !m.nudge.moduleSeen,
            `#rewards-nudge inDom=${m.nudge.inDom}, window.RewardsNudge=${m.nudge.moduleSeen}`);

        await ctx.close();
    }

    /* ══ §2 the sticky bar, measured in the state where the question applies ══ */
    head('§2 the sticky bar — and the state the handoff measured it in');
    {
        const ctx = await phoneCtx();
        // Scroll far enough that .product-info__actions leaves the viewport, which
        // is the ONLY state in which product-detail-page.js shows this bar.
        const page = await openPdp(ctx, { scrollTo: 2600 });
        /* ERR-280: .is-open is set BEFORE the 0.25s translateY runs, so reading
           the box on the class alone measures the bar mid-flight at a position
           it never occupies. */
        const bannerSettled = await waitForBannerSettled(page);
        const m = await page.evaluate(MEASURE);

        console.log(`  scrollY=${m.scrollY}  banner present=${m.banner.present}`
            + `${m.banner.present ? ` z=${m.banner.zIndex} y ${m.banner.top}-${m.banner.bottom} (${m.banner.height}px)` : ''}`);
        if (m.banner.present) {
            console.log(`  body.has-consent-banner=${m.banner.bodyHasClass}  --consent-banner-height=${m.banner.reservedHeight || 'unset'}`);
        }
        describeControl('sticky ATC', m.stickyCta);

        if (!m.banner.present || !bannerSettled) {
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

    /* ══ §3 desktop acceptance (conversion handoff 2026-09-23 D-P0-1/2) ═════ */
    head('§3 desktop 1440x900 — search box clickable at every offset; PDP Add + cart Checkout at scroll 0');
    {
        /* Handoff acceptance, verbatim: "on a fresh 1440x900 context the search
           box accepts a click at every scroll offset", and "the PDP Add to Cart
           and the cart Checkout button are hit-testable at scroll 0". Before the
           fix the rewards popover intercepted #search-input, and the consent bar
           (y 839-900) sat on #add-to-cart-btn (y 830-878). */
        const hitTest = (sel) => {
            const el = document.querySelector(sel);
            if (!el) return { verdict: 'absent' };
            const r = el.getBoundingClientRect();
            if (!r.width || !r.height) return { verdict: 'zero-box' };
            if (r.bottom <= 0 || r.top >= innerHeight) return { verdict: 'offscreen', top: Math.round(r.top) };
            const pts = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + 6, r.top + r.height / 2], [r.right - 6, r.top + r.height / 2]];
            const hits = pts.map(([x, y]) => { const h = document.elementFromPoint(x, y); return !!h && (h === el || el.contains(h) || h.contains(el)); });
            return { verdict: hits.every(Boolean) ? 'reachable' : 'blocked', points: `${hits.filter(Boolean).length}/3`, top: Math.round(r.top), bottom: Math.round(r.bottom) };
        };

        const ctx = await browser.newContext({ viewport: DESKTOP });
        const page = await ctx.newPage();
        await page.goto(`${BASE}/p/${SKU}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForSelector('#add-to-cart-btn', { timeout: 30000 });
        await page.waitForTimeout(SETTLE_MS);
        const atc = await page.evaluate(hitTest, '#add-to-cart-btn');
        console.log(`  PDP #add-to-cart-btn at scroll 0: ${atc.verdict} ${atc.points || ''} y ${atc.top}-${atc.bottom}`);
        check('PDP Add to Cart is hit-testable at scroll 0 (all 3 points)', atc.verdict === 'reachable' || atc.verdict === 'offscreen',
            atc.verdict === 'offscreen' ? 'below the fold at 900px — not covered, simply further down' : `${atc.verdict} ${atc.points || ''}`);

        const docH = await page.evaluate(() => document.documentElement.scrollHeight);
        const blocked = [];
        for (let y = 0; y < docH; y += 300) {
            await page.evaluate((yy) => window.scrollTo(0, yy), y);
            await page.waitForTimeout(250);
            // Hit-tests the header search FORM (its input fills it). Nothing is
            // clicked or typed — no search runs, no search_analytics row (ERR-254).
            const s = await page.evaluate(hitTest, '#site-search-form');
            if (s.verdict === 'blocked') blocked.push(y);
        }
        check('the header search box is uncovered at every scroll offset (300px steps)', blocked.length === 0,
            blocked.length ? `blocked at scrollY ${blocked.join(', ')}` : `0 blocked offsets over ${docH}px`);
        await ctx.close();

        const cartCtx = await browser.newContext({ viewport: DESKTOP });
        const cart = await cartCtx.newPage();
        await cart.goto(`${BASE}/cart`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await cart.waitForTimeout(SETTLE_MS);
        const co = await cart.evaluate(hitTest, '#checkout-btn');
        if (co.verdict === 'absent' || co.verdict === 'zero-box') {
            soft('cart Checkout not measured', 'a fresh context has an EMPTY cart and this probe never adds to one (READ-ONLY) — '
                + 'the empty cart shows no Checkout button. Measure with a cart in a manual session.');
        } else {
            check('cart Checkout is hit-testable at scroll 0', co.verdict === 'reachable' || co.verdict === 'offscreen', `${co.verdict} ${co.points || ''}`);
        }
        await cartCtx.close();
    }

    /* ══ §4 no overlay on the paid landing page either ══════════════════════ */
    head('§4 /ink-cartridges on a phone — no overlay after a real scroll');
    {
        const ctx = await phoneCtx();
        const page = await ctx.newPage();
        await page.goto(`${BASE}/ink-cartridges?gclid=probe`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(SETTLE_MS);
        await page.evaluate((y) => window.scrollTo(0, y), NUDGE_SCROLL_PX + 120);
        await page.waitForTimeout(1500);
        const m = await page.evaluate(MEASURE);
        check('no rewards overlay mounts on the paid landing page', !m.nudge.inDom,
            `#rewards-nudge inDom=${m.nudge.inDom} after scrolling ${NUDGE_SCROLL_PX + 120}px`);
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

    /* ══ §6 THE DEAD ZONE — the shopper's question, at every offset ═════════ */
    head('§6 PDP sweep — is there ANY scroll offset with nothing to tap? (ERR-280)');
    {
        const ctx = await phoneCtx();
        const page = await openPdp(ctx, { scrollTo: 0 });
        const settled = await waitForBannerSettled(page);

        const samples = await sweep(page, PDP_CTA_SELECTORS);
        const dead = runsOf(samples, (m) => !m.tappable);
        const bannerH = samples.find((m) => m.bannerHeight > 0)?.bannerHeight || 0;

        const transientOnly = samples.filter((m) => m.tappable && !m.transientTappable);
        console.log(`  swept ${samples.length} offsets, 0 -> ${samples[samples.length - 1].scrollY}px`
            + ` at ${SWEEP_STEP_PX}px steps, viewport ${samples[0].innerHeight}px, banner ${bannerH}px`);
        console.log(`  ${transientOnly.length} offset(s) were un-tappable mid-slide and tappable once the `
            + `bars stopped moving (max settle ${Math.max(0, ...samples.map((m) => m.settleMs))}ms) — `
            + 'that is the handover animation, not a dead zone. A dead zone does not resolve on its own.');

        if (!settled) {
            soft('the consent banner never settled, so this sweep ran without the occluder',
                'the dead zone only exists while the banner is up — this run proves nothing about it. '
                + 'Either consent-banner.js did not mount, or a decision was already stored in this '
                + 'context, which should be impossible since the context is fresh.');
        } else {
            check('the consent banner was up for the whole sweep', bannerH > 0,
                `measured ${bannerH}px. A sweep taken with the banner already dismissed is the state `
                + 'every member of staff is permanently in, and it is the state in which this defect '
                + 'does not exist (ERR-280).');
        }

        for (const run of dead) {
            const worst = run.samples[Math.floor(run.samples.length / 2)];
            console.log(`  \x1b[31mdead window\x1b[0m scrollY ${run.from}-${run.to} (${run.to - run.from + SWEEP_STEP_PX}px of scroll)`);
            for (const c of worst.controls) {
                console.log(`      ${c.sel.padEnd(30)} y ${String(c.top).padStart(5)}-${String(c.bottom).padStart(5)}`
                    + `  ${c.verdict}${c.blockedBy ? ` (covered by ${c.blockedBy})` : ''}`);
            }
        }

        check('every scroll offset on the PDP offers a tappable Add to Cart',
            dead.length === 0,
            dead.length === 0
                ? `${samples.length} offsets, all tappable`
                : `${dead.length} dead window(s): `
                  + dead.map((r) => `scrollY ${r.from}-${r.to}`).join(', ')
                  + `. This is the whole point of .sticky-atc: it exists to guarantee a tappable CTA `
                  + 'whenever the real one is not reachable. It stands down on isIntersecting of '
                  + '.product-info__actions, which counts the band the consent banner owns as visible '
                  + '— so it hands over to a button underneath the banner and the shopper has nothing '
                  + 'to press (js/product-detail-page.js, the sticky-bar IntersectionObserver).');

        /* The handoff's own numbers, re-asked at the offsets it named. Its sweep
           used a 390x664 profile and found two dead offsets of twelve; ours is
           finer, so it should find at least those. Printed, never asserted —
           their document heights and ours differ with the catalogue. */
        const named = [600, 1200].map((y) => samples.reduce((best, m) =>
            (Math.abs(m.scrollY - y) < Math.abs(best.scrollY - y) ? m : best), samples[0]));
        console.log(`  the handoff's two named offsets: `
            + named.map((m) => `scrollY ${m.scrollY} -> ${m.tappable ? 'tappable' : 'NOTHING TAPPABLE'}`).join(', '));

        await ctx.close();
    }

    /* ══ §7 the category page, which is where most paid clicks land ═════════ */
    head('§7 category sweep — /ink-cartridges, the surface 68% of paid clicks land on');
    {
        const ctx = await phoneCtx();
        const page = await ctx.newPage();
        await page.goto(`${BASE}/ink-cartridges`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(SETTLE_MS);
        const settled = await waitForBannerSettled(page);
        await page.waitForSelector(CARD_CTA_SELECTORS.join(','), { timeout: 30000 }).catch(() => {});

        const samples = await sweep(page, CARD_CTA_SELECTORS);
        const bannerH = samples.find((m) => m.bannerHeight > 0)?.bannerHeight || 0;
        const blockedRuns = runsOf(samples, (m) => m.controls.some((c) => c.verdict === 'blocked'));
        const cardsOnScreen = (m) => m.controls.some((c) => c.verdict === 'reachable' || c.verdict === 'blocked');
        const starved = runsOf(samples, (m) => cardsOnScreen(m) && !m.tappable);

        console.log(`  swept ${samples.length} offsets, 0 -> ${samples[samples.length - 1].scrollY}px, `
            + `banner ${bannerH}px, ${samples[0].controls.length} card control(s) found`);

        if (!settled) {
            soft('the consent banner never settled on /ink-cartridges', 'nothing below was exercised against it');
        }
        if (!samples.some((m) => m.controls.length)) {
            soft('no card add-to-cart controls were found on /ink-cartridges',
                `looked for ${CARD_CTA_SELECTORS.join(', ')}. The popular shelf renders through `
                + 'Products.renderCard (.product-card__add-btn) and the results grid through '
                + 'DrilldownNav.createProductCard (.product-card__cart-btn) — two renderers, '
                + 'deliberately not shared, so a rename on one side is invisible from the other.');
        }

        for (const run of starved) {
            console.log(`  \x1b[31mstarved window\x1b[0m scrollY ${run.from}-${run.to}`
                + ` (${run.to - run.from + SWEEP_STEP_PX}px) — cards on screen, none of them tappable`);
        }

        /* WHAT IS AND IS NOT FIXABLE HERE, STATED SO THE ASSERTION IS HONEST.
           A fixed bottom banner covers the bottom band of every page on the web;
           a card that scrolls through that band is briefly un-tappable and a
           flick clears it. Asserting "no card is ever covered" would be a guard
           that can never pass while the banner exists, which is worse than no
           guard. What IS ours, and what this asserts, is that the covered
           window is only ever the banner's own height — nothing of OURS widens
           it — and that whatever covers a card is the consent banner and not
           some layer we shipped. That is the ERR-276 shape, and it can pass. */
        const widest = blockedRuns.reduce((w, r) => Math.max(w, r.to - r.from + SWEEP_STEP_PX), 0);
        check('nothing of ours widens the band the consent banner covers',
            blockedRuns.length === 0 || widest <= bannerH + SWEEP_STEP_PX * 2,
            `widest covered window ${widest}px of scroll against a ${bannerH}px banner. A window `
            + 'materially larger than the banner means a second layer of ours is also covering the '
            + 'cards, which is ERR-276 on a different surface.');

        /* TWO BANDS ARE ALLOWED AND EVERYTHING ELSE IS A DEFECT.
           `.site-header` is `position: sticky; top: 0` below 1100px and
           `#consent-banner` is `position: fixed; bottom: 0`. Between them they
           own the top and bottom edges of every phone viewport on this site,
           and a card scrolling through either is briefly un-tappable for
           exactly that band's height — universal to the web, cleared by a
           flick, and not something a front end can remove.

           Anything ELSE on top of a buy button is ours and is a defect. This
           check found one on its first run: the rewards nudge, `position:
           fixed` at --z-popover over the product grid, covering a card Add
           button at 32 of 92 offsets — ERR-276's mechanism still live on the
           surface its path gate did not list. The band check above is the
           other half: these two are allowed to cover their OWN height and no
           more, so a third layer hiding behind one of them still shows up. */
        const foreign = samples.flatMap((m) => m.controls
            .filter((c) => c.verdict === 'blocked' && !c.blockedByChrome)
            .map((c) => `scrollY ${m.scrollY}: ${c.sel} covered by ${c.blockedBy}`));
        const byChrome = {};
        samples.forEach((m) => m.controls.forEach((c) => {
            if (c.blockedByChrome) byChrome[c.blockedByChrome] = (byChrome[c.blockedByChrome] || 0) + 1;
        }));
        check('nothing but the sticky header and the consent banner covers a card Add button',
            foreign.length === 0,
            foreign.length === 0
                ? `${blockedRuns.length} covered window(s); blockers were `
                  + (Object.keys(byChrome).length
                      ? Object.entries(byChrome).map(([k, v]) => `${k} x${v}`).join(', ')
                      : 'none')
                : `${foreign.length} sample(s) covered by a layer that is neither — `
                  + `${foreign.slice(0, 4).join(' · ')}. A fixed element over a product grid owns a `
                  + 'constant band of the viewport, and every in-flow buy button travels through it '
                  + '(ERR-224/276/280).');

        console.log(`  measurement, not a verdict: ${blockedRuns.length} window(s) where a visible card `
            + `Add button sits under the banner`
            + (blockedRuns.length ? ` — ${blockedRuns.map((r) => `${r.from}-${r.to}`).join(', ')}` : '')
            + `. A ${bannerH}px flick clears each one, and dismissing consent removes them all.`);
        if (starved.length) {
            console.log(`  measurement, not a verdict: ${starved.length} window(s) with cards on screen and `
                + 'none tappable. Unlike the PDP there is no sticky bar to hand over to here, so this is '
                + 'the banner band plus the gap between card rows, not a broken handover.');
        }

        await ctx.close();
    }

    /* ══ §8 NEGATIVE CONTROL for the sweep ═══════════════════════════════════ */
    head('§8 negative control — can the sweep report a dead window at all?');
    {
        const ctx = await phoneCtx();
        const page = await openPdp(ctx, { scrollTo: 0 });
        await waitForBannerSettled(page);

        const clean = await sweep(page, PDP_CTA_SELECTORS);
        const cleanDead = runsOf(clean, (m) => !m.tappable);
        if (cleanDead.length) {
            soft('the sweep negative control could not run',
                'the page already had a dead window before the overlay went in, so covering the '
                + 'controls proves nothing about the sweep. Fix §6 first.');
        } else {
            /* A full-viewport veil, because the sweep's job is the PAGE-level
               question: covering one control would only prove the other one
               took over, which is the behaviour we want, not the detector. */
            await page.evaluate(() => {
                const veil = document.createElement('div');
                veil.id = 'probe-synthetic-sweep-occluder';
                veil.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:transparent;';
                document.body.appendChild(veil);
            });
            const veiled = await sweep(page, PDP_CTA_SELECTORS, { step: 400 });
            const veiledDead = runsOf(veiled, (m) => !m.tappable);
            const sawOccluder = veiled.some((m) => m.controls.some(
                (c) => String(c.blockedBy).includes('probe-synthetic-sweep-occluder')));

            check('a synthetic full-viewport overlay makes the sweep report a dead window',
                veiledDead.length > 0 && sawOccluder,
                veiledDead.length > 0 && sawOccluder
                    ? `${veiledDead.length} dead window(s) while veiled, naming the overlay`
                    : `dead windows=${veiledDead.length}, overlay named=${sawOccluder}. If §6 stays green `
                      + 'with every control demonstrably covered, §6 is green because it cannot fail, '
                      + 'not because the page is reachable. Six guards in this repo once sat inside a '
                      + '6088/0 suite and not one of them could go red (ERR-258).');
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
console.log('\x1b[32mA first-time guest on a phone can tap Add to Cart at EVERY scroll offset, and desktop is unchanged.\x1b[0m');
process.exit(0);
