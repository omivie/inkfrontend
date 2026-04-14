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

    const ENDPOINT = '/api/search/suggest';
    const DEBOUNCE_MS = 300;
    const MIN_QUERY_LENGTH = 2;
    const LIMIT = 24;
    const SKELETON_DELAY_MS = 150;
    const RECENT_KEY = 'recentSearches';
    const RECENT_MAX = 5;
    const PLACEHOLDER_IMG = '/assets/images/placeholder-product.svg';

    const TRENDING_MODELS = [
        'Brother MFC-L2750DW',
        'HP OfficeJet Pro 9720',
        'Canon PIXMA TS3560',
        'Epson EcoTank ET-2850',
        'Brother HL-L2460DW',
    ];

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
        const slug = p.slug || '';
        // Spec payload has no SKU; fall back to slug-only when missing.
        const sku = p.sku || '';
        if (slug && sku) return `/products/${encodeURIComponent(slug)}/${encodeURIComponent(sku)}`;
        if (sku) return `/html/product/?sku=${encodeURIComponent(sku)}`;
        return `/html/shop?search=${encodeURIComponent(p.name || '')}`;
    }

    async function fetchSuggest(query, signal) {
        const base = (typeof Config !== 'undefined' && Config.API_URL) ? Config.API_URL : '';
        const url = `${base}${ENDPOINT}?q=${encodeURIComponent(query)}&limit=${LIMIT}`;
        const res = await fetch(url, { signal });
        const json = await res.json();
        if (!json || !json.ok) throw new Error((json && json.error && json.error.message) || 'Search failed');
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
            state.dropdown.style.setProperty('--smart-ac-top', `${Math.round(inputRect.bottom + 6)}px`);
            state.dropdown.style.setProperty('--smart-ac-left', `${Math.round(formRect.left)}px`);
            state.dropdown.style.setProperty('--smart-ac-width', `${Math.round(formRect.width)}px`);
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

            const trendingSection = `
                <div class="smart-ac__empty-section">
                    <h4 class="smart-ac__empty-title">Trending printers</h4>
                    <div class="smart-ac__chips">${TRENDING_MODELS.map(chip).join('')}</div>
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
                const dymHTML = didYouMean
                    ? ` Did you mean <button type="button" class="smart-ac__dym" data-dym="${escAttr(didYouMean)}">${esc(didYouMean)}</button>?`
                    : ' Try a different term or browse the <a href="/html/shop">full catalog</a>.';
                const printerBannerHTML = matchedPrinter && matchedPrinter.name
                    ? `<div class="smart-ac__matched-printer">Matched printer: <strong>${esc(matchedPrinter.name)}</strong> — <a href="/html/shop?printer=${escAttr(matchedPrinter.slug || '')}">view all compatible cartridges →</a></div>`
                    : '';
                state.list.innerHTML = `${printerBannerHTML}<div class="smart-ac__no-results">No products match “${q}”.${dymHTML}</div>`;
                const dymBtn = state.list.querySelector('.smart-ac__dym');
                if (dymBtn) {
                    dymBtn.addEventListener('click', () => {
                        state.input.value = dymBtn.dataset.dym || '';
                        state.input.dispatchEvent(new Event('input', { bubbles: true }));
                        state.input.focus();
                    });
                }
                setLive(didYouMean ? `No results. Did you mean ${didYouMean}` : 'No results found');
                return;
            }

            if (typeof Products === 'undefined' || typeof Products.renderCard !== 'function') {
                console.error('[SmartSearch] Products.renderCard not available — ensure /js/products.js is loaded before /js/search.js');
                state.list.innerHTML = `<div class="smart-ac__error">Search is temporarily unavailable. Please try again.</div>`;
                setLive('Search error');
                return;
            }

            const bannerHTML = matchedPrinter && matchedPrinter.name
                ? `<div class="smart-ac__matched-printer">Showing results for printer: <strong>${esc(matchedPrinter.name)}</strong> — <a href="/html/shop?printer=${escAttr(matchedPrinter.slug || '')}">view all compatible cartridges →</a></div>`
                : '';
            const cardsHTML = list.map((p, i) => Products.renderCard(adaptForCard(p), i)).join('');
            const q = state.input.value.trim();
            const viewAllHref = `/html/shop?search=${encodeURIComponent(q)}`;
            const viewAllHTML = q
                ? `<div class="smart-ac__view-all-wrap"><a class="smart-ac__view-all" href="${escAttr(viewAllHref)}">View all results for “${esc(q)}” →</a></div>`
                : '';
            state.list.innerHTML = `${bannerHTML}<div class="product-grid smart-ac__grid">${cardsHTML}</div>${viewAllHTML}`;
            positionDropdown();

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

        function renderError() {
            state.mode = 'error';
            state.list.innerHTML = `<div class="smart-ac__error">Search is temporarily unavailable. Please try again.</div>`;
            setLive('Search error');
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
                renderError();
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
