/**
 * Order discount must reduce admin profit (ERR-168, Aug 2026)
 * ===========================================================
 *
 * Since public volume pricing went live, most orders carry an order-level
 * discount in `orders.discount_amount` — the GST-INCLUSIVE aggregate of volume
 * pricing, coupon and loyalty. The admin computed revenue as Σ(unit_price × qty)
 * over the line items and never subtracted it, so every discounted order
 * overstated profit by `discount / 1.15`.
 *
 * The bug was not confined to the profit line. `computeProfitBreakdown` derives
 * `gstCollected = customerPaid − revenue`. The order total has ALWAYS been net of
 * the discount, so while revenue stayed gross the two sides sat on different
 * bases: the proof order reported **$4.00 of GST collected on a $116.60 sale**
 * (true figure $15.22). Netting the discount out of revenue is what puts them
 * back on one basis, which is why the fix belongs on the REVENUE side and not as
 * another deduction alongside the Stripe fee.
 *
 * FIXTURES ARE REAL. Every number below was measured against production on
 * 2026-08-17 via `npm run probe:order-discount` (read-only), not invented:
 *
 *   20260817000002  10 × $11.26 ex-GST = $112.60 · discount $12.90 · total $116.60
 *   20260812000001  lines $41.56 ex-GST · discount $2.40 · total $52.40 · ship $7.00
 *
 * The acceptance criteria come straight from the backend brief
 * (`order-profit-net-of-discount-aug2026.md` §5).
 *
 * Run with: node --test tests/admin-order-profit-discount-aug2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const ADMIN = path.join(ROOT, 'inkcartridges', 'js', 'admin');
const PROFITABILITY = path.join(ADMIN, 'utils', 'profitability.js');
const ORDER_PROFIT = path.join(ADMIN, 'utils', 'order-profit.js');
const ORDERS_PAGE = path.join(ADMIN, 'pages', 'orders.js');

const ordersSrc = fs.readFileSync(ORDERS_PAGE, 'utf8');
const profitSrc = fs.readFileSync(ORDER_PROFIT, 'utf8');

// Same loader the sibling admin-util tests use.
function stripEsm(src) {
    const exposed = new Set();
    let stripped = src.replace(/^\s*import\s+[^;]+;\s*$/gm, '');
    stripped = stripped.replace(/export\s+\{[^}]*\}\s*;?/g, '');
    stripped = stripped.replace(/export\s+(const|let|var|function|class)\s+([A-Za-z0-9_$]+)/gm, (_m, kw, id) => {
        exposed.add(id);
        return `${kw} ${id}`;
    });
    return stripped + '\n;' + [...exposed].map(id => `try { globalThis.${id} = ${id}; } catch(_) {}`).join('\n');
}

const sandbox = { console, Math, Number, Object, Array, String, Boolean, JSON, Error, RegExp };
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(stripEsm(fs.readFileSync(PROFITABILITY, 'utf8')), ctx, { filename: 'profitability.js' });
vm.runInContext(stripEsm(fs.readFileSync(ORDER_PROFIT, 'utf8')), ctx, { filename: 'order-profit.js' });

const { orderProfitFromDetail, orderDiscountParts, PROFIT_STATE } = sandbox;

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${a} !== ${b}`);
const cents = (a, b) => assert.ok(Math.abs(a - b) < 0.005, `${a} !== ${b} (to the cent)`);

/** Production order 20260817000002 — one line, volume discount only, no coupon. */
const proofOrder = (over = {}) => ({
    id: 'ord-proof',
    order_number: '20260817000002',
    status: 'paid',
    payment_method: 'stripe',
    total_amount: 116.60,
    discount_amount: 12.90,
    items: [{ sku: 'CLC37BK', sell_price: 11.26, qty: 10, supplier_cost_snapshot: 5.00 }],
    ...over,
});

/** A plain undiscounted website order — the no-op control. */
const plainOrder = (over = {}) => ({
    id: 'ord-plain',
    order_number: '20260728000001',
    status: 'paid',
    payment_method: 'stripe',
    total_amount: 57.50,
    items: [
        { sku: 'A1', sell_price: 20, qty: 2, supplier_cost_snapshot: 8 },
        { sku: 'B2', sell_price: 10, qty: 1, supplier_cost_snapshot: 4 },
    ],
    ...over,
});

// ─── orderDiscountParts — the GST convention ────────────────────────────────

