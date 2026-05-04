/**
 * Search-dropdown height contract
 * ================================
 *
 * The smart-autocomplete dropdown shows a 6-column grid of product
 * cards (desktop) below the global search bar. With the previous cap
 * of `max-height: min(76vh, 680px)` the second row of cards was
 * clipped — the "Add to Cart" buttons disappeared off the bottom.
 *
 * Fix: the dropdown's max-height is now driven by JS, sized to fill
 * the available viewport beneath the input (window.innerHeight - top
 * - 16px), so two full rows + the sticky View-all footer always fit
 * regardless of viewport size. CSS keeps a viewport-derived fallback
 * so first paint (before JS runs) and any no-JS preview still render
 * sensibly.
 *
 * These tests pin both halves of the contract:
 *   - search.css: the grid dropdown rule reads `--smart-ac-max-height`
 *     and the fallback is viewport-derived (no fixed-pixel cap that
 *     would re-introduce the clipping).
 *   - search.js: positionDropdown() sets `--smart-ac-max-height` from
 *     the live viewport (driven by window.innerHeight + inputRect),
 *     and rebinds on resize + scroll.
 *
 * Run with: node --test tests/search-dropdown-height.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CSS_PATH = path.join(ROOT, 'inkcartridges', 'css', 'search.css');
const JS_PATH = path.join(ROOT, 'inkcartridges', 'js', 'search.js');

function ruleBody(css, selector) {
    const idx = css.indexOf(selector);
    assert.ok(idx !== -1, `selector not found: ${selector}`);
    const open = css.indexOf('{', idx);
    let depth = 1;
    let i = open + 1;
    while (i < css.length && depth > 0) {
        if (css[i] === '{') depth++;
        else if (css[i] === '}') depth--;
        if (depth === 0) break;
        i++;
    }
    return css.slice(open + 1, i);
}

// ─── CSS contract ──────────────────────────────────────────────────────────

test('search.css — grid dropdown max-height is driven by --smart-ac-max-height', () => {
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    const body = ruleBody(css, '.smart-ac-dropdown:has(.smart-ac__grid)');
    assert.match(
        body,
        /max-height:\s*var\(\s*--smart-ac-max-height\s*,/,
        'grid dropdown must read --smart-ac-max-height (set by positionDropdown)',
    );
});

test('search.css — grid dropdown max-height fallback is viewport-derived (no static <=680px cap)', () => {
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    const body = ruleBody(css, '.smart-ac-dropdown:has(.smart-ac__grid)');
    const start = body.search(/max-height:\s*var\(\s*--smart-ac-max-height\s*,/);
    assert.ok(start !== -1, 'expected max-height: var(--smart-ac-max-height, ...) declaration');
    // Walk the var() expression with a paren-depth counter to capture the
    // fallback even when it contains nested calc()/min()/max() calls.
    let i = body.indexOf('(', start);
    let depth = 1;
    let commaAt = -1;
    i++;
    while (i < body.length && depth > 0) {
        const ch = body[i];
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        else if (ch === ',' && depth === 1 && commaAt === -1) commaAt = i;
        if (depth === 0) break;
        i++;
    }
    assert.ok(commaAt !== -1 && i > commaAt, 'var() must include a fallback after the comma');
    const fallback = body.slice(commaAt + 1, i).trim();
    // Must reference the viewport so it adapts to window size — not a
    // bare pixel value, and not the old min(76vh, 680px) clip.
    assert.match(fallback, /\b100vh\b|\bvh\b/, `fallback must be viewport-derived, got: ${fallback}`);
    assert.doesNotMatch(fallback, /\b680px\b/, 'must not re-introduce the 680px clip that hid row 2');
});

test('search.css — old fixed cap min(76vh, 680px) is removed from the grid rule', () => {
    const css = fs.readFileSync(CSS_PATH, 'utf8');
    const body = ruleBody(css, '.smart-ac-dropdown:has(.smart-ac__grid)');
    assert.doesNotMatch(
        body,
        /min\(\s*76vh\s*,\s*680px\s*\)/,
        'the prior min(76vh, 680px) cap clipped row 2 — it must stay gone',
    );
});

// ─── JS contract ───────────────────────────────────────────────────────────

test('search.js — positionDropdown sets --smart-ac-max-height from the live viewport', () => {
    const js = fs.readFileSync(JS_PATH, 'utf8');

    const fnIdx = js.indexOf('function positionDropdown(');
    assert.ok(fnIdx !== -1, 'positionDropdown function must exist');
    // Slice out just the function body so other functions don't leak in.
    const open = js.indexOf('{', fnIdx);
    let depth = 1;
    let i = open + 1;
    while (i < js.length && depth > 0) {
        if (js[i] === '{') depth++;
        else if (js[i] === '}') depth--;
        if (depth === 0) break;
        i++;
    }
    const body = js.slice(open + 1, i);

    assert.match(
        body,
        /setProperty\(\s*['"`]--smart-ac-max-height['"`]/,
        'positionDropdown must set --smart-ac-max-height on the dropdown',
    );
    assert.match(
        body,
        /window\.innerHeight/,
        'max-height must be derived from window.innerHeight (live viewport)',
    );
    assert.match(
        body,
        /inputRect|input\.getBoundingClientRect/,
        'max-height must subtract the input bottom so the dropdown fills space below it',
    );
});

test('search.js — positionDropdown is rebound on resize and scroll', () => {
    const js = fs.readFileSync(JS_PATH, 'utf8');
    assert.match(
        js,
        /addEventListener\(\s*['"`]resize['"`][^;]*positionDropdown\(\)/,
        'resize must re-run positionDropdown so max-height tracks window resizes',
    );
    assert.match(
        js,
        /addEventListener\(\s*['"`]scroll['"`][^;]*positionDropdown\(\)/,
        'scroll must re-run positionDropdown so the dropdown re-fits when sticky bars shift',
    );
});

// ─── Behavioral simulation ────────────────────────────────────────────────

/**
 * Simulate positionDropdown() against the current source by stubbing
 * the DOM surface it touches. This catches drift between the math and
 * the documented "fill-the-viewport-below-input" intent.
 */
