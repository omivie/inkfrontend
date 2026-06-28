/**
 * Loyalty: Stamp Card → Points (June 2026)
 * ========================================
 *
 * Pins the migration from the 6-stamp punch card to a points programme:
 *
 *   - API:    applyLoyaltyPoints / removeLoyaltyPoints (POST/DELETE /api/cart/loyalty),
 *             getLoyalty (GET /api/user/loyalty); legacy getStampCard removed.
 *   - Cart:   reads cart.loyalty (not stamp_card); renders summary loyalty line.
 *   - Cart/checkout: a points control (amount + Max + Apply/Remove) beside the
 *             coupon UI, mutually exclusive with coupons; full error-code mapping.
 *   - Payment: read-only loyalty line + 409 INSUFFICIENT_POINTS handling.
 *   - Account loyalty page: balance + dual-line savings graph + ledger history +
 *             reward coupons. No stamp/Silver/Gold. No redeem widget.
 *
 * Run with: node --test tests/loyalty-points-jun2026.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..', 'inkcartridges');
const JS = (rel) => fs.readFileSync(path.join(ROOT, 'js', rel), 'utf8');
const HTML = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// API layer
// ─────────────────────────────────────────────────────────────────────────────

test('api.js: cart-redemption + balance methods exist with the right endpoints', () => {
    const src = JS('api.js');
    assert.match(src, /async applyLoyaltyPoints\(points\)\s*{[\s\S]*?post\('\/api\/cart\/loyalty',\s*{\s*points\s*}\)/, 'applyLoyaltyPoints must POST /api/cart/loyalty { points }');
    assert.match(src, /async removeLoyaltyPoints\(\)\s*{[\s\S]*?delete\('\/api\/cart\/loyalty'\)/, 'removeLoyaltyPoints must DELETE /api/cart/loyalty');
    assert.match(src, /async getLoyalty\([\s\S]*?\)\s*{[\s\S]*?\/api\/user\/loyalty\?/, 'getLoyalty must GET /api/user/loyalty with query');
});

test('api.js: legacy getStampCard is gone, loyalty-coupons kept', () => {
    const src = JS('api.js');
    assert.doesNotMatch(src, /getStampCard/, 'getStampCard must be removed');
    assert.doesNotMatch(src, /\/api\/user\/stamp-card/, '/api/user/stamp-card must not be called');
    assert.match(src, /getLoyaltyCoupons[\s\S]*?\/api\/user\/loyalty-coupons/, 'getLoyaltyCoupons kept');
});

// ─────────────────────────────────────────────────────────────────────────────
// Cart state + summary (cart.js)
// ─────────────────────────────────────────────────────────────────────────────

test('cart.js: parses cart.loyalty and drops stamp_card', () => {
    const src = JS('cart.js');
    assert.match(src, /responseData\.loyalty/, 'must read responseData.loyalty');
    assert.match(src, /loyalty:\s*null/, 'Cart.loyalty state field must exist');
    assert.doesNotMatch(src, /stamp_card/, 'stamp_card must be gone');
    assert.doesNotMatch(src, /stampCard/, 'stampCard field must be gone');
    assert.doesNotMatch(src, /_renderStampCardChip/, '_renderStampCardChip must be gone');
    assert.match(src, /_renderLoyaltyChip/, '_renderLoyaltyChip must exist');
});

test('cart.js: summary renders loyalty_discount_amount without double-counting savings', () => {
    const src = JS('cart.js');
    assert.match(src, /loyalty_discount_amount/, 'summary must read loyalty_discount_amount');
    assert.match(src, /cart-loyalty-row/, 'must target the cart loyalty summary row');
    // "You Save" must net out the loyalty portion so it isn't shown twice.
    assert.match(src, /discount\s*-\s*loyaltyDiscount/, 'other savings must subtract the loyalty discount');
});

// ─────────────────────────────────────────────────────────────────────────────
// Cart-page control (cart-page.js)
// ─────────────────────────────────────────────────────────────────────────────

test('cart-page.js: loyalty control wired (init/render, Max, error codes)', () => {
    const src = JS('cart-page.js');
    assert.match(src, /function initLoyaltyControl\(/, 'initLoyaltyControl must exist');
    assert.match(src, /function renderCartLoyaltyControl\(/, 'renderCartLoyaltyControl must exist (called from cart.js)');
    assert.match(src, /initLoyaltyControl\(\)/, 'initLoyaltyControl must be invoked on load');
    assert.match(src, /max_redeemable_points/, 'Max button must use max_redeemable_points');
    assert.match(src, /applyLoyaltyPoints/, 'must call API.applyLoyaltyPoints');
    assert.match(src, /removeLoyaltyPoints/, 'must call API.removeLoyaltyPoints');
    for (const code of ['CONFLICTS_WITH_COUPON', 'BELOW_MIN_POINTS', 'EXCEEDS_AVAILABLE_BALANCE', 'EXCEEDS_CART_SUBTOTAL', 'NOT_MULTIPLE_OF_100', 'RATE_LIMITED', 'EMAIL_NOT_VERIFIED', 'LOYALTY_DISABLED']) {
        assert.match(src, new RegExp(code), `must handle ${code}`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Checkout + payment
// ─────────────────────────────────────────────────────────────────────────────

test('checkout-page.js: loyalty handler + summary line', () => {
    const src = JS('checkout-page.js');
    assert.match(src, /setupLoyaltyHandler\(\)/, 'setupLoyaltyHandler must be invoked');
    assert.match(src, /setupLoyaltyHandler\(\)\s*{/, 'setupLoyaltyHandler must be defined');
    assert.match(src, /checkout-loyalty-row/, 'checkout summary must include a loyalty row');
    assert.match(src, /loyaltyDiscount/, 'totals must carry a loyaltyDiscount');
    assert.match(src, /CONFLICTS_WITH_COUPON/, 'must map the coupon-conflict code');
});

test('payment-page.js: read-only loyalty line + INSUFFICIENT_POINTS on order create', () => {
    const src = JS('payment-page.js');
    assert.match(src, /checkout-loyalty-row/, 'payment summary must show the loyalty line');
    assert.match(src, /loyalty_discount_amount/, 'must read loyalty_discount_amount from summary');
    assert.match(src, /INSUFFICIENT_POINTS/, 'must handle 409 INSUFFICIENT_POINTS on createOrder');
});

// ─────────────────────────────────────────────────────────────────────────────
// Loyalty page controller (loyalty-page.js)
// ─────────────────────────────────────────────────────────────────────────────

test('loyalty-page.js: points page, no stamp/tier vocabulary, no redeem widget', () => {
    const src = JS('loyalty-page.js');
    assert.doesNotMatch(src, /stamp/i, 'no stamp vocabulary');
    assert.doesNotMatch(src, /Silver|Gold/, 'no Silver/Gold tier vocabulary');
    assert.match(src, /getLoyalty\(/, 'must fetch balance/ledger via getLoyalty');
    assert.match(src, /redemption_rate/, 'must read the server-driven redemption_rate');
    assert.match(src, /min_redemption_points/, 'must read the server-driven minimum');
    // No coupon-mint redemption on the account page (redemption is at checkout).
    assert.doesNotMatch(src, /redeemLoyaltyPoints|\/loyalty\/redeem/, 'account page must not mint redemption coupons');
});

test('loyalty-page.js: graph derives points-accrued from ledger and savings from order.discount_amount', () => {
    const src = JS('loyalty-page.js');
    assert.match(src, /type === 'earn'[\s\S]{0,40}type === 'bonus'/, 'accrual series filters earn + bonus ledger rows');
    assert.match(src, /discount_amount/, 'savings series uses order.discount_amount (NOT subtotal − total)');
    assert.doesNotMatch(src, /Number\(o\.subtotal\)[\s\S]{0,20}Number\(o\.total\)/, 'must not compute savings as subtotal − total');
    assert.match(src, /<polyline/, 'renders inline SVG polylines (no external chart library)');
});

// ─────────────────────────────────────────────────────────────────────────────
// HTML surfaces
// ─────────────────────────────────────────────────────────────────────────────

test('loyalty.html: points page scaffolding, no stamp markup, nav relabelled', () => {
    const src = HTML('html/account/loyalty.html');
    assert.doesNotMatch(src, /stamp/i, 'no stamp markup');
    assert.doesNotMatch(src, /Silver|Gold/, 'no tier markup');
    for (const id of ['loyalty-balance-section', 'loyalty-graph', 'loyalty-history-list', 'loyalty-rewards-list']) {
        assert.match(src, new RegExp(`id="${id}"`), `must contain #${id}`);
    }
    assert.match(src, /Loyalty Points/, 'page must be relabelled "Loyalty Points"');
    assert.doesNotMatch(src, /Loyalty Card/, 'no "Loyalty Card" label left');
});

test('cart.html + checkout.html: loyalty control + summary row present', () => {
    for (const rel of ['html/cart.html', 'html/checkout.html']) {
        const src = HTML(rel);
        assert.match(src, /id="cart-loyalty"/, `${rel} must have the loyalty control`);
        assert.match(src, /id="cart-loyalty-max"/, `${rel} must have the Max button`);
    }
    assert.match(HTML('html/cart.html'), /id="cart-loyalty-row"/, 'cart summary loyalty row');
    assert.match(HTML('html/checkout.html'), /id="checkout-loyalty-row"/, 'checkout summary loyalty row');
    assert.match(HTML('html/payment.html'), /id="checkout-loyalty-row"/, 'payment summary loyalty row');
    assert.doesNotMatch(HTML('html/cart.html'), /cart-stamp-card-chip/, 'old stamp chip id gone from cart');
});

test('account sidebar nav relabelled "Loyalty Points" across pages', () => {
    for (const rel of ['html/account/index.html', 'html/account/orders.html', 'html/account/settings.html']) {
        const src = HTML(rel);
        assert.doesNotMatch(src, /Loyalty Card/, `${rel} must not say "Loyalty Card"`);
        assert.match(src, /Loyalty Points/, `${rel} must say "Loyalty Points"`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// RUNTIME: the loyalty page renders a dual-line SVG from ledger + orders.
// ─────────────────────────────────────────────────────────────────────────────

function runLoyaltyPage(loyaltyData, coupons, orders, opts = {}) {
    const els = {};
    // Panes/sections start hidden in the real HTML; mirror that so "did the
    // controller reveal it?" is a meaningful assertion.
    const makeEl = () => ({
        hidden: true, innerHTML: '', textContent: '', disabled: false,
        style: {}, dataset: {},
        classList: { add() {}, remove() {}, toggle() {} },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        addEventListener() {},
    });
    const domHandlers = [];
    const sandbox = {
        console, Math, JSON, Date, Promise, Error, Object, Array, String, Number, Boolean, RegExp, isNaN,
        setTimeout: (fn) => { fn(); return 0; },
        clearTimeout() {},
        URLSearchParams,
        formatPrice: (n) => '$' + Number(n || 0).toFixed(2),
        Security: { escapeHtml: (s) => String(s == null ? '' : s) },
        DebugLog: { log() {}, warn() {}, error() {} },
        Auth: { isAuthenticated: () => true, waitForReady: async () => {} },
        API: {
            getLoyalty: async () => {
                if (opts.loyaltyFails) return { ok: false, code: 'NOT_FOUND', error: 'not found' };
                return { ok: true, data: loyaltyData, meta: { page: 1, total_pages: 1 } };
            },
            getLoyaltyCoupons: async () => ({ ok: true, data: coupons }),
            getOrders: async () => ({ ok: true, data: orders }),
            extractErrorMessage: (_e, f) => f,
        },
        document: {
            getElementById(id) { if (!els[id]) els[id] = makeEl(); return els[id]; },
            addEventListener(ev, cb) { if (ev === 'DOMContentLoaded') domHandlers.push(cb); },
            body: { style: {} },
        },
        window: {},
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(JS('loyalty-page.js'), ctx, { filename: 'loyalty-page.js' });
    return { els, run: async () => { for (const cb of domHandlers) { await cb(); } } };
}

test('runtime: graph draws both series (points accrued + order savings)', async () => {
    const loyalty = {
        program_active: true,
        points_balance: 600,
        points_value_dollars: 6,
        lifetime_earned: 600,
        redemption_rate: 100,
        min_redemption_points: 500,
        ledger: [
            { type: 'earn', points: 40, balance_after: 600, created_at: '2026-01-02T00:00:00Z' },
            { type: 'bonus', points: 200, balance_after: 200, created_at: '2026-01-01T00:00:00Z' },
        ],
    };
    const orders = [
        { created_at: '2026-01-03T00:00:00Z', subtotal: 90, total: 57, discount_amount: 33 },
        { created_at: '2026-01-05T00:00:00Z', subtotal: 50, total: 50, discount_amount: 0 },
    ];
    const { els, run } = runLoyaltyPage(loyalty, [], orders);
    await run();

    assert.equal(els['loyalty-loading'].hidden, true, 'loading hidden after render');
    assert.equal(els['loyalty-balance-points'].textContent, '600', 'balance points rendered');
    const svg = els['loyalty-graph'].innerHTML;
    const polylines = (svg.match(/<polyline/g) || []).length;
    assert.equal(polylines, 2, 'both the accrued and savings polylines render');
    assert.match(svg, /loyalty-chart__line--accrued/, 'accrued line present');
    assert.match(svg, /loyalty-chart__line--savings/, 'savings line present');
});

test('runtime: empty balance + no history shows the empty state, not the graph', async () => {
    const loyalty = { program_active: true, points_balance: 0, redemption_rate: 100, min_redemption_points: 500, ledger: [] };
    const { els, run } = runLoyaltyPage(loyalty, [], []);
    await run();
    assert.equal(els['loyalty-empty'].hidden, false, 'empty state shown');
});

test('runtime: a "restore" ledger row renders as "Restored" with a + sign', async () => {
    const loyalty = {
        program_active: true, points_balance: 500, redemption_rate: 100, min_redemption_points: 500,
        ledger: [{ type: 'restore', points: 500, balance_after: 500, created_at: '2026-02-01T00:00:00Z' }],
    };
    const { els, run } = runLoyaltyPage(loyalty, [], []);
    await run();
    const history = els['loyalty-history-list'].innerHTML;
    assert.match(history, /Restored/, 'restore row labelled "Restored"');
    assert.match(history, /\+500 pts/, 'restore row shows a + sign (credit)');
});

test('runtime: getLoyalty unavailable → soft notice + savings graph + coupons still render (no hard error)', async () => {
    const orders = [
        { created_at: '2026-01-03T00:00:00Z', subtotal: 90, total: 57, discount_amount: 12 },
        { created_at: '2026-01-08T00:00:00Z', subtotal: 60, total: 45, discount_amount: 8 },
    ];
    const coupons = [{ coupon: { code: 'POINTS-AB12CD', discount_type: 'fixed_amount', discount_value: 5 }, status: 'active' }];
    const { els, run } = runLoyaltyPage(null, coupons, orders, { loyaltyFails: true });
    await run();

    const errEl = els['loyalty-error'];
    assert.ok(!errEl || errEl.hidden === true, 'no hard error pane when orders/coupons exist');
    assert.equal(els['loyalty-balance-unavailable'].hidden, false, 'soft balance-unavailable notice shown');
    // Savings graph still draws the order-savings line (from /api/orders alone).
    const svg = els['loyalty-graph'].innerHTML;
    assert.match(svg, /loyalty-chart__line--savings/, 'order-savings line renders without the ledger');
    assert.doesNotMatch(svg, /loyalty-chart__line--accrued/, 'no points-accrued line without the ledger');
    // Coupons still render.
    assert.match(els['loyalty-rewards-list'].innerHTML, /POINTS-AB12CD/, 'reward coupons still render');
});

test('runtime: everything unavailable (points down, no orders, no coupons) → hard error pane', async () => {
    const { els, run } = runLoyaltyPage(null, [], [], { loyaltyFails: true });
    await run();
    assert.equal(els['loyalty-error'].hidden, false, 'hard error pane shown when nothing is available');
});

// ─────────────────────────────────────────────────────────────────────────────
// Account dashboard balance (account.js + account/index.html) — Jun 2026
// The dashboard loyalty card surfaces the live points balance at a glance, not
// just a link to the dedicated page.
// ─────────────────────────────────────────────────────────────────────────────

test('account.js: loadLoyaltyBalance fetches getLoyalty and renders into the dashboard card', () => {
    const src = JS('account.js');
    assert.match(src, /loadLoyaltyBalance\(\)/, 'loadDashboard must invoke loadLoyaltyBalance');
    assert.match(src, /async loadLoyaltyBalance\(\)\s*{/, 'loadLoyaltyBalance must be defined');
    assert.match(src, /getElementById\('dash-loyalty-balance'\)/, 'must target #dash-loyalty-balance');
    assert.match(src, /API\.getLoyalty\(/, 'must call API.getLoyalty');
    assert.match(src, /points_balance/, 'must read points_balance');
    assert.match(src, /redemption_rate/, 'must read the server-driven redemption_rate (not hardcode the value)');
    // Graceful: bail when the balance is zero/unknown so the card stays a plain link.
    assert.match(src, /balance\s*<=\s*0/, 'must hide the balance when zero/unknown');
});

test('account/index.html: dashboard loyalty card has the balance element', () => {
    const src = HTML('html/account/index.html');
    assert.match(src, /id="dash-loyalty-balance"/, 'dashboard must contain #dash-loyalty-balance');
});

// ─────────────────────────────────────────────────────────────────────────────
// Order confirmation: points earned + redemption applied (Jun 2026)
// ─────────────────────────────────────────────────────────────────────────────

test('order-confirmation-page.js: passes through loyalty fields and renders both totals rows', () => {
    const src = JS('order-confirmation-page.js');
    // transformAPIOrder normalises the backend fields (defensive on naming).
    assert.match(src, /loyaltyDiscount:/, 'transform must expose loyaltyDiscount');
    assert.match(src, /pointsEarned:/, 'transform must expose pointsEarned');
    assert.match(src, /loyalty_discount_amount/, 'must read loyalty_discount_amount');
    assert.match(src, /points_earned/, 'must read points_earned');
    // renderTotals populates the rows.
    assert.match(src, /totals-loyalty-row/, 'must drive the applied-points row');
    assert.match(src, /totals-earned-row/, 'must drive the points-earned row');
    // Earn estimate mirrors the backend basis: order value ex-shipping, not ex-GST subtotal.
    assert.match(src, /Number\(total\)[\s\S]{0,40}Number\(shippingCost\)/, 'estimate basis is total − shipping');
    assert.match(src, /≈/, 'estimated (non-backend) earn is marked with ≈');
});

test('order-confirmation.html: totals has loyalty-applied and points-earned rows', () => {
    const src = HTML('html/order-confirmation.html');
    assert.match(src, /id="totals-loyalty-row"[\s\S]*?hidden/, 'applied-points row present and hidden by default');
    assert.match(src, /id="totals-earned-row"[\s\S]*?hidden/, 'points-earned row present and hidden by default');
    assert.match(src, /id="totals-loyalty"/, 'applied-points value element present');
    assert.match(src, /id="totals-earned"/, 'points-earned value element present');
});