test('orderDiscountParts splits a GST-INCLUSIVE discount the same way absorbed courier does', () => {
    const d = orderDiscountParts(12.90);
    assert.equal(d.applies, true);
    near(d.inclGst, 12.90);
    near(d.gst, 12.90 * (0.15 / 1.15));           // GST inside a GST-inclusive amount = × 3/23
    near(d.exGst, 12.90 - d.gst);
    // Deriving by subtraction and dividing by 1.15 must agree — the brief states
    // the /1.15 form, the codebase's absorbed-courier convention states the
    // subtraction form, and a divergence between them would show up as a
    // waterfall that doesn't foot.
    cents(d.exGst, 12.90 / 1.15);
    cents(d.exGst, 11.22);
});

test('orderDiscountParts: absent / null / zero / negative / junk all mean NO discount', () => {
    for (const v of [undefined, null, 0, -5, '', NaN, 'abc', {}]) {
        const d = orderDiscountParts(v);
        assert.equal(d.applies, false, `${JSON.stringify(v)} must not apply`);
        assert.equal(d.exGst, 0);
        assert.equal(d.inclGst, 0);
        assert.equal(d.gst, 0);
    }
});

test('orderDiscountParts reads a numeric STRING, because JSON money sometimes arrives as one', () => {
    const d = orderDiscountParts('12.90');
    assert.equal(d.applies, true);
    cents(d.exGst, 11.22);
});

// ─── The brief's acceptance criteria (§5) ───────────────────────────────────

test('§5.1 order 20260817000002: revenue is $101.38, not $112.60', () => {
    const r = orderProfitFromDetail(proofOrder());
    assert.equal(r.state, PROFIT_STATE.OK);
    cents(r.grossRevenueExGst, 112.60, 'the raw line sum is preserved for display');
    cents(r.orderDiscountExGst, 11.22);
    cents(r.totalRevenueExGst, 101.38);
    // Cross-check against the charged total: 116.60 / 1.15 = 101.39. The ≤1c
    // difference is stored rounding; the brief names the line-sum figure as the
    // acceptance value.
    assert.ok(Math.abs(r.totalRevenueExGst - 116.60 / 1.15) <= 0.02);
});

test('§5.1 order 20260817000002: net profit is exactly $11.22 lower than before the fix', () => {
    const withDiscount = orderProfitFromDetail(proofOrder());
    const preFix = orderProfitFromDetail(proofOrder({ discount_amount: 0 }));
    cents(preFix.netProfit - withDiscount.netProfit, 11.22);
    cents(preFix.netProfit - withDiscount.netProfit, 12.90 / 1.15);
});

test('§5.1 the fee line is UNCHANGED — the fee base was always the discounted total', () => {
    const withDiscount = orderProfitFromDetail(proofOrder());
    const preFix = orderProfitFromDetail(proofOrder({ discount_amount: 0 }));
    near(withDiscount.breakdown.stripeFeeExGst, preFix.breakdown.stripeFeeExGst);
    near(withDiscount.breakdown.stripeFeeInclGst, preFix.breakdown.stripeFeeInclGst);
    near(withDiscount.breakdown.customerPaidInclGst, 116.60);
});

test('§5.2 order 20260812000001 (charged shipping): profit drops by exactly 2.40/1.15', () => {
    const o = {
        id: 'ord-ship', order_number: '20260812000001', status: 'paid', payment_method: 'stripe',
        total_amount: 52.40, discount_amount: 2.40, shipping_fee: 7.00,
        items: [{ sku: 'S1', sell_price: 20.78, qty: 2, supplier_cost_snapshot: 9 }],
    };
    const after = orderProfitFromDetail(o);
    const before = orderProfitFromDetail({ ...o, discount_amount: 0 });
    cents(before.netProfit - after.netProfit, 2.40 / 1.15);
    cents(before.netProfit - after.netProfit, 2.09);
    // "nothing else moves"
    near(after.breakdown.stripeFeeExGst, before.breakdown.stripeFeeExGst);
    near(after.totalCostExGst, before.totalCostExGst);
});

test('§5.3 an order with discount_amount = 0 is byte-identical to the pre-fix output', () => {
    // The strongest statement of the no-op guarantee: same object, key for key.
    const zero = orderProfitFromDetail(plainOrder({ discount_amount: 0 }));
    const absent = orderProfitFromDetail(plainOrder());
    const nulled = orderProfitFromDetail(plainOrder({ discount_amount: null }));
    assert.deepEqual(zero, absent);
    assert.deepEqual(nulled, absent);
    assert.equal(absent.discountApplies, false);
    // And the actual money is the figure the pre-discount test suite pins.
    near(absent.netProfit, 50 - 20 - (57.50 * 0.0265 + 0.30));
});

