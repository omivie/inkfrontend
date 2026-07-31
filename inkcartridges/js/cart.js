/**
 * CART.JS
 * =======
 * Shopping cart functionality for InkCartridges.co.nz
 *
 * HYBRID ARCHITECTURE (server + localStorage):
 * - Authenticated users: Server-first cart storage (linked via user ID)
 * - Guest users: Server + localStorage (localStorage for cross-origin cookie fallback)
 * - On sign-in: Guest cart merges into user cart via /api/cart/merge
 * - localStorage provides fallback for local development (cross-origin cookie issues)
 *
 * PRICING RULE: Frontend never computes prices. All totals come from backend.
 * Client-side math is used ONLY as a fallback when server summary is unavailable.
 */

'use strict';

/**
 * Split the aggregate `summary.discount` into its named components.
 *
 * `summary.discount` is the TOTAL of every discount the backend applied.
 * Loyalty (`loyalty_discount_amount`) and the B2B business-account discount
 * (`b2b_discount.discount_amount`) are sub-components of it that get their own
 * summary rows, so each must be netted out of the generic "You Save" line or
 * the shopper sees the same dollars counted twice.
 *
 * The B2B block is computed PER LINE from the volume ladder and WITH the loss
 * floor, so `discount_amount` is the sum of each line's floored savings and can
 * be far less than any headline percentage of the subtotal. That is expected and
 * it is authoritative — never recompute it. See business.js.
 *
 * TWO PAYLOAD SHAPES, both handled (verified live 2026-07-20, re-verified
 * unchanged under volume pricing 2026-07-31).
 * The handoff documents `summary.b2b_discount` as the metadata OBJECT. The live
 * API actually sends:
 *     summary.b2b_discount  ->  4.88                       (a NUMBER, the amount)
 *     response.b2b_discount ->  { company_name, effective_percent,
 *                                 discount_amount, floored_line_count,
 *                                 source: 'volume' }        (the OBJECT)
 * Reading only the documented shape rendered NOTHING, because `typeof 4.88`
 * is not 'object'. So both are accepted: whichever carries the object becomes
 * the metadata, whichever carries a number becomes the amount. If the backend
 * later moves the object into `summary`, this keeps working unchanged.
 *
 * `pricing_tier` and `discount_percent` are GONE from that block as of v2 —
 * the ceiling now varies per line, so there is no single cart-wide rate.
 *
 * Also verified live: `summary.discount` INCLUDES the B2B amount (a cart with
 * only a B2B discount reported discount === b2b_discount === 4.88), so the B2B
 * row must be netted out of "You Save" exactly like loyalty.
 *
 * Pure: no DOM, no I/O. Shared by cart.js, checkout-page.js, payment-page.js
 * and order-confirmation-page.js so the four summaries cannot drift apart.
 *
 * @param {object|null} summary  the API cart `summary` object
 * @param {number} [total]       aggregate discount; defaults to summary.discount
 * @param {object|number|null} [b2bBlock]  the response-level `b2b_discount`
 * @returns {{loyalty:number, b2b:number, other:number, total:number,
 *            b2bMeta:(object|null)}}
 */
function computeDiscountBreakdown(summary, total, b2bBlock) {
    const s = summary && typeof summary === 'object' ? summary : {};

    const num = (v) => {
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? n : 0;
    };
    const isObj = (v) => !!v && typeof v === 'object';

    const aggregate = Number.isFinite(Number(total)) ? Math.max(0, Number(total)) : num(s.discount);
    const loyalty = num(s.loyalty_discount_amount);

    // Metadata: whichever source carries the object.
    const b2bMeta = isObj(b2bBlock) ? b2bBlock : (isObj(s.b2b_discount) ? s.b2b_discount : null);
    // Amount: prefer the object's own figure, else whichever source is numeric.
    const b2b = num(b2bMeta && b2bMeta.discount_amount) || num(s.b2b_discount) || num(b2bBlock);

    return {
        loyalty,
        b2b,
        other: Math.max(0, aggregate - loyalty - b2b),
        total: aggregate,
        b2bMeta
    };
}
if (typeof window !== 'undefined') window.computeDiscountBreakdown = computeDiscountBreakdown;

/**
 * Label for a B2B summary row, e.g. "Business account — Acme Print Co".
 *
 * v1 named the pricing TIER here ("Business account (Gold tier)"). Volume
 * pricing retired tiers entirely — the live `b2b_discount` block carries
 * `company_name` and no tier at all — and there is deliberately no replacement
 * percentage in this label: the block's `effective_percent` is the realised rate
 * across the WHOLE cart (0.7% on a live cart whose one qualifying line was
 * discounted 5%), so putting it beside the word "account" would read as the
 * customer's discount rate and be wrong on every mixed cart.
 *
 * @param {object|null} b2bMeta  the cart response's b2b_discount block
 * @returns {string}
 */
function businessDiscountLabel(b2bMeta) {
    const company = b2bMeta && typeof b2bMeta.company_name === 'string' ? b2bMeta.company_name.trim() : '';
    return company ? `Business account — ${company}` : 'Business account';
}
if (typeof window !== 'undefined') window.businessDiscountLabel = businessDiscountLabel;

/**
 * DURABLE CART REMOVALS (ERR-136)
 * ===============================
 * "Remove an item, refresh immediately, the item is back."
 *
 * Correctness here needs THREE independent mechanisms. Each covers a hole the
 * other two cannot, so none of them is redundant — do not "simplify" one away:
 *
 *   1. JOURNAL (localStorage `inkcartridges_cart_pending_ops`)
 *      Owns DURABILITY. The intent to remove is written down BEFORE the request
 *      leaves, so it survives an unload, a tab crash, or being offline. This is
 *      the only mechanism that covers a pre-dispatch abort: API.request() awaits
 *      getToken() (and may sit inside Auth.refreshSession()) before fetch is
 *      called, so `keepalive` has nothing to protect yet.
 *
 *   2. FILTER (`isPendingRemoved`, a pure predicate over the journal)
 *      Owns CORRECTNESS OF EVERY PAINT while an intent is unconfirmed. Between
 *      the journal write and the server's confirmation, localStorage and the
 *      server BOTH still contain the row; every read path subtracts the journal
 *      so no paint and no re-push can resurrect it.
 *
 *   3. EPOCH GUARD (`Cart._mutationEpoch`, in memory)
 *      Owns ORDERING. A `GET /api/cart` issued before a mutation landed must
 *      never be adopted after it. Without this the fix is FLAKY rather than
 *      fixed: replay confirms, drops the journal entry, and then an in-flight
 *      earlier GET resolves still carrying the item — the journal is now empty
 *      so the filter correctly no longer matches, and `this.items =
 *      parsed.items` puts it straight back and re-saves it.
 *
 * `keepalive: true` on the DELETE is a fourth, purely latency-side measure: it
 * means the common case usually needs no replay at all. It is not load-bearing.
 *
 * All decision logic below is PURE (no DOM, no I/O, no clock) so it can be
 * executed directly by tests instead of pattern-matched as source text.
 */
const PENDING_OPS_KEY = 'inkcartridges_cart_pending_ops';
const PENDING_OP_VERSION = 1;
/** Real attempts — the server answered, or the network failed while online. */
const MAX_PENDING_OP_ATTEMPTS = 5;
/** Deferrals (offline / 401 / 429) are not verdicts; the age cap is the real bound. */
const MAX_PENDING_OP_DEFERRALS = 50;
const PENDING_OP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING_OPS = 20;

/**
 * Build a pending-removal record.
 *
 * `idx` is stored so a rejected removal can be re-inserted exactly where it was
 * WITHOUT a whole-array snapshot. A snapshot taken before the local filter is a
 * time bomb: rolling back remove-A after remove-B succeeded resurrects B.
 *
 * @param {object} item  the cart line being removed
 * @param {object} ctx   { idx, authenticated, uid, sid, now }
 * @returns {object} record
 */
function makePendingRemoval(item, ctx) {
    const c = ctx || {};
    const it = item || {};
    const qty = Number(it.quantity);
    const idx = Number(c.idx);
    const now = Number(c.now);
    return {
        v: PENDING_OP_VERSION,
        // Reserved so a future 'setQty'/'clear' record can never be misread as a
        // removal by an older build that only understands this shape.
        op: 'remove',
        id: it.id != null ? String(it.id) : null,
        key: (typeof it.key === 'string' && it.key) ? it.key : null,
        sku: typeof it.sku === 'string' ? it.sku : '',
        name: typeof it.name === 'string' ? it.name : '',
        qty: Number.isFinite(qty) && qty > 0 ? qty : 1,
        idx: Number.isInteger(idx) && idx >= 0 ? idx : 0,
        auth: !!c.authenticated,
        uid: (c.authenticated && c.uid) ? String(c.uid) : null,
        sid: (!c.authenticated && c.sid) ? String(c.sid) : null,
        at: Number.isFinite(now) && now > 0 ? now : 0,
        attempts: 0,
        deferrals: 0,
        lastAt: 0
    };
}

/**
 * Parse + validate + age-sweep the journal. Never throws.
 *
 * Anything unrecognised is DROPPED rather than guessed at, and the age sweep runs
 * here so an expired intent can never be replayed even once.
 *
 * @param {string|object|null} raw  the raw localStorage value
 * @param {number} now              Date.now() (0 disables the age sweep)
 * @returns {{records: object[], dropped: {rec: object|null, reason: string}[]}}
 */
function readPendingOps(raw, now) {
    const dropped = [];
    let parsed = null;

    if (typeof raw === 'string' && raw) {
        try {
            parsed = JSON.parse(raw);
        } catch (e) {
            // Corrupt journal: drop the whole thing. Never throw on a paint path.
            return { records: [], dropped: [{ rec: null, reason: 'corrupt' }] };
        }
    } else if (raw && typeof raw === 'object') {
        parsed = raw;
    }
    if (!parsed) return { records: [], dropped };

    const list = Array.isArray(parsed)
        ? parsed
        : (Array.isArray(parsed.ops) ? parsed.ops : null);
    if (!list) return { records: [], dropped: [{ rec: null, reason: 'corrupt' }] };

    const nowMs = Number.isFinite(Number(now)) ? Number(now) : 0;
    const records = [];

    for (let i = 0; i < list.length; i++) {
        const rec = list[i];
        if (!rec || typeof rec !== 'object') { dropped.push({ rec: rec || null, reason: 'malformed' }); continue; }
        if (rec.v !== PENDING_OP_VERSION) { dropped.push({ rec, reason: 'version' }); continue; }
        if (rec.op !== 'remove') { dropped.push({ rec, reason: 'unsupported_op' }); continue; }
        if (typeof rec.id !== 'string' || !rec.id) { dropped.push({ rec, reason: 'malformed' }); continue; }

        const at = Number(rec.at);
        if (!Number.isFinite(at) || at <= 0) { dropped.push({ rec, reason: 'malformed' }); continue; }
        if (nowMs > 0 && (nowMs - at) > PENDING_OP_MAX_AGE_MS) { dropped.push({ rec, reason: 'expired' }); continue; }

        const attempts = Number(rec.attempts);
        const deferrals = Number(rec.deferrals);
        if (Number.isFinite(attempts) && attempts >= MAX_PENDING_OP_ATTEMPTS) { dropped.push({ rec, reason: 'attempts_exhausted' }); continue; }
        if (Number.isFinite(deferrals) && deferrals >= MAX_PENDING_OP_DEFERRALS) { dropped.push({ rec, reason: 'deferrals_exhausted' }); continue; }

        records.push({
            v: PENDING_OP_VERSION,
            op: 'remove',
            id: rec.id,
            key: (typeof rec.key === 'string' && rec.key) ? rec.key : null,
            sku: typeof rec.sku === 'string' ? rec.sku : '',
            name: typeof rec.name === 'string' ? rec.name : '',
            qty: Number.isFinite(Number(rec.qty)) && Number(rec.qty) > 0 ? Number(rec.qty) : 1,
            idx: Number.isInteger(Number(rec.idx)) && Number(rec.idx) >= 0 ? Number(rec.idx) : 0,
            auth: !!rec.auth,
            uid: (typeof rec.uid === 'string' && rec.uid) ? rec.uid : null,
            sid: (typeof rec.sid === 'string' && rec.sid) ? rec.sid : null,
            at: at,
            attempts: Number.isFinite(attempts) && attempts > 0 ? attempts : 0,
            deferrals: Number.isFinite(deferrals) && deferrals > 0 ? deferrals : 0,
            lastAt: Number.isFinite(Number(rec.lastAt)) ? Number(rec.lastAt) : 0
        });
    }

    // A pathological loop must not eat the storage quota. Oldest go first.
    if (records.length > MAX_PENDING_OPS) {
        records.sort(function (a, b) { return a.at - b.at; });
        while (records.length > MAX_PENDING_OPS) {
            dropped.push({ rec: records.shift(), reason: 'overflow' });
        }
    }

    return { records, dropped };
}

/**
 * Is this cart line covered by an unconfirmed removal?
 *
 * Matching is KEY-FIRST. When both the record and the row name a specific line,
 * the composite key is authoritative and there is NO id fallback — otherwise
 * removing a `cross-sell:X` row would also hide the `core:X` row of the same
 * product. When either side has no key the product id is the best available
 * evidence, and filtering is the safer failure (it matches the shopper's intent).
 *
 * @param {object} item      a cart line
 * @param {object[]} records journal records
 * @returns {boolean}
 */
function isPendingRemoved(item, records) {
    if (!item || !Array.isArray(records) || records.length === 0) return false;
    const itemKey = (typeof item.key === 'string' && item.key) ? item.key : null;
    const itemId = item.id != null ? String(item.id) : null;

    for (let i = 0; i < records.length; i++) {
        const rec = records[i];
        if (!rec) continue;
        if (rec.key && itemKey) {
            if (rec.key === itemKey) return true;
            continue;
        }
        if (itemId && rec.id === itemId) return true;
    }
    return false;
}

/**
 * Decide, per record, whether this browser may replay it right now.
 *
 * A removal belongs to ONE cart. Replaying it against a different cart would
 * delete a line somebody deliberately added, so a record that cannot be matched
 * to the current identity is never replayed.
 *
 * For a guest, `X-Guest-Session` from localStorage is the ONLY handle on the
 * cart: request() sends `credentials: 'omit'` whenever there is no token, so the
 * backend's httpOnly guest cookie never rides along. Once the sid is gone that
 * cart is unreachable from this browser forever — the intent is unsatisfiable
 * AND harmless, so it is dropped quietly rather than surfaced.
 *
 * @param {object[]} records
 * @param {object} ctx  { authenticated, uid, sid, retarget }
 * @returns {{replay: object[], drop: {rec,reason}[], defer: {rec,reason}[]}}
 */
function planPendingReplay(records, ctx) {
    const c = ctx || {};
    const replay = [];
    const drop = [];
    const defer = [];
    const list = Array.isArray(records) ? records : [];
    const uid = c.uid != null ? String(c.uid) : null;
    const sid = c.sid != null ? String(c.sid) : null;

    for (let i = 0; i < list.length; i++) {
        const rec = list[i];
        if (!rec) continue;

        if (rec.auth) {
            // Authored while signed in. Still deliverable after a sign-out/sign-in
            // round trip, so being signed out DEFERS rather than drops — which is
            // why the SIGNED_OUT handler must not purge the journal.
            if (!c.authenticated) { defer.push({ rec, reason: 'signed_out' }); continue; }
            if (rec.uid && uid && rec.uid !== uid) { drop.push({ rec, reason: 'other_user' }); continue; }
            if (rec.uid && !uid) { defer.push({ rec, reason: 'identity_unknown' }); continue; }
            replay.push(rec);
            continue;
        }

        // Authored as a guest.
        if (c.authenticated) {
            // The guest cart is about to be (or has just been) merged into the user
            // cart, carrying the un-deleted row with it. Only replay once the merge
            // has happened, and then as an authenticated delete.
            if (c.retarget) replay.push(rec);
            else defer.push({ rec, reason: 'awaiting_merge' });
            continue;
        }
        if (!sid || !rec.sid || rec.sid !== sid) { drop.push({ rec, reason: 'guest_session_gone' }); continue; }
        replay.push(rec);
    }

    return { replay, drop, defer };
}

