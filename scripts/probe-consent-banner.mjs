#!/usr/bin/env node
/**
 * Can a visitor actually press Accept? (ERR-233)
 * ==============================================
 *
 * ERR-227 shipped a consent gate three days ago. It shipped with a working "no"
 * and a broken "yes".
 *
 * Google's platform.js styles OUR #google-reviews-badge div — footer.js renders
 * it with `position: 'BOTTOM_RIGHT'` — as `position:fixed; right:0; bottom:0` at
 * z-index 2147483647. That is the 32-bit signed maximum, so the fix could never
 * be a larger z-index. Measured on the live site at 1512x806:
 *
 *     badge    x 1415-1501   y 742-806
 *     Accept   x 1399-1485   y 754-798    <- 70 of its 86px underneath
 *     Decline  x 1303-1391                <- clear, so it kept working
 *
 * and document.elementFromPoint at Accept's own centre returned Google's iframe,
 * not the button. Exactly one of two buttons was dead, on every desktop, and the
 * bar looked completely normal. The visitor who wanted analytics ON could not
 * say so — which lands in the same place ERR-227 started from, with
 * analytics_storage denied for everyone and nothing anywhere saying so.
 *
 * WHY A PROBE AND NOT ONLY TESTS
 * ------------------------------
 * tests/consent-mode-sep2026.test.js §5 pins the CSS rule, its !important, the
 * calc() and the publisher. Every one of those is an assertion about source
 * text. None of them can see a rendered box, and this bug WAS a rendered box:
 * two elements whose source is individually correct, overlapping. The source was
 * never wrong. The pairing was.
 *
 * So this asks the browser the one question that was false:
 *
 *     is the thing painted at Accept's centre the Accept button?
 *
 * ── READ-ONLY. ──────────────────────────────────────────────────────────────
 * Every navigation is a GET against public pages. There is no --record and no
 * --update-baseline, deliberately: a probe that can record may be green only
 * because it just overwrote what it compared against (sweep:b2b ate a committed
 * fixture, 2026-08-12). The mode is PRINTED on every run so it is never assumed.
 *
 * There is NO ctx.route() here and there must never be one.
 *
 * Each section opens a FRESH context. A stored consent decision suppresses the
 * bar entirely, so a dirty profile would make this probe pass by measuring
 * nothing at all.
 *
 * Usage:  npm run probe:consent-banner
 *         PROBE_BASE=http://localhost:3000 npm run probe:consent-banner
 * Exit:   0 = every assertion held
 *         1 = a measured box regressed
 *         2 = could not run (network / the bar never rendered)
 */

import { chromium } from 'playwright';

const BASE = process.env.PROBE_BASE || 'https://www.inkcartridges.co.nz';
const DESKTOP = { width: 1512, height: 806 };   // the viewport the bug was measured at
const NARROW = { width: 1100, height: 800 };    // still desktop, badge still rendered
const PHONE = { width: 390, height: 844 };      // iPhone 14
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) '
    + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

let pass = 0;
const failures = [];
const notes = [];
const ok = (n, d) => { pass++; console.log(`  \x1b[32m✓\x1b[0m ${n}${d ? ` — ${d}` : ''}`); };
const bad = (n, d) => { failures.push(`${n} — ${d}`); console.log(`  \x1b[31m✗\x1b[0m ${n}\n      ${d}`); };
const soft = (n, d) => { notes.push(`${n} — ${d}`); console.log(`  \x1b[33m~\x1b[0m ${n}\n      ${d}`); };
const check = (n, cond, d) => (cond ? ok(n, d) : bad(n, d));

console.log('\n\x1b[1mprobe:consent-banner — can a visitor actually press Accept? (ERR-233)\x1b[0m');
console.log('\x1b[33mMODE: READ-ONLY.\x1b[0m No --record, no --update-baseline, no ctx.route(), no writes.');
console.log(`Target: ${BASE}\n`);

/**
 * Geometry of the bar, its two buttons and the Google badge, plus the hit-test
 * that was false. Read from the live DOM at whatever viewport is current.
 */
