/**
 * /cart?add=SKU:QTY — the guest one-click reorder deep link
 * =============================================================================
 * ERR-269.
 *
 * The backend's reorder/refill emails were already emitting `/cart?add=…` for
 * guests. Nothing on this side read the parameter, so the link opened an
 * unchanged cart with `?add=` still in the address bar — roughly 99 guest
 * recipients per send, every send.
 *
 * WHY THESE TESTS EXECUTE INSTEAD OF GREPPING
 * -------------------------------------------
 * Every interesting failure here is a runtime one: a parser that drops the
 * second SKU, a handler that adds before it strips (so a refresh doubles the
 * order), a partial batch reported as a success. None of those are visible in
 * the shape of the source. `js/cart-deep-link.js` is guarded like
 * `js/seo-meta.js` precisely so this file can require() it and run it. (Its
 * sibling `cart-page.js` calls document.addEventListener at top level and
 * cannot be required at all — which is why the feature lives in its own file.)
 *
 * §4 drives the whole handler against stubbed globals, including the two things
 * no source grep can see: that the URL is cleaned BEFORE the first add, and
 * that a half-delivered link says so.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const INK = path.join(ROOT, 'inkcartridges');
const read = (p) => fs.readFileSync(p, 'utf8');

const DeepLink = require(path.join(INK, 'js', 'cart-deep-link.js'));
const DEEP_SRC = read(path.join(INK, 'js', 'cart-deep-link.js'));
const CART_SRC = read(path.join(INK, 'js', 'cart.js'));
const CART_HTML = read(path.join(INK, 'html', 'cart.html'));

const P = (raw) => DeepLink.parseAddParam(raw);
const skus = (raw) => P(raw).entries.map((e) => `${e.sku}:${e.qty}`);

// ─────────────────────────────────────────────────────────────────────────────
// §1 — the parser, executed
// ─────────────────────────────────────────────────────────────────────────────

test('§1 the happy path from the handoff: /cart?add=C73NM:1', () => {
    assert.deepEqual(P('C73NM:1').entries, [{ sku: 'C73NM', qty: 1 }]);
});

test('§1 multiple entries, order preserved', () => {
    assert.deepEqual(skus('C73NM:1,GLC3333M:2,PG-540:3'), ['C73NM:1', 'GLC3333M:2', 'PG-540:3']);
});

test('§1 SKUs are uppercased (the spec says uppercase; links get lowercased in the wild)', () => {
    assert.deepEqual(skus('c73nm:2'), ['C73NM:2']);
});

test('§1 a bare SKU means quantity 1', () => {
    assert.deepEqual(skus('C73NM'), ['C73NM:1']);
});

test('§1 real catalogue SKU shapes survive (hyphens and dots)', () => {
    assert.deepEqual(skus('PG-540:1,670.01:1,20N3HK0:1,GBP71GA3:1'),
        ['PG-540:1', '670.01:1', '20N3HK0:1', 'GBP71GA3:1']);
});

test('§1 whitespace and empty tokens are tolerated, not counted', () => {
    assert.deepEqual(skus(' C73NM:1 , , GLC3333M:2 '), ['C73NM:1', 'GLC3333M:2']);
    assert.deepEqual(P(',,,').entries, []);
    assert.deepEqual(P('   ').entries, []);
    assert.deepEqual(P('').entries, []);
});

test('§1 quantity is bounded 1..20 and out-of-range is REPORTED, not clamped away', () => {
    for (const bad of ['C73NM:0', 'C73NM:21', 'C73NM:999', 'C73NM:-1']) {
        const r = P(bad);
        assert.deepEqual(r.entries, [], `${bad} should not become an entry`);
        assert.deepEqual(r.invalid, [bad], `${bad} must be reported as invalid`);
    }
});

test('§1 a non-integer quantity is junk — Number() would have accepted three of these', () => {
    for (const bad of ['C73NM:abc', 'C73NM:2.5', 'C73NM:2e1', 'C73NM: ', 'C73NM:0x2']) {
        assert.deepEqual(P(bad).entries, [], `${bad} should not become an entry`);
        assert.equal(P(bad).invalid.length, 1);
    }
});

test('§1 a malformed token is collected, never silently dropped', () => {
    const r = P('C73NM:1,<script>:1,GLC3333M:2');
    assert.deepEqual(skus('C73NM:1,<script>:1,GLC3333M:2'), ['C73NM:1', 'GLC3333M:2']);
    assert.deepEqual(r.invalid, ['<script>:1']);
});

test('§1 a second colon is junk', () => {
    assert.deepEqual(P('C73NM:1:2').invalid, ['C73NM:1:2']);
});

test('§1 max 12 entries, and the overflow sets truncated', () => {
    const many = Array.from({ length: 14 }, (_, i) => `SKU${i}:1`).join(',');
    const r = P(many);
    assert.equal(r.entries.length, DeepLink.MAX_ENTRIES);
    assert.equal(r.entries.length, 12);
    assert.equal(r.truncated, true, 'dropping two entries silently is the whole bug class');
});

test('§1 exactly 12 entries is not truncated', () => {
    const twelve = Array.from({ length: 12 }, (_, i) => `SKU${i}:1`).join(',');
    assert.equal(P(twelve).truncated, false);
});

test('§1 duplicate SKUs are summed, and a sum over the cap is reported as clamped', () => {
    assert.deepEqual(skus('C73NM:3,C73NM:4'), ['C73NM:7']);
    const r = P('C73NM:15,C73NM:10');
    assert.deepEqual(r.entries, [{ sku: 'C73NM', qty: 20 }]);
    assert.deepEqual(r.clamped, ['C73NM']);
});

test('§1 a duplicate does not consume a second slot against the 12 cap', () => {
    const twelve = Array.from({ length: 12 }, (_, i) => `SKU${i}:1`).join(',');
    assert.equal(P(`${twelve},SKU0:1`).truncated, false);
    assert.deepEqual(P(`${twelve},SKU0:1`).entries[0], { sku: 'SKU0', qty: 2 });
});

test('§1 non-string input cannot throw', () => {
    for (const junk of [null, undefined, 42, {}, []]) {
        assert.deepEqual(DeepLink.parseAddParam(junk).entries, []);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// §2 — the summary. A partial result must never read as a success.
// ─────────────────────────────────────────────────────────────────────────────

const summary = (over) => DeepLink.buildSummary(Object.assign(
    { addedCount: 0, requestedCount: 0, failed: [], invalid: [], truncated: false, clamped: [] }, over));

test('§2 a clean batch is a success toast', () => {
    const s = summary({ addedCount: 3, requestedCount: 3 });
    assert.equal(s.type, 'success');
    assert.match(s.text, /Added 3 items/);
});

test('§2 singular for one item', () => {
    assert.match(summary({ addedCount: 1, requestedCount: 1 }).text, /Added 1 item to your cart\./);
});

test('§2 a PARTIAL batch names what failed and shows both numbers', () => {
    const s = summary({ addedCount: 2, requestedCount: 3, failed: ['C73NM'] });
    assert.equal(s.type, 'warning', 'a partial delivery is not a success');
    assert.match(s.text, /Added 2 of 3/);
    assert.match(s.text, /C73NM/, 'the shopper must be told WHICH cartridge is missing');
});

test('§2 nothing added is an error, and says why', () => {
    const s = summary({ addedCount: 0, requestedCount: 1, failed: ['C73NM'] });
    assert.equal(s.type, 'error');
    assert.match(s.text, /Nothing was added/);
    assert.match(s.text, /C73NM/);
});

test('§2 truncation and clamping surface even when every add succeeded', () => {
    // The adds all worked, so an addedCount-only check would call this a success
    // and the shopper would never learn that two of their fourteen cartridges
    // were dropped at the door.
    const s = summary({ addedCount: 12, requestedCount: 12, truncated: true, clamped: ['C73NM'] });
    assert.equal(s.type, 'warning');
    assert.match(s.text, /only the first 12 items/);
    assert.match(s.text, /capped at 20/);
});

test('§2 an unreadable link with no valid entries still explains itself', () => {
    const s = summary({ addedCount: 0, requestedCount: 0, invalid: ['junk'] });
    assert.equal(s.type, 'error');
    assert.match(s.text, /couldn't read junk/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §3 — the reorder status toast
// ─────────────────────────────────────────────────────────────────────────────

// Inverted 2026-09-25 (ERR-286). The backend listed FIVE values, not four —
// `error` (an exception on their side) was missing, and `guest` lands on
// /SHOP, where this file used to never run. An unknown value used to be
// dropped silently; a reorder that did not say it worked now says so.
test('§3 all five documented ?reorder= values have copy', () => {
    for (const status of ['loaded', 'unavailable', 'invalid', 'error', 'guest']) {
        const entry = DeepLink.REORDER_MESSAGES[status];
        assert.ok(entry && entry.text && entry.type, `${status} has no copy`);
    }
    assert.equal(DeepLink.REORDER_MESSAGES.error.type, 'error', 'a backend failure is an error, not a shrug');
});

test('§3 an unknown status gets a neutral message — never undefined, never silence', () => {
    assert.equal(DeepLink.handleReorderParam('wat'), DeepLink.REORDER_UNKNOWN);
    // The prototype-chain guard still holds: 'constructor' must not resolve to
    // Object's own function and toast "[Function: Object]".
    assert.equal(DeepLink.handleReorderParam('constructor'), DeepLink.REORDER_UNKNOWN);
    assert.equal(typeof DeepLink.REORDER_UNKNOWN.text, 'string');
    // [CONTROL] no status at all is still nothing.
    assert.equal(DeepLink.handleReorderParam(undefined), null);
    assert.equal(DeepLink.handleReorderParam(''), null);
});

test('§3 /shop loads the script and answers ?reorder= ONLY — never ?add=', () => {
    const shop = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'html', 'shop.html'), 'utf8');
    assert.match(shop, /src="\/js\/cart-deep-link\.js\?v=[0-9a-f]{8}"/, '/shop?reorder=guest needs the handler loaded');
    const src = fs.readFileSync(path.join(ROOT, 'inkcartridges', 'js', 'cart-deep-link.js'), 'utf8');
    const fn = src.slice(src.indexOf('    applyReorderParamFromUrl() {'), src.indexOf('    async applyAddParamFromUrl() {'));
    assert.match(fn, /this\._stripParams\(\['reorder'\]\)/, 'only reorder is stripped on /shop');
    assert.doesNotMatch(fn, /parseAddParam|addItem|'add'/, 'the shop page must never act on ?add=');
    assert.match(src, /else if \(document\.querySelector\('\.shop-page'\)\) \{\s*CartDeepLink\.applyReorderParamFromUrl\(\);/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 — the whole handler, driven against stubbed globals
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 *   url        — the address to start at
 *   catalogue  — { SKU: productRecord | null }  (null = getProduct misses)
 *   addResult  — (sku) => the object Cart.addItem resolves to (or throws)
 *   cartLoadingFor — how many polls Cart.loading stays true
 */
