/**
 * ORDER-TOTALS.JS
 * ===============
 * ONE source of truth for how a customer-facing ORDER's money is read and
 * displayed. Shared by:
 *
 *   - js/order-confirmation-page.js   (/order-confirmation)
 *   - js/order-detail-page.js         (/account/order-detail)
 *   - js/order-receipt.js             (the downloadable receipt PDF)
 *
 * WHY THIS FILE EXISTS (Jul 2026)
 * -------------------------------
 * Those three surfaces each had their own money code, and they disagreed:
 *   - order-detail printed `order.subtotal || order.total`, i.e. the TOTAL under
 *     the "Subtotal" label whenever subtotal was absent, and had no discount row
 *     at all — so a loyalty-redeemed order's figures did not add up on screen.
 *   - order-confirmation reimplemented the backend's points-earn rule
 *     (`floor(total - shipping)`) and treated UNKNOWN shipping as free, which
 *     overstated the estimate by the shipping amount.
 *   - the receipt PDF did not exist.
 * Three copies of one rule, two of them wrong, is the whole bug. Row order,
 * labels, visibility and fail-soft behaviour are now encoded exactly once here.
 *
 * NOT the same as cart.js's computeDiscountBreakdown(). That reads the live CART
 * `summary` contract; this reads an ORDER row. Keeping them separate is
 * deliberate — the receipt PDF must not depend on the stateful Cart singleton.
 *
 * THE ONE RULE: null means NOT REPORTED. 0 means REPORTED AS ZERO.
 * ---------------------------------------------------------------
 * They are never collapsed into each other. A missing `shipping_fee` is not
 * free shipping; a missing `gst_amount` is not $0.00 of GST; an unknown earn
 * basis is not "0 points". Every one of those renders as an em-dash, a
 * fail-soft label, or an omitted row — never as a confident zero. (This is the
 * ERR-063/068/073/075/076 family: absence-as-zero is the recurring defect on
 * this codebase, so the primitives below make it hard to write.)
 *
 * PRICING RULE (DEC-004): the backend owns every figure. `pointsEarnedEstimate`
 * is the single exception and it is labelled as an estimate at every call site;
 * it exists only until the backend exposes `points_earned` on the order (BF-011,
 * readfirst/loyalty-retro-claim-jul2026.md), at which point delete it.
 *
 * Pure: no DOM, no I/O, no escaping. Returns data; callers escape and format.
 */

'use strict';

