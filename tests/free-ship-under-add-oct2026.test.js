/**
 * ERR-330 (owner, 13 Oct 2026)
 * ============================
 * 1. /shop: the "Free shipping on orders over $100 • Fast NZ-wide delivery"
 *    pill next to the jump button is REMOVED. Never re-add it.
 * 2. PDP: the free-shipping line moves from the bottom of the buy column
 *    (#product-value-lines) to its own green line directly under Add to Cart
 *    (#product-free-ship). Text comes ONLY from /api/site/value-props;
 *    absent or inactive threshold => the line stays hidden (no default text).
 *
 * renderValueLines is EXECUTED against a fake DOM, not grepped.
 *
 * Run with: node --test tests/free-ship-under-add-oct2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', 'inkcartridges');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const SHOP_HTML = read('html/shop.html');
const PDP_HTML = read('html/product/index.html');
const PDP_JS = read('js/product-detail-page.js');
const PAGES_CSS = read('css/pages.css');
const LAYOUT_CSS = read('css/layout.css');

const Security = { escapeHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'), escapeAttr: (s) => String(s).replace(/"/g, '&quot;') };

function extractMethod(src, name) {
    const re = new RegExp(`\\n\\s+(?:async\\s+)?${name}\\s*\\(([^)]*)\\)\\s*\\{`);
    const m = re.exec(src);
    assert.ok(m, `${name}() must exist`);
    const open = m.index + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) return { params: m[1], body: src.slice(open, i + 1) }; }
    }
    throw new Error(`unbalanced ${name}`);
}

/** Run renderValueLines with a stubbed ValueProps result; returns the two elements. */
async function render(vpResult, info = {}) {
    const els = {
        'product-value-lines': { hidden: true, innerHTML: '', dataset: {} },
        'product-free-ship': { hidden: true, innerHTML: '' },
    };
    const ValueProps = {
        load: async () => vpResult,
        freeShipping: (d) => (d && d.free_shipping && d.free_shipping.active && d.free_shipping.threshold > 0 ? d.free_shipping : null),
    };
    const ctx = vm.createContext({ Security, ValueProps, document: { getElementById: (id) => els[id] || null } });
    const { params, body } = extractMethod(PDP_JS, 'renderValueLines');
    const fn = vm.runInContext(`(async function (${params}) ${body})`, ctx);
    await fn.call({ validRewardPoints: () => null, syncPointsLine() {} }, info);
    return els;
}

const VP_ON = { ok: true, data: { free_shipping: { active: true, threshold: 100, headline: 'Free shipping on orders over $100' } } };

test('/shop: the shipping pill is gone (owner, ERR-330 — never re-add)', () => {
    assert.doesNotMatch(SHOP_HTML, /shipping-info-bar|Fast NZ-wide delivery/);
    assert.doesNotMatch(PAGES_CSS, /\.shipping-info-bar/);
    assert.doesNotMatch(LAYOUT_CSS, /\.shipping-info-bar/);
});

test('PDP: #product-free-ship sits right after the Add row, before the fit promise, and ships hidden', () => {
    const actions = PDP_HTML.indexOf('class="product-info__actions"');
    const ship = PDP_HTML.indexOf('id="product-free-ship"');
    const promise = PDP_HTML.indexOf('id="product-promise"');
    assert.ok(actions !== -1 && actions < ship && ship < promise, 'order: actions, free-ship, promise');
    assert.match(PDP_HTML, /<p class="product-free-ship" id="product-free-ship"[^>]*hidden><\/p>/);
    assert.match(PAGES_CSS, /\.product-free-ship\[hidden\] \{ display: none; \}/);
});

test('renderValueLines: headline verbatim (escaped) in #product-free-ship, never in #product-value-lines', async () => {
    const els = await render(VP_ON);
    assert.equal(els['product-free-ship'].hidden, false);
    assert.match(els['product-free-ship'].innerHTML, /<span>Free shipping on orders over \$100<\/span>/);
    assert.doesNotMatch(els['product-value-lines'].innerHTML, /shipping/i);

    const xss = await render({ ok: true, data: { free_shipping: { active: true, threshold: 100, headline: '<b>x</b>' } } });
    assert.match(xss['product-free-ship'].innerHTML, /&lt;b&gt;x&lt;\/b&gt;/);
});

test('renderValueLines: inactive, absent or failed value-props => line hidden and empty (no default)', async () => {
    for (const vp of [
        { ok: true, data: { free_shipping: { active: false, threshold: 100, headline: 'Free shipping on orders over $100' } } },
        { ok: true, data: {} },
        { ok: false, error: 'network' },
        { ok: true, data: { free_shipping: { active: true, threshold: 100, headline: '   ' } } },
    ]) {
        const els = await render(vp);
        assert.equal(els['product-free-ship'].hidden, true, JSON.stringify(vp));
        assert.equal(els['product-free-ship'].innerHTML, '');
    }
});