async function drive(opts) {
    const events = [];
    const saved = {};
    const globals = {};

    let href = opts.url;
    globals.window = {
        get location() { return { href }; },
    };
    globals.history = {
        state: null,
        replaceState(state, title, next) {
            events.push({ type: 'strip', url: next });
            href = new URL(next, 'https://www.inkcartridges.co.nz').href;
        },
    };
    globals.showToast = (text, type) => { events.push({ type: 'toast', toastType: type, text }); };

    let pollsLeft = opts.cartLoadingFor || 0;
    globals.Cart = {
        get loading() { return pollsLeft-- > 0; },
        updateUI() { events.push({ type: 'updateUI' }); },
        async addItem(product) {
            events.push({ type: 'add:start', sku: product.sku, qty: product.quantity, silent: product.silent });
            await new Promise((r) => setTimeout(r, 1));
            events.push({ type: 'add:end', sku: product.sku });
            const behave = opts.addResult ? opts.addResult(product.sku) : { ok: true, reason: 'confirmed' };
            if (behave instanceof Error) throw behave;
            return behave;
        },
    };
    globals.API = {
        async getProduct(sku) {
            events.push({ type: 'lookup', sku });
            const record = Object.prototype.hasOwnProperty.call(opts.catalogue || {}, sku)
                ? opts.catalogue[sku] : null;
            if (!record) return { ok: false, error: 'NOT_FOUND' };
            return { ok: true, data: record };
        },
    };

    for (const key of Object.keys(globals)) {
        saved[key] = global[key];
        global[key] = globals[key];
    }
    try {
        const report = await DeepLink.applyAddParamFromUrl();
        return { report, events, href };
    } finally {
        for (const key of Object.keys(globals)) {
            if (saved[key] === undefined) delete global[key];
            else global[key] = saved[key];
        }
    }
}

