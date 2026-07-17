/**
 * Shared address autocomplete + envelope-aware address saves — Jul 2026 (ERR-096)
 * ================================================================================
 *
 * Why this exists: the owner couldn't save an address at /account/addresses —
 * the modal showed "Too many requests. Please wait a moment." Investigation
 * found a cluster of defects around one root cause (the backend's per-IP rate
 * budget is shared between address autocomplete AND account writes):
 *
 *   1. checkout's address autocomplete fired up to SIX requests per debounced
 *      keystroke while both providers were down server-side (NZ Post 500
 *      "not configured", Google Places 502), because api.js auto-retried the
 *      failing GETs — silently draining the global per-IP budget that
 *      POST /api/user/address also draws from.
 *   2. account.js saveAddress() never checked RESOLVED {ok:false} envelopes
 *      (api.js RETURNS them for most error codes) → failed saves closed the
 *      modal and toasted "Address added".
 *   3. closeAddressModal() nulls editingAddressId before the toast ternary →
 *      edits always toasted "Address added" (same bug in savePrinter).
 *   4. checkout's Enter-key suggestion selection called a nonexistent
 *      fillFromDetails(suggestion.place_id) → ReferenceError.
 *   5. The account modal never got the autocomplete integration at all
 *      (ADDRESS_AUTOCOMPLETE_HANDOFF.md was wired into checkout only).
 *
 * The fix: ONE shared module js/address-autocomplete.js (debounce, session
 * cache, stale-response guard, NZ Post circuit breaker, RATE_LIMITED backoff,
 * LOUD fail-soft hint) used by BOTH checkout and the account modal; suggestion
 * GETs opt out of api.js retries via { noRetry: true }; the thrown 429 error
 * carries code + retryAfter so saveAddress can show a countdown; all account
 * mutations go through _assertOk() so error envelopes surface as errors.
 *
 * Run with: node --test tests/address-autocomplete-shared-jul2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const READ = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const MODULE_PATH = 'inkcartridges/js/address-autocomplete.js';
const MODULE_SRC = READ(MODULE_PATH);
const API_SRC = READ('inkcartridges/js/api.js');
const ACCOUNT_SRC = READ('inkcartridges/js/account.js');
const CHECKOUT_SRC = READ('inkcartridges/js/checkout-page.js');
const ADDRESSES_HTML = READ('inkcartridges/html/account/addresses.html');
const CHECKOUT_HTML = READ('inkcartridges/html/checkout.html');
const PAGES_CSS = READ('inkcartridges/css/pages.css');

// ─────────────────────────────────────────────────────────────────────────────
// §1 — shared module source contract
// ─────────────────────────────────────────────────────────────────────────────

test('shared module exists and exposes window.AddressAutocomplete.attach', () => {
    assert.ok(fs.existsSync(path.join(ROOT, MODULE_PATH)), `${MODULE_PATH} must exist`);
    assert.match(MODULE_SRC, /window\.AddressAutocomplete\s*=\s*AddressAutocomplete/,
        'module must publish itself as a window global (no build tools in this repo)');
    assert.match(MODULE_SRC, /attach\s*\(\s*inputId\s*,\s*fieldMap\s*,\s*opts\s*=\s*\{\}\s*\)/,
        'attach(inputId, fieldMap, opts) is the single public entry point');
});

test('module debounces at ≥300ms and requires ≥2 chars (handoff contract)', () => {
    const debounce = MODULE_SRC.match(/debounceMs\s*=\s*opts\.debounceMs\s*\|\|\s*(\d+)/);
    assert.ok(debounce, 'attach must read opts.debounceMs with a numeric default');
    assert.ok(Number(debounce[1]) >= 300,
        `default debounce must be ≥300ms per ADDRESS_AUTOCOMPLETE_HANDOFF.md (got ${debounce[1]})`);
    const minChars = MODULE_SRC.match(/minChars\s*=\s*opts\.minChars\s*\|\|\s*(\d+)/);
    assert.ok(minChars && Number(minChars[1]) >= 2, 'default minChars must be ≥2');
});

test('module has a stale-response guard and a session query cache', () => {
    assert.match(MODULE_SRC, /const\s+mySeq\s*=\s*\+\+AddressAutocomplete\._seq/,
        'each lookup must take a monotonic token');
    assert.match(MODULE_SRC, /mySeq\s*!==\s*AddressAutocomplete\._seq\)\s*return/,
        'a lookup that resolves after a newer one started must not render');
    assert.match(MODULE_SRC, /_cache\.has\(q\)/, 'lookup must consult the session cache before fetching');
    assert.match(MODULE_SRC, /_cache\.set\(q,/, 'results (including empty ones) must be cached');
});

test('module circuit-breaks NZ Post after a 5xx and pauses on RATE_LIMITED', () => {
    assert.match(MODULE_SRC, /_nzpostDisabled\s*=\s*true/,
        'a 5xx from NZ Post ("not configured") must disable it for the session');
    assert.match(MODULE_SRC, /if\s*\(!AddressAutocomplete\._nzpostDisabled\)/,
        'the NZ Post attempt must be gated on the breaker');
    assert.match(MODULE_SRC, /code\s*!==\s*['"]RATE_LIMITED['"]\)\s*return false/,
        'rate-limit handler must key off code === RATE_LIMITED');
    assert.match(MODULE_SRC, /errOrEnv\.retryAfter\s*\|\|\s*errOrEnv\.retry_after\s*\|\|\s*30/,
        'backoff must honour retryAfter (thrown error) and retry_after (envelope), defaulting to 30s');
    assert.match(MODULE_SRC, /Date\.now\(\)\s*<\s*AddressAutocomplete\._pausedUntil/,
        'lookups must skip the network entirely while paused');
});

test('LOUD fail-soft: degraded suggestions show a visible hint, and pages.css styles it', () => {
    assert.match(MODULE_SRC, /address-autocomplete__hint/, 'module must create the hint element');
    assert.match(MODULE_SRC, /aria-live/, 'hint must be aria-live for screen readers');
    assert.match(MODULE_SRC, /type your address manually/,
        'paused/unavailable states must tell the user manual entry still works');
    assert.match(MODULE_SRC, /complete the fields manually/,
        'a failed details fetch after picking a suggestion must be shown, not swallowed');
    assert.match(PAGES_CSS, /\.address-autocomplete__hint\s*\{/, 'pages.css must ship the __hint rule');
});

test('Enter-key regression pin: keyboard selection uses the same path as mousedown', () => {
    // The old checkout copy called a NONEXISTENT fillFromDetails(suggestion.place_id)
    // on Enter — every keyboard selection threw a ReferenceError.
    assert.ok(!MODULE_SRC.includes('fillFromDetails('),
        'fillFromDetails does not exist and must never be referenced');
    assert.ok(!MODULE_SRC.includes('suggestion.place_id'),
        'suggestions are mapped to {id, label, provider} — .place_id is undefined on them');
    assert.match(MODULE_SRC, /if\s*\(suggestion\)\s*selectSuggestion\(suggestion\)/,
        'Enter must route through the same selectSuggestion path as mousedown');
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — region normalization (behavioural, vm sandbox)
//
// Checkout's region <select> uses slugs ("manawatu-wanganui" — no "h") while
// the account modal uses display names ("Manawatū-Whanganui", "Hawke's Bay").
// The module must land on a real option VALUE in both vocabularies or the
// account form's required-region validation blocks the save.
// ─────────────────────────────────────────────────────────────────────────────

function loadModule() {
    const sandbox = {
        console,
        Map, Set, Promise, Date, JSON, Error, Object, Array,
        String, Number, Boolean, RegExp,
        setTimeout, clearTimeout, clearInterval, setInterval,
        Event: class Event { constructor(type, opts) { this.type = type; Object.assign(this, opts); } },
        document: { getElementById: () => null, createElement: () => ({ setAttribute() {}, classList: { add() {} } }), addEventListener() {} },
        DebugLog: { log() {}, warn() {}, error() {} },
        API: {},
        window: {},
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(MODULE_SRC, ctx, { filename: 'address-autocomplete.js' });
    return sandbox.AddressAutocomplete;
}

function fakeSelect(values) {
    return {
        tagName: 'SELECT',
        options: values.map(v => ({ value: v })),
        value: '',
        dispatchEvent() {},
    };
}

test('slugifier folds diacritics, apostrophes and the wanganui alias', () => {
    const AC = loadModule();
    assert.equal(AC._slugifyRegion('Manawatū-Whanganui'), 'manawatu-wanganui');
    assert.equal(AC._slugifyRegion('Manawatu-Whanganui'), 'manawatu-wanganui');
    assert.equal(AC._slugifyRegion('manawatu-wanganui'), 'manawatu-wanganui');
    assert.equal(AC._slugifyRegion("Hawke's Bay"), 'hawkes-bay');
    assert.equal(AC._slugifyRegion('Hawke’s Bay'), 'hawkes-bay');
    assert.equal(AC._slugifyRegion('Bay of Plenty'), 'bay-of-plenty');
    assert.equal(AC._slugifyRegion(''), '');
    assert.equal(AC._slugifyRegion(null), '');
});

test('region applier lands on checkout-style slug option values', () => {
    const AC = loadModule();
    const select = fakeSelect(['', 'auckland', 'manawatu-wanganui', 'hawkes-bay']);
    AC._applyRegion(select, 'Manawatū-Whanganui');   // Google's spelling
    assert.equal(select.value, 'manawatu-wanganui');
    AC._applyRegion(select, "Hawke's Bay");
    assert.equal(select.value, 'hawkes-bay');
});

test('region applier lands on account-modal display-name option values', () => {
    const AC = loadModule();
    const select = fakeSelect(['', 'Auckland', 'Manawatū-Whanganui', "Hawke's Bay"]);
    AC._applyRegion(select, 'Manawatu-Wanganui');    // provider slug spelling
    assert.equal(select.value, 'Manawatū-Whanganui');
    AC._applyRegion(select, 'Hawkes Bay');
    assert.equal(select.value, "Hawke's Bay");
    // No match → select untouched, never a bogus value (silent-0-rows hazard)
    AC._applyRegion(select, 'Tasmania');
    assert.equal(select.value, "Hawke's Bay");
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 — checkout delegates to the shared module
// ─────────────────────────────────────────────────────────────────────────────

test('checkout-page.js no longer carries its own autocomplete engine', () => {
    assert.ok(!CHECKOUT_SRC.includes('_setupAutocompleteFor'),
        'the per-page engine was extracted to js/address-autocomplete.js — it must not come back');
    assert.ok(!CHECKOUT_SRC.includes('_normalizeRegion'),
        'region normalization lives in the shared module now');
    assert.ok(!CHECKOUT_SRC.includes('fillFromDetails('),
        'the Enter-key ReferenceError must not come back');
});

test('checkout wires both address inputs through AddressAutocomplete.attach with the shipping-cost hook', () => {
    assert.match(CHECKOUT_SRC, /typeof AddressAutocomplete\s*===\s*['"]undefined['"]/,
        'checkout must degrade gracefully if the module script failed to load');
    assert.match(CHECKOUT_SRC, /AddressAutocomplete\.attach\(\s*['"]address1['"]/,
        'shipping address1 must be attached');
    assert.match(CHECKOUT_SRC, /AddressAutocomplete\.attach\(\s*['"]billing-address1['"]/,
        'billing address1 must be attached');
    assert.match(CHECKOUT_SRC, /onApply\s*=\s*\(\)\s*=>\s*this\.updateShippingCost/,
        'autocomplete fill must still refresh the shipping cost via onApply');
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 — account.js: autocomplete attach + envelope-aware mutations
// ─────────────────────────────────────────────────────────────────────────────

test('account modal attaches autocomplete to all five address fields', () => {
    assert.match(ACCOUNT_SRC, /AddressAutocomplete\.attach\(\s*['"]address-line1['"]/,
        'street address input must be enhanced');
    for (const id of ['address-line1', 'address-line2', 'address-city', 'address-region', 'address-postcode']) {
        assert.ok(ACCOUNT_SRC.includes(`'${id}'`), `fieldMap must reference #${id}`);
    }
    assert.match(ACCOUNT_SRC, /typeof AddressAutocomplete\s*!==\s*['"]undefined['"]/,
        'attach must be guarded so the page still works if the module script fails to load');
});

test('account.js defines _assertOk and routes ALL mutations through it', () => {
    // api.js RETURNS {ok:false} envelopes for most error codes; awaiting a
    // mutation without checking read failures as success (ERR-096).
    assert.match(ACCOUNT_SRC, /_assertOk\(res\)\s*\{[\s\S]{0,200}res\.ok\s*===\s*false/,
        '_assertOk must detect resolved error envelopes');
    assert.match(ACCOUNT_SRC, /API\.mapError\(res\)/,
        '_assertOk must map the envelope through the canonical error mapper');
    for (const call of [
        /_assertOk\([\s\S]{0,160}API\.updateAddress\(/,
        /_assertOk\([\s\S]{0,160}API\.addAddress\(/,
        /_assertOk\(await API\.deleteAddress\(/,
        /_assertOk\(await API\.updateUserPrinter\(/,
        /_assertOk\(await API\.addUserPrinter\(/,
        /_assertOk\(await API\.deleteUserPrinter\(/,
    ]) {
        assert.match(ACCOUNT_SRC, call, `mutation must be envelope-checked: ${call}`);
    }
});

test('saveAddress captures wasEditing before closeAddressModal nulls editingAddressId', () => {
    // closeAddressModal() sets editingAddressId = null, so reading it in the
    // toast ternary always said "Address added" — even for edits.
    assert.match(ACCOUNT_SRC, /const wasEditing\s*=\s*!!this\.editingAddressId/,
        'mode must be captured up front');
    assert.match(ACCOUNT_SRC, /showToast\(wasEditing\s*\?\s*['"]Address updated['"]/,
        'toast must derive from the captured mode');
    assert.ok(!/showToast\(this\.editingAddressId\s*\?\s*['"]Address updated['"]/.test(ACCOUNT_SRC),
        'the post-close read of editingAddressId must not come back');
    // Same bug pattern existed in savePrinter.
    assert.match(ACCOUNT_SRC, /showToast\(wasEditing\s*\?\s*['"]Printer updated['"]/,
        'printer toast must derive from a captured mode too');
});

test('saveAddress handles RATE_LIMITED with a countdown instead of a dead-end message', () => {
    assert.match(ACCOUNT_SRC, /error\.code\s*===\s*['"]RATE_LIMITED['"]/,
        'the thrown 429 (which api.js never auto-retries for mutations) must be recognised');
    assert.match(ACCOUNT_SRC, /_startAddressSaveCooldown/,
        'RATE_LIMITED must start the cooldown flow');
    assert.match(ACCOUNT_SRC, /try again in \$\{remaining\}s/,
        'the countdown must tell the user when retrying will actually work');
    assert.match(ACCOUNT_SRC, /closeAddressModal\(\)\s*\{[\s\S]{0,400}_clearAddressCooldown\(\)/,
        'closing the modal must stop the countdown timer');
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 — api.js source contract: noRetry + enriched 429
// ─────────────────────────────────────────────────────────────────────────────

test('all four address suggestion methods opt out of retries', () => {
    for (const endpoint of [
        '/api/address/nzpost/suggest',
        '/api/address/nzpost/details',
        '/api/address/autocomplete',
        '/api/address/details',
    ]) {
        const idx = API_SRC.indexOf(endpoint);
        assert.ok(idx > 0, `${endpoint} method must exist`);
        const window = API_SRC.slice(idx, idx + 200);
        assert.ok(window.includes('noRetry: true'),
            `${endpoint} must pass { noRetry: true } — a replayed suggestion is stale and burns the shared per-IP budget`);
    }
});

test('_fetchWithAuth honours noRetry on all three retry ladders', () => {
    assert.match(API_SRC, /noRetry\s*=\s*!!opts\.noRetry/,
        '_fetchWithAuth must read opts.noRetry');
    assert.match(API_SRC,
        /rateLimitRetry\s*<\s*this\.MAX_RATE_LIMIT_RETRIES\s*&&\s*!noRetry/,
        '429 GET retry must be gated');
    const transientGates = API_SRC.match(/transientRetry\s*<\s*this\.MAX_TRANSIENT_RETRIES\s*\n?\s*&&\s*!noRetry/g) || [];
    assert.equal(transientGates.length, 2,
        'both transient ladders (5xx response + network/timeout catch) must be gated');
});

test('the thrown 429 error carries code and Retry-After for targeted UI', () => {
    assert.match(API_SRC, /rateErr\.code\s*=\s*['"]RATE_LIMITED['"]/,
        'callers must be able to branch on error.code');
    assert.match(API_SRC, /Number\.isFinite\(retryAfterSec\)/,
        'Retry-After parsing must tolerate a missing header (parseInt(null) → NaN)');
});

// ─────────────────────────────────────────────────────────────────────────────
// §6 — Behavioural: vm-sandboxed api.js proves the retry semantics
// (loader mirrors tests/shop-transient-failure-recovery-may2026.test.js)
// ─────────────────────────────────────────────────────────────────────────────

function loadApi({ fetchImpl } = {}) {
    const calls = [];
    const fetchSpy = async (url, opts) => {
        calls.push({ url, opts });
        return fetchImpl(url, opts, calls);
    };
    const sandbox = {
        console,
        fetch: fetchSpy,
        setTimeout,
        clearTimeout,
        AbortController,
        Headers: globalThis.Headers,
        URL,
        URLSearchParams,
        encodeURIComponent,
        Map, Set, Promise, Date, JSON, Error, Object, Array,
        String, Number, Boolean, Symbol, RegExp, TypeError,
        structuredClone: globalThis.structuredClone,
        Config: {
            API_URL: 'https://backend.test',
            SUPABASE_URL: 'https://supabase.test',
            SUPABASE_ANON_KEY: 'anon-key',
        },
        DebugLog: { log() {}, warn() {}, error() {} },
        localStorage: {
            _data: {},
            getItem(k) { return Object.prototype.hasOwnProperty.call(this._data, k) ? this._data[k] : null; },
            setItem(k, v) { this._data[k] = String(v); },
            removeItem(k) { delete this._data[k]; },
        },
        document: { cookie: '' },
        window: {},
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(API_SRC, ctx, { filename: 'api.js' });
    return { API: sandbox.API, calls };
}

function mockResponse({ status = 200, body = {}, headers = {} } = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k) => headers[k] ?? null },
        async json() { return body; },
        async text() { return JSON.stringify(body); },
    };
}

const RATE_BODY = { ok: false, error: { code: 'RATE_LIMITED', message: 'Too many requests. Please slow down.' } };

test('noRetry suggestion GET on 429: exactly ONE fetch, rejects with code RATE_LIMITED', async () => {
    const { API, calls } = loadApi({
        fetchImpl: () => mockResponse({ status: 429, body: RATE_BODY }),
    });
    await assert.rejects(
        () => API.nzpostSuggest('12 queen'),
        (err) => err.code === 'RATE_LIMITED',
        'thrown error must carry the machine-readable code'
    );
    assert.equal(calls.length, 1,
        'noRetry must suppress the GET 429 retry ladder — replays burned the shared per-IP budget (ERR-096)');
});

test('noRetry suggestion GET on 500: exactly ONE fetch (transient ladder suppressed too)', async () => {
    const { API, calls } = loadApi({
        fetchImpl: () => mockResponse({ status: 500, body: { ok: false, error: { code: 'INTERNAL_ERROR', message: 'NZ Post address service not configured' } } }),
    });
    const resp = await API.addressAutocomplete('12 queen');
    assert.equal(resp.ok, false, '5xx resolves to a structured envelope');
    assert.equal(calls.length, 1,
        'this exact server state (provider down) previously cost 3 requests per attempt');
});

test('429 thrown error parses Retry-After into err.retryAfter', async () => {
    const { API } = loadApi({
        fetchImpl: () => mockResponse({ status: 429, body: RATE_BODY, headers: { 'Retry-After': '30' } }),
    });
    await assert.rejects(
        () => API.addressDetails('ChIJx'),
        (err) => err.code === 'RATE_LIMITED' && err.retryAfter === 30,
        'Retry-After must surface so the UI can count down'
    );
});

test('plain GET on 429 still retries (noRetry is opt-in, not a default change)', async () => {
    let attempt = 0;
    const { API, calls } = loadApi({
        fetchImpl: () => {
            attempt++;
            // Retry-After: '0' keeps the backoff instant so the test is fast.
            if (attempt <= 2) return mockResponse({ status: 429, body: RATE_BODY, headers: { 'Retry-After': '0' } });
            return mockResponse({ status: 200, body: { ok: true, data: { products: [] } } });
        },
    });
    const resp = await API.getProducts({ brand: 'canon' });
    assert.equal(resp.ok, true);
    assert.equal(calls.length, 3, 'catalog GETs keep the 2-retry rate-limit ladder');
});

test('POST /api/user/address on 429: ONE fetch, error carries code + retryAfter', async () => {
    const { API, calls } = loadApi({
        fetchImpl: () => mockResponse({ status: 429, body: RATE_BODY, headers: { 'Retry-After': '17' } }),
    });
    await assert.rejects(
        () => API.addAddress({ address_line1: '37A Archibald Rd' }),
        (err) => err.code === 'RATE_LIMITED' && err.retryAfter === 17 && /Too many requests/.test(err.message),
        'the account save path depends on this shape for its countdown UI'
    );
    assert.equal(calls.length, 1, 'mutations must NEVER auto-retry');
});

// ─────────────────────────────────────────────────────────────────────────────
// §7 — HTML wiring: module loaded on both pages, in the right order
// (defer executes in DOCUMENT ORDER — api.js < module < page controller)
// ─────────────────────────────────────────────────────────────────────────────

test('both pages load address-autocomplete.js with a cache token (value never pinned — ERR-067)', () => {
    for (const [name, src] of [['addresses.html', ADDRESSES_HTML], ['checkout.html', CHECKOUT_HTML]]) {
        assert.match(src, /\/js\/address-autocomplete\.js\?v=[a-z0-9]+/,
            `${name} must reference the module with a ?v= token`);
    }
});

test('script order: api.js < address-autocomplete.js < page controller', () => {
    for (const [name, src, controller] of [
        ['addresses.html', ADDRESSES_HTML, '/js/account.js'],
        ['checkout.html', CHECKOUT_HTML, '/js/checkout-page.js'],
    ]) {
        const api = src.indexOf('/js/api.js');
        const mod = src.indexOf('/js/address-autocomplete.js');
        const ctrl = src.indexOf(controller);
        assert.ok(api > 0 && mod > 0 && ctrl > 0, `${name} must load all three scripts`);
        assert.ok(api < mod, `${name}: module needs API — api.js must come first`);
        assert.ok(mod < ctrl, `${name}: ${controller} attaches the module — it must come after`);
    }
});