function simulatePositionDropdown({ innerWidth, innerHeight, inputBottom, formLeft, formWidth }) {
    const props = {};
    const dropdown = {
        style: { setProperty: (k, v) => { props[k] = v; } },
    };
    const state = {
        input: {
            getBoundingClientRect: () => ({ bottom: inputBottom, top: inputBottom - 40, left: formLeft, right: formLeft + formWidth, width: formWidth, height: 40 }),
        },
        form: {
            getBoundingClientRect: () => ({ left: formLeft, right: formLeft + formWidth, width: formWidth, top: inputBottom - 40, bottom: inputBottom, height: 40 }),
        },
        dropdown,
    };
    const window = { innerWidth, innerHeight };

    // Read positionDropdown body and evaluate it with an injected scope.
    const js = fs.readFileSync(JS_PATH, 'utf8');
    const fnStart = js.indexOf('function positionDropdown(');
    const open = js.indexOf('{', fnStart);
    let depth = 1;
    let i = open + 1;
    while (i < js.length && depth > 0) {
        if (js[i] === '{') depth++;
        else if (js[i] === '}') depth--;
        if (depth === 0) break;
        i++;
    }
    const body = js.slice(open + 1, i);
    const fn = new Function('state', 'window', body);
    fn(state, window);
    return props;
}

test('positionDropdown — on a 1300px-tall viewport, max-height fills space below the input', () => {
    // Mirrors the screenshot the user reported: input bottom ~390px, viewport ~1300px.
    const props = simulatePositionDropdown({
        innerWidth: 1920,
        innerHeight: 1300,
        inputBottom: 390,
        formLeft: 200,
        formWidth: 1500,
    });
    const px = parseInt(props['--smart-ac-max-height'], 10);
    // top = 390 + 6 = 396; max = 1300 - 396 - 16 = 888
    assert.equal(px, 888, 'expected dropdown to claim full available height (~888px), not the old 680px cap');
    // Sanity: this must comfortably hold two rows of cards (~370px each)
    // plus the sticky View-all footer (~50px). 2 * 370 + 50 = 790px.
    assert.ok(px >= 790, `max-height ${px}px must fit two rows of cards + footer (≥790px)`);
});

test('positionDropdown — short viewport falls back to a usable floor (≥280px)', () => {
    // A user with a small/zoomed window or split-screen — never collapse to 0.
    const props = simulatePositionDropdown({
        innerWidth: 1280,
        innerHeight: 360,
        inputBottom: 340,
        formLeft: 100,
        formWidth: 800,
    });
    const px = parseInt(props['--smart-ac-max-height'], 10);
    assert.ok(px >= 280, `floor must be at least 280px, got ${px}`);
});

test('positionDropdown — large viewport scales up past the old 680px cap', () => {
    const props = simulatePositionDropdown({
        innerWidth: 2560,
        innerHeight: 1600,
        inputBottom: 200,
        formLeft: 400,
        formWidth: 1700,
    });
    const px = parseInt(props['--smart-ac-max-height'], 10);
    assert.ok(px > 680, `large viewport must exceed the old 680px cap, got ${px}`);
});
