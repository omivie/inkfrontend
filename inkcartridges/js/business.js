/**
 * BUSINESS.JS
 * ===========
 * B2B "Business Account" VOLUME pricing for InkCartridges.co.nz.
 *
 * Backend handoff: readfirst/business-account-pricing-v2-FE-handoff-jul2026.md
 * FE response:     business-account-volume-pricing-FE-response-jul2026.md
 *
 * WHAT v2 CHANGED (and why the v1 frontend went silently dark)
 * -----------------------------------------------------------
 * v1 was a flat per-account tier (bronze/silver/gold) and every price lived at
 * the TOP LEVEL of a pricing item: `business_price`, `savings_amount`,
 * `effective_percent`, `floored`. v2 replaced that with a per-line VOLUME
 * discount whose % depends on (the product's price band x the line quantity),
 * and moved all of those fields INSIDE `quantity_breaks[]`.
 *
 * Nothing errored. `describeOffer()` read `item.business_price`, found
 * `undefined`, and returned null for every SKU — which this module's own
 * fail-soft contract renders as "no business discount, show retail". The PDP
 * panel and the card overlay simply stopped existing, on every page, for every
 * business customer, with a clean console. That is the exact
 * absence-read-as-a-healthy-zero failure this file warns about below, and it
 * bit the file that warns about it.
 *
 * THE ONE RULE (unchanged, and now it matters more)
 * -------------------------------------------------
 * The frontend NEVER computes a business price. Each rung's `discount_percent`
 * is a CEILING: the backend caps every unit's discount so the unit still nets
 * >= 5% after Stripe fees ("never sell at a loss"). On thin-margin items the
 * realised discount is smaller (`floored:true`). So
 *
 *     retail x (1 - discount_percent)  !=  what checkout charges
 *
 * Every number rendered here is `business_price` / `savings_amount` /
 * `effective_percent` verbatim from the API. `percent` is ALWAYS
 * `effective_percent`, never the ceiling — one rule that is honest when floored
 * and identical when not.
 *
 * THE HAZARD NO HANDOFF MENTIONS: FLOORING PRODUCES DUPLICATE RUNGS
 * -----------------------------------------------------------------
 * When the floor bites, the ladder flattens and consecutive rungs come back at
 * the SAME price. Live examples (2026-08-02, full 4,015-SKU sweep, 39 floored):
 *
 *   GDR2025BK   2+ $187.95 | 3+ $186.04 | 6+ $180.79 | 7+ $180.79
 *   GW213CMY    2+ $1128.32 | 3+ $1124.49 | 5+ $1124.49 | 6+ $1124.49
 *
 * Rendering that verbatim tells a customer to buy more units to get a price they
 * already had. `describeLadder()` therefore COLLAPSES any rung that is not
 * strictly cheaper than the one before it. Every rung this module emits is a
 * real, distinct improvement.
 *
 * The Aug-2026 re-band made this MORE important, not less: the deepest two rungs
 * are now a single unit apart in every band, so a duplicate rung asks the
 * customer to buy one more unit for nothing.
 *
 * A LADDER CAN ALSO FLOOR AWAY COMPLETELY. 13 live SKUs come back with all four
 * rungs priced AT retail (`effective_percent: 0`, `savings_amount: 0`) because
 * the item is already too close to cost for any rung to clear the floor. Every
 * rung is dropped, `describeLadder()` returns null, and the product renders
 * plain retail with no B2B surface — silently, because that is a real answer
 * rather than the unrecognised-payload case below, which must warn.
 *
 * AT QUANTITY 1 A BUSINESS ACCOUNT PAYS FULL RETAIL. There is no such thing as
 * "the business price" of a SKU — only the price at a quantity. Anything that
 * shows one number without a quantity beside it is lying.
 *
 * The entry rung is BAND-DEPENDENT: 2+ in the three bands from $100 up, 3+ in
 * the three below. (Before 2026-08-02 it was 3+ everywhere, and this comment
 * said so.) Never build on one of those numbers — read `ladder.entry`. The only
 * durable invariant is that no band has ever had a qty-1 rung.
 *
 * Two endpoints, both auth-gated (verified live: 401 unauthenticated, vs 404 for
 * a bogus /api/business/nope path — the routes exist):
 *   GET /api/business/status                -> is this user a business account
 *   GET /api/business/pricing?skus=A,B,...  -> per-SKU volume ladder (max 100)
 *
 * CACHING: in-memory ONLY, and wiped whenever the signed-in user changes.
 * Business prices are per-account and must never leak to another shopper, so
 * localStorage/sessionStorage are deliberately not used here.
 *
 * FAIL-SOFT, LOUDLY: a SKU the server declined to answer for is NOT the same as
 * a SKU that is genuinely absent from the catalog. The first lands in `missed`
 * (caller renders plain retail and we warn); the second comes back as a real
 * item with `found:false`. Collapsing the two would let a broken endpoint
 * masquerade as "no business discount available" — the ERR-063/068/073/110
 * failure mode. Same reason `describeLadder()` warns instead of shrugging when
 * the payload shape is one it does not recognise.
 *
 * (ERR-139)
 */