/**
 * Classify one DELETE outcome. Shared by the fresh path and the replay path so
 * the two cannot drift apart.
 *
 * `removed` is read with NO coercion: `null` means "not reported" (HTTP 204, or a
 * backend predating the field), never 0. Reading an unknown count as zero is the
 * ERR-122 failure mode.
 *
 * A FRESH `removed: 0` is deliberately NOT terminal. It means the row was not
 * there — but that could be "already gone" OR "the request resolved against a
 * different cart" (guest sid rotated, session expired to anonymous), and the
 * count alone cannot tell those apart. So it demands verification against a
 * fresh GET. A REPLAYED `removed: 0` is the correct idempotent outcome.
 *
 * @param {object|null} response  the {ok,data} envelope, or null
 * @param {Error|null} error      a thrown transport error, if any
 * @param {object} opts           { replay: boolean, online: boolean }
 * @returns {'confirmed'|'confirmed_unverified'|'absent'|'retry'|'defer'|'reject'}
 */
function classifyRemovalOutcome(response, error, opts) {
    const o = opts || {};
    const isReplay = !!o.replay;
    const online = o.online !== false;

    const verdictFor = function (code, status) {
        if (code === 'NOT_FOUND' || status === 404) return 'absent';
        if (code === 'UNAUTHORIZED' || code === 'EMAIL_NOT_VERIFIED' || status === 401) return 'defer';
        if (code === 'FORBIDDEN' || status === 403) return 'reject';
        if (code === 'RATE_LIMITED' || status === 429) return 'defer';
        if (!online) return 'defer';
        if (Number.isFinite(status) && status >= 500) return 'retry';
        return null;
    };

    if (error) {
        const v = verdictFor(
            error.code ? String(error.code) : '',
            Number(error.status)
        );
        // A TypeError/timeout/abort while online is transient — the replay owns it.
        return v || (online ? 'retry' : 'defer');
    }

    if (!response) return online ? 'retry' : 'defer';

    if (response.ok === false) {
        const v = verdictFor(
            response.code ? String(response.code) : '',
            Number(response.status)
        );
        // Anything else the server rejected outright will not start working.
        return v || 'reject';
    }

    const data = response.data;
    const removed = (data && typeof data.removed === 'number') ? data.removed : null;
    if (removed === null) return 'confirmed_unverified';
    if (removed >= 1) return 'confirmed';
    return isReplay ? 'absent' : 'confirmed_unverified';
}

if (typeof window !== 'undefined') {
    window.makePendingRemoval = makePendingRemoval;
    window.readPendingOps = readPendingOps;
    window.isPendingRemoved = isPendingRemoved;
    window.planPendingReplay = planPendingReplay;
    window.classifyRemovalOutcome = classifyRemovalOutcome;
}

