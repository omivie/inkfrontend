/**
 * Ink Finder wiring contract — May 2026
 * ======================================
 *
 * Pins the spec at readfirst/ink-finder-may2026.md:
 *
 *   1. Endpoint: GET /api/printers/by-brand/<slug>?grouped=true&exclude_non_ink=true
 *      — already covered by tests/ink-finder-grouped.test.js. This file pins
 *      the *wiring* layer on top of that contract.
 *
 *   2. Two-step cascade — series → model — leading to
 *      /shop?brand=<brandSlug>&printer_slug=<modelSlug>.
 *
 *   3. Empty-state fallback — when series_groups is empty, re-fetch with
 *      ?grouped=false and present the flat list. api.js getPrintersByBrand
 *      must accept { grouped: false }.
 *
 *   4. Storefront copy — "Find ink for your printer", "Which series?",
 *      "Which model?", and a CTA that becomes "Show cartridges for <full_name>".
 *
 *   5. Affordances — "✓" prefix on the selected model, sticky CTA at the
 *      bottom of the viewport once both steps complete.
 *
 *   6. Acceptance — homepage finder auto-loads the user's last-selected brand
 *      (localStorage key "ink-finder-last-brand") falling back to brother.
 *
 * Run with: node --test tests/ink-finder-may2026.test.js
 */

'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('node:fs');
const path   = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const READ = (p) => fs.readFileSync(p, 'utf8');

function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
}

const INDEX_HTML  = READ(path.join(ROOT, 'inkcartridges', 'index.html'));
const FINDER_SRC  = READ(path.join(ROOT, 'inkcartridges', 'js', 'ink-finder.js'));
const API_SRC     = READ(path.join(ROOT, 'inkcartridges', 'js', 'api.js'));
const PAGES_CSS   = READ(path.join(ROOT, 'inkcartridges', 'css', 'pages.css'));

const FINDER_CODE = stripComments(FINDER_SRC);
const API_CODE    = stripComments(API_SRC);

// ─────────────────────────────────────────────────────────────────────────────
// §1 — Storefront copy (spec "Storefront copy")
// ─────────────────────────────────────────────────────────────────────────────

test('index.html — heading is "Find ink for your printer"', () => {
    assert.match(
        INDEX_HTML,
        /id="ink-finder-heading"[^>]*>\s*Find ink for your printer\s*</,
        'spec: section heading must read "Find ink for your printer"'
    );
    // The pre-spec wording must not survive — would otherwise cause a flicker
    // if a stale CDN copy lands on a fresh page.
    assert.doesNotMatch(
        INDEX_HTML,
        /id="ink-finder-heading"[^>]*>\s*Find Your Ink Fast\s*</,
        'pre-spec heading "Find Your Ink Fast" must be retired'
    );
});

test('index.html — step 2 prompt is "Which series?"', () => {
    assert.match(
        INDEX_HTML,
        /data-step="2"[\s\S]*?ink-finder__step-label[^>]*>\s*Which series\?\s*</,
        'spec: step 2 label must read "Which series?"'
    );
});

test('index.html — step 3 prompt is "Which model?"', () => {
    assert.match(
        INDEX_HTML,
        /data-step="3"[\s\S]*?ink-finder__step-label[^>]*>\s*Which model\?\s*</,
        'spec: step 3 label must read "Which model?"'
    );
});

