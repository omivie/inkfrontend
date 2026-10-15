/**
 * /cart summary cleanup (owner 2026-10-15, ERR-342):
 *  - the summary scrolls with the page (never sticky);
 *  - the delivery estimate + dispatch countdown sit ABOVE the summary, beside
 *    the "Cart" title, so Subtotal starts level with the first cart line;
 *  - "Add company or PO number" is gone — the "Download PDF quote" button opens
 *    a popup with those fields, and only its submit downloads;
 *  - the points balance chip sits directly under "Points to be earned", and
 *    the trust pills directly under that chip.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', 'inkcartridges');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const HTML = read('html/cart.html');
const CSS = read('css/cart-checkout.css');

const asideOf = (html) => html.slice(html.indexOf('<aside class="cart-summary">'), html.indexOf('</aside>', html.indexOf('<aside class="cart-summary">')));

test('summary is not sticky on /cart', () => {
    assert.match(CSS, /\/\* Summary: a plain column[^*]*\*\/\n\.cart-page \.cart-summary \{\n    position: static;/);
});

test('delivery + dispatch live outside the summary, in grid row 1 beside the title', () => {
    const aside = asideOf(HTML);
    for (const id of ['cart-delivery', 'cart-dispatch-countdown']) {
        assert.ok(!aside.includes(`id="${id}"`), `${id} must not be inside the summary`);
    }
    const wrap = HTML.slice(HTML.indexOf('<div class="cart-assurance"'));
    assert.ok(HTML.indexOf('<div class="cart-assurance"') > HTML.indexOf('</aside>', HTML.indexOf('<aside class="cart-summary">')), 'wrapper follows the aside (phone order)');
    // .cart-dispatch's negative top margin assumes it directly follows .cart-delivery.
    assert.match(wrap, /id="cart-delivery" hidden><\/div>\s*<!--[\s\S]*?-->\s*<p class="cart-dispatch" id="cart-dispatch-countdown"/);
    assert.ok(!wrap.includes('id="cart-trust-signals"'), 'trust pills moved into the summary');
    assert.match(CSS, /#cart-layout > \.cart-assurance \{ grid-column: 2; grid-row: 1; align-self: end; \}/);
    assert.match(CSS, /@media \(max-width: 1024px\) \{\s*section\.cart-page #cart-layout > \.cart-assurance \{ order: -1; \}/);
});

test('points balance chip under "Points to be earned", trust pills under the chip', () => {
    const aside = asideOf(HTML);
    assert.match(aside, /id="cart-points-earn-value"><\/strong><\/p>\s*<\/div>\s*<!--[\s\S]*?-->\s*<div class="cart-summary__loyalty-chip" id="cart-loyalty-chip" hidden><\/div>/);
    assert.equal(HTML.split('id="cart-loyalty-chip"').length, 2, 'exactly one chip');
    // Trust pills directly under the balance chip, inside the summary (owner 2026-10-15 follow-up).
    assert.match(aside, /id="cart-loyalty-chip" hidden><\/div>\s*<!--[\s\S]*?-->\s*<div class="cart-trust-signals" id="cart-trust-signals" hidden><\/div>/);
    assert.equal(HTML.split('id="cart-trust-signals"').length, 2, 'exactly one trust-signals box');
});

// Minimal fake DOM: enough for QuotePdf.mount to wire its listeners.
function mountQuote() {
    const handlers = new Map();
    const node = (key, extra = {}) => Object.assign({
        dataset: {}, hidden: true, disabled: false, textContent: '',
        setAttribute() {}, removeAttribute() {},
        addEventListener(type, fn) { handlers.set(`${key}:${type}`, fn); },
    }, extra);
    const inputs = { company: { value: 'Acme Ltd' }, attention: { value: '' }, reference: { value: 'PO-7' } };
    const dialog = node('dialog', { open: false, showModal() { this.open = true; }, close() { this.open = false; } });
    const form = node('form', { querySelector: (sel) => inputs[/name="(\w+)"/.exec(sel)[1]] });
    const parts = {
        '.quote-pdf__button': node('button'), '.quote-pdf__dialog': dialog, '.quote-pdf__form': form,
        '.quote-pdf__status': node('status'), '.quote-pdf__cancel': node('cancel'),
    };
    const el = { dataset: {}, innerHTML: '', getAttribute: () => 'cart', querySelector: (s) => parts[s] };
    const ctx = { window: undefined, URLSearchParams, console };
    vm.runInNewContext(read('js/cart-quote-pdf.js') + '\nthis.QuotePdf = QuotePdf;', ctx);
    const calls = [];
    ctx.QuotePdf.download = async (header, zone) => { calls.push({ header, zone }); return { ok: true, name: 'q.pdf' }; };
    ctx.QuotePdf.mount(el);
    return { el, dialog, handlers, calls, status: parts['.quote-pdf__status'] };
}

test('quote: no disclosure; the button opens a dialog and only submit downloads', async () => {
    const js = read('js/cart-quote-pdf.js');
    assert.ok(!/quote-pdf__details|Add company or PO number<\/span>/.test(js));
    assert.ok(!/quote-pdf__details/.test(CSS));

    const { el, dialog, handlers, calls, status } = mountQuote();
    assert.match(el.innerHTML, /<dialog class="quote-pdf__dialog"/);
    assert.match(el.innerHTML, /<form method="dialog"/);
    assert.ok(!/<details/.test(el.innerHTML));

    handlers.get('button:click')();
    assert.equal(dialog.open, true, 'button opens the popup');
    assert.equal(calls.length, 0, 'opening must not download');

    handlers.get('cancel:click')();
    assert.equal(dialog.open, false);
    assert.equal(calls.length, 0, 'cancel must not download');

    handlers.get('button:click')();
    await handlers.get('form:submit')({ preventDefault() {} });
    assert.equal(dialog.open, false, 'submit closes the popup');
    assert.equal(calls.length, 1);
    assert.deepEqual({ ...calls[0].header }, { company: 'Acme Ltd', attention: '', reference: 'PO-7' });
    assert.equal(calls[0].zone, null);
    assert.equal(status.dataset.state, 'ok');
});
