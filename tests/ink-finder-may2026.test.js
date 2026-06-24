/**
 * Ink Finder wiring contract — guided cascade redesign (Jun 2026)
 * ===============================================================
 *
 * Supersedes the May 2026 dropdown+sticky-CTA contract. The "Find ink for your
 * printer" section was redesigned into a breadcrumb-driven, replace-in-place
 * cascade:
 *
 *   brand grid → (click) → series tiles → (click) → model tiles → (click) →
 *   navigate straight to /shop?brand=<slug>&printer_slug=<slug>.
 *
 * Jun 2026 revision: the interstitial confirm card (count-then-confirm) was
 * removed. Clicking a model IS the confirmation, so the finder navigates
 * directly to that printer's cartridges — no "View cartridges" button.
 *
 * Pinned behaviour:
 *   1. One stage visible at a time, with a breadcrumb whose crumbs jump back.
 *   2. Series + model are clickable TILES (not <select> dropdowns), each stage
 *      carrying an always-on type-to-filter box.
 *   3. Clicking a model navigates straight to the printer's cartridges — no
 *      confirm card, no count fetch interstitial.
 *   4. Endpoint contract unchanged: grouped=true default, grouped=false fallback
 *      (also covered by tests/ink-finder-grouped.test.js).
 *   5. Acceptance: finder remembers the user's last brand (localStorage
 *      "ink-finder-last-brand"), default brother.
 *   6. The retired surface — dropdown triggers, the inline "Find Cartridges"
 *      submit button, the sticky CTA, and the Popular chips — is gone.
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
// §1 — Storefront copy + structure
// ─────────────────────────────────────────────────────────────────────────────

test('index.html — heading is "Find ink for your printer"', () => {
    assert.match(
        INDEX_HTML,
        /id="ink-finder-heading"[^>]*>\s*Find ink for your printer\s*</,
        'spec: section heading must read "Find ink for your printer"'
    );
});

test('index.html — breadcrumb with brand/series/model crumbs is present', () => {
    assert.match(INDEX_HTML, /id="finder-breadcrumb"/,
        'cascade must render a breadcrumb (#finder-breadcrumb)');
    for (const stage of ['brand', 'series', 'model']) {
        const re = new RegExp(`finder-breadcrumb__crumb[^>]*data-stage="${stage}"`);
        assert.match(INDEX_HTML, re, `breadcrumb must carry a "${stage}" crumb`);
    }
});

test('index.html — three stages exist, only brand is visible initially', () => {
    // Brand stage is the entry point (not hidden); the rest start hidden.
    assert.match(INDEX_HTML, /id="finder-stage-brand"[^>]*data-stage="brand"/,
        'brand stage must exist');
    for (const stage of ['series', 'model']) {
        const re = new RegExp(`id="finder-stage-${stage}"[^>]*data-stage="${stage}"[^>]*hidden`);
        assert.match(INDEX_HTML, re, `${stage} stage must start hidden`);
    }
    // The brand stage div itself must not be hidden at load.
    assert.doesNotMatch(INDEX_HTML, /id="finder-stage-brand"[^>]*hidden/,
        'brand stage must be visible on load');
});

test('index.html — series & model are tile grids with a filter box each', () => {
    assert.match(INDEX_HTML, /id="finder-series-tiles"/, 'series tiles container required');
    assert.match(INDEX_HTML, /id="finder-model-tiles"/, 'model tiles container required');
    // Always-on filter (chosen design): a filter input in each step.
    assert.match(INDEX_HTML, /id="finder-series-filter"/, 'series filter input required');
    assert.match(INDEX_HTML, /id="finder-model-filter"/, 'model filter input required');
});

test('index.html — interstitial confirm stage is removed (direct navigation)', () => {
    assert.doesNotMatch(INDEX_HTML, /id="finder-stage-confirm"/,
        'the confirm stage must be gone — model clicks navigate straight to results');
    assert.doesNotMatch(INDEX_HTML, /id="finder-confirm-card"/,
        'the confirm card target must be gone — no count-then-confirm step');
});

test('index.html — "By Cartridge Code" tab and "Contact us" help line are kept', () => {
    assert.match(INDEX_HTML, /id="finder-tab-cartridge"/,
        'the cartridge-code tab must remain (kept per design decision)');
    assert.match(INDEX_HTML, /ink-finder__help[\s\S]*?Contact us/,
        'the "Not sure of your model? Contact us" help line must remain');
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — Retired surface must be gone
// ─────────────────────────────────────────────────────────────────────────────

test('index.html — dropdown / submit / sticky / popular surface is retired', () => {
    const banned = [
        [/class="ink-finder__steps"/,            'old 3-step dropdown row'],
        [/id="ink-finder-series-trigger"/,       'old series <select> trigger'],
        [/id="ink-finder-model-trigger"/,        'old model <select> trigger'],
        [/id="ink-finder-submit"/,               'old inline "Find Cartridges" button'],
        [/id="ink-finder-sticky-cta"/,           'old sticky CTA bar'],
        [/class="ink-finder__popular"/,          'old Popular shortcut chips'],
    ];
    for (const [re, label] of banned) {
        assert.doesNotMatch(INDEX_HTML, re, `${label} must be removed from the redesigned finder`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 — CSS for the new surface
// ─────────────────────────────────────────────────────────────────────────────

test('pages.css — ships breadcrumb, tile and filter styles (confirm styles gone)', () => {
    assert.match(PAGES_CSS, /\.finder-breadcrumb\b/,        'breadcrumb styles required');
    assert.match(PAGES_CSS, /\.finder-breadcrumb__crumb--active\b/, 'active-crumb state required');
    assert.match(PAGES_CSS, /\.finder-tile\b/,              'tile styles required');
    assert.match(PAGES_CSS, /\.finder-filter__input\b/,     'filter input styles required');
    assert.doesNotMatch(PAGES_CSS, /\.finder-confirm__/,    'dead confirm-card styles must be removed');
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 — api.js endpoint contract (unchanged: grouped default + grouped=false fallback)
// ─────────────────────────────────────────────────────────────────────────────

function getPrintersByBrandBody() {
    const m = API_CODE.match(/async\s+getPrintersByBrand\s*\([^)]*\)\s*\{[\s\S]+?\n\s{4}\},/);
    assert.ok(m, 'expected getPrintersByBrand function in api.js');
    return m[0];
}

test('api.js getPrintersByBrand — grouped=true default, grouped=false fallback', () => {
    const body = getPrintersByBrandBody();
    assert.match(body, /opts/, 'getPrintersByBrand must accept an options arg');
    assert.match(body, /grouped\s*:\s*false|grouped\s*===\s*false/,
        'getPrintersByBrand must branch on opts.grouped === false');
    assert.match(body, /grouped=false&exclude_non_ink=true/,
        'fallback path must request ?grouped=false&exclude_non_ink=true');
    assert.match(body, /grouped=true&exclude_non_ink=true/,
        'default path must still request ?grouped=true&exclude_non_ink=true');
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 — ink-finder.js wiring
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

test('ink-finder.js — drives a brand→series→model stage machine', () => {
    assert.match(FINDER_CODE, /function\s+goToStage\s*\(/,
        'finder must define goToStage() to swap stages in place');
    assert.match(FINDER_CODE, /function\s+updateBreadcrumb\s*\(/,
        'finder must define updateBreadcrumb()');
    assert.match(FINDER_CODE, /function\s+renderSeriesTiles\s*\(/,
        'finder must render series tiles');
    assert.match(FINDER_CODE, /function\s+renderModelTiles\s*\(/,
        'finder must render model tiles');
});

test('ink-finder.js — clicking a model navigates straight to its cartridges', () => {
    // selectModel is the terminal step: it must call findProducts() directly,
    // with no interstitial confirm card or count fetch.
    const m = FINDER_CODE.match(/function\s+selectModel\s*\([^)]*\)\s*\{[\s\S]+?\n\s{4}\}/);
    assert.ok(m, 'expected a selectModel() function in ink-finder.js');
    assert.match(m[0], /findProducts\s*\(\s*\)/,
        'selectModel must navigate straight to results via findProducts()');
});

test('ink-finder.js — confirm card / count-fetch interstitial is gone', () => {
    const banned = [
        [/function\s+showConfirm\b/,        'showConfirm() interstitial'],
        [/function\s+renderConfirm\b/,      'renderConfirm() interstitial'],
        [/API\.getProductsByPrinter\s*\(/,  'pre-navigation count fetch'],
        [/Choose another model/,            'confirm-card back link'],
        [/finder-confirm/,                  'confirm-card DOM hook'],
    ];
    for (const [re, label] of banned) {
        assert.doesNotMatch(FINDER_CODE, re, `${label} must be removed — model click navigates directly`);
    }
});

test('ink-finder.js — empty fallback re-requests with { grouped: false }', () => {
    assert.match(FINDER_CODE, /API\.getPrintersByBrand\s*\(\s*brand\s*,\s*\{\s*grouped\s*:\s*false\s*\}\s*\)/,
        'finder must re-fetch with { grouped: false } when series_groups is empty');
});

test('ink-finder.js — emits canonical /shop?brand=<slug>&printer_slug=<slug>', () => {
    const usesBuilder = /buildPrinterUrl\s*\(/.test(FINDER_CODE);
    const usesLiteral = /\/shop\?brand=\$\{[^}]+\}&printer_slug=\$\{/.test(FINDER_CODE);
    assert.ok(usesBuilder || usesLiteral,
        'finder must navigate to /shop?brand=<slug>&printer_slug=<slug>');
});

test('ink-finder.js — retired dropdown/sticky/CTA code is gone', () => {
    const banned = [
        [/ink-finder-sticky-cta/,      'sticky CTA reference'],
        [/IntersectionObserver/,       'sticky CTA observer'],
        [/custom-select__option/,      'old dropdown option handling'],
        [/updateCtaLabel/,             'old inline CTA label rewrite'],
    ];
    for (const [re, label] of banned) {
        assert.doesNotMatch(FINDER_CODE, re, `${label} must be removed from the rewritten finder`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §6 — Regression guard: brand button set intact
// ─────────────────────────────────────────────────────────────────────────────

test('index.html — every expected brand button is wired with data-brand', () => {
    const brands = ['brother', 'canon', 'epson', 'hp', 'samsung',
                    'lexmark', 'oki', 'fuji-xerox', 'kyocera'];
    for (const slug of brands) {
        const re = new RegExp(`ink-finder__brand-btn[^>]*data-brand="${slug}"`);
        assert.match(INDEX_HTML, re,
            `brand button for "${slug}" is missing — bootstrap will skip it`);
    }
});
