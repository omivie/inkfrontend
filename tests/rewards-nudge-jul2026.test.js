'use strict';

/**
 * GUEST REWARDS NUDGE — Jul 2026
 * ==============================
 * js/rewards-nudge.js shows guests a compact, NON-MODAL popover anchored
 * under the header Account button, inviting them to create an account so
 * future orders earn loyalty points. Shown once per session, ~6s after
 * load; explicit dismissal (close ×, Escape, "Maybe later") suppresses it
 * for CAMPAIGN.dismissDays via versioned localStorage `ic_rewards_nudge`.
 *
 * What this file pins, and why:
 *
 *   §1  COVERAGE. Every page with the canonical site-header carries exactly
 *       one rewards-nudge.js tag; every headerless page (checkout funnel +
 *       auth screens) carries none. Lists are DERIVED from the presence of
 *       the header, so a new page can't silently miss (or wrongly gain)
 *       the nudge.
 *
 *   §2  ORDER. Deferred scripts run in document order; the nudge reads
 *       Config/Security/getStorage/Auth at init, so its tag must come
 *       after utils.js and auth.js on every page. Tokens (?v=) are never
 *       pinned — asset-cache-tokens.test.js owns those.
 *
 *   §3  BREAKPOINT SINGLE-SOURCING (ERR-088). No 480/768/1100 literals in
 *       the JS — Config.BREAKPOINTS/MQ_DESKTOP_NAV only. And zero raw
 *       console.* (DebugLog only, ERR-035).
 *
 *   §5  COPY HONESTY. The loyalty program (html/account/loyalty.html,
 *       cart loyalty control) has NO registration reward and NO way to
 *       attach a guest order after the fact. The nudge must never claim
 *       either, and must state the real earn rate verbatim. Marketing
 *       drift into unverifiable claims is a Google Ads compliance risk,
 *       same class as the warranty-claim guard (ERR-063).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const INK = path.join(ROOT, 'inkcartridges');
const read = (rel) => fs.readFileSync(path.join(INK, rel), 'utf8');

const JS = read('js/rewards-nudge.js');
const CSS = read('css/components.css');

// Walk all storefront HTML files (skip admin tools + node_modules)
function htmlFiles() {
    const out = [];
    (function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name === 'admin') continue;
                walk(full);
            } else if (entry.name.endsWith('.html')) {
                out.push(path.relative(INK, full));
            }
        }
    })(INK);
    return out;
}

const NUDGE_TAG = /<script defer src="\/js\/rewards-nudge\.js\?v=[0-9a-f]{8}"><\/script>/g;

// ────────────────────────────────────────────────────────────────────
// §1 Coverage: header pages get the tag, headerless pages must not
// ────────────────────────────────────────────────────────────────────

test('every site-header page loads rewards-nudge.js exactly once', () => {
    const headerPages = htmlFiles().filter((f) => read(f).includes('<header class="site-header"'));
    assert.ok(headerPages.length >= 28, `expected >=28 header pages, found ${headerPages.length}`);
    for (const f of headerPages) {
        const matches = read(f).match(NUDGE_TAG) || [];
        assert.equal(matches.length, 1, `${f} must contain exactly one rewards-nudge.js tag, found ${matches.length}`);
    }
});

test('headerless pages (checkout funnel + auth screens) never load the nudge', () => {
    const headerless = htmlFiles().filter((f) => !read(f).includes('<header class="site-header"'));
    assert.ok(headerless.length >= 7, `expected >=7 headerless pages, found ${headerless.length}`);
    for (const f of headerless) {
        assert.ok(!read(f).includes('rewards-nudge.js'), `${f} has no site-header and must not load rewards-nudge.js`);
    }
});

// ────────────────────────────────────────────────────────────────────
// §2 Script order: dependencies first (deferred = document order)
// ────────────────────────────────────────────────────────────────────

test('rewards-nudge.js tag comes after utils.js and auth.js on every page', () => {
    const headerPages = htmlFiles().filter((f) => read(f).includes('rewards-nudge.js'));
    for (const f of headerPages) {
        const html = read(f);
        const nudgeAt = html.indexOf('/js/rewards-nudge.js');
        for (const dep of ['/js/utils.js', '/js/auth.js', '/js/config.js', '/js/security.js']) {
            const depAt = html.indexOf(dep);
            assert.ok(depAt !== -1, `${f} must load ${dep}`);
            assert.ok(depAt < nudgeAt, `${f}: ${dep} must precede rewards-nudge.js`);
        }
    }
});

// ────────────────────────────────────────────────────────────────────
// §3 Single-sourced breakpoints + no raw console
// ────────────────────────────────────────────────────────────────────

test('no hardcoded breakpoint literals — Config.BREAKPOINTS only (ERR-088)', () => {
    assert.ok(!/\b(480|768|1100)\b/.test(JS), 'rewards-nudge.js must not hardcode 480/768/1100');
    assert.ok(JS.includes('Config.BREAKPOINTS.tablet'), 'must read Config.BREAKPOINTS.tablet');
    assert.ok(JS.includes('Config.MQ_DESKTOP_NAV'), 'must read Config.MQ_DESKTOP_NAV');
});

test('zero raw console.* — DebugLog only (ERR-035)', () => {
    assert.ok(!/\bconsole\./.test(JS), 'use DebugLog, not console');
    assert.ok(JS.includes('DebugLog.error'), 'init failures must go to DebugLog');
});

// ────────────────────────────────────────────────────────────────────
// §4 Storage contract: versioned localStorage + session cap
// ────────────────────────────────────────────────────────────────────

test('versioned localStorage key via shared helpers', () => {
    assert.ok(JS.includes("'ic_rewards_nudge'"), 'localStorage key ic_rewards_nudge');
    assert.ok(JS.includes("'ic_rewards_nudge_session'"), 'sessionStorage once-per-session key');
    assert.ok(/version:\s*\d+/.test(JS), 'CAMPAIGN.version present (bump to re-arm)');
    assert.ok(JS.includes('getStorage(') && JS.includes('setStorage('), 'use utils.js storage helpers');
    assert.ok(JS.includes('s.v !== CAMPAIGN.version'), 'version mismatch must reset state');
});

// ────────────────────────────────────────────────────────────────────
// §5 Copy honesty: only claims the loyalty program actually supports
// ────────────────────────────────────────────────────────────────────

test('copy never promises unsupported benefits', () => {
    const banned = [
        [/sign[\s-]?up bonus/i, 'no registration reward exists'],
        [/free points/i, 'points are earned on spend, never free'],
        [/(this|current)\s+(order|cart|purchase)/i, 'guest orders cannot be attached after the fact'],
        [/retroactive/i, 'no retro-crediting flow exists'],
        [/act now|last chance|you are losing/i, 'no fake urgency'],
    ];
    for (const [re, why] of banned) {
        assert.ok(!re.test(JS), `banned claim ${re} — ${why}`);
    }
});

test('copy states the verified earn/redeem rates verbatim', () => {
    // Must match the canonical program copy (html/account/loyalty.html)
    assert.ok(JS.includes('1 point for every $1'), 'earn rate');
    assert.ok(JS.includes('excluding shipping'), 'shipping exclusion');
    assert.ok(JS.includes('100 points = $1'), 'redemption rate');
});

// ────────────────────────────────────────────────────────────────────
// §6 Behaviour pins
// ────────────────────────────────────────────────────────────────────

test('interaction + auth contract', () => {
    assert.ok(JS.includes("'Escape'"), 'Escape closes');
    assert.ok(JS.includes('aria-label="Dismiss rewards message"'), 'accessible close button');
    assert.ok(JS.includes('__ink_auth=1'), 'flash-free signed-in cookie fast path');
    assert.ok(JS.includes('Auth.readyPromise'), 'waits for auth hydration');
    assert.ok(JS.includes('Auth.isAuthenticated()'), 'guest-only gate');
    assert.ok(JS.includes('onAuthStateChange') && JS.includes("'SIGNED_IN'"), 'live sign-in teardown');
    assert.ok(JS.includes('Security.escapeHtml') && JS.includes('Security.escapeAttr'), 'campaign strings escaped');
    assert.ok(JS.includes('encodeURIComponent(window.location.pathname'), 'path-only return URL');
    assert.ok(JS.includes("tab=register"), 'CTA deep-links to the register tab');
    assert.ok(/skipPaths:\s*\[\s*'\/cart'/.test(JS), 'suppressed on /cart (owner decision Jul 17)');
    assert.ok(JS.includes("role', 'complementary"), 'non-modal role (not dialog)');
    assert.ok(JS.includes('hidden'), 'hidden-attribute show/hide convention');
});

// ────────────────────────────────────────────────────────────────────
// §7 CSS pins
// ────────────────────────────────────────────────────────────────────

test('css: layering token, reduced motion, restrained animation', () => {
    assert.ok(CSS.includes('.rewards-nudge'), 'styles present in components.css');
    const block = CSS.slice(CSS.indexOf('REWARDS NUDGE'));
    assert.ok(block.includes('var(--z-popover)'), 'must use the shared z-scale token');
    assert.ok(!/z-index:\s*\d/.test(block), 'no raw z-index numbers');
    assert.ok(block.includes('prefers-reduced-motion'), 'reduced-motion support');
    const dur = block.match(/transition:[^;]*?(\d+)ms/);
    assert.ok(dur && +dur[1] >= 150 && +dur[1] <= 220, `entry animation 150-220ms, got ${dur && dur[1]}ms`);
});

// ────────────────────────────────────────────────────────────────────
// §8 Analytics pins
// ────────────────────────────────────────────────────────────────────

test('analytics events exist and are guarded (TrafficTracker is optional)', () => {
    for (const ev of ['rewards_nudge_shown', 'rewards_nudge_dismissed', 'rewards_nudge_cta_clicked']) {
        assert.ok(JS.includes(`'${ev}'`), `event ${ev}`);
    }
    assert.ok(JS.includes('window.TrafficTracker'), 'TrafficTracker existence guard');
    assert.ok(JS.includes("typeof gtag === 'function'"), 'gtag guard');
    assert.ok(!JS.includes('data-track'), 'no data-track on CTA — would double-fire with the explicit send');
});
