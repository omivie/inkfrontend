/**
 * Customer receipt PDF (Jul 2026)
 * ===============================
 *
 * Pins `js/order-receipt.js` — the downloadable receipt a retail customer gets
 * from /order-confirmation and /account/order-detail.
 *
 * BACKGROUND. A backend handoff asked us to add the loyalty points-earned line
 * to "the customer-facing downloadable invoice PDF". No such PDF existed: jsPDF
 * was loaded only on /admin and the only builder was buildInvoiceDoc(), which
 * renders the operator's B2B tax invoice. This module is what made the ask real.
 *
 * These tests run the REAL builder against a recording fake jsPDF, so they
 * assert behaviour rather than grepping source. The three contracts that matter,
 * and which the admin builder violates:
 *
 *   1. NOTHING IS EVER DRAWN OFF THE PAGE. buildInvoiceDoc walks a y cursor with
 *      no bound check, so on a long order the totals silently vanish below A4's
 *      841.89 pt. Tested directly by driving the items table to the bottom of the
 *      page and asserting the totals move to a new page.
 *   2. THE DOC IS RE-ANCHORED AFTER autoTable. autoTable paginates itself but
 *      leaves the "current page" where it started, so without setPage() the
 *      totals land on page 1 under a multi-page table.
 *   3. EVERY STRING IS cp1252-SAFE. jsPDF's built-in fonts are WinAnsi; U+2248
 *      ("≈") is not in cp1252 and corrupts or vanishes silently.
 *
 * Run with: node --test tests/order-receipt-jul2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', 'inkcartridges');
const JS = (rel) => fs.readFileSync(path.join(ROOT, 'js', rel), 'utf8');
const HTML = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Cross-realm copy: vm-context objects have that realm's prototypes. */
const plain = (v) => JSON.parse(JSON.stringify(v));

/** Assert on CODE, not prose — a docblock mentioning 841.89 is not a violation. */
const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 48;

const LEGAL_CONFIG = {
    tradingName: 'InkCartridges.co.nz',
    legalEntity: 'Office Consumables Ltd',
    gstNumber: '94-509-459',
    nzbn: '9429033934204',
    email: 'support@inkcartridges.co.nz',
    phoneDisplay: '027 474 0115',
    address: { street: '37A Archibald Road', suburb: 'Kelston', city: 'Auckland', postcode: '0602', country: 'New Zealand' }
};

/**
 * A fake jsPDF that records every draw. `tableFinalY` lets a test place the
 * items table anywhere on the page, including right at the bottom edge, which is
 * how the overflow contract gets exercised.
 */
/** Adobe standard-14 AFM widths (per 1000 em) for the two Times faces in use. */
const TIMES_BOLD = { A: 722, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 778, I: 389, J: 500, K: 778, L: 667, M: 944, N: 722, O: 778, P: 611, Q: 778, R: 722, S: 556, T: 667, U: 722, V: 722, W: 1000, X: 722, Y: 722, Z: 667, '-': 333, ' ': 250, '.': 250, ',': 250, $: 500, '#': 500 };
const TIMES_ROMAN = { A: 722, B: 667, C: 667, D: 722, E: 611, F: 556, G: 722, H: 722, I: 333, J: 389, K: 722, L: 611, M: 889, N: 722, O: 722, P: 556, Q: 722, R: 667, S: 556, T: 611, U: 722, V: 722, W: 944, X: 722, Y: 722, Z: 611, '-': 333, ' ': 250, '.': 250, ',': 250, $: 500, '#': 500 };
for (let d = 0; d <= 9; d++) { TIMES_BOLD[String(d)] = 500; TIMES_ROMAN[String(d)] = 500; }

