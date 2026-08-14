/**
 * SEARCH-CLICK-BEACON.JS
 * ======================
 * Fires `POST /api/search/click` when a customer clicks a product card on the
 * SEARCH RESULTS PAGE. Per search-click-tracking-fe-handoff-aug2026.
 *
 * WHY THIS EXISTS
 * ---------------
 * The backend already logs every search (query, result count, latency). What it
 * cannot see is WHICH result the customer chose, so search relevance can't be
 * measured against real behaviour. This beacon closes that gap and nothing else
 * — it is pure telemetry. Nothing on the page depends on it, and every failure
 * mode here is a silent no-op by design.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE THREE RULES THAT MAKE THIS CORRECT (read before editing)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 1. `Content-Type: application/json` IS MANDATORY, AND ITS FAILURE IS SILENT.
 *    `navigator.sendBeacon(url, string)` sends `text/plain`. Measured live
 *    2026-08-12: the endpoint then never parses the body and answers
 *    `400 VALIDATION_FAILED  "q" is required` — while `sendBeacon()` STILL
 *    RETURNS `true`. There is no client-side signal at all; a broken beacon is
 *    indistinguishable from a working one. Hence the Blob with an explicit
 *    type, and hence tests/search-click-beacon-aug2026.test.js pins that type
 *    rather than trusting a reviewer to notice.
 *
 * 2. ONLY CARDS THAT CAME FROM `/api/search/smart` MAY BEACON.
 *    The handoff is explicit: results page only — not the typeahead dropdown,
 *    not category grids, not /shop browsing. Two traps make that harder than
 *    "listen on the grid":
 *      (a) /search is a Vercel REWRITE to the shop HTML (vercel.json), so ONE
 *          controller (shop-page.js) serves both /search and /shop browsing.
 *      (b) The results page can SWAP its data source. On softMiss/hijack/
 *          exactMode, loadSearchResults unions /api/products?search= with
 *          /api/search/suggest and nulls `smartData` — while PRESERVING compat
 *          rows that did come from /smart. So a swapped page is a MIX, and a
 *          page-level "was this smart?" flag would be wrong either way.
 *    Therefore provenance is per-SKU: `arm()` is handed the exact set of SKUs
 *    the /smart response returned, and a card beacons IFF its SKU is in it.
 *    Non-/smart rows are excluded; preserved compat rows are correctly kept.
 *
 * 3. A CLICK MEANS "THE CUSTOMER CHOSE THIS RESULT" — i.e. navigation.
 *    Only `.product-card__link` (the anchor wrapping the card body) counts.
 *    Add to Cart, Contact us and the favourite button are NOT click-throughs
 *    and must not be logged. They're excluded structurally by the `closest()`
 *    test, not by relying on the `stopPropagation()` those buttons happen to
 *    call today.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * DELIBERATE DIFFERENCES FROM js/traffic-tracker.js (don't "fix" these)
 * ─────────────────────────────────────────────────────────────────────────────
 * • NO Do Not Track opt-out. traffic-tracker.js honours DNT because its payload
 *   is identity-bearing (visitor_id + session_id + UTMs). This payload carries
 *   NO identifiers — just q/sku/position/page — so it measures relevance in
 *   aggregate, not people. DNT-gating it would bias CTR-by-position INVISIBLY,
 *   because the backend cannot tell a suppressed click from an absent one.
 * • NO auth. The endpoint needs none, so there is no `await getAccessToken()`
 *   (traffic-tracker waits up to 1200ms for Auth to hydrate). Nothing async
 *   runs before dispatch — that is precisely what lets the request survive the
 *   navigation it races.
 * • NO gtag mirror. Search CTR belongs to the backend's search-quality report;
 *   a consent-gated GA4 copy would report a second, always-lower total.
 *
 * KNOWN GAP: right-click → "Open link in new tab" dispatches no click event and
 * cannot be observed, so CTR under-counts slightly. Inherent, not a bug.
 * ALSO: Vercel PREVIEW origins are not on the backend's CORS allow-list (403,
 * measured 2026-08-12), so beacons only land from production and localhost.
 *
 * Contract (verified live 2026-08-12 with malformed payloads only, so no rows
 * were written): q required 1-200 chars, sku required 1-100, position/page
 * optional numbers, 204 on success, 400 on malformed, 60/min/IP. Never retry.
 *
 * Pinned by tests/search-click-beacon-aug2026.test.js.
 * Live contract + CORS guard: npm run audit:searchclick
 */
'use strict';