const Cart = {
    // Storage key for guest cart data
    STORAGE_KEY: 'inkcartridges_cart',

    // Cart data
    items: [],

    // Server-provided summary (subtotal, shipping, discount, total)
    // This is the source of truth for all pricing display when available.
    serverSummary: null,

    // Conversion signals from the cart response (mobile-ux-audit-jul2026 §6):
    // { trust_signals, delivery_estimate, free_shipping_unlock, cart_saved_until }.
    // Server-only — never persisted to localStorage, so guest carts restored
    // offline simply render no signals. Populated when the cart response parses.
    serverCartMeta: null,

    // Applied coupon (server-validated)
    appliedCoupon: null,

    // Discount amount from server
    discountAmount: 0,

    // Loyalty points state for this cart (null for guests / when loyalty service is down).
    // Full shape from the backend: { points_balance, points_applied, applied_value_dollars,
    // max_redeemable_points, min_redemption_points, redemption_rate, redeemable_now,
    // message, stale_notice }.
    loyalty: null,

    // Loading state - starts true, set to false after server data is loaded
    loading: true,

    // Cart validity state
    // 'valid' | 'invalid_price' | 'unknown'
    validationState: 'unknown',
    validationErrors: [],

    // Whether user is authenticated
    isAuthenticated: false,

    // Debounce timer for quantity updates
    _quantityDebounceTimers: {},

    // Per-item in-flight API call guard
    _quantityInFlight: {},

    // Queued quantity values while an API call is in-flight
    _quantityQueued: {},

    // Debounced-but-not-yet-dispatched quantity values, keyed by item, so an
    // unload can flush them instead of losing them (ERR-136).
    _quantityPending: {},

    // Guard against concurrent mergeGuestCartAndLoad calls
    _mergeInProgress: false,

    // Set of item IDs/keys currently being removed (in-flight delete API calls).
    // Covers THIS page only — it dies with the JS context, which is exactly why
    // the durable journal below exists (ERR-136).
    _removingItems: new Set(),

    // ── Durable removals (ERR-136) ──────────────────────────────────────────
    // localStorage key for the pending-op journal. Declared ONCE at module scope;
    // this is a reference, not a second literal.
    PENDING_OPS_KEY: PENDING_OPS_KEY,

    // Single quantity cap. Previously 99 in updateQuantity and 100 in the six
    // other places, so a programmatic set-to-100 silently became 99.
    MAX_QUANTITY: 100,

    // In-memory mirror of the journal, refreshed on every read. Used as the paint
    // filter. NEVER treat this as the source of truth across an await — two tabs
    // share the key, so every add/drop is a read-modify-write against storage.
    _pendingOps: [],

    // False once a journal write has failed (quota, Safari private mode). The
    // removal still proceeds — the shopper asked for it — but a later failure
    // takes the loud path immediately instead of trusting a replay that can
    // never happen.
    _pendingOpsDurable: true,

    // Bumped on every local mutation and every server confirmation. A GET
    // captured at epoch N must not be adopted at epoch != N.
    _mutationEpoch: 0,

    // Shared in-flight promise so the init + auth-change + pageshow burst
    // collapses into one replay pass.
    _replayInFlight: null,

    // Bounded re-fetch budget for stale snapshots, reset on a clean adoption.
    _staleRefetches: 0,

    // Idempotence latch for _bindDurabilityListeners().
    _durabilityListenersBound: false,

    /**
     * Compute composite key for cart item identity.
     * Uses source prefix + best available identifier (sku > slug > id).
     * Ensures stable identity across cart items.
     */
    cartItemKey: function(item) {
        const src = item.source || 'core';
        const identifier = item.sku || item.slug || item.id;
        return src + ':' + identifier;
    },

    /**
     * Decide whether a stored cart/favourites/checkout item is a Compatible
     * product. Reads `product_source` first (the field added by addItem in
     * the May 2026 catalog overhaul cleanup), falls back to `source` only
     * when it carries a brand-source value (i.e. not the cart-namespace
     * sentinels 'core' / 'cross-sell'), and finally — for legacy localStorage
     * rows that predate the field — looks at the leading "Compatible" word
     * of the stored name. The name fallback is constrained to leading word
     * to dodge accidental matches in description text and is the only
     * survival path for carts saved before this field existed.
     */
    _isCompatible: function(item) {
        if (!item) return false;
        if (item.product_source === 'compatible') return true;
        if (item.product_source) return false; // explicit non-compatible
        if (item.source && !['core', 'cross-sell'].includes(item.source)) {
            return item.source === 'compatible';
        }
        // Legacy stored row — last-resort check on the persisted name.
        return /^compatible\b/i.test(item.name || '');
    },

    /**
     * Get color style for a product color (delegates to shared ProductColors in utils.js)
     */
    getColorStyle: function(colorName) {
        return ProductColors.getStyle(colorName, 'background-color: #e0e0e0;');
    },

    /**
     * Detect color from product name (delegates to shared ProductColors in utils.js)
     */
    detectColorFromName: function(name) {
        return ProductColors.detectFromName(name);
    },

    /**
     * Get image HTML for a cart item.
     *
     * Genuine-no-color-tile invariant: the color-block fallback only renders
     * for compatible items. Genuine items (e.g. genuine KCMY packs that ship
     * with image_url=NULL until the composite-image generator catches up)
     * fall through to the neutral placeholder SVG — never a colored tile.
     */
    getItemImageHTML: function(item) {
        const isCompatibleItem = this._isCompatible(item);
        // Color style is only allowed to surface as a tile for compatible
        // items. For genuine items we still need a *fallback* style for the
        // image-error case (so a broken constituent thumbnail doesn't show a
        // grey rectangle), but it's only painted on broken-image, not on
        // missing-image — that's why we never paint it on the no-image path
        // for genuine items below.
        const rawColorStyle = ProductColors.getProductStyle(item, 'background-color: #e0e0e0;');
        const colorStyle = isCompatibleItem ? rawColorStyle : null;
        const escapedName = Security.escapeHtml((typeof ProductName !== 'undefined') ? ProductName.clean(item) : item.name);
        // Prefer the backend-optimized thumbnail (mobile-ux-audit-jul2026 §6);
        // fall back to the resolved `image` field for older rows.
        const imageUrl = item.image_thumbnail_url
            || (typeof storageUrl === 'function' ? storageUrl(item.image) : item.image);
        // Stale-swatch fallback — drop the per-SKU color-swatch placeholder
        // when the canonical color would no longer match (admin color edit
        // outran the static image upload). Render the color block instead.
        // See utils.js ProductColors.isPlaceholderSwatchImage.
        const swatchStale = ProductColors.isPlaceholderSwatchImage(item.image) && colorStyle;

        if (imageUrl && imageUrl !== '/assets/images/placeholder-product.svg' && !swatchStale) {
            if (colorStyle) {
                return `<img src="${Security.escapeAttr(imageUrl)}" alt="${escapedName}" data-fallback="color-block">
                        <div class="cart-item__color-block" style="${colorStyle}; width: 100%; height: 100%; border-radius: 4px; display: none;"></div>`;
            } else {
                return `<img src="${Security.escapeAttr(imageUrl)}" alt="${escapedName}" data-fallback="placeholder">`;
            }
        }

        if (colorStyle) {
            return `<div class="cart-item__color-block" style="${colorStyle}; width: 100%; height: 100%; border-radius: 4px;"></div>`;
        }

        return `<img src="/assets/images/placeholder-product.svg" alt="${escapedName}">`;
    },

    /**
     * Bind image error fallback handlers — delegates to Products if available,
     * otherwise falls back to inline implementation for pages without products.js.
     */
    bindImageFallbacks(container) {
        if (typeof Products !== 'undefined' && Products.bindImageFallbacks) {
            Products.bindImageFallbacks(container);
            return;
        }
        container.querySelectorAll('img[data-fallback]').forEach(img => {
            img.addEventListener('error', function() {
                if (this.dataset.fallback === 'color-block') {
                    this.style.display = 'none';
                    const sibling = this.nextElementSibling;
                    if (sibling) sibling.style.display = 'flex';
                } else if (this.dataset.fallback === 'placeholder') {
                    this.removeAttribute('data-fallback');
                    this.src = '/assets/images/placeholder-product.svg';
                }
            }, { once: true });
        });
    },

    // ═══════════════════════════════════════════════════════════════════════
    // DURABLE REMOVALS — journal, filter, epoch guard (ERR-136)
    // See the module header for why all three are required.
    // ═══════════════════════════════════════════════════════════════════════

    /**
     * Which cart do we currently hold the keys to?
     * @returns {{authenticated: boolean, uid: string|null, sid: string|null}}
     */
    _cartIdentity() {
        const authenticated = typeof Auth !== 'undefined' && Auth.isAuthenticated();
        let uid = null;
        if (authenticated && typeof Auth !== 'undefined' && typeof Auth.getUser === 'function') {
            const user = Auth.getUser();
            if (user && user.id) uid = String(user.id);
        }
        let sid = null;
        if (typeof API !== 'undefined' && typeof API.getGuestSessionId === 'function') {
            sid = API.getGuestSessionId() || null;
        }
        return { authenticated, uid, sid };
    },

    /**
     * Read the journal from storage into `_pendingOps`. Synchronous and cheap —
     * one read plus validation, no network — so it is safe on the first-paint path.
     * @returns {object[]} the live records
     */
    _hydratePendingOps() {
        let raw = null;
        try {
            raw = localStorage.getItem(PENDING_OPS_KEY);
        } catch (e) {
            DebugLog.warn('Cart: pending-op journal unreadable:', e);
            this._pendingOps = [];
            return this._pendingOps;
        }
        const { records, dropped } = readPendingOps(raw, Date.now());
        this._pendingOps = records;
        if (dropped.length > 0) {
            // Anything swept here is an intent we can no longer honour. It is logged
            // rather than toasted because a sweep on load has no actionable UI, and
            // the reconciling GET that follows will show the truth either way.
            DebugLog.warn('Cart: dropped ' + dropped.length + ' pending cart op(s): ' +
                dropped.map(function (d) { return d.reason; }).join(', '));
            this._persistPendingOps(records);
        }
        return this._pendingOps;
    },

    /**
     * Write records to storage and refresh the in-memory mirror.
     * @returns {boolean} whether the write is durable
     */
    _persistPendingOps(records) {
        const list = Array.isArray(records) ? records : [];
        this._pendingOps = list;
        try {
            if (list.length === 0) {
                localStorage.removeItem(PENDING_OPS_KEY);
            } else {
                localStorage.setItem(PENDING_OPS_KEY, JSON.stringify({ v: PENDING_OP_VERSION, ops: list }));
            }
            return true;
        } catch (e) {
            // Quota exhausted or storage unavailable. The removal still proceeds, but
            // nothing can replay it, so mark it non-durable and let the caller take
            // the loud path on any failure rather than promising a replay.
            DebugLog.warn('Cart: pending-op journal not writable — removals are not durable this session:', e);
            this._pendingOpsDurable = false;
            return false;
        }
    },

    /**
     * Read-modify-write the journal. Always re-reads storage first so a sibling
     * tab's concurrent add/drop is not clobbered.
     * @param {function(object[]): object[]} mutate
     * @returns {boolean} durability of the write
     */
    _mutatePendingOps(mutate) {
        this._hydratePendingOps();
        const next = mutate(this._pendingOps.slice());
        return this._persistPendingOps(Array.isArray(next) ? next : []);
    },

    /**
     * Journal an intent to remove one line. Called BEFORE the local mutation and
     * BEFORE the request, so a crash in between fails toward "we will replay".
     * @returns {object|null} the stored record
     */
    _journalRemoval(item, idx) {
        const id = this._cartIdentity();
        const record = makePendingRemoval(item, {
            idx: idx,
            authenticated: id.authenticated,
            uid: id.uid,
            sid: id.sid,
            now: Date.now()
        });
        if (!record.id) return null;
        this._mutatePendingOps(function (ops) {
            // Supersede any earlier intent for the same line.
            const kept = ops.filter(function (rec) {
                if (record.key && rec.key) return rec.key !== record.key;
                return rec.id !== record.id;
            });
            kept.push(record);
            return kept;
        });
        return record;
    },

    /**
     * Drop journal entries matching a line — used on confirmation, and by addItem /
     * quantity changes to cancel a superseded removal (otherwise "remove → re-add →
     * refresh" replays a DELETE against the freshly re-added row).
     */
    _dropPendingOpsFor(idOrKey) {
        if (!idOrKey) return;
        const needle = String(idOrKey);
        this._mutatePendingOps(function (ops) {
            return ops.filter(function (rec) {
                return rec.id !== needle && rec.key !== needle;
            });
        });
    },

    /** Replace one record in place (attempt/deferral bookkeeping). */
    _updatePendingOp(record, changes) {
        if (!record) return;
        this._mutatePendingOps(function (ops) {
            return ops.map(function (rec) {
                const same = record.key && rec.key ? rec.key === record.key : rec.id === record.id;
                return same ? Object.assign({}, rec, changes) : rec;
            });
        });
    },

    /**
     * Discard the whole journal. Called when the cart it referred to no longer
     * exists (confirmed clear, completed order) — a stale intent must never fire
     * against a fresh cart.
     */
    purgePendingOps(reason) {
        if (this._pendingOps.length > 0) {
            DebugLog.log('Cart: purging ' + this._pendingOps.length + ' pending cart op(s) — ' + (reason || 'unspecified'));
        }
        this._persistPendingOps([]);
    },

    /** Is this line covered by an unconfirmed removal, or an in-flight one? */
    _isPendingRemoved(item) {
        if (!item) return false;
        if (isPendingRemoved(item, this._pendingOps)) return true;
        if (this._removingItems.size > 0) {
            if (item.id != null && this._removingItems.has(item.id)) return true;
            if (item.key && this._removingItems.has(item.key)) return true;
        }
        return false;
    },

    /**
     * The ONE filter every cart-item list passes through — whether it came from the
     * server, from localStorage, or is about to be pushed back to the server.
     * Adding a new reader without this call is how the bug comes back.
     */
    _filterPendingRemovals(items) {
        if (!Array.isArray(items) || items.length === 0) return Array.isArray(items) ? items : [];
        const self = this;
        return items.filter(function (item) { return !self._isPendingRemoved(item); });
    },

    /**
     * Capture the mutation epoch before an `await API.getCart()`.
     * @returns {number}
     */
    _beginSnapshot() {
        return this._mutationEpoch;
    },

    /**
     * Did anything change while that GET was in flight? If so the response is a
     * view of the past and adopting it would resurrect what just changed.
     */
    _snapshotStale(epoch) {
        return this._mutationEpoch !== epoch;
    },

    /**
     * Finish any removals this browser promised but never confirmed.
     *
     * Collapses concurrent callers (init, auth change, pageshow, online) into one
     * pass via a shared in-flight promise.
     *
     * @param {object} [opts] { retarget: boolean, reason: string }
     * @returns {Promise<{attempted:number, confirmed:number, absent:number,
     *                    deferred:number, dropped:number,
     *                    failed:{id,sku,name,reason}[]}>}
     */
    async replayPendingOps(opts) {
        if (this._replayInFlight) return this._replayInFlight;
        const self = this;
        this._replayInFlight = this._runPendingReplay(opts || {})
            .catch(function (e) {
                DebugLog.error('Cart: pending-op replay failed:', e);
                return { attempted: 0, confirmed: 0, absent: 0, deferred: 0, dropped: 0, failed: [] };
            })
            .then(function (result) {
                self._replayInFlight = null;
                return result;
            });
        return this._replayInFlight;
    },

    /**
     * Bind the unload flush and the replay re-kicks. Idempotent.
     */
    _bindDurabilityListeners() {
        if (this._durabilityListenersBound) return;
        this._durabilityListenersBound = true;
        if (typeof window === 'undefined') return;

        const flush = () => { this._flushPendingQuantityUpdates(); };

        // pagehide, never beforeunload: beforeunload would prompt the shopper on a
        // routine cart action, and Chrome ignores it without a prior gesture anyway.
        window.addEventListener('pagehide', flush);
        // iOS Safari is unreliable on pagehide.
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') flush();
        });

        // Back-button into a bfcached /cart runs no DOMContentLoaded and no init(),
        // so without this the page would look authoritative while the server
        // disagrees. Mirrors the ribbons-page.js precedent.
        window.addEventListener('pageshow', (event) => {
            if (!event.persisted) return;
            this._hydratePendingOps();
            this.replayPendingOps({ reason: 'bfcache-restore' })
                .then((r) => { this._renderRemovalNotice(r); })
                .catch(() => {});
        });

        // Coming back online makes every deferred removal deliverable.
        window.addEventListener('online', () => {
            this.replayPendingOps({ reason: 'online' })
                .then((r) => { this._renderRemovalNotice(r); })
                .catch(() => {});
        });
    },

    async _runPendingReplay(opts) {
        // Partial-ness lives in the RETURN VALUE, not just a log line.
        const summary = { attempted: 0, confirmed: 0, absent: 0, deferred: 0, dropped: 0, failed: [] };
        if (typeof API === 'undefined') return summary;

        this._hydratePendingOps();
        if (this._pendingOps.length === 0) return summary;

        const identity = this._cartIdentity();
        const plan = planPendingReplay(this._pendingOps, {
            authenticated: identity.authenticated,
            uid: identity.uid,
            sid: identity.sid,
            retarget: !!opts.retarget
        });

        // Unsatisfiable intents are removed so they cannot be retried forever.
        for (let i = 0; i < plan.drop.length; i++) {
            const d = plan.drop[i];
            summary.dropped++;
            DebugLog.warn('Cart: dropping pending removal (' + d.reason + ') for ' + (d.rec.sku || d.rec.id));
            this._dropPendingOpsFor(d.rec.key || d.rec.id);
        }
        summary.deferred += plan.defer.length;

        let anyResolved = false;
        // Rows we dropped WITHOUT proof they are gone (204, or a fresh-style 0).
        // Verified against a real GET below rather than assumed.
        const unverified = [];

        // SEQUENTIAL, not parallel. The backend limiter is 60 req/min per IP, so
        // firing N deletes at once is how one 429 becomes N deferrals.
        for (let i = 0; i < plan.replay.length; i++) {
            const rec = plan.replay[i];
            summary.attempted++;
            const online = typeof navigator === 'undefined' || navigator.onLine !== false;

            let response = null;
            let error = null;
            try {
                response = await API.removeFromCart(rec.id, { keepalive: true });
            } catch (e) {
                error = e;
            }

            const state = classifyRemovalOutcome(response, error, { replay: true, online: online });

            if (state === 'confirmed' || state === 'absent' || state === 'confirmed_unverified') {
                if (state === 'confirmed') summary.confirmed++;
                else if (state === 'absent') summary.absent++;
                else { summary.confirmed++; unverified.push(rec); }
                anyResolved = true;
                this._mutationEpoch++;
                this._dropPendingOpsFor(rec.key || rec.id);
                continue;
            }

            // A retargeted guest intent that did NOT resolve must be re-stamped as an
            // authenticated one. Left as-authored it would read as guest on the next
            // load, find the sid gone (the merge cleared it) and be dropped — silently
            // losing a removal we had already decided to honour.
            const reaim = (opts.retarget && !rec.auth && identity.authenticated)
                ? { auth: true, uid: identity.uid, sid: null }
                : {};

            if (state === 'defer') {
                // Offline / 401 / 429 — not a verdict. Never burns the attempt budget.
                summary.deferred++;
                this._updatePendingOp(rec, Object.assign({ deferrals: rec.deferrals + 1, lastAt: Date.now() }, reaim));
                continue;
            }

            if (state === 'retry') {
                const attempts = rec.attempts + 1;
                if (attempts >= MAX_PENDING_OP_ATTEMPTS) {
                    summary.failed.push({ id: rec.id, sku: rec.sku, name: rec.name, reason: 'attempts_exhausted' });
                    this._dropPendingOpsFor(rec.key || rec.id);
                } else {
                    this._updatePendingOp(rec, Object.assign({ attempts: attempts, lastAt: Date.now() }, reaim));
                }
                continue;
            }

            // 'reject' — the server refused and will keep refusing.
            summary.failed.push({ id: rec.id, sku: rec.sku, name: rec.name, reason: 'rejected' });
            this._dropPendingOpsFor(rec.key || rec.id);
        }

        if (anyResolved || summary.failed.length > 0) {
            this._mutationEpoch++;
            await this.loadFromServer();
            this.saveToLocalStorage();

            // Contradiction check: we dropped these without proof. If the server still
            // lists them, the removal did NOT happen and saying nothing would be a lie.
            for (let i = 0; i < unverified.length; i++) {
                const rec = unverified[i];
                const stillThere = this.items.some(function (item) {
                    return isPendingRemoved(item, [rec]);
                });
                if (stillThere) {
                    summary.confirmed = Math.max(0, summary.confirmed - 1);
                    summary.failed.push({ id: rec.id, sku: rec.sku, name: rec.name, reason: 'still_present' });
                }
            }
            this.updateUI();
        }

        return summary;
    },

    /**
     * Render the durable disclosure for a failed removal.
     *
     * A toast auto-dismisses; a durable failure needs a durable statement, so the
     * inline notice is the primary channel and the toast is the attention-getter.
     * Shown ONLY after an attempt has actually failed — never while merely in
     * flight, or every normal removal flashes a warning for 300ms.
     */
    _renderRemovalNotice(result) {
        const el = document.getElementById('cart-removal-notice');
        if (!el) return;

        const failed = (result && Array.isArray(result.failed)) ? result.failed : [];
        if (failed.length === 0) {
            el.hidden = true;
            el.textContent = '';
            return;
        }

        const names = failed.map(function (f) { return f.name || f.sku || 'An item'; });
        const label = names.length === 1
            ? Security.escapeHtml(names[0])
            : Security.escapeHtml(names.length + ' items');
        el.innerHTML = '<strong>We couldn\'t remove ' + label + '.</strong> ' +
            'It\'s still in your cart — your cart below has been refreshed from our server. Please try again.';
        el.hidden = false;

        if (typeof showToast === 'function') {
            showToast('We couldn\'t remove ' + names[0] + ' — it\'s still in your cart. Please try again.', 'warning', 6000);
        }
    },

    /**
     * Initialize cart - SERVER FIRST
     * Waits for Auth to initialize before loading cart
     */
    async init() {
        this.bindEvents();
        this.bindCheckoutButton();

        // Wait for Auth to initialize before checking authentication
        if (typeof Auth !== 'undefined') {
            // Wait for Auth.init() to complete if it hasn't yet
            if (!Auth.initialized) {
                await this.waitForAuth();
            }

            // Pre-set auth flag so session-restore SIGNED_IN events are correctly guarded
            this.isAuthenticated = Auth.isAuthenticated();

            // Listen for auth state changes
            Auth.onAuthStateChange(async (event, session) => {
                if (event === 'SIGNED_IN') {
                    // Skip merge if already authenticated (session restore, not a real sign-in)
                    if (this.isAuthenticated || this._mergeInProgress) {
                        // Still worth a replay: a removal deferred while signed out (or
                        // during an expired session) just became deliverable.
                        this.replayPendingOps({ reason: 'session-restore' })
                            .then((r) => { this._renderRemovalNotice(r); })
                            .catch(() => {});
                        return;
                    }
                    // User just logged in - merge guest cart to server and load server cart
                    await this.mergeGuestCartAndLoad();
                } else if (event === 'TOKEN_REFRESHED') {
                    // Just update auth flag, don't re-merge
                    this.isAuthenticated = true;
                    // A 401-deferred removal is now deliverable.
                    this.replayPendingOps({ reason: 'token-refresh' })
                        .then((r) => { this._renderRemovalNotice(r); })
                        .catch(() => {});
                } else if (event === 'SIGNED_OUT') {
                    // User logged out - clear cart state and localStorage cache
                    this.items = [];
                    this.appliedCoupon = null;
                    this.discountAmount = 0;
                    this.serverSummary = null;
                    this.isAuthenticated = false;
                    this.validationState = 'unknown';
                    this.validationErrors = [];
                    this._mutationEpoch++;
                    localStorage.removeItem(this.STORAGE_KEY);
                    // The pending-op journal is deliberately NOT purged. An
                    // authenticated removal that never confirmed is still sitting in
                    // that user's SERVER cart; purging here would resurrect it the next
                    // time they sign in. planPendingReplay() defers those records while
                    // signed out rather than dropping them (ERR-136).
                    this.updateUI();
                }
            });
        }

        this._bindDurabilityListeners();

        await this.loadCart();

        // Load business settings (non-blocking) — re-render cart page with server threshold
        if (typeof Config !== 'undefined' && Config.loadSettings) {
            Config.loadSettings().then(() => {
                if (document.querySelector('.cart-page')) this.renderCartPage();
            }).catch(() => {});
        }
    },

    /**
     * Wait for Auth to be initialized (max 3 seconds)
     */
    async waitForAuth() {
        const maxWait = 3000;
        const checkInterval = 50;
        let waited = 0;

        while (!Auth.initialized && waited < maxWait) {
            await new Promise(resolve => setTimeout(resolve, checkInterval));
            waited += checkInterval;
        }

        if (!Auth.initialized) {
            DebugLog.warn('Auth initialization timed out, proceeding with guest mode');
        }
    },

    /**
     * Parse server cart response into local items + summary
     */
    _parseServerCart: function(responseData) {
        const self = this;
        const items = (responseData.items || []).filter(item => item.product != null).map(item => {
            const parsed = {
                id: item.product.id,
                name: item.product.name,
                price: item.product.retail_price,
                image: typeof storageUrl === 'function' ? storageUrl(item.product.image_url) : (item.product.image_url || ''),
                // Backend-optimized thumbnail preferred for the line image
                // (mobile-ux-audit-jul2026 §6); falls back to `image` above.
                image_thumbnail_url: item.product.image_thumbnail_url || null,
                sku: item.product.sku,
                brand: item.product.brand?.name || '',
                color: item.product.color || '',
                color_hex: item.product.color_hex || null,
                quantity: item.quantity,
                source: 'core',
                // Preserve the brand-source field separately from the cart's
                // 'core' subsystem namespace. _isCompatible reads this first
                // so the COMPATIBLE/GENUINE badge — and the color-tile gate
                // in getItemImageHTML — both stay correct after a server
                // cart reload, which is when the legacy name fallback
                // (`/^compatible\b/`) would silently misfire on the May 2026
                // "Compatible Ink Cartridge Replacement for …" rename.
                product_source: item.product.source || null,
                // Per-line value-pack upsell (mobile-ux-audit-jul2026 §3c/§6):
                // present on single-colour lines that have a cheaper KCMY/CMY
                // pack; absent otherwise. Render-only — never used for pricing.
                pack_suggestion_for_line: item.pack_suggestion_for_line || null
            };
            parsed.key = self.cartItemKey(parsed);
            return parsed;
        });

        // Store server summary if provided
        const summary = responseData.summary
            ? { ...responseData.summary }
            : null;
        // Normalise the B2B block at the boundary. The live API puts the
        // metadata OBJECT at the response top level and leaves
        // `summary.b2b_discount` as a bare NUMBER (the amount). Folding the
        // object into the summary here means every one of the ~15
        // `this.serverSummary = parsed.summary` assignments carries the tier
        // and floored_line_count for free, instead of threading a new field
        // through all of them. The bare number is kept when no object is sent.
        // See computeDiscountBreakdown() above. (ERR-110)
        if (summary && responseData.b2b_discount && typeof responseData.b2b_discount === 'object') {
            summary.b2b_discount = responseData.b2b_discount;
        }

        const couponCode = responseData.coupon?.code || null;
        const discountAmount = responseData.coupon?.discount_amount || summary?.discount || 0;

        // Notify user if backend auto-removed orphaned items (deleted products)
        const removedItems = responseData.removed_items || [];
        if (removedItems.length > 0 && typeof showToast === 'function') {
            const count = removedItems.length;
            showToast(`${count} item${count > 1 ? 's were' : ' was'} removed from your cart (no longer available)`, 'info');
        }

        // Loyalty points block (null for guests or if loyalty service is down)
        const loyalty = responseData.loyalty || null;

        // Conversion signals (mobile-ux-audit-jul2026 §4h/§6). All additive and
        // best-effort — any may be absent. Stored as a side effect so the many
        // `this.items = parsed.items` call sites don't each need updating; the
        // cart response is always the authoritative current cart when parsed.
        self.serverCartMeta = {
            trust_signals: responseData.trust_signals || null,
            delivery_estimate: responseData.delivery_estimate || null,
            free_shipping_unlock: responseData.free_shipping_unlock || null,
            cart_saved_until: responseData.cart_saved_until || null
        };

        return { items, summary, couponCode, discountAmount, loyalty, meta: self.serverCartMeta };
    },

    /**
     * Load cart from server (both guest and authenticated users)
     * Guest carts use httpOnly cookie, authenticated carts use user ID
     */
    async loadCart() {
        this.loading = true;
        this.isAuthenticated = typeof Auth !== 'undefined' && Auth.isAuthenticated();

        // Read the pending-op journal BEFORE the first paint. Synchronous — one
        // storage read plus validation, no network — so this adds no latency and
        // introduces no await ahead of the first render (ERR-121, ERR-136).
        this._hydratePendingOps();

        // Load from localStorage first for instant display (fallback data)
        this.loadFromLocalStorage();
        // Counted AFTER the journal filter: a cart the journal has already emptied
        // must not make the skeleton wait on a server round trip.
        const localItemCount = this.items.length;
        this._localStorageHadItems = localItemCount > 0;

        // Show localStorage items immediately for visual feedback
        this.updateUI();

        // Finish any removal this browser promised but never confirmed. NOT awaited —
        // it must not sit between the first paint and the fan-out below. Correctness
        // does not depend on it landing first; the filter above already hides the
        // affected rows, and the epoch guard stops a stale GET adopting them.
        this.replayPendingOps({ reason: 'load' })
            .then((result) => { this._renderRemovalNotice(result); })
            .catch(() => { /* replayPendingOps already logs */ });

        if (typeof API !== 'undefined') {
            try {
                if (this.isAuthenticated) {
                    await this.syncWithServer();
                } else {
                    // Guest users: Server-first with localStorage fallback
                    const epoch = this._beginSnapshot();
                    try {
                        const response = await API.getCart();
                        if (this._snapshotStale(epoch)) {
                            await this._handleStaleSnapshot('loadCart(guest)');
                        } else if (response.ok && response.data) {
                            const parsed = this._parseServerCart(response.data);
                            parsed.items = this._filterPendingRemovals(parsed.items);

                            // If server has items, use them (with fresh prices)
                            if (parsed.items.length > 0) {
                                this.items = parsed.items;
                                this.serverSummary = parsed.summary;
                                this.appliedCoupon = parsed.couponCode;
                                this.discountAmount = parsed.discountAmount;
                                this.saveToLocalStorage();
                                this.updateUI();
                            } else if (localItemCount > 0) {
                                // Server empty but localStorage has items - keep localStorage
                                this.serverSummary = null; // No server totals for local-only items
                                this.updateUI();
                                // Sync localStorage items to server in background
                                const localItems = this.getGuestCartItems();
                                for (const item of localItems) {
                                    try {
                                        await API.addToCart(item.id, item.quantity);
                                    } catch (e) {
                                        DebugLog.error('Failed to sync item to server:', e);
                                    }
                                }
                                // After syncing, reload from server to get fresh prices
                                const refreshEpoch = this._beginSnapshot();
                                try {
                                    const refreshResponse = await API.getCart();
                                    if (this._snapshotStale(refreshEpoch)) {
                                        await this._handleStaleSnapshot('loadCart(guest refresh)');
                                    } else if (refreshResponse.ok && refreshResponse.data) {
                                        const refreshed = this._parseServerCart(refreshResponse.data);
                                        refreshed.items = this._filterPendingRemovals(refreshed.items);
                                        if (refreshed.items.length > 0) {
                                            this.items = refreshed.items;
                                            this.serverSummary = refreshed.summary;
                                            this.saveToLocalStorage();
                                            this.updateUI();
                                        }
                                    }
                                } catch (e) {
                                    DebugLog.warn('Failed to refresh after sync:', e);
                                }
                            } else {
                                this.serverSummary = null;
                                this.updateUI();
                            }
                        }
                    } catch (error) {
                        DebugLog.warn('Could not load guest cart from server:', error.message);
                        // Keep localStorage data, but mark that we have no server totals
                        this.serverSummary = null;
                    }
                }
            } finally {
                // IMPORTANT: Only set loading to false AFTER all server operations complete
                this.loading = false;
                this.updateUI();
            }
        } else {
            this.serverSummary = null;
            this.loading = false;
            this.updateUI();
        }
    },

    /**
     * Get guest cart items from localStorage (without clearing)
     */
    getGuestCartItems() {
        try {
            const stored = localStorage.getItem(this.STORAGE_KEY);
            const items = stored ? JSON.parse(stored) : [];
            // Filtered because this feeds the guest re-push loop in loadCart(). An
            // unfiltered mirror can re-addToCart a row the shopper just removed,
            // resurrecting it INTO the server — the same symptom with no race at all.
            return this._filterPendingRemovals(items);
        } catch (e) {
            return [];
        }
    },

    /**
     * Sync cart with server (background operation for authenticated users)
     */
    async syncWithServer() {
        const epoch = this._beginSnapshot();
        try {
            const response = await API.getCart();
            if (this._snapshotStale(epoch)) {
                return this._handleStaleSnapshot('syncWithServer');
            }
            if (response.ok && response.data) {
                const parsed = this._parseServerCart(response.data);

                // Subtract unconfirmed removals BEFORE the empty-cart guard below.
                // "The server had items but every one of them is a pending removal" is a
                // LEGITIMATELY empty cart, not a suspicious one — filtering after the
                // guard would take the fallback branch and resurrect the local copy.
                parsed.items = this._filterPendingRemovals(parsed.items);

                // Guard: don't clear local items if server unexpectedly returns empty
                if (parsed.items.length === 0 && this._filterPendingRemovals(this.items).length > 0) {
                    DebugLog.warn('Server returned empty cart — keeping local items as fallback');
                    this.serverSummary = null;
                    this.updateUI();
                    return;
                }

                // Merge back any local core items the server doesn't know about yet
                // (e.g. add-to-cart API call was in-flight during navigation).
                // Superseded by the epoch guard above; kept as defence in depth.
                const serverIds = new Set(parsed.items.map(i => i.id));
                const localOnly = this._filterPendingRemovals(this.items).filter(i => {
                    return i.source === 'core' && !serverIds.has(i.id);
                });
                this.items = parsed.items;
                if (localOnly.length > 0) {
                    for (const item of localOnly) {
                        if (typeof API !== 'undefined') {
                            try {
                                await API.addToCart(item.id, item.quantity);
                            } catch (e) {
                                DebugLog.error('Failed to sync local item:', item.id, e);
                            }
                        }
                    }
                    // Reload to get accurate server state after adding items
                    await this.loadFromServer();
                    this.saveToLocalStorage();
                }
                this.serverSummary = parsed.summary;
                this.appliedCoupon = parsed.couponCode;
                this.discountAmount = parsed.discountAmount;
                this.loyalty = parsed.loyalty;

                this.saveToLocalStorage();

                this.updateUI();
            }
        } catch (error) {
            DebugLog.warn('Could not sync cart with server:', error.message);
            this.serverSummary = null;
            // Keep using localStorage data
        }
    },

    /**
     * Save cart to localStorage as a cache for ALL users.
     * Server remains source of truth for authenticated users,
     * but localStorage acts as a fallback for slow/failed server calls.
     */
    saveToLocalStorage() {
        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.items));
        } catch (e) {
            DebugLog.error('Failed to save cart:', e);
        }
    },

    /**
     * Load cart from server (authenticated users)
     */
    async loadFromServer() {
        const epoch = this._beginSnapshot();
        try {
            const response = await API.getCart();
            if (this._snapshotStale(epoch)) {
                // Something mutated while this GET was in flight, so the body we just
                // received is a view of the past. Adopting it would resurrect whatever
                // changed (ERR-136).
                return this._handleStaleSnapshot('loadFromServer');
            }
            if (response.ok && response.data) {
                const parsed = this._parseServerCart(response.data);

                // Subtract unconfirmed removals — in-flight this page AND journaled
                // across reloads.
                parsed.items = this._filterPendingRemovals(parsed.items);

                this.items = parsed.items;
                this.serverSummary = parsed.summary;
                this.appliedCoupon = parsed.couponCode;
                this.discountAmount = parsed.discountAmount;
                this.loyalty = parsed.loyalty;
                this._staleRefetches = 0;
            }
        } catch (error) {
            DebugLog.error('Failed to load cart from server:', error);
            this.serverSummary = null;
            // Keep existing items on failure (don't clear)
        }
    },

    /**
     * A server snapshot arrived after the state it described had already changed.
     *
     * Re-fetch once (bounded), otherwise keep local state and drop `serverSummary`
     * so the UI is honest about having no server pricing — `isUsingEstimatedPrices()`
     * already surfaces that.
     */
    async _handleStaleSnapshot(where) {
        DebugLog.warn('Cart: discarded a stale server cart snapshot in ' + where);
        if (this._staleRefetches < 2) {
            this._staleRefetches++;
            return this.loadFromServer();
        }
        DebugLog.warn('Cart: stale-snapshot refetch budget exhausted — keeping local items without server totals');
        this.serverSummary = null;
    },

    /**
     * Load cart from localStorage (guest users only)
     */
    loadFromLocalStorage() {
        try {
            const stored = localStorage.getItem(this.STORAGE_KEY);
            const items = stored ? JSON.parse(stored) : [];
            // First paint. The mirror still contains anything whose DELETE was
            // interrupted, so it is filtered here — this is what stops the removed
            // item flashing back before the server reconcile lands. Synchronous:
            // no await is introduced ahead of the first render (ERR-121).
            this.items = this._filterPendingRemovals(items);
            this.serverSummary = null; // localStorage has no server totals
        } catch (e) {
            DebugLog.error('Failed to load guest cart:', e);
            this.items = [];
            this.serverSummary = null;
        }
    },


    /**
     * Merge guest cart into server cart when user logs in
     * Uses /api/cart/merge endpoint for server-side guest carts (httpOnly cookie)
     * Also handles legacy localStorage items for backward compatibility
     */
    async mergeGuestCartAndLoad() {
        if (this._mergeInProgress) return;
        this._mergeInProgress = true;

        try {
            this.isAuthenticated = true;

            // Read and clear legacy localStorage items BEFORE any server calls
            let legacyItems = [];
            try {
                const stored = localStorage.getItem(this.STORAGE_KEY);
                if (stored) {
                    legacyItems = JSON.parse(stored);
                    localStorage.removeItem(this.STORAGE_KEY);
                }
            } catch (e) {
                DebugLog.error('Failed to parse legacy cart:', e);
            }
            // If the crash landed between the journal write and saveToLocalStorage,
            // this snapshot still holds the removed row and the migration loop below
            // would re-add it to the user cart (ERR-136).
            legacyItems = this._filterPendingRemovals(legacyItems);

            // Step 1: Merge guest cookie cart into user cart FIRST
            if (typeof API !== 'undefined') {
                try {
                    const mergeResult = await API.mergeCart();
                    if (mergeResult.ok) {
                        if (mergeResult.data?.merged_count > 0 || mergeResult.data?.added_count > 0) {
                            if (typeof showToast === 'function') {
                                showToast(`${mergeResult.data.total_items} items in your cart`, 'success');
                            }
                        }
                    }
                } catch (e) {
                    DebugLog.error('Cart merge failed:', e);
                }
            }

            // Step 1b: the merge just copied the guest cart — INCLUDING any row whose
            // DELETE was aborted — into the user cart. Without this, "guest removes →
            // signs in" brings the item back permanently. Awaited on purpose: this is a
            // post-sign-in flow, not the first-paint path, and the ordering (replay
            // strictly after the merge, strictly before the reconciling GET below) is
            // load-bearing. `retarget` re-aims guest-authored intents at the now
            // authenticated cart.
            this._mutationEpoch++;
            await this.replayPendingOps({ reason: 'post-merge', retarget: true });

            // Step 2: Load server cart to see what's already there
            await this.loadFromServer();
            const serverKeys = new Set(this.items.map(i => i.key || this.cartItemKey(i)));

            // Step 3: Only add localStorage items NOT already on server
            if (legacyItems.length > 0 && typeof API !== 'undefined') {
                for (const item of legacyItems) {
                    const k = item.key || this.cartItemKey(item);
                    if (!serverKeys.has(k)) {
                        try {
                            await API.addToCart(item.id, item.quantity);
                        } catch (e) {
                            DebugLog.error('Failed to migrate legacy item:', item.id, e);
                        }
                    }
                }
                // Reload to get accurate totals after adding new items
                await this.loadFromServer();
            }

            this.saveToLocalStorage();
            this.updateUI();
        } finally {
            this._mergeInProgress = false;
        }
    },

    /**
     * Validate cart with server before checkout.
     * Checks stock availability and price consistency.
     * Returns { valid: boolean, errors: array, priceChanges: array }
     */
    async validateCart(acknowledgePriceChanges) {
        if (typeof API === 'undefined') {
            return { valid: false, errors: ['Unable to validate cart. Please try again.'], priceChanges: [] };
        }

        // Get Turnstile token for bot verification (non-blocking — returns null if unavailable)
        const turnstileToken = typeof Auth !== 'undefined' ? await Auth.getTurnstileToken() : null;

        try {
            const response = await API.validateCart(turnstileToken, acknowledgePriceChanges);
            if (response.ok) {
                const data = response.data || {};
                const errors = [];
                const priceChanges = [];

                // Parse issues array from backend response
                // Backend returns: { cart_item_id, sku, issue, name?, available?, old_price?, new_price? }
                if (data.issues && data.issues.length > 0) {
                    data.issues.forEach(issue => {
                        const label = issue.name || issue.sku || 'Item';
                        if (issue.issue === 'Price has changed') {
                            priceChanges.push({
                                name: label,
                                sku: issue.sku,
                                oldPrice: issue.old_price,
                                newPrice: issue.new_price
                            });
                        } else if (issue.issue === 'Product is no longer available') {
                            errors.push(`"${label}" is no longer available`);
                        } else {
                            errors.push(`${label}: ${issue.issue || 'unavailable'}`);
                        }
                    });
                }

                // Check for price changes in valid_items
                if (data.valid_items && data.valid_items.length > 0) {
                    data.valid_items.forEach(item => {
                        if (item.price_changed) {
                            priceChanges.push({
                                name: item.name || 'Item',
                                sku: item.sku,
                                oldPrice: item.old_price,
                                newPrice: item.unit_price
                            });
                        }
                    });
                }

                const valid = errors.length === 0 && priceChanges.length === 0 && data.is_valid !== false;
                this.validationState = valid ? 'valid' : 'invalid_price';
                this.validationErrors = errors;

                return { valid, errors, priceChanges };
            } else {
                // Non-ok API response = infrastructure error (auth, Turnstile, server failure).
                // Stock/availability errors always come via data.issues in an ok: true response.
                // Re-throw so the checkout handler's catch block allows proceeding.
                throw new Error(API.extractErrorMessage(response, 'Cart validation failed'));
            }
        } catch (error) {
            DebugLog.error('Cart validation error:', error);
            // Re-throw server/network errors so the checkout handler's catch
            // can allow proceeding — checkout page will re-validate before charging
            throw error;
        }
    },

    /**
     * Bind checkout button with pre-checkout validation
     * Intercepts the checkout anchor click to validate cart first
     * SECURITY: Blocks checkout if server pricing is unavailable
     */
    bindCheckoutButton: function() {
        const self = this;
        document.addEventListener('click', async (e) => {
            const checkoutLink = e.target.closest('#checkout-btn, .cart-summary__checkout-btn');
            if (!checkoutLink) return;

            e.preventDefault();

            // A non-empty cart means either local items exist OR server pricing exists
            // (serverSummary is cleared on remove/clear, so it's a reliable signal).
            const cartHasItems = self.items.length > 0 || self.hasServerPricing();
            if (!cartHasItems) {
                if (typeof showToast === 'function') {
                    showToast('Your cart is empty', 'error');
                }
                return;
            }

            // Validate cart for stock issues and price changes.
            // Stock warnings are advisory (never block navigation — checkout re-validates).
            // Price changes require explicit acknowledgment before proceeding.
            try {
                const result = await self.validateCart();

                // Show stock/availability warnings as toasts (advisory only)
                if (result.errors && result.errors.length > 0) {
                    if (typeof showToast === 'function') {
                        result.errors.forEach(function(err, i) {
                            setTimeout(function() { showToast(err, 'warning', 6000); }, i * 500);
                        });
                    }
                }

                // Price changes require user acknowledgment before checkout
                if (result.priceChanges && result.priceChanges.length > 0) {
                    const accepted = await self.showPriceChangeModal(result.priceChanges);
                    if (!accepted) return; // User declined — stay on cart
                    // Acknowledge price changes so backend updates snapshots
                    try {
                        await self.validateCart(true);
                    } catch (_ackErr) {
                        // Acknowledgment failed — proceed anyway, checkout will re-validate
                    }
                }
            } catch (_) {
                // Validation failed (network/Turnstile/auth) — proceed anyway.
            }

            window.location.href = '/checkout';
        });
    },

    /**
     * Show a modal listing price changes and ask the user to accept or decline.
     * Returns a Promise that resolves true (accept) or false (decline).
     */
    showPriceChangeModal(priceChanges) {
        return new Promise((resolve) => {
            const existing = document.getElementById('price-change-modal');
            if (existing) existing.remove();

            // esc() provided by utils.js
            const fmt = typeof formatPrice === 'function' ? formatPrice : (v) => `$${Number(v).toFixed(2)}`;

            const rows = priceChanges.map(pc =>
                `<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid #eee">` +
                    `<span style="font-weight:500">${esc(pc.name)}</span>` +
                    `<span>` +
                        (pc.oldPrice != null ? `<span style="text-decoration:line-through;color:#999;margin-right:8px">${esc(fmt(pc.oldPrice))}</span>` : '') +
                        `<span style="color:#e53e3e;font-weight:600">${esc(fmt(pc.newPrice))}</span>` +
                    `</span>` +
                `</div>`
            ).join('');

            const overlay = document.createElement('div');
            overlay.id = 'price-change-modal';
            overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5)';
            overlay.innerHTML =
                `<div style="background:#fff;border-radius:12px;padding:28px 24px;max-width:440px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.18)">` +
                    `<h3 style="margin:0 0 6px;font-size:18px">Prices Have Changed</h3>` +
                    `<p style="margin:0 0 16px;color:#666;font-size:14px">The following items have updated prices since you added them to your cart:</p>` +
                    `<div style="margin-bottom:20px">${rows}</div>` +
                    `<div style="display:flex;gap:12px;justify-content:flex-end">` +
                        `<button type="button" id="price-change-decline" class="btn btn--secondary">Return to Cart</button>` +
                        `<button type="button" id="price-change-accept" class="btn btn--primary">Accept &amp; Continue</button>` +
                    `</div>` +
                `</div>`;

            document.body.appendChild(overlay);

            const cleanup = (accepted) => {
                overlay.remove();
                resolve(accepted);
            };

            document.getElementById('price-change-accept').addEventListener('click', () => cleanup(true));
            document.getElementById('price-change-decline').addEventListener('click', () => cleanup(false));
            overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(false); });
        });
    },

    /**
     * Bind cart-related events
     */
    bindEvents: function() {
        document.addEventListener('click', async (e) => {
            // Contact-us CTA on OOS cards (contact-button-may2026.md). The
            // crosssell modal nests buttons inside an outer <a>, so a real
            // anchor would be auto-closed by the HTML5 parser. The button
            // navigates and stops the bubble that would open the PDP.
            const contactBtn = e.target.closest('[data-action="contact"]');
            if (contactBtn) {
                e.preventDefault();
                e.stopPropagation();
                window.location.href = '/contact';
                return;
            }

            // Add to cart button
            if (e.target.matches('.product-card__add-btn, .add-to-cart-btn')) {
                e.preventDefault();
                const btn = e.target;
                const productData = {
                    id: btn.dataset.productId,
                    sku: btn.dataset.productSku,
                    name: btn.dataset.productName,
                    price: parseFloat(btn.dataset.productPrice) || 0,
                    image: btn.dataset.productImage || '',
                    // Subsystem namespace (core / cross-sell / …)
                    source: btn.dataset.productSubsystem || 'core',
                    // Brand source (genuine / compatible / remanufactured) for the
                    // COMPATIBLE/GENUINE badge — not used in the composite key.
                    product_source: btn.dataset.productSource || null
                };

                if (productData.id) {
                    await this.addItem(productData);

                    const originalText = btn.textContent;
                    btn.textContent = 'Added!';
                    btn.classList.add('btn--success');
                    setTimeout(() => {
                        btn.textContent = originalText;
                        btn.classList.remove('btn--success');
                    }, 1500);
                }
            }

            // Quantity increase
            const increaseBtn = e.target.closest('.quantity-selector__btn--increase');
            if (increaseBtn) {
                const selector = increaseBtn.closest('.quantity-selector');
                const input = selector.querySelector('.quantity-selector__input');
                const itemId = selector.dataset.itemKey || selector.dataset.itemId;
                const maxQty = this.MAX_QUANTITY;
                const newValue = parseInt(input.value) + 1;
                if (newValue <= maxQty) {
                    input.value = newValue;
                    this._debouncedQuantityUpdate(itemId, newValue);
                }
            }

            // Quantity decrease
            const decreaseBtn = e.target.closest('.quantity-selector__btn--decrease');
            if (decreaseBtn) {
                const selector = decreaseBtn.closest('.quantity-selector');
                const input = selector.querySelector('.quantity-selector__input');
                const itemId = selector.dataset.itemKey || selector.dataset.itemId;
                const newValue = parseInt(input.value) - 1;
                if (newValue >= 1) {
                    input.value = newValue;
                    this._debouncedQuantityUpdate(itemId, newValue);
                }
                // If user wants to go below 1, they must use the remove button
            }

            // Remove item
            const removeBtn = e.target.closest('.cart-item__remove, .btn-remove');
            if (removeBtn) {
                const cartItem = removeBtn.closest('.cart-item');
                if (cartItem) {
                    const itemId = cartItem.dataset.itemKey || cartItem.dataset.itemId;
                    // Disable BEFORE the await. The id-level guard in removeItem() is
                    // what actually protects the request, but it is not sufficient on
                    // its own: updateUI() rebuilds #cart-items via innerHTML between the
                    // two clicks of a double-click, so the second click can land on a
                    // DIFFERENT item's button at the same coordinates and remove the
                    // wrong line. The two guards cover both orderings.
                    if (removeBtn.disabled) return;
                    removeBtn.disabled = true;
                    cartItem.classList.add('cart-item--removing');
                    cartItem.setAttribute('aria-busy', 'true');
                    await this.removeItem(itemId);
                }
            }

            // Clear cart
            if (e.target.matches('.clear-cart-btn')) {
                if (confirm('Are you sure you want to clear your cart?')) {
                    await this.clear();
                }
            }

        });

        // Quantity input change (manual typing)
        document.addEventListener('change', async (e) => {
            if (e.target.matches('.quantity-selector__input')) {
                const selector = e.target.closest('.quantity-selector');
                const itemId = selector.dataset.itemKey || selector.dataset.itemId;
                const maxQty = this.MAX_QUANTITY;
                let newValue = parseInt(e.target.value);

                // Clamp to valid range
                if (isNaN(newValue) || newValue < 1) {
                    newValue = 1;
                    e.target.value = 1;
                }
                if (newValue > maxQty) {
                    newValue = maxQty;
                    e.target.value = maxQty;
                }

                this._debouncedQuantityUpdate(itemId, newValue);
            }
        });
    },

    /**
     * Debounced quantity update to prevent rapid-fire API calls.
     * Uses surgical DOM updates instead of full innerHTML rebuild.
     */
    _debouncedQuantityUpdate: function(itemId, quantity) {
        if (this._quantityDebounceTimers[itemId]) {
            clearTimeout(this._quantityDebounceTimers[itemId]);
        }

        const item = this.items.find(function(i) { return i.key === itemId || i.id === itemId; });
        if (!item) return;

        // Changing a quantity supersedes an unconfirmed removal of the same line.
        this._dropPendingOpsFor(item.key || item.id);

        const clampedQty = Math.min(quantity, this.MAX_QUANTITY);
        const oldQty = item.quantity;
        item.quantity = clampedQty;
        this._mutationEpoch++;
        this.saveToLocalStorage();

        // Apply price delta to server summary for responsive display
        // (server will replace with correct values after API responds)
        if (this.serverSummary && this.serverSummary.subtotal !== undefined) {
            const priceDelta = item.price * (clampedQty - oldQty);
            this.serverSummary.subtotal += priceDelta;
            if (this.serverSummary.total !== undefined) {
                this.serverSummary.total += priceDelta;
            }
        }

        // Surgical DOM update — only touch the changed item + summary numbers
        this._updateCartItemDOM(itemId);
        this._updateCartSummaryDOM();

        // Remembered so an unload can dispatch the value the timer never got to.
        this._quantityPending[itemId] = clampedQty;

        this._quantityDebounceTimers[itemId] = setTimeout(async () => {
            delete this._quantityDebounceTimers[itemId];
            delete this._quantityPending[itemId];
            await this._executeQuantityUpdate(itemId, clampedQty);
        }, 400);
    },

    /**
     * Dispatch every debounced quantity change immediately, with `keepalive` so it
     * survives the unload that triggered this.
     *
     * Same bug class as the headline removal bug: a 400ms debounce plus an immediate
     * refresh silently loses the change. Bound to `pagehide` AND
     * `visibilitychange → hidden` because iOS Safari is unreliable on `pagehide`.
     * Deliberately NOT `beforeunload` — that would prompt the shopper.
     *
     * Fire-and-forget by necessity: nothing can be awaited during unload. This is
     * why the flush is a best-effort latency fix and not a durability guarantee —
     * quantity intents are last-write-wins and are not journaled (see ERR-136).
     */
    _flushPendingQuantityUpdates() {
        const ids = Object.keys(this._quantityPending);
        if (ids.length === 0) return;
        for (let i = 0; i < ids.length; i++) {
            const itemId = ids[i];
            const qty = this._quantityPending[itemId];
            if (this._quantityDebounceTimers[itemId]) {
                clearTimeout(this._quantityDebounceTimers[itemId]);
                delete this._quantityDebounceTimers[itemId];
            }
            delete this._quantityPending[itemId];

            const item = this.items.find(function(i) { return i.key === itemId || i.id === itemId; });
            const isCore = !item || !item.source || item.source === 'core';
            const actualId = item ? item.id : itemId;
            if (!isCore || typeof API === 'undefined') continue;
            try {
                API.updateCartItem(actualId, qty, { keepalive: true }).catch(function () { /* unload */ });
            } catch (e) {
                DebugLog.warn('Cart: quantity flush failed on unload:', e);
            }
        }
    },

    /**
     * Execute the actual quantity update after debounce.
     * Guarded per-item to prevent concurrent API calls for the same item.
     * Queues the latest value if an API call is already in-flight.
     */
    async _executeQuantityUpdate(itemId, quantity) {
        // Guard: if already in-flight for this item, queue the value
        if (this._quantityInFlight[itemId]) {
            this._quantityQueued[itemId] = quantity;
            return;
        }

        this._quantityInFlight[itemId] = true;
        const oldQuantity = quantity;
        const item = this.items.find(function(i) { return i.key === itemId || i.id === itemId; });
        const isCore = !item || !item.source || item.source === 'core';
        const actualId = item ? item.id : itemId;

        try {
            if (isCore && typeof API !== 'undefined') {
                try {
                    const response = await API.updateCartItem(actualId, quantity);
                    const hasPendingUpdate = this._quantityQueued[itemId] !== undefined
                                          || this._quantityDebounceTimers[itemId];

                    if (response.ok) {
                        if (response.data?.items) {
                            const parsed = this._parseServerCart(response.data);
                            this.items = parsed.items;
                            this.serverSummary = parsed.summary;
                            this.appliedCoupon = parsed.couponCode;
                            this.discountAmount = parsed.discountAmount;
                        } else {
                            await this.loadFromServer();
                        }
                        // Only update DOM if no pending update (queue or debounce timer)
                        if (!hasPendingUpdate) {
                            this._updateCartItemDOM(itemId);
                            this._updateCartSummaryDOM();
                        }
                    } else {
                        // Generic failure — reload from server for correct state
                        await this.loadFromServer();
                        if (!hasPendingUpdate) {
                            this._updateCartItemDOM(itemId);
                            this._updateCartSummaryDOM();
                        }
                        if (typeof showToast === 'function') {
                            showToast('Failed to update quantity. Please try again.', 'error');
                        }
                    }
                } catch (error) {
                    DebugLog.error('Failed to sync quantity to server:', error);
                    await this.loadFromServer();
                    if (!this._quantityQueued[itemId] && !this._quantityDebounceTimers[itemId]) {
                        this._updateCartItemDOM(itemId);
                        this._updateCartSummaryDOM();
                    }
                    if (typeof showToast === 'function') {
                        showToast('Network error. Quantity may have reverted.', 'error');
                    }
                }
            }

            // Track analytics
            const trackItem = this.items.find(function(i) { return i.key === itemId || i.id === itemId; });
            if (typeof CartAnalytics !== 'undefined' && trackItem) {
                CartAnalytics.trackUpdateQuantity(trackItem, oldQuantity, trackItem.quantity);
            }
        } finally {
            delete this._quantityInFlight[itemId];

            // If a new value was queued while in-flight, fire it now
            if (this._quantityQueued[itemId] !== undefined) {
                const queued = this._quantityQueued[itemId];
                delete this._quantityQueued[itemId];
                await this._executeQuantityUpdate(itemId, queued);
            }
        }
    },

    /**
     * Surgically update a single cart item's DOM elements.
     * Avoids full innerHTML rebuild to prevent destroying in-flight interactions.
     */
    _updateCartItemDOM: function(itemId) {
        const item = this.items.find(function(i) { return i.key === itemId || i.id === itemId; });
        if (!item) return;

        const cartItemEl = document.querySelector('.cart-item[data-item-key="' + itemId + '"]')
            || document.querySelector('.cart-item[data-item-id="' + itemId + '"]');
        if (!cartItemEl) return;

        // Update quantity input (only if not focused — don't fight the user)
        const input = cartItemEl.querySelector('.quantity-selector__input');
        if (input && document.activeElement !== input) {
            input.value = item.quantity;
        }

        // Update input max and + button disabled state
        if (input) input.max = 100;
        const increaseBtn = cartItemEl.querySelector('.quantity-selector__btn--increase');
        if (increaseBtn) {
            increaseBtn.disabled = item.quantity >= 100;
        }

        // Update line total
        const totalEl = cartItemEl.querySelector('.cart-item__total');
        if (totalEl) {
            totalEl.textContent = formatPrice(item.price * item.quantity);
        }

        // Update mobile price line
        const priceMobile = cartItemEl.querySelector('.cart-item__price-mobile');
        if (priceMobile) {
            priceMobile.textContent = formatPrice(item.price);
        }

        // The volume nudge is a function of the quantity that just changed, so
        // the surgical path has to repaint it too. Skipping this here is exactly
        // how the loyalty row drifted between the two renderers (ERR-110): the
        // full paint would be right and the quantity-change path stale.
        cartItemEl.setAttribute('data-quantity', String(item.quantity));
        this.decorateVolumeNudges(cartItemEl.parentElement || cartItemEl);
    },

    /**
     * Business volume nudges on cart lines: "Add 1 more to reach 5+ — $32.19
     * each, saving $14.00 on this line."
     *
     * Fire-and-forget and additive: the retail lines are already painted and
     * correct for everyone. Guests and retail accounts short-circuit inside
     * Business.decorateCartLines without a network request.
     *
     * This cannot come from the cart payload. Cart lines carry retail
     * `price_snapshot` / `line_total` and no per-line B2B figure at all — the
     * discount surfaces only as one cart-level `b2b_discount.discount_amount` —
     * so the ladder is the only route from "you saved $4.88" to "here is how to
     * save more", which is the entire point of a volume scheme.
     *
     * @param {Element} container
     */
    decorateVolumeNudges: function(container) {
        if (typeof Business === 'undefined' || !container) return;
        Business.decorateCartLines(container, this.MAX_QUANTITY).catch(function(e) {
            DebugLog.warn('[Cart] volume nudges failed:', e && e.message);
        });
    },

    /**
     * Render the cart summary's three discount rows — "You Save", loyalty and
     * business account — from one breakdown.
     *
     * This exists because renderCartPage() and _updateCartSummaryDOM() used to
     * write these rows separately and had drifted: only the surgical path
     * rendered the loyalty row and netted it out, so on a fresh cart load the
     * loyalty row stayed hidden until the shopper changed a quantity. Adding a
     * third discount line to two divergent code paths would have doubled that
     * bug, so both paths now call this. (errors.md ERR-110)
     *
     * @param {number} discount  aggregate discount (Cart.getDiscount())
     */
    _renderDiscountRows: function(discount) {
        const { loyalty, b2b, other, b2bMeta } = computeDiscountBreakdown(this.serverSummary, discount);

        const setRow = (rowId, valueId, amount) => {
            const row = document.getElementById(rowId);
            const el = document.getElementById(valueId);
            if (!row || !el) return;
            if (amount > 0) {
                row.hidden = false;
                el.textContent = '-' + formatPrice(amount);
            } else {
                row.hidden = true;
            }
        };

        setRow('cart-savings-row', 'cart-savings', other);
        setRow('cart-loyalty-row', 'cart-loyalty-discount', loyalty);
        setRow('cart-b2b-row', 'cart-b2b-discount', b2b);

        // Company label on the B2B row — never a percentage. See
        // businessDiscountLabel().
        const b2bLabel = document.getElementById('cart-b2b-label');
        if (b2bLabel && b2b > 0) b2bLabel.textContent = businessDiscountLabel(b2bMeta);

        // When the loss floor bit on one or more lines, say so plainly rather
        // than letting the shopper wonder why the ladder didn't pay out in full.
        //
        // `effective_percent` is stated as "across your cart" on purpose: it is
        // the realised rate over the WHOLE cart including lines below their
        // entry rung, so an unqualified "you saved 0.7%" would read as the
        // customer's discount rate rather than an average over their basket.
        const note = document.getElementById('cart-b2b-note');
        if (note) {
            const flooredLines = b2bMeta && Number(b2bMeta.floored_line_count) > 0;
            if (b2b > 0 && flooredLines) {
                const pct = b2bMeta && Number.isFinite(Number(b2bMeta.effective_percent))
                    ? Number(b2bMeta.effective_percent)
                    : null;
                const realised = pct != null && typeof Business !== 'undefined'
                    ? ` That works out at ${Business.formatPercent(pct)} across your cart.`
                    : '';
                note.textContent = 'Some items are already at their best possible price.' + realised;
                note.hidden = false;
            } else {
                note.hidden = true;
            }
        }
    },

    /**
     * Surgically update cart summary DOM elements.
     * Updates counts, subtotal, shipping, total, progress bar without rebuilding cart items.
     */
    _updateCartSummaryDOM: function() {
        // Update header cart count badges
        const itemCount = this.getItemCount();
        document.querySelectorAll('.cart-count, .cart-badge, #cart-count').forEach(el => {
            el.textContent = itemCount;
            el.hidden = itemCount === 0;
        });
        if (typeof updateCartCount === 'function') {
            updateCartCount(itemCount);
        }
        try { localStorage.setItem('cart_count', itemCount); } catch (e) { /* ignore */ }

        // Only update summary section if on cart page
        if (!document.querySelector('.cart-page')) return;

        const subtotal = this.getSubtotal();
        const discount = this.getDiscount();
        // Cart page total excludes shipping — shipping is calculated at checkout
        const cartTotal = subtotal - discount;

        const itemCountEl = document.getElementById('cart-item-count');
        const subtotalEl = document.getElementById('cart-subtotal');
        const gstEl = document.getElementById('cart-gst');
        const totalEl = document.getElementById('cart-total');
        if (itemCountEl) itemCountEl.textContent = itemCount;
        if (subtotalEl) subtotalEl.textContent = formatPrice(subtotal);
        if (gstEl) gstEl.textContent = formatPrice(this.serverSummary?.gst_amount != null ? this.serverSummary.gst_amount : calculateGST(cartTotal));
        if (totalEl) totalEl.textContent = formatPrice(cartTotal) + ' NZD';

        // Savings / loyalty / business-account rows — one shared renderer.
        this._renderDiscountRows(discount);

        // Cart summary class-based elements
        const cartSummary = document.querySelector('.cart-summary');
        if (cartSummary) {
            const subtotalClassEl = cartSummary.querySelector('.cart-summary__subtotal');
            const totalClassEl = cartSummary.querySelector('.cart-summary__total-value');

            if (subtotalClassEl) subtotalClassEl.textContent = formatPrice(subtotal);
            if (totalClassEl) totalClassEl.textContent = formatPrice(cartTotal);
        }
    },

    /**
     * Add item to cart - SERVER FIRST for all users
     * Both guest and authenticated users use server-side cart
     * Also saves to localStorage for cross-origin cookie fallback
     */
    async addItem(product) {
        // The cart's `source` field is a SUBSYSTEM namespace — it tags where
        // the row was added from ('core' for the main catalog, 'cross-sell'
        // for upsell strips, etc.) and is part of the composite key so the
        // same SKU can live in both buckets. It is NOT the product's genuine/
        // compatible classification.
        //
        // For the COMPATIBLE/GENUINE badge we capture `product_source`
        // separately. May 2026 catalog overhaul (api-changes-may2026.md §2)
        // changed the compatible name format and asked us to stop parsing
        // names — `product_source` lets the cart, favourites, and checkout
        // render the badge from a real signal instead of `name.includes
        // ('compatible')`. Falls through `product.product_source` first for
        // explicit callers; otherwise treats `product.source` as the brand
        // source when it's a known catalog value (i.e. not the cart-namespace
        // sentinels 'core' / 'cross-sell').
        const source = product.source || 'core';
        const productSource = product.product_source
            || (product.source && !['core', 'cross-sell'].includes(product.source) ? product.source : null);
        const key = this.cartItemKey({ source: source, sku: product.sku, slug: product.slug, id: product.id });
        const isCore = source === 'core';

        // Re-adding supersedes any unconfirmed removal of the same line. Without
        // this, "remove → re-add → refresh" replays a DELETE against the row that was
        // just put back (ERR-136).
        this._dropPendingOpsFor(key);
        if (product.id) this._dropPendingOpsFor(product.id);

        // Update local cart first (instant feedback)
        const existingItem = this.items.find(function(item) {
            return (item.key || Cart.cartItemKey(item)) === key;
        });
        // Recorded for a surgical rollback. A whole-array snapshot taken here would
        // resurrect a DIFFERENT item whose removal landed while this add was in flight.
        const hadExisting = !!existingItem;
        const addedQty = product.quantity || 1;

        if (existingItem) {
            existingItem.quantity += product.quantity || 1;
            // Backfill product_source on legacy rows once we learn it
            if (productSource && !existingItem.product_source) {
                existingItem.product_source = productSource;
            }
        } else {
            this.items.push({
                id: product.id,
                name: product.name,
                price: product.price,
                image: product.image || '',
                sku: product.sku || '',
                brand: product.brand || '',
                color: product.color || '',
                color_hex: product.color_hex || null,
                quantity: product.quantity || 1,
                source: source,
                product_source: productSource,
                key: key,
                slug: product.slug || ''
            });
        }

        // Invalidate server summary (will be refreshed after server confirms)
        this.serverSummary = null;
        this._mutationEpoch++;

        // Always save to localStorage as backup (for cross-origin cookie issues)
        this.saveToLocalStorage();
        this.updateUI();

        // Sync to server only for core items
        let crossSellPayload = null;
        if (isCore && typeof API !== 'undefined') {
            try {
                const response = await API.addToCart(product.id, product.quantity || 1);
                if (!response.ok) {
                    // Server rejected — undo just this add, never a whole-array restore.
                    const self = this;
                    const at = this.items.findIndex(function(item) {
                        return (item.key || self.cartItemKey(item)) === key;
                    });
                    if (at >= 0) {
                        if (hadExisting) this.items[at].quantity = Math.max(0, this.items[at].quantity - addedQty);
                        if (!hadExisting || this.items[at].quantity <= 0) this.items.splice(at, 1);
                    }
                    this._mutationEpoch++;
                    this.saveToLocalStorage();
                    this.updateUI();
                    if (typeof showToast === 'function') {
                        showToast(API.extractErrorMessage(response, 'Failed to add item to cart'), 'error');
                    }
                    return;
                }

                // Capture cross-sell hint from add-to-cart response.
                // Backend returns either `frequently_bought_together` (warm cache, inline)
                // or `frequently_bought_together_url` (cold, hand off to a lazy fetch).
                if (response.data) {
                    if (Array.isArray(response.data.frequently_bought_together) && response.data.frequently_bought_together.length) {
                        crossSellPayload = { products: response.data.frequently_bought_together };
                    } else if (response.data.frequently_bought_together_url) {
                        crossSellPayload = { url: response.data.frequently_bought_together_url };
                    }
                }

                // Server confirmed - refresh to get accurate server totals
                const itemsAfterAdd = JSON.parse(JSON.stringify(this.items));
                const addedKey = key;
                await this.loadFromServer();
                // Guard: if server returned empty (e.g. cross-origin cookie blocked), keep local state
                if (this.items.length === 0 && itemsAfterAdd.length > 0) {
                    this.items = itemsAfterAdd;
                    this.saveToLocalStorage();
                } else if (!this.items.find(i => (i.key || this.cartItemKey(i)) === addedKey)) {
                    // Server confirmed add but GET didn't return it yet — merge back
                    const localAdded = itemsAfterAdd.find(i => (i.key || this.cartItemKey(i)) === addedKey);
                    if (localAdded) {
                        this.items.push(localAdded);
                        this.saveToLocalStorage();
                    }
                }
                this.updateUI();
            } catch (error) {
                DebugLog.error('Failed to sync cart to server:', error);
                // Keep item locally — it's saved in localStorage for resilience.
                // Don't rollback; the server will get the item on next successful sync.
                if (typeof showToast === 'function') {
                    showToast('Item saved locally. It will sync when connection is restored.', 'info');
                }
                return;
            }
        }

        if (typeof showToast === 'function') {
            showToast(product.name + ' added to cart', 'success');
        }

        // Track analytics
        if (typeof CartAnalytics !== 'undefined') {
            CartAnalytics.trackAddToCart(product, product.quantity || 1);
        }

        // Show "Customers also bought" carousel from add-to-cart response.
        // Inline products render immediately; URL fallback fetches on idle so
        // the cart-confirmation flow isn't blocked.
        if (crossSellPayload) {
            this._showCrossSellModal(crossSellPayload).catch(() => {});
        }
    },

    /**
     * Render a "Customers also bought" carousel after a successful add-to-cart.
     * Accepts either { products: [...] } (warm cache) or { url } (cold cache).
     */
    async _showCrossSellModal(payload) {
        let products = payload.products || null;
        if (!products && payload.url) {
            // Lazy-fetch on idle — backend says hot path is cache.set'd for 1h
            await new Promise(resolve => {
                if (typeof window.requestIdleCallback === 'function') {
                    window.requestIdleCallback(() => resolve(), { timeout: 1500 });
                } else {
                    setTimeout(resolve, 250);
                }
            });
            try {
                // credentials: 'omit' (ERR-124). This is a public catalog read
                // — the backend-supplied frequently_bought_together_url — and it
                // lives under the Cloudflare-edge-cached `/api/products/` prefix.
                // Sending cookies unconditionally was the one catalog fetch in
                // the codebase that could bypass the edge for every visitor,
                // signed in or not. Nothing here needs an identity.
                const res = await fetch(payload.url, { credentials: 'omit' });
                if (!res.ok) return;
                const json = await res.json();
                products = json?.data?.bought_together || json?.data?.products || [];
            } catch (_) {
                return;
            }
        }
        if (!products || !products.length) return;

        const top = products.slice(0, 3);
        const existing = document.getElementById('crosssell-modal');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'crosssell-modal';
        overlay.className = 'crosssell-modal';

        const cards = top.map(p => {
            const img = typeof storageUrl === 'function' ? storageUrl(p.image_url) : (p.image_url || '');
            // Prefer backend-supplied canonical_url. Reduce absolute URLs to a
            // path so router-based navigation stays in-app.
            const link = (() => {
                if (p.canonical_url) {
                    try { return new URL(p.canonical_url).pathname; }
                    catch (_) { return p.canonical_url; }
                }
                return p.slug && p.sku
                    ? `/products/${encodeURIComponent(p.slug)}/${encodeURIComponent(p.sku)}`
                    : `/p/${encodeURIComponent(p.sku || '')}`;
            })();
            const price = p.retail_price != null && typeof formatPrice === 'function' ? formatPrice(p.retail_price) : '';
            const crosssellName = (typeof ProductName !== 'undefined') ? ProductName.clean(p) : (p.name || '');
            return `
                <a class="crosssell-modal__card" href="${Security.escapeAttr(link)}">
                    ${img ? `<img class="crosssell-modal__img" src="${Security.escapeAttr(img)}" alt="${Security.escapeAttr(crosssellName)}" loading="lazy">` : '<div class="crosssell-modal__img crosssell-modal__img--placeholder"></div>'}
                    <div class="crosssell-modal__name">${Security.escapeHtml(crosssellName)}</div>
                    <div class="crosssell-modal__price">${Security.escapeHtml(price)}</div>
                    ${p.in_stock === false
                        ? `<button type="button"
                            class="btn btn--primary crosssell-modal__add"
                            data-action="contact"
                            aria-label="Contact us about ${Security.escapeAttr(p.name || 'this product')}">
                            Contact us
                          </button>`
                        : `<button type="button" class="btn btn--secondary crosssell-modal__add add-to-cart-btn"
                            data-product-id="${Security.escapeAttr(p.id || '')}"
                            data-product-sku="${Security.escapeAttr(p.sku || '')}"
                            data-product-name="${Security.escapeAttr(p.name || '')}"
                            data-product-price="${Security.escapeAttr(p.retail_price != null ? p.retail_price : '')}"
                            data-product-image="${Security.escapeAttr(img || '')}"
                            data-product-color="${Security.escapeAttr(p.color || '')}"
                            data-product-source="${Security.escapeAttr(p.source || '')}">
                            Add to cart
                          </button>`}
                </a>`;
        }).join('');

        overlay.innerHTML = `
            <div class="crosssell-modal__panel" role="dialog" aria-modal="true" aria-labelledby="crosssell-title">
                <div class="crosssell-modal__head">
                    <h3 id="crosssell-title">Customers also bought</h3>
                    <button type="button" class="crosssell-modal__close" aria-label="Close">&times;</button>
                </div>
                <div class="crosssell-modal__grid">${cards}</div>
                <div class="crosssell-modal__foot">
                    <a href="/cart" class="btn btn--primary">Go to cart</a>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const close = () => overlay.remove();
        overlay.querySelector('.crosssell-modal__close').addEventListener('click', close);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        document.addEventListener('keydown', function escClose(e) {
            if (e.key === 'Escape') { close(); document.removeEventListener('keydown', escClose); }
        });
        // Add-to-cart on cross-sell items goes through the normal Cart.addItem path
        // via the global delegate already bound in bindEvents().
    },

    /**
     * Update item quantity - called directly only for programmatic updates
     * UI-triggered updates go through _debouncedQuantityUpdate
     */
    async updateQuantity(itemId, quantity) {
        if (quantity <= 0) {
            await this.removeItem(itemId);
            return;
        }

        // Store old quantity for potential rollback
        const item = this.items.find(function(i) { return i.key === itemId || i.id === itemId; });
        const oldQuantity = item ? item.quantity : 0;
        const isCore = !item || !item.source || item.source === 'core';
        const actualId = item ? item.id : itemId;

        // Changing a quantity supersedes an unconfirmed removal of the same line.
        if (item) {
            this._dropPendingOpsFor(item.key || item.id);
        }

        // Update locally first (instant feedback)
        if (item) {
            // Single cap. This clamped to 99 while the six other sites used 100, so a
            // programmatic set-to-100 silently became 99.
            item.quantity = Math.min(quantity, this.MAX_QUANTITY);
            this.serverSummary = null; // Invalidate until server confirms
            this._mutationEpoch++;
            this.saveToLocalStorage();
            this.updateUI();
        }

        // Sync to server only for core items
        if (isCore && typeof API !== 'undefined') {
            try {
                const response = await API.updateCartItem(actualId, quantity);
                if (response.ok) {
                    // Refresh from server for accurate totals
                    await this.loadFromServer();
                    this.updateUI();
                } else {
                    // Generic failure - rollback
                    if (item) {
                        item.quantity = oldQuantity;
                        this.saveToLocalStorage();
                        this.updateUI();
                    }
                    if (typeof showToast === 'function') {
                        showToast('Failed to update quantity. Please try again.', 'error');
                    }
                }
            } catch (error) {
                DebugLog.error('Failed to sync quantity to server:', error);
                // Rollback on error
                if (item) {
                    item.quantity = oldQuantity;
                    this.saveToLocalStorage();
                    this.updateUI();
                }
                if (typeof showToast === 'function') {
                    showToast('Network error. Quantity reverted.', 'error');
                }
            }
        }

        // Track analytics
        if (typeof CartAnalytics !== 'undefined' && item) {
            CartAnalytics.trackUpdateQuantity(item, oldQuantity, item.quantity);
        }
    },

    /**
     * Remove item from cart — durable, with surgical rollback (ERR-136).
     *
     * Ordering is load-bearing: the intent is JOURNALED before the local mutation
     * and before the request, so a crash anywhere after this point fails toward
     * "we will replay" rather than "we forgot".
     *
     * A transient failure (offline, 5xx, timeout) does NOT roll back and does NOT
     * toast. That used to say "Item not removed", which with a durable journal is a
     * lie in the other direction — the removal WILL happen. Only exhaustion or an
     * outright rejection puts the row back, and that path is loud.
     *
     * @returns {Promise<{ok: boolean, state: string, verified: boolean}>}
     */
    async removeItem(itemId) {
        const idx = this.items.findIndex(function(item) {
            return item.key === itemId || item.id === itemId;
        });
        const removedItem = idx >= 0 ? this.items[idx] : null;
        const isCore = !removedItem || !removedItem.source || removedItem.source === 'core';
        const actualId = removedItem ? removedItem.id : itemId;
        const itemKey = removedItem && removedItem.key ? removedItem.key : null;

        // Double-click guard. Without it two DELETEs fire for one row and the first
        // `finally` clears the in-flight marker while the second is still running.
        if (this._removingItems.has(actualId) || (itemKey && this._removingItems.has(itemKey))) {
            return { ok: false, state: 'in_flight', verified: false };
        }

        // Journal FIRST — before this.items changes, before saveToLocalStorage().
        // Non-core rows (cross-sell) never reach the server, so they are never
        // journaled; journaling them would let a cross-sell removal hide the core
        // row of the same product.
        let record = null;
        if (isCore && removedItem) {
            record = this._journalRemoval(removedItem, idx >= 0 ? idx : 0);
        }

        // Remove locally (instant feedback)
        this.items = this.items.filter(function(item) {
            return item.key !== itemId && item.id !== itemId;
        });
        this.serverSummary = null; // Invalidate until server confirms
        this._mutationEpoch++;
        this.saveToLocalStorage();
        this.updateUI();

        // Sync to server only for core items
        if (isCore && typeof API !== 'undefined') {
            this._removingItems.add(actualId);
            if (itemKey) this._removingItems.add(itemKey);

            const online = typeof navigator === 'undefined' || navigator.onLine !== false;
            let response = null;
            let error = null;
            try {
                // keepalive so an immediate refresh does not abort the request.
                response = await API.removeFromCart(actualId, { keepalive: true });
            } catch (e) {
                error = e;
                DebugLog.error('Failed to sync removal to server:', e);
            }

            const state = classifyRemovalOutcome(response, error, { replay: false, online: online });

            try {
                if (state === 'reject' || (!this._pendingOpsDurable && (state === 'retry' || state === 'defer'))) {
                    // Either the server refused outright, or we could not journal the
                    // intent so no replay can rescue it. Put the row back where it was —
                    // surgically, never from a whole-array snapshot, which would
                    // resurrect a DIFFERENT item removed in between.
                    if (record) this._dropPendingOpsFor(record.key || record.id);
                    if (removedItem) {
                        const already = this.items.some(function(item) {
                            return item.key === removedItem.key || item.id === removedItem.id;
                        });
                        if (!already) {
                            const at = Math.min(Math.max(idx, 0), this.items.length);
                            this.items.splice(at, 0, removedItem);
                        }
                    }
                    this._mutationEpoch++;
                    this.saveToLocalStorage();
                    this.updateUI();
                    if (typeof showToast === 'function') {
                        showToast('Failed to remove item. Please try again.', 'error');
                    }
                    return { ok: false, state: state, verified: true };
                }

                if (state === 'retry' || state === 'defer') {
                    // The intent is durable. Leave the UI optimistic — the replay owns it.
                    DebugLog.warn('Cart: removal not yet confirmed (' + state + '); journaled for replay');
                    return { ok: true, state: state, verified: false };
                }

                // confirmed / confirmed_unverified / absent — the row is gone as far as
                // this request can tell.
                if (record) this._dropPendingOpsFor(record.key || record.id);
                this._mutationEpoch++;
                await this.loadFromServer();
                this.saveToLocalStorage();
                this.updateUI();

                if (state === 'confirmed_unverified' && removedItem) {
                    // `removed: 0` on a FRESH delete, or a bodyless 204. Either the row was
                    // already gone, or the request resolved against a DIFFERENT cart
                    // (rotated guest sid, expired session) — the count cannot tell those
                    // apart, so verify instead of assuming.
                    const stillThere = this.items.some(function(item) {
                        return item.key === removedItem.key || item.id === removedItem.id;
                    });
                    if (stillThere) {
                        this._renderRemovalNotice({
                            failed: [{ id: actualId, sku: removedItem.sku, name: removedItem.name, reason: 'still_present' }]
                        });
                        return { ok: false, state: 'still_present', verified: true };
                    }
                }

                this._renderRemovalNotice({ failed: [] });
            } finally {
                this._removingItems.delete(actualId);
                if (itemKey) this._removingItems.delete(itemKey);
            }

            if (typeof showToast === 'function') {
                showToast('Item removed from cart', 'info');
            }
            if (typeof CartAnalytics !== 'undefined' && removedItem) {
                CartAnalytics.trackRemoveFromCart(removedItem, removedItem.quantity);
            }
            return { ok: true, state: state, verified: true };
        }

        if (typeof showToast === 'function') {
            showToast('Item removed from cart', 'info');
        }

        // Track analytics
        if (typeof CartAnalytics !== 'undefined' && removedItem) {
            CartAnalytics.trackRemoveFromCart(removedItem, removedItem.quantity);
        }
        return { ok: true, state: 'local_only', verified: true };
    },

    /**
     * Clear entire cart - Local first, then sync to server
     * Syncs to server for both guest and authenticated users
     */
    async clear() {
        // Snapshot for rollback. Legitimate here, unlike in removeItem/addItem: a
        // clear IS the whole array, so restoring the whole array cannot resurrect a
        // row that some other operation removed in the meantime.
        const previousItems = JSON.parse(JSON.stringify(this.items));
        const previousCoupon = this.appliedCoupon;
        const previousDiscount = this.discountAmount;

        // Clear locally first (instant)
        this.items = [];
        this.appliedCoupon = null;
        this.discountAmount = 0;
        this.serverSummary = null;
        this._mutationEpoch++;
        // NOTE: the localStorage mirror is NOT dropped here. It used to be, before
        // the server had confirmed anything, so a failed clear left the rollback
        // restoring in-memory state over an already-emptied mirror. It is written on
        // confirmation, and rewritten from the snapshot on failure (ERR-136).
        this.updateUI();

        // Sync to server for both guest and authenticated users
        if (typeof API !== 'undefined') {
            const restore = () => {
                this.items = previousItems;
                this.appliedCoupon = previousCoupon;
                this.discountAmount = previousDiscount;
                this._mutationEpoch++;
                this.saveToLocalStorage();
                this.updateUI();
            };
            try {
                const response = await API.clearCart();
                if (response && !response.ok) {
                    restore();
                    if (typeof showToast === 'function') {
                        showToast('Failed to clear cart. Please try again.', 'error');
                    }
                    return;
                }
                // Confirmed. A cleared cart subsumes every pending removal in it, and
                // the mirror can now safely go.
                try {
                    localStorage.removeItem(this.STORAGE_KEY);
                } catch (e) {
                    DebugLog.warn('Cart: could not clear the localStorage mirror:', e);
                }
                this.purgePendingOps('cart cleared');
                this._mutationEpoch++;
            } catch (error) {
                DebugLog.error('Failed to sync cart clear to server:', error);
                restore();
                if (typeof showToast === 'function') {
                    showToast('Network error. Cart not cleared.', 'error');
                }
            }
        } else {
            try {
                localStorage.removeItem(this.STORAGE_KEY);
            } catch (e) { /* storage unavailable */ }
        }
    },

    /**
     * Check if we have server-verified pricing
     * SECURITY: Checkout should be blocked if this returns false
     */
    hasServerPricing: function() {
        return this.serverSummary && this.serverSummary.subtotal !== undefined;
    },

    /**
     * Get cart subtotal - uses server summary when available
     * Returns estimate for display only when server unavailable
     */
    getSubtotal: function() {
        if (this.serverSummary && this.serverSummary.subtotal !== undefined) {
            return this.serverSummary.subtotal;
        }
        // DISPLAY ONLY estimate - never use for checkout
        // This is only for showing approximate cart value when offline
        return this.items.reduce((total, item) => {
            return total + (item.price * item.quantity);
        }, 0);
    },

    /**
     * Check if current prices are estimates (not server-verified)
     */
    isUsingEstimatedPrices: function() {
        return !this.hasServerPricing();
    },

    /**
     * Get total item count
     */
    getItemCount: function() {
        return this.items.reduce((count, item) => count + item.quantity, 0);
    },

    /**
     * Get shipping cost - uses server summary when available
     * Returns estimate for display only when server unavailable
     */
    getShipping: function() {
        if (this.serverSummary && this.serverSummary.shipping !== undefined) {
            return this.serverSummary.shipping;
        }
        // DISPLAY ONLY estimate via Shipping module
        if (typeof Shipping !== 'undefined') {
            return Shipping.calculate(this.items, this.getSubtotal()).fee;
        }
        // Ultimate fallback (North Island urban light rate)
        const threshold = typeof Config !== 'undefined' ? Config.getSetting('FREE_SHIPPING_THRESHOLD', 100) : 100;
        return this.getSubtotal() >= threshold ? 0 : 7;
    },

    /**
     * Get discount amount from applied coupon
     */
    getDiscount: function() {
        if (this.serverSummary && this.serverSummary.discount !== undefined) {
            return this.serverSummary.discount;
        }
        // Discount is calculated server-side for authenticated users
        // For guests, no discounts available (must login)
        return this.discountAmount || 0;
    },

    /**
     * Get cart total - uses server summary when available
     * Returns estimate for display only when server unavailable
     * SECURITY: Never use this for payment - backend calculates final total
     */
    getTotal: function() {
        if (this.serverSummary && this.serverSummary.total !== undefined) {
            return this.serverSummary.total;
        }
        // DISPLAY ONLY estimate - includes shipping estimate
        // SECURITY: Never use this for payment - backend calculates final total
        return this.getSubtotal() + this.getShipping() - this.getDiscount();
    },

    /**
     * Check if any cart items are out of stock
     */
    hasOutOfStockItems: function() {
        return false;
    },

    /**
     * Update UI to reflect cart state
     */
    updateUI: function() {
        if (typeof updateCartCount === 'function') {
            updateCartCount(this.getItemCount());
        }

        document.querySelectorAll('.cart-count, .cart-badge, #cart-count').forEach(el => {
            el.textContent = this.getItemCount();
            el.hidden = this.getItemCount() === 0;
        });

        const cartPage = document.querySelector('.cart-page');
        if (cartPage) {
            this.renderCartPage();
        }
    },

    /**
     * Render the loyalty message chip on the cart page (earn nudge or applied summary).
     * Hidden for guests and when the loyalty service couldn't be queried.
     * Uses loyalty.message verbatim — do not interpolate from numeric fields.
     * The interactive redeem control (amount/Max/Apply/Remove) lives in cart-page.js.
     */
    _renderLoyaltyChip: function() {
        const chipEl = document.getElementById('cart-loyalty-chip');
        if (!chipEl) return;
        const lo = this.loyalty;
        if (!lo || !lo.message) {
            chipEl.hidden = true;
            chipEl.textContent = '';
            return;
        }
        chipEl.textContent = lo.message;
        chipEl.hidden = false;
    },

    /**
     * Render cart page content
     */
    renderCartPage: function() {
        const cartItems = document.querySelector('.cart-items') || document.getElementById('cart-items');
        const cartEmpty = document.querySelector('.cart-empty') || document.getElementById('cart-empty');
        const cartLayout = document.querySelector('.cart-layout') || document.getElementById('cart-layout');
        const cartLoading = document.getElementById('cart-loading');
        const cartSummary = document.querySelector('.cart-summary');

        // Show loading skeleton only if loading AND localStorage had items
        // If localStorage is empty, show the empty state immediately rather than
        // blocking on a server round-trip (Render cold starts can take 10-30s)
        if (this.loading && this.items.length === 0 && cartLoading) {
            if (this._localStorageHadItems) {
                // localStorage had items — worth waiting for server to confirm
                cartLoading.hidden = false;
                if (cartLayout) cartLayout.hidden = true;
                if (cartEmpty) cartEmpty.hidden = true;
                return;
            }
            // localStorage was empty — show empty state instantly, server will
            // update the UI if it turns out a cookie-based guest cart exists
        }

        // Hide loading state
        if (cartLoading) cartLoading.hidden = true;

        // Add syncing indicator if loading with existing items
        if (cartLayout) {
            if (this.loading && this.items.length > 0) {
                cartLayout.classList.add('cart-layout--syncing');
            } else {
                cartLayout.classList.remove('cart-layout--syncing');
            }
        }

        if (this.items.length === 0) {
            if (cartLayout) cartLayout.hidden = true;
            if (cartEmpty) cartEmpty.hidden = false;
        } else {
            if (cartLayout) cartLayout.hidden = false;
            if (cartEmpty) cartEmpty.hidden = true;

            if (cartItems) {
                const self = this;
                cartItems.innerHTML = this.items.map(function(item) {
                    const escapedName = Security.escapeHtml((typeof ProductName !== 'undefined') ? ProductName.clean(item) : item.name);
                    const escapedBrand = Security.escapeHtml(item.brand || '');
                    const escapedSku = Security.escapeHtml(item.sku || '');
                    const itemKey = item.key || self.cartItemKey(item);

                    let productLink;
                    if (item.canonical_url) {
                        try { productLink = new URL(item.canonical_url).pathname; }
                        catch (_) { productLink = item.canonical_url; }
                    } else if (item.slug) {
                        productLink = '/products/' + encodeURIComponent(item.slug) + '/' + encodeURIComponent(item.sku || '');
                    } else {
                        productLink = '/p/' + encodeURIComponent(item.sku || '');
                    }

                    return '\
                    <article class="cart-item" data-item-id="' + item.id + '" data-item-key="' + Security.escapeAttr(itemKey) + '" data-sku="' + Security.escapeAttr(item.sku || '') + '" data-quantity="' + Security.escapeAttr(String(item.quantity)) + '">\
                        <div class="cart-item__image">\
                            ' + self.getItemImageHTML(item) + '\
                        </div>\
                        <div class="cart-item__details">\
                            <span class="source-badge source-badge--' + (Cart._isCompatible(item) ? 'compatible' : 'genuine') + '">' + (Cart._isCompatible(item) ? 'COMPATIBLE' : 'GENUINE') + '</span>\
                            <h3 class="cart-item__name">\
                                <a href="' + productLink + '">' + escapedName + '</a>\
                            </h3>\
                            ' + (escapedBrand ? '<p class="cart-item__brand">' + escapedBrand + '</p>' : '') + '\
                            ' + (escapedSku ? '<p class="cart-item__sku">SKU: ' + escapedSku + '</p>' : '') + '\
                            \
                            <p class="cart-item__price-mobile">' + formatPrice(item.price) + '</p>\
                            ' + self.renderLinePackSuggestion(item) + '\
                        </div>\
                        <div class="cart-item__price">\
                            ' + formatPrice(item.price) + '\
                        </div>\
                        <div class="cart-item__quantity">\
                            <div class="quantity-selector" data-item-id="' + item.id + '" data-item-key="' + Security.escapeAttr(itemKey) + '">\
                                <button type="button" class="quantity-selector__btn quantity-selector__btn--decrease" aria-label="Decrease quantity">\
                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">\
                                        <line x1="5" y1="12" x2="19" y2="12"></line>\
                                    </svg>\
                                </button>\
                                <input type="number" class="quantity-selector__input" value="' + item.quantity + '" min="1" max="' + self.MAX_QUANTITY + '" aria-label="Quantity">\
                                <button type="button" class="quantity-selector__btn quantity-selector__btn--increase" aria-label="Increase quantity"' + (item.quantity >= 100 ? ' disabled' : '') + '>\
                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">\
                                        <line x1="12" y1="5" x2="12" y2="19"></line>\
                                        <line x1="5" y1="12" x2="19" y2="12"></line>\
                                    </svg>\
                                </button>\
                            </div>\
                        </div>\
                        <div class="cart-item__total">\
                            ' + formatPrice(item.price * item.quantity) + '\
                        </div>\
                        <button type="button" class="cart-item__remove" aria-label="Remove ' + escapedName + '">\
                            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">\
                                <polyline points="3 6 5 6 21 6"></polyline>\
                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>\
                            </svg>\
                        </button>\
                    </article>';
                }).join('');
                // Bind image error fallbacks (replaces inline onerror)
                this.bindImageFallbacks(cartItems);
                this.decorateVolumeNudges(cartItems);
            }

            const subtotal = this.getSubtotal();
            const discount = this.getDiscount();
            // Cart page total excludes shipping — shipping is calculated at checkout
            const cartTotal = subtotal - discount;
            const itemCount = this.getItemCount();

            const itemCountEl = document.getElementById('cart-item-count');
            const subtotalEl = document.getElementById('cart-subtotal');
            const gstEl = document.getElementById('cart-gst');
            const totalEl = document.getElementById('cart-total');

            if (itemCountEl) itemCountEl.textContent = itemCount;
            if (subtotalEl) subtotalEl.textContent = formatPrice(subtotal);
            if (gstEl) gstEl.textContent = formatPrice(this.serverSummary?.gst_amount != null ? this.serverSummary.gst_amount : calculateGST(cartTotal));
            if (totalEl) totalEl.textContent = formatPrice(cartTotal) + ' NZD';

            // Savings / loyalty / business-account rows — one shared renderer.
            this._renderDiscountRows(discount);

            if (cartSummary) {
                const subtotalClassEl = cartSummary.querySelector('.cart-summary__subtotal');
                const totalClassEl = cartSummary.querySelector('.cart-summary__total-value');

                if (subtotalClassEl) subtotalClassEl.textContent = formatPrice(subtotal);
                if (totalClassEl) totalClassEl.textContent = formatPrice(cartTotal);
            }

            // Free shipping nudge + progress bar.
            // Backend cart summary now provides:
            //   free_shipping_message  — null on empty cart, or pre-formatted copy
            //   qualifies_for_free_shipping
            //   free_shipping_threshold / free_shipping_remaining
            // Render verbatim when present; fall back to local Shipping helper when not.
            const shippingMsgEl = document.getElementById('cart-shipping-message');
            const shippingBarEl = document.getElementById('cart-shipping-bar');
            const barFillEl = document.getElementById('shipping-bar-fill');

            // Shipping row. Only the SERVER may put a price in a money row: the
            // local Shipping.getSpendMore fallback below is a frontend threshold
            // calc, fine for nudge copy but never good enough to print. Unknown
            // shipping stays "Calculated at checkout" and is never shown as free.
            const shipEl = document.getElementById('cart-shipping');
            const serverQualifies = !!(this.serverSummary
                && this.serverSummary.qualifies_for_free_shipping === true);
            if (shipEl) {
                shipEl.textContent = serverQualifies ? 'Free' : 'Calculated at checkout';
            }

            if (shippingMsgEl) {
                const summary = this.serverSummary || {};
                const hasServerNudge = summary.free_shipping_message !== undefined
                    && summary.free_shipping_threshold != null;

                if (hasServerNudge) {
                    // Compose a message ourselves when the backend provides
                    // numbers but no copy — keeps the nudge useful on every
                    // cart state.
                    // Once the shipping row itself reads "Free", a banner saying the
                    // same thing is pure duplication — and the two used to read as a
                    // contradiction ("Calculated at checkout" above "you qualify").
                    // The "add $X more" nudge is the half worth keeping.
                    let copy = summary.qualifies_for_free_shipping
                        ? '' : summary.free_shipping_message;
                    if (!copy && !summary.qualifies_for_free_shipping
                        && typeof summary.free_shipping_remaining === 'number'
                        && summary.free_shipping_remaining > 0) {
                        const priceStr = (typeof formatPrice === 'function')
                            ? formatPrice(summary.free_shipping_remaining)
                            : '$' + summary.free_shipping_remaining.toFixed(2);
                        copy = 'Add ' + priceStr + ' more for FREE shipping';
                    }

                    if (copy) {
                        shippingMsgEl.querySelector('span').textContent = copy;
                        shippingMsgEl.className = 'cart-summary__shipping-message'
                            + (summary.qualifies_for_free_shipping ? ' cart-summary__shipping-message--success' : '');
                        shippingMsgEl.hidden = false;
                    } else {
                        shippingMsgEl.hidden = true;
                    }

                    if (shippingBarEl && barFillEl) {
                        if (summary.qualifies_for_free_shipping || !copy) {
                            shippingBarEl.hidden = true;
                        } else {
                            const threshold = summary.free_shipping_threshold;
                            // Prefer backend-derived progress: (threshold - remaining)/threshold.
                            // Fall back to subtotal/threshold for safety.
                            const pct = threshold > 0
                                ? (typeof summary.free_shipping_remaining === 'number'
                                    ? Math.min(Math.round(((threshold - summary.free_shipping_remaining) / threshold) * 100), 100)
                                    : Math.min(Math.round((subtotal / threshold) * 100), 100))
                                : 0;
                            barFillEl.style.width = Math.max(pct, 0) + '%';
                            barFillEl.className = 'shipping-bar__fill' + (pct >= 100 ? ' shipping-bar__fill--complete' : '');
                            shippingBarEl.hidden = false;
                        }
                    }
                } else {
                    // Fallback: local Shipping helper (server didn't return the nudge fields)
                    const spendMore = (typeof Shipping !== 'undefined') ? Shipping.getSpendMore(subtotal) : null;

                    if (spendMore && spendMore.qualifies) {
                        // Suppress only when the shipping row already says "Free" —
                        // i.e. the server confirmed it but withheld the nudge fields.
                        // Otherwise this banner is the only free-shipping signal the
                        // shopper gets, since the row can't be trusted to print it.
                        shippingMsgEl.querySelector('span').textContent = "You've qualified for FREE shipping!";
                        shippingMsgEl.className = 'cart-summary__shipping-message cart-summary__shipping-message--success';
                        shippingMsgEl.hidden = serverQualifies;
                        if (shippingBarEl) shippingBarEl.hidden = true;
                    } else if (spendMore) {
                        const priceStr = (typeof formatPrice === 'function') ? formatPrice(spendMore.needed) : '$' + spendMore.needed.toFixed(2);
                        shippingMsgEl.querySelector('span').textContent = 'Add ' + priceStr + ' more for free shipping!';
                        shippingMsgEl.className = 'cart-summary__shipping-message';
                        shippingMsgEl.hidden = false;

                        if (shippingBarEl && barFillEl) {
                            const threshold = (typeof Config !== 'undefined') ? Config.getSetting('FREE_SHIPPING_THRESHOLD', 100) : 100;
                            const pct = Math.min(Math.round((subtotal / threshold) * 100), 100);
                            barFillEl.style.width = pct + '%';
                            barFillEl.className = 'shipping-bar__fill' + (pct >= 100 ? ' shipping-bar__fill--complete' : '');
                            shippingBarEl.hidden = false;
                        }
                    } else {
                        shippingMsgEl.hidden = true;
                        if (shippingBarEl) shippingBarEl.hidden = true;
                    }
                }
            }

            // Loyalty message chip (auth users only, null for guests / loyalty downtime)
            this._renderLoyaltyChip();
            // Refresh the interactive redeem control state from the latest cart
            if (typeof renderCartLoyaltyControl === 'function') {
                renderCartLoyaltyControl();
            }

            // Disable checkout if cart has out-of-stock items
            const checkoutBtn = document.getElementById('checkout-btn');
            if (checkoutBtn) {
                checkoutBtn.classList.remove('btn--disabled');
                checkoutBtn.removeAttribute('aria-disabled');
                checkoutBtn.title = '';
            }
        }

        // Conversion signals (delivery estimate, trust badges, free-shipping
        // unlock with add-ons, guest cart-saved nudge). Fail-soft; hides on an
        // empty cart or when the backend omitted the fields.
        this.renderCartSignals();
    },

    /**
     * Per-line value-pack upsell chip (mobile-ux-audit-jul2026 §3c). Mirrors the
     * PDP's renderPackSuggestion guards: only renders when the line carries a
     * complete, sane `pack_suggestion_for_line` with a positive dollar saving.
     * Savings render as DOLLARS ONLY (value-pack convention, May 2026). One tap
     * on the swap button replaces the single line with the pack SKU (delegated
     * handler in _initCartSignalHandlers). Returns '' when not applicable.
     */
    renderLinePackSuggestion: function(item) {
        const ps = item && item.pack_suggestion_for_line;
        const savings = ps ? parseFloat(ps.savings_amount) : NaN;
        if (!ps || typeof ps !== 'object' || !ps.sku
            || !Number.isFinite(savings) || savings <= 0) {
            return '';
        }
        const label = 'Save ' + formatPrice(savings) + ' — switch to the value pack';
        return '<button type="button" class="cart-line-pack" data-pack-sku="'
            + Security.escapeAttr(ps.sku) + '" data-single-key="'
            + Security.escapeAttr(item.key || this.cartItemKey(item))
            + '" data-track="cta_click" data-track-cta="pack_swap" data-track-location="cart">'
            + '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>'
            + '<span>' + Security.escapeHtml(label) + '</span>'
            + '</button>';
    },

    /**
     * Render the cart conversion signals from this.serverCartMeta into their
     * fail-soft containers (mobile-ux-audit-jul2026 §4h/§6). Every block hides
     * itself when its data is absent or the cart is empty. Nothing here computes
     * a price — all figures are backend-provided.
     */
    renderCartSignals: function() {
        const meta = this.serverCartMeta || {};
        const hasItems = this.items.length > 0;

        // Delivery estimate — "Order by 2pm — arrives in X–Y days".
        const deliveryEl = document.getElementById('cart-delivery');
        if (deliveryEl) {
            const d = hasItems ? meta.delivery_estimate : null;
            const promise = d && (d.promise || d.label);
            if (promise) {
                deliveryEl.innerHTML =
                    '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>'
                    + '<span>' + Security.escapeHtml(String(promise)) + '</span>';
                deliveryEl.hidden = false;
            } else {
                deliveryEl.hidden = true;
            }
        }

        // Same-day dispatch countdown (traffic-conversion-jul2026 §4) — the
        // urgency line right where the shopper decides to check out.
        //
        // renderCartSignals re-runs after EVERY cart mutation, so mount() must
        // stop the previous timer before starting a new one; it keys the handle
        // off the element itself so repeated calls can't stack intervals (which
        // would tick the number down several times a second). An empty cart
        // passes null and the element hides.
        const dispatchEl = document.getElementById('cart-dispatch-countdown');
        if (dispatchEl && typeof DispatchCountdown !== 'undefined') {
            DispatchCountdown.mount(dispatchEl, hasItems ? meta.delivery_estimate : null);
        }

        // Trust signals — guarantee / returns / shipping badges.
        const trustEl = document.getElementById('cart-trust-signals');
        if (trustEl) {
            const badges = hasItems ? this._trustBadgeList(meta.trust_signals) : [];
            if (badges.length) {
                trustEl.innerHTML = badges.map(function(text) {
                    return '<span class="cart-trust-badge">'
                        + '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 12l2 2 4-4"/><path d="M12 3l7 4v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V7z"/></svg>'
                        + '<span>' + Security.escapeHtml(text) + '</span></span>';
                }).join('');
                trustEl.hidden = false;
            } else {
                trustEl.hidden = true;
            }
        }

        // Free-shipping unlock — "Add $X for free shipping" + cheap in-stock
        // add-ons that cross the gap. Supersedes the plain free-shipping nudge.
        this._renderFreeShipUnlock(hasItems ? meta.free_shipping_unlock : null);

        // Cart-saved-until nudge (guests, non-empty cart).
        const savedEl = document.getElementById('cart-saved-until');
        if (savedEl) {
            const days = this._daysUntil(hasItems ? meta.cart_saved_until : null);
            if (days && days > 0) {
                const noun = days === 1 ? 'day' : 'days';
                savedEl.textContent = 'Your cart is saved for ' + days + ' ' + noun + '.';
                savedEl.hidden = false;
            } else {
                savedEl.hidden = true;
            }
        }

        this._initCartSignalHandlers();
    },

    /**
     * Normalise the backend trust_signals object into a short list of badge
     * strings. Tolerant of shape: accepts {guarantee, returns, shipping, org}
     * as strings or {label}/{text}/{promise} objects; ignores anything else.
     * Caps at 3 to keep the mobile summary tidy.
     */
    _trustBadgeList: function(ts) {
        if (!ts || typeof ts !== 'object') return [];
        const pick = function(v) {
            if (!v) return null;
            if (typeof v === 'string') return v;
            if (typeof v === 'object') return v.label || v.text || v.promise || v.title || null;
            return null;
        };
        const out = [];
        ['guarantee', 'returns', 'shipping', 'shipping_promise', 'org'].forEach(function(k) {
            const s = pick(ts[k]);
            if (s && out.indexOf(s) === -1) out.push(s);
        });
        return out.slice(0, 3);
    },

    _renderFreeShipUnlock: function(unlock) {
        const el = document.getElementById('cart-free-ship-unlock');
        if (!el) return;
        const msgEl = document.getElementById('cart-shipping-message');
        const barEl = document.getElementById('cart-shipping-bar');

        const amountShort = unlock ? parseFloat(unlock.amount_short) : NaN;
        const suggestions = (unlock && Array.isArray(unlock.suggested_products))
            ? unlock.suggested_products.slice(0, 3) : [];

        if (!unlock || unlock.qualifies || !Number.isFinite(amountShort) || amountShort <= 0) {
            el.hidden = true;
            el.innerHTML = '';
            return; // leave the existing plain nudge in place
        }

        // Unlock supersedes the plain free-shipping message to avoid duplication.
        if (msgEl) msgEl.hidden = true;
        if (barEl) barEl.hidden = true;

        const self = this;
        const chips = suggestions.map(function(p) {
            const href = self._suggestedProductHref(p);
            const img = self._suggestedProductImage(p);
            const price = (p.retail_price != null) ? formatPrice(parseFloat(p.retail_price)) : '';
            return '<a class="cart-addon" href="' + Security.escapeAttr(href) + '" data-track="cta_click" data-track-cta="free_ship_addon" data-track-location="cart">'
                + img
                + '<span class="cart-addon__name">' + Security.escapeHtml(p.name || p.sku || '') + '</span>'
                + (price ? '<span class="cart-addon__price">' + Security.escapeHtml(price) + '</span>' : '')
                + '</a>';
        }).join('');

        el.innerHTML =
            '<p class="cart-free-ship-unlock__lead">Add ' + Security.escapeHtml(formatPrice(amountShort)) + ' more for FREE shipping</p>'
            + (chips ? '<div class="cart-addon-row">' + chips + '</div>' : '');
        el.hidden = false;
        this.bindImageFallbacks(el);
    },

    _suggestedProductHref: function(p) {
        if (p.canonical_url) {
            try { return new URL(p.canonical_url).pathname; } catch (_) { return p.canonical_url; }
        }
        if (p.slug) return '/products/' + encodeURIComponent(p.slug) + '/' + encodeURIComponent(p.sku || '');
        return '/p/' + encodeURIComponent(p.sku || '');
    },

    _suggestedProductImage: function(p) {
        // Prefer the backend's optimized thumbnail (mobile-ux-audit-jul2026 §6);
        // fall back to a hand-built optimized URL, then the placeholder path.
        let raw = p.image_thumbnail_url
            || (p.image_url && typeof optimizedImageUrl === 'function' ? optimizedImageUrl(p.image_url, 96) : p.image_url)
            || '';
        if (!raw) return '<span class="cart-addon__img cart-addon__img--empty" aria-hidden="true"></span>';
        const src = (typeof Security !== 'undefined' && Security.sanitizeUrl) ? Security.sanitizeUrl(raw) : raw;
        const rawFallback = (typeof storageUrlRaw === 'function' && p.image_url) ? storageUrlRaw(p.image_url) : '';
        return '<img class="cart-addon__img" src="' + Security.escapeAttr(src) + '"'
            + (rawFallback ? ' data-raw-src="' + Security.escapeAttr(rawFallback) + '"' : '')
            + ' alt="" width="40" height="40" loading="lazy" decoding="async">';
    },

    /** Whole days from now until an ISO date, or null if invalid/past. */
    _daysUntil: function(iso) {
        if (!iso) return null;
        const then = new Date(iso).getTime();
        if (!Number.isFinite(then)) return null;
        const diff = then - Date.now();
        if (diff <= 0) return null;
        return Math.ceil(diff / (24 * 60 * 60 * 1000));
    },

    /**
     * Delegated click handlers for the signal CTAs. Idempotent — bound once via
     * a guard flag so repeated renderCartPage() calls don't stack listeners.
     * The pack-swap removes the single line then adds the pack SKU (qty 1),
     * reusing the existing Cart mutation methods so all server/localStorage
     * plumbing and re-render happen normally.
     */
    _initCartSignalHandlers: function() {
        if (this._cartSignalHandlersBound) return;
        this._cartSignalHandlersBound = true;
        const self = this;
        const container = document.getElementById('cart-items');
        if (!container) return;
        container.addEventListener('click', function(e) {
            const btn = e.target.closest('.cart-line-pack');
            if (!btn) return;
            e.preventDefault();
            const packSku = btn.getAttribute('data-pack-sku');
            const singleKey = btn.getAttribute('data-single-key');
            if (!packSku) return;
            btn.disabled = true;
            self._swapLineForPack(singleKey, packSku).catch(function(err) {
                DebugLog.error('Pack swap failed:', err);
                btn.disabled = false;
                if (typeof showToast === 'function') showToast('Could not switch to the value pack. Please try again.', 'error');
            });
        });
    },

    async _swapLineForPack(singleKey, packSku) {
        // Resolve the pack product from its SKU, add it, then drop the single.
        // Order matters: add first so a failed lookup leaves the cart intact.
        if (typeof API === 'undefined' || typeof API.getProduct !== 'function') {
            throw new Error('product lookup unavailable');
        }
        const res = await API.getProduct(packSku);
        const product = (res && res.ok && res.data) ? res.data : null;
        if (!product || !product.id) throw new Error('pack product not found');
        await this.addItem({
            id: product.id,
            name: product.name,
            price: product.retail_price,
            sku: product.sku || packSku,
            slug: product.slug || '',
            brand: (product.brand && product.brand.name) || '',
            color: product.color || '',
            color_hex: product.color_hex || null,
            image: (typeof storageUrl === 'function' ? storageUrl(product.image_url) : product.image_url) || '',
            quantity: 1,
            source: 'core',
            product_source: product.source || null
        });
        const single = this.items.find(function(i) { return (i.key || '') === singleKey; });
        if (single) {
            await this.removeItem(single.key || this.cartItemKey(single));
        }
        if (typeof showToast === 'function') showToast('Switched to the value pack.', 'success');
    }
};

// Initialize cart when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
    Cart.init();
});