function makeFakeJsPdf(opts = {}) {
    const calls = { text: [], addPage: 0, setPage: [], save: [], lines: [], autoTable: [] };

    function Doc() {
        this.currentPage = 1;
        this.pageCount = 1;
        this.lastAutoTable = null;
        const self = this;
        this.internal = {
            pageSize: { getWidth: () => PAGE_W, getHeight: () => PAGE_H },
            getNumberOfPages: () => self.pageCount
        };
    }
    Doc.prototype.setFont = function (_family, style) { this.fontStyle = style || 'normal'; return this; };
    Doc.prototype.setFontSize = function (n) { this.fontSize = n; return this; };
    /**
     * Real Times metrics, because the builder now MEASURES (ERR-198).
     *
     * `buildReceiptDoc` seats the header meta labels a fixed gap clear of the
     * widest value via doc.getTextWidth(), the same way buildInvoiceDoc does
     * since ERR-196. A fake that returned a made-up number here would let the
     * geometry test pass while the real PDF overlapped, so these are the
     * Adobe standard-14 AFM widths (per 1000 em) that jsPDF actually draws
     * Times with — the same numbers the fix was measured against.
     */
    Doc.prototype.getTextWidth = function (s) {
        const t = this.fontStyle === 'bold' ? TIMES_BOLD : TIMES_ROMAN;
        return [...String(s)].reduce((a, c) => a + ((t[c] === undefined ? 500 : t[c]) / 1000), 0) * (this.fontSize || 12);
    };
    Doc.prototype.setTextColor = function () { return this; };
    Doc.prototype.setDrawColor = function () { return this; };
    Doc.prototype.setLineWidth = function () { return this; };
    Doc.prototype.line = function (x1, y1, x2, y2) {
        calls.lines.push({ page: this.currentPage, x1, y1, x2, y2 });
        return this;
    };
    Doc.prototype.text = function (s, x, y, opts) {
        // size/style/align are recorded so a test can reconstruct the box a string
        // actually occupies — without them "does the label overlap its value?"
        // cannot be asked at all, which is how the 110 pt pin survived (ERR-198).
        calls.text.push({
            page: this.currentPage, s: String(s), x, y,
            size: this.fontSize, style: this.fontStyle || 'normal',
            align: (opts && opts.align) || 'left',
        });
        return this;
    };
    Doc.prototype.splitTextToSize = function (s, width) {
        // Crude but deterministic wrap at ~5.2pt/char for the fonts in use.
        const perLine = Math.max(8, Math.floor(width / 5.2));
        const words = String(s).split(/\s+/).filter(Boolean);
        if (!words.length) return [''];
        const out = [];
        let line = '';
        for (const w of words) {
            if (line && (line + ' ' + w).length > perLine) { out.push(line); line = w; }
            else line = line ? line + ' ' + w : w;
        }
        if (line) out.push(line);
        return out;
    };
    Doc.prototype.addPage = function () {
        this.pageCount += 1;
        this.currentPage = this.pageCount;
        calls.addPage += 1;
        return this;
    };
    Doc.prototype.setPage = function (p) {
        this.currentPage = p;
        calls.setPage.push(p);
        return this;
    };
    Doc.prototype.autoTable = function (cfg) {
        calls.autoTable.push(cfg);
        // Simulate a table that paginates: each extra page bumps pageCount but
        // leaves currentPage where it was — exactly how real autoTable behaves,
        // which is the trap setPage() exists to close.
        const extraPages = opts.tablePages ? opts.tablePages - 1 : 0;
        this.pageCount += extraPages;
        this.lastAutoTable = { finalY: opts.tableFinalY !== undefined ? opts.tableFinalY : (cfg.startY + 90) };
        return this;
    };
    Doc.prototype.save = function (name) { calls.save.push(name); return this; };

    return { jsPDF: Doc, calls };
}

