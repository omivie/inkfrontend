/**
 * PRINTER CONTEXT
 * ===============
 * Carries "which printer was the customer shopping for" from the page that
 * genuinely knows it, through the cart, to the order payload.
 *
 * WHY (data-tracking-capture-fe-handoff-aug2026 §1.2)
 * --------------------------------------------------
 * Which printer ecosystem a customer belongs to is only derivable server-side
 * through `product_compatibility`, which is many-to-many BY DESIGN — one
 * cartridge fits dozens of printers, so the answer is genuinely ambiguous. The
 * frontend already holds the unambiguous answer whenever the shopper arrived via
 * the ink finder, a `/shop?printer_slug=` hub, or a PDP opened with
 * `?printer_slug=`. That chain existed already and died at `Cart.addItem`:
 * `product-detail-page.js` reads the slug, uses it for the "bought for this
 * printer" proof line, and then drops it on the floor.
 *
 * THE ONE RULE, AND WHY THIS IS A MODULE
 * --------------------------------------
 * **Send it only when you actually know it.** An unresolvable slug records
 * nothing, but a GUESSED one silently corrupts the printer-ecosystem analysis
 * the field exists to enable — and a wrong ecosystem is not a smaller version of
 * the truth. Never derive a slug from a brand, a `printer_model` free-text
 * param, a compatibility list, or a product name. Only a real `printer_slug`
 * that a printer-scoped URL put in front of us counts.
 *
 * That rule is easy to state and easy to erode across six call sites, so it
 * lives here, once, with the storage and the ambiguity handling.
 *
 * WHY STORAGE AT ALL — the field cannot live on the cart line alone
 * ----------------------------------------------------------------
 * `Cart.addItem` pushes the line, then calls `loadFromServer()`, and
 * `_parseServerCart` rebuilds every line from scratch out of the server's cart
 * row. The server cart has no printer column, so a field written onto the line
 * is gone milliseconds after it is set — and would have looked like it worked in
 * any test that did not round-trip. This map is the side-channel that survives
 * that, keyed by the cart's own composite line key.
 *
 * AMBIGUITY IS RECORDED, NOT RESOLVED
 * -----------------------------------
 * If the same line is added twice from two different printer contexts, we do not
 * pick one. The line is marked ambiguous and reports NO slug from then on. Two
 * answers is not more information than one — it is a coin toss with a database
 * row attached.
 *
 * Global: `window.PrinterContext` (a real window export — grep the assignment at
 * the bottom before writing a `window.PrinterContext?.` guard elsewhere, because
 * `Config`, `Security` and `Shipping` in this same directory are bare consts
 * whose window guards were silent off-switches: ERR-156 / ERR-167).
 */
