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

/* ════════════════════════════════════════════════════════════════════════════
 * SHARED READERS — one owner for each "is this value real?" question
 *
 * Two tag families live in this file: Google Ads conversions (the account the
 * owner bids real money from) and GA4 ecommerce (the funnel). They are twins by
 * design — same moments, same values — and they are fed by the SAME server
 * payload. So every question about that payload is answered here, once.
 *
 * This is not tidying. If the delta or the price were derived twice, the two
 * platforms could disagree about the same event and nothing would say so: the
 * Ads number is in one account, the GA4 number is in another, and no assertion
 * spans both. Sharing the readers makes the agreement STRUCTURAL rather than a
 * coincidence that a test happens to catch on the inputs it thought of.
 * ════════════════════════════════════════════════════════════════════════════ */

/**
 * A money figure the server actually reported, or NaN.
 *
 * `Number(null)` IS 0, and so is `Number('')`. Coercing first and range-checking
 * afterwards turns "the server did not report a price" into a confident $0.00 —
 * the ERR-219/ERR-068 absence-as-zero shape, here pointed at an ad platform and
 * an analytics property. So the TYPE is checked BEFORE any coercion. A genuine 0
 * survives as 0; absence comes back NaN and the caller omits the field rather
 * than inventing a number for it.
 *
 * Figures are GST-INCLUSIVE and stay that way — both platforms want the
 * shopper-facing price, which is why there is deliberately no /1.15 anywhere in
 * this file.
 */
function readMoney(raw) {
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : NaN;
    if (typeof raw === 'string' && raw.trim() !== '') {
        const n = Number(raw);
        return Number.isFinite(n) ? n : NaN;
    }
    return NaN;
}

/** True when readMoney() found a reportable figure. A genuine 0 counts. */
function hasMoney(value) {
    return Number.isFinite(value) && value >= 0;
}

/** A trimmed non-empty string, or undefined. Never '' — absence must be absent. */
function cleanText(value) {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
}

/* Labels that must never become a reported dimension.
 *
 * `getProductInfo()` in product-detail-page.js resolves a brand as
 * `p.brand?.name || p.brand || this.extractBrand(name) || 'Unknown'` — so
 * 'Unknown' is not hypothetical, it is a value that really arrives, and
 * `extractBrand` reads a brand out of the product NAME against a hardcoded list
 * of five. A fabricated dimension is worse than a missing one: a missing one is
 * visibly missing and gets fixed, while 'Unknown' is indistinguishable from a
 * real brand in a report and quietly becomes one of the biggest rows in it.
 * ERR-157: never infer source from a name. */
const PLACEHOLDER_LABELS = ['unknown', 'n/a', 'na', 'none', 'null', 'undefined', '-', '—', '?'];

/** A reportable label, or undefined. Placeholders are dropped, not passed on. */
function cleanLabel(value) {
    const text = cleanText(value);
    if (text === undefined) return undefined;
    return PLACEHOLDER_LABELS.indexOf(text.toLowerCase()) === -1 ? text : undefined;
}

/**
 * THE UNITS ADDED BY THIS CALL. A DELTA — never the resulting line total.
 *
 * `quantity_added` is the units added by THIS call, on both the insert and the
 * merge path. It is the authoritative answer and it is what this prefers
 * (backend added it 2026-09-06 in response to BF-060; verified live the same
 * day: empty line + 2 -> added 2, then + 1 -> quantity 3 / quantity_added 1).
 *
 * The derivation below is kept as a LIVE FALLBACK, not as dead code. Without it
 * a response missing the delta falls through to `confirmed.quantity` — the LINE
 * TOTAL — and the triple-value bug returns silently. Removing a fallback is a
 * behaviour change, not a cleanup (ERR-158).
 *
 * Why the fallback exists at all: `confirmed.quantity` is the RESULTING LINE
 * TOTAL. Measured in a real browser 2026-09-06 — a line already holding 2, add 1
 * more, and the response says `quantity: 3`, so sending it straight through
 * reported a THREE-unit add at $290.97 for a shopper who added ONE $96.99
 * cartridge. Triple the true value, into the account the owner bids from,
 * silently, every single time a shopper added to something already in the cart.
 * Every unit test passed: one add to an EMPTY line is indistinguishable from a
 * delta, so only a SECOND add to the same line exposes it.
 *
 * And the derivation is CONSERVATIVE. Server total minus what the line held is
 * the truth when both are trustworthy; the requested amount is the fallback. It
 * is capped at the requested amount because the local cart can be stale-low (the
 * server may hold a line from another device), and an inflated delta
 * over-reports — the one direction that costs real money. A clamp the other way
 * is honoured: if stock limited a 5 to a 2, the delta really is 2.
 */
