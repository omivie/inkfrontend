/**
 * SEARCH.JS — Smart Autocomplete
 * ================================
 * Row-based typeahead dropdown backed by GET /api/search/suggest.
 *
 * Public API: window.SmartSearch.init(form, input)
 *   main.js wires this to every .search-form in the DOM.
 */

(function () {
    'use strict';

    // /suggest is the type-ahead endpoint that returns matched_printer and
    // did_you_mean metadata. /autocomplete allows higher limits but omits
    // those fields, so we stick with /suggest at its max of 10.
    const ENDPOINT = '/api/search/suggest';
    // 250ms debounce — backend bucket is 120 req/min/IP; a fast typer hammering
    // backspace at <250ms intervals can still trip it, so we err on the safe side.
    const DEBOUNCE_MS = 250;
    const MIN_QUERY_LENGTH = 2;
    const LIMIT = 10;
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
            const res = await fetch(`${base}/api/printers/trending?limit=5`);
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
            source: p.source || (p.is_genuine ? 'genuine' : 'compatible'),
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

    async function fetchSuggest(query, signal) {
        const base = (typeof Config !== 'undefined' && Config.API_URL) ? Config.API_URL : '';
        const url = `${base}${ENDPOINT}?q=${encodeURIComponent(query)}&limit=${LIMIT}`;
        const res = await fetch(url, { signal });
        let json = null;
        try { json = await res.json(); } catch (_) { /* non-JSON body — leave null */ }
        if (!res.ok || !json || !json.ok) {
            const err = new Error((json && json.error && json.error.message) || 'Search failed');
            err.status = res.status;
            err.code = (json && json.error && json.error.code) || null;
            throw err;
        }
        const data = json.data || {};
        return {
            suggestions: Array.isArray(data.suggestions) ? data.suggestions : [],
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
            _outsideHandler: null,
        };

        function positionDropdown() {
            if (!state.input || !state.dropdown) return;
            const formRect = state.form.getBoundingClientRect();
            const inputRect = state.input.getBoundingClientRect();
            const isMobile = window.innerWidth <= 640;
            // On mobile, center the dropdown across the viewport (not the form,
            // which is a narrow 260px centered box). 16px side margins.
            const left = isMobile ? 16 : Math.round(formRect.left);
            const width = isMobile ? (window.innerWidth - 32) : Math.round(formRect.width);
            state.dropdown.style.setProperty('--smart-ac-top', `${Math.round(inputRect.bottom + 6)}px`);
            state.dropdown.style.setProperty('--smart-ac-left', `${left}px`);
            state.dropdown.style.setProperty('--smart-ac-width', `${width}px`);
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
            const didYouMean = data && data.did_you_mean;
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
                console.error('[SmartSearch] Products.renderCard not available — ensure /js/products.js is loaded before /js/search.js');
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
            const dymRowHTML = didYouMean && !matchedPrinter
                ? `<button type="button" class="smart-ac__top-row smart-ac__top-row--dym" data-dym="${escAttr(didYouMean)}">
                       <span class="smart-ac__top-row__icon" aria-hidden="true">?</span>
                       <span class="smart-ac__top-row__text">Did you mean <strong>${esc(didYouMean)}</strong>?</span>
                   </button>`
                : '';
            const q = state.input.value.trim();
            const cardsHTML = list.map((p, i) => Products.renderCard(adaptForCard(p), i)).join('');
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
            state.list.innerHTML = `${matchedRowHTML}${dymRowHTML}<div class="product-grid smart-ac__grid">${cardsHTML}</div>${viewAllHTML}`;
            positionDropdown();

            // Apply <mark> highlighting to the (already-escaped) product titles.
            // Spec §1.2: highlight name+sku, never highlight description HTML.
            if (q) {
                state.list.querySelectorAll('.smart-ac__grid .product-card__title').forEach(el => {
                    el.innerHTML = highlightTokens(el.innerHTML, q);
                });
                state.list.querySelectorAll('.smart-ac__grid [data-sku-text]').forEach(el => {
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

            // Tag each card for keyboard navigation + a11y
            state.list.querySelectorAll('.product-card').forEach((card, i) => {
                card.setAttribute('role', 'option');
                card.setAttribute('aria-selected', 'false');
                card.setAttribute('data-index', String(i));
                card.id = `smart-ac-option-${id}-${i}`;
            });

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
                        showToast(`${name} added to cart`, 'success', 2500);
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
                const data = await fetchSuggest(query, signal);
                clearTimeout(state.skeletonTimer);
                if (signal.aborted) return;
                renderResults(data);
            } catch (err) {
                clearTimeout(state.skeletonTimer);
                if (err && err.name === 'AbortError') return;
                console.error('[SmartSearch]', err);
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
                const q = chip.getAttribute('data-chip') || '';
                state.input.value = q;
                state.input.focus();
                runSearch(q);
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
                if (e.target.closest('.product-card, .smart-ac__chip, .product-card__add-btn, .product-card__link, [data-clear-recent]')) {
                    e.preventDefault();
                }
            });
            state.list.addEventListener('click', onListClick);

            // Save recent on form submit (free-text search)
            state.form.addEventListener('submit', () => {
                saveRecent(state.input.value.trim());
            });

            state._outsideHandler = (e) => {
                if (!state.form.contains(e.target)) close();
            };
            document.addEventListener('click', state._outsideHandler);

            window.addEventListener('resize', () => { if (state.isOpen) positionDropdown(); });
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
