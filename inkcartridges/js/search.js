/**
 * SEARCH.JS — Smart Autocomplete
 * ================================
 * Card-grid typeahead dropdown backed by GET /api/search/smart.
 *
 * ⚠️ NOT /api/search/suggest. It was, once; the migration to /smart is
 * described at ENDPOINT below. This header said "backed by GET
 * /api/search/suggest" until 2026-08-04, and the backend read it, concluded
 * the dropdown fed off /suggest, and spent a commit (`99d798b`) adding
 * ribbon "FOR USE IN" blob search to /suggest + /autocomplete to fix a
 * dropdown gap that /smart had already closed on 2026-07-30. That change was
 * not harmless here — /suggest is this app's results-page literal CONTROL
 * SET, and widening it broke the "Fits <model>" chip (ERR-144). If you
 * repoint this file at a different endpoint, fix this comment in the same
 * edit, and check API.searchSuggest in js/api.js, which is a DIFFERENT
 * consumer with a different job.
 *
 * Public API: window.SmartSearch.init(form, input)
 *   main.js wires this to every .search-form in the DOM.
 */

(function () {
    'use strict';

    // /smart is the canonical search endpoint the results page uses. It returns
    // the full enriched envelope (products[] with retail_price/color/source/
    // series_codes/discounts, plus matched_printer + did_you_mean) and accepts
    // limit up to 40. The literal /suggest endpoint we used previously is
    // hard-capped by the backend at 24 — re-measured 2026-08-04: limit=24 gives
    // 24 rows and limit=25 is a hard `400 Validation failed` — so it cannot
    // surface the 40 products we now want, and asking anyway is an error rather
    // than a short list; driving the dropdown off /smart also makes it group and render
    // identically to the product/shop grid (byCodeThenColor + row-breaks below),
    // and it is why the dropdown already showed ribbon "for use in" matches with
    // their "Fits <model>" chip from 2026-07-30 (ERR-133), months before
    // /suggest learned to.
    const ENDPOINT = '/api/search/smart';
    // 250ms debounce — backend bucket is 120 req/min/IP; a fast typer hammering
    // backspace at <250ms intervals can still trip it, so we err on the safe side.
    const DEBOUNCE_MS = 250;
    const MIN_QUERY_LENGTH = 2;
    const LIMIT = 40;
    const SKELETON_DELAY_MS = 150;
    const RECENT_KEY = 'recentSearches';
    const RECENT_MAX = 5;
    const PLACEHOLDER_IMG = '/assets/images/placeholder-product.svg';

    // Trending printer chips. Sourced from GET /api/printers/trending, which ranks
    // by recent search-match + printer-page pageview signal (last 30 days). The
    // hardcoded list below is a hard fallback for first paint / offline / fetch
    // failure; the IIFE replaces it with the real list and caches for 1 h in
    // localStorage so we don't hammer the API on every page load.
    const FALLBACK_TRENDING_MODELS = [
        { name: 'Brother MFC-L2750DW',   slug: 'brother-mfc-l2750dw' },
        { name: 'HP OfficeJet Pro 9720', slug: 'hp-officejet-pro-9720' },
        { name: 'Canon PIXMA TS3560',    slug: 'canon-pixma-ts3560' },
        { name: 'Epson EcoTank ET-2850', slug: 'epson-ecotank-et-2850' },
        { name: 'Brother HL-L2460DW',    slug: 'brother-hl-l2460dw' },
    ];
    let TRENDING_MODELS = FALLBACK_TRENDING_MODELS;
    const TRENDING_CACHE_KEY = 'trendingPrinters';
    const TRENDING_CACHE_TTL_MS = 60 * 60 * 1000;

    (async () => {
        try {
            const cached = JSON.parse(localStorage.getItem(TRENDING_CACHE_KEY) || 'null');
            if (cached && Array.isArray(cached.v) && cached.v.length && (Date.now() - cached.t) < TRENDING_CACHE_TTL_MS) {
                TRENDING_MODELS = cached.v;
                return;
            }
            const base = (typeof Config !== 'undefined' && Config.API_URL) ? Config.API_URL : '';
            // credentials: 'omit' is explicit (ERR-124) — public catalog read, must stay
            // eligible for the Cloudflare edge cache rather than rely on the default.
            const res = await fetch(`${base}/api/printers/trending?limit=5`, { credentials: 'omit' });
            const json = await res.json();
            if (json && json.ok && json.data && Array.isArray(json.data.printers) && json.data.printers.length) {
                TRENDING_MODELS = json.data.printers;
                localStorage.setItem(TRENDING_CACHE_KEY, JSON.stringify({ t: Date.now(), v: TRENDING_MODELS }));
            }
        } catch (_) { /* keep fallback */ }
    })();

    let _instanceId = 0;

    function esc(s) {
        return (typeof Security !== 'undefined' && Security.escapeHtml)
            ? Security.escapeHtml(s == null ? '' : String(s))
            : String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function escAttr(s) {
        return (typeof Security !== 'undefined' && Security.escapeAttr)
            ? Security.escapeAttr(s == null ? '' : String(s))
            : esc(s);
    }
    function priceNZD(n) {
        if (typeof formatPrice === 'function') return formatPrice(n);
        const v = Number(n);
        if (!isFinite(v)) return '';
        try { return new Intl.NumberFormat('en-NZ', { style: 'currency', currency: 'NZD' }).format(v); }
        catch (_) { return '$' + v.toFixed(2); }
    }

    // Term highlighting per spec §1.2 — wrap each whitespace-separated token
    // in <mark>. Caller is responsible for escaping `text` first; the regex
    // tokens are escaped inline so query text can never break out as HTML.
    function highlightTokens(escapedHtml, query) {
        if (!query) return escapedHtml;
        const tokens = String(query).trim().split(/[\s\-/]+/).filter(Boolean);
        if (!tokens.length) return escapedHtml;
        let html = escapedHtml;
        for (const t of tokens) {
            const safe = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            try {
                html = html.replace(new RegExp(`(${safe})`, 'gi'), '<mark class="smart-ac__mark">$1</mark>');
            } catch (_) { /* malformed regex — skip this token */ }
        }
        return html;
    }

    function getRecent() {
        try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); }
        catch (_) { return []; }
    }
    function saveRecent(query) {
        const q = (query || '').trim();
        if (q.length < MIN_QUERY_LENGTH) return;
        try {
            const current = getRecent().filter(x => x !== q);
            const next = [q, ...current].slice(0, RECENT_MAX);
            localStorage.setItem(RECENT_KEY, JSON.stringify(next));
        } catch (_) { /* ignore quota */ }
    }

    function adaptForCard(p) {
        // Autocomplete payload uses `price`; product-card template expects `retail_price`.
        // Also supply sensible defaults for fields the card reads but autocomplete omits.
        return Object.assign({}, p, {
            retail_price: p.retail_price != null ? p.retail_price : p.price,
            sku: p.sku || '',
            // ONE brand-source vocabulary (BrandSource, utils.js, ERR-157).
            // The old expression invented 'compatible' for a row carrying
            // neither field, because `undefined ? … : …` takes the false
            // branch. /api/search/suggest ships `is_genuine` as a real boolean
            // on every row and /api/search/smart ships `source` (both verified
            // live 2026-08-12), so this resolves identically for real payloads
            // — it just stops guessing when neither is there.
            source: BrandSource.of(p),
            brand: p.brand || null,
            category: p.category || null,
        });
    }

    function productHref(p) {
        // Prefer backend-supplied canonical_url (when the suggest endpoint adds
        // it). Reduce absolute URLs to a path so the SPA handles navigation
        // without a backend round-trip.
        if (p.canonical_url) {
            try { return new URL(p.canonical_url).pathname; }
            catch (_) { return p.canonical_url; }
        }
        const slug = p.slug || '';
        // Spec payload has no SKU; fall back to slug-only when missing.
        const sku = p.sku || '';
        if (slug && sku) return `/products/${encodeURIComponent(slug)}/${encodeURIComponent(sku)}`;
        if (sku) return `/p/${encodeURIComponent(sku)}`;
        return `/shop?q=${encodeURIComponent(p.name || '')}`;
    }

    // Named for the endpoint it actually calls. It was `fetchSuggest` until
    // 2026-08-04 — a name left over from the pre-/smart dropdown, and half the
    // reason the backend misidentified this surface's feed (ERR-144).
    async function fetchSmart(query, signal) {
        const base = (typeof Config !== 'undefined' && Config.API_URL) ? Config.API_URL : '';
        // Admin mirror (ERR-234). This is the header dropdown — the surface the
        // owner most wants an admin-only product to appear on — and it is a raw
        // fetch that never enters API.request, so it has to route itself. The
        // fallback keeps the public path when api.js has not loaded yet.
        const path = `${ENDPOINT}?q=${encodeURIComponent(query)}&limit=${LIMIT}`;
        const route = (typeof API !== 'undefined' && typeof API._catalogRoute === 'function')
            ? API._catalogRoute(path)
            : { endpoint: path, anonymous: true };
        const plain = `${base}${route.endpoint}`;
        // ?sid=/?vid= — the analytics join key (data-tracking-capture aug2026
        // §1.1). This is the highest-volume search surface on the site, and it
        // is a raw fetch that never enters API.request, so it has to ask for the
        // ids itself. `window.` is correct here: TrafficTracker really is on
        // window, unlike `Config` (ERR-156). Returns the URL untouched under
        // DNT, on /admin, or before the tracker has loaded — never a blank param.
        const url = (typeof window !== 'undefined' && window.TrafficTracker && window.TrafficTracker.identifyUrl)
            ? window.TrafficTracker.identifyUrl(plain)
            : plain;
        // Public search read — cookies explicitly omitted (ERR-124). The admin
        // mirror authenticates by bearer token instead; cookies stay off both.
        const headers = {};
        if (!route.anonymous && typeof API !== 'undefined' && typeof API.getToken === 'function') {
            try {
                const t = await API.getToken();
                if (t) headers['Authorization'] = `Bearer ${t}`;
            } catch (_) { /* fall through tokenless; the mirror will 401 */ }
        }
        // X-Session-Id / X-Visitor-Id as well as the ?sid=/?vid= above.
        //
        // The backend's CORS allow-list gained both on 2026-09-08 (verified
        // 2026-09-09 with a negative control — see api.js request()). This
        // surface is a raw fetch that never enters API.request, so the
        // per-helper `identify: true` enrolment there does not reach it and it
        // has to ask for itself, exactly as it already does for the URL params.
        //
        // THE COST, MEASURED, because a header on a GET is never free: it makes
        // the request non-simple, so the browser preflights it, and the
        // CORS-preflight cache is keyed by full URL — a typeahead query is a new
        // URL every time, so effectively every search pays one. Measured against
        // api.inkcartridges.co.nz on 2026-09-09: OPTIONS ~280ms against a GET
        // that is already ~3.0s, so ~9%. That is the trade, and it is one line
        // to reverse if it ever stops being worth it.
        if (typeof window !== 'undefined' && window.TrafficTracker && window.TrafficTracker.identifyHeaders) {
            window.TrafficTracker.identifyHeaders(headers);
        }
        const res = await fetch(url, { signal, credentials: 'omit', headers });
        let json = null;
        try { json = await res.json(); } catch (_) { /* non-JSON body — leave null */ }
        if (!res.ok || !json || !json.ok) {
            const err = new Error((json && json.error && json.error.message) || 'Search failed');
            err.status = res.status;
            err.code = (json && json.error && json.error.code) || null;
            throw err;
        }
        const data = json.data || {};
        // /smart returns the result set under `products` (the literal /suggest
        // endpoint we used previously returned `suggestions`). Map it into the
        // same slot so renderResults — which reads `data.suggestions` — is
        // untouched; fall back to `suggestions` for resilience if the envelope
        // shape changes.
        const items = Array.isArray(data.products)
            ? data.products
            : (Array.isArray(data.suggestions) ? data.suggestions : []);
        return {
            suggestions: items,
            matched_printer: data.matched_printer || null,
            did_you_mean: data.did_you_mean || null,
        };
    }

    function createInstance() {
        const id = _instanceId++;
        const listboxId = `smart-ac-listbox-${id}`;

        const state = {
            form: null,
            input: null,
            dropdown: null,
            list: null,
            live: null,
            debounceTimer: null,
            skeletonTimer: null,
            abort: null,
            results: [],
            highlightIndex: -1,
            isOpen: false,
            mode: 'empty', // 'empty' | 'skeleton' | 'results' | 'no-results' | 'error'
            // PHONE SEGMENTED CONTROL (ERR-238). Which source's panel is showing
            // below 700px: 'compatible' | 'genuine' | null (null = not a split
            // result, so there are no tabs and both sections are visible).
            //
            // It lives HERE, on the instance, and not in the markup, because
            // renderResults() replaces state.list.innerHTML on every debounced
            // keystroke. Read off the old DOM it would reset to Compatible
            // mid-word, which is the one thing a shopper would notice.
            activeSource: null,
            // Painted cards per source, so switching tabs can re-point
            // state.results at the cards the shopper can actually SEE. Arrowing
            // into a hidden section and pressing Enter would open a product that
            // is not on screen — the ERR-144 failure in a new costume.
            renderedBySource: { compatible: [], genuine: [] },
            // The full painted order, both sections. Kept because widening the
            // viewport back past 699px has to restore it — recomputing from the
            // DOM would work until the day the DOM and the payload disagree, and
            // that disagreement is exactly what the keyboard-nav contract exists
            // to prevent.
            renderedAll: [],
            _outsideHandler: null,
        };

        function positionDropdown() {
            if (!state.input || !state.dropdown) return;
            const formRect = state.form.getBoundingClientRect();
            const inputRect = state.input.getBoundingClientRect();
            // "Mobile" = below the tablet breakpoint (Config.BREAKPOINTS, the
            // JS mirror of the css/base.css header breakpoint system). From
            // 768px up the form itself is wide (full-width until 1100, inline
            // after), so the form-anchored desktop math lays out correctly.
            const isMobile = window.innerWidth <
                ((typeof Config !== 'undefined' && Config.BREAKPOINTS && Config.BREAKPOINTS.tablet) || 768);
            // On mobile, center the dropdown across the viewport (not the form,
            // which is a narrow 260px centered box). 16px side margins.
            //
            // On desktop the search input is far narrower than a row of product
            // cards, so we widen the panel to a comfortable fixed width (clamped
            // to the viewport) and keep it anchored under the input — shifting
            // left only as much as needed to stay on-screen. 1120px carries six
            // cards across: either one six-up row, or two three-up columns when
            // both a Compatible and a Genuine section came back.
            const DESKTOP_PANEL = 1120;
            const width = isMobile
                ? (window.innerWidth - 32)
                : Math.min(DESKTOP_PANEL, window.innerWidth - 32);
            const left = isMobile
                ? 16
                : Math.min(Math.max(16, Math.round(formRect.left)), window.innerWidth - width - 16);
            state.dropdown.style.setProperty('--smart-ac-left', `${left}px`);
            state.dropdown.style.setProperty('--smart-ac-width', `${width}px`);

            // Vertical placement (ERR-217). This used to be two lines —
            // `top = inputRect.bottom + 6` and `max-height = max(280, innerHeight
            // - top - 16)` — which is correct for the ONLY search box that
            // existed when it was written: the one in the header, which always
            // has ~630px of clear viewport under it. 404.html's in-page box sits
            // 649px down an 800px window, so "fill the space below" meant 129px,
            // the 280px floor took over, and the panel hung 135px BELOW THE FOLD
            // with the product titles and prices in the part you cannot reach.
            // A floor that is larger than the space it is floored into is not a
            // fallback, it is an off-screen panel.
            //
            // So: prefer below (byte-identical numbers for the header box), flip
            // above when below is cramped and above is roomier, and never return
            // a box that leaves the viewport. Flipping anchors by `bottom`, not
            // by `top` minus a guessed height, so the panel stays glued to the
            // input when the content is shorter than the cap.
            const GAP = 6;    // input-to-panel gap
            const EDGE = 16;  // viewport margin, top and bottom
            /* Two card rows + the sticky View-all footer. On a phone the
               segmented control adds a tab bar above them, so the same content
               needs more room and a gap that "fits" 280px would in fact hold the
               tab bar, one row and the footer.
               MEASURED off the rendered box, never a constant: a number written
               here to reserve space for something that has a height is a
               measurement somebody declined to take (ERR-189/196). offsetHeight
               is 0 when the tab bar is display:none above 700px, which is
               exactly right — no tabs, no reservation. */
            const tablist = state.list && state.list.querySelector('.smart-ac__tablist');
            const PREFERRED = 280 + (tablist ? tablist.offsetHeight : 0);

            // A panel flipped above must stop below the sticky header, which
            // paints over it (header z-index:200 vs dropdown z-index:50 —
            // probed with elementFromPoint, not assumed). Math.max(0, …) covers
            // the header having scrolled away. The typeof guard is load-bearing:
            // tests/search-dropdown-*.test.js evaluate this function body in
            // node with an injected scope.
            let headerBottom = 0;
            if (typeof document !== 'undefined' && document.querySelector) {
                const header = document.querySelector('.site-header');
                if (header) headerBottom = Math.max(0, Math.round(header.getBoundingClientRect().bottom));
            }

            // Round the ANCHOR first and derive the space from it, so that
            // `anchor + max-height` lands exactly EDGE px inside the viewport.
            // Rounding the two independently lets them disagree by a pixel, and
            // the pixel they disagree by is always the one past the fold.
            const topIfBelow = Math.round(inputRect.bottom + GAP);
            const bottomIfAbove = Math.round(window.innerHeight - inputRect.top + GAP);
            const spaceBelow = window.innerHeight - topIfBelow - EDGE;
            const spaceAbove = window.innerHeight - bottomIfAbove - headerBottom - EDGE;
            // Below unless above is genuinely better: only when below cannot hold
            // a usable panel AND above holds more. Where both are cramped we take
            // the larger and let the panel scroll — a short scrollable panel is
            // honest, an off-screen one is not.
            const placeBelow = spaceBelow >= PREFERRED || spaceBelow >= spaceAbove;

            if (placeBelow) {
                const top = topIfBelow;
                state.dropdown.classList.remove('is-above');
                state.dropdown.style.removeProperty('--smart-ac-bottom');
                state.dropdown.style.setProperty('--smart-ac-top', `${top}px`);
                state.dropdown.style.setProperty('--smart-ac-max-height', `${Math.max(0, spaceBelow)}px`);
            } else {
                // positionDropdown() re-runs on resize and scroll, so the flip
                // has to be reversible — hence remove/removeProperty above.
                const bottom = bottomIfAbove;
                state.dropdown.classList.add('is-above');
                state.dropdown.style.removeProperty('--smart-ac-top');
                state.dropdown.style.setProperty('--smart-ac-bottom', `${bottom}px`);
                state.dropdown.style.setProperty('--smart-ac-max-height', `${Math.max(0, spaceAbove)}px`);
            }
        }

        function open() {
            if (state.isOpen) return;
            state.isOpen = true;
            state.dropdown.classList.add('is-open');
            state.input.setAttribute('aria-expanded', 'true');
            positionDropdown();
        }
        function close() {
            if (!state.isOpen) return;
            state.isOpen = false;
            state.dropdown.classList.remove('is-open');
            state.input.setAttribute('aria-expanded', 'false');
            state.input.removeAttribute('aria-activedescendant');
            state.highlightIndex = -1;
            // A new session starts on Compatible. Deliberately NOT reset in
            // onInput/runSearch — see state.activeSource.
            state.activeSource = null;
        }

        /* Below this width the two sources are a segmented control over ONE
           full-width list instead of two side-by-side columns. 699 is not a new
           number: it is the boundary search.css already measured for this panel
           and pages.css now uses for the results grid, so the two surfaces step
           together. */
        const SEGMENTED_MQ = '(max-width: 699px)';
        function isSegmented() {
            return !!state.activeSource
                && typeof window.matchMedia === 'function'
                && window.matchMedia(SEGMENTED_MQ).matches;
        }

        /**
         * Show the selected source (segmented, phone) or both (columns, wider),
         * then re-tag the cards and re-point state.results at what is VISIBLE.
         *
         * state.results must always be the cards the shopper can see, in paint
         * order, because setActive(i) highlights DOM card i while Enter
         * navigates to state.results[i]. Hiding a section without re-pointing it
         * would let an arrow key highlight nothing and Enter open a product that
         * is not on screen — which is ERR-144 again, in a new costume.
         *
         * The inactive section is hidden with the `hidden` ATTRIBUTE rather than
         * a CSS class: it has to leave the a11y tree and the tab order too, not
         * just the paint.
         */
        function applyActiveSource() {
            const wrap = state.list.querySelector('.smart-ac__sections');
            const segmented = isSegmented();
            if (wrap) {
                wrap.setAttribute('data-active-source', segmented ? state.activeSource : '');
                wrap.querySelectorAll('.smart-ac__section').forEach((sec) => {
                    const mine = sec.getAttribute('data-source');
                    if (segmented && mine !== state.activeSource) sec.hidden = true;
                    else sec.hidden = false;
                });
            }
            state.list.querySelectorAll('.smart-ac__tab').forEach((t) => {
                const on = t.getAttribute('data-source') === state.activeSource;
                t.setAttribute('aria-selected', String(on && segmented));
                t.setAttribute('tabindex', on ? '0' : '-1');
            });
            state.results = segmented
                ? (state.renderedBySource[state.activeSource] || [])
                : state.renderedAll;
            let i = 0;
            state.list.querySelectorAll('.smart-ac__section').forEach((sec) => {
                if (sec.hidden) {
                    // Strip the nav attributes from cards nobody can reach, so a
                    // stale data-index can never be arrowed onto.
                    sec.querySelectorAll('.product-card').forEach((card) => {
                        card.removeAttribute('data-index');
                        card.removeAttribute('role');
                        card.removeAttribute('aria-selected');
                    });
                    return;
                }
                sec.querySelectorAll('.product-card').forEach((card) => {
                    card.setAttribute('role', 'option');
                    card.setAttribute('aria-selected', 'false');
                    card.setAttribute('data-index', String(i));
                    card.id = `smart-ac-option-${id}-${i}`;
                    i++;
                });
            });
            state.highlightIndex = -1;
            state.input.removeAttribute('aria-activedescendant');
        }

        /** Switch tabs: re-show, re-tag, re-measure, and say what happened. */
        function setActiveSource(source) {
            if (!source || source === state.activeSource) return;
            if (!state.renderedBySource[source] || !state.renderedBySource[source].length) return;
            state.activeSource = source;
            applyActiveSource();
            // Content height changed, and when the panel is placed ABOVE the
            // input its anchor changes with it.
            positionDropdown();
            const n = state.renderedBySource[source].length;
            setLive(`Showing ${n} ${source} result${n === 1 ? '' : 's'}`);
        }

        function setActive(i) {
            state.highlightIndex = i;
            const cards = state.list.querySelectorAll('.product-card[data-index]');
            cards.forEach((c, idx) => {
                const on = idx === i;
                c.classList.toggle('is-highlighted', on);
                c.setAttribute('aria-selected', on ? 'true' : 'false');
            });
            if (i >= 0 && cards[i]) {
                state.input.setAttribute('aria-activedescendant', `smart-ac-option-${id}-${i}`);
                cards[i].scrollIntoView({ block: 'nearest' });
            } else {
                state.input.removeAttribute('aria-activedescendant');
            }
        }

        function renderEmpty() {
            state.mode = 'empty';
            state.results = [];
            state.renderedAll = [];
            state.renderedBySource = { compatible: [], genuine: [] };
            state.activeSource = null;
            state.highlightIndex = -1;
            const recent = getRecent();

            const chip = (q) => `<button type="button" class="smart-ac__chip" data-chip="${escAttr(q)}">${esc(q)}</button>`;

            const recentSection = recent.length
                ? `<div class="smart-ac__empty-section">
                       <div class="smart-ac__empty-header">
                           <h4 class="smart-ac__empty-title">Recent searches</h4>
                           <button type="button" class="smart-ac__clear-recent" data-clear-recent aria-label="Clear recent searches">Clear</button>
                       </div>
                       <div class="smart-ac__chips">${recent.map(chip).join('')}</div>
                   </div>`
                : '';

            // brand_slug is forward-compat: when the trending API starts
            // including it, the chip click handler will build the canonical
            // /shop?brand=&printer_slug= URL automatically. Until then it's
            // an empty data attribute and the chip falls back to the
            // documented unbranded form via buildPrinterUrl(allowUnbranded).
            const printerChip = (p) => {
                const brandSlug = p.brand_slug || (p.brand && p.brand.slug) || '';
                return `<button type="button" class="smart-ac__chip"`
                    + ` data-printer-slug="${escAttr(p.slug)}"`
                    + ` data-printer-name="${escAttr(p.name)}"`
                    + ` data-printer-brand-slug="${escAttr(brandSlug)}"`
                    + `>${esc(p.name)}</button>`;
            };
            const trendingSection = `
                <div class="smart-ac__empty-section">
                    <h4 class="smart-ac__empty-title">Trending printers</h4>
                    <div class="smart-ac__chips">${TRENDING_MODELS.map(printerChip).join('')}</div>
                </div>`;

            state.list.innerHTML = `<div class="smart-ac__empty">${recentSection}${trendingSection}</div>`;
            state.list.setAttribute('role', 'group');
            setLive('');
        }

        function renderSkeleton() {
            state.mode = 'skeleton';
            state.results = [];
            state.renderedAll = [];
            state.renderedBySource = { compatible: [], genuine: [] };
            state.activeSource = null;
            state.list.setAttribute('role', 'listbox');
            let cards = '';
            for (let i = 0; i < 12; i++) {
                cards += `
                    <div class="product-card product-card--skeleton" aria-hidden="true">
                        <div class="product-card__image-wrapper"><div class="smart-ac__skel smart-ac__skel--thumb"></div></div>
                        <div class="product-card__content">
                            <div class="smart-ac__skel smart-ac__skel--line"></div>
                            <div class="smart-ac__skel smart-ac__skel--line smart-ac__skel--short"></div>
                            <div class="smart-ac__skel smart-ac__skel--btn"></div>
                        </div>
                    </div>`;
            }
            state.list.innerHTML = `<div class="product-grid smart-ac__grid">${cards}</div>`;
            positionDropdown();
        }

        function renderResults(data) {
            const list = (data && Array.isArray(data.suggestions)) ? data.suggestions : [];
            const matchedPrinter = data && data.matched_printer;
            const rawDidYouMean = data && data.did_you_mean;

            // ONE did-you-mean vocabulary, shared with the results page
            // (SearchMatch, utils.js, ERR-226). Do NOT inline the rule here:
            // this dropdown and /search read the SAME response envelope, and
            // when only one of them applied the rule they gave the customer two
            // different answers to the same query — the dropdown offering
            // "Did you mean LC3333KCMY … 4-Pack?" directly above the LC3333
            // cards, while /search suppressed that exact banner.
            //
            // Called directly, with no `window.SearchMatch?.x ? … : fallback`
            // guard. utils.js is loaded on every page that loads this file (41
            // vs 34, pinned by test); a guard here would run its fallback on 33
            // of 34 pages, which is ERR-167 — when the fallback is the only
            // branch that ever runs, the guard IS the bug.
            //
            // This is also what makes the dropdown stop depending on a backend
            // page-1 guarantee. ERR-222 was a suggestion naming a product the
            // endpoint had ranked 239th of 367; the backend now hoists it onto
            // page 1, but the symptom cannot return from a regression either,
            // because a correction is only offered when nothing on screen
            // already matches what was typed.
            const didYouMean = SearchMatch.shouldShowCorrection(
                rawDidYouMean, list, state.input.value.trim()
            ) ? rawDidYouMean : null;
            state.mode = list.length ? 'results' : 'no-results';
            state.results = list;
            state.highlightIndex = -1;
            state.list.setAttribute('role', 'listbox');

            if (!list.length) {
                const q = esc(state.input.value.trim());
                // When the backend matched a printer, the useful action is to view
                // its compatible cartridges — not a "no results / did you mean" copy.
                // Spec (search-dropdown-routing.md): canonical printer URL is
                // /shop?brand=<brand_slug>&printer_slug=<slug>; if brand_slug is
                // absent on an older deploy, hide the CTA rather than emit a
                // partial URL.
                const matchedHref = buildPrinterUrl(matchedPrinter);
                if (matchedHref && matchedPrinter.name) {
                    state.list.innerHTML = `
                        <div class="smart-ac__matched-printer">
                            Matched printer: <strong>${esc(matchedPrinter.name)}</strong>
                            — <a href="${escAttr(matchedHref)}">view all compatible cartridges →</a>
                        </div>`;
                    setLive(`Matched printer ${matchedPrinter.name}. View compatible cartridges.`);
                    return;
                }
                const dymHTML = didYouMean
                    ? ` Did you mean <button type="button" class="smart-ac__dym" data-dym="${escAttr(didYouMean)}">${esc(didYouMean)}</button>?`
                    : ` Keep typing or press <kbd>Enter</kbd> to search anyway.`;
                state.list.innerHTML = `<div class="smart-ac__no-results">No results for "${q}".${dymHTML}</div>`;
                const dymBtn = state.list.querySelector('.smart-ac__dym');
                if (dymBtn) {
                    dymBtn.addEventListener('click', () => {
                        state.input.value = dymBtn.dataset.dym || '';
                        state.input.dispatchEvent(new Event('input', { bubbles: true }));
                        state.input.focus();
                    });
                }
                setLive(didYouMean ? `No results. Did you mean ${didYouMean}` : 'No results — press Enter to search anyway');
                return;
            }

            if (typeof Products === 'undefined' || typeof Products.renderCard !== 'function') {
                DebugLog.error('[SmartSearch] Products.renderCard not available — ensure /js/products.js is loaded before /js/search.js');
                state.list.innerHTML = `<div class="smart-ac__error">Search is temporarily unavailable. Please try again.</div>`;
                setLive('Search error');
                return;
            }

            // Spec §1.1: matched_printer and did_you_mean render as clickable
            // rows ABOVE the product list (not as a banner), so the user can
            // act on them directly.
            //
            // Spec (search-dropdown-routing.md, "Three-handler invariant"):
            // this drill-in row is the ONLY element in the dropdown that may
            // navigate to the printer page. The printer-page canonical is
            // /shop?brand=<brand_slug>&printer_slug=<slug> — emitting any
            // other shape (e.g. ?printer=<slug>) breaks bot prerender and
            // splits canonical signals against the sitemap. brand_slug is
            // nullable in older deploys; prefer hiding the row over rendering
            // a partial URL.
            const printerHref = buildPrinterUrl(matchedPrinter);
            const matchedRowHTML = printerHref && matchedPrinter && matchedPrinter.name
                ? `<a class="smart-ac__top-row smart-ac__top-row--printer" href="${escAttr(printerHref)}" data-printer-name="${escAttr(matchedPrinter.name)}">
                       <span class="smart-ac__top-row__icon" aria-hidden="true">
                           <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
                       </span>
                       <span class="smart-ac__top-row__text">Show all cartridges for <strong>${esc(matchedPrinter.name)}</strong></span>
                       <span class="smart-ac__top-row__arrow" aria-hidden="true">→</span>
                   </a>`
                : '';
            // `!matchedPrinter` stays here, exactly as before — SearchMatch
            // deliberately does not fold it in (see its comment in utils.js).
            const dymRowHTML = didYouMean && !matchedPrinter
                ? `<button type="button" class="smart-ac__top-row smart-ac__top-row--dym" data-dym="${escAttr(didYouMean)}">
                       <span class="smart-ac__top-row__icon" aria-hidden="true">?</span>
                       <span class="smart-ac__top-row__text">Did you mean <strong>${esc(didYouMean)}</strong>?</span>
                   </button>`
                : '';
            const q = state.input.value.trim();
            // Organize exactly like the product/shop page: split into a
            // Compatible section and a Genuine section (page order: compatible
            // first — shop.html #compatible-section precedes #genuine-section),
            // then within each section sort by code → yield → colour and break
            // each (familyKey, yieldTier) group onto its own row. A single mixed
            // grid interleaves genuine + compatible variants of the same code,
            // which is the "unorganised" order the page never shows.
            //
            // Partition on the backend canonical `source` BEFORE adaptForCard so
            // byCodeThenColor still sees the grouping fields (series_codes,
            // color, name, product_type, pack_type). Same predicate as
            // shop-page.js loadSearchResults (source === 'compatible'). The
            // injected break <div>s and section heads are skipped by the
            // .product-card keyboard-nav / highlight selectors below.
            // ONE brand-source vocabulary (BrandSource, utils.js, ERR-157).
            // Partition behaviour is deliberately unchanged: a row we cannot
            // classify is not compatible, so it lands in the second group
            // exactly as before. What changed is that an unclassifiable row is
            // no longer ASSERTED compatible on the way in.
            const isCompatibleProduct = (p) => BrandSource.isCompatible(p);
            const compatibleItems = list.filter(isCompatibleProduct);
            const genuineItems = list.filter((p) => !isCompatibleProduct(p));

            // KEYBOARD-NAV CONTRACT: this array must end up in the SAME order as
            // the .product-card elements the browser paints, because setActive(i)
            // highlights DOM card i while the Enter handler navigates to
            // state.results[i]. renderSection pushes each row as it emits that
            // row's card, across both sections, so the two can't disagree.
            //
            // They used to. state.results held the raw API array while the cards
            // were emitted after the compatible/genuine partition AND
            // ProductSort.byCodeThenColor — i.e. reordered on essentially every
            // query, since compatible rows are hoisted above genuine ones.
            // Arrowing to a card and pressing Enter opened a DIFFERENT product
            // than the highlighted one, and the bug was silent because nothing
            // is filtered out, so `count` stayed correct and only the identity
            // was wrong. A customer could land on (and buy) the wrong cartridge.
            // Fixed 2026-08-04 alongside ERR-144.
            const renderedOrder = [];

            const renderSection = (items, badgeClass, label, source) => {
                if (!items.length) return '';
                const startedAt = renderedOrder.length;
                const sorted = (typeof ProductSort !== 'undefined' && ProductSort.byCodeThenColor)
                    ? ProductSort.byCodeThenColor(items)
                    : items;
                // Two rows a shopper cannot tell apart get their SKU printed on the
                // card (ERR-195). Runs on the SORTED list so a group is always
                // adjacent, and marks only — it never filters or reorders.
                if (typeof ProductIdentity !== 'undefined') ProductIdentity.markLookalikes(sorted);
                const breaks = (typeof ProductSort !== 'undefined' && ProductSort.rowBreakIndices)
                    ? new Set(ProductSort.rowBreakIndices(sorted))
                    : new Set();
                const cards = sorted.map((p, i) => {
                    // Push the RAW row (not the adaptForCard copy) — productHref
                    // reads canonical_url/slug/sku, all of which survive intact,
                    // and keeping the raw object means analytics/identity stay
                    // consistent with what the API returned.
                    renderedOrder.push(p);
                    return (breaks.has(i) ? '<div class="products-row__break" aria-hidden="true"></div>' : '')
                        + Products.renderCard(adaptForCard(p), i);
                }).join('');
                state.renderedBySource[source] = renderedOrder.slice(startedAt);
                return `<div class="smart-ac__section" data-source="${source}" role="tabpanel"`
                    + ` id="smart-ac-panel-${id}-${source}" aria-labelledby="smart-ac-tab-${id}-${source}">`
                    + `<div class="smart-ac__section-head"><span class="products-section__badge ${badgeClass}">${label}</span></div>`
                    + `<div class="product-grid smart-ac__grid">${cards}</div>`
                    + `</div>`;
            };

            // TWO COLUMNS, NOT TWO STACKS. Compatible is the left column and
            // Genuine the right, three cards to a row inside each, so a full
            // CMYK family reads `K C M` / `Y CMY KCMY` down one column and the
            // shopper can compare the two sources for the same colour without
            // scrolling. Stacked, the Genuine section began below the fold on
            // essentially every query.
            //
            // The split/single decision is made HERE and written onto the
            // wrapper, rather than inferred in CSS with :has(). One place
            // counts the sources, a test can read the count, and the answer is
            // in the DOM when the probe measures it. `renderSection` already
            // returns '' for an empty group, so "no genuine ⇒ compatible takes
            // the whole width" needs no second code path — only a class that
            // says which of the two layouts is in force.
            const sectionCount = (compatibleItems.length ? 1 : 0) + (genuineItems.length ? 1 : 0);
            // `--rows` is the SHARED marker for the phone presentation (the 64px
            // horizontal-thumb row). Both variants carry it so one rule body
            // serves both instead of a second copy — ERR-192 is what a relocated
            // rule costs when it becomes a copy 2,400 lines away in the same file.
            const rowsClass = ' smart-ac__sections--rows';
            const sectionsClass = (sectionCount === 2
                ? 'smart-ac__sections smart-ac__sections--split'
                : 'smart-ac__sections smart-ac__sections--single') + rowsClass;

            // Which tab is showing. Only a two-source result has tabs at all, so
            // a kept 'genuine' is always valid by construction — sectionCount
            // counts POPULATED sections and renderSection returns '' for an
            // empty group, so a source with zero rows is already --single.
            if (sectionCount !== 2) {
                state.activeSource = null;
            } else if (!state.activeSource) {
                state.activeSource = 'compatible';
            }
            state.renderedBySource = { compatible: [], genuine: [] };
            // Composition order is unchanged — Compatible first, matching
            // shop.html #compatible-section before #genuine-section — which is
            // what keeps `renderedOrder` (below) in painted-DOM order. The
            // columns are a CSS concern; the DOM is still one ordered list, so
            // arrow keys walk the left column and then the right.
            // THE PHONE TAB BAR. Rendered only for a two-source result, and
            // only ever VISIBLE below 700px (CSS decides that; the markup is the
            // same at every width so nothing re-renders on resize and the
            // keyboard contract does not fork).
            //
            // Counts come from the two `.length` reads that already computed
            // sectionCount — not from counting .product-card nodes, which would
            // also sweep up the .products-row__break divs and make the label a
            // function of layout rather than of the payload.
            const tab = (source, label, n) => `<button type="button" role="tab"`
                + ` class="smart-ac__tab" id="smart-ac-tab-${id}-${source}"`
                + ` data-source="${source}"`
                + ` aria-controls="smart-ac-panel-${id}-${source}"`
                + ` aria-selected="${state.activeSource === source}"`
                + ` tabindex="${state.activeSource === source ? '0' : '-1'}">`
                + `${label} <span class="smart-ac__tab-count">${n}</span></button>`;
            const tabsHTML = sectionCount === 2
                ? `<div class="smart-ac__tablist" role="tablist" aria-label="Result source">`
                    + tab('compatible', 'Compatible', compatibleItems.length)
                    + tab('genuine', 'Genuine', genuineItems.length)
                    + `</div>`
                : '';
            const sectionsHTML = sectionCount
                ? tabsHTML + `<div class="${sectionsClass}" data-active-source="${state.activeSource || ''}">`
                    + renderSection(compatibleItems, 'products-section__badge--compatible', 'Compatible', 'compatible')
                    + renderSection(genuineItems, 'products-section__badge--genuine', 'Genuine', 'genuine')
                    + `</div>`
                : '';
            // Re-point state.results at the painted order (see the contract note
            // above). Length is unchanged — the partition and sort never drop a
            // row — so `count` in the keyboard handler stays correct either way.
            state.results = renderedOrder;
            state.renderedAll = renderedOrder;
            // Spec (search-dropdown-routing.md, "Three-handler invariant"):
            // the "View all results" footer ALWAYS goes to /search?q=<query>,
            // independent of matched_printer. Branching on matched_printer here
            // is the regression this contract pins down — it collapses the
            // user's disambiguation choice between "the Canon printer" and
            // "the Epson 200 cartridge family", which is the whole point of
            // surfacing both affordances in the dropdown.
            const viewAllHref = `/search?q=${encodeURIComponent(q)}`;
            const viewAllHTML = q
                ? `<div class="smart-ac__view-all-wrap"><a class="smart-ac__view-all" href="${escAttr(viewAllHref)}">View all results for “${esc(q)}” →</a></div>`
                : '';
            state.list.innerHTML = `${matchedRowHTML}${dymRowHTML}${sectionsHTML}${viewAllHTML}`;
            positionDropdown();

            // PUBLIC VOLUME PRICING — the dropdown was the last product surface
            // without it (ERR-160).
            //
            // Every other grid pairs its paint with this call: products.js:626,
            // shop-page.js (search results + browse), landing.js, ribbons-page.js,
            // favourites.js, and the PDP. This one never did — the file had no
            // `Business.` reference at all — so a shopper saw "Bulk price $21.82"
            // on /shop and /search and nothing here, on the same SKU, one
            // keystroke apart. Business.CARD_SELECTOR already matches these
            // cards (`.product-card[data-sku]`, which Products.renderCard emits);
            // nobody had ever handed them over.
            //
            // Pass `renderedOrder` — the RAW /smart rows, in painted order.
            // `adaptForCard` copies are equivalent today because it spreads with
            // Object.assign rather than whitelisting, but the raw rows are what
            // carry `quantity_breaks` by contract and passing a re-shaped copy
            // to an ingester is precisely how ERR-150 happened.
            //
            // Costs zero requests: /api/search/smart embeds `quantity_breaks` on
            // every row (verified live 2026-08-12), so ingest() answers from the
            // payload and decorateCards() never reaches for the authed route
            // while signed out.
            if (typeof Products !== 'undefined' && typeof Products.decorateBusinessPricing === 'function') {
                Products.decorateBusinessPricing(state.list, renderedOrder);
            }

            // Apply <mark> highlighting to the (already-escaped) product titles.
            // Spec §1.2: highlight name+sku, never highlight description HTML.
            //
            // The "+sku" half is satisfied by the title pass, not by a second
            // selector. Products.renderCard exposes the SKU only as a data-sku
            // ATTRIBUTE — the card has no SKU text node anywhere — so there is
            // nothing else to mark. A `[data-sku-text]` query lived here until
            // 2026-08-04 and matched zero elements on every render, because that
            // attribute is emitted nowhere in this repo; it read as working
            // code, which is worse than an honest gap. In practice product names
            // embed their code ("… Time Clock Ribbon RED/BLACK 360001.02"), so a
            // SKU-shaped query already highlights inside the title. If a real
            // SKU line is ever added to the card, mark it here — and note the
            // card renderer is SHARED with the results grid, so it is not a
            // dropdown-local change.
            if (q) {
                state.list.querySelectorAll('.smart-ac__grid .product-card__title').forEach(el => {
                    el.innerHTML = highlightTokens(el.innerHTML, q);
                });
            }

            const dymBtn = state.list.querySelector('.smart-ac__top-row--dym');
            if (dymBtn) {
                dymBtn.addEventListener('click', () => {
                    state.input.value = dymBtn.dataset.dym || '';
                    state.input.dispatchEvent(new Event('input', { bubbles: true }));
                    state.input.focus();
                });
            }
            const printerRow = state.list.querySelector('.smart-ac__top-row--printer');
            if (printerRow) {
                printerRow.addEventListener('click', () => {
                    saveRecent(printerRow.dataset.printerName || q);
                });
            }

            const viewAllLink = state.list.querySelector('.smart-ac__view-all');
            if (viewAllLink) {
                viewAllLink.addEventListener('click', () => saveRecent(q));
            }

            // Tag each card for keyboard navigation + a11y, and point
            // state.results at the cards that are actually on screen.
            applyActiveSource();

            // ERR-218 — the quantity stepper is TAB-unreachable INSIDE the
            // dropdown. ERR-228 corrects what this comment used to claim.
            //
            // This panel's keyboard model is aria-activedescendant on the search
            // input: arrows and Enter are handled on the input, the cards are
            // role="option" and are never themselves focused, and Tab closes the
            // panel outright. So the controls stay out of the tab order.
            //
            // What is NOT true — and this comment used to say it was — is that
            // focus never leaves the combobox. A pointer click on the number box
            // focuses it (QtyStepper does that focus itself, because the
            // mousedown guard below suppresses the native one), which is the
            // whole point: a quantity you cannot type is a quantity you cannot
            // enter. tabindex="-1" does not block programmatic focus. Escape
            // hands focus back to the search input — see bind().
            //
            // Not a regression — today's Add-to-Cart button in this panel is
            // equally unreachable by Tab, and on every OTHER grid (shop, PDP,
            // ribbons, favourites) the stepper tabs normally.
            state.list.querySelectorAll('.product-card__qty-btn, .product-card__qty-input')
                .forEach(el => el.setAttribute('tabindex', '-1'));

            // Image error-fallback parity with the /search results grid.
            // Every other card surface (shop, filters, favourites, landing,
            // checkout, cart, PDP rail) binds this; the dropdown was the lone
            // omission, so a tile whose /api/images/optimize URL transiently
            // failed showed bare alt text here while /search recovered via the
            // raw Supabase URL. getProductImageHTML now emits data-raw-src and
            // this binds the error→raw-retry→placeholder handler so both
            // surfaces share one fallback strategy. See
            // search-dropdown-routing.md "Image rendering parity" (2026-05-20)
            // and tests/search-dropdown-image-parity.test.js.
            if (typeof Products.bindImageFallbacks === 'function') {
                Products.bindImageFallbacks(state.list);
            }

            if (typeof Products.bindAddToCartEvents === 'function') {
                Products.bindAddToCartEvents(state.list);
            } else if (typeof Products.attachCardListeners === 'function') {
                Products.attachCardListeners(state.list);
            }

            // Toast feedback when an Add-to-Cart button is clicked inside the dropdown
            state.list.querySelectorAll('.product-card__add-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    if (typeof showToast === 'function') {
                        const name = btn.dataset.productName || 'Item';
                        // Read the quantity BEFORE the add path resets the
                        // stepper to 1, or the toast reports "added" for a
                        // quantity nobody asked for (ERR-218).
                        const qty = (typeof QtyStepper !== 'undefined') ? QtyStepper.read(btn) : 1;
                        showToast(
                            qty > 1 ? `${qty} × ${name} added to cart` : `${name} added to cart`,
                            'success',
                            2500
                        );
                    }
                }, { capture: false });
            });

            const liveMsg = matchedPrinter && matchedPrinter.name
                ? `${list.length} result${list.length === 1 ? '' : 's'} found for printer ${matchedPrinter.name}`
                : `${list.length} result${list.length === 1 ? '' : 's'} found`;
            setLive(liveMsg);
        }

        function renderError(err) {
            state.mode = 'error';
            const isRateLimited = err && (err.status === 429 || err.code === 'RATE_LIMITED');
            const msg = isRateLimited
                ? `You're searching too quickly, slow down a sec.`
                : `Search is temporarily unavailable. Please try again.`;
            state.list.innerHTML = `<div class="smart-ac__error">${esc(msg)}</div>`;
            setLive(isRateLimited ? 'Searching too quickly' : 'Search error');
        }

        function setLive(msg) {
            if (state.live) state.live.textContent = msg;
        }

        async function runSearch(query) {
            if (state.abort) state.abort.abort();
            state.abort = new AbortController();
            const signal = state.abort.signal;

            clearTimeout(state.skeletonTimer);
            state.skeletonTimer = setTimeout(() => {
                if (!signal.aborted) renderSkeleton();
            }, SKELETON_DELAY_MS);

            try {
                const data = await fetchSmart(query, signal);
                clearTimeout(state.skeletonTimer);
                if (signal.aborted) return;
                renderResults(data);
            } catch (err) {
                clearTimeout(state.skeletonTimer);
                if (err && err.name === 'AbortError') return;
                DebugLog.error('[SmartSearch]', err);
                renderError(err);
            }
        }

        function onInput() {
            const query = state.input.value.trim();
            clearTimeout(state.debounceTimer);
            if (state.abort) state.abort.abort();
            clearTimeout(state.skeletonTimer);

            open();

            if (query.length < MIN_QUERY_LENGTH) {
                renderEmpty();
                return;
            }
            state.debounceTimer = setTimeout(() => runSearch(query), DEBOUNCE_MS);
        }

        function onKeyDown(e) {
            if (!state.isOpen) {
                if (e.key === 'ArrowDown') { open(); onInput(); }
                return;
            }
            const count = state.results.length;
            switch (e.key) {
                case 'ArrowDown':
                    if (!count) return;
                    e.preventDefault();
                    setActive((state.highlightIndex + 1) % count);
                    break;
                case 'ArrowUp':
                    if (!count) return;
                    e.preventDefault();
                    setActive(state.highlightIndex <= 0 ? count - 1 : state.highlightIndex - 1);
                    break;
                case 'Enter':
                    if (state.highlightIndex >= 0 && state.results[state.highlightIndex]) {
                        e.preventDefault();
                        const p = state.results[state.highlightIndex];
                        saveRecent(state.input.value.trim());
                        window.location.href = productHref(p);
                    }
                    // else: let form submit handler in main.js run
                    break;
                case 'Escape':
                    e.preventDefault();
                    close();
                    state.input.blur();
                    break;
                case 'Tab':
                    close();
                    break;
            }
        }

        function onListClick(e) {
            // Add-to-Cart on product cards is handled by Products.attachCardListeners.
            const clearBtn = e.target.closest('[data-clear-recent]');
            if (clearBtn) {
                e.preventDefault();
                e.stopPropagation();
                try { localStorage.removeItem(RECENT_KEY); } catch (_) {}
                const section = clearBtn.closest('.smart-ac__empty-section');
                if (section) section.remove();
                return;
            }
            const chip = e.target.closest('.smart-ac__chip');
            if (chip) {
                e.preventDefault();
                // Trending-printer chips carry a backend-canonical slug.
                // Navigate directly to the strict printer-products page —
                // the backend serves 301 redirects for any legacy slug drift,
                // so we don't need a suggest round-trip (which can stall on a
                // cold backend and force a misleading "no products" fallback).
                //
                // Spec (search-dropdown-routing.md): canonical printer URL is
                // /shop?brand=<brand_slug>&printer_slug=<slug>. The trending
                // API (/api/printers/trending) does not currently return
                // brand_slug, so we use the documented `allowUnbranded` last-
                // resort form (/shop?printer_slug=<slug>) — this is a
                // user-click affordance (a <button>, not an indexed <a>),
                // so the bot-prerender path isn't impacted; the storefront
                // shop page filters identically by either query param.
                const printerSlug = chip.getAttribute('data-printer-slug');
                if (printerSlug) {
                    const printerName = chip.getAttribute('data-printer-name') || '';
                    const brandSlug = chip.getAttribute('data-printer-brand-slug') || '';
                    saveRecent(printerName);
                    const href = buildPrinterUrl(
                        { slug: printerSlug, brand_slug: brandSlug },
                        { allowUnbranded: true }
                    );
                    window.location.href = href;
                    return;
                }
                // Recent-search chip: "re-run this search." Per the three-handler
                // routing contract (search-dropdown-routing.md), a recent-search
                // chip routes to /search?q= exactly like Enter / "View all
                // results" — it never branches on matched_printer and it never
                // leaves the box merely *filled*.
                //
                // Navigating directly is also the permanent fix for
                // search-recent-chip-no-submit-jun2026.md: writing the chip text
                // via `input.value = …` does NOT fire an 'input' event, so
                // main.js's syncSubmitState() never re-enables the submit button.
                // A stale-disabled submit button is a no-op for BOTH Enter and a
                // direct magnifier click — so the previous "fill the box +
                // runSearch" path left the user staring at a dead search box.
                // Routing straight to the results page sidesteps that entirely
                // and matches what a "recent searches" list is for (one click
                // re-runs it).
                const q = (chip.getAttribute('data-chip') || '').trim();
                if (!q) return;
                saveRecent(q); // bump this query back to the top of recents
                window.location.href = `/search?q=${encodeURIComponent(q)}`;
                return;
            }
            const card = e.target.closest('.product-card');
            if (card && !card.classList.contains('product-card--skeleton')) {
                saveRecent(state.input.value.trim());
                // let the <a class="product-card__link"> navigate naturally
            }
        }

        function bind() {
            state.input.addEventListener('input', onInput);
            state.input.addEventListener('keydown', onKeyDown);
            state.input.addEventListener('focus', () => {
                const q = state.input.value.trim();
                open();
                if (q.length < MIN_QUERY_LENGTH) renderEmpty();
            });

            state.list.addEventListener('mousedown', (e) => {
                // prevent input blur before click fires
                // The stepper controls belong in this list (ERR-218): without
                // them the FIRST click on − or + blurs the search input, the
                // panel closes, and the click lands on nothing.
                if (e.target.closest('.product-card, .smart-ac__chip, .smart-ac__tab, .product-card__add-btn, .product-card__qty, .product-card__qty-btn, .product-card__qty-input, .product-card__link, [data-clear-recent]')) {
                    e.preventDefault();
                }
            });
            // THE TABS. Click first — and note `.smart-ac__tab` is in the
            // mousedown guard above: without it the first tap blurs the search
            // input, the panel closes, and the click lands on nothing. That is
            // byte-for-byte the ERR-218 failure the stepper controls are in that
            // list to prevent.
            state.list.addEventListener('click', (e) => {
                const t = e.target.closest('.smart-ac__tab');
                if (!t) return;
                e.preventDefault();
                setActiveSource(t.getAttribute('data-source'));
                t.focus();
            });
            state.list.addEventListener('click', onListClick);


            // ERR-228 — a pointer click can now put focus in the quantity box,
            // so Escape has to have an answer there. onKeyDown lives on the
            // search input and never sees these keystrokes. Enter is already
            // handled by QtyStepper (it must not submit the search form).
            // Focus goes back to the search input rather than closing: the
            // shopper was mid-quantity, not mid-exit, and state.input's focus
            // handler keeps the panel open.
            state.list.addEventListener('keydown', (e) => {
                if (e.key !== 'Escape') return;
                if (!e.target.closest || !e.target.closest('.product-card__qty-input')) return;
                e.preventDefault();
                e.stopPropagation();
                state.input.focus();
            });

            /* ORDER MATTERS HERE, and only to a test — but the test is right.
               tests/qty-stepper-sep2026.test.js reads the FIRST
               `state.list.addEventListener('keydown'` in this file and asserts it is
               the quantity-box Escape handler (ERR-228). Registering the tab handler
               above it made that test read this block instead and fail, which is the
               test doing its job: it pins WHICH listener owns the qty box, and a
               second keydown listener appearing first is exactly the kind of change
               that could quietly take it over. Behaviour is identical either way —
               both early-return on a target they do not own — so the handler goes
               second and the contract stays readable. */
            /* Tab keyboard, on the LIST rather than the input. The panel's
               arrow-key model (ArrowDown/Up + Enter over state.results) lives on
               state.input via onKeyDown and is never reached while a tab has
               focus, so nothing is stolen from it — and ArrowDown from a tab
               hands straight back to that model rather than inventing a second
               one. Roving tabindex, per the ARIA tabs pattern. */
            state.list.addEventListener('keydown', (e) => {
                const t = e.target.closest && e.target.closest('.smart-ac__tab');
                if (!t) return;
                const tabs = Array.from(state.list.querySelectorAll('.smart-ac__tab'));
                const i = tabs.indexOf(t);
                let next = null;
                if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
                else if (e.key === 'ArrowLeft') next = tabs[i <= 0 ? tabs.length - 1 : i - 1];
                else if (e.key === 'Home') next = tabs[0];
                else if (e.key === 'End') next = tabs[tabs.length - 1];
                else if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setActiveSource(t.getAttribute('data-source'));
                    return;
                } else if (e.key === 'ArrowDown') {
                    // Into the results, using the panel's own one model.
                    e.preventDefault();
                    state.input.focus();
                    if (state.results.length) setActive(0);
                    return;
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    state.input.focus();
                    return;
                } else return;
                e.preventDefault();
                if (next) { setActiveSource(next.getAttribute('data-source')); next.focus(); }
            });

            // Save recent on form submit (free-text search)
            state.form.addEventListener('submit', () => {
                saveRecent(state.input.value.trim());
            });

            state._outsideHandler = (e) => {
                if (!state.form.contains(e.target)) close();
            };
            document.addEventListener('click', state._outsideHandler);

            // Crossing 699px swaps the phone segmented control for the
            // two-column split and back. The MARKUP is identical either way, so
            // nothing re-renders — but which section is visible changes, and
            // state.results has to follow or the keyboard model would be walking
            // a section the shopper can no longer see (ERR-238).
            window.addEventListener('resize', () => {
                if (!state.isOpen) return;
                if (state.activeSource) applyActiveSource();
                positionDropdown();
            });
            window.addEventListener('scroll', () => { if (state.isOpen) positionDropdown(); }, { passive: true });
        }

        function createDom() {
            const existing = state.form.querySelector('.smart-search-dropdown, .search-autocomplete, .smart-ac-dropdown');
            if (existing) existing.remove();

            const formPos = window.getComputedStyle(state.form).position;
            if (formPos === 'static') state.form.style.position = 'relative';

            const wrap = document.createElement('div');
            wrap.className = 'smart-ac-dropdown';
            wrap.id = listboxId;
            wrap.innerHTML = `
                <div class="smart-ac__list" role="listbox" aria-label="Search suggestions"></div>
                <div class="smart-ac__live" aria-live="polite" aria-atomic="true"></div>
            `;
            state.form.appendChild(wrap);
            state.dropdown = wrap;
            state.list = wrap.querySelector('.smart-ac__list');
            state.live = wrap.querySelector('.smart-ac__live');

            state.input.setAttribute('role', 'combobox');
            state.input.setAttribute('aria-expanded', 'false');
            state.input.setAttribute('aria-controls', listboxId);
            state.input.setAttribute('aria-autocomplete', 'list');
            state.input.setAttribute('autocomplete', 'off');
        }

        return {
            init(form, input) {
                state.form = form;
                state.input = input;
                createDom();
                bind();
            }
        };
    }

    window.SmartSearch = {
        init(form, input) {
            if (!form || !input) return null;
            const instance = createInstance();
            instance.init(form, input);
            return instance;
        }
    };
})();
