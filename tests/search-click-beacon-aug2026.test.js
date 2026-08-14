/**
 * SEARCH CLICK BEACON — POST /api/search/click (Aug 2026)
 * =======================================================
 * Pins inkcartridges/js/search-click-beacon.js and its three wiring points in
 * shop-page.js, per search-click-tracking-fe-handoff-aug2026.
 *
 * WHY EACH SECTION EXISTS — every assertion here corresponds to a way this
 * feature can break WITHOUT ANY VISIBLE SYMPTOM. The beacon is fire-and-forget
 * telemetry: there is no UI, no error state, and no user complaint when it
 * regresses. Only these tests and `npm run audit:searchclick` can tell.
 *
 *   §1 Transport. Measured live 2026-08-12: sending the body as `text/plain`
 *      makes the endpoint answer `400 VALIDATION_FAILED "q" is required`
 *      (the body is never parsed) while `sendBeacon()` STILL RETURNS `true`.
 *      So the single most important line in the module is the Blob's
 *      `type: 'application/json'`, and a reviewer cannot see its absence.
 *   §2 Provenance. Only cards from /api/search/smart may beacon. /search is a
 *      Vercel rewrite to the shop HTML, so ONE controller serves both search
 *      and /shop browsing; and on softMiss the results page swaps in a literal
 *      union while PRESERVING /smart's compat rows, making the page a MIX.
 *   §3 What counts as a click: navigation only. Add to Cart / Contact us /
 *      favourite are not click-throughs.
 *   §4 Payload validity — never send a guaranteed 400, never repair `q`.
 *   §5 position/page arithmetic.
 *   §6 Dedupe an accidental double-click.
 *   §7 Wiring — arm/disarm sites, and the typeahead dropdown staying CLEAN.
 *   §8 FYI-2 regression: `match_reason: "semantic"` must never render a
 *      compatibility claim. Live 2026-08-12, a vague query returns 20 rows all
 *      carrying `matched_token: "<the customer's whole sentence>"`, so a truthy
 *      check on match_reason would print "Compatible with cheap black ink for
 *      my brother printer" — false compat claim (ERR-135) and absurd copy.
 *
 * Run: node --test tests/search-click-beacon-aug2026.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const JS = (f) => fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', f), 'utf8');
const HTML = (f) => fs.readFileSync(path.join(ROOT, 'inkcartridges', 'html', f), 'utf8');

const BEACON_SRC = JS('search-click-beacon.js');
const SHOP_SRC = JS('shop-page.js');
const UTILS_SRC = JS('utils.js');
const PRODUCTS_SRC = JS('products.js');
const SEARCH_SRC = JS('search.js');

// Strip comments so a literal inside a comment can't satisfy a source
// assertion. NOTE: never put a slash-star sequence inside a fixture string in
// this file — it opens a fake block comment and silently voids everything
// below it (ERR-154 cost 2.7kB of real code to exactly that).
function stripComments(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/[^\n]*/g, '');
}
const BEACON_CODE = stripComments(BEACON_SRC);
const SHOP_CODE = stripComments(SHOP_SRC);
const PRODUCTS_CODE = stripComments(PRODUCTS_SRC);
const SEARCH_CODE = stripComments(SEARCH_SRC);

// Balanced `{ … }` body of the first block at/after `anchor` (ERR-124's lesson:
// a fixed-width slice window goes vacuous the moment the code inside grows).
function blockBodyAt(src, anchor) {
    const at = src.indexOf(anchor);
    if (at === -1) return null;
    const open = src.indexOf('{', at + anchor.length);
    if (open === -1) return null;
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(open + 1, i);
    }
    return null;
}

// ───────────────────────────────────────────────────────────────────────────
// Fake DOM. Deliberately minimal and hand-rolled: the module only ever calls
// getElementById / querySelectorAll / contains / closest / getAttribute /
// addEventListener, and a real DOM would hide which of those it depends on.
// ───────────────────────────────────────────────────────────────────────────

const CARD_CLASS = 'product-card';
const LINK_CLASS = 'product-card__link';

