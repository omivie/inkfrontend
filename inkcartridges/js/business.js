/**
 * BUSINESS.JS
 * ===========
 * B2B "Business Account" pricing for InkCartridges.co.nz.
 *
 * Backend handoff: business-account-pricing-FE-handoff.md (Jul 2026).
 * See readfirst/business-account-pricing-FE-response-jul2026.md.
 *
 * THE ONE RULE
 * ------------
 * The frontend NEVER computes a business price. The tier % (5/10/15) is a
 * CEILING, not a guarantee: the backend caps each unit's discount so the unit
 * still nets >= 5% after Stripe fees ("never sell at a loss"). On thin-margin
 * items the realised discount is smaller than the tier % — `floored:true` — or
 * suppressed entirely. So `retail x (1 - tier%)` DISAGREES with what checkout
 * charges. Every number rendered here comes verbatim from the API.
 *
 * Two endpoints, both auth-gated (verified live 2026-07-20: 401 when
 * unauthenticated, vs 404 for a bogus /api/business/nope path — the routes exist):
 *   GET /api/business/status                -> is this user a business account
 *   GET /api/business/pricing?skus=A,B,...  -> per-SKU floored pricing (max 100)
 *
 * CACHING: in-memory ONLY, and wiped whenever the signed-in user changes.
 * Business prices are per-account and must never leak to another shopper, so
 * localStorage/sessionStorage are deliberately not used here.
 *
 * FAIL-SOFT, LOUDLY: a SKU the server declined to answer for is NOT the same as
 * a SKU that is genuinely absent from the catalog. The first lands in
 * `missed` (caller renders plain retail and we warn); the second comes back as
 * a real item with `found:false`. Collapsing the two would let a broken
 * endpoint masquerade as "no business discount available" — the ERR-063/068/073
 * failure mode.
 */

'use strict';