const product = (sku, over = {}) => Object.assign({
    id: `uuid-${sku}`, sku, name: `Brother ${sku}`, retail_price: 65.49,
    image_url: 'x.png', brand: { name: 'Brother' }, source: 'genuine', slug: sku.toLowerCase(),
}, over);

test('§4 the acceptance check: /cart?add=C73NM:1 adds one and cleans the URL', async () => {
    const { report, events, href } = await drive({
        url: 'https://www.inkcartridges.co.nz/cart?add=C73NM:1',
        catalogue: { C73NM: product('C73NM') },
    });
    assert.equal(report.addedCount, 1);
    assert.equal(report.ok, true);
    assert.equal(new URL(href).search, '', 'the address bar must read plain /cart');
    assert.equal(new URL(href).pathname, '/cart');
    const added = events.filter((e) => e.type === 'add:start');
    assert.equal(added.length, 1);
    assert.equal(added[0].sku, 'C73NM');
    assert.equal(added[0].qty, 1);
});

test('§4 THE PARAM IS STRIPPED BEFORE THE FIRST ADD — a refresh must not double-add', async () => {
    const { events } = await drive({
        url: 'https://www.inkcartridges.co.nz/cart?add=C73NM:1,GLC3333M:2',
        catalogue: { C73NM: product('C73NM'), GLC3333M: product('GLC3333M') },
    });
    const stripAt = events.findIndex((e) => e.type === 'strip');
    const firstAddAt = events.findIndex((e) => e.type === 'add:start');
    assert.ok(stripAt > -1, 'the param was never stripped');
    assert.ok(firstAddAt > -1);
    assert.ok(stripAt < firstAddAt,
        'strip must precede the first add — otherwise an F5 mid-flight re-runs the whole link');
});