(function () {
    // GST is a component of the displayed (GST-inclusive) figures, not an
    // addition to them — hence the "Included" fail-soft rather than "$0.00".
    const GST_LABEL = 'GST (15%)';

    /**
     * Number, or null when not reported. The whole honesty contract rests here:
     * `undefined`, `null`, `''`, `NaN` and `'abc'` all become null, and only a
     * genuinely finite number survives. 0 survives, because 0 is an answer.
     */
    const num = (v) => {
        if (v === null || v === undefined || v === '') return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    };

    /** First reported value among candidates, else null. */
    const pick = (...candidates) => {
        for (const v of candidates) {
            const n = num(v);
            if (n !== null) return n;
        }
        return null;
    };

    /** First non-empty string among candidates, else null. */
    const pickStr = (...candidates) => {
        for (const v of candidates) {
            if (typeof v === 'string' && v.trim() !== '') return v.trim();
        }
        return null;
    };

    /** Positive numbers only — used for "show this row at all?" decisions. */
    const positive = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0;

    /**
     * Money for display. Delegates to the shared formatPrice() (api.js) so the
     * NZD/en-NZ convention lives in one place; the fallback mirrors the `money`
     * shim in js/admin/pages/invoices.js for contexts where api.js is absent.
     */
    function format(n) {
        const v = num(n);
        if (v === null) return '—';
        if (typeof window !== 'undefined' && typeof window.formatPrice === 'function') {
            return window.formatPrice(v);
        }
        return '$' + v.toFixed(2);
    }

    /** Points count for display, e.g. 1234 -> "1,234". */
    function formatPoints(n) {
        const v = num(n);
        if (v === null) return '—';
        return Math.round(v).toLocaleString('en-NZ');
    }

    /**
     * Fold display glyphs down to characters jsPDF's standard fonts can encode.
     *
     * jsPDF's built-in fonts (times/helvetica) use WinAnsi/cp1252. The em-dash
     * is in cp1252, but U+2248 ALMOST EQUAL TO ("≈") and U+2212 MINUS SIGN are
     * not — they render as garbage or vanish silently. The DOM wants the real
     * glyphs, the PDF wants these substitutes, so the mapping lives here rather
     * than being re-guessed in the PDF builder.
     */
    function ascii(str) {
        return String(str === null || str === undefined ? '' : str)
            .replace(/\u2248/g, '~')            // almost equal -> tilde
            .replace(/\u2212/g, '-')            // minus sign   -> hyphen
            .replace(/[\u2013\u2014]/g, '-')    // en/em dash   -> hyphen
            .replace(/[\u2018\u2019]/g, "'")   // curly single -> apostrophe
            .replace(/[\u201c\u201d]/g, '"')   // curly double -> quote
            .replace(/\u2026/g, '...')          // ellipsis
            .replace(/\u00a0/g, ' ')            // nbsp         -> space
            .replace(/\u2b50/g, '*');           // star         -> asterisk
    }

    /**
     * Normalise ANY order-ish payload into one flat, honest money shape.
     *
     * Accepts three shapes, because all three reach these surfaces:
     *   1. the raw `GET /api/orders/{n}` row (snake_case, `order_items[]`)
     *   2. order-confirmation-page.js's transformAPIOrder() output (camelCase,
     *      `items[]`) — which is ALSO what gets written to sessionStorage by
     *      payment-page.js#buildOrderSnapshot() and read back on the offline
     *      fallback path, so this shape is not hypothetical
     *   3. a partial mix of the two
     *
     * @param {object|null} order
     * @returns {object} see the docblock fields below; every money field is
     *                   `number|null` and null means NOT REPORTED.
     */
    function normalise(order) {
        const o = order && typeof order === 'object' ? order : {};

        const subtotal = pick(o.subtotal, o.subtotal_amount, o.sub_total);
        const shipping = pick(
            o.shipping_fee, o.shipping_cost, o.shippingCost,
            o.shipping_amount, o.freight,
            // LAST, and deliberately so: on a raw API order `shipping` is the tier
            // NAME ("Standard Shipping"), which num() rejects as non-finite. On
            // this function's OWN output it is the numeric cost. Reading it last
            // makes normalise() idempotent without letting a tier name win over a
            // real figure.
            o.shipping
        );
        const gstAmount = pick(o.gst_amount, o.gstAmount, o.tax_amount);
        const total = pick(o.total, o.total_amount, o.grand_total);

        const loyaltyDiscount = pick(
            o.loyalty_discount_amount,
            o.loyaltyDiscount,
            o.loyalty && o.loyalty.discount_amount
        );
        // The POINT COUNT, distinct from the dollar figure above. Exposed by the
        // backend on the order row but read nowhere before Jul 2026, so the
        // applied row could say "-$5.00" but never "500 pts".
        const loyaltyPoints = pick(
            o.loyalty_points_redeemed,
            o.loyaltyPoints,
            o.loyalty && o.loyalty.points_redeemed
        );

        // Volume discount: several live payload shapes, same as
        // computeDiscountBreakdown() — whichever source carries the object is the
        // metadata, whichever is numeric is the amount. See cart.js.
        // `volume_discount` is the current field name and `b2bMeta` is this
        // function's OWN output (normalise must stay idempotent).
        //
        // `b2b_discount` IS DELIBERATELY STILL READ HERE (ERR-158). The backend
        // dropped that alias on 2026-08-10 and cart.js/payment-page.js stopped
        // reading it — but this function normalises ORDERS, which is a different
        // payload with a different lifetime. The backend's note covers the cart
        // response only, and an order placed before the cutover keeps whatever
        // spelling it was stored with, forever. Removing it here would silently
        // zero the volume-discount row on historical receipts and order-detail
        // pages, where nobody would notice because the totals still add up.
        // Do not "finish the job" without first confirming, against a real
        // pre-August order, that the order payload never carries this key.
        const isObj = (v) => !!v && typeof v === 'object';
        const b2bMeta = [o.volume_discount, o.b2b_discount, o.b2bMeta].find(isObj) || null;
        const b2bDiscount = pick(
            b2bMeta && b2bMeta.discount_amount,
            o.volume_discount_amount,
            o.b2b_discount_amount,
            o.b2bDiscount,
            typeof o.volume_discount === 'number' ? o.volume_discount : null,
            typeof o.b2b_discount === 'number' ? o.b2b_discount : null,
            o.business_discount_amount
        );

        // `discount_amount` is the AGGREGATE of every discount (coupon + loyalty
        // + B2B), documented at loyalty-page.js:262-265. The coupon/other slice
        // is what is left once the rows that get their own line are netted out —
        // exactly the `other` in cart.js's computeDiscountBreakdown, so the
        // shopper never sees the same dollars twice.
        const discountTotal = pick(o.discount_amount, o.discount, o.discountTotal);
        const otherDiscount = discountTotal !== null
            ? Math.max(0, discountTotal - (loyaltyDiscount || 0) - (b2bDiscount || 0))
            // IDEMPOTENCE: normalise() must be safe to run on its OWN output.
            // order-confirmation-page.js normalises once in transformAPIOrder and
            // again in renderTotals, and the transform does not carry
            // `discount_amount` forward — so without this the coupon row silently
            // vanished on the second pass. Caught in a live browser, not by a unit
            // test, because both passes look correct in isolation.
            : pick(o.otherDiscount);
        const couponCode = pickStr(o.coupon_code, o.couponCode, o.promo_code);

        // Backend-confirmed earn. Absent today (BF-011).
        const pointsEarned = pick(
            o.points_earned,
            o.pointsEarned,
            o.loyalty_points_earned,
            o.loyalty && o.loyalty.points_earned
        );

        // THE HONEST ESTIMATE. Basis is the order value ex-shipping, matching
        // the backend's stated earn math ("same ex-shipping math as a real
        // member earn"). If EITHER input is unknown the estimate is null and the
        // row disappears — it does NOT fall back to treating shipping as free,
        // which is what the old code did (order-confirmation-page.js:589,
        // `order.shippingCost || order.shipping_cost || 0`) and which overstated
        // every estimate on an order whose shipping was not reported.
        const earnBasis = (total === null || shipping === null)
            ? null
            : Math.max(0, total - shipping);
        const pointsEarnedEstimate = earnBasis === null ? null : Math.floor(earnBasis);

        const rawItems = Array.isArray(o.order_items) ? o.order_items
            : (Array.isArray(o.items) ? o.items : []);
        const items = rawItems.map((it) => {
            const item = it && typeof it === 'object' ? it : {};
            const product = item.product && typeof item.product === 'object' ? item.product : {};
            const quantity = pick(item.quantity, item.qty);
            const unitPrice = pick(item.unit_price, item.unitPrice, item.price);
            return {
                sku: pickStr(item.product_sku, item.sku, product.sku),
                name: pickStr(item.product_name, item.name, product.name) || 'Item',
                quantity: quantity,
                unitPrice: unitPrice,
                // line_total is the backend's figure; qty x unit is a LABELLED
                // fallback (DEC-004), and null when neither is knowable.
                lineTotal: pick(item.line_total, item.lineTotal)
                    ?? ((quantity !== null && unitPrice !== null) ? quantity * unitPrice : null)
            };
        });

        // Reconciliation check, in the spirit of the dashboard margin-consistency
        // gate (ERR-113): any figure derivable from the others is cross-checked.
        // We do NOT rewrite the backend's numbers when they disagree — the
        // customer sees exactly what was charged — but callers can DebugLog.warn
        // so a broken payload is loud to us instead of silently not adding up.
        let footing = { checkable: false, reconciles: true, expected: null, delta: null };
        if (subtotal !== null && total !== null) {
            const expected = subtotal
                + (shipping || 0)
                - (loyaltyDiscount || 0)
                - (b2bDiscount || 0)
                - (otherDiscount || 0);
            const delta = Math.round((total - expected) * 100) / 100;
            footing = {
                checkable: true,
                reconciles: Math.abs(delta) < 0.02,
                expected: Math.round(expected * 100) / 100,
                delta: delta
            };
        }

        return {
            orderNumber: pickStr(o.order_number, o.orderNumber, o.id),
            createdAt: pickStr(o.created_at, o.createdAt) || null,
            invoiceNumber: pickStr(
                o.invoiceNumber,
                o.invoice && o.invoice.invoice_number,
                o.invoice_number
            ),
            email: pickStr(o.email, o.customer_email, o.guest_email),
            shippingAddress: (o.shipping_address && typeof o.shipping_address === 'object')
                ? o.shipping_address
                : ((o.shippingAddress && typeof o.shippingAddress === 'object') ? o.shippingAddress : null),
            items: items,
            subtotal: subtotal,
            shipping: shipping,
            gstAmount: gstAmount,
            total: total,
            loyaltyDiscount: loyaltyDiscount,
            loyaltyPoints: loyaltyPoints,
            b2bDiscount: b2bDiscount,
            b2bMeta: b2bMeta,
            otherDiscount: otherDiscount,
            couponCode: couponCode,
            discountTotal: discountTotal,
            pointsEarned: pointsEarned,
            pointsEarnedEstimate: pointsEarnedEstimate,
            footing: footing
        };
    }

    /**
     * The ordered, labelled summary rows — the single definition of what an
     * order's money looks like, walked identically by the DOM renderers and the
     * PDF builder so they cannot drift.
     *
     * @param {object} t  the output of normalise()
     * @returns {Array<{key:string,label:string,value:string,kind:string,note?:string,amount:(number|null)}>}
     *   kind: 'money' | 'free' | 'negative' | 'included' | 'unknown' | 'total' | 'points'
     */
    function rows(t) {
        const o = t && typeof t === 'object' ? t : {};
        const out = [];

        // Subtotal — always shown, em-dash when not reported (never $0.00).
        out.push(o.subtotal === null || o.subtotal === undefined
            ? { key: 'subtotal', label: 'Subtotal', value: '—', kind: 'unknown', amount: null }
            : { key: 'subtotal', label: 'Subtotal', value: format(o.subtotal), kind: 'money', amount: o.subtotal });

        // Shipping — three distinct states. "not reported" is NOT "free".
        if (o.shipping === null || o.shipping === undefined) {
            out.push({ key: 'shipping', label: 'Shipping', value: '—', kind: 'unknown', amount: null });
        } else if (o.shipping === 0) {
            out.push({ key: 'shipping', label: 'Shipping', value: 'FREE', kind: 'free', amount: 0 });
        } else {
            out.push({ key: 'shipping', label: 'Shipping', value: format(o.shipping), kind: 'money', amount: o.shipping });
        }

        // Loyalty redemption — omitted entirely unless something was redeemed.
        // The point count rides in the label when the backend reports it, so
        // "-$5.00" becomes "Loyalty points applied (500 pts)  -$5.00".
        if (positive(o.loyaltyDiscount)) {
            const label = positive(o.loyaltyPoints)
                ? `Loyalty points applied (${formatPoints(o.loyaltyPoints)} pts)`
                : 'Loyalty points applied';
            out.push({
                key: 'loyalty', label: label,
                value: '-' + format(o.loyaltyDiscount), kind: 'negative', amount: o.loyaltyDiscount
            });
        }

        // Volume discount. Not a "tier" — the flat bronze/silver/gold tiers were
        // retired with v2 (ERR-139); this is a per-line quantity discount, and the
        // label names the COMPANY only when the server supplied one. This row is
        // ungated, so the no-company fallback must not claim a business account
        // (ERR-149) — it is printed to whoever the server discounted.
        if (positive(o.b2bDiscount)) {
            const label = (typeof window !== 'undefined' && typeof window.businessDiscountLabel === 'function')
                ? window.businessDiscountLabel(o.b2bMeta)
                : 'Volume discount';
            out.push({
                key: 'b2b', label: label,
                value: '-' + format(o.b2bDiscount), kind: 'negative', amount: o.b2bDiscount
            });
        }

        // Whatever discount is left over once loyalty and B2B are netted out —
        // in practice a coupon. Code appended when reported.
        if (positive(o.otherDiscount)) {
            const label = o.couponCode ? `Discount (${o.couponCode})` : 'Discount';
            out.push({
                key: 'coupon', label: label,
                value: '-' + format(o.otherDiscount), kind: 'negative', amount: o.otherDiscount
            });
        }

        // GST. Reported -> the dollar component; not reported -> "Included",
        // which is true of NZ GST-inclusive retail pricing and is the correct
        // fail-soft. Never "$0.00", which would be a lie.
        out.push((o.gstAmount === null || o.gstAmount === undefined)
            ? { key: 'gst', label: GST_LABEL, value: 'Included', kind: 'included', amount: null }
            : { key: 'gst', label: GST_LABEL, value: format(o.gstAmount), kind: 'money', amount: o.gstAmount });

        out.push(o.total === null || o.total === undefined
            ? { key: 'total', label: 'Total Paid', value: '—', kind: 'unknown', amount: null }
            : { key: 'total', label: 'Total Paid', value: format(o.total), kind: 'total', amount: o.total });

        // Points earned. Backend figure wins; the estimate is clearly marked and
        // carries the reason it is an estimate. Both absent -> no row at all.
        const exact = positive(o.pointsEarned) ? o.pointsEarned : null;
        const estimate = exact === null && positive(o.pointsEarnedEstimate) ? o.pointsEarnedEstimate : null;
        if (exact !== null) {
            out.push({
                key: 'earned', label: 'Loyalty points earned',
                value: '+' + formatPoints(exact) + ' pts', kind: 'points', amount: exact
            });
        } else if (estimate !== null) {
            out.push({
                key: 'earned', label: 'Loyalty points earned',
                value: '≈ +' + formatPoints(estimate) + ' pts', kind: 'points', amount: estimate,
                note: "Estimate based on this order's value excluding shipping. "
                    + 'Your confirmed balance is on your Loyalty Points page.'
            });
        }

        return out;
    }

    const OrderTotals = {
        normalise: normalise,
        rows: rows,
        format: format,
        formatPoints: formatPoints,
        ascii: ascii,
        GST_LABEL: GST_LABEL
    };

    if (typeof window !== 'undefined') window.OrderTotals = OrderTotals;
    if (typeof module !== 'undefined' && module.exports) module.exports = OrderTotals;
})();