const Business = {

    /** Hard cap from the backend contract — more than this per call is rejected. */
    MAX_SKUS_PER_CALL: 100,

    /** Recognised pricing tiers, cheapest ceiling first. */
    TIERS: ['bronze', 'silver', 'gold'],

    /**
     * `status` values that mean "this account gets business pricing".
     *
     * VERIFIED LIVE 2026-07-20 against a real approved account:
     *   { status: "approved", pricing_tier: "bronze", net30_approved: true,
     *     credit_limit: 0, application: { company_name, submitted_at } }
     *
     * The handoff said "active business account" in prose, so an earlier draft
     * of this module tested `status === 'active'` — which silently denied
     * business pricing to every genuinely approved customer. Anything NOT on
     * this list (pending, rejected, suspended, …) falls back to retail, which
     * is the safe direction to be wrong in.
     */
    ACTIVE_STATUSES: ['approved', 'active'],

    // ── Internal state ──────────────────────────────────────────────────────
    // `_cacheOwner` is the user id the caches belong to. Any mismatch (sign in,
    // sign out, account switch) throws the whole cache away before it can be read.
    _cacheOwner: undefined,
    _statusPromise: null,
    _priceCache: new Map(),   // sku -> item object from the API
    _chunkPromises: new Map(), // sku -> in-flight promise, collapses concurrent calls

    // ─────────────────────────────────────────────────────────────────────────
    // Pure helpers (no I/O, no DOM) — these are what the test-suite executes.
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Trim, drop blanks, de-dupe — preserving first-seen order.
     * The backend de-dupes server-side too; doing it here keeps us under the
     * 100-SKU cap on pages that repeat a SKU (e.g. a grid plus a carousel).
     * @param {Array<string>} skus
     * @returns {Array<string>}
     */
    normalizeSkus(skus) {
        const out = [];
        const seen = new Set();
        for (const raw of (Array.isArray(skus) ? skus : [])) {
            const sku = typeof raw === 'string' ? raw.trim() : '';
            if (!sku || seen.has(sku)) continue;
            seen.add(sku);
            out.push(sku);
        }
        return out;
    },

    /**
     * Split a list into fixed-size chunks.
     * @param {Array} list
     * @param {number} size
     * @returns {Array<Array>}
     */
    chunk(list, size) {
        const n = Math.max(1, size | 0);
        const out = [];
        for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
        return out;
    },

    /**
     * Normalise GET /api/business/status into { active, tier }.
     *
     * The handoff documents the endpoint's PURPOSE but not its exact field
     * names, so this accepts the plausible spellings rather than guessing one
     * and silently showing retail to every business customer. A recognised
     * `pricing_tier` is treated as sufficient evidence of an active account
     * UNLESS an explicit active/status flag says otherwise.
     * @param {object} data
     * @returns {{active: boolean, tier: (string|null)}}
     */
    readStatus(data) {
        const d = data && typeof data === 'object' ? data : {};
        const rawTier = d.pricing_tier || d.tier || null;
        const tier = typeof rawTier === 'string' && this.TIERS.includes(rawTier.toLowerCase())
            ? rawTier.toLowerCase()
            : null;

        // An explicit negative always wins over the presence of a tier — a
        // revoked account must never keep pricing off a stale tier field.
        const flags = [d.active, d.is_active, d.is_business, d.business_account];
        if (flags.some(v => v === false)) return { active: false, tier: null };

        // When the payload carries a status, it is authoritative: only a known
        // good status grants pricing. Unknown/pending/rejected => retail.
        if (typeof d.status === 'string' && d.status) {
            if (!this.ACTIVE_STATUSES.includes(d.status.toLowerCase())) {
                return { active: false, tier: null };
            }
            return { active: true, tier };
        }

        const flaggedActive = flags.some(v => v === true);
        return (flaggedActive || tier) ? { active: true, tier } : { active: false, tier: null };
    },

    /**
     * Turn one /api/business/pricing item into a display model, or null when
     * there is nothing honest to show.
     *
     * Suppressed (returns null) when: the SKU is missing/unfound/inactive, the
     * business price is not a usable number, or `savings_amount` is 0 — the
     * item is already at or under its floor, so there is no business discount
     * to advertise and the shopper just sees standard retail.
     *
     * `percent` is ALWAYS `effective_percent`, never `tier_percent`. On a
     * floored line the tier % is not what the customer gets, and the handoff
     * forbids advertising it there; when nothing is floored the two are equal,
     * so one rule covers both cases and cannot drift.
     *
     * @param {object} item
     * @returns {{businessPrice:number, retailPrice:number, savings:number,
     *            percent:(number|null), floored:boolean}|null}
     */
    describeOffer(item) {
        if (!item || typeof item !== 'object') return null;
        if (item.found === false || item.is_active === false) return null;

        const businessPrice = Number(item.business_price);
        const retailPrice = Number(item.retail_price);
        const savings = Number(item.savings_amount);

        if (!Number.isFinite(businessPrice) || businessPrice <= 0) return null;
        if (!Number.isFinite(retailPrice) || retailPrice <= 0) return null;
        if (!Number.isFinite(savings) || savings <= 0) return null;

        const effective = Number(item.effective_percent);

        return {
            businessPrice,
            retailPrice,
            savings,
            percent: Number.isFinite(effective) && effective > 0 ? effective : null,
            floored: item.floored === true
        };
    },

    /**
     * Format a percent for display: 15 -> "15%", 6.3 -> "6.3%".
     * @param {number} pct
     * @returns {string}
     */
    formatPercent(pct) {
        if (!Number.isFinite(pct)) return '';
        const rounded = Math.round(pct * 10) / 10;
        return (Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)) + '%';
    },

    /**
     * Human label for a tier, e.g. "gold" -> "Gold".
     * @param {string} tier
     * @returns {string}
     */
    tierLabel(tier) {
        if (typeof tier !== 'string' || !tier) return '';
        return tier.charAt(0).toUpperCase() + tier.slice(1).toLowerCase();
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Auth / cache lifecycle
    // ─────────────────────────────────────────────────────────────────────────

    /** @returns {string|null} the signed-in user id, or null. */
    _userId() {
        if (typeof Auth === 'undefined' || !Auth) return null;
        if (typeof Auth.isAuthenticated === 'function' && !Auth.isAuthenticated()) return null;
        return (Auth.user && Auth.user.id) || null;
    },

    /** @returns {boolean} */
    _isAuthenticated() {
        return typeof Auth !== 'undefined' && !!Auth &&
            typeof Auth.isAuthenticated === 'function' && Auth.isAuthenticated();
    },

    /** Drop every cached status and price. Called on any auth change. */
    reset() {
        this._statusPromise = null;
        this._priceCache.clear();
        this._chunkPromises.clear();
        this._cacheOwner = undefined;
    },

    /**
     * Guard every cache read: if the signed-in user is not the one the cache
     * was built for, bin it first. This is what stops one shopper's negotiated
     * prices from ever being rendered to another.
     */
    _syncCacheOwner() {
        const uid = this._userId();
        if (this._cacheOwner !== uid) {
            this.reset();
            this._cacheOwner = uid;
        }
    },

    /** Wait for Auth to finish its async getSession (mirrors Favourites._waitForAuth). */
    _waitForAuth() {
        return new Promise(resolve => {
            if (typeof Auth !== 'undefined' && Auth.initialized) { resolve(); return; }
            let elapsed = 0;
            const interval = setInterval(() => {
                elapsed += 50;
                if ((typeof Auth !== 'undefined' && Auth.initialized) || elapsed >= 3000) {
                    clearInterval(interval);
                    resolve();
                }
            }, 50);
        });
    },

    /** Register the auth-change listener. Safe to call more than once. */
    init() {
        if (this._inited) return;
        this._inited = true;
        if (typeof Auth !== 'undefined' && Auth && typeof Auth.onAuthStateChange === 'function') {
            Auth.onAuthStateChange(() => this.reset());
        }
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Network
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Is the signed-in user an active business account, and on which tier?
     * Guests, retail customers and any failure all resolve to
     * { active:false, tier:null } — the storefront then behaves exactly as it
     * does today. Memoised per user for the life of the page.
     * @returns {Promise<{active: boolean, tier: (string|null)}>}
     */
    async getStatus() {
        const INACTIVE = { active: false, tier: null };

        await this._waitForAuth();
        this._syncCacheOwner();

        // Never fire a business request for a guest — it would 401 on every page.
        if (!this._isAuthenticated()) return INACTIVE;
        if (this._statusPromise) return this._statusPromise;

        this._statusPromise = (async () => {
            try {
                const res = await API.get('/api/business/status');
                if (!res || res.ok === false) {
                    // 403 B2B_REQUIRED / 401 simply means "not a business account".
                    // Anything else is worth a dev-console note.
                    const code = res && res.code;
                    if (code && code !== 'B2B_REQUIRED' && code !== 'FORBIDDEN' && code !== 'UNAUTHORIZED') {
                        DebugLog.warn('[Business] status failed:', code, res && res.error);
                    }
                    return INACTIVE;
                }
                return this.readStatus(res.data);
            } catch (e) {
                DebugLog.warn('[Business] status error:', e && e.message);
                return INACTIVE;
            }
        })();

        return this._statusPromise;
    },

    /** @returns {Promise<boolean>} */
    async isActive() {
        return (await this.getStatus()).active;
    },

    /**
     * Fetch floored business pricing for a set of SKUs.
     *
     * Returns BOTH what we got and what we failed to get. `missed` is part of
     * the return value on purpose: a caller that renders retail for a missed
     * SKU is correct, but a caller that cannot tell "missed" from "no discount"
     * would show a wrong price with total confidence.
     *
     * @param {Array<string>} skus
     * @returns {Promise<{items: Map<string, object>, missed: Array<string>, tier: (string|null)}>}
     */
    async getPricing(skus) {
        const status = await this.getStatus();
        const result = { items: new Map(), missed: [], tier: status.tier };

        // Not a business account: not an error, and not a miss. Nothing to show.
        if (!status.active) return result;

        this._syncCacheOwner();

        const wanted = this.normalizeSkus(skus);
        if (!wanted.length) return result;

        const need = [];
        for (const sku of wanted) {
            if (this._priceCache.has(sku)) result.items.set(sku, this._priceCache.get(sku));
            else need.push(sku);
        }
        if (!need.length) return result;

        const chunks = this.chunk(need, this.MAX_SKUS_PER_CALL);
        await Promise.all(chunks.map(chunk => this._fetchChunk(chunk, result)));

        if (result.missed.length) {
            DebugLog.warn(
                `[Business] pricing unavailable for ${result.missed.length} SKU(s) — ` +
                'these render at standard retail:', result.missed.join(', ')
            );
        }
        return result;
    },

    /**
     * One /api/business/pricing call. Any failure marks the WHOLE chunk missed
     * rather than pretending those SKUs have no business price.
     * @param {Array<string>} chunk
     * @param {{items: Map, missed: Array}} result
     */
    async _fetchChunk(chunk, result) {
        const qs = chunk.map(encodeURIComponent).join(',');
        try {
            const res = await API.get(`/api/business/pricing?skus=${qs}`);
            if (!res || res.ok === false || !res.data) {
                result.missed.push(...chunk);
                return;
            }
            const items = Array.isArray(res.data.items) ? res.data.items : [];
            const answered = new Set();
            for (const item of items) {
                if (!item || typeof item.sku !== 'string') continue;
                answered.add(item.sku);
                this._priceCache.set(item.sku, item);
                result.items.set(item.sku, item);
            }
            // A SKU we asked about and got no row for at all is a miss, not a
            // "no discount". found:false rows DO come back and are kept above.
            for (const sku of chunk) if (!answered.has(sku)) result.missed.push(sku);
        } catch (e) {
            DebugLog.warn('[Business] pricing error:', e && e.message);
            result.missed.push(...chunk);
        }
    },

    /**
     * Convenience for the PDP: pricing for exactly one SKU.
     * @param {string} sku
     * @returns {Promise<object|null>} the raw API item, or null.
     */
    async getPricingFor(sku) {
        const { items } = await this.getPricing([sku]);
        return items.get(sku) || null;
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Rendering
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Inline business-price markup for a product card.
     * @param {object} offer  result of describeOffer()
     * @returns {string} HTML
     */
    cardMarkup(offer) {
        const price = typeof formatPrice === 'function'
            ? formatPrice(offer.businessPrice)
            : '$' + offer.businessPrice.toFixed(2);
        const save = typeof formatPrice === 'function'
            ? formatPrice(offer.savings)
            : '$' + offer.savings.toFixed(2);
        const pct = offer.percent != null ? ` (${this.formatPercent(offer.percent)})` : '';
        return (
            `<span class="product-card__biz-price" data-testid="business-card-price">` +
                `<span class="product-card__biz-label">Business price</span>` +
                `<span class="product-card__biz-amount">${Security.escapeHtml(price)}</span>` +
                `<span class="product-card__biz-save">Save ${Security.escapeHtml(save + pct)}</span>` +
            `</span>`
        );
    },

    /**
     * Decorate already-rendered product cards with the signed-in business
     * customer's price. Runs after a grid renders; no-ops instantly for guests
     * and retail shoppers, so the two card renderers stay untouched.
     *
     * @param {Element|Document} [root=document]
     * @returns {Promise<number>} how many cards were decorated
     */
    async decorateCards(root) {
        const scope = root || document;
        if (!scope || typeof scope.querySelectorAll !== 'function') return 0;
        if (!(await this.isActive())) return 0;

        const cards = Array.from(scope.querySelectorAll('.product-card[data-sku]'))
            .filter(card => !card.querySelector('.product-card__biz-price'));
        if (!cards.length) return 0;

        const { items } = await this.getPricing(cards.map(c => c.getAttribute('data-sku')));

        let decorated = 0;
        for (const card of cards) {
            const sku = card.getAttribute('data-sku');
            const offer = this.describeOffer(items.get(sku));
            if (!offer) continue; // missed, unfound, or genuinely no discount -> retail
            // Both card renderers use one of these two price-block class names.
            const target = card.querySelector('.product-card__price-block, .product-card__pricing');
            if (!target || target.querySelector('.product-card__biz-price')) continue;
            target.insertAdjacentHTML('beforeend', this.cardMarkup(offer));
            decorated++;
        }
        return decorated;
    }
};

if (typeof window !== 'undefined') {
    window.Business = Business;
    // Registering the auth listener is cheap and fires no network request.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => Business.init());
    } else {
        Business.init();
    }
}
