/**
 * BFCACHE RESTORE — sticky "Failed to load…" / "Product not found" guard
 * ======================================================================
 *
 * Pins the contract documented in
 *   readfirst/bfcache-restore-may2026.md
 *
 * Why this exists: clicking a product card and pressing Back fast left
 * the shop page pinned on a "No products found / Failed to load products.
 * Please try again." state. The same race could leave a fresh product
 * detail page on a "Product not found" state.
 *
 * Two cooperating bugs caused the stickiness:
 *
 *   1. When the browser begins navigating away, in-flight `fetch()`
 *      promises reject. The catch handlers on each loader called
 *      `showEmpty('Failed to load products. Please try again.')` BEFORE
 *      the page unloaded, mutating the DOM mid-flight.
 *
 *   2. Chrome's back/forward cache then snapshotted that mutated DOM
 *      verbatim. Pressing Back restored the snapshot — pageshow fires
 *      with `event.persisted === true`, but DOMContentLoaded does NOT,
 *      so the page never re-runs its `init()`. The empty-error state
 *      sticks until the user reloads.
 *
 * The fix in `js/shop-page.js`, `js/product-detail-page.js`, and
 * `js/ribbons-page.js`:
 *
 *   - `pagehide` sets `_unloading = true` and bumps `navigationVersion`,
 *     so any in-flight catch handler short-circuits without painting.
 *     `showEmpty` / `showError` ALSO check `_unloading` defensively
 *     (belt-and-suspenders for any non-navigationVersion code path).
 *   - `pageshow` clears `_unloading`, and on `event.persisted === true`
 *     re-runs the loader so the user sees fresh data.
 *
 * Run with: node --test tests/bfcache-restore-may2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SHOP_PAGE_JS = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', 'shop-page.js'), 'utf8');
const PRODUCT_PAGE_JS = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', 'product-detail-page.js'), 'utf8');
const RIBBONS_PAGE_JS = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', 'ribbons-page.js'), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1 — every list/detail page registers BOTH lifecycle handlers
// ─────────────────────────────────────────────────────────────────────────────

const PAGES = [
    { name: 'shop-page.js', src: SHOP_PAGE_JS },
    { name: 'product-detail-page.js', src: PRODUCT_PAGE_JS },
    { name: 'ribbons-page.js', src: RIBBONS_PAGE_JS },
];

for (const { name, src } of PAGES) {
    test(`${name} — registers a pagehide handler that flips an unloading flag`, () => {
        assert.match(src, /addEventListener\(\s*['"`]pagehide['"`]/,
            `${name} must register a 'pagehide' listener — without it, in-flight catch handlers paint a "Failed to load…" DOM that bfcache snapshots`);
        // The pagehide handler must set _unloading = true so showEmpty/showError
        // short-circuit even on code paths that don't gate on navigationVersion.
        assert.match(src, /pagehide[\s\S]{0,400}_unloading\s*=\s*true/,
            `${name} pagehide handler must set _unloading = true so showEmpty/showError short-circuit during the snapshot window`);
    });

    test(`${name} — registers a pageshow handler that re-inits on bfcache restore`, () => {
        assert.match(src, /addEventListener\(\s*['"`]pageshow['"`]/,
            `${name} must register a 'pageshow' listener — without it, a bfcache-restored snapshot of an error state would never refresh`);
        // The handler must check event.persisted (true only when restored from
        // bfcache; false on every normal load).
        assert.match(src, /pageshow[\s\S]{0,400}\.persisted/,
            `${name} pageshow handler must branch on event.persisted — fresh loads already run init() via DOMContentLoaded; only bfcache restores need re-init`);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2 — _unloading actually short-circuits the error painters
// ─────────────────────────────────────────────────────────────────────────────

test('shop-page.js — DrilldownNav.showEmpty short-circuits when _unloading is true', () => {
    const showEmpty = extractMethodAsFunction(SHOP_PAGE_JS, 'showEmpty');
    let painted = false;
    const ctx = {
        _unloading: true,
        elements: {
            empty: { hidden: true, set hiddenSetter(v) { painted = true; } },
            emptyMessage: { textContent: '' },
        },
    };
    // Make `empty.hidden = false` observable.
    Object.defineProperty(ctx.elements.empty, 'hidden', {
        get() { return this._h; },
        set(v) { this._h = v; if (v === false) painted = true; },
    });
    ctx.elements.empty._h = true;

    showEmpty.call(ctx, 'Failed to load products. Please try again.');
    assert.equal(painted, false,
        'showEmpty must NOT paint the empty/error state while _unloading — otherwise bfcache snapshots a sticky "Failed to load…" view');

    // Sanity: with _unloading = false it still works.
    ctx._unloading = false;
    showEmpty.call(ctx, 'Real empty state');
    assert.equal(ctx.elements.empty._h, false,
        'showEmpty must paint normally when _unloading is false');
    assert.equal(ctx.elements.emptyMessage.textContent, 'Real empty state',
        'showEmpty must set the message text when not unloading');
});

test('product-detail-page.js — ProductPage.showError short-circuits when _unloading is true', () => {
    // Extract by name; this method is a member of an object literal nested
    // inside an IIFE, but extractMethodAsFunction only needs the body.
    const fn = extractMethodAsFunction(PRODUCT_PAGE_JS, 'showError');
    // Rather than build the entire DOM mock surface that showError touches,
    // we trip the early return by asserting that document.getElementById is
    // never called when _unloading=true (the very next line after the guard).
    let getCalls = 0;
    const ctx = { _unloading: true };
    const fakeDocument = { getElementById() { getCalls++; return { textContent: '', innerHTML: '', hidden: true, querySelector() { return { addEventListener() {} }; } }; }, querySelector() { getCalls++; return { hidden: false }; } };
    // Run with `document` in scope.
    runWithGlobals({ document: fakeDocument, Security: { escapeHtml: (s) => s } }, () => fn.call(ctx, 'Failed to load product'));
    assert.equal(getCalls, 0,
        'showError must early-return before touching the DOM when _unloading — otherwise a snapshot of "Product not found" sticks on bfcache restore');

    // Sanity: with _unloading=false, showError DOES touch the DOM.
    ctx._unloading = false;
    runWithGlobals({ document: fakeDocument, Security: { escapeHtml: (s) => s } }, () => fn.call(ctx, 'Failed to load product'));
    assert.ok(getCalls > 0,
        'showError must paint the DOM when not unloading — otherwise the genuine "not found" state never surfaces');
});

test('ribbons-page.js — RibbonsPage.showEmpty short-circuits when _unloading is true', () => {
    const showEmpty = extractMethodAsFunction(RIBBONS_PAGE_JS, 'showEmpty');
    let painted = false;
    const ctx = {
        _unloading: true,
        elements: {
            empty: { _h: true, get hidden() { return this._h; }, set hidden(v) { this._h = v; if (v === false) painted = true; } },
            emptyMessage: { textContent: '' },
        },
    };
    showEmpty.call(ctx, 'Failed to load ribbons. Please try again.');
    assert.equal(painted, false, 'ribbons showEmpty must skip DOM mutation while _unloading');
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 3 — pageshow handlers actually re-run the loader on persisted restores
// ─────────────────────────────────────────────────────────────────────────────

test('shop-page.js — pageshow handler calls loadCurrentLevel when event.persisted is true', () => {
    // Extract the pageshow callback body as a string and assert it includes
    // the right call. We don't eval it (it depends on `this` and a lot of
    // sibling state) — the structural shape is what we want to pin.
    const handler = extractPageshowHandler(SHOP_PAGE_JS);
    assert.ok(handler, 'shop-page.js must register a pageshow handler');
    assert.match(handler, /e\.persisted|event\.persisted/,
        'pageshow handler must read event.persisted — every fresh load fires pageshow too, only persisted restores need re-init');
    assert.match(handler, /loadCurrentLevel/,
        'pageshow handler must call loadCurrentLevel(...) on a bfcache restore so the empty/error DOM is replaced with fresh data');
    assert.match(handler, /navigationVersion\s*\+\+/,
        'pageshow handler must bump navigationVersion before re-loading so any racing in-flight handler from the previous session is neutralized');
});

test('product-detail-page.js — pageshow handler re-runs ProductPage.init on bfcache restore', () => {
    const handler = extractPageshowHandler(PRODUCT_PAGE_JS);
    assert.ok(handler, 'product-detail-page.js must register a pageshow handler');
    assert.match(handler, /e\.persisted|event\.persisted/,
        'pageshow handler must branch on event.persisted');
    assert.match(handler, /ProductPage\.init\(\)/,
        'pageshow handler must call ProductPage.init() on a bfcache restore — DOMContentLoaded does NOT fire on restore so init() is the only re-entry path');
});

test('ribbons-page.js — pageshow handler re-runs the level loader on bfcache restore', () => {
    const handler = extractPageshowHandler(RIBBONS_PAGE_JS);
    assert.ok(handler, 'ribbons-page.js must register a pageshow handler');
    assert.match(handler, /e\.persisted|event\.persisted/,
        'pageshow handler must branch on event.persisted');
    assert.match(handler, /loadProducts|loadBrands/,
        'pageshow handler must call loadProducts(...) or loadBrands() on a bfcache restore');
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 4 — pagehide ALSO bumps navigationVersion so the existing
// "if (this.navigationVersion !== navVersion) return;" guards in every catch
// block neutralize themselves automatically. Belt-and-suspenders with the
// _unloading flag — if a future loader skips the navVersion gate, _unloading
// still saves it; if a future loader skips the _unloading check (e.g.
// because the developer forgot), the navVersion gate still saves it.
// ─────────────────────────────────────────────────────────────────────────────

test('shop-page.js — pagehide handler bumps navigationVersion (defense-in-depth with _unloading)', () => {
    const handler = extractPagehideHandler(SHOP_PAGE_JS);
    assert.ok(handler, 'shop-page.js must register a pagehide handler');
    assert.match(handler, /navigationVersion\s*\+\+/,
        'pagehide handler must bump navigationVersion — every loader catch block already checks navigationVersion before painting, so this is a free belt-and-suspenders guard against a future _unloading-check regression');
    assert.match(handler, /_unloading\s*=\s*true/,
        'pagehide handler must set _unloading = true');
});

test('ribbons-page.js — pagehide handler bumps navigationVersion', () => {
    const handler = extractPagehideHandler(RIBBONS_PAGE_JS);
    assert.ok(handler, 'ribbons-page.js must register a pagehide handler');
    assert.match(handler, /navigationVersion\s*\+\+/,
        'pagehide handler must bump navigationVersion');
});

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract a method body by name and return it as a callable Function.
 * Works on object-literal methods (`name(...) { ... },`) at any indent.
 *
 *   <indent> [async] <name>(args) { ... }
 *
 * The returned function is constructed with `new Function('arg1', ..., body)`
 * so it can be called via `.call(ctx, ...args)` to bind `this`.
 */
