/**
 * Admin Color dropdown contract — May 2026
 * =========================================
 *
 * Pins the rule that the admin product drawer's Color field is a
 * canonical-list dropdown, NOT a free-text input. Free-text invited
 * data drift: editors typed "black", "Black", "BLACK", "Blk", and the
 * storefront's K→C→M→Y→CMY→KCMY tier sort (utils.js ProductSort) only
 * recognises the PascalCase-normalised forms ("Black", "Cyan", "CMY",
 * "KCMY", …). One typo on a new SKU and the row falls into TIER_UNKNOWN
 * and lands at the end of the grid.
 *
 * The fix:
 *
 *   1. ProductColors.OPTIONS in inkcartridges/js/utils.js is the single
 *      source of truth for valid color values, ordered to match
 *      ProductSort.COLOR_ORDER (K → C → M → Y → CMY → KCMY → specialty).
 *
 *   2. inkcartridges/js/admin/pages/products.js exposes buildColorSelect()
 *      which builds a <select> from that list. Both the create modal
 *      (~line 681) and edit drawer (~line 936) bind to it.
 *
 *   3. Editing a legacy product whose stored color isn't in the canonical
 *      list still works: the unknown value is appended pre-selected as
 *      "<value> (legacy)" so the editor never silently drops it on save.
 *
 *   4. The save payload still reads `val('edit-color')`, unchanged — the
 *      backend contract (`PUT /api/admin/products/:id` with `color`
 *      string) is identical.
 *
 * Spec: readfirst/admin-color-dropdown-may2026.md
 *
 * Run: node --test tests/admin-color-dropdown.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const JS = (rel) => path.join(ROOT, 'inkcartridges', 'js', rel);
const READ = (rel) => fs.readFileSync(JS(rel), 'utf8');

const UTILS_SRC = READ('utils.js');
const PRODUCTS_ADMIN_SRC = READ('admin/pages/products.js');

// ─────────────────────────────────────────────────────────────────────────────
// 1. ProductColors.OPTIONS is the canonical list
// ─────────────────────────────────────────────────────────────────────────────

function loadProductColors() {
    // utils.js declares `const ProductColors = { ... };` at top-level and
    // assigns to window.ProductColors only when window exists. Run the file
    // in a vm with permissive browser stubs (utils.js touches
    // window.location.hostname for env detection on load) and pull the
    // global back out via the stubbed window.
    const stubWindow = {
        location: { hostname: 'localhost', protocol: 'http:', href: 'http://localhost/' },
        addEventListener: () => {},
        document: { addEventListener: () => {}, readyState: 'complete' },
    };
    const ctx = {
        window: stubWindow,
        document: stubWindow.document,
        console,
        navigator: { userAgent: 'node-test' },
        setTimeout, clearTimeout, setInterval, clearInterval,
    };
    vm.createContext(ctx);
    vm.runInContext(`
        (function(){
            ${UTILS_SRC}
            window.ProductColors = ProductColors;
        })();
    `, ctx);
    return ctx.window.ProductColors;
}

const ProductColors = loadProductColors();

test('ProductColors.OPTIONS exists and is a non-empty array of {value,label}', () => {
    assert.ok(ProductColors, 'ProductColors must be defined');
    assert.ok(Array.isArray(ProductColors.OPTIONS),
        'ProductColors.OPTIONS must be an array');
    assert.ok(ProductColors.OPTIONS.length >= 20,
        `expected ≥20 canonical color options; got ${ProductColors.OPTIONS.length}`);
    for (const opt of ProductColors.OPTIONS) {
        assert.equal(typeof opt.value, 'string', `option ${JSON.stringify(opt)} must have string value`);
        assert.equal(typeof opt.label, 'string', `option ${JSON.stringify(opt)} must have string label`);
        assert.ok(opt.value.length > 0, 'option value must be non-empty');
        assert.ok(opt.label.length > 0, 'option label must be non-empty');
    }
});

test('ProductColors.OPTIONS includes every PascalCase color the backend stores in production', () => {
    // Snapshot (May 2026, 1200-row sample): Black, CMY, Magenta, White,
    // Cyan, Yellow, KCMY, Photo, Black/Red, Value Pack. (Plus null/empty,
    // not represented by an option.) New values entering production must
    // be added here AND to ProductColors.OPTIONS — keeping admin and
    // storefront in lockstep is the whole point of this list.
    const required = [
        'Black', 'Cyan', 'Magenta', 'Yellow',
        'CMY', 'KCMY',
        'Photo',
        'Black/Red',
        'Value Pack',
        'White',
    ];
    const values = ProductColors.OPTIONS.map(o => o.value);
    for (const need of required) {
        assert.ok(values.includes(need),
            `ProductColors.OPTIONS must include '${need}' (observed in production data)`);
    }
});

test('ProductColors.OPTIONS opens with K → C → M → Y → CMY → KCMY in that order', () => {
    // Mirrors ProductSort.COLOR_ORDER tier ordering. The cartridge core
    // colors must come first so an admin scrolling the dropdown sees
    // them at the top, and storefront sort + admin selection share an
    // ordering — there is exactly one canonical sequence.
    const values = ProductColors.OPTIONS.map(o => o.value);
    const indexOf = (v) => values.indexOf(v);

    assert.ok(indexOf('Black')   < indexOf('Cyan'),    'Black must precede Cyan');
    assert.ok(indexOf('Cyan')    < indexOf('Magenta'), 'Cyan must precede Magenta');
    assert.ok(indexOf('Magenta') < indexOf('Yellow'),  'Magenta must precede Yellow');
    assert.ok(indexOf('Yellow')  < indexOf('CMY'),     'Yellow must precede CMY');
    assert.ok(indexOf('CMY')     < indexOf('KCMY'),    'CMY must precede KCMY');

    // Specialty tier (Red/Blue/Green/Gray/etc.) sits after the cartridge core.
    assert.ok(indexOf('KCMY') < indexOf('Red'),  'KCMY must precede Red (specialty tier follows core)');
    assert.ok(indexOf('KCMY') < indexOf('Gray'), 'KCMY must precede Gray (specialty tier follows core)');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. buildColorSelect renders a <select> bound to ProductColors.OPTIONS
// ─────────────────────────────────────────────────────────────────────────────

test('admin/pages/products.js — Color form rows are bound to buildColorSelect, not a text input', () => {
    // Two call sites: the create modal and the edit drawer.
    const createMatch = PRODUCTS_ADMIN_SRC.match(/formGroup\(\s*'Color'\s*,\s*buildColorSelect\(\s*'edit-color'\s*,\s*empty\.color\s*\)\s*\)/);
    assert.ok(createMatch,
        "create modal must render Color via buildColorSelect('edit-color', empty.color)");

    const editMatch = PRODUCTS_ADMIN_SRC.match(/formGroup\(\s*'Color'\s*,\s*buildColorSelect\(\s*'edit-color'\s*,\s*full\.color\s*\)\s*,\s*'color'\s*\)/);
    assert.ok(editMatch,
        "edit drawer must render Color via buildColorSelect('edit-color', full.color) with 'color' override field");

    // No regression to the old text input.
    assert.ok(
        !/formGroup\(\s*'Color'\s*,\s*`<input[^`]*id="edit-color"/.test(PRODUCTS_ADMIN_SRC),
        'no <input id="edit-color"> may remain — Color must be a select');
});

test('admin/pages/products.js — buildColorSelect produces the expected <select> markup', () => {
    // Extract `function buildColorSelect(...) { ... }` and evaluate it in a
    // vm with esc / window stubs. We exercise three states:
    //   (a) selected = '' → blank "Select color…" preselected.
    //   (b) selected = 'Black' → matching canonical option preselected.
    //   (c) selected = 'CustomTeal' → canonical list intact, plus an extra
    //       option `<option value="CustomTeal" selected>CustomTeal (legacy)</option>`.
    const fnMatch = PRODUCTS_ADMIN_SRC.match(/function buildColorSelect\([\s\S]*?\n\}\n/);
    assert.ok(fnMatch, 'buildColorSelect must be defined in admin/pages/products.js');

    const ctx = {
        window: { ProductColors: { OPTIONS: ProductColors.OPTIONS } },
        esc: (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
                                    .replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    };
    vm.createContext(ctx);
    vm.runInContext(`var __r; ${fnMatch[0]}; __r = buildColorSelect;`, ctx);
    const buildColorSelect = ctx.__r;

    // (a) Empty / new product
    const blankHtml = buildColorSelect('edit-color', '');
    assert.match(blankHtml, /^<select class="admin-select" id="edit-color"/,
        'must open a <select> with id="edit-color"');
    assert.match(blankHtml, /data-color-select="canonical"/,
        'must carry the data-color-select="canonical" handle for tests/automation');
    assert.match(blankHtml, /<option value=""\s+selected>Select color/,
        'blank state must preselect the empty placeholder option');
    for (const opt of ProductColors.OPTIONS) {
        const re = new RegExp(`<option value="${opt.value.replace(/[/]/g, '\\/')}"`);
        assert.match(blankHtml, re, `must include canonical option for "${opt.value}"`);
    }

    // (b) Editing a known canonical value
    const blackHtml = buildColorSelect('edit-color', 'Black');
    assert.match(blackHtml, /<option value="Black"\s+selected>Black<\/option>/,
        'matching canonical value must be the one preselected option');
    assert.ok(!/Black\s*\(legacy\)/.test(blackHtml),
        'canonical match must NOT also append a (legacy) duplicate');
    // Placeholder option must NOT also be selected.
    assert.ok(!/<option value=""\s+selected>/.test(blackHtml),
        'placeholder must lose its selected attribute when a real value is set');

    // (c) Legacy / unknown value preserved
    const legacyHtml = buildColorSelect('edit-color', 'CustomTeal');
    assert.match(legacyHtml, /<option value="CustomTeal" selected>CustomTeal \(legacy\)<\/option>/,
        'unknown legacy values must be appended pre-selected with a (legacy) suffix');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Save payload still reads val('edit-color') — backend contract unchanged
// ─────────────────────────────────────────────────────────────────────────────

test('admin/pages/products.js — both save handlers still read val(\'edit-color\') into the payload', () => {
    // Two save paths: createProduct (create modal) and updateProduct (edit drawer).
    // Both must still wire `color: val('edit-color')` into the JSON they POST/PUT.
    const occurrences = PRODUCTS_ADMIN_SRC.match(/color:\s*val\(['"]edit-color['"]\)/g) || [];
    assert.ok(occurrences.length >= 2,
        `expected ≥2 'color: val("edit-color")' lines (create + update); got ${occurrences.length}`);
});

test('admin/pages/products.js — buildColorSelect is exposed near buildSelect (co-located helper)', () => {
    // Co-location matters because future devs adding a new canonical-list
    // field (e.g. the inevitable "Compatibility Family" select) will copy
    // the nearest pattern. Keep the two helpers next to each other so the
    // dropdown story is one clear neighbourhood, not scattered.
    const buildSelectIdx = PRODUCTS_ADMIN_SRC.indexOf('function buildSelect(');
    const buildColorIdx  = PRODUCTS_ADMIN_SRC.indexOf('function buildColorSelect(');
    assert.ok(buildSelectIdx > 0, 'buildSelect must exist');
    assert.ok(buildColorIdx > 0,  'buildColorSelect must exist');
    assert.ok(buildColorIdx > buildSelectIdx,
        'buildColorSelect should be defined just below buildSelect');
    // No huge gap (sanity: <2KB between them).
    assert.ok(buildColorIdx - buildSelectIdx < 2000,
        'buildColorSelect should sit close to buildSelect, not scattered elsewhere');
});
