/**
 * printer_slug — from the printer page to the order payload (Aug 2026)
 * ====================================================================
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Which printer ecosystem a customer belongs to is only derivable server-side
 * through `product_compatibility`, which is many-to-many BY DESIGN — one
 * cartridge fits dozens of printers, so the answer is genuinely ambiguous. The
 * frontend has held the unambiguous answer all along and threw it away: the
 * chain ink-finder → /shop?printer_slug= → PDP ?printer_slug= existed, the PDP
 * even read the slug for its "bought for this printer" proof line, and then
 * `Cart.addItem` was called without it.
 *
 * THE RULE
 * --------
 * **Send it only when you actually know it.** An unresolvable slug records
 * nothing; a GUESSED one corrupts the printer-ecosystem analysis the field
 * exists to enable, and a wrong ecosystem is not a smaller version of the truth.
 * Never derived from a brand, a `printer_model` free-text param, a compatibility
 * list, or a product name.
 *
 * THE TWO TRAPS, BOTH OF WHICH SILENTLY DELETE THE FIELD
 * -----------------------------------------------------
 * 1. `_parseServerCart` rebuilds every cart line from scratch out of the server
 *    row, and the server cart has NO printer column. `addItem` calls
 *    `loadFromServer()` on itself, so a field written only onto the line is gone
 *    milliseconds after it is set — and would look correct in any test that did
 *    not round-trip. That is the ERR-150 whitelist trap.
 * 2. `payment-page.js` `calculateTotals()` re-projects `cartItems` into a
 *    narrower shape on every call, stripping anything it does not name —
 *    seconds before the order POST.
 *
 * Run: node --test tests/printer-slug-order-plumbing-aug2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const INK = path.join(ROOT, 'inkcartridges');
const JS = (rel) => fs.readFileSync(path.join(INK, 'js', rel), 'utf8');

const PrinterContext = require(path.join(INK, 'js', 'printer-context.js'));

/** Fresh in-memory localStorage for each case; the module reads global localStorage. */
function withStorage(fn) {
    const store = {};
    const prev = global.localStorage;
    global.localStorage = {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: (k) => { delete store[k]; },
    };
    try { return fn(store); } finally { global.localStorage = prev; }
}

// ─────────────────────────────────────────────────────────────────────────
// §1  normalize — the "do we actually know it" gate
// ─────────────────────────────────────────────────────────────────────────

test('§1 a real slug passes', () => {
    assert.equal(PrinterContext.normalize('brother-mfc-j5740dw'), 'brother-mfc-j5740dw');
    assert.equal(PrinterContext.normalize('  hp-officejet-pro-9720  '), 'hp-officejet-pro-9720');
    assert.equal(PrinterContext.normalize('canon-ts3160'), 'canon-ts3160');
});

test('§1 anything that is not a slug is null — never repaired into one', () => {
    ['Brother MFC-J5740DW', 'BROTHER-MFC', 'brother_mfc', 'brother--mfc', '-brother',
     'brother-', '', '   ', null, undefined, 42, {}, 'a'.repeat(121)].forEach((v) => {
        assert.equal(PrinterContext.normalize(v), null, `expected null for ${JSON.stringify(v)}`);
    });
});

// ─────────────────────────────────────────────────────────────────────────
// §2  fromLocation — the page's own scope, and nothing else
// ─────────────────────────────────────────────────────────────────────────

test('§2 ?printer_slug= is read; ?printer_model= and ?printer_brand= are NOT', () => {
    assert.equal(PrinterContext.fromLocation('?printer_slug=brother-mfc-j5740dw'), 'brother-mfc-j5740dw');
    assert.equal(PrinterContext.fromLocation('?brand=hp&printer_slug=hp-envy-6020'), 'hp-envy-6020');
    // These two are in the shop's URL vocabulary and are NOT slugs. Reading them
    // here is exactly the guess this module exists to prevent.
    assert.equal(PrinterContext.fromLocation('?printer_model=MFC-J5740DW'), null);
    assert.equal(PrinterContext.fromLocation('?printer_brand=brother'), null);
    assert.equal(PrinterContext.fromLocation(''), null);
});

