/**
 * Recent-search chip → Enter / magnifier does nothing — fix
 * =========================================================
 *
 * Pins the storefront fix for the backend-team handoff
 *   ~/Downloads/search-recent-chip-no-submit-jun2026.md
 *
 * THE BUG (root-caused from a prod screenshot 2026-06-21)
 * ------------------------------------------------------
 * Clicking a RECENT SEARCHES chip wrote the chip text into #search-input via a
 * plain `input.value = …` assignment. That does NOT fire an 'input' event, so
 * main.js's syncSubmitState() — which is what re-enables the magnifier/submit
 * button once the box has >= 2 chars — never ran. The submit button kept its
 * empty-box state: `disabled`. A disabled submit button is a no-op for BOTH the
 * Enter key (HTML implicit submission clicks the form's default submit button)
 * AND a direct magnifier click. So both affordances died together, and only on
 * the chip path. The user was left staring at a filled-but-dead search box.
 *
 * THE FIX (two layers)
 * --------------------
 *  1. Primary (search.js): a recent-search chip now navigates directly to
 *     /search?q=<encoded> — the same destination as Enter / "View all results"
 *     (the three-handler routing contract, search-dropdown-routing.md). This is
 *     immune to the submit-button state entirely: there is no box to be dead.
 *  2. Defense-in-depth (main.js): syncSubmitState() is re-run on 'focus' and
 *     'change' too, not just 'input'. Any programmatic `value =` from any other
 *     source (browser autofill, bfcache restore, a future fill path) can no
 *     longer leave the submit button stale-disabled.
 *
 * Run with: node --test tests/search-recent-chip-no-submit-jun2026.test.js
 *
 * The tests run the REAL handlers (not just source greps):
 *   Pass A — drive SmartSearch.init() through a fake DOM, capture the real
 *            onListClick, and fire synthetic chip clicks.
 *   Pass B — drive main.js initSearch() through a fake DOM and exercise the
 *            real syncSubmitState() / submit handler.
 *   Pass C — source-grep regression guards so the fix can't silently rot.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const JS = (rel) => path.join(ROOT, 'inkcartridges', 'js', rel);
const SEARCH_JS = fs.readFileSync(JS('search.js'), 'utf8');
const MAIN_JS = fs.readFileSync(JS('main.js'), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// Fake-DOM scaffolding (no jsdom in repo)
// ─────────────────────────────────────────────────────────────────────────────

function makeNode(nodeName) {
    return {
        nodeName: nodeName || 'DIV',
        _attrs: {},
        _handlers: {},
        _html: '',
        _value: '',
        _disabled: false,
        style: {},
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        set className(v) { this._className = v; },
        get className() { return this._className || ''; },
        set id(v) { this._id = v; },
        get id() { return this._id || ''; },
        set innerHTML(v) { this._html = String(v); },
        get innerHTML() { return this._html; },
        set value(v) { this._value = v == null ? '' : String(v); },
        get value() { return this._value; },
        set disabled(v) { this._disabled = !!v; },
        get disabled() { return this._disabled; },
        addEventListener(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
        removeEventListener() {},
        setAttribute(k, v) { this._attrs[k] = String(v); },
        getAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k) ? this._attrs[k] : null; },
        removeAttribute(k) { delete this._attrs[k]; },
        hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this._attrs, k); },
        appendChild(c) { (this._kids = this._kids || []).push(c); return c; },
        contains() { return false; },
        closest() { return null; },
        focus() {},
        blur() {},
        dispatchEvent() { return true; },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        // test helper: invoke registered listeners
        fire(type, ev) { (this._handlers[type] || []).slice().forEach((fn) => fn(ev || {})); },
    };
}

function makeSandbox() {
    const navigations = [];
    const lsData = {};
    const sandbox = {
        console,
        navigations,
        Intl,
        URL,
        URLSearchParams,
        encodeURIComponent,
        decodeURIComponent,
        setTimeout,
        clearTimeout,
        Date,
        JSON,
        Math,
        Array,
        Object,
        Promise,
        // search.js's trending IIFE calls fetch(); reject so it falls back.
        fetch: () => Promise.reject(new Error('no network in test')),
        localStorage: {
            getItem: (k) => (Object.prototype.hasOwnProperty.call(lsData, k) ? lsData[k] : null),
            setItem: (k, v) => { lsData[k] = String(v); },
            removeItem: (k) => { delete lsData[k]; },
        },
        location: {
            _href: 'http://localhost/',
            get href() { return this._href; },
            set href(v) { navigations.push(String(v)); this._href = String(v); },
            assign(v) { navigations.push(String(v)); this._href = String(v); },
            pathname: '/',
            search: '',
        },
    };
    sandbox.document = {
        addEventListener() {},
        removeEventListener() {},
        createElement: () => makeNode('DIV'),
        querySelector: () => null,
        querySelectorAll: () => [],
    };
    sandbox.history = { scrollRestoration: 'auto', pushState() {}, replaceState() {} };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;
    sandbox.getComputedStyle = () => ({ position: 'relative' });
    sandbox.window.getComputedStyle = sandbox.getComputedStyle;
    sandbox.window.addEventListener = () => {};
    sandbox.window.removeEventListener = () => {};
    sandbox.window.innerWidth = 1280;
    sandbox.window.innerHeight = 800;
    sandbox._ls = lsData;
    return sandbox;
}

function loadInto(env, ...relPaths) {
    const ctx = vm.createContext(env);
    for (const rel of relPaths) {
        vm.runInContext(fs.readFileSync(JS(rel), 'utf8'), ctx, { filename: rel });
    }
    return ctx;
}

/**
 * Synthetic click event whose target.closest() resolves to a fake chip with
 * the given attributes. Mirrors what the browser hands onListClick().
 */
