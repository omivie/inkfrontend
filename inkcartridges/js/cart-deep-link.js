/**
 * /cart?add=SKU:QTY — one-click reorder deep link
 * ==============================================================================
 * ERR-269.
 *
 * Guest recipients of a reorder/refill email had no one-click path back into a
 * cart. Account holders did (a signed backend link); the ~99 guests per send
 * were pointed at `/shop` and had to find their cartridges again by hand. The
 * backend's redirects were already emitting `/cart?add=…`; nothing on this side
 * read the parameter, so the link opened an unchanged cart with `?add=` still
 * sitting in the address bar.
 *
 * Spec (backend handoff, 2026-09-15 addendum):
 *   /cart?add=SKU:QTY,SKU:QTY — SKUs uppercase, QTY 1-20, max 12 entries.
 *   Add each through the NORMAL add-to-cart call under the visitor's own
 *   session (guest or authed — the same code path as the add-to-cart button).
 *   Then strip the param with history.replaceState so a refresh cannot
 *   double-add. Toast off ?reorder=loaded|unavailable|invalid|guest.
 *
 * WHY THIS IS ITS OWN FILE
 * ------------------------
 * `cart-page.js` calls `document.addEventListener` at top level, so a test that
 * `require()`s it throws. Everything below is guarded the way `js/seo-meta.js`
 * is — browser global under `typeof window`, `module.exports` under Node — so
 * tests can EXECUTE the parser against real inputs instead of grepping its
 * source. A suite that only greps proves the code is spelled a certain way, not
 * that it works (ERR-224, where all 21 tests were source greps).
 *
 * FOUR THINGS THIS FILE IS CAREFUL ABOUT, each of them a scar
 * -----------------------------------------------------------
 * 1. `Cart.add` DOES NOT EXIST. The method is `Cart.addItem(product)` — one
 *    OBJECT argument, quantity inside it, no second parameter. Passing a bare
 *    SKU reads `.id` off a string, gets `undefined`, and POSTs
 *    `product_id: undefined` (ERR-218).
 * 2. `addItem` POSTs a product UUID, not a SKU, so every entry costs one
 *    `API.getProduct(sku)` first. There is no batch endpoint.
 * 3. We wait for the cart to finish loading before the first add. `Cart.init()`
 *    registers its DOMContentLoaded listener before ours but is async — it
 *    awaits `waitForAuth()` (up to 3s) and then `loadCart()`. Adding inside that
 *    window races the server-cart adoption that emptied a cart in ERR-259.
 * 4. Adds run SERIALLY. Each `addItem` awaits a full `loadFromServer()`, and
 *    rapid concurrent adds race the pricing GET into a false "we couldn't
 *    confirm today's prices" banner (ERR-210).
 *
 * AND THE REPORT IS LOUD. A link that named three cartridges and delivered two
 * says so, and names the one that did not land. Absence is never rendered as
 * success (ERR-063/068/073/075/076/149/150).
 */