test('§4 other query params survive the strip', async () => {
    const { href } = await drive({
        url: 'https://www.inkcartridges.co.nz/cart?utm_source=email&add=C73NM:1&coupon=SAVE5',
        catalogue: { C73NM: product('C73NM') },
    });
    const params = new URL(href).searchParams;
    assert.equal(params.get('add'), null);
    assert.equal(params.get('utm_source'), 'email');
    assert.equal(params.get('coupon'), 'SAVE5', 'the coupon handler still needs its param');
});

test('§4 adds are SERIAL — concurrent adds race the pricing GET (ERR-210)', async () => {
    const { events } = await drive({
        url: 'https://www.inkcartridges.co.nz/cart?add=A:1,B:1,C:1',
        catalogue: { A: product('A'), B: product('B'), C: product('C') },
    });
    const addSeq = events.filter((e) => e.type === 'add:start' || e.type === 'add:end');
    for (let i = 0; i < addSeq.length; i += 2) {
        assert.equal(addSeq[i].type, 'add:start');
        assert.equal(addSeq[i + 1].type, 'add:end', 'an add began before the previous one finished');
        assert.equal(addSeq[i].sku, addSeq[i + 1].sku);
    }
});

test('§4 every add is silent — 12 toasts is not a report', async () => {
    const { events } = await drive({
        url: 'https://www.inkcartridges.co.nz/cart?add=A:1,B:1',
        catalogue: { A: product('A'), B: product('B') },
    });
    for (const e of events.filter((x) => x.type === 'add:start')) {
        assert.equal(e.silent, true);
    }
    assert.equal(events.filter((e) => e.type === 'toast').length, 1, 'exactly one summary toast');
});