test('§5.4 CANCELLED and UNKNOWN survive a discount — never $0', () => {
    const cancelled = orderProfitFromDetail(proofOrder({ status: 'cancelled' }));
    assert.equal(cancelled.state, PROFIT_STATE.CANCELLED);
    assert.equal(cancelled.netProfit, null);

    const uncosted = proofOrder();
    uncosted.items = [
        { sku: 'A', sell_price: 11.26, qty: 5, supplier_cost_snapshot: 5 },
        { sku: 'B', sell_price: 11.26, qty: 5, supplier_cost_snapshot: null },
    ];
    const unknown = orderProfitFromDetail(uncosted);
    assert.equal(unknown.state, PROFIT_STATE.UNKNOWN);
    assert.equal(unknown.netProfit, null);
    assert.equal(unknown.totalCostExGst, null);
    // …but the discount is still reported, so the modal can explain the revenue.
    assert.equal(unknown.discountApplies, true);
    cents(unknown.totalRevenueExGst, 101.38);
});

test('§5.5 per-line profits sum to the order profit on a DISCOUNTED multi-line order', () => {
    const o = {
        id: 'm', status: 'paid', payment_method: 'stripe', total_amount: 200, discount_amount: 23,
        items: [
            { sku: 'A', sell_price: 20, qty: 2, supplier_cost_snapshot: 8 },
            { sku: 'B', sell_price: 10, qty: 3, supplier_cost_snapshot: 4 },
            { sku: 'C', sell_price: 7.5, qty: 4, supplier_cost_snapshot: 2 },
        ],
    };
    const r = orderProfitFromDetail(o);
    const sum = r.lineProfits.reduce((a, b) => a + b, 0);
    near(sum, r.netProfit, 1e-9);
});

// ─── The GST row the brief flagged as a side benefit ────────────────────────

test('gstCollected now reports real GST instead of the discount-shaped nonsense', () => {
    const after = orderProfitFromDetail(proofOrder());
    const before = orderProfitFromDetail(proofOrder({ discount_amount: 0 }));
    // Pre-fix: 116.60 − 112.60 = $4.00 of "GST collected" on a $116.60 sale.
    cents(before.breakdown.gstCollected, 4.00);
    // Post-fix: 116.60 − 101.38 = $15.22, which is 15% of the realised revenue.
    cents(after.breakdown.gstCollected, 15.22);
    assert.ok(Math.abs(after.breakdown.gstCollected - after.totalRevenueExGst * 0.15) < 0.02,
        'GST collected must be ~15% of realised ex-GST revenue');
});

test('the cash waterfall still foots exactly with a discount applied', () => {
    const b = orderProfitFromDetail(proofOrder()).breakdown;
    const footed = b.customerPaidInclGst - b.supplierCostInclGst - b.stripeFeeInclGst
        - b.absorbedShippingInclGst - b.gstRemittedToIrd;
    near(footed, b.netProfit, 1e-9);
});

test('net margin is measured against REALISED revenue, not the pre-discount line sum', () => {
    const r = orderProfitFromDetail(proofOrder());
    near(r.netMarginPct, (r.netProfit / r.totalRevenueExGst) * 100);
    // A margin over the gross figure would flatter the order — assert it differs,
    // so a regression that swaps the denominator back is caught.
    assert.ok(Math.abs(r.netMarginPct - (r.netProfit / r.grossRevenueExGst) * 100) > 1);
});

// ─── Apportionment ─────────────────────────────────────────────────────────

test('the discount is apportioned across lines by revenue share, not spread evenly', () => {
    const o = {
        id: 'ap', status: 'paid', payment_method: 'stripe', total_amount: 120, discount_amount: 11.50,
        items: [
            { sku: 'BIG', sell_price: 90, qty: 1, supplier_cost_snapshot: 40 },
            { sku: 'SML', sell_price: 10, qty: 1, supplier_cost_snapshot: 4 },
        ],
    };
    const r = orderProfitFromDetail(o);
    const undiscounted = orderProfitFromDetail({ ...o, discount_amount: 0 });
    const dropBig = undiscounted.lineProfits[0] - r.lineProfits[0];
    const dropSml = undiscounted.lineProfits[1] - r.lineProfits[1];
    // 90:10 revenue split ⇒ the big line absorbs 9× the discount of the small one.
    near(dropBig / dropSml, 9, 1e-6);
    cents(dropBig + dropSml, 11.50 / 1.15);
});