function extractMethodAsFunction(src, name) {
    const headerRe = new RegExp(
        `(?<![.\\w])(?:async\\s+)?${name}\\s*\\(([^)]*)\\)\\s*\\{`,
        'gm',
    );
    let m;
    while ((m = headerRe.exec(src)) !== null) {
        const lineStart = src.lastIndexOf('\n', m.index) + 1;
        const linePrefix = src.slice(lineStart, m.index);
        const prefixMatch = linePrefix.match(/^( +)(?:async\s+)?$/);
        if (!prefixMatch) continue;
        const indent = prefixMatch[1];
        const args = m[1];
        const after = m.index + m[0].length;
        const closeRe = new RegExp(`\\n${indent}\\}(?:,|\\s*$)`, 'm');
        const tail = src.slice(after);
        const closeMatch = tail.match(closeRe);
        if (!closeMatch) continue;
        const body = tail.slice(0, closeMatch.index);
        // eslint-disable-next-line no-new-func
        return new Function(...args.split(',').map((s) => s.trim()).filter(Boolean), body);
    }
    throw new Error(`method "${name}" not found in source`);
}

/**
 * Extract the body of a `window.addEventListener('pageshow', (e) => { ... })`
 * registration. Returns the body string (everything between the `{` and the
 * matching `}`) so we can match-and-assert structural shapes without eval.
 */