function makeCard(sku) {
    const card = { _tag: 'article', _classes: [CARD_CLASS], _sku: sku, _parent: null };
    card.getAttribute = (name) => (name === 'data-sku' ? card._sku : null);
    const link = { _tag: 'a', _classes: [LINK_CLASS], _parent: card };
    // A descendant of the link — the real card nests h3/img/span inside it, so
    // e.target is usually NOT the anchor itself.
    const title = { _tag: 'h3', _classes: ['product-card__title'], _parent: link };
    // Buttons that must never beacon. The cart button really lives INSIDE the
    // anchor in the shipped markup (shop-page.js keeps it a <button> because a
    // nested <a> would close the outer link); the favourite button is a sibling.
    const cartBtn = { _tag: 'button', _classes: ['product-card__cart-btn'], _parent: link };
    // The out-of-stock variant occupies the same slot, also inside the anchor.
    const contactBtn = { _tag: 'button', _classes: ['product-card__cart-btn', 'product-card__contact-btn'], _parent: link };
    const favBtn = { _tag: 'button', _classes: ['favourite-btn'], _parent: card };

    // Supports a class selector (".x") or a bare tag selector ("button").
    const climb = (node, selector) => {
        const byClass = selector.charAt(0) === '.';
        const want = byClass ? selector.slice(1) : selector;
        let cur = node;
        while (cur) {
            const hit = byClass
                ? (cur._classes && cur._classes.indexOf(want) !== -1)
                : cur._tag === want;
            if (hit) return cur;
            cur = cur._parent;
        }
        return null;
    };
    for (const node of [card, link, title, cartBtn, contactBtn, favBtn]) {
        node.closest = (selector) => climb(node, selector);
    }
    card._link = link;
    card._title = title;
    card._cartBtn = cartBtn;
    card._contactBtn = contactBtn;
    card._favBtn = favBtn;
    return card;
}

function makeGrid(id, cards) {
    const contains = (el) => {
        let cur = el;
        while (cur) {
            if (cards.indexOf(cur) !== -1) return true;
            cur = cur._parent;
        }
        return false;
    };
    return {
        id,
        listeners: {},
        querySelectorAll: (sel) => (sel === '.' + CARD_CLASS ? cards.slice() : []),
        contains,
        addEventListener(type, fn) {
            this.listeners[type] = this.listeners[type] || [];
            this.listeners[type].push(fn);
        },
    };
}

/**
 * Boot the beacon in a sandbox.
 * @param {object} o
 * @param {Array<string>} o.compatible - SKUs for #compatible-products
 * @param {Array<string>} o.genuine    - SKUs for #genuine-products
 * @param {boolean|string} o.beacon    - true, false (queue full), 'missing', 'throw'
 */
function boot(o) {
    const opts = o || {};
    const compatCards = (opts.compatible || []).map(makeCard);
    const genuineCards = (opts.genuine || []).map(makeCard);
    const grids = {
        'compatible-products': makeGrid('compatible-products', compatCards),
        'genuine-products': makeGrid('genuine-products', genuineCards),
    };

    const sent = [];       // sendBeacon calls: { url, body, type }
    const fetched = [];    // fetch fallback calls: { url, init }
    const warnings = [];

    function FakeBlob(parts, options) {
        this.parts = parts;
        this.type = (options && options.type) || '';
    }

    const navigatorStub = { userAgent: 'node' };
    if (opts.beacon !== 'missing') {
        navigatorStub.sendBeacon = (url, blob) => {
            if (opts.beacon === 'throw') throw new Error('sendBeacon exploded');
            sent.push({ url, body: String(blob.parts[0]), type: blob.type });
            return opts.beacon !== false;
        };
    }

    // ⚠️ `window` is a DISTINCT object from the sandbox global, on purpose.
    // A browser page is NOT `window === globalThis` for script-scoped `const`s:
    // js/config.js declares `const Config`, which lands in the global LEXICAL
    // environment, so `Config` resolves as a bare identifier while
    // `window.Config` is `undefined`. An earlier version of this harness set
    // `sandbox.window = sandbox`, which made `window.Config` work here and
    // ONLY here — the beacon read `window.Config`, passed every test, and sent
    // nothing at all in a real browser (ERR-156). So: things config.js/utils.js
    // expose as bare globals go on the sandbox; things they explicitly assign
    // with `window.X = X` (DebugLog, CompatSource) go on `windowObj`.
    const windowObj = {
        DebugLog: { log() {}, warn(...a) { warnings.push(a.join(' ')); }, error() {} },
    };
    const sandbox = {
        console,
        URL, URLSearchParams, Map, Set, Promise, JSON, Date, RegExp,
        Object, Array, String, Number, Boolean, Error, Math,
        parseInt, parseFloat, isNaN, setTimeout, clearTimeout,
        Blob: FakeBlob,
        document: {
            getElementById: (id) => grids[id] || null,
            addEventListener() {},
        },
        location: { search: '', pathname: '/search', href: 'http://localhost/search' },
        navigator: navigatorStub,
        fetch: (url, init) => { fetched.push({ url, init }); return Promise.resolve({ status: 204 }); },
        // Bare global ONLY — mirrors js/config.js. Not on windowObj.
        Config: opts.config === undefined ? { API_URL: 'https://backend.test' } : opts.config,
        window: windowObj,
    };
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(BEACON_SRC, ctx, { filename: 'search-click-beacon.js' });

    const B = windowObj.SearchClickBeacon;
    assert.ok(B, 'search-click-beacon.js must expose window.SearchClickBeacon');
    return { B, sent, fetched, warnings, grids, compatCards, genuineCards, sandbox, windowObj };
}