'use strict';

const Business = {

    /** Hard cap from the backend contract — more than this per call is rejected. */
    MAX_SKUS_PER_CALL: 100,

    /**
     * The pricing model this module understands. The API echoes it as
     * `data.source`; anything else means the backend changed the model out from
     * under us again and we say so instead of rendering a stale mental model.
     */
    SOURCE: 'volume',

    /**
     * `status` values that mean "this account gets business pricing".
     *
     * VERIFIED LIVE 2026-07-31 against a real approved account:
     *   { status: "approved", application: { company_name, submitted_at },
     *     credit_limit: 0, credit_remaining: 0, net30_approved: true }
     *
     * Note what is NOT there any more: `pricing_tier`. v1 treated a recognised
     * tier as sufficient evidence of an active account; with the field gone,
     * `status` is the only signal — and the live payload always carries it.
     *
     * The v1 handoff said "active business account" in prose, so an earlier
     * draft tested `status === 'active'`, which silently denied business pricing
     * to every genuinely approved customer. Anything NOT on this list (pending,
     * rejected, suspended, ...) falls back to retail, which is the safe
     * direction to be wrong in.
     */
    ACTIVE_STATUSES: ['approved', 'active'],

    /** Shape returned by readStatus() for anyone who is not a business account. */
    INACTIVE_STATUS: Object.freeze({
        active: false,
        companyName: null,
        net30Approved: false,
        creditLimit: null,
        creditRemaining: null
    }),

    // ── Internal state ──────────────────────────────────────────────────────
    // `_cacheOwner` is the user id the caches belong to. Any mismatch (sign in,
    // sign out, account switch) throws the whole cache away before it can be read.
    _cacheOwner: undefined,
    _statusPromise: null,
    _priceCache: new Map(),   // sku -> item object from the API
    // True when the last status call returned a NON-ANSWER (5xx, network, throw)
    // rather than an honest "not a business account". Distinguishing the two is
    // what stops an outage from looking like a deliberate downgrade (ERR-139).
    _statusDegraded: false,

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
     * Normalise GET /api/business/status.
     *
     * An explicit negative flag always wins over everything else — a revoked
     * account must never keep pricing off a stale field. When the payload
     * carries a `status` string it is authoritative: only a known-good status
     * grants pricing, and unknown/pending/rejected fall back to retail.
     *
     * `credit_limit` / `credit_remaining` / `net30_approved` / the application's
     * `company_name` are all live and were all discarded by v1. They are the
     * account panel's content now that there is no tier to name.
     *
     * @param {object} data
     * @returns {{active:boolean, companyName:(string|null), net30Approved:boolean,
     *            creditLimit:(number|null), creditRemaining:(number|null)}}
     */
    readStatus(data) {
        const inactive = () => Object.assign({}, this.INACTIVE_STATUS);
        const d = data && typeof data === 'object' ? data : {};

        const flags = [d.active, d.is_active, d.is_business, d.business_account];
        if (flags.some(v => v === false)) return inactive();

        let active;
        if (typeof d.status === 'string' && d.status) {
            active = this.ACTIVE_STATUSES.includes(d.status.toLowerCase());
        } else {
            active = flags.some(v => v === true);
        }
        if (!active) return inactive();

        const app = d.application && typeof d.application === 'object' ? d.application : {};
        const rawName = [d.company_name, app.company_name]
            .find(v => typeof v === 'string' && v.trim());

        // A credit figure of 0 is meaningful (an approved account with no credit
        // extended); only a missing/garbage figure becomes null. `?? null` on a
        // Number() would turn NaN into NaN, so test finiteness explicitly.
        const money = (v) => {
            if (v === null || v === undefined || v === '') return null;
            const n = Number(v);
            return Number.isFinite(n) ? n : null;
        };

        return {
            active: true,
            companyName: rawName ? rawName.trim() : null,
            net30Approved: d.net30_approved === true,
            creditLimit: money(d.credit_limit),
            creditRemaining: money(d.credit_remaining)
        };
    },

    /**
     * Turn one /api/business/pricing item into a rendered-ready volume ladder,
     * or null when there is nothing honest to show.
     *
     * This is THE ONE PLACE the ladder is interpreted. Everything downstream —
     * PDP chips, card overlay, cart nudges — consumes the result, so the
     * collapsing rule and the effective_percent rule cannot drift between
     * surfaces.
     *
     * Returns null (caller renders plain retail) when: the SKU is missing,
     * unfound or inactive; `retail_price` is unusable; or no rung survives
     * normalisation. An EMPTY `quantity_breaks` is a documented, legitimate
     * "no volume discount for this band" and returns null silently.
     *
     * Returns null LOUDLY when `quantity_breaks` is absent altogether. The
     * contract says the array is always present on a found item, so its absence
     * is a payload we do not understand — most likely a rollback to the v1 flat
     * shape, which is exactly how this feature went dark once already. A warn
     * costs nothing and makes the next model change a five-minute diagnosis.
     *
     * @param {object} item  one element of data.items[]
     * @returns {{sku:(string|null), retailPrice:number, breaks:Array<object>,
     *            entry:object, best:object, collapsed:number,
     *            droppedAtOrAboveRetail:number, anyFloored:boolean}|null}
     */
    describeLadder(item) {
        if (!item || typeof item !== 'object') return null;
        if (item.found === false || item.is_active === false) return null;

        const sku = typeof item.sku === 'string' ? item.sku : null;
        const retailPrice = Number(item.retail_price);
        if (!Number.isFinite(retailPrice) || retailPrice <= 0) return null;

        if (!Array.isArray(item.quantity_breaks)) {
            const v1 = item.business_price !== undefined;
            this._warn(
                `[Business] unrecognised pricing payload for ${sku || 'an unnamed SKU'} — ` +
                `quantity_breaks is absent` +
                (v1 ? ' but a flat top-level business_price is present (the retired v1 shape)' : '') +
                '. Rendering standard retail: NO volume ladder is being shown to this business customer.'
            );
            return null;
        }

        const rungs = [];
        // A rung can vanish here for a reason the COLLAPSE loop below never
        // counts. That used to be unreachable: the shallowest ladder rung was
        // 3%, so `business_price >= retail_price` could not happen. The Aug 2026
        // re-seed put the entry rung at 0.5%, where a cheap SKU's discount can
        // round away to nothing — the ladder then silently starts one rung
        // higher than the matrix says while `collapsed` reports 0. Counted and
        // returned so the conservation law
        //   breaks.length + collapsed + droppedAtOrAboveRetail === quantity_breaks.length
        // is checkable from outside this function.
        let droppedAtOrAboveRetail = 0;
        for (const raw of item.quantity_breaks) {
            if (!raw || typeof raw !== 'object') continue;

            const minQuantity = Number(raw.min_quantity);
            const businessPrice = Number(raw.business_price);
            // A rung at qty < 2 is not a volume break; a rung at or above retail
            // has nothing to advertise. Both are dropped rather than rendered as
            // a "saving" of zero or less.
            //
            // `< 2` is LOAD-BEARING, not incidental. It used to sit safely below
            // every band's entry rung (3+), so it never fired on live data. Since
            // 2026-08-02 the three $100+ bands enter at 2+, which puts 2,261 of
            // 4,015 SKUs' entry rung exactly on this boundary — tightening it to
            // `< 3` would delete the first rung of over half the catalog while
            // every other rung kept working, and the ladder would just quietly
            // start one rung too high.
            if (!Number.isFinite(minQuantity) || minQuantity < 2) continue;
            if (!Number.isFinite(businessPrice) || businessPrice <= 0) continue;
            if (businessPrice >= retailPrice) { droppedAtOrAboveRetail++; continue; }

            // savings_amount is DEFINED by the contract as retail_price -
            // business_price. Preferring the server's figure and subtracting two
            // authoritative prices only as a fallback is not the banned
            // arithmetic: the ban is on reconstructing a PRICE from a percentage
            // ceiling, which is the thing the floor makes wrong.
            const rawSavings = Number(raw.savings_amount);
            const savings = Number.isFinite(rawSavings) && rawSavings > 0
                ? rawSavings
                : Math.round((retailPrice - businessPrice) * 100) / 100;

            const percent = Number(raw.effective_percent);

            rungs.push({
                minQuantity: Math.floor(minQuantity),
                businessPrice,
                savings,
                percent: Number.isFinite(percent) && percent > 0 ? percent : null,
                floored: raw.floored === true
            });
        }

        rungs.sort((a, b) => a.minQuantity - b.minQuantity);

        // COLLAPSE. Keep a rung only when it is a strict improvement on the last
        // one kept. This is what stops a floored SKU advertising "Buy 20+" for
        // the price it already charges at 10+.
        const breaks = [];
        let collapsed = 0;
        for (const rung of rungs) {
            const prev = breaks[breaks.length - 1];
            if (prev && (rung.minQuantity === prev.minQuantity || rung.businessPrice >= prev.businessPrice)) {
                collapsed++;
                continue;
            }
            breaks.push(rung);
        }
        if (!breaks.length) return null;

        return {
            sku,
            retailPrice,
            breaks,
            entry: breaks[0],
            best: breaks[breaks.length - 1],
            collapsed,
            droppedAtOrAboveRetail,
            anyFloored: breaks.some(r => r.floored)
        };
    },

    /**
     * The rung that applies at a given line quantity — the deepest rung whose
     * `min_quantity` the quantity reaches — or null when the quantity is below
     * the entry rung (i.e. the customer pays retail).
     *
     * This is the function that makes "the business price" a function of
     * quantity rather than a property of a product.
     *
     * @param {object|null} ladder  result of describeLadder()
     * @param {number} quantity
     * @returns {object|null} the rung
     */
    offerAtQuantity(ladder, quantity) {
        const qty = Number(quantity);
        if (!ladder || !Array.isArray(ladder.breaks) || !Number.isFinite(qty)) return null;
        let hit = null;
        for (const rung of ladder.breaks) {
            if (qty >= rung.minQuantity) hit = rung;
            else break; // breaks[] is ascending, so the first miss ends it
        }
        return hit;
    },

    /**
     * The next rung up from a given quantity, for an "add N more" nudge, or null
     * when the customer is already on the deepest rung.
     *
     * `lineSavingsAtBreak` is the TOTAL saved on the line once they get there
     * (per-unit savings x the break quantity) — the number that actually
     * motivates, and still nothing but multiplication of authoritative figures.
     *
     * @param {object|null} ladder
     * @param {number} quantity
     * @returns {{rung:object, unitsAway:number, quantityAtBreak:number,
     *            lineSavingsAtBreak:number}|null}
     */
    nextBreak(ladder, quantity) {
        const qty = Number(quantity);
        if (!ladder || !Array.isArray(ladder.breaks) || !Number.isFinite(qty)) return null;
        const here = Math.max(0, Math.floor(qty));
        for (const rung of ladder.breaks) {
            if (rung.minQuantity > here) {
                return {
                    rung,
                    unitsAway: rung.minQuantity - here,
                    quantityAtBreak: rung.minQuantity,
                    lineSavingsAtBreak: Math.round(rung.savings * rung.minQuantity * 100) / 100
                };
            }
        }
        return null;
    },

    /**
     * Total saved on one line at its current quantity — 0 when no rung applies.
     * Used by the cart consistency check and by the PDP's live line.
     * @param {object|null} ladder
     * @param {number} quantity
     * @returns {number}
     */
    lineSavings(ladder, quantity) {
        const rung = this.offerAtQuantity(ladder, quantity);
        const qty = Number(quantity);
        if (!rung || !Number.isFinite(qty) || qty <= 0) return 0;
        return Math.round(rung.savings * Math.floor(qty) * 100) / 100;
    },

    /**
     * Format a percent for display: 15 -> "15%", 6.3 -> "6.3%", 0.03 -> "<0.1%".
     *
     * The floor case is not cosmetic. The PDP chip renders this as
     * `&minus;` + the string, so a percent that rounds to zero prints
     * "-0%" NEXT TO A PRICE THAT IS GENUINELY LOWER THAN RETAIL. That was
     * unreachable while the shallowest ladder rung was 3%; the Aug 2026
     * re-seed put the entry rung at 0.5%, and the "never net below 5% after
     * fees" floor can clamp a thin-margin unit below 0.05% from there.
     *
     * "<0.1%" and not "" — an empty string is falsy, the chip's ternary reads
     * that as "no percent to show" and omits the badge entirely, and a badge
     * silently missing from a real discount is the absence-reads-as-zero
     * failure this whole module exists to prevent (ERR-063/068/139).
     *
     * @param {number} pct
     * @returns {string}
     */
    formatPercent(pct) {
        if (!Number.isFinite(pct)) return '';
        const rounded = Math.round(pct * 10) / 10;
        if (pct > 0 && rounded === 0) return '<0.1%';
        return (Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)) + '%';
    },

    /**
     * "Buy 3+" — the one place rung quantities get worded, so the PDP chips, the
     * card overlay and the cart nudge cannot describe the same rung differently.
     * @param {object} rung
     * @returns {string}
     */
    breakLabel(rung) {
        return rung && Number.isFinite(rung.minQuantity) ? `${rung.minQuantity}+` : '';
    },

    /** Money, via the app-wide formatter when it is loaded. */
    _money(n) {
        return typeof formatPrice === 'function'
            ? formatPrice(n)
            : '$' + Number(n).toFixed(2);
    },

    /** DebugLog when present, silent otherwise — this module also runs under `vm` in tests. */
    _warn(...args) {
        if (typeof DebugLog !== 'undefined' && DebugLog && typeof DebugLog.warn === 'function') {
            DebugLog.warn(...args);
        }
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
        this._cacheOwner = undefined;
        this._statusDegraded = false;
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
            Auth.onAuthStateChange(() => {
                this.reset();
                // Sign-in/sign-out must add or drop the header shortcut without a
                // reload — reset() has just binned the memoised status, so this
                // re-asks rather than reading a stale answer.
                this._evaluateHeaderLink();
            });
        }
        this.initHeaderLink();
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Header entry point — the "Business" shortcut
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * sessionStorage key for the instant-show hint, keyed to the user id so one
     * account's answer can never reveal the button for another.
     */
    HEADER_HINT_KEY: 'ink_business_header_hint',

    /**
     * Reveal the header "Business" shortcut for approved business accounts only.
     *
     * The link is CREATED here rather than shipped hidden in markup, for the same
     * reason the Admin link is (main.js#initAdminHeaderLink): the site header is
     * byte-identical across 29 pages and hashed by tests/navbar-parity-may2026,
     * so a fourth static action item would mean editing all 29 in lockstep. It
     * lands as the FIRST item in `.header-actions` — the slot the Admin shortcut
     * vacated when it moved to `.header-lead` (Aug 2026).
     *
     * This is UI sugar, not an access gate. /business re-checks the account in
     * BusinessPage.init(), and every endpoint behind it is `requireB2B` server
     * side, so a wrongly-shown button grants nothing.
     *
     * UX: a per-session hint makes the button appear instantly on later page
     * loads instead of popping in after each navigation. The authoritative
     * getStatus() call always runs and reconciles it, so a revoked account or a
     * stale hint self-corrects within one page load.
     */
    initHeaderLink() {
        if (this._headerInited) return;
        this._headerInited = true;
        this._evaluateHeaderLink();
    },

    _ensureHeaderLink() {
        const existing = document.getElementById('header-business-link');
        if (existing) return existing;
        const actions = document.querySelector('.header-actions');
        if (!actions) return null;
        const a = document.createElement('a');
        a.href = '/business';
        a.className = 'header-actions__item header-actions__item--business';
        a.id = 'header-business-link';
        a.setAttribute('aria-label', 'Business Centre');
        a.innerHTML = '<span class="header-actions__icon">' +
            '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>' +
            '</span><span>Business Centre</span>';
        // First item, so it leads the cluster where Admin used to sit.
        actions.insertBefore(a, actions.firstElementChild);
        return a;
    },

    _removeHeaderLink() {
        const el = document.getElementById('header-business-link');
        if (el && el.parentNode) el.parentNode.removeChild(el);
    },

    _readHeaderHint() {
        try { return sessionStorage.getItem(this.HEADER_HINT_KEY); } catch (e) { return null; }
    },

    _writeHeaderHint(value) {
        try {
            if (value) sessionStorage.setItem(this.HEADER_HINT_KEY, value);
            else sessionStorage.removeItem(this.HEADER_HINT_KEY);
        } catch (e) { /* private mode — the hint is an optimisation, not state */ }
    },

    /**
     * Decide whether the shortcut should be on the page right now.
     *
     * The one subtlety: getStatus() folds "you are not a business account" and
     * "we could not reach the backend" into the same inactive shape. Removing
     * the button on an outage would take a working surface away from a customer
     * who still has it, and would look exactly like a deliberate downgrade —
     * the ERR-139 failure mode. So when the status call is DEGRADED we keep
     * whatever the hint already decided instead of acting on a non-answer.
     */
    async _evaluateHeaderLink() {
        if (typeof document === 'undefined' || !document.querySelector) return;
        await this._waitForAuth();

        // Guests never see it and never trigger a request.
        if (!this._isAuthenticated()) {
            this._removeHeaderLink();
            this._writeHeaderHint(null);
            return;
        }

        const uid = this._userId() || '';
        if (uid && this._readHeaderHint() === uid) this._ensureHeaderLink();

        const status = await this.getStatus();
        if (this._statusDegraded) return;   // non-answer — leave the hint's verdict alone

        if (status.active) this._ensureHeaderLink();
        else this._removeHeaderLink();
        this._writeHeaderHint(status.active && uid ? uid : null);
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Network
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Is the signed-in user an active business account?
     * Guests, retail customers and any failure all resolve to an inactive
     * status — the storefront then behaves exactly as it does today. Memoised
     * per user for the life of the page.
     * @returns {Promise<object>} readStatus() shape
     */
    async getStatus() {
        await this._waitForAuth();
        this._syncCacheOwner();

        // Never fire a business request for a guest — it would 401 on every page.
        if (!this._isAuthenticated()) return Object.assign({}, this.INACTIVE_STATUS);
        if (this._statusPromise) return this._statusPromise;

        this._statusDegraded = false;
        this._statusPromise = (async () => {
            try {
                const res = await API.get('/api/business/status');
                if (!res || res.ok === false) {
                    // 403 B2B_REQUIRED / 401 simply means "not a business account".
                    // Anything else is worth a dev-console note.
                    const code = res && res.code;
                    if (code && code !== 'B2B_REQUIRED' && code !== 'FORBIDDEN' && code !== 'UNAUTHORIZED') {
                        this._warn('[Business] status failed:', code, res && res.error);
                        // A real "no" downgrades the storefront honestly; a 500 or a
                        // dead backend is a NON-ANSWER wearing the same shape. Callers
                        // that can hold their nerve (the header shortcut) read this
                        // flag instead of treating silence as a denial (ERR-139).
                        this._statusDegraded = true;
                    }
                    return Object.assign({}, this.INACTIVE_STATUS);
                }
                return this.readStatus(res.data);
            } catch (e) {
                this._warn('[Business] status error:', e && e.message);
                this._statusDegraded = true;
                return Object.assign({}, this.INACTIVE_STATUS);
            }
        })();

        return this._statusPromise;
    },

    /** @returns {Promise<boolean>} */
    async isActive() {
        return (await this.getStatus()).active;
    },

    /**
     * Fetch volume ladders for a set of SKUs.
     *
     * Returns BOTH what we got and what we failed to get. `missed` is part of
     * the return value on purpose: a caller that renders retail for a missed
     * SKU is correct, but a caller that cannot tell "missed" from "no discount"
     * would show a wrong price with total confidence.
     *
     * @param {Array<string>} skus
     * @returns {Promise<{items: Map<string, object>, missed: Array<string>}>}
     */
    async getPricing(skus) {
        const status = await this.getStatus();
        const result = { items: new Map(), missed: [] };

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
            this._warn(
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
            // The model the response was computed under. Not fatal — the items
            // still get read — but a mismatch means this module's mental model
            // is out of date and someone should look.
            if (res.data.source && res.data.source !== this.SOURCE) {
                this._warn(
                    `[Business] pricing source is "${res.data.source}", not "${this.SOURCE}" — ` +
                    'the backend pricing model may have changed. Ladders may render incorrectly.'
                );
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
            this._warn('[Business] pricing error:', e && e.message);
            result.missed.push(...chunk);
        }
    },

    /**
     * Convenience for the PDP: the ladder for exactly one SKU.
     * @param {string} sku
     * @returns {Promise<object|null>} describeLadder() result, or null.
     */
    async getLadderFor(sku) {
        const { items } = await this.getPricing([sku]);
        return this.describeLadder(items.get(sku));
    },

    // ─────────────────────────────────────────────────────────────────────────
    // Rendering
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Inline bulk-price markup for a product card.
     *
     * v1 said "Business price $X" with no quantity, which under the volume model
     * would be a price checkout refuses to honour on the qty-1 add-to-cart the
     * card itself offers. The quantity is now part of the claim: the headline is
     * the ENTRY rung (the achievable one) and the deepest rung rides along as
     * the aspiration.
     *
     * @param {object} ladder  result of describeLadder()
     * @returns {string} HTML
     */
    cardMarkup(ladder) {
        const entry = ladder.entry;
        const best = ladder.best;
        const sub = (best && best !== entry)
            ? `Buy ${this.breakLabel(entry)} · down to ${this._money(best.businessPrice)} at ${this.breakLabel(best)}`
            : `Buy ${this.breakLabel(entry)}`;
        return (
            `<span class="product-card__biz-price" data-testid="business-card-price">` +
                `<span class="product-card__biz-label">Business bulk price</span>` +
                `<span class="product-card__biz-amount">${Security.escapeHtml(this._money(entry.businessPrice))}` +
                    `<span class="product-card__biz-unit"> ea</span></span>` +
                `<span class="product-card__biz-save">${Security.escapeHtml(sub)}</span>` +
            `</span>`
        );
    },

    /**
     * Every card component in the storefront that carries a SKU and a price.
     * Six grids render product tiles from four different bits of markup
     * (products.js, shop-page.js, ribbons-page.js, landing.js) plus the saved
     * list (favourites.js); listing them here rather than in each caller is what
     * keeps a business customer from seeing bulk pricing on /shop and not on
     * /account/favourites — which is the surface where they actually reorder.
     */
    CARD_SELECTOR: '.product-card[data-sku], .favourite-item[data-sku]',

    /**
     * Where the overlay goes INSIDE a card, most specific first.
     *
     * Ordered lookups, not one comma-joined selector: querySelector returns the
     * first match in DOCUMENT order across the whole list, so a wrapper like
     * `.product-card__info` would beat the `.product-card__price-block` nested
     * inside it and the price would land in the wrong place.
     */
    PRICE_BLOCK_SELECTORS: [
        '.product-card__price-block',   // products.js
        '.product-card__pricing',       // shop-page.js, ribbons-page.js
        '.favourite-item__info',        // favourites.js
        '.product-card__info'           // landing.js
    ],

    /** @param {Element} card @returns {Element|null} */
    _priceBlock(card) {
        for (const sel of this.PRICE_BLOCK_SELECTORS) {
            const el = card.querySelector(sel);
            if (el) return el;
        }
        return null;
    },

    /**
     * Decorate already-rendered product cards with the signed-in business
     * customer's bulk pricing. Runs after a grid renders; no-ops instantly for
     * guests and retail shoppers, so the card renderers stay untouched.
     *
     * @param {Element|Document} [root=document]
     * @returns {Promise<number>} how many cards were decorated
     */
    async decorateCards(root) {
        const scope = root || document;
        if (!scope || typeof scope.querySelectorAll !== 'function') return 0;
        if (!(await this.isActive())) return 0;

        const cards = Array.from(scope.querySelectorAll(this.CARD_SELECTOR))
            .filter(card => !card.querySelector('.product-card__biz-price'));
        if (!cards.length) return 0;

        const { items } = await this.getPricing(cards.map(c => c.getAttribute('data-sku')));

        let decorated = 0;
        for (const card of cards) {
            const ladder = this.describeLadder(items.get(card.getAttribute('data-sku')));
            if (!ladder) continue; // missed, unfound, or genuinely no ladder -> retail
            const target = this._priceBlock(card);
            if (!target || target.querySelector('.product-card__biz-price')) continue;
            target.insertAdjacentHTML('beforeend', this.cardMarkup(ladder));
            decorated++;
        }
        return decorated;
    },

    /**
     * "Add 3 more to reach 7+ — $22.78 each, saving $11.97 on this line."
     *
     * The cart's own payload cannot produce this: cart lines carry retail
     * `price_snapshot` / `line_total` and no per-line B2B figure at all (the
     * discount only surfaces as one cart-level `b2b_discount.discount_amount`).
     * The ladder is the only route from "you saved $4.88" to "here is how to
     * save more", which is the whole point of a volume scheme.
     *
     * @param {object} ladder
     * @param {number} quantity  the line's current quantity
     * @param {number} [maxQuantity]  the line's quantity cap; a break beyond it
     *                                is not offered rather than silently clamped
     * @returns {string} HTML, or '' when there is nothing to nudge toward
     */
    nudgeMarkup(ladder, quantity, maxQuantity) {
        const next = this.nextBreak(ladder, quantity);
        if (!next) return '';
        if (Number.isFinite(maxQuantity) && next.quantityAtBreak > maxQuantity) return '';

        const units = next.unitsAway === 1 ? '1 more' : `${next.unitsAway} more`;
        const text =
            `Add ${units} to reach ${this.breakLabel(next.rung)} — ` +
            `${this._money(next.rung.businessPrice)} each, ` +
            `saving ${this._money(next.lineSavingsAtBreak)} on this line.`;

        return (
            `<p class="cart-item__volume-nudge" data-testid="volume-nudge" ` +
                `data-break-quantity="${next.quantityAtBreak}">` +
                Security.escapeHtml(text) +
            `</p>`
        );
    },

    /**
     * Decorate rendered cart lines with their next volume break. Mirrors
     * decorateCards: one batched pricing call, no-op for guests and retail.
     *
     * Reads `data-sku` / `data-quantity` off each `.cart-item`.
     *
     * @param {Element|Document} [root=document]
     * @param {number} [maxQuantity]
     * @returns {Promise<number>} how many lines were decorated
     */
    async decorateCartLines(root, maxQuantity) {
        const scope = root || document;
        if (!scope || typeof scope.querySelectorAll !== 'function') return 0;
        if (!(await this.isActive())) return 0;

        const lines = Array.from(scope.querySelectorAll('.cart-item[data-sku]'));
        if (!lines.length) return 0;

        // Repaint from scratch every time: a quantity change moves the nudge.
        for (const line of lines) {
            const stale = line.querySelector('.cart-item__volume-nudge');
            if (stale) stale.remove();
        }

        const { items } = await this.getPricing(lines.map(l => l.getAttribute('data-sku')));

        let decorated = 0;
        for (const line of lines) {
            const ladder = this.describeLadder(items.get(line.getAttribute('data-sku')));
            if (!ladder) continue;
            const html = this.nudgeMarkup(ladder, Number(line.getAttribute('data-quantity')), maxQuantity);
            if (!html) continue;
            const target = line.querySelector('.cart-item__details') || line;
            target.insertAdjacentHTML('beforeend', html);
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