function resolveAddedQuantity(confirmed, context) {
    const ctx = context || {};
    const requested = Number(ctx.requestedQuantity);
    const requestedQty = Number.isFinite(requested) && requested > 0 ? requested : 1;
    const prior = Number(ctx.priorQuantity);
    const priorQty = Number.isFinite(prior) && prior > 0 ? prior : 0;

    const serverTotal = Number(confirmed.quantity);
    const derived = Number.isFinite(serverTotal) ? serverTotal - priorQty : NaN;
    const fallbackQty = (Number.isFinite(derived) && derived > 0 && derived <= requestedQty)
        ? derived
        : requestedQty;

    // The server's own delta wins when it is there.
    const added = Number(confirmed.quantity_added);
    return (Number.isFinite(added) && added > 0) ? added : fallbackQty;
}

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

            // THE AMOUNT ADDED, from the one owner of that question. The GA4
            // twin below calls the same reader, so the two platforms cannot
            // report different quantities for the same add. See
            // resolveAddedQuantity() above for why this is not just
            // `confirmed.quantity` (it is the LINE TOTAL — BF-060/ERR-223).
            const quantity = resolveAddedQuantity(confirmed, context);

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
            const snap = readMoney(confirmed.price_snapshot);
            const hasValue = hasMoney(snap);

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

/* ============================================================================
 * GA4 BROWSER ECOMMERCE - the funnel above the purchase
 * (backend handoff `ga4-ecommerce-events-FE-handoff-sep2026.md` - ERR-256)
 *
 * WHAT WAS WRONG
 * --------------
 * GA4 received NO ecommerce events from the browser - only page_view / scroll /
 * user_engagement. Purchases arrive server-side through the Measurement Protocol
 * (postPaymentService -> ga4Service), so revenue was right and the whole funnel
 * above it was empty: GA4 literally could not draw view -> cart -> checkout ->
 * purchase. Mobile is 64% of ad clicks converting at 1.65% against desktop's
 * 8.6%, and nothing could say where the mobile funnel lost people. Measured
 * before this shipped: zero occurrences of view_item / begin_checkout /
 * add_shipping_info anywhere in js/.
 *
 * WHY IT LIVES IN gtag.js
 * ----------------------
 * Same reason AdsConversions does, and the reason is measured, not assumed:
 * gtag.js is on 38 of 43 pages - a strict superset of the 33 that load cart.js,
 * and it covers the PDP and /checkout too - and it is a blocking <head> script,
 * so this global exists before any body script runs. A new file would need ~35
 * new <script> tags, which is ERR-194 verbatim: cart-analytics.js sat on THREE
 * pages behind `typeof CartAnalytics !== 'undefined'`, so the guard was an
 * off-switch at every real entry point and add_to_cart recorded 56 events in its
 * entire history. Enrolment is pinned as a SET EQUALITY by the test, never a
 * count (ERR-214).
 *
 * EVERY EVENT IS SCOPED WITH send_to, AND THAT IS NOT DECORATION
 * -------------------------------------------------------------
 * This file configures THREE destinations: G-SDQELG0FGD, a second GA4 property
 * G-YJXTSGLM28 that appears nowhere else in the repo, and the Google Ads tag
 * AW-18032498762. An event with no `send_to` goes to ALL THREE - which is what
 * every pre-existing custom event on this site does (contact_form_submit,
 * faq_open, quote_started). For an ECOMMERCE event that is not a style
 * preference: it would put add_to_cart-shaped hits into the ad account the owner
 * bids from, and the backend's acceptance criterion for this work is that its
 * duplicated-conversion monitor stays 22/22. So every event here names its one
 * destination, and a test asserts none of them can reach the Ads tag.
 *
 * THERE IS NO purchase() HERE, DELIBERATELY
 * -----------------------------------------
 * The server already posts `purchase` with the order's transaction_id. A browser
 * twin double-counts revenue unless both carry an identical transaction_id AND
 * GA4 dedups them - and MP dedup is unreliable. So the rule is: purchase is
 * server-side only, everything upstream of it is browser-side only. A test
 * asserts no browser `purchase` event exists anywhere in js/, because the way
 * this breaks is somebody helpfully "completing the set" later.
 *
 * CONSENT IS NOT GATED HERE
 * -------------------------
 * analytics_storage is denied until the banner is accepted (gcs=G1-0, ERR-227).
 * Events sent before consent are modelled or dropped by Google BY DESIGN. Adding
 * our own gate would suppress hits Consent Mode is built to handle, and would be
 * a second implementation of a policy that already has an owner.
 * ========================================================================== */
