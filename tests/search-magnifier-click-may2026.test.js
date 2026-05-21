/**
 * Search magnifier-click navigation invariant — May 2026
 * ======================================================
 *
 * Companion to tests/search-enter-key-may2026.test.js.
 *
 * Backend handoff (docs/storefront/search-enter-key-may2026.md, second
 * section "Magnifier icon click — companion regression") reported that
 * clicking the magnifying-glass icon "does not navigate to /search?q=".
 *
 * Investigation (2026-05-21, live Playwright on production + DOM hit-
 * testing) DISPROVED all four hypotheses in the handoff — the magnifier
 * works in every scenario (desktop + mobile, dropdown open + closed, on
 * the homepage and the /search results page). The findings:
 *
 *   H1 "preventDefault with no follow-up navigation"
 *       → FALSE. main.js's submit handler calls e.preventDefault() AND
 *         THEN navigates: window.location.href = `/search?q=…`.
 *
 *   H2 "stale action='/shop' sends you to the generic shop shell"
 *       → FALSE. /shop and /search BOTH rewrite to /html/shop in
 *         vercel.json, and shop-page.js reads ?q= to render the
 *         search-results level regardless of which path served the file.
 *         /shop?q=tn%202350 renders the IDENTICAL "Search Results for…"
 *         view as /search?q=tn%202350. Confirmed live.
 *
 *   H3 "disabled flicker race"
 *       → only no-ops for q.length < 2 (the documented MIN_LEN guard),
 *         which is expected behaviour, not the reported failure.
 *
 *   H4 "overlay intercepts the click"
 *       → FALSE. The expanded form sits at z-index 10, the dimming
 *         overlay at z-index 5; document.elementFromPoint() at the
 *         magnifier's centre returns the button's <svg>, not the overlay.
 *
 * So there was no production bug to fix. What was MISSING was a
 * regression guard: the Enter path is pinned by search-enter-key, but
 * NOTHING pinned the magnifier-click path. This file closes that gap and
 * additionally aligns the form `action` to the canonical /search route
 * (defense-in-depth, so the no-JS native-submit fallback also lands on
 * the documented search destination).
 *
 * The magnifier is a `<button type="submit">`. Clicking it fires the
 * form's `submit` event — the SAME event Enter triggers. So the single
 * `searchForm.addEventListener('submit', …)` in main.js drives BOTH
 * affordances. These tests fail if:
 *   - the navigation handler stops being bound to the FORM's submit
 *     event (e.g. someone moves it to input.keydown only — Enter would
 *     keep working while the magnifier silently dies, the exact split
 *     the handoff feared)
 *   - the handler stops routing to /search?q=
 *   - the magnifier loses type="submit" (a type="button" magnifier would
 *     never trigger submission)
 *   - a search form drops method=GET / name="q" / a q-routing action,
 *     breaking the no-JS native fallback
 *   - vercel.json stops rewriting /search (or /shop) to the shop page
 *
 * Run with: node --test tests/search-magnifier-click-may2026.test.js
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const INK  = path.join(ROOT, 'inkcartridges');
const READ = (p) => fs.readFileSync(p, 'utf8');

function stripComments(src) {
    return src
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
}

const MAIN_SRC  = READ(path.join(INK, 'js', 'main.js'));
const MAIN_CODE = stripComments(MAIN_SRC);

// ─────────────────────────────────────────────────────────────────────────────
// §1 — The navigation handler is bound to the FORM's `submit` event
// ─────────────────────────────────────────────────────────────────────────────
//
// This is THE invariant that makes the magnifier work. Clicking a
// type="submit" button fires the form's submit event; pressing Enter in
// the input fires the same submit event. If a refactor ever moves the
// /search?q= navigation onto the input's keydown handler only, Enter
// would keep working while the magnifier would silently no-op — exactly
// the asymmetric failure the backend handoff worried about.

test('main.js binds the navigation handler to the search FORM submit event', () => {
    assert.match(
        MAIN_CODE,
        /searchForm\.addEventListener\(\s*['"]submit['"]\s*,/,
        'main.js must attach the navigation handler to searchForm\'s "submit" event — ' +
        'this is what makes a magnifier (type="submit") click and an Enter keypress ' +
        'share one code path. Moving it to input.keydown would break the magnifier.',
    );
});

test('main.js submit handler preventDefaults AND THEN navigates to /search?q=', () => {
    // Slice from the submit listener to the end of initSearch so we assert
    // ordering: preventDefault must be FOLLOWED by the location assignment
    // (handoff H1 — a bare preventDefault with no follow-up navigation is
    // the classic "click does nothing" footgun).
    const startIdx = MAIN_CODE.search(/searchForm\.addEventListener\(\s*['"]submit['"]/);
    assert.ok(startIdx !== -1, 'submit listener not found in main.js');
    const handlerSlice = MAIN_CODE.slice(startIdx, startIdx + 600);

    const pdIdx  = handlerSlice.indexOf('preventDefault');
    const navIdx = handlerSlice.search(/window\.location\.href\s*=\s*`\/search\?q=\$\{encodeURIComponent\(query\)\}`/);

    assert.ok(pdIdx !== -1, 'submit handler must call e.preventDefault()');
    assert.ok(navIdx !== -1, 'submit handler must navigate to /search?q=${encodeURIComponent(query)}');
    assert.ok(
        navIdx > pdIdx,
        'navigation (window.location.href = /search?q=…) must come AFTER preventDefault() — ' +
        'a preventDefault with no subsequent navigation is the "magnifier does nothing" bug.',
    );
});

test('main.js resolves the magnifier as the submit button it disables/enables', () => {
    // syncSubmitState toggles disabled on the SAME button that submits, so a
    // valid (>=2 char) query both enables the magnifier and lets the form
    // submit. Pin that the submit button is selected by type="submit".
    assert.match(
        MAIN_CODE,
        /querySelector\(\s*['"]button\[type="submit"\]['"]\s*\)/,
        'main.js must select the submit button via button[type="submit"] — that is the magnifier.',
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — Every site-header search form: GET + name="q" + canonical action
// ─────────────────────────────────────────────────────────────────────────────
//
// Even though the JS handler intercepts submission, the form must degrade
// gracefully: a native submit (no JS / pre-hydration) has to land on a
// q-reading shop page. We pin method=GET, an input named "q", and an
// action of /search (canonical) — never a non-q-routing action.

function walkHtml(dir, out = []) {
    if (!fs.existsSync(dir)) return out;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
            if (ent.name === 'admin') continue; // admin uses its own chrome
            walkHtml(full, out);
        } else if (ent.isFile() && full.endsWith('.html')) {
            out.push(full);
        }
    }
    return out;
}

const HTML_FILES = walkHtml(INK);

test('every #site-search-form is method=GET, posts to /search, and carries name="q"', () => {
    let checked = 0;
    const offenders = [];
    for (const file of HTML_FILES) {
        const html = READ(file);
        const formRe = /<form[^>]*\bid="site-search-form"[^>]*>[\s\S]*?<\/form>/g;
        let m;
        while ((m = formRe.exec(html)) !== null) {
            checked++;
            const block = m[0];
            const openTag = block.slice(0, block.indexOf('>') + 1);
            const ok =
                /\bmethod="GET"/i.test(openTag) &&
                /\baction="\/search"/.test(openTag) &&
                /name="q"/.test(block);
            if (!ok) offenders.push(path.relative(ROOT, file) + ' :: ' + openTag.trim());
        }
    }
    assert.ok(checked >= 20, `expected 20+ #site-search-form forms, found ${checked}`);
    assert.deepEqual(
        offenders, [],
        'Every header search form must degrade to a native GET to /search?q= when JS is ' +
        'absent. Offenders (missing method=GET / action="/search" / name="q"):\n  ' +
        offenders.join('\n  '),
    );
});

test('the magnifier in each search form is type="submit" (so a click triggers submit)', () => {
    let checked = 0;
    const offenders = [];
    for (const file of HTML_FILES) {
        const html = READ(file);
        const formRe = /<form[^>]*\bclass="search-form[^"]*"[^>]*>[\s\S]*?<\/form>/g;
        let m;
        while ((m = formRe.exec(html)) !== null) {
            // Ink Finder uses .ink-finder__cartridge-form, not .search-form, so
            // this regex only ever matches the real search affordances.
            checked++;
            const hasSubmitMagnifier =
                /<button[^>]*\btype="submit"[^>]*\bclass="[^"]*\bsearch-form__button/.test(m[0]) ||
                /<button[^>]*\bclass="[^"]*\bsearch-form__button[^"]*"[^>]*\btype="submit"/.test(m[0]);
            if (!hasSubmitMagnifier) offenders.push(path.relative(ROOT, file));
        }
    }
    assert.ok(checked >= 20, `expected 20+ search forms, found ${checked}`);
    assert.deepEqual(
        offenders, [],
        'Each .search-form must keep its magnifier as <button type="submit" class="search-form__button"> — ' +
        'a type="button" magnifier would never trigger form submission.\nOffenders:\n  ' +
        offenders.join('\n  '),
    );
});

test('the Ink Finder cartridge form is NOT rewritten to /search (it legitimately targets /shop)', () => {
    const index = READ(path.join(INK, 'html', 'index.html'));
    assert.match(
        index,
        /<form class="ink-finder__cartridge-form" action="\/shop" method="GET">/,
        'The Ink Finder form posts brand/printer params to /shop and must stay action="/shop" — ' +
        'only the keyword search forms were aligned to /search.',
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 — vercel.json routes /search (and /shop) to the q-reading shop page
// ─────────────────────────────────────────────────────────────────────────────
//
// This is the routing equivalence that makes both the JS path (/search?q=)
// and the native fallback resolve to the same search-results view.

test('vercel.json rewrites both /search and /shop to the shop page', () => {
    const vercel = READ(path.join(INK, 'vercel.json'));
    const json = JSON.parse(vercel);
    const rewrites = json.rewrites || [];
    // A ?q= search has no `printer` query param, so the conditional
    // bot-prerender proxy rewrites (which require `has: printer`) don't
    // match — the request falls through to the UNCONDITIONAL rewrite. Pin
    // that one (no `has`/`missing` guard).
    const unconditionalDest = (src) => {
        const r = rewrites.find((x) => x.source === src && !x.has && !x.missing);
        return r && r.destination;
    };
    assert.equal(unconditionalDest('/search'), '/html/shop',
        'vercel.json must unconditionally rewrite /search → /html/shop so the JS destination renders search results');
    assert.equal(unconditionalDest('/shop'), '/html/shop',
        'vercel.json must unconditionally rewrite /shop → /html/shop so the legacy/native fallback ALSO renders ' +
        'search results when ?q= is present (this is why the old action="/shop" was never a hard bug)');
});