test('index.html — submit button has a label span the JS can rewrite', () => {
    // The CTA text becomes "Show cartridges for <full_name>" once both steps
    // complete. The JS swaps textContent on this span — without it, swapping
    // the whole button blows away the icon.
    assert.match(
        INDEX_HTML,
        /id="ink-finder-submit"[\s\S]*?class="ink-finder__btn-label"[^>]*data-default-label="Find Cartridges"/,
        'submit button must wrap its label in <span class="ink-finder__btn-label">'
    );
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — Sticky CTA element (spec "Affordance")
// ─────────────────────────────────────────────────────────────────────────────

test('index.html — sticky CTA element is present', () => {
    assert.match(
        INDEX_HTML,
        /id="ink-finder-sticky-cta"/,
        'spec: a sticky bottom-of-viewport CTA must exist'
    );
    assert.match(
        INDEX_HTML,
        /id="ink-finder-sticky-btn"/,
        'sticky CTA must carry a click target with id="ink-finder-sticky-btn"'
    );
});

test('pages.css — sticky CTA is fixed-bottom with safe-area inset', () => {
    assert.match(PAGES_CSS, /\.ink-finder__sticky-cta\s*\{[^}]*position:\s*fixed/,
        'sticky CTA must be position:fixed');
    assert.match(PAGES_CSS, /\.ink-finder__sticky-cta\s*\{[^}]*bottom:\s*0/,
        'sticky CTA must dock to bottom:0');
    assert.match(PAGES_CSS, /env\(safe-area-inset-bottom/,
        'sticky CTA must respect iOS safe-area-inset-bottom');
});

test('pages.css — sticky CTA has a --visible reveal state', () => {
    assert.match(PAGES_CSS, /\.ink-finder__sticky-cta--visible/,
        'sticky CTA must have a --visible modifier the JS can toggle');
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 — api.js getPrintersByBrand accepts { grouped: false }
// ─────────────────────────────────────────────────────────────────────────────

function getPrintersByBrandBody() {
    const m = API_CODE.match(/async\s+getPrintersByBrand\s*\([^)]*\)\s*\{[\s\S]+?\n\s{4}\},/);
    assert.ok(m, 'expected getPrintersByBrand function in api.js');
    return m[0];
}

test('api.js getPrintersByBrand — accepts { grouped: false } for the empty fallback', () => {
    const body = getPrintersByBrandBody();
    assert.match(body, /opts/,
        'getPrintersByBrand must accept an options arg');
    assert.match(body, /grouped\s*:\s*false|grouped\s*===\s*false/,
        'getPrintersByBrand must branch on opts.grouped === false');
    assert.match(body, /grouped=false&exclude_non_ink=true/,
        'fallback path must request ?grouped=false&exclude_non_ink=true');
    // The default must still be the grouped shape — that's the primary contract.
    assert.match(body, /grouped=true&exclude_non_ink=true/,
        'default path must still request ?grouped=true&exclude_non_ink=true');
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 — ink-finder.js wiring
// ─────────────────────────────────────────────────────────────────────────────

test('ink-finder.js — bootstraps from localStorage with brother fallback', () => {
    assert.match(FINDER_CODE, /ink-finder-last-brand/,
        'finder must persist last-selected brand under "ink-finder-last-brand"');
    assert.match(FINDER_CODE, /DEFAULT_BRAND\s*=\s*['"]brother['"]/,
        'finder must default to brother when no preference is stored');
    assert.match(FINDER_CODE, /function\s+bootstrap\s*\(/,
        'finder must define a bootstrap() that runs on load');
    assert.match(FINDER_CODE, /bootstrap\s*\(\s*\)\s*;/,
        'bootstrap() must be invoked on module init');
});

test('ink-finder.js — empty fallback re-requests with { grouped: false }', () => {
    assert.match(FINDER_CODE, /API\.getPrintersByBrand\s*\(\s*brand\s*,\s*\{\s*grouped\s*:\s*false\s*\}\s*\)/,
        'finder must re-fetch with { grouped: false } when series_groups is empty');
});

test('ink-finder.js — CTA text becomes "Show cartridges for <full_name>"', () => {
    assert.match(FINDER_CODE, /Show cartridges for/,
        'finder must rewrite the CTA to "Show cartridges for <full_name>"');
    assert.match(FINDER_CODE, /function\s+updateCtaLabel/,
        'finder must define updateCtaLabel');
    assert.match(FINDER_CODE, /function\s+resetCtaLabel/,
        'finder must define resetCtaLabel for reverting on brand/series changes');
});

test('ink-finder.js — selected model gets a "✓" prefix in the dropdown', () => {
    // The handler builds `✓ <label>` after a click. We just pin the literal so
    // a refactor that drops the affordance trips this test.
    assert.match(FINDER_CODE, /['"`]✓\s/,
        'finder must prepend "✓ " to the selected model option label');
});

test('ink-finder.js — sticky CTA toggle uses IntersectionObserver', () => {
    assert.match(FINDER_CODE, /IntersectionObserver/,
        'finder must observe the inline button so the sticky bar only shows when it is off-screen');
    assert.match(FINDER_CODE, /ink-finder-sticky-cta/,
        'finder must reference the sticky CTA element id');
});

test('ink-finder.js — emits canonical /shop?brand=<slug>&printer_slug=<slug>', () => {
    // Either via buildPrinterUrl (preferred) or by emitting the literal — both
    // resolve to the same canonical URL. Pin both shapes.
    const usesBuilder = /buildPrinterUrl\s*\(/.test(FINDER_CODE);
    const usesLiteral = /\/shop\?brand=\$\{[^}]+\}&printer_slug=\$\{/.test(FINDER_CODE);
    assert.ok(usesBuilder || usesLiteral,
        'finder must navigate to /shop?brand=<slug>&printer_slug=<slug>');
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 — Regression guard: spec-mandated brand button set is intact
// ─────────────────────────────────────────────────────────────────────────────

test('index.html — every expected brand button is wired with data-brand', () => {
    // 9 brands the storefront exposes today. The bootstrap path validates the
    // localStorage value against this DOM list — losing one silently makes the
    // default-to-Brother fallback no-op for that brand.
    const brands = ['brother', 'canon', 'epson', 'hp', 'samsung',
                    'lexmark', 'oki', 'fuji-xerox', 'kyocera'];
    for (const slug of brands) {
        const re = new RegExp(`ink-finder__brand-btn[^>]*data-brand="${slug}"`);
        assert.match(INDEX_HTML, re,
            `brand button for "${slug}" is missing — bootstrap will skip it`);
    }
});
