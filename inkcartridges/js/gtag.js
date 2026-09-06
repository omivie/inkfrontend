/**
 * GTAG.JS
 * =======
 * Google Analytics initialization (extracted from inline scripts for CSP compliance)
 */
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('consent', 'default', {
    analytics_storage: localStorage.getItem('cookie_consent') === 'accepted' ? 'granted' : 'denied'
});
gtag('js', new Date());
// cookie_flags ensures first-party GA/Ads cookies (_ga, _gcl_au) carry the
// Secure attribute — the site is HTTPS-only (HSTS in vercel.json), so Secure
// is always honoured. Google's documented mechanism for flagging the
// conversion-linker cookie (FE audit Jun 2026, ERR-049).
const GTAG_COOKIE_FLAGS = { cookie_flags: 'SameSite=None;Secure' };
gtag('config', 'G-SDQELG0FGD', GTAG_COOKIE_FLAGS);
gtag('config', 'G-YJXTSGLM28', GTAG_COOKIE_FLAGS);
gtag('config', 'AW-18032498762', GTAG_COOKIE_FLAGS);

// First-party traffic tracker — loaded alongside GA so it lands on every page
// that already includes gtag.js. Skips admin pages internally.
(function loadTrafficTracker() {
    try {
        const s = document.createElement('script');
        s.src = '/js/traffic-tracker.js';
        s.defer = true;
        (document.head || document.documentElement).appendChild(s);
    } catch (_) { /* non-fatal */ }
})();

/* ═══════════════════════════════════════════════════════════════════════════
 * GOOGLE ADS CONVERSIONS — one owner for the label vocabulary
 * (add-to-cart-tracking-fe-handoff-sep2026 §1 · ERR-223)
 *
 * WHY THIS LIVES IN gtag.js
 * -------------------------
 * It needs to exist on every page a shopper can add to cart from. `cart.js` is
 * loaded on 33 pages; a NEW script would need 33 new <script> tags, and that is
 * exactly how ERR-194 happened — `cart-analytics.js` sat on THREE pages behind
 * `typeof CartAnalytics !== 'undefined'`, so the guard was an off-switch at
 * every real add-to-cart entry point and `add_to_cart` recorded 56 events in its
 * entire history. gtag.js is already on 38 of 43 pages, a measured strict
 * superset of the 33 that load cart.js, and it is a HEAD script, so it is
 * defined before any body script runs. Pinned by
 * tests/ads-add-to-cart-conversion-sep2026.test.js §2.
 *
 * WHY THE EVENT NAME IS 'conversion' AND NOT 'add_to_cart'
 * --------------------------------------------------------
 * The hand-off wrote `gtag('event','add_to_cart', {send_to})`. Google's own
 * snippet generated for this account's action uses `'conversion'`. What routes
 * the hit is `send_to` + the label, not the event name; we use the form the
 * account generates.
 *
 * THE 'Shopping Cart' ACTION MUST STAY SECONDARY. id 7710654861,
 * primary_for_goal:false, include_in_conversions_metric:false. It is a funnel
 * diagnostic. Promoting it makes Smart Bidding optimise toward add-to-carts
 * instead of purchases.
 * ═══════════════════════════════════════════════════════════════════════════ */
const ADS = {
    TAG_ID: 'AW-18032498762',
    // action 7558732273 · WEBPAGE · PURCHASE · primary. Fired by
    // order-confirmation-page.js, which deliberately keeps its own literal —
    // that is live money behind three tested guards and this registry must not
    // be able to move it. A drift test asserts the two are identical.
    PURCHASE: 'AW-18032498762/W1laCPGzpJQcEMqwyJZD',
    // action 7710654861 · was WEBPAGE_CODELESS · ADD_TO_CART · SECONDARY.
    // Never fired once in ~6 months: codeless detection scrapes for a page load
    // that an SPA add-to-cart does not produce.
    ADD_TO_CART: 'AW-18032498762/e3c8CI2D3dwcEMqwyJZD',
};