// ─────────────────────────────────────────────────────────────────────────
// §3  remember / slugFor, including ambiguity
// ─────────────────────────────────────────────────────────────────────────

test('§3 a remembered slug comes back for its line key', () => withStorage(() => {
    PrinterContext.remember('core:LC3319BK', 'brother-mfc-j5740dw');
    assert.equal(PrinterContext.slugFor('core:LC3319BK'), 'brother-mfc-j5740dw');
    assert.equal(PrinterContext.slugFor('core:OTHER'), null);
}));

test('§3 the SAME slug twice is not ambiguity', () => withStorage(() => {
    PrinterContext.remember('core:A', 'hp-envy-6020');
    PrinterContext.remember('core:A', 'hp-envy-6020');
    assert.equal(PrinterContext.slugFor('core:A'), 'hp-envy-6020');
}));

test('§3 a DIFFERENT slug for the same line makes it ambiguous — and it stays that way', () => withStorage(() => {
    // Two answers is not more information than one; it is a coin toss with a
    // database row attached.
    PrinterContext.remember('core:A', 'hp-envy-6020');
    PrinterContext.remember('core:A', 'brother-mfc-j5740dw');
    assert.equal(PrinterContext.slugFor('core:A'), null);
    // …and a later re-add of one of them must not "resolve" it.
    PrinterContext.remember('core:A', 'hp-envy-6020');
    assert.equal(PrinterContext.slugFor('core:A'), null);
}));

test('§3 a null slug never clears an answer we already had', () => withStorage(() => {
    // Arriving at a line from a printer-less page does not un-know the printer.
    PrinterContext.remember('core:A', 'hp-envy-6020');
    PrinterContext.remember('core:A', null);
    PrinterContext.remember('core:A', '');
    assert.equal(PrinterContext.slugFor('core:A'), 'hp-envy-6020');
}));

test('§3 an expired annotation is null, not stale', () => withStorage((store) => {
    const old = Date.now() - (PrinterContext.TTL_MS + 1000);
    store[PrinterContext.STORAGE_KEY] = JSON.stringify({ 'core:A': { slug: 'hp-envy-6020', ambiguous: false, at: old } });
    assert.equal(PrinterContext.slugFor('core:A'), null);
}));

test('§3 storage that throws degrades to "unknown", never to a crash', () => {
    const prev = global.localStorage;
    global.localStorage = {
        getItem() { throw new Error('blocked'); },
        setItem() { throw new Error('blocked'); },
    };
    try {
        assert.doesNotThrow(() => PrinterContext.remember('core:A', 'hp-envy-6020'));
        assert.equal(PrinterContext.slugFor('core:A'), null);
    } finally { global.localStorage = prev; }
});

// ─────────────────────────────────────────────────────────────────────────
// §4  applyTo — surviving the server round-trip
// ─────────────────────────────────────────────────────────────────────────

test('§4 re-attaches the slug to lines the server rebuilt', () => withStorage(() => {
    PrinterContext.remember('core:LC3319BK', 'brother-mfc-j5740dw');
    // Exactly what _parseServerCart produces: a fresh object with no printer field.
    const parsed = [{ key: 'core:LC3319BK', sku: 'LC3319BK' }, { key: 'core:GLC3333M', sku: 'GLC3333M' }];
    PrinterContext.applyTo(parsed);
    assert.equal(parsed[0].printer_slug, 'brother-mfc-j5740dw');
    assert.equal(parsed[1].printer_slug, undefined, 'a line we know nothing about stays bare');
}));

// ─────────────────────────────────────────────────────────────────────────
// §5  orderLevel — the "single-printer cart" rule
// ─────────────────────────────────────────────────────────────────────────

test('§5 exactly one distinct known slug → that slug', () => {
    assert.equal(PrinterContext.orderLevel([
        { printer_slug: 'hp-envy-6020' },
        { printer_slug: 'hp-envy-6020' },
        { },
    ]), 'hp-envy-6020');
});

test('§5 zero known slugs → null', () => {
    assert.equal(PrinterContext.orderLevel([{}, {}]), null);
    assert.equal(PrinterContext.orderLevel([]), null);
});