const CartDeepLink = {
    /** Spec limits. Kept as fields so the tests read the same numbers the code does. */
    MAX_ENTRIES: 12,
    MIN_QTY: 1,
    MAX_QTY: 20,
    MAX_SKU_LENGTH: 48,

    /** How long to wait for Cart.loadCart() before giving up, ms. */
    CART_READY_TIMEOUT_MS: 8000,

    /** Concurrent API.getProduct lookups. Bounded to stay polite to the
     *  shared 100-req/60s-per-IP limiter (ERR-266) — 12 entries would
     *  otherwise burst 12 GETs plus 12 POSTs plus 12 cart re-reads. */
    LOOKUP_CONCURRENCY: 4,

    /**
     * Parse the `add` parameter. PURE — no DOM, no network, no `Cart`.
     *
     * @param {string} raw e.g. "C73NM:1,GLC3333M:2"
     * @returns {{entries: Array<{sku: string, qty: number}>, invalid: string[],
     *           truncated: boolean, clamped: string[]}}
     *
     * Nothing is dropped quietly. A token we cannot read comes back in
     * `invalid`, entries past the cap set `truncated`, and a duplicate SKU whose
     * summed quantity exceeds MAX_QTY comes back in `clamped`. The caller
     * reports all three — a parser that silently discards half its input is how
     * "we added everything" gets said about two of three cartridges.
     */
    parseAddParam(raw) {
        const out = { entries: [], invalid: [], truncated: false, clamped: [] };
        if (typeof raw !== 'string') return out;

        const trimmed = raw.trim();
        if (!trimmed) return out;

        const bySku = new Map();
        const tokens = trimmed.split(',');

        for (const token of tokens) {
            const piece = token.trim();
            if (!piece) continue;

            if (bySku.size >= this.MAX_ENTRIES && !bySku.has(this._skuOf(piece))) {
                out.truncated = true;
                continue;
            }

            // "SKU:QTY" or a bare "SKU" (quantity 1). A second colon is junk.
            const parts = piece.split(':');
            if (parts.length > 2) { out.invalid.push(piece); continue; }

            const sku = String(parts[0] || '').trim().toUpperCase();
            // Real SKUs in this catalogue look like C73NM, GLC3333M, PG-540,
            // 670.01, 20N3HK0 — alphanumeric with hyphens and dots inside.
            if (!sku || sku.length > this.MAX_SKU_LENGTH || !/^[A-Z0-9][A-Z0-9._-]*$/.test(sku)) {
                out.invalid.push(piece);
                continue;
            }

            let qty = 1;
            if (parts.length === 2) {
                const rawQty = String(parts[1]).trim();
                // Integers only. "2.5", "2e1", " " and "abc" are all junk, and
                // Number() would happily turn two of those into a quantity.
                if (!/^\d+$/.test(rawQty)) { out.invalid.push(piece); continue; }
                qty = parseInt(rawQty, 10);
                if (!Number.isFinite(qty) || qty < this.MIN_QTY || qty > this.MAX_QTY) {
                    out.invalid.push(piece);
                    continue;
                }
            }

            if (bySku.has(sku)) {
                const summed = bySku.get(sku) + qty;
                if (summed > this.MAX_QTY) {
                    bySku.set(sku, this.MAX_QTY);
                    if (!out.clamped.includes(sku)) out.clamped.push(sku);
                } else {
                    bySku.set(sku, summed);
                }
            } else {
                bySku.set(sku, qty);
            }
        }

        for (const [sku, qty] of bySku) out.entries.push({ sku, qty });
        return out;
    },

    /** First field of a token, uppercased — used only for the cap check above. */
    _skuOf(piece) {
        return String(piece.split(':')[0] || '').trim().toUpperCase();
    },

    /**
     * Remove our parameters from the address bar, before anything is added.
     *
     * Strip-first is the house pattern (`autoApplyCouponFromUrl`,
     * cart-page.js) and the spec asks for it by name: the URL must not survive
     * into a refresh, or the shopper doubles their order by pressing F5.
     */
    _stripParams(keys) {
        if (typeof window === 'undefined' || !window.location) return;
        let url;
        try { url = new URL(window.location.href); } catch (_) { return; }
        let touched = false;
        for (const key of keys) {
            if (url.searchParams.has(key)) { url.searchParams.delete(key); touched = true; }
        }
        if (!touched) return;
        const qs = url.searchParams.toString();
        const clean = url.pathname + (qs ? '?' + qs : '') + url.hash;
        try { history.replaceState(history.state, '', clean); } catch (_) { /* best-effort */ }
    },

    /**
     * Wait until the cart has finished its initial load.
     *
     * `Cart.loading` starts true (cart.js) and clears only at the end of
     * `loadCart()`. Bounded: if the load never settles we proceed anyway rather
     * than silently dropping the shopper's reorder — `addItem` is server-first
     * and will still do the right thing; the risk we were avoiding is the
     * adoption race, not a hard dependency.
     */
    async _waitForCartReady() {
        if (typeof Cart === 'undefined') return false;
        const started = Date.now();
        while (Cart.loading && Date.now() - started < this.CART_READY_TIMEOUT_MS) {
            await new Promise((r) => setTimeout(r, 50));
        }
        return !Cart.loading;
    },

    /** Resolve SKU -> product record, bounded concurrency. */
    async _resolveAll(entries) {
        const results = new Array(entries.length);
        let cursor = 0;
        const worker = async () => {
            while (cursor < entries.length) {
                const index = cursor++;
                const { sku } = entries[index];
                try {
                    const res = await API.getProduct(sku);
                    // `res.ok` is not enough and neither is "the promise
                    // settled": a fulfilled allSettled entry reports success on
                    // every failure (ERR-187/192/211), and getProduct resolves
                    // a structured miss rather than throwing. The thing we
                    // actually need is an id to POST.
                    const product = (res && res.ok && res.data) ? res.data : null;
                    results[index] = (product && product.id) ? product : null;
                } catch (_) {
                    results[index] = null;
                }
            }
        };
        const workers = [];
        for (let i = 0; i < Math.min(this.LOOKUP_CONCURRENCY, entries.length); i++) {
            workers.push(worker());
        }
        await Promise.all(workers);
        return results;
    },

    /** Build the product object `Cart.addItem` expects from a catalogue record. */
    _toCartProduct(product, sku, qty) {
        return {
            id: product.id,
            sku: product.sku || sku,
            name: product.name || sku,
            price: product.retail_price || 0,
            image: (typeof storageUrl === 'function' ? storageUrl(product.image_url) : product.image_url) || '',
            brand: (product.brand && product.brand.name) || (typeof product.brand === 'string' ? product.brand : ''),
            color: product.color || '',
            color_hex: product.color_hex || null,
            slug: product.slug || '',
            quantity: qty,
            source: 'core',
            product_source: product.source || null,
            // We own the reporting for this batch — see the summary below.
            silent: true,
        };
    },

    /**
     * Compose the one summary line. Exported for the tests, and pure.
     *
     * The shape that matters: when some of the link landed and some did not,
     * the message says BOTH numbers and names what failed. "Added to cart" on a
     * partial result is the failure mode this whole file is written against.
     */
    buildSummary(report) {
        const { addedCount, requestedCount, failed, invalid, truncated, clamped } = report;
        const problems = [];
        if (failed.length) problems.push(`we couldn't add ${failed.join(', ')}`);
        if (invalid.length) problems.push(`we couldn't read ${invalid.join(', ')}`);
        if (truncated) problems.push(`only the first ${this.MAX_ENTRIES} items were used`);
        if (clamped.length) problems.push(`${clamped.join(', ')} was capped at ${this.MAX_QTY}`);

        if (addedCount === 0) {
            const why = problems.length ? problems.join('; ') : 'we could not read that reorder link';
            return { text: `Nothing was added — ${why}.`, type: 'error', duration: 8000 };
        }
        const noun = addedCount === 1 ? 'item' : 'items';
        if (!problems.length) {
            return { text: `Added ${addedCount} ${noun} to your cart.`, type: 'success', duration: 5000 };
        }
        return {
            text: `Added ${addedCount} of ${requestedCount} — ${problems.join('; ')}.`,
            type: 'warning',
            duration: 9000,
        };
    },

    /** Toast copy for the backend's ?reorder= status values. */
    REORDER_MESSAGES: {
        loaded: { text: 'Your previous order is ready to review.', type: 'success' },
        unavailable: { text: 'Some items from that order are no longer available.', type: 'warning' },
        invalid: { text: 'That reorder link has expired. Please add items from your order history.', type: 'error' },
        guest: { text: 'Sign in to reorder with one click next time.', type: 'info' },
    },

    /** `?reorder=<status>` — a toast, nothing else. Param already stripped. */
    handleReorderParam(status) {
        // hasOwnProperty, not a bare lookup: `?reorder=constructor` (or
        // toString, valueOf, __proto__) resolves up the prototype chain and
        // would toast `[Function: Object]` at the shopper. Caught by this
        // file's own §3 test, which is why it is spelled out rather than
        // trusted to the truthiness check below.
        if (typeof status !== 'string'
            || !Object.prototype.hasOwnProperty.call(this.REORDER_MESSAGES, status)) {
            return null;
        }
        const entry = this.REORDER_MESSAGES[status];
        if (!entry) return null;
        if (typeof showToast === 'function') {
            showToast(entry.text, entry.type, 6000);
        }
        return entry;
    },

    /**
     * The load-time entry point.
     * @returns {Promise<?object>} the report, or null when there was no `?add=`.
     */
    async applyAddParamFromUrl() {
        if (typeof window === 'undefined' || !window.location) return null;

        let url;
        try { url = new URL(window.location.href); } catch (_) { return null; }
        const raw = url.searchParams.get('add');
        const reorderStatus = url.searchParams.get('reorder');

        // Strip BOTH before any await. A refresh mid-flight must not re-add.
        this._stripParams(['add', 'reorder']);

        if (reorderStatus) this.handleReorderParam(reorderStatus);
        if (!raw) return null;

        const parsed = this.parseAddParam(raw);
        const requestedCount = parsed.entries.length;

        const report = {
            addedCount: 0,
            requestedCount,
            failed: [],
            invalid: parsed.invalid.slice(),
            truncated: parsed.truncated,
            clamped: parsed.clamped.slice(),
            ok: false,
        };

        if (!requestedCount) {
            const summary = this.buildSummary(report);
            if (typeof showToast === 'function') showToast(summary.text, summary.type, summary.duration);
            return report;
        }

        if (typeof Cart === 'undefined' || typeof Cart.addItem !== 'function'
            || typeof API === 'undefined' || typeof API.getProduct !== 'function') {
            report.failed = parsed.entries.map((e) => e.sku);
            const summary = this.buildSummary(report);
            if (typeof showToast === 'function') showToast(summary.text, summary.type, summary.duration);
            return report;
        }

        await this._waitForCartReady();

        const resolved = await this._resolveAll(parsed.entries);

        // Serial, deliberately — see note 4 in the header.
        for (let i = 0; i < parsed.entries.length; i++) {
            const { sku, qty } = parsed.entries[i];
            const product = resolved[i];
            if (!product) { report.failed.push(sku); continue; }
            try {
                const result = await Cart.addItem(this._toCartProduct(product, sku, qty));
                // `ok: false` is a server refusal with the line already rolled
                // back. 'offline' is ok:true — the item IS in their cart.
                if (result && result.ok === false) report.failed.push(sku);
                else report.addedCount++;
            } catch (_) {
                report.failed.push(sku);
            }
        }

        report.ok = report.addedCount === requestedCount
            && !report.invalid.length && !report.truncated && !report.clamped.length;

        const summary = this.buildSummary(report);
        if (typeof showToast === 'function') showToast(summary.text, summary.type, summary.duration);

        if (typeof Cart.updateUI === 'function') Cart.updateUI();

        return report;
    },
};

// Browser global (mirrors the project's module pattern — Config/API/Cart/...).
if (typeof window !== 'undefined') {
    window.CartDeepLink = CartDeepLink;

    // Self-enrolling: the cart page needs no wiring beyond the <script> tag.
    // A feature that depends on someone remembering to call it has gone missing
    // here before (ERR-214 — ten dead search boxes for four months), so the
    // script tag in html/cart.html is pinned by a test instead.
    document.addEventListener('DOMContentLoaded', () => {
        if (!document.querySelector('.cart-page')) return;
        CartDeepLink.applyAddParamFromUrl().catch((err) => {
            if (typeof DebugLog !== 'undefined') DebugLog.warn('cart deep link failed:', err);
        });
    });
}

// Node test harness (node --test).
if (typeof module !== 'undefined' && module.exports) {
    module.exports = CartDeepLink;
}