// Arm over every card in both grids (the common case: all rows came from /smart).
function armAll(h, page) {
    const skus = h.compatCards.concat(h.genuineCards).map((c) => c._sku);
    h.B.arm({ query: 'brother lc233', page: page || 1, skus });
}

const lastBody = (h) => JSON.parse(h.sent[h.sent.length - 1].body);

// ───────────────────────────────────────────────────────────────────────────
// §1 Transport
// ───────────────────────────────────────────────────────────────────────────

test('§1 the beacon Blob is application/json — a bare string arrives as text/plain and the server drops the body while sendBeacon still returns true', () => {
    const h = boot({ genuine: ['GLC233BK'] });
    armAll(h);
    assert.equal(h.B._handleActivation(h.genuineCards[0]._title), true);
    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].type, 'application/json',
        'measured live: text/plain makes the endpoint 400 with "q is required" and there is NO client-side signal');
});

test('§1 source pins the Blob content type (the one line whose absence is invisible)', () => {
    assert.match(BEACON_CODE, /new Blob\(\s*\[\s*body\s*\]\s*,\s*\{\s*type:\s*['"]application\/json['"]\s*\}\s*\)/,
        'the typed Blob must survive refactors');
});

test('§1 payload carries q, sku, position and page', () => {
    const h = boot({ genuine: ['GLC233BK', 'GLC233C'] });
    h.B.arm({ query: 'brother lc233', page: 3, skus: ['GLC233BK', 'GLC233C'] });
    h.B._handleActivation(h.genuineCards[1]._title);
    assert.deepEqual(lastBody(h), { q: 'brother lc233', sku: 'GLC233C', position: 2, page: 3 });
});

test('§1 the request goes to Config.API_URL + /api/search/click', () => {
    const h = boot({ genuine: ['GLC233BK'] });
    armAll(h);
    h.B._handleActivation(h.genuineCards[0]._title);
    assert.equal(h.sent[0].url, 'https://backend.test/api/search/click');
});

test('§1 sendBeacon returning false (queue full) falls back to a keepalive fetch', () => {
    const h = boot({ genuine: ['GLC233BK'], beacon: false });
    armAll(h);
    h.B._handleActivation(h.genuineCards[0]._title);
    assert.equal(h.fetched.length, 1, 'false means NOTHING was queued — the click would be lost');
    assert.equal(h.fetched[0].init.method, 'POST');
    assert.equal(h.fetched[0].init.keepalive, true, 'without keepalive the navigation kills the request');
    assert.equal(h.fetched[0].init.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(h.fetched[0].init.body), { q: 'brother lc233', sku: 'GLC233BK', position: 1, page: 1 });
});

test('§1 a browser with no sendBeacon uses the fetch path', () => {
    const h = boot({ genuine: ['GLC233BK'], beacon: 'missing' });
    armAll(h);
    h.B._handleActivation(h.genuineCards[0]._title);
    assert.equal(h.sent.length, 0);
    assert.equal(h.fetched.length, 1);
});

test('§1 a THROWING sendBeacon still falls through to fetch, and never escapes the click', () => {
    const h = boot({ genuine: ['GLC233BK'], beacon: 'throw' });
    armAll(h);
    assert.doesNotThrow(() => h.B._handleActivation(h.genuineCards[0]._title),
        'a throw here would run inside the click that is navigating away');
    assert.equal(h.fetched.length, 1, 'the click must not be lost just because sendBeacon threw');
});

test('§1 the API base is read from the BARE Config global — window.Config does not exist (ERR-156)', () => {
    // This is the bug that shipped past the first version of this suite. In a
    // real page `Config` is a script-scoped `const` from js/config.js, so it is
    // reachable only as a bare identifier; `window.Config` is undefined
    // (verified in the browser 2026-08-12). Reading the wrong one meant apiBase()
    // returned '' and the beacon sent NOTHING — armed, wired, silent.
    const h = boot({ genuine: ['GLC233BK'] });
    assert.equal(h.windowObj.Config, undefined,
        'the harness must NOT put Config on window, or it cannot catch this');
    armAll(h);
    assert.equal(h.B._handleActivation(h.genuineCards[0]._title), true);
    assert.equal(h.sent.length, 1, 'the beacon must resolve Config as a bare global, like traffic-tracker.js does');
    assert.equal(h.sent[0].url, 'https://backend.test/api/search/click');
});

test('§1 source reads Config as a bare identifier behind a typeof guard', () => {
    assert.match(BEACON_CODE, /typeof Config !== ['"]undefined['"]/,
        'a bare name that was never declared throws — the typeof guard is required');
});

test('§1 no Config at all — degrades to a no-op, never a relative POST to the storefront', () => {
    // A relative POST would hit the Vercel storefront, not the API: 405 noise at
    // best, and on a rewrite-matched path something stranger.
    const h = boot({ genuine: ['GLC233BK'], config: null });
    armAll(h);
    assert.doesNotThrow(() => h.B._handleActivation(h.genuineCards[0]._title));
    assert.equal(h.sent.length, 0);
    assert.equal(h.fetched.length, 0);
    assert.ok(h.warnings.some((w) => /API_URL/.test(w)), 'a missing API base must be loud in dev');
});

// ───────────────────────────────────────────────────────────────────────────
// §2 Provenance — /smart rows only
// ───────────────────────────────────────────────────────────────────────────

test('§2 a card whose SKU is not in the /smart allow-list never beacons', () => {
    // The softMiss shape: the literal union from /api/products?search= paints
    // rows /smart never returned. Those are not search results.
    const h = boot({ genuine: ['FROM-SMART', 'FROM-LITERAL-UNION'] });
    h.B.arm({ query: 'q', page: 1, skus: ['FROM-SMART'] });
    assert.equal(h.B._handleActivation(h.genuineCards[1]._title), false);
    assert.equal(h.sent.length, 0);
    assert.equal(h.B._handleActivation(h.genuineCards[0]._title), true);
    assert.equal(h.sent.length, 1);
});

test('§2 disarmed — /shop browsing and every other drilldown level cannot beacon', () => {
    const h = boot({ genuine: ['GLC233BK'] });
    armAll(h);
    h.B.disarm();
    assert.equal(h.B._isArmed(), false);
    assert.equal(h.B._handleActivation(h.genuineCards[0]._title), false);
    assert.equal(h.sent.length, 0);
});

test('§2 arming with an empty SKU set leaves the beacon disarmed rather than open', () => {
    const h = boot({ genuine: ['GLC233BK'] });
    h.B.arm({ query: 'q', page: 1, skus: [] });
    assert.equal(h.B._isArmed(), false, 'no provenance must mean no beacon, not any beacon');
    assert.equal(h.B._handleActivation(h.genuineCards[0]._title), false);
});

test('§2 a card outside the two search grids never beacons (zero-result recovery rails)', () => {
    const h = boot({ genuine: ['GLC233BK'] });
    armAll(h);
    // Same class, same SKU, but not inside #compatible-products/#genuine-products.
    const orphan = makeCard('GLC233BK');
    assert.equal(h.B._handleActivation(orphan._title), false);
    assert.equal(h.sent.length, 0);
});

test('§2 arm() accepts a Set as well as an Array — shop-page.js passes a Set', () => {
    const h = boot({ genuine: ['GLC233BK'] });
    h.B.arm({ query: 'q', page: 1, skus: new Set(['GLC233BK']) });
    assert.equal(h.B._handleActivation(h.genuineCards[0]._title), true);
});

// ───────────────────────────────────────────────────────────────────────────
// §3 What counts as a click
// ───────────────────────────────────────────────────────────────────────────

test('§3 Add to Cart does not beacon — it is not a click-through', () => {
    const h = boot({ genuine: ['GLC233BK'] });
    armAll(h);
    assert.equal(h.B._handleActivation(h.genuineCards[0]._cartBtn), false,
        'the cart button sits INSIDE the anchor, so this must be excluded structurally');
    assert.equal(h.sent.length, 0);
});

test('§3 the favourite button does not beacon', () => {
    const h = boot({ genuine: ['GLC233BK'] });
    armAll(h);
    assert.equal(h.B._handleActivation(h.genuineCards[0]._favBtn), false);
    assert.equal(h.sent.length, 0);
});

test('§3 the "Contact us" CTA on an out-of-stock card does not beacon', () => {
    const h = boot({ genuine: ['GLC233BK'] });
    armAll(h);
    assert.equal(h.B._handleActivation(h.genuineCards[0]._contactBtn), false);
    assert.equal(h.sent.length, 0);
});

test('§3 the exclusion is structural, not a bet on stopPropagation', () => {
    // The bug this pins: BOTH card CTAs live INSIDE .product-card__link, because
    // shop-page.js keeps them <button> elements (a nested <a> would close the
    // outer anchor). So `closest(LINK_SELECTOR)` alone MATCHES them, and the
    // first cut of this module logged an add-to-cart as a click-through. The
    // browser hid it, because those handlers call stopPropagation() so the event
    // never reaches the delegated container listener — a mask, not a guard.
    const body = blockBodyAt(BEACON_CODE, 'function handleActivation');
    assert.ok(body, 'handleActivation must exist');
    assert.match(body, /closest\(\s*['"]button['"]\s*\)/,
        'controls inside the card must be excluded by element type, independently of the anchor test');
    const buttonAt = body.indexOf("closest('button')");
    const linkAt = body.indexOf('closest(LINK_SELECTOR)');
    assert.ok(buttonAt !== -1 && linkAt !== -1 && buttonAt < linkAt,
        'the button check must run BEFORE the anchor check, since the buttons are inside the anchor');
    assert.match(body, /if\s*\(\s*!link\s*\)\s*return false/,
        'a click that is not on the navigation anchor must bail');
});

test('§3 a click on a descendant of the anchor beacons (e.target is rarely the anchor)', () => {
    const h = boot({ genuine: ['GLC233BK'] });
    armAll(h);
    assert.equal(h.B._handleActivation(h.genuineCards[0]._title), true);
});

test('§3 middle-click (auxclick button 1) beacons; right-click (button 2) does not', () => {
    const h = boot({ genuine: ['GLC233BK'] });
    armAll(h);
    const aux = h.grids['genuine-products'].listeners.auxclick;
    assert.ok(aux && aux.length === 1, 'an auxclick listener must be attached');
    aux[0]({ button: 2, target: h.genuineCards[0]._title });
    assert.equal(h.sent.length, 0, 'the context menu Open-in-new-tab is unobservable, so button 2 must not count');
    aux[0]({ button: 1, target: h.genuineCards[0]._title });
    assert.equal(h.sent.length, 1, 'middle-click opens a new tab and emits NO click event');
});

test('§3 both grids get click and auxclick listeners, attached exactly once', () => {
    const h = boot({ compatible: ['C1'], genuine: ['G1'] });
    armAll(h);
    h.B.attach();
    h.B.attach();
    for (const id of ['compatible-products', 'genuine-products']) {
        assert.equal(h.grids[id].listeners.click.length, 1, id + ' click listener must be attached once');
        assert.equal(h.grids[id].listeners.auxclick.length, 1, id + ' auxclick listener must be attached once');
    }
});

test('§3 the delegated click listener fires the beacon end-to-end', () => {
    const h = boot({ genuine: ['GLC233BK'] });
    armAll(h);
    h.grids['genuine-products'].listeners.click[0]({ target: h.genuineCards[0]._title });
    assert.equal(h.sent.length, 1);
});

test('§3 no pointerdown/mousedown listener — those over-count drags that never navigate', () => {
    assert.doesNotMatch(BEACON_CODE, /addEventListener\(\s*['"](?:pointerdown|mousedown|mouseup)['"]/);
});

// ───────────────────────────────────────────────────────────────────────────
// §4 Payload validity — never send a guaranteed 400
// ───────────────────────────────────────────────────────────────────────────

test('§4 a query over 200 chars is dropped, not truncated', () => {
    // The search input is maxlength=200 but a hand-crafted ?q= is not. Live:
    // 250 chars => 400 "q length must be less than or equal to 200".
    const h = boot({ genuine: ['GLC233BK'] });
    h.B.arm({ query: 'a'.repeat(201), page: 1, skus: ['GLC233BK'] });
    assert.equal(h.B._handleActivation(h.genuineCards[0]._title), false);
    assert.equal(h.sent.length, 0);
    assert.equal(h.fetched.length, 0);
    assert.ok(h.warnings.some((w) => /over 200 chars/.test(w)),
        'a dropped click must be loud in dev — truncating q would misattribute CTR to a different query');
});

test('§4 a query of exactly 200 chars still sends (boundary is inclusive)', () => {
    const h = boot({ genuine: ['GLC233BK'] });
    h.B.arm({ query: 'a'.repeat(200), page: 1, skus: ['GLC233BK'] });
    assert.equal(h.B._handleActivation(h.genuineCards[0]._title), true);
});

test('§4 an empty query never sends', () => {
    const h = boot({ genuine: ['GLC233BK'] });
    h.B.arm({ query: '', page: 1, skus: ['GLC233BK'] });
    assert.equal(h.B._handleActivation(h.genuineCards[0]._title), false);
    assert.equal(h.sent.length, 0);
});

test('§4 a card with no data-sku never sends', () => {
    const h = boot({ genuine: ['GLC233BK'] });
    armAll(h);
    h.genuineCards[0]._sku = null;
    assert.equal(h.B._handleActivation(h.genuineCards[0]._title), false);
    assert.equal(h.sent.length, 0);
});

test('§4 an over-length sku never sends', () => {
    const long = 'S'.repeat(101);
    const h = boot({ genuine: [long] });
    h.B.arm({ query: 'q', page: 1, skus: [long] });
    assert.equal(h.B._handleActivation(h.genuineCards[0]._title), false);
    assert.equal(h.sent.length, 0);
});

test('§4 the backend limits live in named constants, not inline magic numbers', () => {
    assert.match(BEACON_CODE, /MAX_Q_LENGTH\s*=\s*200/);
    assert.match(BEACON_CODE, /MAX_SKU_LENGTH\s*=\s*100/);
});

// ───────────────────────────────────────────────────────────────────────────
// §5 position and page
// ───────────────────────────────────────────────────────────────────────────

test('§5 position is 1-based and spans BOTH grids in painted order (compatible first)', () => {
    const h = boot({ compatible: ['C1', 'C2'], genuine: ['G1', 'G2'] });
    armAll(h);
    const pos = (card) => { h.sent.length = 0; h.B._handleActivation(card._title); return lastBody(h).position; };
    assert.equal(pos(h.compatCards[0]), 1);
    assert.equal(pos(h.compatCards[1]), 2);
    assert.equal(pos(h.genuineCards[0]), 3, '#compatible-section precedes #genuine-section in shop.html');
    assert.equal(pos(h.genuineCards[1]), 4);
});

test('§5 position is read at click time, so a re-sort between render and click stays correct', () => {
    const h = boot({ genuine: ['A', 'B'] });
    armAll(h);
    // Simulate renderProducts repainting the grid in the other order.
    const flipped = [h.genuineCards[1], h.genuineCards[0]];
    h.grids['genuine-products'].querySelectorAll = (sel) => (sel === '.product-card' ? flipped.slice() : []);
    h.B._handleActivation(h.genuineCards[0]._title);
    assert.equal(lastBody(h).position, 2, 'a position captured at render time would have gone stale here');
});

test('§5 position is within the page — it is NOT offset by the page number', () => {
    const h = boot({ genuine: ['G1'] });
    h.B.arm({ query: 'q', page: 4, skus: ['G1'] });
    h.B._handleActivation(h.genuineCards[0]._title);
    const body = lastBody(h);
    assert.equal(body.position, 1, 'page is reported separately, so position must not be (page-1)*100+1');
    assert.equal(body.page, 4);
    assert.doesNotMatch(BEACON_CODE, /SEARCH_PAGE_SIZE|\*\s*100\s*\+/);
});

test('§5 page defaults to 1 when arm() is given a junk page', () => {
    const h = boot({ genuine: ['G1'] });
    h.B.arm({ query: 'q', page: 'not-a-number', skus: ['G1'] });
    h.B._handleActivation(h.genuineCards[0]._title);
    assert.equal(lastBody(h).page, 1);
});

// ───────────────────────────────────────────────────────────────────────────
// §6 Dedupe
// ───────────────────────────────────────────────────────────────────────────

test('§6 an accidental double-click on one card sends once', () => {
    const h = boot({ genuine: ['G1'] });
    armAll(h);
    assert.equal(h.B._handleActivation(h.genuineCards[0]._title), true);
    assert.equal(h.B._handleActivation(h.genuineCards[0]._title), false);
    assert.equal(h.sent.length, 1);
});

test('§6 dedupe is per card — a different card still sends', () => {
    const h = boot({ genuine: ['G1', 'G2'] });
    armAll(h);
    h.B._handleActivation(h.genuineCards[0]._title);
    h.B._handleActivation(h.genuineCards[1]._title);
    assert.equal(h.sent.length, 2);
});

test('§6 a new query re-sends the same sku — coming back and re-choosing is real behaviour', () => {
    const h = boot({ genuine: ['G1'] });
    h.B.arm({ query: 'first', page: 1, skus: ['G1'] });
    h.B._handleActivation(h.genuineCards[0]._title);
    h.B.arm({ query: 'second', page: 1, skus: ['G1'] });
    h.B._handleActivation(h.genuineCards[0]._title);
    assert.equal(h.sent.length, 2);
    assert.equal(JSON.parse(h.sent[0].body).q, 'first');
    assert.equal(JSON.parse(h.sent[1].body).q, 'second');
});

// ───────────────────────────────────────────────────────────────────────────
// §7 Wiring
// ───────────────────────────────────────────────────────────────────────────

test('§7 loadCurrentLevel disarms unconditionally — armed-off is the default for every level', () => {
    const body = blockBodyAt(SHOP_CODE, 'async loadCurrentLevel(');
    assert.ok(body, 'loadCurrentLevel must exist');
    assert.match(body, /window\.SearchClickBeacon/,
        'the beacon must be read off window, never as a bare identifier (the CompatSource TDZ lesson)');
    assert.match(body, /clickBeacon\.disarm\(\)/);
    const switchAt = body.indexOf('switch (this.state.level)');
    const disarmAt = body.indexOf('clickBeacon.disarm()');
    assert.ok(disarmAt !== -1 && switchAt !== -1 && disarmAt < switchAt,
        'disarm must run BEFORE the level dispatch, or a level could inherit the previous arming');
});

test('§7 loadSearchResults arms with the query, the requested page and the /smart SKU set', () => {
    const body = blockBodyAt(SHOP_CODE, 'async loadSearchResults(');
    assert.ok(body, 'loadSearchResults must exist');
    assert.match(body, /clickBeacon\.arm\(\{[\s\S]*?query:\s*searchQuery[\s\S]*?page:\s*requestedPage[\s\S]*?skus:\s*smartSkus[\s\S]*?\}\)/,
        'searchQuery is the string sent to /smart verbatim — not the corrected form');
});

test('§7 the /smart SKU snapshot is taken BEFORE reconciliation can null smartData', () => {
    const body = blockBodyAt(SHOP_CODE, 'async loadSearchResults(');
    const addAt = body.indexOf('smartSkus.add');
    // lastIndexOf, not indexOf: the FIRST `smartData = null` is the declaration
    // at the top of the function. The one that matters is the softMiss swap.
    const nullAt = body.lastIndexOf('smartData = null');
    assert.ok(addAt !== -1, 'the snapshot must exist');
    assert.ok(nullAt !== -1, 'the softMiss swap must still null smartData');
    assert.ok(addAt < nullAt,
        'snapshotting after the swap would lose provenance for the preserved compat rows');
});

test('§7 the typeahead dropdown is NOT instrumented — the handoff forbids it', () => {
    // search.js renders the dropdown via Products.renderCard. Instrumenting the
    // shared renderer would hit the dropdown AND miss the results grid, since
    // the results grid uses DrilldownNav.createProductCard instead.
    assert.doesNotMatch(SEARCH_CODE, /SearchClickBeacon/,
        'js/search.js is the typeahead dropdown — it must never beacon');
    assert.doesNotMatch(PRODUCTS_CODE, /SearchClickBeacon/,
        'js/products.js renderCard also feeds PDP rails, favourites and the recovery rails');
});

test('§7 no other page loads the beacon — only shop.html hosts the results grid', () => {
    const dir = path.join(ROOT, 'inkcartridges', 'html');
    const hosts = fs.readdirSync(dir)
        .filter((f) => f.endsWith('.html'))
        .filter((f) => /search-click-beacon\.js/.test(fs.readFileSync(path.join(dir, f), 'utf8')));
    assert.deepEqual(hosts, ['shop.html']);
    // Never pin the ?v= token itself (ERR-067) — it is restamped by npm run build.
    assert.match(HTML('shop.html'), /<script[^>]+src="\/js\/search-click-beacon\.js\?v=[^"]+"/);
});

test('§7 the beacon never retries and never surfaces an error to the customer', () => {
    assert.doesNotMatch(BEACON_CODE, /setTimeout\([^)]*(?:post|report|retry)/i);
    assert.doesNotMatch(BEACON_CODE, /showError|alert\(|showToast/);
    assert.match(BEACON_CODE, /\.catch\(\(\)\s*=>\s*\{[^}]*\}\)/,
        'the fetch fallback must swallow its rejection');
});

test('§7 the deliberate divergences from traffic-tracker.js are documented in the source', () => {
    // Both are load-bearing decisions someone will otherwise "fix" by copying
    // traffic-tracker's shape across. The reasoning has to live next to them.
    assert.doesNotMatch(BEACON_CODE, /doNotTrack/,
        'no DNT gate: this payload carries no identifiers, and gating it would bias CTR invisibly');
    assert.match(BEACON_SRC, /NO Do Not Track opt-out/,
        'the DNT decision must be explained where the next reader will look');
    assert.doesNotMatch(BEACON_CODE, /getAccessToken|Authorization/,
        'no auth: nothing async may run before dispatch or the navigation kills the beacon');
    assert.doesNotMatch(BEACON_CODE, /gtag/, 'no GA4 mirror — one destination for search CTR');
});

// ───────────────────────────────────────────────────────────────────────────
// §8 FYI-2 regression — match_reason "semantic" must not claim compatibility
// ───────────────────────────────────────────────────────────────────────────

// The live all-semantic response (q="cheap black ink for my brother printer",
// measured 2026-08-12): 20 rows, every one tagged semantic, and matched_token
// is the WHOLE SENTENCE rather than a printer code.
const SEMANTIC_SENTENCE = 'cheap black ink for my brother printer';
const semanticRow = (sku) => ({ sku, match_reason: 'semantic', matched_token: SEMANTIC_SENTENCE });

function loadShopHelpers() {
    const sandbox = {
        console,
        URL, URLSearchParams, Map, Set, Promise, JSON, Date, RegExp,
        Object, Array, String, Number, Boolean, Error, Math, parseInt, parseFloat, isNaN,
        setTimeout, clearTimeout,
        document: {
            addEventListener() {}, getElementById() { return null; },
            querySelector() { return null; }, querySelectorAll() { return []; },
            createElement() { return { style: {}, classList: { add() {}, remove() {} }, setAttribute() {}, appendChild() {} }; },
            body: { appendChild() {} }, documentElement: { style: {} }, cookie: '',
        },
        location: { search: '', pathname: '/search', href: 'http://localhost/search' },
        history: { replaceState() {}, pushState() {} },
        localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
        navigator: { userAgent: 'node' },
        DebugLog: { log() {}, warn() {}, error() {} },
        Config: { API_URL: 'https://backend.test', settings: {}, getSetting(k, f) { return f; } },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(UTILS_SRC, ctx, { filename: 'utils.js' });
    assert.ok(sandbox.window.CompatSource, 'utils.js must expose window.CompatSource');
    vm.runInContext(SHOP_SRC, ctx, { filename: 'shop-page.js' });
    const helpers = sandbox.window._searchParityHelpers;
    assert.ok(helpers, 'shop-page.js must expose window._searchParityHelpers');
    return helpers;
}
const H = loadShopHelpers();

test('§8 a semantic row NEVER earns the compatibility chip — the guard demands the exact enum', () => {
    // A truthy check here would render "Compatible with cheap black ink for my
    // brother printer" on all 20 cards: a compatibility claim the frontend is
    // forbidden to make (ERR-135), from a token that is not a printer at all.
    for (const [label, code] of [['shop-page.js', SHOP_CODE], ['products.js', PRODUCTS_CODE]]) {
        assert.match(code, /match_reason\s*===\s*['"]compatibility['"]\s*&&\s*\w+\.matched_token/,
            label + ' must gate the Fits chip on the exact enum AND a token');
    }
});

test('§8 the raw match_reason enum is never interpolated into markup', () => {
    for (const [label, code] of [['shop-page.js', SHOP_CODE], ['products.js', PRODUCTS_CODE]]) {
        assert.doesNotMatch(code, /\$\{[^}]*\bmatch_reason\b[^}]*\}/,
            label + ' must never print the enum — a new backend value would leak into the UI');
    }
});

test('§8 a semantic matched_token never reaches the "results similar to" banner', () => {
    const s = H.summarizeMatchReasons([semanticRow('A'), semanticRow('B')]);
    assert.equal(s.semantic, 2);
    assert.equal(s.allSemantic, true, 'an all-semantic set gets ONE section notice, not N chips');
    assert.equal(s.fuzzyToken, null,
        'fuzzyToken feeds a rendered banner — a semantic sentence must never populate it');
});

test('§8 a semantic row partitions as DIRECT, never as a compatibility row', () => {
    const { direct, compat } = H.partitionCompatRows([semanticRow('A')]);
    assert.equal(direct.length, 1);
    assert.equal(compat.length, 0);
});

test('§8 a semantic row is never re-labelled into a compatibility claim', () => {
    const rows = H.reattachCompatProvenance(
        [semanticRow('A')],
        [{ sku: 'A', match_reason: 'compatibility', matched_token: 'VP6000' }],
    );
    assert.equal(rows[0].match_reason, 'semantic',
        "the backend's own verdict for a row wins — provenance is re-labelled, never labelled");
    assert.equal(rows[0].matched_token, SEMANTIC_SENTENCE);
});

test('§8 an unknown future match_reason is ignored safely — no throw, no chip, no banner', () => {
    const rows = [{ sku: 'A', match_reason: 'hybrid', matched_token: 'whatever' }, null, undefined];
    let s;
    assert.doesNotThrow(() => { s = H.summarizeMatchReasons(rows); });
    assert.equal(s.semantic, 0);
    assert.equal(s.compatibility, 0);
    assert.equal(s.fuzzyToken, null);
    assert.equal(s.allSemantic, false);
    assert.doesNotThrow(() => H.partitionCompatRows(rows));
});