test('§4 A PARTIAL LINK IS REPORTED AS PARTIAL, by name', async () => {
    const { report, events } = await drive({
        url: 'https://www.inkcartridges.co.nz/cart?add=A:1,GONE:1,B:1',
        catalogue: { A: product('A'), B: product('B') },   // GONE misses
    });
    assert.equal(report.addedCount, 2);
    assert.deepEqual(report.failed, ['GONE']);
    assert.equal(report.ok, false);
    const toast = events.find((e) => e.type === 'toast');
    assert.equal(toast.toastType, 'warning');
    assert.match(toast.text, /Added 2 of 3/);
    assert.match(toast.text, /GONE/);
});

test('§4 a server REFUSAL (ok:false) counts as failed, not added', async () => {
    const { report } = await drive({
        url: 'https://www.inkcartridges.co.nz/cart?add=A:1,B:1',
        catalogue: { A: product('A'), B: product('B') },
        addResult: (sku) => (sku === 'B'
            ? { ok: false, reason: 'server-rejected', error: 'Out of stock' }
            : { ok: true, reason: 'confirmed' }),
    });
    assert.equal(report.addedCount, 1);
    assert.deepEqual(report.failed, ['B']);
});

test("§4 an 'offline' add counts as ADDED — the item IS in their cart", async () => {
    const { report } = await drive({
        url: 'https://www.inkcartridges.co.nz/cart?add=A:1',
        catalogue: { A: product('A') },
        addResult: () => ({ ok: true, reason: 'offline' }),
    });
    assert.equal(report.addedCount, 1);
    assert.deepEqual(report.failed, []);
});

test('§4 a throwing add is caught and counted as failed', async () => {
    const { report } = await drive({
        url: 'https://www.inkcartridges.co.nz/cart?add=A:1,B:1',
        catalogue: { A: product('A'), B: product('B') },
        addResult: (sku) => (sku === 'A' ? new Error('boom') : { ok: true, reason: 'confirmed' }),
    });
    assert.equal(report.addedCount, 1);
    assert.deepEqual(report.failed, ['A']);
});

test('§4 a product record with no id is a miss, not an add of undefined (ERR-218)', async () => {
    const { report, events } = await drive({
        url: 'https://www.inkcartridges.co.nz/cart?add=A:1',
        catalogue: { A: product('A', { id: undefined }) },
    });
    assert.equal(report.addedCount, 0);
    assert.deepEqual(report.failed, ['A']);
    assert.equal(events.filter((e) => e.type === 'add:start').length, 0,
        'never POST a product_id of undefined');
});

test('§4 it waits for Cart.loading to clear before the first add (ERR-259 race)', async () => {
    const { report, events } = await drive({
        url: 'https://www.inkcartridges.co.nz/cart?add=A:1',
        catalogue: { A: product('A') },
        cartLoadingFor: 3,
    });
    assert.equal(report.addedCount, 1);
    assert.ok(events.some((e) => e.type === 'add:start'));
});

test('§4 no ?add= at all is a no-op that returns null', async () => {
    const { report, events } = await drive({
        url: 'https://www.inkcartridges.co.nz/cart',
        catalogue: {},
    });
    assert.equal(report, null);
    assert.equal(events.filter((e) => e.type === 'toast').length, 0);
    assert.equal(events.filter((e) => e.type === 'add:start').length, 0);
});

test('§4 ?reorder= toasts even with no ?add=, and is stripped', async () => {
    const { events, href } = await drive({
        url: 'https://www.inkcartridges.co.nz/cart?reorder=unavailable',
        catalogue: {},
    });
    const toast = events.find((e) => e.type === 'toast');
    assert.ok(toast, 'the reorder status produced no toast');
    assert.equal(toast.toastType, 'warning');
    assert.equal(new URL(href).search, '');
});

test('§4 an entirely unreadable ?add= still strips and still explains', async () => {
    const { report, events, href } = await drive({
        url: 'https://www.inkcartridges.co.nz/cart?add=%20%3A%3A',
        catalogue: {},
    });
    assert.equal(report.addedCount, 0);
    assert.equal(new URL(href).search, '', 'a junk link must still clean the address bar');
    assert.equal(events.find((e) => e.type === 'toast').toastType, 'error');
});