const GA4 = {
    // The property the handoff names. NOT G-YJXTSGLM28 (configured at the top of
    // this file and referenced nowhere else in the repo - raised with the backend
    // rather than silently fed), and NOT the Ads tag.
    PROPERTY: 'G-SDQELG0FGD',
};

const Ga4Ecommerce = {
    PROPERTY: GA4.PROPERTY,
    CURRENCY: 'NZD',

    /* ONE-SHOT STATE, PER PAGE LOAD.
     *
     * view_item is keyed by SKU and begin_checkout is a flag, both matching the
     * in-memory guard in CartAnalytics.trackCheckoutStarted so the first-party
     * beacon and GA4 stay comparable - that comparability is what lets one
     * dataset audit the other. GA4 funnel exploration counts sessions reaching a
     * step, not raw events, so a refresh cannot distort the mobile-vs-desktop
     * comparison this work exists for.
     *
     * add_shipping_info stores the TIER, not a boolean: repeated Continue clicks
     * with the same delivery area must not inflate the step, but a genuine
     * urban -> rural change must not be recorded stale. A boolean would silently
     * pick the wrong one of those two. */
    _sentViewItem: null,
    _sentBeginCheckout: false,
    _sentShippingTier: null,

    /**
     * One GA4 item, or null when there is no SKU to name it with.
     *
     * item_id MUST be the SKU - it is what joins to the product feed and the
     * catalog reports. Everything else is omitted when it is not genuinely
     * known: an absent dimension is visibly absent and gets fixed, while an
     * invented one ('Unknown', '') becomes a real row in a report.
     */
    _item(src) {
        if (!src || typeof src !== 'object') return null;
        const sku = cleanText(src.sku);
        if (!sku) return null;

        const item = { item_id: sku };
        const name = cleanText(src.name);
        if (name) item.item_name = name;
        const brand = cleanLabel(src.brand);
        if (brand) item.item_brand = brand;
        const category = cleanLabel(src.category);
        if (category) item.item_category = category;

        const price = readMoney(src.price);
        if (hasMoney(price)) item.price = price;

        const qty = Number(src.quantity);
        if (Number.isFinite(qty) && qty > 0) item.quantity = qty;

        return item;
    },

    /**
     * The brand, from the AUTHORITATIVE field only.
     *
     * `getProductInfo().brandName` is deliberately NOT used: it falls through
     * `extractBrand(name)`, which reads a brand out of the product NAME against
     * a hardcoded list of five, and then to the literal 'Unknown'. Reading a
     * dimension off a name is ERR-157; reporting 'Unknown' as a brand is worse
     * than reporting nothing. The backend's `brand` arrives either as
     * { name } or as a plain string.
     */
    _brandOf(product) {
        if (!product) return undefined;
        const brand = product.brand;
        if (brand && typeof brand === 'object') return cleanLabel(brand.name);
        return cleanLabel(brand);
    },

    /** Cart lines -> GA4 items, dropping any line that cannot be named. */
    _lines(items) {
        if (!Array.isArray(items)) return [];
        const out = [];
        for (let i = 0; i < items.length; i++) {
            const line = items[i] || {};
            const item = this._item({
                sku: line.sku,
                name: line.name,
                brand: line.brand,
                // A cart line has NO product_type and no category - measured:
                // neither the local push whitelist nor _parseServerCart carries
                // one, and none of the nine add-to-cart callers passes one. So
                // this is absent rather than guessed. view_item carries the real
                // category, and GA4 joins the rest by item_id.
                category: line.product_type,
                price: line.price,
                quantity: line.quantity,
            });
            if (item) out.push(item);
        }
        return out;
    },

    /** Send one event to the one property. Never throws. */
    _emit(eventName, params) {
        if (typeof gtag !== 'function') return false;
        gtag('event', eventName, Object.assign({
            send_to: GA4.PROPERTY,
            currency: this.CURRENCY,
        }, params));
        return true;
    },

    /**
     * The cart's value and where that number came from.
     *
     * Cart.getSubtotal() already answers "the server's subtotal when we have one,
     * a display-only local estimate otherwise", so it is reused rather than
     * reimplemented - and Cart.hasServerPricing() says WHICH it was, so the
     * partialness is in the RETURN VALUE instead of being silently indistinguish-
     * able (the fail-soft-must-be-loud rule).
     *
     * GOODS ONLY - never Cart.getTotal(). At begin_checkout the shopper has not
     * reached the delivery section, so getTotal() carries a GUESSED urban
     * shipping estimate (the `|| 'urban'` of ERR-235). Baking a guess into the
     * funnel's headline number is the ERR-241/255 shape. GA4 takes shipping on
     * its own params, not inside `value`.
     */
    _cartValue(cart) {
        /* AN EMPTY CART HAS NO VALUE, AND 0 IS NOT ITS VALUE.
         *
         * MEASURED, not imagined (probe:ga4-events, 2026-09-13): on /checkout the
         * cart can hold ZERO lines while `hasServerPricing()` answers TRUE and
         * `getSubtotal()` answers 0 — the server returned an empty cart together
         * with a summary, so the figure is "server-confirmed" and it is zero.
         * Reading that straight through reported `value=0` on a real
         * add_shipping_info hit: "this shopper's cart is worth $0.00", stated with
         * full confidence, into the funnel's headline number. That is
         * absence-as-zero (ERR-063/068/073/075/076/149/150) reaching an analytics
         * property, and a genuine-0 allowance written for a unit PRICE is exactly
         * what let it through — a cartridge can legitimately cost 0, a cart with
         * lines in it cannot.
         *
         * The line count is the question, so the line count is what is asked. */
        const lines = (cart && Array.isArray(cart.items)) ? cart.items : [];
        if (!lines.length) return { value: null, valueSource: 'empty-cart' };

        if (cart && typeof cart.getSubtotal === 'function') {
            const value = readMoney(cart.getSubtotal());
            const server = typeof cart.hasServerPricing === 'function'
                ? cart.hasServerPricing() === true
                : false;
            if (hasMoney(value)) return { value: value, valueSource: server ? 'server' : 'local' };
        }
        // No getSubtotal at all - sum the lines and SAY that is what happened.
        let sum = 0;
        let sane = true;
        for (let i = 0; i < lines.length; i++) {
            const price = readMoney(lines[i] && lines[i].price);
            const qty = Number(lines[i] && lines[i].quantity);
            if (!hasMoney(price) || !Number.isFinite(qty) || qty <= 0) { sane = false; break; }
            sum += price * qty;
        }
        return sane ? { value: sum, valueSource: 'local' } : { value: null, valueSource: 'none' };
    },

    /** The live Cart, unless a caller (or a test) supplies one. */
    _cart(cart) {
        if (cart) return cart;
        return (typeof Cart !== 'undefined') ? Cart : null;
    },

    /**
     * GA4 `view_item` - fired once per SKU per page load, after the PDP renders.
     *
     * @param {object} product - the PDP's product (getProductInfo()'s result or
     *   `this.product`; the fields read exist on both).
     * @returns {{sent: boolean, reason?: string, value?: number}}
     */
    viewItem(product) {
        try {
            if (!product || typeof product !== 'object') return { sent: false, reason: 'no-payload' };
            const sku = cleanText(product.sku);
            if (!sku) return { sent: false, reason: 'no-sku' };
            if (this._sentViewItem === sku) return { sent: false, reason: 'already-sent' };

            const item = this._item({
                sku: sku,
                name: product.name,
                brand: this._brandOf(product),
                // The RAW authoritative enum ('ink_cartridge', 'maintenance_box'),
                // which is what the handoff asked for and what the feed carries.
                // NOT getProductInfo().category - that is a normalised display
                // bucket whose fallback chain ends in reading the product name.
                category: product.product_type,
                price: product.retail_price,
                quantity: 1,
            });
            if (!item) return { sent: false, reason: 'no-sku' };

            const params = { items: [item] };
            // The unit retail the shopper is looking at, GST-inclusive.
            if (item.price !== undefined) params.value = item.price;

            if (!this._emit('view_item', params)) return { sent: false, reason: 'no-gtag' };
            this._sentViewItem = sku;

            return params.value !== undefined
                ? { sent: true, value: params.value }
                : { sent: true, reason: 'no-price' };
        } catch (err) {
            if (typeof DebugLog !== 'undefined') DebugLog.warn('GA4 view_item failed (non-fatal):', err);
            return { sent: false, reason: 'threw' };
        }
    },

    /**
     * GA4 `add_to_cart` - the twin of the Google Ads add-to-cart conversion.
     *
     * CALL IT WHERE THAT ONE IS CALLED AND UNDER THE SAME GATE: only after
     * POST /api/cart/items has returned 2xx, with the SERVER's own numbers. Both
     * read the delta and the price through the shared readers above, so the two
     * platforms cannot report different numbers for the same add.
     *
     * @param {object} confirmed - `response.data` from the add-to-cart call.
     * @param {object} context - `{ priorQuantity, requestedQuantity }`.
     * @param {object} [descriptors] - `{ brand, category }` from the caller's own
     *   product object, for the two dimensions the server payload does not carry.
     *   Either may be absent; absent means omitted, never guessed.
     * @returns {{sent: boolean, reason?: string, value?: number, quantity?: number}}
     */
    addToCart(confirmed, context, descriptors) {
        try {
            if (!confirmed || typeof confirmed !== 'object') return { sent: false, reason: 'no-payload' };
            const product = confirmed.product || {};
            const desc = descriptors || {};

            const quantity = resolveAddedQuantity(confirmed, context);
            const item = this._item({
                sku: product.sku,
                name: product.name,
                brand: desc.brand !== undefined ? desc.brand : this._brandOf(product),
                category: desc.category,
                // price_snapshot is what the shopper is actually charged (the
                // volume/contract-aware figure), GST-inclusive. The local
                // product.price a card was rendered from is NOT an acceptable
                // substitute: this frontend never computes a price, and a number
                // invented for an analytics property is worse than a missing one.
                price: confirmed.price_snapshot,
                quantity: quantity,
            });
            if (!item) return { sent: false, reason: 'no-sku' };

            const params = { items: [item] };
            // The value of the units ADDED - price x delta. Not the resulting
            // cart-line total: that reading is BF-060/ERR-223, which reported a
            // $290.97 three-unit add for one $96.99 cartridge.
            if (item.price !== undefined) params.value = item.price * quantity;

            if (!this._emit('add_to_cart', params)) return { sent: false, reason: 'no-gtag' };

            return params.value !== undefined
                ? { sent: true, value: params.value, quantity: quantity }
                : { sent: true, reason: 'no-price', quantity: quantity };
        } catch (err) {
            if (typeof DebugLog !== 'undefined') DebugLog.warn('GA4 add_to_cart failed (non-fatal):', err);
            return { sent: false, reason: 'threw' };
        }
    },

    /**
     * GA4 `begin_checkout` - fired where the first-party `checkout_started`
     * beacon is sent, once per page load.
     *
     * @param {object} [cart] - defaults to the live `Cart`.
     * @returns {{sent, reason?, value?, valueSource?, items?}}
     */
    beginCheckout(cart) {
        try {
            const source = this._cart(cart);
            if (!source) return { sent: false, reason: 'no-cart' };
            if (this._sentBeginCheckout) return { sent: false, reason: 'already-sent' };
            if (!Array.isArray(source.items) || source.items.length === 0) {
                return { sent: false, reason: 'empty-cart' };
            }

            const items = this._lines(source.items);
            const priced = this._cartValue(source);
            const params = {};
            if (items.length) params.items = items;
            if (hasMoney(priced.value)) params.value = priced.value;

            if (!this._emit('begin_checkout', params)) return { sent: false, reason: 'no-gtag' };
            this._sentBeginCheckout = true;

            const result = { sent: true, items: items.length, valueSource: priced.valueSource };
            if (params.value !== undefined) result.value = params.value;
            else result.reason = 'no-value';
            if (!items.length) result.reason = 'no-items';
            return result;
        } catch (err) {
            if (typeof DebugLog !== 'undefined') DebugLog.warn('GA4 begin_checkout failed (non-fatal):', err);
            return { sent: false, reason: 'threw' };
        }
    },

    /**
     * GA4 `add_shipping_info` - fired when the shopper commits a delivery area.
     *
     * @param {string} tier - the checked `delivery_type`, or null/undefined.
     *   Validated against DeliveryArea, the single owner of that vocabulary
     *   (utils.js), read at call time because utils.js loads after this head
     *   script. Anything else is treated as "not stated": the event still fires
     *   because the funnel rung is real, but it carries NO shipping_tier and the
     *   return says so. It NEVER substitutes 'urban' - that is the `|| 'urban'`
     *   that had already quoted an urban rate before anyone touched the control
     *   (ERR-235), and the submit path deliberately records null instead.
     * @param {object} [cart] - defaults to the live `Cart`.
     * @returns {{sent, reason?, tier?, value?, valueSource?}}
     */
    addShippingInfo(tier, cart) {
        try {
            const source = this._cart(cart);
            if (!source) return { sent: false, reason: 'no-cart' };

            const urban = (typeof DeliveryArea !== 'undefined') ? DeliveryArea.URBAN : 'urban';
            const rural = (typeof DeliveryArea !== 'undefined') ? DeliveryArea.RURAL : 'rural';
            const clean = cleanText(tier);
            const known = (clean === urban || clean === rural) ? clean : null;

            // Keyed by the tier, so a repeated Continue is a no-op but a genuine
            // change is not recorded stale. `null` is a state like any other.
            const key = known === null ? ' none' : known;
            if (this._sentShippingTier === key) return { sent: false, reason: 'already-sent' };

            /* SYMMETRIC WITH beginCheckout, and the symmetry is the point.
             *
             * A delivery area committed on a cart with nothing in it is not a
             * funnel step, it is a broken state. If this fired while
             * begin_checkout had refused the same empty cart, GA4 would show
             * add_shipping_info ABOVE its own parent step — a funnel that reads
             * as a data bug and gets distrusted wholesale. Refusing keeps the
             * funnel monotonic, and the absent event is itself the honest signal. */
            if (!Array.isArray(source.items) || source.items.length === 0) {
                return { sent: false, reason: 'empty-cart' };
            }

            const items = this._lines(source.items);
            const priced = this._cartValue(source);
            const params = {};
            if (items.length) params.items = items;
            if (hasMoney(priced.value)) params.value = priced.value;
            if (known !== null) params.shipping_tier = known;

            if (!this._emit('add_shipping_info', params)) return { sent: false, reason: 'no-gtag' };
            this._sentShippingTier = key;

            const result = { sent: true, valueSource: priced.valueSource };
            if (known !== null) result.tier = known;
            else result.reason = 'no-tier';
            if (params.value !== undefined) result.value = params.value;
            return result;
        } catch (err) {
            if (typeof DebugLog !== 'undefined') DebugLog.warn('GA4 add_shipping_info failed (non-fatal):', err);
            return { sent: false, reason: 'threw' };
        }
    },
};

if (typeof window !== 'undefined') window.AdsConversions = AdsConversions;
if (typeof window !== 'undefined') window.Ga4Ecommerce = Ga4Ecommerce;