const MEASURE = () => {
    const box = (e) => {
        if (!e) return null;
        const r = e.getBoundingClientRect();
        return {
            x: Math.round(r.x), y: Math.round(r.y),
            w: Math.round(r.width), h: Math.round(r.height),
            right: Math.round(r.right), bottom: Math.round(r.bottom),
        };
    };
    const banner = document.getElementById('consent-banner');
    const badge = document.getElementById('google-reviews-badge');
    const btns = banner ? Array.from(banner.querySelectorAll('button')) : [];

    /* What is actually painted at a button's own centre? This is the whole
       probe. A button can be the right size, in the right place, fully visible,
       and still be unclickable because something else answers the hit-test. */
    const hitAt = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(
            Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
        if (!hit) return 'nothing';
        if (hit === el || el.contains(hit)) return 'self';
        return `${hit.tagName.toLowerCase()}#${hit.id || ''}.${String(hit.className).trim().slice(0, 30)}`;
    };

    return {
        bannerPresent: !!banner,
        banner: box(banner),
        bannerPaddingRight: banner ? getComputedStyle(banner).paddingRight : null,
        badgePresent: !!badge && getComputedStyle(badge).position === 'fixed'
            && badge.getBoundingClientRect().height > 0,
        badge: box(badge),
        badgeZ: badge ? getComputedStyle(badge).zIndex : null,
        badgeBottom: badge ? getComputedStyle(badge).bottom : null,
        badgeWidthVar: getComputedStyle(document.documentElement)
            .getPropertyValue('--google-badge-width').trim() || null,
        bannerHeightVar: document.body.style.getPropertyValue('--consent-banner-height') || null,
        hasClass: document.body.classList.contains('has-consent-banner'),
        buttons: btns.map((b) => ({ text: (b.textContent || '').trim(), ...box(b), hit: hitAt(b) })),
        viewport: { w: window.innerWidth, h: window.innerHeight },
    };
};

const intersects = (a, b) => !!a && !!b && a.w > 0 && b.w > 0
    && a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;

/**
 * Open the site and wait for the CONDITION — the badge having a real box —
 * rather than sleeping an interval and hoping Google finished. platform.js is
 * async and takes roughly 1.4s; a guessed sleep is how a probe measures the
 * moment before the bug appears and calls it clean.
 */
async function load(ctx, { expectBadge = true } = {}) {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForSelector('#consent-banner.is-open', { timeout: 30000 });

    /* `.is-open` is added BEFORE the 0.25s translateY transition runs, so the
       bar is still sliding up at that moment. The first draft of this probe
       measured it mid-flight at y=797 in an 806px viewport, which put both
       buttons past the bottom edge and made elementFromPoint return null for
       BOTH of them — reported as "Accept is dead", for the wrong reason, while
       Decline (which works) failed identically. Wait for the bar to have
       actually landed on the bottom edge. */
    await page.waitForFunction(() => {
        const el = document.getElementById('consent-banner');
        if (!el) return false;
        return Math.abs(el.getBoundingClientRect().bottom - window.innerHeight) <= 1;
    }, null, { timeout: 15000 }).catch(() => { /* reported by the caller */ });

    if (expectBadge) {
        /* Waiting on the badge is where two drafts of this probe went wrong, in
           opposite directions, and both looked fine:

           1. `width > 0` returns IMMEDIATELY. Before platform.js touches it the
              mount is an empty block-level div in the footer — height 0 but FULL
              WIDTH — so the wait passed before Google had done anything at all.
           2. `position === 'fixed' && height > 0` returns on Google's 2x2
              PLACEHOLDER, which it paints first and expands to 86x64 a moment
              later. The probe then measured a 2px box, found it collided with
              nothing, and reported the page clean. Given six seconds the same
              headless browser shows the full 86x64.

           3. Settling on "unchanged for 2.5s" ALSO returns on the placeholder,
              because 2x2 holds still for a full two seconds before Google moves.

           Traced against the live site, the box actually goes:

              0.0s  1512x0   position:static    our empty mount div
              1.0s  2x2      fixed, iframe parked at top:-10000px
              3.0s  450x150  iframe unparked to position:static
              3.5s  614x64
              6.5s  86x64    final

           The signal that separates placeholder from badge is not any size: it
           is Google PARKING the inner iframe off-screen at top:-10000px while it
           loads. So wait for the iframe to be unparked AND the box to have
           settled after that. No size threshold anywhere — the final box is
           86x64 headless and 450x150 in a headed browser, and hardcoding either
           would make this a measurement of the browser, not of the site. */
        await page.waitForFunction(() => {
            const b = document.getElementById('google-reviews-badge');
            if (!b || getComputedStyle(b).position !== 'fixed') return false;
            const f = b.querySelector('iframe');
            // Parked off-screen — Google is still loading it.
            if (!f || getComputedStyle(f).position === 'absolute') return false;
            const r = b.getBoundingClientRect();
            if (r.height <= 0 || r.width <= 0) return false;
            const key = `${Math.round(r.width)}x${Math.round(r.height)}`;
            window.__badgeSettle = (window.__badgeSettle && window.__badgeSettle.key === key)
                ? { key, n: window.__badgeSettle.n + 1 }
                : { key, n: 1 };
            /* 16 polls = 4s. Deliberately longer than the 3s that 614x64 holds
               still for: settle on that and the probe measures a loading state,
               which is how it first reported a 638px padding as the shipped
               design. The final 86x64 never changes again, so a longer window
               only makes this more certain, never flakier. */
            return window.__badgeSettle.n >= 16;
        }, null, { timeout: 45000, polling: 250 })
            .catch(() => { /* the caller reports what it actually found */ });
    }
    return page;
}