function chipClickEvent(attrs) {
    const chip = { getAttribute: (k) => (Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null) };
    return {
        preventDefault() {},
        stopPropagation() {},
        target: {
            closest(sel) {
                if (sel === '.smart-ac__chip') return chip;
                return null; // not a clear-recent button, not a product card
            },
        },
    };
}

/**
 * Boot SmartSearch.init() against a fake form/input and return the captured
 * real onListClick handler plus the live sandbox.
 */
function bootSmartSearch() {
    const env = makeSandbox();
    const list = makeNode('DIV');
    const live = makeNode('DIV');
    const wrap = makeNode('DIV');
    wrap.querySelector = (sel) => (sel.includes('list') ? list : sel.includes('live') ? live : null);
    env.document.createElement = () => wrap;

    const form = makeNode('FORM');
    form.querySelector = () => null; // no pre-existing dropdown
    const input = makeNode('INPUT');

    loadInto(env, 'utils.js', 'security.js', 'search.js');
    assert.equal(typeof env.SmartSearch, 'object', 'SmartSearch must be exposed on window');
    env.SmartSearch.init(form, input);

    const clickHandlers = list._handlers.click || [];
    assert.ok(clickHandlers.length, 'onListClick must be bound to the dropdown list');
    return { env, input, list, fireListClick: (ev) => clickHandlers.forEach((fn) => fn(ev)) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pass A — behavioral: the REAL onListClick on the recent-search chip path
// ─────────────────────────────────────────────────────────────────────────────

test('A1: recent-search chip navigates straight to /search?q= (single token)', () => {
    const { env, fireListClick } = bootSmartSearch();
    fireListClick(chipClickEvent({ 'data-chip': 'lc432' }));
    assert.deepEqual(env.navigations, ['/search?q=lc432'],
        'a recent chip must route to /search?q=<chip>, like Enter / "View all results"');
});

test('A2: multi-word chip is URL-encoded (Epson WORK FORCE 3640)', () => {
    const { env, fireListClick } = bootSmartSearch();
    fireListClick(chipClickEvent({ 'data-chip': 'Epson WORK FORCE 3640' }));
    assert.deepEqual(env.navigations, ['/search?q=Epson%20WORK%20FORCE%203640'],
        'spaces and case must survive via encodeURIComponent');
});

test('A3: short numeric codes (t073, 073) each navigate', () => {
    for (const q of ['t073', '073']) {
        const { env, fireListClick } = bootSmartSearch();
        fireListClick(chipClickEvent({ 'data-chip': q }));
        assert.deepEqual(env.navigations, [`/search?q=${q}`], `chip "${q}" must navigate`);
    }
});

test('A4: clicking a recent chip bumps it back to the top of recents', () => {
    const { env, fireListClick } = bootSmartSearch();
    fireListClick(chipClickEvent({ 'data-chip': 'lc432' }));
    const recents = JSON.parse(env._ls.recentSearches || '[]');
    assert.equal(recents[0], 'lc432', 'the re-run query should be saved at the head of recentSearches');
});

test('A5: whitespace-only / empty chip is a no-op (no navigation)', () => {
    const { env, fireListClick } = bootSmartSearch();
    fireListClick(chipClickEvent({ 'data-chip': '   ' }));
    assert.deepEqual(env.navigations, [], 'a blank chip must not navigate');
});

test('A6: chip text is trimmed before building the URL', () => {
    const { env, fireListClick } = bootSmartSearch();
    fireListClick(chipClickEvent({ 'data-chip': '  lc432  ' }));
    assert.deepEqual(env.navigations, ['/search?q=lc432'], 'leading/trailing space must be trimmed');
});

test('A7: trending-printer chip still routes to /shop (regression — printer branch untouched)', () => {
    const { env, fireListClick } = bootSmartSearch();
    fireListClick(chipClickEvent({
        'data-printer-slug': 'brother-mfc-1770',
        'data-printer-name': 'Brother MFC-1770',
        'data-printer-brand-slug': 'brother',
    }));
    assert.deepEqual(env.navigations, ['/shop?brand=brother&printer_slug=brother-mfc-1770'],
        'a trending-printer chip must still go to the canonical /shop printer URL, not /search');
});

// ─────────────────────────────────────────────────────────────────────────────
// Pass B — behavioral: main.js syncSubmitState() + submit routing
// ─────────────────────────────────────────────────────────────────────────────

function bootMainSearch() {
    const env = makeSandbox();
    const form = makeNode('FORM');
    const input = makeNode('INPUT');
    input.setAttribute('type', 'search');
    const submitBtn = makeNode('BUTTON');
    submitBtn.setAttribute('type', 'submit');

    form.querySelector = (sel) => {
        if (sel.includes('input')) return input;
        if (sel.includes('button')) return submitBtn;
        return null;
    };
    form.closest = () => null; // not inside .primary-nav → skip the expand animation branch
    env.document.querySelectorAll = (sel) => (sel === '.search-form' ? [form] : []);

    loadInto(env, 'utils.js', 'main.js');
    assert.equal(typeof env.initSearch, 'function', 'initSearch must be a top-level function');
    env.initSearch();
    return { env, form, input, submitBtn };
}

test('B1: submit button starts disabled on an empty box', () => {
    const { submitBtn } = bootMainSearch();
    assert.equal(submitBtn.disabled, true, 'an empty search box must keep the submit button disabled (mirrors backend min-len)');
});

test('B2: the original bug — a programmatic value set does NOT re-enable the button on its own', () => {
    const { input, submitBtn } = bootMainSearch();
    input.value = 'lc432';            // exactly what the old chip handler did
    // no 'input' event fired → syncSubmitState never ran
    assert.equal(submitBtn.disabled, true,
        'reproduces the root cause: value-only assignment leaves the submit button stale-disabled');
});

test('B3: defense-in-depth — focus re-syncs the disabled state (button re-enables)', () => {
    const { input, submitBtn } = bootMainSearch();
    input.value = 'lc432';
    input.fire('focus', {});
    assert.equal(submitBtn.disabled, false,
        'focusing the box must re-run syncSubmitState so a filled box never leaves a dead submit button');
    assert.equal(submitBtn.getAttribute('aria-disabled'), 'false', 'aria-disabled must track the disabled state');
});

test('B4: defense-in-depth — change re-syncs the disabled state both ways', () => {
    const { input, submitBtn } = bootMainSearch();
    input.value = 't073';
    input.fire('change', {});
    assert.equal(submitBtn.disabled, false, 'change with valid length enables');
    input.value = 'a';                // below MIN_LEN (2)
    input.fire('change', {});
    assert.equal(submitBtn.disabled, true, 'change below min-len disables again');
});

test('B5: input event still re-syncs (original wiring preserved)', () => {
    const { input, submitBtn } = bootMainSearch();
    input.value = 'lc432';
    input.fire('input', {});
    assert.equal(submitBtn.disabled, false, 'the original input-event sync must remain wired');
});

test('B6: form submit routes to /search?q= and URL-encodes multi-word queries', () => {
    const { env, form, input } = bootMainSearch();
    input.value = 'Epson WORK FORCE 3640';
    let prevented = false;
    form.fire('submit', { preventDefault() { prevented = true; } });
    assert.equal(prevented, true, 'submit handler must preventDefault (SPA navigation)');
    assert.deepEqual(env.navigations, ['/search?q=Epson%20WORK%20FORCE%203640']);
});

test('B7: form submit is guarded below MIN_LEN (no 400-bait navigation)', () => {
    const { env, form, input } = bootMainSearch();
    input.value = 'a';
    form.fire('submit', { preventDefault() {} });
    assert.deepEqual(env.navigations, [], 'a 1-char query must not navigate (mirrors backend Joi min-len)');
});

// ─────────────────────────────────────────────────────────────────────────────
// Pass C — source-grep regression guards
// ─────────────────────────────────────────────────────────────────────────────

test('C1: search.js recent-chip branch navigates to /search?q= via encodeURIComponent', () => {
    // Isolate the data-chip branch: from "const q = chip.getAttribute('data-chip')"
    // through its return.
    const m = SEARCH_JS.match(/const q = \(chip\.getAttribute\('data-chip'\)[\s\S]+?window\.location\.href[\s\S]+?return;/);
    assert.ok(m, 'expected the data-chip recent-search branch in onListClick');
    assert.match(m[0], /window\.location\.href\s*=\s*`\/search\?q=\$\{encodeURIComponent\(q\)\}`/,
        'recent chip must route to /search?q=${encodeURIComponent(q)}');
});

test('C2: search.js recent-chip branch no longer leaves a filled-but-dead box', () => {
    const m = SEARCH_JS.match(/const q = \(chip\.getAttribute\('data-chip'\)[\s\S]+?window\.location\.href[\s\S]+?return;/);
    assert.ok(m);
    assert.doesNotMatch(m[0], /state\.input\.value\s*=/,
        'the recent-chip branch must NOT set input.value then stop — that was the dead-box bug');
    assert.doesNotMatch(m[0], /runSearch\(/,
        'the recent-chip branch must navigate, not run an inline-only search');
});

test('C3: recent-chip branch never branches on matched_printer (routing-contract invariant)', () => {
    const m = SEARCH_JS.match(/const q = \(chip\.getAttribute\('data-chip'\)[\s\S]+?window\.location\.href[\s\S]+?return;/);
    assert.ok(m);
    assert.doesNotMatch(m[0], /matched[_]?[Pp]rinter/,
        'a recent-search chip routes like Enter / "View all results" — it must not read matched_printer');
});

test('C4: main.js re-syncs submit state on focus AND change (defense-in-depth)', () => {
    assert.match(MAIN_JS, /searchInput\.addEventListener\('focus',\s*syncSubmitState\)/,
        'syncSubmitState must be wired to focus so programmatic fills can never strand a disabled button');
    assert.match(MAIN_JS, /searchInput\.addEventListener\('change',\s*syncSubmitState\)/,
        'syncSubmitState must be wired to change as well');
    assert.match(MAIN_JS, /searchInput\.addEventListener\('input',\s*syncSubmitState\)/,
        'the original input-event sync must remain');
});

test('C5: companion fix still present — card add/contact buttons are type="button"', () => {
    // The May-2026 implicit-submit fix keeps the *typed* Enter path clean; this
    // doc ships alongside it. Guard against regression.
    const PRODUCTS_JS = fs.readFileSync(JS('products.js'), 'utf8');
    const addBtns = PRODUCTS_JS.match(/class="product-card__add-btn[^"]*"/g) || [];
    assert.ok(addBtns.length >= 1, 'expected product-card__add-btn markup in products.js');
    // Every add-btn template literal must carry an explicit type="button".
    const btnBlocks = PRODUCTS_JS.match(/<button[\s\S]{0,160}?product-card__add-btn/g) || [];
    assert.ok(btnBlocks.length >= 1);
    for (const b of btnBlocks) {
        assert.match(b, /type="button"/,
            'every card add/contact button must be type="button" so it never becomes the form\'s implicit submitter');
    }
});