function extractPageshowHandler(src) {
    return extractListenerBody(src, 'pageshow');
}

function extractPagehideHandler(src) {
    return extractListenerBody(src, 'pagehide');
}

function extractListenerBody(src, eventName) {
    const re = new RegExp(`addEventListener\\(\\s*['"\`]${eventName}['"\`]\\s*,\\s*(?:async\\s*)?\\(?\\s*\\w*\\s*\\)?\\s*=>\\s*\\{`, 'g');
    const m = re.exec(src);
    if (!m) return null;
    const start = m.index + m[0].length;
    // Brace-match from `start` until we find the matching close.
    let depth = 1;
    let i = start;
    while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
    }
    if (depth !== 0) return null;
    return src.slice(start, i - 1);
}

/**
 * Run `fn` with the given globals merged onto globalThis, restoring them
 * afterwards. Used to test methods that touch `document` / `Security` etc.
 */
function runWithGlobals(globals, fn) {
    const saved = {};
    const keys = Object.keys(globals);
    for (const k of keys) {
        saved[k] = Object.prototype.hasOwnProperty.call(globalThis, k) ? globalThis[k] : undefined;
        globalThis[k] = globals[k];
    }
    try {
        return fn();
    } finally {
        for (const k of keys) {
            if (saved[k] === undefined) delete globalThis[k];
            else globalThis[k] = saved[k];
        }
    }
}