const browser = await chromium.launch();
let fatal = null;

try {
    /* ── §1 DESKTOP — the exact viewport the bug was measured at ──────────── */
    {
        console.log('\x1b[1m§1 Desktop 1512x806 — the geometry that was broken\x1b[0m');
        const ctx = await browser.newContext({ viewport: DESKTOP });
        const page = await load(ctx);
        const m = await page.evaluate(MEASURE);

        check('the consent bar is showing for an undecided visitor', m.bannerPresent,
            m.bannerPresent ? `${m.banner.w}x${m.banner.h} at y=${m.banner.y}`
                : 'no #consent-banner — a stored decision, or the bar stopped rendering; '
                  + 'nothing below this measured anything');

        const accept = m.buttons.find((b) => b.text === 'Accept');
        const decline = m.buttons.find((b) => b.text === 'Decline');

        if (!m.badgePresent || !m.badge || m.badge.w === 0) {
            /* THE POSITIVE CONTROL. Without the badge every assertion below
               passes for the wrong reason — there is nothing left to collide
               with. That is not a green run, it is an unexercised one. */
            soft('the Google Customer Reviews badge did not render',
                'gapi blocked, merchant feed down, or the badge removed from footer.js. '
                + 'The overlap this probe exists to catch was NOT exercised — '
                + 'the buttons could be back under the corner and this run would still be green');
        } else {
            ok('the Google badge rendered', `${m.badge.w}x${m.badge.h} at x=${m.badge.x} y=${m.badge.y}, z-index ${m.badgeZ}`);

            check('the badge is lifted clear of the bar, not sitting on it',
                m.badge.bottom <= m.banner.y + 1,
                m.badge.bottom <= m.banner.y + 1
                    ? `badge bottom=${m.badge.bottom}, bar top=${m.banner.y} — it sits ON the bar, not over it`
                    : `badge bottom=${m.badge.bottom} vs bar top=${m.banner.y} — Google's inline bottom:0 `
                      + 'is winning, so the !important rule in components.css is gone or outranked');

            check('the badge overlaps NEITHER button',
                !intersects(m.badge, accept) && !intersects(m.badge, decline),
                `badge x${m.badge.x}-${m.badge.right} y${m.badge.y}-${m.badge.bottom} vs `
                + `Accept x${accept && accept.x}-${accept && accept.right} y${accept && accept.y}-${accept && accept.bottom}`);

            /* THE POSITIVE CONTROL. Every assertion above is satisfied by two
               boxes that do not touch — and two boxes trivially fail to touch
               when one of them is not really there. So prove the collision is
               still POSSIBLE: put the padding back to the shipped 16px on paper
               and check the buttons would land under the badge.

               Google only serves the full 86x64 badge on the registered merchant
               domain. Against localhost it renders a 2x2 stub, which cannot
               collide with anything and would make this assertion fail for a
               reason that has nothing to do with the fix. A stub is not a
               regression and it is not a pass either — it is an unexercised
               run, and it has to say so by name. */
            const padRight = parseFloat(m.bannerPaddingRight) || 0;
            const unfixedAcceptRight = accept ? accept.right + (padRight - 16) : 0;
            const badgeIsRealSize = m.badge.h >= 32 && m.badge.w >= 32;

            if (!badgeIsRealSize) {
                soft('positive control: the badge is a stub, not the production badge',
                    `${m.badge.w}x${m.badge.h} — Google serves the full 86x64 badge only on the `
                    + 'registered merchant domain, so nothing here could have collided. THE OVERLAP '
                    + 'WAS NOT EXERCISED: run this against the live origin to test the real geometry');
            } else {
                check('positive control: the UNFIXED layout really would collide',
                    unfixedAcceptRight > m.badge.x,
                    unfixedAcceptRight > m.badge.x
                        ? `with the original padding-right:16px Accept would reach x=${Math.round(unfixedAcceptRight)}, `
                          + `past the badge's left edge at x=${m.badge.x} — the collision is real and this fix prevents it`
                        : `with the original padding-right:16px Accept would end at x=${Math.round(unfixedAcceptRight)} `
                          + `and the badge starts at x=${m.badge.x} — they no longer overlap for some other `
                          + 'reason, so this probe is not measuring the bug it was written for');
            }
        }

        check('Accept answers its own hit-test',
            !!accept && accept.hit === 'self',
            !accept ? 'no Accept button rendered at all'
                : accept.hit === 'self'
                    ? "elementFromPoint at Accept's centre returns the button itself"
                    : `elementFromPoint at Accept's centre returned "${accept.hit}" — THE EXACT `
                      + 'ASSERTION THAT WAS FALSE: the button is fully visible and completely dead');

        check('Decline answers its own hit-test',
            !!decline && decline.hit === 'self',
            decline ? `elementFromPoint returned "${decline.hit}"` : 'no Decline button rendered');

        check('the bar reserved the badge width it measured',
            !!m.badgeWidthVar,
            m.badgeWidthVar
                ? `--google-badge-width = ${m.badgeWidthVar}, padding-right = ${m.bannerPaddingRight}`
                : '--google-badge-width is UNSET — footer.js never published the footprint, '
                  + 'so the buttons never moved left');

        check('the bar reserved its own measured height for the badge to sit on',
            !!m.bannerHeightVar && m.hasClass,
            `--consent-banner-height=${m.bannerHeightVar}, body.has-consent-banner=${m.hasClass}`
            + (m.bannerHeightVar && m.hasClass ? ''
                : ' — without both, the lift rule has nothing to spend and resolves to bottom:0'));

        await ctx.close();
    }

    /* ── §2 Accept must actually WORK, not merely be reachable ────────────── */
    {
        console.log('\n\x1b[1m§2 Pressing Accept — through the real UI, never by writing storage\x1b[0m');
        const ctx = await browser.newContext({ viewport: DESKTOP });
        const page = await load(ctx);

        let clicked = true;
        await page.click('#consent-banner .consent-banner__btn--accept', { timeout: 5000 })
            .catch(() => { clicked = false; });

        check('the Accept button is clickable by a real pointer', clicked,
            clicked ? 'a real pointer event reached it'
                : 'Playwright refused the click — the button is covered or intercepted');

        if (clicked) {
            const after = await page.evaluate(() => ({
                stored: (() => { try { return localStorage.getItem('cookie_consent'); } catch (_) { return 'ERR'; } })(),
                bannerGone: !document.getElementById('consent-banner'),
                hasClass: document.body.classList.contains('has-consent-banner'),
                badgeBottom: (() => {
                    const b = document.getElementById('google-reviews-badge');
                    return b ? getComputedStyle(b).bottom : null;
                })(),
            }));

            check('the bar dismissed itself', after.bannerGone,
                after.bannerGone ? 'removed from the DOM' : 'the bar survived its own Accept click');
            check('the RAW string gtag.js compares against is what landed in storage',
                after.stored === 'accepted',
                after.stored === 'accepted' ? 'cookie_consent = accepted (bare, unquoted)'
                    : `stored ${JSON.stringify(after.stored)} — gtag.js line 9 compares against the `
                      + 'bare string "accepted"; a JSON-quoted value keeps analytics denied for ever');
            check('the reserved space was released', after.hasClass === false,
                after.hasClass === false ? 'body.has-consent-banner removed'
                    : 'the class survived, leaving a permanent gap at the foot of every page');
            check('the badge dropped back to the corner once the bar was gone',
                after.badgeBottom === '0px',
                after.badgeBottom === '0px' ? 'bottom back to 0px'
                    : `badge bottom is ${after.badgeBottom} — the lift outlived the bar it was `
                      + 'avoiding, so the badge now floats above nothing');
        }
        await ctx.close();
    }

    /* ── §3 A narrower desktop — the badge is still there ─────────────────── */
    {
        console.log('\n\x1b[1m§3 Desktop 1100x800 — narrower, badge still rendered\x1b[0m');
        const ctx = await browser.newContext({ viewport: NARROW });
        const page = await load(ctx);
        const m = await page.evaluate(MEASURE);
        const accept = m.buttons.find((b) => b.text === 'Accept');

        if (!m.badgePresent || !m.badge || m.badge.w === 0) {
            soft('no badge at 1100px', 'the overlap was not exercised at this width');
        } else {
            check('Accept still answers its own hit-test at 1100px',
                !!accept && accept.hit === 'self',
                accept ? `elementFromPoint returned "${accept.hit}"` : 'no Accept button');
        }
        await ctx.close();
    }

    /* ── §4 Phone — Google renders the badge 0x0, so nothing is reserved ──── */
    {
        console.log('\n\x1b[1m§4 iPhone 390x844 — the badge is 0x0 and nothing must be reserved\x1b[0m');
        const ctx = await browser.newContext({
            viewport: PHONE, userAgent: IPHONE_UA, isMobile: true, hasTouch: true, deviceScaleFactor: 3,
        });
        const page = await load(ctx, { expectBadge: false });
        const m = await page.evaluate(MEASURE);
        const accept = m.buttons.find((b) => b.text === 'Accept');
        const decline = m.buttons.find((b) => b.text === 'Decline');

        check('the badge reserves nothing on a phone',
            !m.badgePresent && (!m.badgeWidthVar || parseFloat(m.badgeWidthVar) === 0),
            m.badgePresent
                ? `the badge rendered here and --google-badge-width is ${m.badgeWidthVar} — the bar `
                  + 'will reserve space it has no room to give'
                : `--google-badge-width = ${m.badgeWidthVar || 'unset'}`);

        check('both buttons answer their own hit-test on a phone',
            !!accept && accept.hit === 'self' && !!decline && decline.hit === 'self',
            `Accept="${accept && accept.hit}", Decline="${decline && decline.hit}"`);

        check('both buttons still clear 44px on a phone',
            !!accept && accept.h >= 44 && !!decline && decline.h >= 44,
            `Accept ${accept && accept.h}px, Decline ${decline && decline.h}px`);

        check('neither button is clipped by the viewport',
            !!accept && accept.right <= m.viewport.w && !!decline && decline.x >= 0,
            `Accept right=${accept && accept.right} vs viewport ${m.viewport.w}`);

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
console.log('\x1b[32mAccept is reachable, clickable, and it stores the value gtag.js reads.\x1b[0m');
process.exit(0);
