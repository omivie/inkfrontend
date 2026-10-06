/**
 * FE master checklist, v2 (the backend's 6 Oct afternoon re-issue)
 * =============================================================================
 * Source: backend-docs/inbox/FE-MASTER-CHECKLIST-oct2026.md, "Status after the
 * live check of the FE deploy (6 Oct, afternoon)" + items 16 and 17. Items 14
 * and 15 shipped in b2d07c0f (ERR-307) after the backend's check ran.
 *
 *   §2   the cart wallet is ON (owner waived the iPhone test order, 6 Oct).
 *   §6   PDP "Earn N reward points" sits IN THE PRICE ROW. It lived in
 *        #product-value-lines, which the >=1100px layout moves below Add
 *        (pages.css, ERR-293) — y 1183 at 1366x599 on the backend's check.
 *   §16  a genuine PDP shows "Our compatible version" from
 *        `compatible_alternatives`, under Add, prices and yields only.
 *   §17  a cart line stops at its stock: + walked GDK11203WH (8 in stock) to
 *        13, the PUT got 400, and the toast said "Network error".
 *
 * Behaviour is EXECUTED (the real cart.js in a vm, real methods extracted from
 * product-detail-page.js / business.js, the real QtyStepper), so a test cannot
 * pass on a comment.
 *
 * Run: node --test tests/fe-master-checklist-v2-oct2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const stripComments = require('./helpers/strip-comments');

const ROOT = path.resolve(__dirname, '..');
const PDP_FILE = 'js/product-detail-page.js';
const read = (rel) => fs.readFileSync(path.join(ROOT, 'inkcartridges', rel), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// assert.match prints the whole 150 KB source on a miss; this prints the label.
const has = (src, re, label) => assert.ok(re.test(src), `${label || ''} — expected ${re}`);
const hasNot = (src, re, label) => assert.ok(!re.test(src), `${label || ''} — must not match ${re}`);

function extractMethod(raw, name) {
    const src = stripComments(raw);
    const re = new RegExp(`\\n\\s+(?:async\\s+)?${name}(?:\\s*:\\s*(?:async\\s+)?function)?\\s*\\(([^)]*)\\)\\s*\\{`);
    const m = re.exec(src);
    assert.ok(m, `${name}() must exist`);
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let quote = null;
    for (let i = open; i < src.length; i++) {
        const c = src[i];
        if (quote) {
            if (c === '\\') { i++; continue; }
            if (c === quote) quote = null;
            continue;
        }
        if (c === '\'' || c === '"' || c === '`') { quote = c; continue; }
        if (c === '{') depth++;
        else if (c === '}' && --depth === 0) return { params: m[1], body: src.slice(open, i + 1), async: /async/.test(m[0]) };
    }
    throw new Error(`unbalanced ${name}`);
}
function method(file, name, self = {}, globals = {}) {
    const { params, body, async } = extractMethod(read(file), name);
    const ctx = vm.createContext({ formatPrice: (n) => '$' + Number(n).toFixed(2), setTimeout, clearTimeout, Promise, Date, JSON, Math, Number, String, Array, Object, ...globals });
    const fn = vm.runInContext(`(${async ? 'async ' : ''}function (${params}) ${body})`, ctx);
    return (...args) => fn.apply(self, args);
}

const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const Security = { escapeHtml: esc, escapeAttr: esc, sanitizeUrl: (u) => (/^https?:\/\//.test(u) ? u : '#') };

// ─── the real cart.js in a sandbox, with toasts captured ────────────────────
const CART_SRC = read('js/cart.js');
function loadCart(api = {}) {
    const store = Object.create(null);
    const toasts = [];
    const stubEl = () => ({ hidden: false, textContent: '', innerHTML: '', style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        setAttribute() {}, getAttribute() { return null; }, removeAttribute() {}, addEventListener() {}, appendChild() {}, insertAdjacentHTML() {},
        querySelector() { return null; }, querySelectorAll() { return []; }, closest() { return null; } });
    const sandbox = {
        console, setTimeout, clearTimeout, setInterval, clearInterval,
        JSON, Math, Date, Number, String, Boolean, Array, Object, Set, Map, Promise, Error,
        localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
        navigator: { onLine: true },
        document: { getElementById: () => stubEl(), querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, visibilityState: 'visible' },
        DebugLog: { log() {}, warn() {}, error() {} },
        Security,
        formatPrice: (n) => '$' + Number(n || 0).toFixed(2),
        calculateGST: (n) => Number(n || 0) * 0.15 / 1.15,
        showToast: (msg, type) => toasts.push({ msg, type }),
        API: api,
        Auth: { initialized: true, isAuthenticated: () => false, onAuthStateChange() {} },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(CART_SRC + '\n;globalThis.__Cart = Cart;', sandbox, { filename: 'cart.js' });
    const Cart = sandbox.__Cart;
    Cart.loading = false;
    Cart.__toasts = toasts;
    // Every path re-reads the cart; the sandbox has no server, so a re-read
    // is recorded and leaves the lines as they are.
    Cart.__reloads = 0;
    Cart.loadFromServer = async function () { Cart.__reloads++; };
    Cart.updateUI = function () {};
    Cart._updateCartItemDOM = function () {};
    Cart._updateCartSummaryDOM = function () {};
    return Cart;
}
// GDK11203WH: 8 in stock on 2026-10-06 (GET /api/products/GDK11203WH).
const dkLine = (quantity, stock = 8) => ({ id: 'dk', key: 'dk', sku: 'GDK11203WH', price: 27.99, quantity, source: 'core', stock_quantity: stock });
const STOCK_TOAST = /^Only 8 in stock — that is the most you can order\.$/;

// ═══ §17 the cart quantity stops at stock ════════════════════════════════════

test('§17 maxQuantityFor: stock capped at MAX_QUANTITY; unknown keeps MAX_QUANTITY; 0 caps at 1', () => {
    const Cart = loadCart();
    assert.equal(Cart.MAX_QUANTITY, 100);
    const cases = [[null, 100], [undefined, 100], [8, 8], ['8', 8], [8.7, 8], [0, 1], [-1, 100], [250, 100], ['n/a', 100]];
    for (const [stock, want] of cases) {
        assert.equal(Cart.maxQuantityFor({ stock_quantity: stock }), want, `stock ${JSON.stringify(stock)}`);
    }
    assert.equal(Cart.maxQuantityFor(undefined), 100, 'no line ⇒ the global cap');
});

test('§17 _parseServerCart keeps items[].product.stock_quantity (absent ⇒ null, never 0)', () => {
    const Cart = loadCart();
    const parsed = Cart._parseServerCart({ items: [
        { id: 'r1', quantity: 1, product: { id: 'dk', sku: 'GDK11203WH', name: 'Brother DK-11203', retail_price: 27.99, stock_quantity: 8 } },
        { id: 'r2', quantity: 1, product: { id: 'x', sku: 'X1', name: 'X', retail_price: 5 } },
    ] });
    const items = parsed.items || parsed;
    assert.equal(items[0].stock_quantity, 8);
    assert.equal(items[1].stock_quantity, null);
});

test('§17 a typed or debounced quantity above stock becomes the stock, and the PUT carries the stock', async () => {
    const puts = [];
    const Cart = loadCart({ updateCartItem: async (id, q) => { puts.push(q); return { ok: true, data: {} }; } });
    Cart.items = [dkLine(1)];
    Cart._debouncedQuantityUpdate('dk', 28);
    assert.equal(Cart.items[0].quantity, 8, 'clamped locally at once');
    await sleep(900);
    assert.deepEqual(puts, [8], 'the server is asked for 8, never 28');
});

test('§17 updateQuantity (programmatic) sends the CLAMPED quantity, not the raw one', async () => {
    const puts = [];
    const Cart = loadCart({ updateCartItem: async (id, q) => { puts.push(q); return { ok: true, data: {} }; } });
    Cart.items = [dkLine(1)];
    await Cart.updateQuantity('dk', 13);
    assert.deepEqual(puts, [8]);
    assert.equal(Cart.items[0].quantity, 8);
});

test('§17 stockRefusal reads both shapes: the STOCK_INSUFFICIENT envelope and the legacy thrown Error', () => {
    const Cart = loadCart();
    assert.equal(Cart.stockRefusal({ ok: false, code: 'STOCK_INSUFFICIENT', details: { available: 8 } }), 8);
    assert.equal(Cart.stockRefusal({ ok: false, code: 'STOCK_INSUFFICIENT', details: { available: 0, current_in_cart: 8 } }), 0);
    const legacy = Object.assign(new Error('Insufficient stock'), { code: 'BAD_REQUEST', details: { available: 8 } });
    assert.equal(Cart.stockRefusal(legacy), 8);
    assert.equal(Cart.stockRefusal({ ok: false, code: 'VALIDATION_FAILED', details: { available: 8 } }), null, 'a resolved non-stock refusal is not a stock refusal');
    assert.equal(Cart.stockRefusal(new Error('fetch failed')), null, 'a real network error is not a stock refusal');
    assert.equal(Cart.stockRefusal({ ok: false, code: 'STOCK_INSUFFICIENT' }), null, 'no figure ⇒ nothing to cap at');
    assert.equal(Cart.stockRefusal(null), null);
});

test('§17 a PUT refused for stock says "Only 8 in stock", records the stock, and NEVER says "Failed"/"Network error"', async () => {
    // Stock fell after the page loaded: the line believes 20, the server has 8.
    for (const answer of [
        async () => ({ ok: false, code: 'STOCK_INSUFFICIENT', error: 'Only 8 in stock.', details: { available: 8 } }),
        async () => { throw Object.assign(new Error('Insufficient stock'), { code: 'BAD_REQUEST', details: { available: 8 } }); },
    ]) {
        const Cart = loadCart({ updateCartItem: answer });
        Cart.items = [dkLine(9, 20)];
        await Cart._executeQuantityUpdate('dk', 9);
        const msgs = Cart.__toasts.map((t) => t.msg);
        assert.equal(msgs.length, 1, JSON.stringify(msgs));
        assert.match(msgs[0], STOCK_TOAST);
        assert.equal(Cart.__toasts[0].type, 'info');
        assert.equal(Cart.items[0].stock_quantity, 8, 'every later cap uses the stock the server named');
        assert.equal(Cart.maxQuantityFor(Cart.items[0]), 8);
        assert.equal(Cart.__reloads, 1, 'the cart is still re-read');
    }
});

test('§17 updateQuantity\'s refusal branches give the same stock toast; a real failure keeps its message', async () => {
    let Cart = loadCart({ updateCartItem: async () => ({ ok: false, code: 'STOCK_INSUFFICIENT', details: { available: 8 } }) });
    Cart.items = [dkLine(5, 20)];
    await Cart.updateQuantity('dk', 9);
    assert.deepEqual(Cart.__toasts.map((t) => t.msg).filter((m) => /in stock/.test(m)).length, 1);
    assert.equal(Cart.items[0].quantity, 5, 'rolled back');

    Cart = loadCart({ updateCartItem: async () => { throw new Error('fetch failed'); } });
    Cart.items = [dkLine(1)];
    await Cart.updateQuantity('dk', 2);
    assert.deepEqual(Cart.__toasts.map((t) => t.msg), ['Network error. Quantity reverted.'], 'a REAL network error still says so');

    Cart = loadCart({ updateCartItem: async () => ({ ok: false, code: 'SERVER_ERROR' }) });
    Cart.items = [dkLine(1)];
    await Cart._executeQuantityUpdate('dk', 2);
    assert.deepEqual(Cart.__toasts.map((t) => t.msg), ['Failed to update quantity. Please try again.']);
});

test('§17 a rate-limited quantity change says so — never "Network error" (measured 6 Oct: PUT 429 ⇒ "Network error")', async () => {
    const thrown = Object.assign(new Error('Too many requests. Please wait a moment.'), { code: 'RATE_LIMITED' });
    for (const [answer, run] of [
        [async () => ({ ok: false, code: 'RATE_LIMITED', error: 'Too many requests' }), (C) => C._executeQuantityUpdate('dk', 2)],
        [async () => { throw thrown; }, (C) => C._executeQuantityUpdate('dk', 2)],
        [async () => ({ ok: false, code: 'RATE_LIMITED' }), (C) => C.updateQuantity('dk', 2)],
        [async () => { throw thrown; }, (C) => C.updateQuantity('dk', 2)],
    ]) {
        const Cart = loadCart({ updateCartItem: answer });
        Cart.items = [dkLine(1)];
        await run(Cart);
        assert.deepEqual(Cart.__toasts, [{ msg: 'Too many changes at once. Please wait a moment and try again.', type: 'warning' }]);
    }
});

test('§17 addItem carries the caller\'s stock onto a NEW local line, and a STOCK_INSUFFICIENT add rolls back', async () => {
    const Cart = loadCart({ addToCart: async () => ({ ok: false, code: 'STOCK_INSUFFICIENT', error: 'Only 8 in stock, and 8 are already in your cart.', details: { available: 8, current_in_cart: 8 } }),
        extractErrorMessage: (r, f) => (r && r.error) || f });
    Cart.items = [];
    const result = await Cart.addItem({ id: 'dk', sku: 'GDK11203WH', name: 'DK', price: 27.99, quantity: 1, stock_quantity: 8 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'server-rejected');
    assert.equal(Cart.items.length, 0, 'the refused line is rolled back, not "saved locally"');
    assert.ok(Cart.__toasts.some((t) => /Only 8 in stock, and 8 are already in your cart\./.test(t.msg)), JSON.stringify(Cart.__toasts));

    const ok = loadCart({ addToCart: async () => ({ ok: true, data: { quantity: 1 } }) });
    ok.items = [];
    await ok.addItem({ id: 'dk', sku: 'GDK11203WH', name: 'DK', price: 27.99, quantity: 1, stock_quantity: 8 });
    assert.equal(ok.items[0].stock_quantity, 8);
    assert.equal(ok.maxQuantityFor(ok.items[0]), 8);
});

test('§17 every cart cap site uses the LINE\'s cap — no literal 100 left, the render map still uses self', () => {
    const code = stripComments(CART_SRC);
    hasNot(code, /input\.max = 100/);
    hasNot(code, /item\.quantity >= 100/);
    has(code, /const maxQty = this\.maxQuantityFor\(line\);[\s\S]{0,200}const newValue = parseInt\(input\.value\) \+ 1;/, '+ handler');
    has(code, /if \(newValue >= maxQty && maxQty < this\.MAX_QUANTITY\) \{\s*increaseBtn\.disabled = true;\s*this\._toastStockCap\(line\.stock_quantity\);/, '+ at the cap disables and says so');
    has(code, /let newValue = parseInt\(e\.target\.value\);[\s\S]{0,400}if \(maxQty < this\.MAX_QUANTITY\) this\._toastStockCap\(line\.stock_quantity\);/, 'typed value at the cap says so');
    has(code, /Math\.min\(quantity, this\.maxQuantityFor\(item\)\)/, '_debouncedQuantityUpdate clamp');
    has(code, /const maxQty = this\.maxQuantityFor\(item\);\s*if \(input\) input\.max = maxQty;[\s\S]{0,400}increaseBtn\.disabled = item\.quantity >= maxQty;/, '_updateCartItemDOM');
    has(code, /const maxQty = self\.maxQuantityFor\(item\);/, 'full render, via self');
    has(code, /max="' \+ maxQty \+ '"/);
    has(code, /\(item\.quantity >= maxQty \? ' disabled' : ''\)/);
    has(code, /data-max-quantity="' \+ maxQty \+ '"/, 'the line tells the volume nudge its cap');
    has(code, /QtyStepper\.markup\(\{ value: 1, stock: p\.stock_quantity \}\)/, 'cross-sell stepper');
});

test('§17 the volume nudge reads the LINE\'s cap: never "add N more" past stock', async () => {
    const seen = [];
    const self = {
        hasLadderFor: () => true, isActive: async () => true,
        getPricing: async () => ({ items: new Map([['GDK11203WH', {}]]) }),
        describeLadder: () => ({ ladder: true }),
        nudgeFromServer: () => null,
        nudgeMarkup: (ladder, qty, max) => { seen.push(max); return ''; },
    };
    const mk = (maxAttr) => ({ getAttribute: (k) => ({ 'data-sku': 'GDK11203WH', 'data-quantity': '7', 'data-max-quantity': maxAttr })[k] ?? null, querySelector: () => null });
    const decorate = method('js/business.js', 'decorateCartLines', self);
    await decorate({ querySelectorAll: () => [mk('8'), mk(null)] }, 100, null);
    assert.deepEqual(seen, [8, 100], 'line cap when printed, else the global cap');
});

// ─── QtyStepper (product cards) ─────────────────────────────────────────────
const { QtyStepper } = require(path.join(ROOT, 'inkcartridges/js/utils.js'));

test('§17 QtyStepper: a card stepper caps at the product\'s stock; ceiling() alone is unchanged', () => {
    assert.equal(QtyStepper.ceiling(), 100, 'pinned by tests/qty-stepper-sep2026.test.js');
    assert.equal(QtyStepper.capFor(8), 8);
    assert.equal(QtyStepper.capFor(0), 1);
    assert.equal(QtyStepper.capFor(null), 100);
    assert.equal(QtyStepper.capFor(''), 100);
    assert.equal(QtyStepper.capFor(500), 100);

    const eight = QtyStepper.markup({ value: 1, stock: 8 });
    assert.match(eight, /data-qty-stepper data-max="8"/);
    assert.match(eight, /max="8"/);
    const one = QtyStepper.markup({ value: 1, stock: 1 });
    assert.match(one, /data-step="up" disabled/, 'stock 1 ⇒ + disabled in the markup');
    const unknown = QtyStepper.markup({ value: 1 });
    assert.doesNotMatch(unknown, /data-max=/);
    assert.match(unknown, /max="100"/);
    assert.equal(QtyStepper.clamp(28, 8), 8);
    assert.equal(QtyStepper.clamp(28), 28);

    // apply() on a painted stepper clamps to ITS cap.
    const input = { value: '28' };
    const up = { disabled: false }, down = { disabled: false };
    const stepper = { dataset: { max: '8' }, querySelector: (s) => (s === '.product-card__qty-input' ? input : s === '[data-step="up"]' ? up : s === '[data-step="down"]' ? down : null), closest: () => null };
    assert.equal(QtyStepper._apply(stepper, 28), 8);
    assert.equal(input.value, '8');
    assert.equal(up.disabled, true);
});

test('§17 the card surfaces that have stock pass it to the stepper; the PDP box caps at stock', () => {
    assert.match(read('js/products.js'), /QtyStepper\.markup\(\{ value: 1, stock: product\.stock_quantity \}\)/);
    assert.match(read('js/shop-page.js'), /QtyStepper\.markup\(\{ value: 1, stock: product\.stock_quantity \}\)/);
    assert.match(read('js/ribbons-page.js'), /QtyStepper\.markup\(\{ value: 1, stock: ribbon\.stock_quantity \}\)/);
    // Every add path that HAS the product's stock hands it to the cart, so a
    // new line is capped before the next re-read (which a rate-limited backend
    // may not deliver — measured on 6 Oct: 12 clicks went past 8 that way).
    assert.match(read('js/cart-deep-link.js'), /stock_quantity: product\.stock_quantity,/);
    assert.match(read('js/shop-page.js'), /stock_quantity: product\.stock_quantity,/);
    assert.match(read('js/products.js'), /data-product-stock="/);
    assert.match(read('js/products.js'), /stock_quantity: btn\.dataset\.productStock !== undefined/);
    const pdp = stripComments(read('js/product-detail-page.js'));
    assert.match(pdp, /Cart\.maxQuantityFor\(\{ stock_quantity: info\.stock_quantity \}\)/);
    assert.doesNotMatch(pdp, /const maxQty = 99;/);
    assert.match(pdp, /stock_quantity: info\.stock_quantity,/, 'the PDP add carries the stock onto the line');
    assert.match(pdp, /if \(result && result\.ok === false\) \{\s*btn\.textContent = 'Add to Cart';/, 'a refused add never says "Added!"');
});

// ═══ §6 points in the price row ══════════════════════════════════════════════

test('§6 #product-points-line lives in the PRICE <dd>, above Add, and no longer in #product-value-lines', () => {
    const html = read('html/product/index.html');
    const dd = html.match(/<dd class="buy-box__value buy-box__value--price">([\s\S]*?)<\/dd>/);
    assert.ok(dd, 'price dd');
    assert.match(dd[1], /<span class="product-info__points" id="product-points-line" data-testid="product-points" hidden><\/span>/);
    assert.ok(html.indexOf('id="product-points-line"') < html.indexOf('id="add-to-cart-btn"'));
    assert.equal((html.match(/id="product-points-line"/g) || []).length, 1);
    const pdp = stripComments(read('js/product-detail-page.js'));
    assert.doesNotMatch(pdp, /product-value-lines__points/, 'renderValueLines no longer prints a second points slot');
    assert.match(pdp, /line\.textContent = `Earn \$\{earn\.points\.toLocaleString\('en-NZ'\)\} reward points \(\$\{formatPrice\(earn\.value\)\}\)`;/);
    assert.match(read('css/pages.css'), /\.buy-box__value--price \.product-info__points \{/);
});

test('§6 the price-row span is static markup now, so a product WITHOUT reward_points clears it', () => {
    const line = { hidden: false, textContent: 'Earn 67 reward points ($0.67)' };
    const self = { _rewardPoints: null };
    method(PDP_FILE, 'syncPointsLine', self, { document: { getElementById: (id) => (id === 'product-points-line' ? line : null) } })();
    assert.equal(line.hidden, true);
    assert.equal(line.textContent, '');
});

// ═══ §16 "Our compatible version" ════════════════════════════════════════════

const PDP = 'js/product-detail-page.js';
function pdpSelf() {
    const self = {};
    self.pageYieldText = method(PDP, 'pageYieldText', self);
    self.capacityLabel = method(PDP, 'capacityLabel', self);
    self.compatibleAlternativesHtml = method(PDP, 'compatibleAlternativesHtml', self, { Security, storageUrl: (u) => u });
    return self;
}
// As served by GET /api/products/:sku on 2026-10-06.
const CTN2030BK = { sku: 'CTN2030BK', slug: 'tn2030bk-compatible-toner-cartridge-for-brother-tn2030tn2250-black', name: 'TN2030BK Compatible Toner Cartridge for Brother TN2030/TN2250 Black',
    retail_price: 24.49, page_yield: '1,000', yield_tier: 'STD', same_capacity: true, image_url: 'https://lmdlgldjgcanknsjrcxh.supabase.co/x/ctn2030bk/compatible-tile-v1.png', in_stock: true };
const C604XLBK = { sku: 'C604XLBK', slug: '604xlbk-compatible-ink-cartridge-for-epson-604xl-black', name: '604XLBK Compatible Ink Cartridge for Epson 604XL Black',
    retail_price: 25.49, page_yield: null, yield_tier: 'XL', same_capacity: false, image_url: 'https://lmdlgldjgcanknsjrcxh.supabase.co/x/c604xlbk/compatible-tile-v1.png', in_stock: true };
const WARRANTY = { warranty: { compatible_label: 'Compatible cartridges are covered by our 30-day satisfaction guarantee.' } };

test('§16 GTN2030BK: "Our compatible version", CTN2030BK at $24.49, 1,000 pages, View link, Add, warranty line', () => {
    const html = pdpSelf().compatibleAlternativesHtml({ source: 'genuine', yield_tier: 'STD', compatible_alternatives: [CTN2030BK], trust_signals: WARRANTY });
    assert.match(html, /<h2 class="compat-alt__heading" id="compat-alt-heading">Our compatible version<\/h2>/);
    assert.match(html, /TN2030BK Compatible Toner Cartridge for Brother TN2030\/TN2250 Black/);
    assert.match(html, /\$24\.49/);
    assert.match(html, />1,000 pages</);
    assert.match(html, /href="\/products\/tn2030bk-compatible-toner-cartridge-for-brother-tn2030tn2250-black\/CTN2030BK"/);
    assert.match(html, /data-compat-add data-sku="CTN2030BK"/);
    assert.match(html, /Compatible cartridges are covered by our 30-day satisfaction guarantee\./);
    assert.doesNotMatch(html, /capacity/, 'same capacity ⇒ no capacity line');
});

test('§16 G604BK: C604XLBK labelled "XL — higher capacity"; a lower tier says "lower"; an unknown direction is never guessed', () => {
    const self = pdpSelf();
    assert.match(self.compatibleAlternativesHtml({ source: 'genuine', yield_tier: 'STD', compatible_alternatives: [C604XLBK] }), />XL — higher capacity</);
    assert.equal(self.capacityLabel('XL', 'STD'), 'XL — higher capacity');
    assert.equal(self.capacityLabel('XXL', 'XL'), 'XXL — higher capacity');
    assert.equal(self.capacityLabel('STD', 'XL'), 'Standard — lower capacity');
    assert.equal(self.capacityLabel('XL', null), 'XL capacity', 'genuine tier unknown ⇒ no direction claimed');
    assert.equal(self.capacityLabel('HY', 'STD'), 'HY capacity');
    assert.equal(self.capacityLabel('', 'STD'), '');
});

test('§16 no box: a compatible PDP, a genuine PDP with the field absent (G924CMY), empty, or only malformed rows', () => {
    const self = pdpSelf();
    assert.equal(self.compatibleAlternativesHtml({ source: 'compatible', compatible_alternatives: [CTN2030BK] }), '');
    assert.equal(self.compatibleAlternativesHtml({ source: 'genuine' }), '');
    assert.equal(self.compatibleAlternativesHtml({ source: 'genuine', compatible_alternatives: [] }), '');
    assert.equal(self.compatibleAlternativesHtml({ source: 'genuine', compatible_alternatives: [{ sku: 'X' }, { ...CTN2030BK, retail_price: 0 }, null] }), '');
    assert.equal(self.compatibleAlternativesHtml(null), '');
});

test('§16 at most 3, plural heading; out of stock ⇒ no Add; missing warranty ⇒ no line; page_yield shapes', () => {
    const self = pdpSelf();
    const rows = [CTN2030BK, { ...CTN2030BK, sku: 'B' }, { ...CTN2030BK, sku: 'C', in_stock: false }, { ...CTN2030BK, sku: 'D' }];
    const html = self.compatibleAlternativesHtml({ source: 'genuine', compatible_alternatives: rows });
    assert.equal((html.match(/<li class="compat-alt__item"/g) || []).length, 3);
    assert.match(html, /Our compatible versions/);
    assert.match(html, /data-sku="C"><img[\s\S]*?Out of stock/);
    assert.doesNotMatch(html, /data-compat-add data-sku="C"/);
    assert.doesNotMatch(html, /compat-alt__note/);
    assert.equal(self.pageYieldText('1,000'), '1,000 pages');
    assert.equal(self.pageYieldText(2500), '2,500 pages');
    assert.equal(self.pageYieldText(''), '');
    assert.equal(self.pageYieldText(null), '');
    assert.equal(self.pageYieldText('approx 1000'), '', 'free text is not a yield');
});

test('§16 every field is escaped and the image URL sanitised', () => {
    const evil = { ...CTN2030BK, name: '<img src=x onerror=alert(1)>', sku: 'A"B', slug: 's"/x', image_url: 'javascript:alert(1)' };
    const html = pdpSelf().compatibleAlternativesHtml({ source: 'genuine', compatible_alternatives: [evil], trust_signals: { warranty: { compatible_label: '<b>x</b>' } } });
    assert.doesNotMatch(html, /<img src=x/);
    assert.doesNotMatch(html, /<b>x<\/b>/);
    assert.doesNotMatch(html, /javascript:/);
    assert.match(html, /data-sku="A&quot;B"/);
    assert.match(html, /href="\/products\/s%22%2Fx\/A%22B"/);
});

test('§16 wording (invariant 13): prices and yields only — no save / % / "same quality" / "as good as", no OEM tile', () => {
    const self = pdpSelf();
    const html = self.compatibleAlternativesHtml({ source: 'genuine', yield_tier: 'STD', compatible_alternatives: [CTN2030BK, C604XLBK], trust_signals: WARRANTY });
    const text = html.replace(/<[^>]+>/g, ' ');
    assert.doesNotMatch(text, /\bsav(e|es|ing|ings)\b|%|same quality|as good as|cheaper|lowest|best/i, text);
    const src = extractMethod(read(PDP), 'compatibleAlternativesHtml').body;
    assert.doesNotMatch(src, /BrandSource|genuine-tile/, 'no OEM tile on a compatible card');
});

test('§16 the section sits UNDER Add and the fit line, above the terms; Add resolves the SKU and is LOUD on a miss', () => {
    const html = read('html/product/index.html');
    const at = (s) => html.indexOf(s);
    assert.ok(at('id="add-to-cart-btn"') < at('id="product-promise"'));
    assert.ok(at('id="product-promise"') < at('id="compatible-alternatives"'));
    assert.ok(at('id="compatible-alternatives"') < at('id="product-terms"'));
    assert.match(html, /<section class="compat-alt" id="compatible-alternatives" data-testid="compatible-alternatives" hidden aria-labelledby="compat-alt-heading"><\/section>/);
    const pdp = stripComments(read(PDP));
    assert.match(pdp, /this\.renderPromise\(info\);\s*this\.renderCompatibleAlternatives\(info\);/);
    const add = extractMethod(read(PDP), 'addCompatibleAlternative').body;
    assert.match(add, /await API\.getProduct\(sku\)/);
    assert.match(add, /if \(!d \|\| !d\.id \|\| typeof Cart === 'undefined'\) \{\s*if \(typeof showToast === 'function'\) showToast\(/);
    assert.match(add, /product_source: d\.source \|\| 'compatible'/);
});

test('§16 Add: SKU resolved to an id, added once; a lookup miss toasts and resets', async () => {
    const added = [];
    const toasts = [];
    const btn = { dataset: { sku: 'CTN2030BK', name: 'n', price: '24.49', image: '' }, disabled: false, textContent: 'Add' };
    const globals = {
        API: { getProduct: async (sku) => ({ ok: true, data: { id: 'f164e513', sku, name: 'CTN', retail_price: 24.49, source: 'compatible', stock_quantity: 100, brand: { name: 'Brother' } } }) },
        Cart: { addItem: async (p) => { added.push(p); return { ok: true }; } },
        showToast: (m) => toasts.push(m), DebugLog: { warn() {} },
    };
    await method(PDP, 'addCompatibleAlternative', {}, globals)(btn);
    assert.equal(added.length, 1);
    assert.equal(added[0].id, 'f164e513');
    assert.equal(added[0].quantity, 1);
    assert.equal(added[0].brand, 'Brother');
    assert.equal(added[0].stock_quantity, 100);
    assert.equal(btn.textContent, 'Added!');

    const btn2 = { dataset: { sku: 'GONE' }, disabled: false, textContent: 'Add' };
    await method(PDP, 'addCompatibleAlternative', {}, { ...globals, API: { getProduct: async () => ({ ok: false, code: 'NOT_FOUND' }) } })(btn2);
    assert.equal(toasts.length, 1);
    assert.match(toasts[0], /Couldn.t add this item/);
    await sleep(5);
    assert.equal(btn2.disabled, false);
    assert.equal(btn2.textContent, 'Add');
});

// ═══ §2 cart wallet ON ═══════════════════════════════════════════════════════

// The wallet decided ONCE at load: a cart filled after load (the /cart?add=
// reorder link) stayed at none/no-server-total all visit. Measured on www,
// 6 Oct 23:30 NZT, right after it went live for every shopper.
const CartWallet = require(path.join(ROOT, 'inkcartridges/js/cart-wallet.js'));
function walletWith(state, why, { items = 1, summary = { subtotal: 67.49, discount: 0, shipping: 7, qualifies_for_free_shipping: false }, ece = null, device = true, amount } = {}) {
    const w = Object.create(CartWallet);
    const calls = { init: 0, update: [] };
    Object.assign(w, {
        state, why, ece, _deviceHasWallet: device, _amount: amount,
        elements: ece ? { update: (o) => calls.update.push(o.amount) } : null,
        _items: () => Array.from({ length: items }, () => ({ product_id: 'p', quantity: 1 })),
        _summary: () => summary,
        _setState(s2, y) { this.state = s2; this.why = y || ''; },
        init() { calls.init++; },
    });
    return { w, calls };
}

test('§2 CartWallet.sync: a cart filled AFTER load mounts the wallet once a server total exists', () => {
    let { w, calls } = walletWith('none', 'no-server-total');
    w.sync();
    assert.equal(calls.init, 1, 'never mounted + now eligible ⇒ init');
    ({ w, calls } = walletWith('none', 'no-server-total', { items: 0 }));
    w.sync();
    assert.equal(calls.init, 0, 'still empty ⇒ nothing');
    ({ w, calls } = walletWith('none', 'no-wallet-on-device'));
    w.sync();
    assert.equal(calls.init, 0, 'a device without a wallet is not retried');
    for (const st of ['off', 'loading', 'error']) {
        ({ w, calls } = walletWith(st, ''));
        w.sync();
        assert.equal(calls.init, 0, st);
    }
});

test('§2 CartWallet.sync: a mounted wallet follows the CURRENT total, and hides when the cart empties', () => {
    let { w, calls } = walletWith('ready', '', { ece: {}, amount: 7449 });
    w._summary = () => ({ subtotal: 202.47, discount: 4.05, shipping: 0, qualifies_for_free_shipping: true });
    w.sync();
    assert.deepEqual(calls.update, [19842], 'qty 3: $198.42 in cents');
    w.sync();
    assert.deepEqual(calls.update, [19842], 'unchanged ⇒ no second update');
    ({ w, calls } = walletWith('ready', '', { ece: {}, items: 0, amount: 7449 }));
    w.sync();
    assert.equal(w.state, 'none');
    ({ w, calls } = walletWith('none', 'no-server-total', { ece: {}, amount: 0 }));
    w.sync();
    assert.equal(w.state, 'ready', 'mounted earlier, refilled ⇒ shown again');
});

test('§2 the cart calls CartWallet.sync from the settled-summary hook (both renderers end there)', () => {
    const code = stripComments(CART_SRC);
    assert.ok(/if \(!pending\) \{\s*if \(typeof CartWallet !== 'undefined' && typeof CartWallet\.sync === 'function'\) \{\s*try \{ CartWallet\.sync\(\); \}/.test(code));
});

test('§2 the cart wallet ships ON (owner, 6 Oct)', () => {
    assert.match(stripComments(read('js/config.js')), /cartWallet: true,/);
});
