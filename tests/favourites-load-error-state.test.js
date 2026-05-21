/**
 * FAVOURITES LOAD-ERROR STATE — a failed load must never look like "empty"
 * ========================================================================
 *
 * Root cause of the 2026-05-20 "I favourited it but My Favourites is empty"
 * report (errors.md ERR-032):
 *
 *   - The storefront WAS calling GET /api/user/favourites, WITH a valid
 *     `Authorization: Bearer <jwt>` header (verified live via Playwright +
 *     curl). The backend dev's "the page never calls the API / has no auth
 *     header" diagnosis was wrong.
 *   - The real fault is backend-side: GET /api/user/favourites returns
 *     HTTP 500 ("Failed to fetch favourites") in EVERY state — zero rows,
 *     one row, after delete — while POST (201), DELETE (200) and
 *     check/:id (200) all succeed with the same token. So the list handler
 *     is systemically broken, not data- or user-specific.
 *   - The FRONTEND defect this test pins: api.js resolves a 500 as a
 *     { ok:false, ... } envelope (it does NOT throw on 5xx), so the old
 *     loadFromServer() skipped its `if (response.ok && response.data)`
 *     block, left `items` empty, hit no catch, and renderFavouritesPage()
 *     showed "You haven't saved any favourites yet." A backend outage thus
 *     masqueraded as an empty wishlist and stayed invisible for a week.
 *
 * The fix (js/favourites.js + js/favourites-page.js):
 *   - loadFromServer records `loadError = { message, requestId }` whenever
 *     the response isn't ok (or throws) — never silently empties the list.
 *   - renderFavouritesPage shows a real error+retry state BEFORE the
 *     items.length === 0 empty-state check.
 *   - loads are de-duped through a shared `_loadPromise` (init + auth-change
 *     + page controller stop firing 2-3 GETs).
 *   - the page controller is authoritative: it calls ensureLoaded() and
 *     renders, instead of racing the global init() double-render.
 *
 * Run with: node --test tests/favourites-load-error-state.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const FAV_JS = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', 'favourites.js'), 'utf8');
const FAV_PAGE_JS = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', 'favourites-page.js'), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// State fields
// ─────────────────────────────────────────────────────────────────────────────

test('favourites.js declares loadError / loaded / _loadPromise state', () => {
    assert.match(FAV_JS, /\bloadError\s*:/, 'must declare a loadError field to distinguish failure from empty');
    assert.match(FAV_JS, /\bloaded\s*:/, 'must declare a loaded flag so "not loaded yet" ≠ "loaded, empty"');
    assert.match(FAV_JS, /_loadPromise\s*:/, 'must declare an in-flight _loadPromise for de-duping concurrent loads');
});

// ─────────────────────────────────────────────────────────────────────────────
// loadFromServer — failure handling + de-dupe
// ─────────────────────────────────────────────────────────────────────────────

test('loadFromServer de-dupes via the shared in-flight promise', () => {
    assert.match(FAV_JS, /if\s*\(\s*this\._loadPromise\s*\)\s*return\s+this\._loadPromise/,
        'loadFromServer must return the in-flight promise so init + auth-change + page do not fire duplicate GETs');
});

test('a non-ok response sets loadError instead of silently emptying the list', () => {
    // The guard must reject anything that is not strictly ok === true, because
    // api.js returns a resolved { ok:false, code:'INTERNAL_ERROR', status:500 }
    // envelope for a 500 (it does not throw).
    assert.match(FAV_JS, /response\.ok\s*!==\s*true/,
        'must branch on response.ok !== true (500 resolves as ok:false, not a throw)');
    assert.match(FAV_JS, /this\.loadError\s*=\s*\{[\s\S]*?requestId/,
        'a failed load must populate loadError with a requestId for log correlation');

    // The legacy silent-empty pattern must be gone, scoped to the load
    // function: its catch must NOT reset items to [] (that is exactly what
    // masked the 500 as an empty wishlist). The logout handler's
    // `this.items = []` elsewhere is legitimate, so scope the check.
    const loadFnStart = FAV_JS.indexOf('async _doLoadFromServer');
    const loadFnEnd = FAV_JS.indexOf('async ensureLoaded');
    assert.ok(loadFnStart !== -1 && loadFnEnd > loadFnStart, 'could not locate the load function body');
    const loadFnBody = FAV_JS.slice(loadFnStart, loadFnEnd);
    assert.doesNotMatch(loadFnBody, /this\.items\s*=\s*\[\]/,
        'the load function must not wipe items to [] on failure — a failed load is not an empty list');
    assert.match(loadFnBody, /catch\s*\([^)]*\)\s*\{[\s\S]*?this\.loadError\s*=/,
        'the load function catch must record loadError (network/parse failures must surface, not vanish)');
});

test('a successful load sets loaded = true', () => {
    assert.match(FAV_JS, /this\.loaded\s*=\s*true/,
        'loadFromServer must mark loaded = true only on a genuine ok response');
});

// ─────────────────────────────────────────────────────────────────────────────
// renderFavouritesPage — error branch precedes empty branch
// ─────────────────────────────────────────────────────────────────────────────

test('renderFavouritesPage renders an error+retry state before the empty-state check', () => {
    const errIdx = FAV_JS.search(/if\s*\(\s*this\.loadError\s*\)/);
    const emptyIdx = FAV_JS.search(/if\s*\(\s*this\.items\.length\s*===\s*0\s*\)/);
    assert.ok(errIdx !== -1, 'renderFavouritesPage must have an `if (this.loadError)` branch');
    assert.ok(emptyIdx !== -1, 'renderFavouritesPage must still have the items.length === 0 empty-state branch');
    assert.ok(errIdx < emptyIdx,
        'the loadError branch must run BEFORE the empty-state branch, else a failed load still shows "no favourites"');
});

test('the error state offers a retry wired to reload()', () => {
    assert.match(FAV_JS, /favourites-retry/, 'error state needs a retry control (#favourites-retry)');
    assert.match(FAV_JS, /this\.reload\(\)/, 'the retry button must call reload()');
    assert.match(FAV_JS, /async\s+reload\s*\(/, 'reload() must exist');
});

test('the request-id reference shown in the error state is escaped', () => {
    // Defence-in-depth: the requestId is server-supplied; escape it before
    // injecting into innerHTML (house XSS rule).
    assert.match(FAV_JS, /Security\.escapeHtml\(String\(this\.loadError\.requestId\)/,
        'requestId must be passed through Security.escapeHtml before being injected');
});

test('ensureLoaded exists and short-circuits when already loaded', () => {
    assert.match(FAV_JS, /async\s+ensureLoaded\s*\(/, 'ensureLoaded() must exist');
    assert.match(FAV_JS, /if\s*\(\s*this\.loaded\s*&&\s*!this\.loadError\s*\)\s*return/,
        'ensureLoaded must skip a redundant GET when already loaded without error');
});

// ─────────────────────────────────────────────────────────────────────────────
// Page controller is authoritative
// ─────────────────────────────────────────────────────────────────────────────

test('favourites-page.js drives the load via ensureLoaded (not a bare render race)', () => {
    assert.match(FAV_PAGE_JS, /await\s+Favourites\.ensureLoaded\(\)/,
        'the page controller must await ensureLoaded() so the list/empty/error state is final before the user sees it');
    assert.match(FAV_PAGE_JS, /Favourites\.renderFavouritesPage\(\)/,
        'the page controller must render after the load resolves');
    // Spinner must be gated on !loaded so a finished load does not get stuck
    // showing the spinner forever.
    assert.match(FAV_PAGE_JS, /if\s*\(\s*!Favourites\.loaded\s*\)/,
        'the page controller must only force the spinner when not already loaded');
});