test('an invoiced sale nets the discount too, and still pays no card fee', () => {
    const inv = orderProfitFromDetail(proofOrder({ payment_method: 'invoice', order_number: 'INV-3300' }));
    assert.equal(inv.isInvoice, true);
    assert.equal(inv.breakdown.stripeFeeExGst, 0);
    cents(inv.totalRevenueExGst, 101.38);
    cents(inv.netProfit, 101.38 - 50.00);   // revenue − cost, no processor at all
});

// ─── The pathological case must be UNKNOWN, never a confident number ────────

test('a discount at or above the line total resolves to UNKNOWN, not $0 and not a loss', () => {
    const r = orderProfitFromDetail(proofOrder({ discount_amount: 9999 }));
    assert.equal(r.state, PROFIT_STATE.UNKNOWN);
    assert.equal(r.netProfit, null, 'a refused revenue figure is unknown, not zero');
    assert.equal(r.discountExceedsRevenue, true, 'and it must say WHY, not just fail');
    assert.equal(r.missingCostCount, 0, 'this is NOT a missing-cost failure');
});

test('discountExceedsRevenue is false in the ordinary case, so the UI picks the right words', () => {
    assert.equal(orderProfitFromDetail(proofOrder()).discountExceedsRevenue, false);
    assert.equal(orderProfitFromDetail(plainOrder()).discountExceedsRevenue, false);
});

// ─── Labelling fields ──────────────────────────────────────────────────────

test('coupon_code and loyalty are carried for LABELLING and never double-subtracted', () => {
    const r = orderProfitFromDetail(proofOrder({
        coupon_code: 'WELCOME10', loyalty_discount_amount: 4.00,
    }));
    assert.equal(r.couponCode, 'WELCOME10');
    cents(r.loyaltyDiscountInclGst, 4.00);
    // The money must come from the AGGREGATE alone — adding the loyalty subset on
    // top would deduct those dollars twice.
    cents(r.orderDiscountInclGst, 12.90);
    cents(r.totalRevenueExGst, 101.38);
});

test('a missing coupon_code is null, not an empty string that would render an empty badge', () => {
    assert.equal(orderProfitFromDetail(proofOrder()).couponCode, null);
    assert.equal(orderProfitFromDetail(proofOrder({ coupon_code: '' })).couponCode, null);
});

// ─── Wiring: the deduction must reach BOTH surfaces ─────────────────────────

test('the discount is netted BEFORE both profit calls, so line profits and the waterfall agree', () => {
    const iDiscount = profitSrc.indexOf('orderDiscountParts(order.discount_amount)');
    const iLines = profitSrc.indexOf('computeLineProfits(lines, feeOpts)');
    const iBreak = profitSrc.indexOf('computeProfitBreakdown(totalRevenueExGst, totalCostExGst, feeOpts)');
    assert.ok(iDiscount > -1, 'order-profit.js must read discount_amount through orderDiscountParts');
    assert.ok(iLines > -1 && iBreak > -1, 'both profit calls must still be present');
    assert.ok(iDiscount < iLines && iDiscount < iBreak,
        'the deduction must precede both calls — applying it to only one splits the two surfaces (ERR-113)');
});

test('the GST conversion lives in profitability.js, not in the classification layer', () => {
    // order-profit.js's header promises it contains NO math. A bare /1.15 here
    // would be a second, uncommented statement of the GST convention.
    // Comments are stripped first — the prose legitimately says "discount/1.15"
    // when explaining the bug, and pinning prose is how a test starts failing for
    // reasons that have nothing to do with the code.
    const code = profitSrc
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/\/\s*1\.15/.test(code),
        'order-profit.js must not hand-roll the GST conversion — use orderDiscountParts');
    assert.match(profitSrc, /import\s*\{[^}]*orderDiscountParts[^}]*\}\s*from\s*'\.\/profitability\.js'/);
});