const PrinterContext = {
    STORAGE_KEY: 'ink_printer_context',

    /** Keep the map small and self-expiring; a stale printer is worse than none. */
    MAX_ENTRIES: 60,
    TTL_MS: 30 * 24 * 60 * 60 * 1000, // 30 days

    /**
     * Printer slugs are lowercase, hyphen-joined, alphanumeric — e.g.
     * `brother-mfc-j5740dw`. Anything else is not a slug we were handed by a
     * printer URL, so it is not something we know.
     */
    SLUG_PATTERN: /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    MAX_SLUG_LENGTH: 120,

    /**
     * The slug, or null. Null is the honest answer for absent, malformed,
     * wrong-cased, over-long, or non-string input — never a repaired guess.
     * @param {*} slug
     * @returns {string|null}
     */
    normalize(slug) {
        if (typeof slug !== 'string') return null;
        const trimmed = slug.trim();
        if (!trimmed || trimmed.length > this.MAX_SLUG_LENGTH) return null;
        if (!this.SLUG_PATTERN.test(trimmed)) return null;
        return trimmed;
    },

    /** @returns {object} the raw map, always an object, never throws. */
    _read() {
        try {
            const raw = localStorage.getItem(this.STORAGE_KEY);
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
        } catch (_) {
            return {};
        }
    },

    _write(map) {
        try {
            const now = Date.now();
            const entries = Object.keys(map)
                .filter((k) => map[k] && typeof map[k] === 'object' && (now - (map[k].at || 0)) < this.TTL_MS)
                .sort((a, b) => (map[b].at || 0) - (map[a].at || 0))
                .slice(0, this.MAX_ENTRIES);
            const trimmed = {};
            entries.forEach((k) => { trimmed[k] = map[k]; });
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(trimmed));
        } catch (_) {
            // Private browsing / quota. The annotation is a nice-to-have on an
            // analytics field; it must never break an add-to-cart.
        }
    },

    /**
     * Annotate a cart line with the printer the shopper was browsing.
     *
     * A second, DIFFERENT slug for the same line marks it ambiguous rather than
     * overwriting — see the header. A repeat of the same slug is a no-op, and a
     * null slug never clears an answer we already had (arriving at a line from a
     * printer-less page does not un-know the printer).
     *
     * @param {string} key  Cart composite line key (`source:identifier`).
     * @param {string|null} slug
     */
    remember(key, slug) {
        const clean = this.normalize(slug);
        if (!key || !clean) return;
        const map = this._read();
        const existing = map[key];
        if (existing && existing.ambiguous) return;
        if (existing && existing.slug && existing.slug !== clean) {
            map[key] = { slug: null, ambiguous: true, at: Date.now() };
        } else {
            map[key] = { slug: clean, ambiguous: false, at: Date.now() };
        }
        this._write(map);
    },

    /** Drop one line's annotation (the line was removed from the cart). */
    forget(key) {
        if (!key) return;
        const map = this._read();
        if (!(key in map)) return;
        delete map[key];
        this._write(map);
    },

    /**
     * The known printer for a line, or null.
     * Null covers unknown, expired and ambiguous alike — every one of which
     * means "do not send a printer for this line".
     * @returns {string|null}
     */
    slugFor(key) {
        if (!key) return null;
        const entry = this._read()[key];
        if (!entry || entry.ambiguous) return null;
        if ((Date.now() - (entry.at || 0)) >= this.TTL_MS) return null;
        return this.normalize(entry.slug);
    },

    /**
     * Re-attach `printer_slug` to freshly parsed cart lines.
     *
     * Called after `_parseServerCart`, which rebuilds every line from the server
     * row and therefore drops any client-only field. Without this the annotation
     * is written and then destroyed by `addItem`'s own `loadFromServer()` call,
     * and the whole feature reports nothing while looking wired.
     *
     * @param {Array} items cart lines, mutated in place
     * @param {function} [keyOf] how to derive a line's key (defaults to `item.key`)
     * @returns {Array} the same array
     */
    applyTo(items, keyOf) {
        if (!Array.isArray(items)) return items;
        items.forEach((item) => {
            if (!item) return;
            const key = typeof keyOf === 'function' ? keyOf(item) : item.key;
            const slug = this.slugFor(key);
            if (slug) item.printer_slug = slug;
        });
        return items;
    },

    /**
     * The order-level `printer_slug`, or null.
     *
     * The backend treats this as a fallback for any line without its own, so it
     * is only safe when the cart speaks with one voice: EXACTLY ONE distinct
     * known slug across all lines. Zero known slugs → null. Two or more → null,
     * because applying either one to the lines that lack it would be a guess,
     * and per-item values already carry the part we do know.
     *
     * @param {Array} items
     * @returns {string|null}
     */
    orderLevel(items) {
        if (!Array.isArray(items)) return null;
        const distinct = [];
        items.forEach((item) => {
            const slug = item && this.normalize(item.printer_slug);
            if (slug && distinct.indexOf(slug) === -1) distinct.push(slug);
        });
        return distinct.length === 1 ? distinct[0] : null;
    },

    /**
     * Read the printer the CURRENT page is scoped to, from the URL only.
     *
     * Deliberately narrow. `?printer_model=` and `?printer_brand=` are also in
     * the shop's URL vocabulary and are NOT slugs; reading them here is exactly
     * the guess this module exists to prevent.
     *
     * @param {string} [search] defaults to location.search
     * @returns {string|null}
     */
    fromLocation(search) {
        try {
            const qs = typeof search === 'string'
                ? search
                : (typeof location !== 'undefined' ? location.search : '');
            const params = new URLSearchParams(qs || '');
            return this.normalize(params.get('printer_slug'));
        } catch (_) {
            return null;
        }
    }
};

if (typeof window !== 'undefined') window.PrinterContext = PrinterContext;
if (typeof module !== 'undefined' && module.exports) module.exports = PrinterContext;