const AdsConversions = {
    LABELS: ADS,

    /**
     * Google Ads add-to-cart conversion.
     *
     * CALL THIS ONLY AFTER `POST /api/cart/items` HAS RETURNED 2xx, and pass the
     * SERVER's own numbers. Never on click, never optimistically, and never on a
     * failed add — an out-of-stock or inactive-pack rejection that records a
     * conversion is a conversion that did not happen, in the account the owner
     * bids real money from.
     *
     * @param {object} confirmed - `response.data` from the add-to-cart call:
     *   `{ price_snapshot, quantity, product: { sku } }`. Shape verified against
     *   production 2026-09-06. NOTE `quantity` is the RESULTING LINE TOTAL, not
     *   the amount added — see below.
     * @param {object} context - `{ priorQuantity, requestedQuantity }` from the
     *   cart, so the amount ACTUALLY ADDED can be derived.
     * @returns {{sent: boolean, reason?: string, value?: number}} The result is
     *   structured rather than boolean so partialness is in the RETURN VALUE and
     *   a test can assert on it. Nothing here throws: an analytics tag is never
     *   worth breaking an add-to-cart over.
     */
    addToCart(confirmed, context) {
        try {
            if (typeof gtag !== 'function') return { sent: false, reason: 'no-gtag' };
            if (!confirmed || typeof confirmed !== 'object') return { sent: false, reason: 'no-payload' };

            const product = confirmed.product || {};
            const sku = typeof product.sku === 'string' ? product.sku.trim() : '';
            if (!sku) return { sent: false, reason: 'no-sku' };

            /* QUANTITY IS A DELTA, AND THE SERVER REPORTS A TOTAL.
             *
             * `confirmed.quantity` is the RESULTING LINE TOTAL, not the amount
             * added. Measured in a real browser 2026-09-06: a line already
             * holding 2, add 1 more, and the response says `quantity: 3` — so
             * sending it straight through reported a THREE-unit add-to-cart at
             * $290.97 for a shopper who added ONE $96.99 cartridge. Triple the
             * true value, into the account the owner bids from, silently and
             * every single time a shopper adds to something already in the cart.
             * The unit tests could not see it; only a second add to the same
             * line exposes it, which is why this needed a browser.
             *
             * So the delta is derived, and it is derived CONSERVATIVELY. The
             * server total minus what the line held is the truth when both are
             * trustworthy; the requested amount is the fallback. It is capped at
             * the requested amount because the local cart can be stale-low (the
             * server may hold a line from another device), and an inflated delta
             * over-reports — the one direction that costs real money. A clamp
             * the other way is honoured: if stock limited a 5 to a 2, the delta
             * really is 2 and that is what is reported.
             */
            const ctx = context || {};
            const requested = Number(ctx.requestedQuantity);
            const requestedQty = Number.isFinite(requested) && requested > 0 ? requested : 1;
            const prior = Number(ctx.priorQuantity);
            const priorQty = Number.isFinite(prior) && prior > 0 ? prior : 0;

            const serverTotal = Number(confirmed.quantity);
            const delta = Number.isFinite(serverTotal) ? serverTotal - priorQty : NaN;
            const quantity = (Number.isFinite(delta) && delta > 0 && delta <= requestedQty)
                ? delta
                : requestedQty;

            // PRICE COMES FROM THE SERVER OR NOT AT ALL.
            //
            // `price_snapshot` is what the shopper is actually being charged —
            // the volume/contract-aware figure — as opposed to `retail_price`,
            // which is list. Both are GST-INCLUSIVE and stay that way: the ad
            // platform wants the shopper-facing price, so there is deliberately
            // no /1.15 anywhere in this function.
            //
            // The local `product.price` a card was rendered from is NOT an
            // acceptable substitute. This frontend never computes a price, and a
            // number invented for an ad platform is worse than a missing one —
            // it is wrong, it is silent, and it is what the account bids on. So
            // a missing snapshot still fires the conversion (the add really did
            // happen and the funnel rung is the point of this tag) but carries
            // no `value`, and says so in the return.
            //
            // Number(null) IS 0, and so is Number(''). Coercing first and
            // range-checking after would turn "the server did not report a
            // price" into a confident $0.00 conversion — the ERR-219/ERR-068
            // absence-as-zero shape, here pointed at an ad platform. So the
            // TYPE is checked before any coercion, and a genuine 0 still
            // reports as 0.
            const raw = confirmed.price_snapshot;
            const snap = typeof raw === 'number'
                ? raw
                : (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN);
            const hasValue = Number.isFinite(snap) && snap >= 0;

            const params = {
                send_to: ADS.ADD_TO_CART,
                currency: 'NZD',
                items: [{
                    id: sku,
                    google_business_vertical: 'retail',
                    quantity: quantity,
                }],
            };
            if (hasValue) params.value = snap * quantity;

            gtag('event', 'conversion', params);

            return hasValue
                ? { sent: true, value: params.value }
                : { sent: true, reason: 'no-price' };
        } catch (err) {
            // A thrown tag must never take an add-to-cart with it.
            if (typeof DebugLog !== 'undefined') DebugLog.warn('Ads add_to_cart failed (non-fatal):', err);
            return { sent: false, reason: 'threw' };
        }
    },
};

if (typeof window !== 'undefined') window.AdsConversions = AdsConversions;