test('§4 the cart is re-rendered once at the end', async () => {
    const { events } = await drive({
        url: 'https://www.inkcartridges.co.nz/cart?add=A:1',
        catalogue: { A: product('A') },
    });
    assert.equal(events.filter((e) => e.type === 'updateUI').length, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// §5 — the contract it depends on, in cart.js
// ─────────────────────────────────────────────────────────────────────────────

test('§5 Cart.addItem returns a result on ALL FOUR branches', () => {
    for (const reason of ['confirmed', 'local-only', 'offline', 'server-rejected']) {
        assert.match(CART_SRC, new RegExp(`reason: '${reason}'|reason: serverConfirmed \\? 'confirmed'`),
            `addItem has no return carrying reason='${reason}'`);
    }
    assert.match(CART_SRC, /return \{ ok: false, reason: 'server-rejected'/);
    assert.match(CART_SRC, /return \{ ok: true, reason: 'offline'/);
});

test('§5 addItem has no bare `return;` left — undefined is indistinguishable from success', () => {
    const start = CART_SRC.indexOf('async addItem(product) {');
    assert.ok(start > -1);
    const end = CART_SRC.indexOf('\n    async _showCrossSellModal', start);
    assert.ok(end > start);
    const body = CART_SRC.slice(start, end);
    assert.doesNotMatch(body, /^\s+return;\s*$/m,
        'a bare return inside addItem means a caller cannot tell a refusal from a success');
});

test('§5 the silent flag gates only the toasts, and every toast in addItem respects it', () => {
    const start = CART_SRC.indexOf('async addItem(product) {');
    const end = CART_SRC.indexOf('\n    async _showCrossSellModal', start);
    const body = CART_SRC.slice(start, end);
    const toasts = [...body.matchAll(/typeof showToast === 'function'([^)]*)\)/g)];
    assert.ok(toasts.length >= 3, `expected >=3 toast guards in addItem, found ${toasts.length}`);
    for (const m of toasts) {
        assert.match(m[1], /!product\.silent/,
            'a toast in addItem that ignores product.silent will fire 12 times on a deep link');
    }
});

test('§5 the deep link calls addItem, never the non-existent Cart.add (ERR-218)', () => {
    assert.doesNotMatch(DEEP_SRC, /Cart\.add\s*\(/);
    assert.match(DEEP_SRC, /Cart\.addItem\(/);
});

test('§5 the deep link passes an OBJECT with a real id, and quantity inside it', () => {
    assert.match(DEEP_SRC, /id: product\.id/);
    assert.match(DEEP_SRC, /quantity: qty/);
    assert.match(DEEP_SRC, /source: 'core'/);
});

test('§5 a lookup is only trusted when it carries an id — allSettled fulfils on failure too', () => {
    assert.match(DEEP_SRC, /res && res\.ok && res\.data/);
    assert.match(DEEP_SRC, /product && product\.id/);
});

// ─────────────────────────────────────────────────────────────────────────────
// §6 — enrolment. A feature nobody loads is a feature nobody has (ERR-214).
// ─────────────────────────────────────────────────────────────────────────────

test('§6 cart.html loads cart-deep-link.js', () => {
    assert.match(CART_HTML, /src="\/js\/cart-deep-link\.js(\?v=[a-f0-9]+)?"/,
        'the deep link is inert unless cart.html loads it');
});

test('§6 it loads AFTER cart.js and cart-page.js', () => {
    const at = (f) => CART_HTML.indexOf(`/js/${f}`);
    assert.ok(at('cart.js') > -1 && at('cart-deep-link.js') > at('cart.js'),
        'cart-deep-link.js must come after cart.js — it calls Cart');
    assert.ok(at('cart-deep-link.js') > at('cart-page.js'));
});

test('§6 it is deferred, like every other page script', () => {
    assert.match(CART_HTML, /<script defer src="\/js\/cart-deep-link\.js/);
});

test('§6 it self-enrols and only on the cart page', () => {
    assert.match(DEEP_SRC, /document\.addEventListener\('DOMContentLoaded'/);
    assert.match(DEEP_SRC, /querySelector\('\.cart-page'\)/,
        'it must no-op on every other page that happens to load it');
});

test('§6 it is exported for Node and attached for the browser', () => {
    assert.match(DEEP_SRC, /typeof window !== 'undefined'/);
    assert.match(DEEP_SRC, /module\.exports = CartDeepLink/);
});