test('§5 TWO printers → null, never a majority vote', () => {
    // The backend applies the order-level value to every line lacking its own,
    // so picking either would attribute lines to a printer they were not bought
    // for. "Most common" is a guess with arithmetic in front of it.
    assert.equal(PrinterContext.orderLevel([
        { printer_slug: 'hp-envy-6020' },
        { printer_slug: 'hp-envy-6020' },
        { printer_slug: 'brother-mfc-j5740dw' },
    ]), null);
});

test('§5 a malformed slug on a line cannot become the order-level value', () => {
    assert.equal(PrinterContext.orderLevel([{ printer_slug: 'Brother MFC' }]), null);
});

// ─────────────────────────────────────────────────────────────────────────
// §6  The wiring — every place the field could silently die
// ─────────────────────────────────────────────────────────────────────────

test('§6 Cart.addItem records it, and never lets it into the composite key', () => {
    const cart = JS('cart.js');
    assert.ok(cart.includes('PrinterContext.remember(key, printerSlug)'));
    // ERR-136 / the `source` warning: re-keying a line orphans the pending-op
    // journal and the localStorage rows. The same cartridge bought for two
    // printers is ONE cart line.
    const keyFn = cart.slice(cart.indexOf('cartItemKey:'), cart.indexOf('cartItemKey:') + 400);
    assert.ok(!/printer/i.test(keyFn), 'printer_slug must not be part of cartItemKey');
});

test('§6 an explicit slug wins over the page URL, and the URL is the fallback', () => {
    const cart = JS('cart.js');
    assert.ok(/PrinterContext\.normalize\(product\.printer_slug\)\s*\|\|\s*PrinterContext\.fromLocation\(\)/.test(cart));
});

test('§6 _parseServerCart re-attaches it (trap 1)', () => {
    const cart = JS('cart.js');
    const idx = cart.indexOf('parsed.key = self.cartItemKey(parsed);');
    assert.notEqual(idx, -1);
    const after = cart.slice(idx, idx + 700);
    assert.ok(after.includes('PrinterContext.slugFor(parsed.key)'),
        'without this the field dies on the loadFromServer() that addItem calls on itself');
});

test('§6 the payment page projection carries it (trap 2)', () => {
    const pay = JS('payment-page.js');
    const idx = pay.indexOf('this.cartItems = cartData.items.map(item => ({');
    assert.notEqual(idx, -1);
    assert.ok(pay.slice(idx, idx + 1200).includes('printer_slug'),
        'calculateTotals() re-projects cartItems on every call and strips what it does not name');
});

test('§6 BOTH order payload builders send it — per item and order level', () => {
    const pay = JS('payment-page.js');
    // Stripe and PayPal are near-verbatim duplicates and must change together.
    const perItem = (pay.match(/withPrinterSlug\(\{/g) || []).length;
    assert.equal(perItem, 2, 'expected the Stripe and PayPal item maps to both use the helper');
    // The leading `.` keeps the method DEFINITION out of the count.
    const orderLevel = (pay.match(/\.orderLevelPrinterSlug\(items\)/g) || []).length;
    assert.equal(orderLevel, 2, 'expected both order payloads to spread the order-level value');
});

test('§6 the capture sites pass what they genuinely know', () => {
    assert.ok(/printer_slug: this\._printerSlug \|\| null/.test(JS('product-detail-page.js')),
        'the PDP already read ?printer_slug= for its proof line and then dropped it');
    assert.ok(/printer_slug: \(this\.state && this\.state\.printer\) \|\| null/.test(JS('shop-page.js')));
});

test('§6 an unknown printer omits the key entirely — never printer_slug: null', () => {
    const pay = JS('payment-page.js');
    const helper = pay.slice(pay.indexOf('withPrinterSlug(line, cartItem) {'));
    const body = helper.slice(0, helper.indexOf('\n        },'));
    assert.ok(/if \(slug\) line\.printer_slug = slug;/.test(body));
    assert.ok(!/line\.printer_slug = null/.test(body),
        'an absent key says "we do not know"; an explicit null invites a reader to think the ' +
        'printer was cleared');
});