test('orders.js still does not build a waterfall itself (ERR-113 boundary holds)', () => {
    assert.ok(!/computeProfitBreakdown\(/.test(ordersSrc),
        'the page must keep deriving profit only through orderProfitFromDetail');
});

// ─── Wiring: the render surfaces ───────────────────────────────────────────

test('the items foot shows gross, the discount, and the net revenue', () => {
    assert.match(ordersSrc, /profitInfo\.discountApplies/, 'the foot rows must be guarded on the flag');
    assert.match(ordersSrc, /profitInfo\.grossRevenueExGst/, 'the raw line sum must be shown');
    assert.match(ordersSrc, /profitInfo\.orderDiscountExGst/, 'and the ex-GST discount that explains the drop');
    assert.match(ordersSrc, /Order discount/, 'with a label a human can read');
});

test('the CASH waterfall must NOT subtract the discount again', () => {
    // `Customer paid` is already net of it. A `neg(...)` row here would
    // double-count and stop Take-home footing — the trap the brief's §4 mockup
    // would have walked into, because it assumed a revenue-first breakdown.
    const wf = ordersSrc.slice(ordersSrc.indexOf('Profit breakdown'), ordersSrc.indexOf('Take-home profit'));
    assert.ok(!/neg\(\s*(b|profitInfo)\.(orderDiscount|discount)/.test(wf),
        'the discount must never be a negated row in the cash waterfall');
    assert.match(ordersSrc, /after −\$\{|after −\$|after −/,
        'it must appear as a qualifier on the Customer paid row instead');
});

test('the Orders LIST shows the discount without spending a detail fetch', () => {
    assert.match(ordersSrc, /function orderDiscountSubline\(r\)/,
        'the list reads discount_amount straight off the row (backend 52abc83)');
    assert.match(ordersSrc, /orderDiscountSubline\(r\)/, 'and the Total column renders it');
    const fn = ordersSrc.slice(ordersSrc.indexOf('function orderDiscountSubline'),
        ordersSrc.indexOf('function profitCellHtml'));
    assert.match(fn, /amount\s*<=\s*0/, 'a $0 discount must render nothing at all, not "−$0.00"');
    assert.ok(!/AdminAPI\.getOrder/.test(fn), 'and it must not trigger a fetch');
});

// ─── The UNKNOWN copy must not blame the wrong thing ───────────────────────

test('UNKNOWN copy branches on the CAUSE — never "0 of 2 items have no recorded cost"', () => {
    // This lie predates the discount work (the !breakdown branch could always
    // reach UNKNOWN with missingCostCount === 0) and the discount makes it easier
    // to hit, so it is fixed and pinned here.
    for (const marker of [
        /missingCostCount > 0\s*$/m,           // the foot tooltip branches
        /const unknownBody = n > 0/,           // the modal panel branches
    ]) {
        assert.match(ordersSrc, marker);
    }
    assert.match(ordersSrc, /discountExceedsRevenue/,
        'the discount-driven UNKNOWN must have its own explanation');
    assert.match(ordersSrc, /at or above/, 'which names what actually went wrong');
});

// ─── ENROLMENT: the lesson of ERR-150 / ERR-160 ────────────────────────────
//
// "Every surface calls X" is a list nobody maintains. Public volume pricing has
// already vanished twice — once at a whitelist parser, once at a call site — so
// the enrolment itself is asserted here rather than trusted.

test('ENROLMENT: order-profit.js is the ONLY place in js/admin that ACCUMULATES order revenue', () => {
    // The bug shape is not "reads a unit price" — orders.js reads one to print the
    // Price cell, and invoices.js reads one to seed a draft line, and neither is a
    // revenue total. The shape is ACCUMULATION: running a `+=` over line prices to
    // build an order's revenue, which is the figure the discount has to come off.
    const ACCUMULATES = /\+=\s*[^;\n]*(sell_price|unit_price|lineRevenue|revenueExGst)/;

    // Guard against a vacuous pass: if the pattern stops matching the one file it
    // is supposed to match, it would report a clean sweep over nothing (ERR-073).
    assert.match(profitSrc, ACCUMULATES,
        'the detector must still match order-profit.js, or this test proves nothing');

    const offenders = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(p); continue; }
            if (!entry.name.endsWith('.js')) continue;
            if (p === ORDER_PROFIT) continue;
            if (ACCUMULATES.test(fs.readFileSync(p, 'utf8'))) offenders.push(path.relative(ROOT, p));
        }
    };
    walk(ADMIN);
    assert.deepEqual(offenders, [],
        'a second revenue summation would need its own discount netting and would drift from this one:\n  '
        + offenders.join('\n  '));
});

test('ENROLMENT: every consumer of orderProfitFromDetail gets the discount for free', () => {
    // Both surfaces call the one derivation, so neither can miss the netting.
    const calls = ordersSrc.match(/orderProfitFromDetail\(/g) || [];
    assert.ok(calls.length >= 2, 'the list column and the modal must both call it');
    assert.ok(!/discount_amount/.test(
        ordersSrc.slice(ordersSrc.indexOf('async function hydrateProfits'),
            ordersSrc.indexOf('function orderLabel'))),
        'the list hydration must not re-derive the discount — it comes back inside the result');
});