(function () {
    const ENDPOINT = '/api/search/click';

    // Backend Joi limits, measured live. Over-length is a guaranteed 400, and
    // TRUNCATING q would attribute the click to a different query than the one
    // that ran — so an out-of-range payload is dropped, never repaired.
    const MAX_Q_LENGTH = 200;
    const MAX_SKU_LENGTH = 100;

    // Collapse an accidental double-click on the same card into one send. A
    // genuine re-click after this window still counts (the customer came back
    // and chose it again, which is real behaviour worth recording).
    const DEDUPE_WINDOW_MS = 1000;

    // The two search-results grids, in DOM order. `querySelectorAll` returns
    // document order, and #compatible-section precedes #genuine-section in
    // shop.html, so this yields the painted order across the whole page.
    // Scoped deliberately: `.product-card` also appears in the zero-results
    // recovery rails, which are NOT search results.
    const GRID_IDS = ['compatible-products', 'genuine-products'];
    const CARD_SELECTOR = '.product-card';
    const LINK_SELECTOR = '.product-card__link';

    // Armed state. `skus` is the /smart provenance allow-list (rule 2).
    let armed = null;
    let attached = false;
    let lastSend = { key: null, at: 0 };

    function log() {
        try {
            const d = (typeof window !== 'undefined' && window.DebugLog) || null;
            if (d && typeof d.warn === 'function') d.warn.apply(d, arguments);
        } catch (_) { /* logging must never break a click */ }
    }

    /**
     * ⚠️ `Config` IS NOT ON `window`. js/config.js declares it as a top-level
     * `const`, which lands in the global LEXICAL environment — reachable as a
     * bare identifier from another classic script, but `window.Config` is
     * `undefined`. Verified in the browser 2026-08-12; the first cut of this
     * file read `window.Config`, found nothing, and silently sent NOTHING. That
     * is the beacon's worst failure mode: armed, wired, zero requests, no error.
     *
     * So: bare identifier, exactly as js/traffic-tracker.js:84 does it, behind a
     * `typeof` guard because a bare name that has never been declared throws.
     * (`window.Config` is still tried first, harmlessly, in case config.js ever
     * starts exporting it — but the bare read is the one that works today.)
     *
     * Contrast `DebugLog` and `CompatSource`, which DO get an explicit
     * `window.X = X` in utils.js. Don't assume; check for the export line.
     */
    function apiBase() {
        try {
            if (typeof window !== 'undefined' && window.Config && window.Config.API_URL) {
                return window.Config.API_URL;
            }
        } catch (_) { /* fall through to the bare binding */ }
        try {
            if (typeof Config !== 'undefined' && Config && Config.API_URL) return Config.API_URL;
        } catch (_) { /* not loaded — nothing we can do */ }
        return '';
    }

    /**
     * Deliver the payload. Mirrors the proven transport in traffic-tracker.js:
     * sendBeacon with a typed Blob first (survives the navigation), falling back
     * to a keepalive fetch when sendBeacon is missing OR returns false — false
     * means the browser's beacon queue is full and the request was NOT queued,
     * which is the one beacon failure that IS observable.
     */
    function post(body) {
        const base = apiBase();
        if (!base) {
            log('SearchClickBeacon: no Config.API_URL — click not logged');
            return;
        }
        const url = base + ENDPOINT;
        try {
            // Its own try: a throwing sendBeacon (or a missing Blob) must still
            // fall through to fetch rather than losing the click silently.
            try {
                if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
                    // The type is load-bearing — see rule 1 at the top of this file.
                    const blob = new Blob([body], { type: 'application/json' });
                    // `false` means the beacon queue is full and NOTHING was
                    // queued — the one beacon failure that is observable.
                    if (navigator.sendBeacon(url, blob)) return;
                }
            } catch (_) { /* fall through to fetch */ }
            fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body,
                keepalive: true,
                credentials: 'omit',
            }).catch(() => { /* fire-and-forget: never retry, never surface */ });
        } catch (_) { /* analytics must never break navigation */ }
    }

    /**
     * The 1-based index of `card` across BOTH grids as currently painted.
     *
     * Read at click time rather than stamped at render time on purpose: the
     * grid is re-sorted and client-side filtered (in-stock, brand narrowing,
     * compatLast) after the cards exist, and it is fully re-rendered by
     * `container.innerHTML = ''`. A number captured at render would go stale;
     * live DOM order cannot. Row-break divs are skipped by CARD_SELECTOR.
     *
     * Per the contract this is the position WITHIN the current page — `page` is
     * reported alongside it, so it must not be offset by the page number.
     */
    function positionOf(card) {
        try {
            const cards = [];
            for (const id of GRID_IDS) {
                const grid = document.getElementById(id);
                if (!grid) continue;
                const found = grid.querySelectorAll(CARD_SELECTOR);
                for (let i = 0; i < found.length; i++) cards.push(found[i]);
            }
            const idx = cards.indexOf(card);
            return idx === -1 ? null : idx + 1;
        } catch (_) {
            return null;
        }
    }

    // True when `card` sits inside one of the two search-results grids. This is
    // what keeps the recovery rails and any future grid on the page out.
    function inSearchGrid(card) {
        for (const id of GRID_IDS) {
            const grid = document.getElementById(id);
            if (grid && grid.contains(card)) return true;
        }
        return false;
    }

    function report(sku, position) {
        if (!armed) return false;

        const q = armed.query;
        if (typeof q !== 'string' || q.length === 0) return false;
        if (q.length > MAX_Q_LENGTH) {
            // A hand-crafted ?q= can exceed the search input's maxlength=200.
            log('SearchClickBeacon: query over ' + MAX_Q_LENGTH + ' chars — click not logged');
            return false;
        }
        if (typeof sku !== 'string' || sku.length === 0 || sku.length > MAX_SKU_LENGTH) {
            log('SearchClickBeacon: unusable sku — click not logged', sku);
            return false;
        }

        const key = q + ' ' + sku + ' ' + String(position);
        const now = Date.now();
        if (lastSend.key === key && (now - lastSend.at) < DEDUPE_WINDOW_MS) return false;
        lastSend = { key: key, at: now };

        const payload = { q: q, sku: sku };
        if (typeof position === 'number' && position > 0) payload.position = position;
        if (typeof armed.page === 'number' && armed.page > 0) payload.page = armed.page;

        post(JSON.stringify(payload));
        return true;
    }

    // Shared by the click and auxclick handlers. Returns true when a beacon was
    // sent — used only by tests; the DOM handlers ignore it.
    function handleActivation(target) {
        try {
            if (!armed) return false;
            if (!target || typeof target.closest !== 'function') return false;

            // Rule 3, part one — any control INSIDE the card is not a
            // click-through. This has to be its own check because "Add to Cart"
            // and "Contact us" live INSIDE the anchor: shop-page.js keeps them
            // <button> elements precisely because a nested <a> would close the
            // outer .product-card__link, so a `closest(LINK_SELECTOR)` test
            // alone matches them and would log an add-to-cart as a click-through.
            // They do call stopPropagation() today, which would mask this in the
            // browser — that is exactly why the exclusion may not depend on it.
            if (target.closest('button')) return false;

            // Rule 3, part two — only the card's navigation anchor counts.
            const link = target.closest(LINK_SELECTOR);
            if (!link) return false;

            const card = link.closest(CARD_SELECTOR);
            if (!card || !inSearchGrid(card)) return false;

            const sku = card.getAttribute && card.getAttribute('data-sku');
            if (!sku) return false;

            // Rule 2 — per-SKU /smart provenance.
            if (!armed.skus || !armed.skus.has(sku)) return false;

            return report(sku, positionOf(card));
        } catch (_) {
            // A throw here would run inside the click that is navigating away.
            return false;
        }
    }

    function onClick(e) {
        // Covers left-click, Cmd/Ctrl/Shift+click (new tab/window) and keyboard
        // Enter on the focused anchor — Enter dispatches a click.
        handleActivation(e && e.target);
    }

    function onAuxClick(e) {
        // Middle-click opens a new tab but does NOT emit `click`; it emits
        // `auxclick` with button 1. Button 2 is the context menu — the menu's
        // "Open link in new tab" is unobservable, so right-click never counts.
        if (!e || e.button !== 1) return;
        handleActivation(e.target);
    }

    /**
     * Install the delegated listeners. Idempotent — safe to call on every
     * render. Bubble phase on the grid containers: the containers outlive the
     * `innerHTML = ''` re-render of their children and survive a bfcache
     * restore, so this runs exactly once per page lifetime.
     */
    function attach() {
        if (attached) return;
        try {
            for (const id of GRID_IDS) {
                const grid = document.getElementById(id);
                if (!grid) continue;
                grid.addEventListener('click', onClick);
                grid.addEventListener('auxclick', onAuxClick);
            }
            attached = true;
        } catch (_) { /* no listeners = no beacons, never an error */ }
    }

    /**
     * Arm for one rendered page of search results.
     *
     * @param {object} opts
     * @param {string} opts.query - The query EXACTLY as sent to /search/smart.
     *   Not the backend's corrected form: CTR must be attributed to the query
     *   that actually ran, and /smart returns no echo of it anyway.
     * @param {number} opts.page  - The pagination page these cards are on.
     * @param {Array|Set} opts.skus - SKUs present in the /smart response, taken
     *   before reconciliation can null the envelope (rule 2).
     */
    function arm(opts) {
        try {
            const o = opts || {};
            const skus = new Set();
            if (o.skus && typeof o.skus.forEach === 'function') {
                o.skus.forEach((s) => { if (typeof s === 'string' && s) skus.add(s); });
            }
            if (skus.size === 0) { armed = null; return; }
            armed = {
                query: typeof o.query === 'string' ? o.query : '',
                page: typeof o.page === 'number' && o.page > 0 ? o.page : 1,
                skus: skus,
            };
            attach();
        } catch (_) {
            armed = null;
        }
    }

    // Disarm whenever the page is not showing /smart-backed search results, so
    // /shop browsing and every other drilldown level can never beacon. Called
    // unconditionally at the top of loadCurrentLevel — armed-off is the default.
    function disarm() {
        armed = null;
    }

    if (typeof window !== 'undefined') {
        window.SearchClickBeacon = {
            arm: arm,
            disarm: disarm,
            attach: attach,
            // Test seams — not a public surface. Product code calls arm/disarm.
            _handleActivation: handleActivation,
            _positionOf: positionOf,
            _isArmed: () => !!armed,
            _reset: () => { armed = null; attached = false; lastSend = { key: null, at: 0 }; },
        };
    }
})();