/** Load order-totals.js + order-receipt.js into one sandbox. */
function loadReceipt(opts = {}) {
    const fake = makeFakeJsPdf(opts);
    const toasts = [];
    const warnings = [];

    const sandbox = {
        console, Math, JSON, Number, String, Array, Object, Date, RegExp, isNaN, Promise,
        jspdf: opts.noLib ? undefined : { jsPDF: fake.jsPDF },
        LegalConfig: opts.noLegalConfig ? undefined : LEGAL_CONFIG,
        formatPrice: (n) => '$' + Number(n).toFixed(2),
        DebugLog: { warn: (...a) => warnings.push(a.join(' ')), error: () => {}, log: () => {} },
        showToast: (msg, kind) => toasts.push({ msg, kind }),
        setTimeout: (fn, ms) => setTimeout(fn, ms),
        clearTimeout: (id) => clearTimeout(id),
        document: {
            // A stub that fires NEITHER onload nor onerror would hang the awaiting
            // caller forever — which is exactly the failure mode LOAD_TIMEOUT_MS
            // exists to bound, so it is modelled explicitly by scriptLoad:'stall'.
            head: {
                appendChild: (el) => {
                    const mode = opts.scriptLoad || 'error';
                    if (mode === 'stall') return;
                    setTimeout(() => {
                        if (mode === 'ok' && el.onload) el.onload();
                        else if (mode === 'error' && el.onerror) el.onerror();
                    }, 0);
                }
            },
            querySelector: () => null,
            createElement: () => ({ dataset: {}, addEventListener: () => {}, onload: null, onerror: null })
        }
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;

    const ctx = vm.createContext(sandbox);
    vm.runInContext(JS('order-totals.js'), ctx, { filename: 'order-totals.js' });
    vm.runInContext(JS('order-receipt.js'), ctx, { filename: 'order-receipt.js' });

    return { OrderReceipt: sandbox.OrderReceipt, OrderTotals: sandbox.OrderTotals, calls: fake.calls, toasts, warnings, sandbox };
}

const ORDER = {
    // A real interim-format number (matching this fixture's July date) rather
    // than the fabricated 'INK-10432' — a shape the backend has never minted,
    // and the wrong width to exercise the header geometry with (ERR-198).
    order_number: '20260728000001',
    created_at: '2026-07-28T02:00:00Z',
    customer_email: 'buyer@example.com',
    subtotal: 89.98,
    shipping_fee: 0,
    total: 84.98,
    loyalty_discount_amount: 5,
    loyalty_points_redeemed: 500,
    gst_amount: 11.08,
    shipping_address: {
        recipient_name: 'Jun Jackson', address_line1: '12 Example St',
        city: 'Auckland', region: 'Auckland', postal_code: '1010', country: 'New Zealand'
    },
    order_items: [
        { product_sku: 'CN-045', product_name: 'Canon 045 Black', quantity: 2, unit_price: 44.99, line_total: 89.98 }
    ]
};

const manyItems = (n) => Array.from({ length: n }, (_, i) => ({
    product_sku: `SKU-${i}`, product_name: `Product number ${i} with a fairly long description`,
    quantity: 1, unit_price: 10, line_total: 10
}));

// ─────────────────────────────────────────────────────────────────────────────
// Module surface + guard rails
// ─────────────────────────────────────────────────────────────────────────────

test('exposes ensureLib / build / download / attach on window.OrderReceipt', () => {
    const { OrderReceipt } = loadReceipt();
    assert.equal(typeof OrderReceipt.ensureLib, 'function');
    assert.equal(typeof OrderReceipt.build, 'function');
    assert.equal(typeof OrderReceipt.download, 'function');
    assert.equal(typeof OrderReceipt.attach, 'function');
});

test('jsPDF is LAZY-loaded — no storefront page carries a jspdf script tag', () => {
    // ~400 KB. It must never be on the critical path of a customer page. If
    // someone "fixes" a load bug by adding a script tag, this fails.
    for (const page of ['html/order-confirmation.html', 'html/account/order-detail.html']) {
        assert.doesNotMatch(HTML(page), /jspdf/i, `${page} must not eager-load jsPDF`);
    }
});

test('CDN versions match the admin shell so one jsPDF generation is in play', () => {
    const receipt = JS('order-receipt.js');
    const adminShell = HTML('html/admin/index.html');
    const version = receipt.match(/jspdf@([\d.]+)/);
    assert.ok(version, 'order-receipt.js must pin a jspdf version');
    assert.ok(adminShell.includes('jspdf@' + version[1]),
        `order-receipt.js pins jspdf@${version[1]} but the admin shell pins a different version`);
});

test('build() returns null when the lib is missing rather than throwing', () => {
    const { OrderReceipt } = loadReceipt({ noLib: true });
    assert.equal(OrderReceipt.build(ORDER), null);
});

test('build() refuses to render a receipt out of unknowns', () => {
    // A document that LOOKS authoritative but is full of em-dashes is worse than
    // no document. Same condition gates the button; this is the backstop.
    const { OrderReceipt } = loadReceipt();
    assert.equal(OrderReceipt.build({ order_items: [{ product_name: 'X', quantity: 1 }] }), null,
        'no total => no receipt');
    assert.equal(OrderReceipt.build({ total: 84.98, order_items: [] }), null,
        'no items => no receipt');
    assert.ok(OrderReceipt.build(ORDER), 'a complete order does render');
});

test('build() never throws on garbage input', () => {
    const { OrderReceipt } = loadReceipt();
    for (const bad of [null, undefined, {}, 0, 'x', []]) {
        assert.equal(OrderReceipt.build(bad), null);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT 1 — nothing is ever drawn off the page
// ─────────────────────────────────────────────────────────────────────────────

test('every drawn string lands inside the page box', () => {
    const { OrderReceipt, calls } = loadReceipt();
    OrderReceipt.build(ORDER);
    assert.ok(calls.text.length > 10, 'sanity: the builder drew something');
    for (const c of calls.text) {
        assert.ok(c.y > 0 && c.y <= PAGE_H, `text drawn outside the page at y=${c.y}: ${c.s}`);
        assert.ok(c.x >= 0 && c.x <= PAGE_W, `text drawn outside the page at x=${c.x}: ${c.s}`);
    }
});

test('totals BREAK TO A NEW PAGE when the items table ends at the page bottom', () => {
    // THE REGRESSION TEST FOR THE ADMIN BUILDER'S BUG. Table finishes at 800pt,
    // leaving ~40pt — not enough for a 7-row totals stack. buildInvoiceDoc would
    // happily write to y=816, 832, 848, 864... straight off the page.
    const { OrderReceipt, calls } = loadReceipt({ tableFinalY: 800 });
    const doc = OrderReceipt.build(ORDER);
    assert.ok(doc);
    assert.ok(calls.addPage >= 1, 'a page break must be added rather than overflowing');
    for (const c of calls.text) {
        assert.ok(c.y <= PAGE_H, `overflowed the page at y=${c.y}: ${c.s}`);
    }
    // The totals must have moved onto the new page, not stayed under the table.
    const totalRow = calls.text.find((c) => c.s === 'Total Paid');
    assert.ok(totalRow, 'the total row was drawn');
    assert.ok(totalRow.page > 1, 'the totals stack moved to the next page');
});

test('the totals stack is never split across a page break', () => {
    // It reserves its whole height in one ensure() call, so Subtotal..Total Paid
    // always share a page. A receipt with "Subtotal" on p1 and "Total Paid" on p2
    // is unreadable.
    for (const finalY of [700, 720, 740, 760, 780, 800, 820]) {
        const { OrderReceipt, calls } = loadReceipt({ tableFinalY: finalY });
        OrderReceipt.build(ORDER);
        const labels = ['Subtotal', 'Shipping', 'Total Paid'];
        const pages = labels
            .map((l) => calls.text.find((c) => c.s === l))
            .filter(Boolean)
            .map((c) => c.page);
        assert.equal(new Set(pages).size, 1,
            `totals split across pages when the table ended at ${finalY}`);
    }
});

test('the points-earned footnote is never orphaned off the page', () => {
    const withEstimate = { ...ORDER, total: 57, shipping_fee: 7 };
    for (const finalY of [700, 750, 780, 800, 820]) {
        const { OrderReceipt, calls } = loadReceipt({ tableFinalY: finalY });
        OrderReceipt.build(withEstimate);
        for (const c of calls.text) {
            assert.ok(c.y <= PAGE_H, `footnote overflowed at y=${c.y} (table end ${finalY}): ${c.s}`);
        }
        assert.ok(calls.text.some((c) => /earned/i.test(c.s)), 'the earned line was drawn');
    }
});

test('a long order does not overflow at any table end position', () => {
    const big = { ...ORDER, order_items: manyItems(60) };
    for (let finalY = 200; finalY <= 830; finalY += 30) {
        const { OrderReceipt, calls } = loadReceipt({ tableFinalY: finalY, tablePages: 3 });
        OrderReceipt.build(big);
        for (const c of calls.text) {
            assert.ok(c.y <= PAGE_H, `overflow at y=${c.y} with table end ${finalY}: ${c.s}`);
        }
    }
});

test('page bounds come from the document, not a hardcoded 841.89', () => {
    const src = stripComments(JS('order-receipt.js'));
    assert.match(src, /pageSize\.getHeight\(\)/, 'the page height must be read from the doc');
    assert.doesNotMatch(src, /841/, 'no hardcoded A4 height');
    assert.match(src, /pageSize\.getWidth\(\)/, 'nor a hardcoded width');
    assert.doesNotMatch(src, /595/, 'no hardcoded A4 width');
    assert.match(src, /addPage\(\)/, 'it must be able to paginate');
});

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT 2 — re-anchor after autoTable
// ─────────────────────────────────────────────────────────────────────────────

test('after autoTable the doc is re-anchored to the LAST page', () => {
    // Real autoTable paginates but leaves currentPage at 1. Without setPage the
    // totals get drawn on page 1 underneath the table — the admin builder's bug.
    const { OrderReceipt, calls } = loadReceipt({ tablePages: 3, tableFinalY: 300 });
    OrderReceipt.build({ ...ORDER, order_items: manyItems(60) });
    assert.ok(calls.setPage.length > 0, 'setPage must be called after the table');
    assert.equal(calls.setPage[0], 3, 'must re-anchor to the last page the table produced');
    const totalRow = calls.text.find((c) => c.s === 'Total Paid');
    assert.equal(totalRow.page, 3, 'the total belongs on the table\'s last page, not page 1');
});

test('autoTable reserves the footer strip so table rows do not collide with it', () => {
    const { OrderReceipt, calls } = loadReceipt();
    OrderReceipt.build(ORDER);
    const cfg = calls.autoTable[0];
    assert.ok(cfg.margin && typeof cfg.margin.bottom === 'number' && cfg.margin.bottom > MARGIN,
        'autoTable must reserve bottom margin beyond the page margin for the page footer');
});

test('every page gets a "Page n of N" footer', () => {
    const { OrderReceipt, calls } = loadReceipt({ tablePages: 3, tableFinalY: 300 });
    OrderReceipt.build({ ...ORDER, order_items: manyItems(60) });
    const footers = calls.text.filter((c) => /^Page \d+ of \d+$/.test(c.s));
    assert.equal(footers.length, 3, 'one footer per page');
    assert.deepEqual(footers.map((f) => f.s), ['Page 1 of 3', 'Page 2 of 3', 'Page 3 of 3']);
});

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT 3 — cp1252-safe output
// ─────────────────────────────────────────────────────────────────────────────

test('every string drawn into the PDF is printable ASCII', () => {
    // jsPDF built-in fonts are WinAnsi. "≈" (U+2248) is not in cp1252 and
    // corrupts silently, which is why the estimate marker is folded to "~".
    const cases = [
        ORDER,
        { ...ORDER, total: 57, shipping_fee: 7 },                       // estimated earn -> ≈
        { ...ORDER, subtotal: undefined, gst_amount: undefined },       // em-dash + "Included"
        { ...ORDER, shipping_fee: undefined },
        { ...ORDER, b2b_discount: { pricing_tier: 'gold', discount_amount: 4 }, discount_amount: 9 }
    ];
    for (const order of cases) {
        const { OrderReceipt, calls } = loadReceipt();
        OrderReceipt.build(order);

        // text() calls...
        for (const c of calls.text) {
            assert.match(c.s, /^[\x20-\x7e]*$/,
                `non-cp1252 glyph reached the PDF via text(): ${JSON.stringify(c.s)}`);
        }
        // ...AND autoTable cells, which autoTable draws itself. Checking only
        // text() let an unfolded em-dash into the items table unnoticed.
        for (const cfg of calls.autoTable) {
            for (const row of [].concat(cfg.head || [], cfg.body || [])) {
                for (const cell of row) {
                    assert.match(String(cell), /^[\x20-\x7e]*$/,
                        `non-cp1252 glyph reached the PDF via autoTable: ${JSON.stringify(cell)}`);
                }
            }
        }
    }
});

test('the estimate is disclosed in WORDS, not just a "~" glyph', () => {
    const { OrderReceipt, calls } = loadReceipt();
    OrderReceipt.build({ ...ORDER, total: 57, shipping_fee: 7 });
    const drawn = calls.text.map((c) => c.s).join(' | ');
    assert.match(drawn, /Estimated/, 'the PDF must say the figure is an estimate');
    assert.match(drawn, /excluding shipping/i, 'and state the basis');
});

test('a backend-confirmed earn is stated plainly with no estimate hedge', () => {
    const { OrderReceipt, calls } = loadReceipt();
    OrderReceipt.build({ ...ORDER, points_earned: 85 });
    const drawn = calls.text.map((c) => c.s).join(' | ');
    assert.match(drawn, /You earned 85 points on this order/);
    assert.doesNotMatch(drawn, /Estimated/);
});

test('no earned line at all when neither a figure nor an estimate exists', () => {
    const { OrderReceipt, calls } = loadReceipt();
    OrderReceipt.build({ ...ORDER, total: 0, shipping_fee: 0, points_earned: 0 });
    assert.ok(!calls.text.some((c) => /earned/i.test(c.s)), 'must not print "0 points earned"');
});

// ─────────────────────────────────────────────────────────────────────────────
// Content: totals come from OrderTotals, identity comes from LegalConfig
// ─────────────────────────────────────────────────────────────────────────────

test('the totals block is exactly OrderTotals.rows() — no private copy', () => {
    const { OrderReceipt, OrderTotals, calls } = loadReceipt();
    const order = {
        ...ORDER,
        b2b_discount: { pricing_tier: 'gold', discount_amount: 4 },
        discount_amount: 15, coupon_code: 'SAVE10', points_earned: 85
    };
    OrderReceipt.build(order);
    const drawn = calls.text.map((c) => c.s);
    for (const row of OrderTotals.rows(OrderTotals.normalise(order))) {
        if (row.key === 'earned') continue;   // rendered as a footnote sentence
        assert.ok(drawn.includes(OrderTotals.ascii(row.label)), `missing label: ${row.label}`);
        assert.ok(drawn.includes(OrderTotals.ascii(row.value)), `missing value: ${row.value}`);
    }
    assert.match(JS('order-receipt.js'), /OrderTotals\b/, 'must delegate to the shared helper');
});

test('the loyalty POINT COUNT reaches the receipt, not just the dollar figure', () => {
    const { OrderReceipt, calls } = loadReceipt();
    OrderReceipt.build(ORDER);
    const drawn = calls.text.map((c) => c.s).join(' | ');
    assert.match(drawn, /Loyalty points applied \(500 pts\)/);
    assert.match(drawn, /-\$5\.00/);
});

test('seller identity comes from LegalConfig — nothing hardcoded', () => {
    const src = JS('order-receipt.js');
    assert.doesNotMatch(src, /94-509-459/, 'GST number must not be hardcoded');
    assert.doesNotMatch(src, /9429033934204/, 'NZBN must not be hardcoded');
    assert.doesNotMatch(src, /Office Consumables/, 'legal entity must not be hardcoded');
    assert.doesNotMatch(src, /Archibald/, 'address must not be hardcoded');

    const { OrderReceipt, calls } = loadReceipt();
    OrderReceipt.build(ORDER);
    const drawn = calls.text.map((c) => c.s).join(' | ');
    assert.match(drawn, /GST 94-509-459/, 'the GST number is rendered from config');
    assert.match(drawn, /NZBN 9429033934204/);
    assert.match(drawn, /Office Consumables Ltd/);
});

test('LegalConfig absent => the FROM block is OMITTED, never a placeholder GST', () => {
    // A stale or invented GST number on a document that looks like a tax record
    // is a compliance problem, not a cosmetic one.
    const { OrderReceipt, calls } = loadReceipt({ noLegalConfig: true });
    const doc = OrderReceipt.build(ORDER);
    assert.ok(doc, 'the receipt still renders');
    const drawn = calls.text.map((c) => c.s).join(' | ');
    assert.doesNotMatch(drawn, /GST 9/, 'no GST identity without config');
    assert.doesNotMatch(drawn, /FROM/, 'the whole seller block is omitted');
    assert.match(drawn, /ORDER RECEIPT/, 'but the receipt itself is intact');
});

test('it is a RECEIPT, not a tax invoice — no payment terms or bank details', () => {
    const { OrderReceipt, calls } = loadReceipt();
    OrderReceipt.build(ORDER);
    const drawn = calls.text.map((c) => c.s).join(' | ');
    assert.match(drawn, /ORDER RECEIPT/);
    assert.doesNotMatch(drawn, /TAX INVOICE/, 'must not impersonate the operator invoice');
    assert.doesNotMatch(drawn, /Payment due|a\/c Number|a\/c Name|make payment to/i,
        'an already-paid order has no payment terms');
});

test('order number, date and recipient are on the receipt', () => {
    const { OrderReceipt, calls } = loadReceipt();
    OrderReceipt.build(ORDER);
    const drawn = calls.text.map((c) => c.s).join(' | ');
    assert.match(drawn, /20260728000001/);
    assert.match(drawn, /ORDER NUMBER/);
    assert.match(drawn, /Jun Jackson/);
    assert.match(drawn, /12 Example St/);
    assert.match(drawn, /Jul 2026/, 'the order date is formatted, not raw ISO');
    assert.doesNotMatch(drawn, /2026-07-28T/, 'no raw ISO timestamps on a customer document');
});

test('a duplicated city/region prints once ("Auckland Auckland 1010")', () => {
    // Extremely common in NZ — Auckland city sits in Auckland region, likewise
    // Wellington, Nelson, Gisborne. Printing both reads as a bug on a document
    // the customer keeps.
    const { OrderReceipt, calls } = loadReceipt();
    OrderReceipt.build(ORDER);   // fixture has city === region === 'Auckland'
    const drawn = calls.text.map((c) => c.s);
    assert.ok(drawn.includes('Auckland 1010'), 'city + postcode, region collapsed');
    assert.ok(!drawn.some((s) => /Auckland\s+Auckland/.test(s)), 'the region must not repeat the city');
});

test('a genuinely different region is still printed', () => {
    const { OrderReceipt, calls } = loadReceipt();
    OrderReceipt.build({ ...ORDER, shipping_address: {
        recipient_name: 'A', address_line1: '1 X St', city: 'Hamilton', region: 'Waikato', postal_code: '3204' } });
    assert.ok(calls.text.map((c) => c.s).includes('Hamilton Waikato 3204'));
});

test('an unparseable created_at drops the date row instead of printing junk', () => {
    const { OrderReceipt, calls } = loadReceipt();
    OrderReceipt.build({ ...ORDER, created_at: 'not-a-date' });
    const drawn = calls.text.map((c) => c.s).join(' | ');
    assert.doesNotMatch(drawn, /Invalid Date|NaN/);
});

test('item rows render code, name, qty and amount; unknowns become em-dashes', () => {
    const { OrderReceipt, calls } = loadReceipt();
    OrderReceipt.build(ORDER);
    const body = plain(calls.autoTable[0].body);
    assert.deepEqual(body[0], ['CN-045', 'Canon 045 Black', '2', '$89.98']);
    assert.deepEqual(plain(calls.autoTable[0].head), [['Code', 'Description', 'Qty', 'Amount']]);

    // Unknown qty / line total must be em-dashes, never 0 or a blank cell.
    const { OrderReceipt: R2, calls: c2 } = loadReceipt();
    R2.build({ ...ORDER, order_items: [{ product_name: 'Mystery item' }] });
    const row = plain(c2.autoTable[0].body)[0];
    assert.deepEqual(row, ['', 'Mystery item', '-', '-'],
        'unknown qty/amount render as dashes (ascii-folded), not 0');
});

// ─────────────────────────────────────────────────────────────────────────────
// download() / attach()
// ─────────────────────────────────────────────────────────────────────────────

test('download() saves a sanitised filename', async () => {
    const { OrderReceipt, calls } = loadReceipt();
    assert.equal(await OrderReceipt.download(ORDER), true);
    assert.deepEqual(calls.save, ['Receipt-20260728000001.pdf']);
});

test('safeName strips path and shell-hostile characters', () => {
    const { OrderReceipt } = loadReceipt();
    assert.equal(OrderReceipt.safeName('20260728000001'), 'Receipt-20260728000001.pdf');
    assert.equal(OrderReceipt.safeName('../../etc/passwd'), 'Receipt-....etcpasswd.pdf');
    assert.equal(OrderReceipt.safeName(''), 'Receipt-order.pdf');
    assert.equal(OrderReceipt.safeName(null), 'Receipt-order.pdf');
    assert.equal(OrderReceipt.safeName('a b"c'), 'Receipt-abc.pdf');
});

test('download() returns false (never throws) when the lib is unavailable', async () => {
    const { OrderReceipt, calls } = loadReceipt({ noLib: true });
    assert.equal(await OrderReceipt.download(ORDER), false);
    assert.deepEqual(calls.save, []);
});

test('download() returns false for an order it cannot render', async () => {
    const { OrderReceipt } = loadReceipt();
    assert.equal(await OrderReceipt.download({ total: 10, order_items: [] }), false);
    assert.equal(await OrderReceipt.download(null), false);
});

test('attach() restores the button on success AND on failure', async () => {
    const { OrderReceipt, toasts } = loadReceipt({ noLib: true });
    const handlers = [];
    const btn = {
        dataset: {}, disabled: false, innerHTML: '<span>Download receipt</span>',
        textContent: '', attrs: {},
        setAttribute(k, v) { this.attrs[k] = v; },
        removeAttribute(k) { delete this.attrs[k]; },
        addEventListener(ev, fn) { handlers.push(fn); }
    };
    OrderReceipt.attach(btn, () => ORDER);
    await handlers[0]();

    assert.equal(btn.disabled, false, 'button must be re-enabled');
    assert.equal(btn.innerHTML, '<span>Download receipt</span>', 'label must be restored');
    assert.equal(btn.attrs['aria-busy'], undefined, 'aria-busy must be cleared');
    assert.equal(toasts.length, 1, 'the user is told it failed');
    assert.equal(toasts[0].kind, 'error');
    assert.match(toasts[0].msg, /receipt/i);
});

test('attach() is idempotent — repeated renders bind exactly one handler', () => {
    const { OrderReceipt } = loadReceipt();
    let bound = 0;
    const btn = { dataset: {}, addEventListener: () => { bound += 1; }, setAttribute() {}, removeAttribute() {} };
    OrderReceipt.attach(btn, () => ORDER);
    OrderReceipt.attach(btn, () => ORDER);
    OrderReceipt.attach(btn, () => ORDER);
    assert.equal(bound, 1);
});

test('attach() reads the order at CLICK time, not at bind time', async () => {
    // Both pages bind before the order payload has necessarily arrived.
    const { OrderReceipt, calls } = loadReceipt();
    const handlers = [];
    const btn = {
        dataset: {}, disabled: false, innerHTML: 'x', textContent: '',
        setAttribute() {}, removeAttribute() {},
        addEventListener(ev, fn) { handlers.push(fn); }
    };
    let current = null;
    OrderReceipt.attach(btn, () => current);
    current = ORDER;              // arrives after binding
    await handlers[0]();
    assert.deepEqual(calls.save, ['Receipt-20260728000001.pdf']);
});

test('attach() tolerates a missing button or getter', () => {
    const { OrderReceipt } = loadReceipt();
    assert.doesNotThrow(() => OrderReceipt.attach(null, () => ORDER));
    assert.doesNotThrow(() => OrderReceipt.attach({ dataset: {} }, null));
});

// ─────────────────────────────────────────────────────────────────────────────
// House rules
// ─────────────────────────────────────────────────────────────────────────────

test('order-receipt.js uses DebugLog, never raw console.*', () => {
    const src = JS('order-receipt.js')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '');
    assert.doesNotMatch(src, /(^|[^.\w])console\.(log|warn|error|info|debug)\s*\(/);
    assert.match(src, /DebugLog/);
});

test('the lazy loader cannot inject the same script twice', () => {
    const src = JS('order-receipt.js');
    assert.match(src, /_libPromise/, 'a shared in-flight promise must guard concurrent clicks');
});

test('a stalled CDN cannot hang the button forever — the load is time-bounded', () => {
    // A connection that neither completes nor errors never fires onerror, so
    // without a timeout `await ensureLib()` parks indefinitely and the button
    // stays disabled on "Preparing..." with no way back.
    const src = JS('order-receipt.js');
    assert.match(src, /LOAD_TIMEOUT_MS/, 'script loading must be time-bounded');
    assert.match(src, /setTimeout\([\s\S]{0,120}LOAD_TIMEOUT_MS/, 'the timeout must actually be armed');
    assert.match(src, /clearTimeout/, 'and cleared on settle so it cannot double-settle');
});

test('a failed load is retryable — the cached promise is cleared', () => {
    // Without clearing _libPromise, one transient CDN blip would permanently
    // disable receipts for the rest of the page's life.
    const src = JS('order-receipt.js');
    assert.match(src, /_libPromise\s*=\s*null/, 'a failed load must not be cached forever');
});

test('concurrent clicks share ONE in-flight load', async () => {
    const { OrderReceipt, sandbox } = loadReceipt({ noLib: true, scriptLoad: 'error' });
    let appended = 0;
    sandbox.document.head.appendChild = (el) => {
        appended += 1;
        setTimeout(() => el.onerror && el.onerror(), 0);
    };
    const [a, b, c] = await Promise.all([
        OrderReceipt.ensureLib(), OrderReceipt.ensureLib(), OrderReceipt.ensureLib()
    ]);
    assert.deepEqual([a, b, c], [false, false, false]);
    assert.equal(appended, 1, 'three simultaneous callers must not inject three script tags');
});

test('ensureLib resolves true without touching the network when jsPDF is already present', async () => {
    const { OrderReceipt, sandbox } = loadReceipt();
    let appended = 0;
    sandbox.document.head.appendChild = () => { appended += 1; };
    assert.equal(await OrderReceipt.ensureLib(), true);
    assert.equal(appended, 0);
});

// ── Header meta geometry (ERR-198) ──────────────────────────────────────────
//
// The label column used to be pinned at `pageW - M - 110`: a constant reserving
// space for text, which is a measurement someone declined to take (ERR-196's
// lesson, and this file is where it went unlearned). The suite above asserts
// every string lands inside the PAGE BOX, and it always did — what it never
// asked was whether two strings land on top of EACH OTHER. That is why the pin
// survived here after being fixed in the invoice builder one file over.

/** The box a recorded text call occupies, honouring right-alignment. */
function boxOf(call, widthOf) {
    const w = widthOf(call.s, call.style, call.size);
    const x0 = call.align === 'right' ? call.x - w : call.x;
    return { x0, x1: x0 + w, y: call.y, w };
}

/** Width using the same Times metrics the fake draws with. */
function timesWidth(s, style, size) {
    const t = style === 'bold' ? TIMES_BOLD : TIMES_ROMAN;
    return [...String(s)].reduce((a, c) => a + ((t[c] === undefined ? 500 : t[c]) / 1000), 0) * (size || 12);
}

const META_LABELS = ['ORDER NUMBER', 'DATE', 'INVOICE NUMBER'];

test('a header meta label never collides with its own value, at any order-number width', () => {
    // Every shape the backend has ever minted, widest last. The two legacy forms
    // are the ones that broke it: at 11 pt Times bold they are 124.7 pt and
    // 198.6 pt wide against a 110 pt pin, so each printed straight through its
    // own ORDER NUMBER label on every receipt for a pre-2026-05-18 order.
    const shapes = [
        '2026090101', '20260901100', '20260829000004',
        'ORD-MMQXBRYO-6E93', 'ORD-MP7GA80N-C3DD9FA2EC39F1DE',
    ];
    for (const orderNumber of shapes) {
        const { OrderReceipt, calls } = loadReceipt();
        OrderReceipt.build({ ...ORDER, order_number: orderNumber });

        const labels = calls.text.filter((c) => META_LABELS.includes(c.s));
        assert.ok(labels.length >= 2, `sanity: the meta labels were drawn for ${orderNumber}`);

        const value = calls.text.find((c) => c.s === orderNumber);
        assert.ok(value, `the order number ${orderNumber} must be drawn on the receipt`);

        const vBox = boxOf(value, timesWidth);
        for (const label of labels.filter((l) => l.y === value.y)) {
            const lBox = boxOf(label, timesWidth);
            assert.ok(lBox.x1 <= vBox.x0,
                `on a receipt for ${orderNumber} the label "${label.s}" ends at `
                + `x=${lBox.x1.toFixed(1)} but its value starts at x=${vBox.x0.toFixed(1)} — `
                + `they overlap by ${(lBox.x1 - vBox.x0).toFixed(1)} pt, so the PDF prints them `
                + `on top of each other (ERR-198).`);
        }
    }
});

test('the meta gap is derived from the widest value, not from a constant', () => {
    // Pin the SHAPE of the fix, not a number: a future value one character wider
    // must move the labels, which a hardcoded offset can never do.
    const src = fs.readFileSync(path.join(ROOT, 'js', 'order-receipt.js'), 'utf8');
    assert.match(src, /getTextWidth/,
        'the receipt builder must MEASURE its meta values with the font that draws them');
    assert.doesNotMatch(src, /pageW - M - 110/,
        'the 110 pt label pin is the defect — it must not come back');
    assert.match(src, /const metaLabelX = pageW - M - metaValW - 18;/,
        'labels are seated a fixed gap clear of the measured widest value');
});

test('POSITIVE CONTROL — the pre-fix 110 pt pin DOES overlap the legacy numbers', () => {
    // If this ever stops overlapping, the geometry test above is not measuring
    // anything and would pass against the broken source.
    const PIN = 110;
    const overlaps = (n) => timesWidth(n, 'bold', 11) > PIN;
    assert.ok(!overlaps('20260829000004'),
        'the interim 14-digit form fit inside the old pin — which is why nobody noticed');
    assert.ok(!overlaps('2026090101'),
        'and the new 10-digit form fits too, so the migration did not cause this');
    assert.ok(overlaps('ORD-MMQXBRYO-6E93'),
        'the short legacy form is 124.7 pt and overlapped by 14.7 pt');
    assert.ok(overlaps('ORD-MP7GA80N-C3DD9FA2EC39F1DE'),
        'the long legacy form is 198.6 pt and overlapped by 88.6 pt');
});
