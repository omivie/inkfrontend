    // ============================================
    // SEARCH RESULT RECONCILIATION HELPERS
    // ============================================
    // The typeahead dropdown (search.js → /api/search/suggest) and the full
    // results page (/search → /api/search/smart) hit different backend
    // endpoints, so they could disagree: /smart classifies "intent" and will
    // autocorrect a query it judges ambiguous, while /suggest does a plain
    // literal-substring match. For numeric cartridge codes the /smart
    // autocorrect misfires hard — q=511 became "Lexmark MX 511" and returned
    // four Lexmark products that contain "511" nowhere, while the dropdown
    // correctly showed the CL511 / CT3511xx family. These helpers let
    // loadSearchResults detect that divergence and reconcile the results page
    // back to what the dropdown promised. Pinned by
    // tests/search-results-parity-may2026.test.js.

    // Lowercase + strip every non-alphanumeric char so "CT-351101", "CL511"
    // and "165.11" all compare on their bare token. Pure (no external refs)
    // so it stays unit-testable via the window hook below.
    function normalizeForMatch(s) {
        return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '');
    }

    // True when `product` literally contains what the user typed — the same
    // notion of "match" the dropdown uses. Single-token queries must appear
    // as a contiguous substring of name+sku; multi-token queries must have
    // every token (length >= 2) present somewhere. This is the gate that
    // separates a genuine typo ("cannon" — no literal hit anywhere in the
    // catalog) from a mis-autocorrected valid query ("511" — hits CL511).
    function productMatchesQuery(product, query) {
        if (!product) return false;
        const q = normalizeForMatch(query);
        if (!q) return false;
        const hay = normalizeForMatch((product.name || '') + ' ' + (product.sku || ''));
        if (!hay) return false;
        if (hay.includes(q)) return true;
        const tokens = String(query == null ? '' : query)
            .toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 2);
        if (tokens.length > 1) return tokens.every(t => hay.includes(t));
        return false;
    }

    // Adapt a /suggest payload row to the product shape the card renderer
    // expects. Mirrors search.js's adaptForCard — /suggest sends `price` +
    // `is_genuine`; the shop cards read `retail_price` + `source`.
    function adaptSuggestProduct(p) {
        return Object.assign({}, p, {
            retail_price: p.retail_price != null ? p.retail_price : p.price,
            sku: p.sku || '',
            source: p.source || (p.is_genuine ? 'genuine' : 'compatible'),
            brand: p.brand || null,
            category: p.category || null,
        });
    }

    // Union the dropdown's ranked shortlist (/suggest) with the full literal
    // search set (/api/products?search=). Dropdown order is preserved first,
    // then any products-search rows the dropdown did not surface. Deduped by
    // id, then sku, then normalized name. When the same product appears in
    // both lists the richer /api/products object wins the slot (it carries
    // canonical_url + discount fields the /suggest payload omits) but keeps
    // the dropdown's position. Guarantees the results page is a superset of —
    // never a subset of — what the dropdown showed.
    function mergeLiteralResults(suggestList, fallbackProducts) {
        const fallback = Array.isArray(fallbackProducts) ? fallbackProducts : [];
        const suggest = Array.isArray(suggestList) ? suggestList : [];
        const byId = new Map();
        const bySku = new Map();
        for (const p of fallback) {
            if (p && p.id != null && p.id !== '') byId.set(String(p.id), p);
            if (p && p.sku) bySku.set(String(p.sku).toUpperCase(), p);
        }
        const seen = new Set();
        const out = [];
        const used = new Set();
        const mark = (p) => {
            if (p && p.id != null && p.id !== '') seen.add('id:' + String(p.id));
            if (p && p.sku) seen.add('sku:' + String(p.sku).toUpperCase());
            const n = normalizeForMatch(p && p.name);
            if (n) seen.add('name:' + n);
        };
        const isSeen = (p) => {
            if (p && p.id != null && p.id !== '' && seen.has('id:' + String(p.id))) return true;
            if (p && p.sku && seen.has('sku:' + String(p.sku).toUpperCase())) return true;
            const n = normalizeForMatch(p && p.name);
            return !!n && seen.has('name:' + n);
        };
        for (const s of suggest) {
            const adapted = adaptSuggestProduct(s);
            const richer = (adapted.id != null && byId.get(String(adapted.id)))
                || (adapted.sku && bySku.get(adapted.sku.toUpperCase()))
                || null;
            const row = richer || adapted;
            if (isSeen(row)) continue;
            mark(row);
            if (richer) used.add(richer);
            out.push(row);
        }
        for (const p of fallback) {
            if (used.has(p) || isSeen(p)) continue;
            mark(p);
            out.push(p);
        }
        return out;
    }

    // True when `query` names a REAL product code on `product` — not an
    // incidental substring. Used to strip the off-topic flood from the literal-
    // search fallback union for digit queries: q=220 must keep "220" and
    // "220XL" but drop "220V" (voltage), "(220 pages)" (page count), and digits
    // embedded in a longer code ("72200.01", "IDK22205", "106R01220", "B220Z00",
    // "CT351220"). Two signals, series_codes preferred:
    //   1. product.series_codes contains the query (optionally + a yield suffix).
    //   2. the query appears in name/sku as a boundary-delimited code token
    //      (optionally + a yield suffix), and is NOT followed by "page(s)".
    // Boundaries use the RAW text (not normalizeForMatch, which would collapse
    // "220 pages" → "220pages" and re-admit it).
    function queryCodeMatch(product, query) {
        if (!product) return false;
        const q = normalizeForMatch(query);
        if (!q) return false;
        const esc = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const YIELD = '(?:xl|xxl|xxhy|ehy|hy|h)?';
        // 1. series_codes (backend-canonical).
        const codes = Array.isArray(product.series_codes) ? product.series_codes : [];
        const codeRe = new RegExp('^' + esc + YIELD + '$', 'i');
        for (const c of codes) {
            const nc = normalizeForMatch(c);
            if (nc && (nc === q || codeRe.test(nc))) return true;
        }
        // 2. bounded code token in name/sku, rejecting "<q> page(s)".
        const tokenRe = new RegExp('(^|[^0-9a-z])(' + esc + YIELD + ')([^0-9a-z]|$)', 'gi');
        for (const field of [product.name, product.sku]) {
            const text = String(field == null ? '' : field).toLowerCase();
            if (!text) continue;
            tokenRe.lastIndex = 0;
            let m;
            while ((m = tokenRe.exec(text)) !== null) {
                const afterIdx = m.index + (m[1] ? m[1].length : 0) + m[2].length;
                if (/^\s*pages?\b/.test(text.slice(afterIdx))) continue;
                return true;
            }
        }
        return false;
    }

    // Test hook — exercised by tests/search-results-parity-may2026.test.js.
    // Not a public surface; product code calls the locals directly.
    if (typeof window !== 'undefined') {
        window._searchParityHelpers = {
            normalizeForMatch, productMatchesQuery, adaptSuggestProduct, mergeLiteralResults,
            queryCodeMatch,
        };
    }

    // ============================================
    // DRILL-DOWN NAVIGATION STATE MACHINE
    // ============================================
    const DrilldownNav = {
        // Current state
        state: {
            level: 'brands',
            brand: null,
            category: null,
            code: null,
            printer: null,      // For printer-based product lookup
            printerName: null,  // Display name for the printer
            type: null,         // 'genuine' or 'compatible' filter
            // Mobile Filter & Sort sheet (mobile-ux-audit-jul2026 §2b). Both are
            // client-side refinements applied at render time over the loaded
            // rows — there is no backend facet endpoint (audit §7).
            sort: 'recommended', // recommended | price_asc | price_desc | name_asc | name_desc
            inStock: false,      // in-stock-only toggle
            page: 1             // Pagination — only meaningful on search-results level
        },

        // Allowed values for the Filter & Sort sheet's sort control. Named
        // to match the backend's /api/shop `sort` param vocabulary even though
        // the sort itself is applied client-side (audit §2b/§7).
        SORT_OPTIONS: ['recommended', 'price_asc', 'price_desc', 'name_asc', 'name_desc'],

        // Navigation version to prevent race conditions
        // Incremented on each navigation, checked before rendering
        navigationVersion: 0,

        // Whether the /api/shop endpoint is available (set to false on first 404/error)
        _shopEndpointAvailable: true,

        // Cached data
        cache: {
            brands: null,
            products: {}
        },

        // Static categories - mapped to backend API values
        categories: [
            { id: 'ink',          name: 'Ink Cartridges',  icon: 'droplet',   apiCategory: 'ink' },
            { id: 'toner',        name: 'Toner Cartridges', icon: 'box',       apiCategory: 'toner' },
            { id: 'consumable',   name: 'Drums & Supplies', icon: 'disc',      apiCategory: 'drums' },
            { id: 'label_tape',   name: 'Label Tape',       icon: 'tag',       apiCategory: 'label' },
            { id: 'paper',        name: 'Paper',             icon: 'image',     apiCategory: 'paper' },
            { id: 'ribbons',      name: 'Printer Ribbons',  icon: 'file-text', apiCategory: 'ribbons' }
        ],

        // URL-boundary translation between the backend's canonical category
        // slugs (ink, toner, ribbon, drums, label, paper — IA reorg Jul 2026)
        // and this controller's internal tab ids. Internal ids stay untouched
        // everywhere else (tab state, cache keys, counts, display names);
        // ONLY what we read from and write to the address bar is translated.
        CATEGORY_INTERNAL_BY_CANONICAL: { drums: 'consumable', label: 'label_tape', ribbon: 'ribbons' },
        CATEGORY_CANONICAL_BY_INTERNAL: { consumable: 'drums', label_tape: 'label', ribbons: 'ribbon' },

        // (`compatiblePrefix` field removed 2026-05-03 — five duplicate
        // `isCompatibleProduct` definitions used to fall back to
        // `name.includes(compatiblePrefix)` for legacy data; all now trust
        // `product.source === 'compatible'`. Search audit: SEARCH_AUDIT.md.)

        // Brand display info with local logos
        brandInfo: {
            brother: { name: 'Brother', logo: '/assets/brands/brother.png' },
            canon: { name: 'Canon', logo: '/assets/brands/canon.png' },
            epson: { name: 'Epson', logo: '/assets/brands/epson.png' },
            hp: { name: 'HP', logo: '/assets/brands/hp.png' },
            samsung: { name: 'Samsung', logo: '/assets/brands/samsung.svg' },
            lexmark: { name: 'Lexmark', logo: '/assets/brands/lexmark.png' },
            oki: { name: 'OKI', logo: '/assets/brands/oki.svg' },
            'fuji-xerox': { name: 'Fuji Xerox', logo: '/assets/brands/fuji-xerox.png' },
            kyocera: { name: 'Kyocera', logo: '/assets/brands/kyocera.svg' },
            dymo: { name: 'Dymo', logo: 'https://lmdlgldjgcanknsjrcxh.supabase.co/storage/v1/object/public/public-assets/logos/dymo.png' }
        },

        // DOM Elements
        elements: {
            breadcrumbList: document.getElementById('breadcrumb-list'),
            title: document.getElementById('drilldown-title'),
            productTypeLabel: document.getElementById('product-type-label'),
            levelBrands: document.getElementById('level-brands'),
            levelCategories: document.getElementById('level-categories'),
            levelCodes: document.getElementById('level-codes'),
            levelProducts: document.getElementById('level-products'),
            brandsGrid: document.getElementById('brands-grid'),
            ribbonsBrandsGrid: document.getElementById('ribbons-brands-grid'),
            categoriesGrid: document.getElementById('categories-grid'),
            codesGrid: document.getElementById('codes-grid'),
            genuineProducts: document.getElementById('genuine-products'),
            compatibleProducts: document.getElementById('compatible-products'),
            genuineSection: document.getElementById('genuine-section'),
            compatibleSection: document.getElementById('compatible-section'),
            compatibleTitleText: document.getElementById('compatible-title-text'),
            genuineTitleText: document.getElementById('genuine-title-text'),
            // category-page-contract-may2026.md §2 — the page-level
            // "For Use In: …" aggregation has been retired from list views.
            // Backend never emits a top-level compatible_printers[] for
            // list endpoints; the previous client-side aggregation has
            // been stripped. The PDP keeps its per-product printer block.
            yieldBanner: document.getElementById('yield-banner'),
            yieldValue: document.getElementById('yield-value'),
            loading: document.getElementById('drilldown-loading'),
            empty: document.getElementById('drilldown-empty'),
            emptyMessage: document.getElementById('empty-message'),
            // shop-transient-failure-recovery-may2026.md — separate error pane
            // (with Retry button) so a real failure is visually distinct from
            // "no products in this category" and doesn't look terminal to the
            // user when api.js's transient retry was exhausted.
            error: document.getElementById('drilldown-error'),
            errorMessage: document.getElementById('error-message'),
            errorRetryBtn: document.getElementById('drilldown-retry-btn'),
            // Skeleton elements
            skeletonBrands: document.getElementById('skeleton-brands'),
            skeletonCategories: document.getElementById('skeleton-categories'),
            skeletonCodes: document.getElementById('skeleton-codes'),
            skeletonProducts: document.getElementById('skeleton-products')
        },

        // =========================================
        // INITIALIZATION
        // =========================================
        async init() {
            // Parse URL params to restore state
            this.parseURLState();

            // Load initial level based on state
            this.navigationVersion++;
            await this.loadCurrentLevel(this.navigationVersion);

            // Render active filter indicators
            this.renderActiveFilters();

            // Inject CollectionPage / BreadcrumbList JSON-LD for the current view
            this.injectCollectionSchema();

            // Set up browser navigation
            window.addEventListener('popstate', (e) => {
                if (e.state) {
                    this.state = e.state;
                } else {
                    this.parseURLState();
                }
                this.navigationVersion++;
                this.loadCurrentLevel(this.navigationVersion);
                this.renderActiveFilters();
                this.injectCollectionSchema();
            });

            // BFCACHE / NAVIGATION-AWAY GUARDS (bfcache-restore-may2026.md)
            // Symptom: clicking a product card → pressing Back fast pinned a
            // sticky "Failed to load products. Please try again." state on
            // the shop page. Two cooperating fixes:
            //   1. `pagehide` bumps navigationVersion. Every loader's catch
            //      block early-returns when navigationVersion changes, so
            //      an in-flight fetch that rejects during unload no longer
            //      writes the empty-error DOM that gets snapshotted into
            //      the back/forward cache.
            //   2. `pageshow` with event.persisted === true means the
            //      browser restored a bfcache snapshot; DOMContentLoaded
            //      did NOT fire, so any stale empty/error DOM is still
            //      visible. Re-run loadCurrentLevel against the now-current
            //      URL to refresh the view.
            window.addEventListener('pagehide', () => {
                this._unloading = true;
                this.navigationVersion++;
            });
            window.addEventListener('pageshow', (e) => {
                this._unloading = false;
                if (!e.persisted) return;
                if (this.elements.empty) this.elements.empty.hidden = true;
                if (this.elements.error) this.elements.error.hidden = true;
                this.parseURLState();
                this.navigationVersion++;
                this.loadCurrentLevel(this.navigationVersion);
                this.renderActiveFilters();
                this.injectCollectionSchema();
            });

            // Set up search form to preserve current filters
            this.setupSearchForm();

            // Mobile Filter & Sort sheet wiring (mobile-ux-audit-jul2026 §2b).
            this.initFilterSort();
        },

        // Embed CollectionPage / BreadcrumbList JSON-LD for the current view.
        // Routes to:
        //   - Schema.injectPrinter(slug) when on a printer page (`?printer_slug=...`)
        //   - Schema.injectCollection(brand, category) for everything else
        // Both fall back to the local _writeJsonLdScripts pathway if the
        // unified Schema module isn't loaded (defence in depth).
        async injectCollectionSchema() {
            const brand = this.state.brand;
            const category = this.state.category;
            const printer = this.state.printer;

            // Printer page wins — backend has a dedicated CollectionPage for it.
            if (printer) {
                if (typeof Schema !== 'undefined' && Schema.injectPrinter) {
                    Schema.injectPrinter(printer);
                    if (typeof Schema.remove === 'function') {
                        Schema.remove(['collection-jsonld-collection-page', 'collection-jsonld-breadcrumbs']);
                    }
                    return;
                }
                // Fallback if Schema module didn't load.
                try {
                    const res = await API.getPrinterSchema(printer);
                    if (res && res.ok && res.data) {
                        this._writeJsonLdScripts({
                            'printer-jsonld-collection-page': res.data.collectionPage,
                            'printer-jsonld-breadcrumbs': res.data.breadcrumbs,
                        });
                    }
                } catch (_) { /* additive */ }
                this._removeCollectionSchema();
                return;
            }

            // Need at least one of brand/category for a meaningful CollectionPage entry.
            if (!brand && !category) {
                this._removeCollectionSchema();
                if (typeof Schema !== 'undefined' && Schema.remove) {
                    Schema.remove(['printer-jsonld-collection-page', 'printer-jsonld-breadcrumbs']);
                }
                return;
            }

            if (typeof Schema !== 'undefined' && Schema.injectCollection) {
                Schema.injectCollection(brand, category);
                if (typeof Schema.remove === 'function') {
                    Schema.remove(['printer-jsonld-collection-page', 'printer-jsonld-breadcrumbs']);
                }
                return;
            }

            try {
                const res = await API.getCollectionSchema({ brand: brand || undefined, category: category || undefined });
                if (!res || !res.ok || !res.data) {
                    this._removeCollectionSchema();
                    return;
                }
                this._writeJsonLdScripts({
                    'collection-jsonld-collection-page': res.data.collectionPage,
                    'collection-jsonld-breadcrumbs': res.data.breadcrumbs,
                });
            } catch (_) {
                // Non-critical — JSON-LD is additive
            }
        },

        _writeJsonLdScripts(map) {
            Object.keys(map).forEach(id => {
                const value = map[id];
                if (!value) return;
                let el = document.getElementById(id);
                if (!el) {
                    el = document.createElement('script');
                    el.type = 'application/ld+json';
                    el.id = id;
                    document.head.appendChild(el);
                }
                el.textContent = JSON.stringify(value);
            });
        },

        _removeCollectionSchema() {
            ['collection-jsonld-collection-page', 'collection-jsonld-breadcrumbs'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.remove();
            });
        },

        // Reuses the site-wide nav search form. Hidden brand/type inputs are
        // injected at submit time so the navbar markup stays byte-identical
        // across every page (see project_navbar_parity_may2026).
        setupSearchForm() {
            const searchForm = document.getElementById('site-search-form');
            if (!searchForm) return;

            const upsertHidden = (name, value) => {
                let field = searchForm.querySelector(`input[type="hidden"][name="${name}"]`);
                if (value == null || value === '') {
                    if (field) field.remove();
                    return;
                }
                if (!field) {
                    field = document.createElement('input');
                    field.type = 'hidden';
                    field.name = name;
                    searchForm.appendChild(field);
                }
                field.value = value;
            };

            searchForm.addEventListener('submit', () => {
                upsertHidden('brand', this.state.brand);
                upsertHidden('type', this.state.type);
            });
        },

        // Clear all filters and reset to initial state
        clearAllFilters() {
            // Clear cache to ensure fresh data
            this.cache.products = {};

            // Reset state
            this.state = {
                level: 'brands',
                brand: null,
                category: null,
                code: null,
                printer: null,
                printerName: null,
                printerModel: null,
                printerModelDisplay: null,
                search: null,
                type: null,
                sort: 'recommended',
                inStock: false,
                page: 1
            };

            // Clear URL
            history.pushState(this.state, '', window.location.pathname);

            // Reload brands level
            this.navigationVersion++;
            this.loadCurrentLevel(this.navigationVersion);
        },

        // Remove a specific filter
        removeFilter(filterType) {
            switch (filterType) {
                case 'type':
                    this.state.type = null;
                    break;
                case 'search':
                    this.state.search = null;
                    this.state.page = 1;
                    // If we were in search-results, go back to brands or current nav level
                    if (this.state.level === 'search-results') {
                        if (this.state.code) {
                            this.state.level = 'products';
                        } else if (this.state.category) {
                            this.state.level = 'codes';
                        } else if (this.state.brand) {
                            this.state.level = 'categories';
                        } else {
                            this.state.level = 'brands';
                        }
                    }
                    break;
                case 'brand':
                    this.state.brand = null;
                    this.state.category = null;
                    this.state.code = null;
                    this.state.level = 'brands';
                    break;
                case 'category':
                    this.state.category = null;
                    this.state.code = null;
                    this.state.level = 'categories';
                    break;
            }

            // Invalidate cache
            this.cache.products = {};

            this.updateURL();
            this.navigationVersion++;
            this.loadCurrentLevel(this.navigationVersion);
            this.renderActiveFilters();
        },

        // Render active filter chips
        renderActiveFilters() {
            const container = document.getElementById('active-filters');
            const list = document.getElementById('active-filters-list');
            const clearBtn = document.getElementById('clear-all-filters');

            if (!container || !list) return;

            list.innerHTML = '';
            let hasFilters = false;

            // Type filter (genuine/compatible)
            if (this.state.type) {
                hasFilters = true;
                const chip = document.createElement('button');
                chip.className = 'active-filters__chip';
                chip.innerHTML = `
                    ${this.state.type === 'genuine' ? 'Genuine Only' : 'Compatible Only'}
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                `;
                chip.addEventListener('click', () => this.removeFilter('type'));
                list.appendChild(chip);
            }

            // Search filter
            if (this.state.search && this.state.level === 'search-results') {
                hasFilters = true;
                const chip = document.createElement('button');
                chip.className = 'active-filters__chip';
                chip.innerHTML = `
                    Search: "${this.state.search}"
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                `;
                chip.addEventListener('click', () => this.removeFilter('search'));
                list.appendChild(chip);
            }

            // Show/hide container
            container.hidden = !hasFilters;

            // Set up clear all button
            if (clearBtn && hasFilters) {
                clearBtn.onclick = () => this.clearAllFilters();
            }
        },

        parseURLState() {
            const params = new URLSearchParams(window.location.search);
            this.state.brand = params.get('brand');
            // Category-landing routes: /ink-cartridges and /toner-cartridges
            // are mounted directly at this SPA (rewrite, not redirect) so the
            // page URL matches the backend's CollectionPage.url canonical
            // (brand-canonical audit, May 2026). An explicit ?category= query
            // param wins over the path so legacy /shop?category=ink URLs and
            // brand-narrowing drilldowns keep working.
            const pathCategory = (window.location.pathname === '/ink-cartridges' || window.location.pathname === '/ink-cartridges/')
                ? 'ink'
                : (window.location.pathname === '/toner-cartridges' || window.location.pathname === '/toner-cartridges/')
                    ? 'toner'
                    : null;
            // Canonicalize the incoming slug (IA reorg Jul 2026): the address
            // bar speaks the backend's canonical slugs (drums/label/ribbon…)
            // while internal state keeps the historical tab ids
            // (consumable/label_tape/ribbons). Legacy params (consumable,
            // label_tape, drum) map to their canonical equivalents; params
            // with no canonical form (cartridge, junk) are dropped. The
            // `typeof` guard keeps vm-sandboxed tests (url-consolidation)
            // working without a canonicalizeCategory stub.
            const _rawCategory = params.get('category');
            const _canonCategory = _rawCategory
                ? ((typeof canonicalizeCategory === 'function') ? canonicalizeCategory(_rawCategory) : _rawCategory)
                : null;
            this.state.category = _canonCategory
                ? (this.CATEGORY_INTERNAL_BY_CANONICAL[_canonCategory] || _canonCategory)
                : pathCategory;
            // Fix a non-canonical param in the address bar without a reload
            // (replaceState fires no popstate, so this can't loop). The edge
            // middleware already 301s document loads; this covers SPA-internal
            // entries (pushState/popstate) and non-Vercel environments.
            if (_rawCategory && _canonCategory !== _rawCategory) {
                const _fixed = new URLSearchParams(window.location.search);
                if (_canonCategory) _fixed.set('category', _canonCategory);
                else _fixed.delete('category');
                const _qs = _fixed.toString();
                history.replaceState(history.state, '', window.location.pathname + (_qs ? `?${_qs}` : ''));
            }
            const _rawCode = params.get('code');
            this.state.code = (typeof window !== 'undefined' && window.SeriesCodes && _rawCode)
                ? window.SeriesCodes.collapseYieldSuffix(_rawCode)
                : _rawCode;
            // Canonical printer query param is `printer_slug` per
            // docs: search-dropdown-routing.md (May 2026). The legacy
            // `printer` form is still accepted to keep bookmarks, cached
            // crawls, and the /printers/:slug → /shop?printer=:slug Vercel
            // redirect working. updateURL() and every new emission across
            // the storefront use the canonical name.
            this.state.printer = params.get('printer_slug') || params.get('printer');
            this.state.printerModel = params.get('printer_model');
            this.state.printerBrand = params.get('printer_brand'); // Brand of printer (for display, not filtering)
            this.state.search = params.get('search') || params.get('q'); // Support both 'search' and 'q' params
            this.state.type = params.get('type'); // Support 'type' param for genuine/compatible filtering
            // Filter & Sort refinements (mobile-ux-audit-jul2026 §2b).
            const _rawSort = params.get('sort');
            this.state.sort = this.SORT_OPTIONS.includes(_rawSort) ? _rawSort : 'recommended';
            this.state.inStock = params.get('in_stock') === '1';
            // Pagination — `page` only applies on the search-results level, but
            // we parse it unconditionally so popstate restores the right page.
            const rawPage = parseInt(params.get('page'), 10);
            this.state.page = (Number.isInteger(rawPage) && rawPage > 0) ? rawPage : 1;

            // Ribbons category → redirect to dedicated ribbons page
            if (this.state.category === 'ribbons' && this.state.brand) {
                window.location.replace(`/ribbons?printer_brand=${encodeURIComponent(this.state.brand)}`);
                return;
            }

            // Determine level from state - search takes priority when combined with filters
            if (this.state.search) {
                // Text search mode (may be combined with brand/type filters)
                this.state.level = 'search-results';
            } else if (this.state.printerModel) {
                // Filter products by printer model (from compatible_printers field)
                this.state.level = 'printer-model-products';
            } else if (this.state.printer) {
                // Special case: loading products for a specific printer
                this.state.level = 'printer-products';
            } else if (this.state.code) {
                this.state.level = 'products';
            } else if (this.state.category && this.state.brand) {
                this.state.level = 'codes';
            } else if (this.state.category) {
                // mobile-parity-may2026 S0.3 — category set but no brand. The
                // chip grid is meaningless without a brand (/api/products/series
                // 422s without one), which used to dump deep-linked users into
                // the "server may be warming up" error state forever. Show the
                // brand picker instead; picking a brand drills into the chips.
                this.state.level = 'brands';
            } else if (this.state.brand) {
                this.state.level = 'categories';
            } else {
                this.state.level = 'brands';
            }

        },

        updateURL() {
            // Category-landing path: /ink-cartridges and /toner-cartridges
            // are the canonical URLs for the category-only state (no brand /
            // code / search / printer filters). Any extra filter switches the
            // URL back to /shop?... so /ink-cartridges?brand=hp doesn't appear
            // (the brand drilldown shape has always been /shop?brand=...).
            const isCategoryOnly = !this.state.brand
                && !this.state.code
                && !this.state.search
                && !this.state.printer
                && !this.state.printerModel
                && !this.state.type
                && this.state.category;

            const categoryLandings = { ink: '/ink-cartridges', toner: '/toner-cartridges' };
            const onCategoryLanding = window.location.pathname === '/ink-cartridges'
                || window.location.pathname === '/toner-cartridges';

            let pathname;
            if (isCategoryOnly && categoryLandings[this.state.category]) {
                pathname = categoryLandings[this.state.category];
            } else if (onCategoryLanding) {
                // Leaving the category-landing for a filtered state — switch
                // back to /shop so the URL shape matches the canonical
                // shop-filter route.
                pathname = '/shop';
            } else {
                pathname = window.location.pathname;
            }

            const params = new URLSearchParams();
            if (this.state.brand) params.set('brand', this.state.brand);
            // On a category-landing path the category is implied by pathname;
            // omitting the param keeps the URL canonical (no /ink-cartridges?category=ink).
            const categoryImpliedByPath = pathname === '/ink-cartridges' || pathname === '/toner-cartridges';
            // Emit the backend's canonical slug, never the internal tab id
            // (consumable→drums etc. — IA reorg Jul 2026).
            if (this.state.category && !categoryImpliedByPath) params.set('category', this.CATEGORY_CANONICAL_BY_INTERNAL[this.state.category] || this.state.category);
            if (this.state.code) params.set('code', this.state.code);
            if (this.state.type) params.set('type', this.state.type);
            // Filter & Sort refinements — omit the defaults to keep URLs clean.
            if (this.state.sort && this.state.sort !== 'recommended') params.set('sort', this.state.sort);
            if (this.state.inStock) params.set('in_stock', '1');
            if (this.state.search) params.set('q', this.state.search);
            // `page` is meaningful only on search-results and only beyond p1;
            // omitting it on p1 keeps the canonical URL clean and the browser
            // history short.
            if (this.state.search && this.state.level === 'search-results' && this.state.page > 1) {
                params.set('page', String(this.state.page));
            }

            const newURL = params.toString()
                ? `${pathname}?${params.toString()}`
                : pathname;

            history.pushState({ ...this.state }, '', newURL);
        },

        // =========================================
        // MOBILE FILTER & SORT SHEET (mobile-ux-audit-jul2026 §2b/§8.2)
        // =========================================
        // The list levels get a bottom "Filter & Sort" action bar (thumb zone)
        // that opens a full-screen sheet. Sort is client-side over the loaded
        // rows; Source reuses the existing `type` param; In-stock is a
        // client-side toggle. Facet counts are NOT available from the backend
        // (audit §7) so the bar shows an active-refinement count instead.
        FILTER_SORT_LEVELS: ['products', 'printer-products', 'printer-model-products', 'search-results'],

        // True when the current view is a product list with something rendered.
        _isProductListLevel() {
            return this.FILTER_SORT_LEVELS.includes(this.state.level)
                && this.elements.levelProducts
                && !this.elements.levelProducts.hidden;
        },

        // Number of non-default refinements currently applied (for the bar badge).
        _activeRefinementCount() {
            let n = 0;
            if (this.state.sort && this.state.sort !== 'recommended') n++;
            if (this.state.type) n++;
            if (this.state.inStock) n++;
            return n;
        },

        updateFilterSortBar() {
            const bar = document.getElementById('filter-sort-bar');
            if (!bar) return;
            const show = this._isProductListLevel();
            bar.hidden = !show;
            const countEl = document.getElementById('filter-sort-count');
            if (countEl) {
                const n = this._activeRefinementCount();
                countEl.textContent = n ? String(n) : '';
                countEl.hidden = n === 0;
            }
        },

        initFilterSort() {
            const bar = document.getElementById('filter-sort-bar');
            const sheet = document.getElementById('filter-sort-sheet');
            if (!bar || !sheet) return; // fail-soft when markup absent

            const openBtn = document.getElementById('filter-sort-open');
            const closeEls = sheet.querySelectorAll('[data-filter-sort-close]');
            const applyBtn = document.getElementById('filter-sort-apply');
            const clearBtn = document.getElementById('filter-sort-clear');
            let lastFocus = null;

            // Reflect current state into the sheet controls before opening.
            const syncControls = () => {
                const sortInput = sheet.querySelector(`input[name="fs-sort"][value="${this.state.sort || 'recommended'}"]`);
                if (sortInput) sortInput.checked = true;
                const srcInput = sheet.querySelector(`input[name="fs-source"][value="${this.state.type || ''}"]`);
                if (srcInput) srcInput.checked = true;
                const stock = document.getElementById('fs-instock');
                if (stock) stock.checked = !!this.state.inStock;
            };

            const openSheet = () => {
                syncControls();
                lastFocus = document.activeElement;
                sheet.hidden = false;
                document.body.classList.add('filter-sort-open');
                const first = sheet.querySelector('input, button');
                if (first) first.focus();
                document.addEventListener('keydown', onKeydown);
            };

            const closeSheet = () => {
                sheet.hidden = true;
                document.body.classList.remove('filter-sort-open');
                document.removeEventListener('keydown', onKeydown);
                if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
            };

            const onKeydown = (e) => {
                if (e.key === 'Escape') { e.preventDefault(); closeSheet(); }
            };

            const applySheet = () => {
                const sortVal = (sheet.querySelector('input[name="fs-sort"]:checked') || {}).value || 'recommended';
                const srcVal = (sheet.querySelector('input[name="fs-source"]:checked') || {}).value || '';
                const stockEl = document.getElementById('fs-instock');
                this.state.sort = this.SORT_OPTIONS.includes(sortVal) ? sortVal : 'recommended';
                this.state.type = (srcVal === 'genuine' || srcVal === 'compatible') ? srcVal : null;
                this.state.inStock = !!(stockEl && stockEl.checked);
                this.updateURL();
                closeSheet();
                // Re-run the current level so the type filter re-splits sections
                // and the client-side sort/in-stock refinements re-render.
                this.navigationVersion++;
                this.loadCurrentLevel(this.navigationVersion);
                this.renderActiveFilters();
            };

            const clearSheet = () => {
                const rec = sheet.querySelector('input[name="fs-sort"][value="recommended"]');
                if (rec) rec.checked = true;
                const allSrc = sheet.querySelector('input[name="fs-source"][value=""]');
                if (allSrc) allSrc.checked = true;
                const stock = document.getElementById('fs-instock');
                if (stock) stock.checked = false;
            };

            if (openBtn) openBtn.addEventListener('click', openSheet);
            closeEls.forEach((el) => el.addEventListener('click', closeSheet));
            if (applyBtn) applyBtn.addEventListener('click', applySheet);
            if (clearBtn) clearBtn.addEventListener('click', clearSheet);
        },

        // =========================================
        // NAVIGATION METHODS
        // =========================================
        async navigateTo(level, data = {}) {
            // Increment navigation version to cancel any pending renders
            this.navigationVersion++;
            const thisNavVersion = this.navigationVersion;

            // Preserve type filter + Filter & Sort refinements across navigation
            const currentType = this.state.type;
            const currentSort = this.state.sort || 'recommended';
            const currentInStock = !!this.state.inStock;

            // Update state
            switch (level) {
                case 'brands':
                    this.state = { level: 'brands', brand: null, category: null, code: null, type: currentType, sort: currentSort, inStock: currentInStock };
                    break;
                case 'categories':
                    this.state = { level: 'categories', brand: data.brand, category: null, code: null, type: currentType, sort: currentSort, inStock: currentInStock };
                    break;
                case 'codes':
                    // data.brand is supplied by the S0.3 category-picker path
                    // (brand was null until the user picked one); the normal
                    // categories→codes drilldown omits it and keeps the
                    // already-selected brand.
                    this.state = { level: 'codes', brand: data.brand || this.state.brand, category: data.category, code: null, type: currentType, sort: currentSort, inStock: currentInStock };
                    break;
                case 'products':
                    this.state = { level: 'products', brand: this.state.brand, category: this.state.category, code: data.code, type: currentType, sort: currentSort, inStock: currentInStock };
                    break;
            }

            this.updateURL();
            window.scrollTo(0, 0);
            await this.loadCurrentLevel(thisNavVersion);
        },

        async loadCurrentLevel(navVersion) {
            // Use current version if not provided (for direct calls)
            const expectedVersion = navVersion ?? this.navigationVersion;

            // Hide all levels first
            this.hideAllLevels();

            switch (this.state.level) {
                case 'brands':
                    await this.loadBrands(expectedVersion);
                    break;
                case 'categories':
                    await this.loadCategories(expectedVersion);
                    break;
                case 'codes':
                    await this.loadProductCodes(expectedVersion);
                    break;
                case 'products':
                    await this.loadProducts(expectedVersion);
                    break;
                case 'printer-products':
                    await this.loadPrinterProducts(expectedVersion);
                    break;
                case 'printer-model-products':
                    await this.loadPrinterModelProducts(expectedVersion);
                    break;
                case 'search-results':
                    await this.loadSearchResults(expectedVersion);
                    break;
            }

            // Only update UI if this is still the current navigation
            if (this.navigationVersion === expectedVersion) {
                this.updateBreadcrumb();
                this.updateTitle();
                this.updateSEO();
                this.updateFilterSortBar();
            }
        },

        hideAllLevels() {
            this.elements.levelBrands.hidden = true;
            this.elements.levelCategories.hidden = true;
            this.elements.levelCodes.hidden = true;
            this.elements.levelProducts.hidden = true;
            this.elements.empty.hidden = true;
            if (this.elements.error) this.elements.error.hidden = true;
            const colorPacksSection = document.getElementById('color-packs-section');
            if (colorPacksSection) colorPacksSection.hidden = true;
        },

        showLoading(show, level = null) {
            this.elements.loading.hidden = !show;

            // Hide all skeletons first
            if (this.elements.skeletonBrands) this.elements.skeletonBrands.hidden = true;
            if (this.elements.skeletonCategories) this.elements.skeletonCategories.hidden = true;
            if (this.elements.skeletonCodes) this.elements.skeletonCodes.hidden = true;
            if (this.elements.skeletonProducts) this.elements.skeletonProducts.hidden = true;

            // Show appropriate skeleton based on level
            if (show) {
                const currentLevel = level || this.state.level;
                switch (currentLevel) {
                    case 'brands':
                        if (this.elements.skeletonBrands) this.elements.skeletonBrands.hidden = false;
                        break;
                    case 'categories':
                        if (this.elements.skeletonCategories) this.elements.skeletonCategories.hidden = false;
                        break;
                    case 'codes':
                        if (this.elements.skeletonCodes) this.elements.skeletonCodes.hidden = false;
                        break;
                    case 'products':
                    case 'printer-products':
                    case 'printer-model-products':
                    case 'search-results':
                        if (this.elements.skeletonProducts) this.elements.skeletonProducts.hidden = false;
                        break;
                }
            }
        },

        showEmpty(message) {
            // bfcache-restore-may2026.md: when the page is unloading
            // (the browser is about to snapshot it into bfcache), do not
            // mutate the DOM. Otherwise an in-flight fetch that rejects
            // mid-navigation would write a sticky "Failed to load…" state
            // that gets snapshotted and then shown when the user presses
            // Back. The pageshow/persisted handler in init() will refetch.
            if (this._unloading) return;
            this.elements.emptyMessage.textContent = message;
            this.elements.empty.hidden = false;
            if (this.elements.error) this.elements.error.hidden = true;
        },

        // shop-transient-failure-recovery-may2026.md
        // Distinct-from-empty pane. Use this on a real fetch failure (api.js
        // exhausted its transient retries, or a non-5xx error like a 502 that
        // doesn't fit the retry classifier) instead of dumping the user into
        // .drilldown-empty with "Failed to load products…" text — which looks
        // like a permanent "no products" state and offers no recovery path.
        //
        // The Retry button re-runs the supplied loader against the current
        // navigationVersion, keeping the skeleton visible during the retry
        // (so the user gets immediate visual feedback, not a flash to empty
        // and back). bfcache guard: same `_unloading` check as showEmpty so a
        // mid-unload reject can't poison the snapshot.
        showError(message, onRetry) {
            if (this._unloading) return;
            if (!this.elements.error) {
                // Defensive fallback for legacy DOMs that haven't picked up
                // the new pane yet — degrade to the empty state rather than
                // showing nothing.
                this.showEmpty(message || 'Failed to load products. Please try again.');
                return;
            }
            if (this.elements.errorMessage && message) {
                this.elements.errorMessage.textContent = message;
            }
            this.elements.empty.hidden = true;
            this.elements.error.hidden = false;

            const btn = this.elements.errorRetryBtn;
            if (btn && typeof onRetry === 'function') {
                // Replace the click handler each time so successive showError
                // calls don't stack listeners. Cloning is cheaper than tracking
                // listener identity by hand.
                const fresh = btn.cloneNode(true);
                btn.parentNode.replaceChild(fresh, btn);
                this.elements.errorRetryBtn = fresh;
                fresh.addEventListener('click', async () => {
                    if (this._unloading) return;
                    fresh.disabled = true;
                    try {
                        if (this.elements.error) this.elements.error.hidden = true;
                        this.showLoading(true);
                        // Bump nav version so any zombie in-flight fetch from the
                        // first attempt can't paint over the retry's result.
                        this.navigationVersion++;
                        await onRetry(this.navigationVersion);
                    } finally {
                        fresh.disabled = false;
                    }
                });
            }
        },

        // =========================================
        // LEVEL LOADERS
        // =========================================
        async loadBrands(navVersion) {
            this.showLoading(true);

            try {
                // Use cached brands or fetch from API
                if (!this.cache.brands) {
                    const response = await API.getBrands();
                    // Check if navigation changed during fetch
                    if (navVersion !== undefined && this.navigationVersion !== navVersion) return;

                    if (response.ok && response.data) {
                        this.cache.brands = response.data;
                    } else {
                        // Fallback to static brands
                        this.cache.brands = Object.keys(this.brandInfo).map(id => ({
                            id,
                            name: this.brandInfo[id].name,
                            slug: id
                        }));
                    }
                }

                // Check if navigation changed before rendering
                if (navVersion !== undefined && this.navigationVersion !== navVersion) return;

                this.renderBrands(this.cache.brands);
                await this.renderRibbonBrands();
                this.elements.levelBrands.hidden = false;
            } catch (error) {
                DebugLog.error('Failed to load brands:', error);
                // Check if navigation changed
                if (navVersion !== undefined && this.navigationVersion !== navVersion) return;

                // Fallback to static brands
                this.cache.brands = Object.keys(this.brandInfo).map(id => ({
                    id,
                    name: this.brandInfo[id].name,
                    slug: id
                }));
                this.renderBrands(this.cache.brands);
                await this.renderRibbonBrands();
                this.elements.levelBrands.hidden = false;
            }

            this.showLoading(false);
        },

        renderBrands(brands) {
            const grid = this.elements.brandsGrid;
            grid.innerHTML = '';

            // mobile-parity-may2026 S0.3 — when we arrived here via a
            // category-only URL (/shop?category=ink, /ink-cartridges) the brand
            // picker is a "choose a brand to see <category>" step. Re-label the
            // section, hide the unrelated typewriter-ribbon picker, and route
            // tile clicks straight to the chip grid for brand + category.
            const categoryPicker = !this.state.brand && !!this.state.category;
            const ribbonsSection = document.getElementById('ribbons-section');
            const sectionTitle = this.elements.levelBrands?.querySelector('.shop-section-card__title');
            if (categoryPicker) {
                // Keys are the INTERNAL tab ids (see this.categories).
                const labels = { ink: 'ink cartridges', toner: 'toner', consumable: 'drums & supplies', label_tape: 'label tape', paper: 'photo paper' };
                const label = labels[this.state.category] || `${this.state.category} products`;
                if (sectionTitle) sectionTitle.textContent = `Choose a brand to see ${label}`;
                if (ribbonsSection) ribbonsSection.hidden = true;
            } else {
                if (sectionTitle) sectionTitle.textContent = 'Select your ink cartridge or toner brand';
                if (ribbonsSection) ribbonsSection.hidden = false;
            }

            // Known brands shown first, in preferred order
            const preferredOrder = ['brother', 'canon', 'epson', 'hp', 'samsung', 'lexmark', 'oki', 'fuji-xerox', 'kyocera', 'dymo'];

            // Sort: preferred (logo) brands first, then remaining API brands alphabetically
            const sorted = [...brands].sort((a, b) => {
                const aId = a.slug || a.id || '';
                const bId = b.slug || b.id || '';
                const aIdx = preferredOrder.indexOf(aId);
                const bIdx = preferredOrder.indexOf(bId);
                if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
                if (aIdx !== -1) return -1;
                if (bIdx !== -1) return 1;
                return (a.name || '').localeCompare(b.name || '');
            });

            // Only show ink/toner brands — filter out typewriter brands that bleed in from API
            const inkBrands = sorted.filter(b => preferredOrder.includes(b.slug || b.id || ''));

            inkBrands.forEach(brand => {
                const brandId = brand.slug || brand.id || '';
                const info = this.brandInfo[brandId];
                const box = document.createElement('button');
                box.className = 'drilldown-box drilldown-box--brand';
                box.dataset.brand = brandId;
                const logoSrc = brand.logo_path || (info && info.logo);
                const displayName = (info && info.name) || brand.name || brandId;
                const inner = logoSrc
                    ? `<img src="${Security.escapeAttr(logoSrc)}" alt="${Security.escapeAttr(displayName)}" class="drilldown-box__logo drilldown-box__logo--${Security.escapeAttr(brandId)}">`
                    : `<span class="drilldown-box__name">${Security.escapeHtml(brand.name || brandId)}</span>`;
                box.innerHTML = `${inner}<span class="drilldown-box__count" data-count="${Security.escapeAttr(brandId)}" aria-hidden="true"></span>`;
                box.addEventListener('click', () => categoryPicker
                    ? this.navigateTo('codes', { brand: brandId, category: this.state.category })
                    : this.navigateTo('categories', { brand: brandId }));
                const prefetch = () => {
                    if (!this._prefetchedBrands) this._prefetchedBrands = new Set();
                    if (this._prefetchedBrands.has(brandId)) return;
                    this._prefetchedBrands.add(brandId);
                    API.getShopData({ brand: brandId }).catch(() => {
                        this._prefetchedBrands.delete(brandId);
                    });
                };
                box.addEventListener('mouseenter', prefetch);
                box.addEventListener('focus', prefetch);
                grid.appendChild(box);
            });

            // Lazy-load product counts per brand (non-blocking, graceful on failure)
            this._loadBrandCounts(inkBrands);
        },

        async _loadBrandCounts(brands) {
            for (const brand of brands) {
                const brandId = brand.slug || brand.id || '';
                if (!brandId) continue;
                try {
                    const res = await API.getProductCounts({ brand: brandId });
                    const n = res?.data?.count ?? res?.count;
                    if (n == null) continue;
                    const el = this.elements.brandsGrid?.querySelector(`[data-count="${CSS.escape(brandId)}"]`);
                    if (el) el.textContent = `${n} product${n === 1 ? '' : 's'}`;
                } catch { /* silent */ }
            }
        },

        async renderRibbonBrands() {
            const grid = this.elements.ribbonsBrandsGrid;
            if (!grid) return;

            // Use cached device brands or fetch from API
            // Try ribbon_brands table first (same source as navbar dropdown), fall back to legacy API
            if (!this.cache.ribbonDeviceBrands) {
                try {
                    let brands = [];
                    const res = await API.getRibbonBrandsList();
                    const ribbonBrands = res?.data?.brands || [];
                    if (ribbonBrands.length > 0) {
                        brands = ribbonBrands.map(b => ({
                            value: b.slug || b.name.toLowerCase(),
                            label: b.name,
                        }));
                    } else {
                        const legacyRes = await API.getRibbonBrands();
                        const rawBrands = legacyRes?.data?.brands || [];
                        brands = rawBrands
                            .filter(name => name.toLowerCase() !== 'universal')
                            .map(name => ({ value: name.toLowerCase(), label: name }));
                    }
                    this.cache.ribbonDeviceBrands = brands;
                } catch (e) {
                    this.cache.ribbonDeviceBrands = [];
                }
            }

            grid.innerHTML = '';
            this.cache.ribbonDeviceBrands.forEach((b, i) => {
                const box = document.createElement('a');
                box.className = 'drilldown-box drilldown-box--ribbon';
                box.href = `/ribbons?printer_brand=${encodeURIComponent(b.value)}`;
                box.style.animationDelay = `${60 + i * 30}ms`;
                box.innerHTML = `<span class="drilldown-box__label">${Security.escapeHtml(b.label)}</span>`;
                grid.appendChild(box);
            });
        },

        async loadCategories(navVersion) {
            const grid = this.elements.categoriesGrid;
            grid.innerHTML = '';
            this.showLoading(true);

            const icons = {
                droplet: '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></svg>',
                box: '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
                disc: '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>',
                package: '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>',
                image: '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
                'file-text': '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>',
                tag: '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>'
            };

            // Check cache for category counts
            const cacheKey = `${this.state.brand}-category-counts-v4`;
            let categoryCounts = this.cache.products[cacheKey];

            if (!categoryCounts) {
                try {
                    // Fire shop (counts) and ribbons count in parallel — ribbons aren't in /api/shop
                    const shopPromise = this._shopEndpointAvailable
                        ? API.getShopData({ brand: this.state.brand })
                        : Promise.resolve(null);
                    const ribbonPromise = this.state.brand
                        ? API.getRibbons({ printer_brand: this.state.brand, limit: 1 }).catch(() => null)
                        : Promise.resolve(null);

                    if (this._shopEndpointAvailable) {
                        const response = await shopPromise;
                        if (navVersion !== undefined && this.navigationVersion !== navVersion) return;

                        if (response.ok && response.data?.counts) {
                            const counts = response.data.counts;
                            const totalCount = (counts.ink || 0) + (counts.toner || 0) +
                                (counts.drums || 0) + (counts.label_tape || counts.label || 0) + (counts.paper || 0);
                            if (totalCount > 0) {
                                categoryCounts = {
                                    ink: counts.ink || 0,
                                    toner: counts.toner || 0,
                                    consumable: counts.drums || 0,
                                    label_tape: counts.label_tape || counts.label || 0,
                                    paper: counts.paper || 0,
                                    ribbons: 0
                                };
                            }
                        } else {
                            this._shopEndpointAvailable = false;
                        }
                    }

                    // Legacy fallback: fetch all products and count client-side
                    if (!categoryCounts) {
                        const fetchAllProducts = async (params) => {
                            let allProducts = [];
                            let page = 1;
                            let hasMore = true;
                            while (hasMore) {
                                const response = await API.getProducts({ ...params, page, limit: 100 });
                                if (navVersion !== undefined && this.navigationVersion !== navVersion) return null;
                                if (response.ok && response.data?.products) {
                                    allProducts = allProducts.concat(response.data.products);
                                    const pagination = response.data.pagination;
                                    hasMore = pagination && page < pagination.total_pages;
                                    page++;
                                } else {
                                    hasMore = false;
                                }
                            }
                            return allProducts;
                        };

                        const countByProductType = (products, categoryId) => {
                            return products.filter(p => {
                                const productType = (p.product_type || '').toLowerCase();
                                if (categoryId === 'ink') {
                                    return productType === 'ink_cartridge' || productType === 'ink_bottle';
                                } else if (categoryId === 'toner') {
                                    return productType === 'toner_cartridge';
                                } else if (categoryId === 'consumable') {
                                    return productType === 'drum_unit' ||
                                           productType === 'waste_toner' ||
                                           productType === 'belt_unit' ||
                                           productType === 'fuser_kit' ||
                                           productType === 'maintenance_kit';
                                } else if (categoryId === 'label_tape') {
                                    return productType === 'label_tape';
                                } else if (categoryId === 'paper') {
                                    return productType === 'photo_paper';
                                }
                                return true;
                            }).length;
                        };

                        // Fetch all products for brand (no category filter — /api/products doesn't support it)
                        // Client-side countByProductType() already separates ink/toner/consumable
                        const allProducts = await fetchAllProducts({ brand: this.state.brand });
                        if (allProducts === null) return;

                        categoryCounts = {};
                        categoryCounts['ink'] = countByProductType(allProducts, 'ink');
                        categoryCounts['toner'] = countByProductType(allProducts, 'toner');
                        categoryCounts['consumable'] = countByProductType(allProducts, 'consumable');
                        categoryCounts['label_tape'] = countByProductType(allProducts, 'label_tape');
                        categoryCounts['paper'] = countByProductType(allProducts, 'paper');
                        categoryCounts['ribbons'] = 0;
                    }

                    // Resolve the parallel ribbons count (fired alongside the shop call above)
                    if (categoryCounts && this.state.brand) {
                        const ribbonRes = await ribbonPromise;
                        if (navVersion !== undefined && this.navigationVersion !== navVersion) return;
                        const ribbonTotal = ribbonRes?.meta?.total_items || ribbonRes?.data?.pagination?.total || 0;
                        categoryCounts.ribbons = ribbonTotal;
                    }

                    this.cache.products[cacheKey] = categoryCounts;
                } catch (error) {
                    DebugLog.error('Error fetching category counts:', error);
                    if (navVersion !== undefined && this.navigationVersion !== navVersion) return;
                    categoryCounts = {};
                    this.categories.forEach(cat => categoryCounts[cat.id] = 1);
                }
            }

            // Check if navigation changed before rendering
            if (navVersion !== undefined && this.navigationVersion !== navVersion) return;

            // Filter categories to only those with products.
            // Ribbons are intentionally excluded from shop — only reachable via the
            // "Typewriter & Printer Ribbons" nav dropdown.
            const availableCategories = this.categories.filter(cat => cat.id !== 'ribbons' && categoryCounts[cat.id] > 0);

            this.showLoading(false);

            if (availableCategories.length === 0) {
                this.showEmpty('No products available for this brand.');
                return;
            }

            // If there's only one category, skip the selection step and go straight to codes
            if (availableCategories.length === 1) {
                const onlyCat = availableCategories[0];
                if (onlyCat.id === 'ribbons') {
                    window.location.href = `/ribbons?printer_brand=${encodeURIComponent(this.state.brand)}`;
                    return;
                }
                this.navigateTo('codes', { category: onlyCat.id });
                return;
            }

            availableCategories.forEach(cat => {
                const box = document.createElement('button');
                box.className = 'drilldown-box drilldown-box--category';
                box.dataset.category = cat.id;
                const count = categoryCounts[cat.id];
                box.innerHTML = `
                    <span class="drilldown-box__icon">${icons[cat.icon]}</span>
                    <span class="drilldown-box__name">${cat.name}</span>
                    <span class="drilldown-box__count">${count} product${count !== 1 ? 's' : ''}</span>
                `;
                if (cat.id === 'ribbons') {
                    box.addEventListener('click', () => {
                        window.location.href = `/ribbons?printer_brand=${encodeURIComponent(this.state.brand)}`;
                    });
                } else {
                    box.addEventListener('click', () => this.navigateTo('codes', { category: cat.id }));
                }
                grid.appendChild(box);
            });

            this.elements.levelCategories.hidden = false;
        },

        async loadProductCodes(navVersion) {
            this.showLoading(true);

            try {
                // Get the API category value
                const categoryConfig = this.categories.find(c => c.id === this.state.category);
                const apiCategory = categoryConfig?.apiCategory || this.state.category;
                const brandName = this.brandInfo[this.state.brand]?.name || this.state.brand;

                // Include type filter in cache key to prevent stale results when switching genuine/compatible.
                // v8 (May 2026 series-codes-thin-extractor): backend commit 5c99462
                // now projects `series_codes` on /api/products responses too, so
                // PRIORITY 0 is authoritative and the legacy regex/IB-combo/B-code
                // fallback branches are deleted. Bumping invalidates any in-memory
                // v7 chip counts that may still carry phantom combo chips
                // (LC37LC57, IB3757, LC39KCMY2) from the old fallback paths.
                // v7 (May 2026 yield-collapse): XL/XXL collapse into base chip.
                // v6 (May 2026 catalog overhaul): Epson specialty → base T-series.
                // v5 (legacy): /api/shop endpoint for server-side series extraction.
                const typeKey = this.state.type || 'all';
                const categoryId = this.state.category;
                const cacheKey = `${this.state.brand}-${categoryId}-${typeKey}-codes-v8`;
                const codesCacheKey = `${cacheKey}-final`;

                // Check if we have cached codes with counts already
                // Paper categories skip the early return (need to fetch products which aren't cached in series objects)
                if (this.cache.products[codesCacheKey] &&
                        this.state.category !== 'paper') {
                    const cachedCodes = this.cache.products[codesCacheKey];
                    if (cachedCodes.length === 0) {
                        this.showEmpty('No products found for this category.');
                    } else {
                        this.renderProductCodes(cachedCodes);
                        this.elements.levelCodes.hidden = false;
                    }
                    this.showLoading(false);
                    return;
                }

                let codes = null;

                if (this._shopEndpointAvailable) {
                    // Use /api/shop endpoint for server-side series extraction
                    const apiParams = { brand: this.state.brand, category: apiCategory };
                    if (this.state.type === 'genuine' || this.state.type === 'compatible') {
                        apiParams.source = this.state.type;
                    }

                    const response = await API.getShopData(apiParams);
                    if (navVersion !== undefined && this.navigationVersion !== navVersion) return;

                    if (response.ok && response.data?.series) {
                        codes = response.data.series;
                    } else {
                        // Endpoint failed — fall back to legacy for the rest of the session
                        this._shopEndpointAvailable = false;
                    }
                }

                // Legacy fallback: fetch all products and extract codes client-side
                if (codes === null) {
                    const legacyCacheKey = `${this.state.brand}-${categoryId}-${typeKey}-codes-v4`;

                    if (!this.cache.products[legacyCacheKey]) {
                        const categoryConfig = this.categories.find(c => c.id === this.state.category);
                        const legacyApiCategory = categoryConfig?.apiCategory || this.state.category;

                        const fetchAllProducts = async (params) => {
                            let allProducts = [];
                            let page = 1;
                            let hasMore = true;
                            while (hasMore) {
                                const response = await API.getProducts({ ...params, page, limit: 100 });
                                if (response.ok && response.data?.products) {
                                    allProducts = allProducts.concat(response.data.products);
                                    const pagination = response.data.pagination;
                                    hasMore = pagination && page < pagination.total_pages;
                                    page++;
                                } else {
                                    hasMore = false;
                                }
                            }
                            return allProducts;
                        };

                        // Trust product.brand.slug — backend canonical field
                        // (search audit, 2026-05-03). The previous name+brand-name
                        // text-match fallback walked every product, lowercased and
                        // no-space-stripped its name and brand, then substring-
                        // matched against every variant of the brand keyword.
                        // Backend has returned `product.brand: { id, slug, name }`
                        // since the structured-brand migration; the no-space
                        // collapse and "Compatible <Brand>"-prefix stripping were
                        // workarounds for a data shape that no longer exists.
                        const brandSlug = this.state.brand.toLowerCase();
                        const filterByBrand = (products) => products.filter(p =>
                            (p.brand?.slug || '').toLowerCase() === brandSlug
                        );

                        const apiParams = { brand: this.state.brand };
                        if (this.state.type === 'genuine' || this.state.type === 'compatible') {
                            apiParams.source = this.state.type;
                        }

                        const brandFetchPromise = fetchAllProducts(apiParams)
                            .then(async (results) => {
                                if (results.length === 0) {
                                    apiParams.brand = brandName;
                                    return fetchAllProducts(apiParams);
                                }
                                return results;
                            })
                            .catch(() => []);

                        const searchPromises = [
                            fetchAllProducts({ search: brandName }).catch(() => [])
                        ];
                        if (this.state.brand === 'fuji-xerox') {
                            for (const variant of ['Fuji-Xerox', 'FujiXerox', 'Xerox']) {
                                searchPromises.push(fetchAllProducts({ search: variant }).catch(() => []));
                            }
                        }

                        const settled = await Promise.allSettled([brandFetchPromise, ...searchPromises]);
                        const [brandResult, ...searchResults] = settled.map(r => r.status === 'fulfilled' ? r.value : []);
                        let searchProducts = searchResults.flat();

                        if (searchProducts.length === 0) {
                            try {
                                searchProducts = await fetchAllProducts({ search: brandName });
                            } catch (searchError) { /* continue */ }
                        }

                        let compatibleProducts = searchProducts.filter(p => {
                            const productType = (p.product_type || '').toLowerCase();
                            if (categoryId === 'ink') return productType === 'ink_cartridge' || productType === 'ink_bottle';
                            if (categoryId === 'toner') return productType === 'toner_cartridge';
                            if (categoryId === 'consumable') return productType === 'drum_unit' || productType === 'waste_toner' || productType === 'belt_unit' || productType === 'fuser_kit' || productType === 'maintenance_kit';
                            if (categoryId === 'label_tape') return productType === 'label_tape';
                            if (categoryId === 'paper') return productType === 'photo_paper';
                            return true;
                        });
                        compatibleProducts = filterByBrand(compatibleProducts);

                        const seenIds = new Set();
                        const allProducts = [];
                        for (const p of [...brandResult, ...compatibleProducts]) {
                            if (!seenIds.has(p.id)) { seenIds.add(p.id); allProducts.push(p); }
                        }
                        this.cache.products[legacyCacheKey] = allProducts;
                    }

                    let allProducts = this.cache.products[legacyCacheKey];
                    allProducts = allProducts.filter(p => {
                        const productType = (p.product_type || '').toLowerCase();
                        if (categoryId === 'ink') return productType === 'ink_cartridge' || productType === 'ink_bottle';
                        if (categoryId === 'toner') return productType === 'toner_cartridge';
                        if (categoryId === 'consumable') return productType === 'drum_unit' || productType === 'waste_toner' || productType === 'belt_unit' || productType === 'fuser_kit' || productType === 'maintenance_kit';
                        if (categoryId === 'label_tape') return productType === 'label_tape';
                        if (categoryId === 'paper') return productType === 'photo_paper';
                        return true;
                    });

                    if (navVersion !== undefined && this.navigationVersion !== navVersion) return;
                    codes = this.extractProductCodes(allProducts);
                }

                // Collapse XL/XXL/XXXL yield variants into their base chip so
                // the customer sees one tile per series (200/200XL → 200,
                // 604/604XL → 604, T312/T312XL → T312). Each consolidated
                // chip carries `aliases` so loadProducts can fan out to
                // /api/shop?code=<alias> for every yield level — backend
                // filters strictly on series_codes contains, so a "604" chip
                // alone misses 604XL genuines.
                if (typeof window !== 'undefined' && window.SeriesCodes) {
                    codes = window.SeriesCodes.collapseChipList(codes);
                }

                // Cache the final codes with counts
                this.cache.products[codesCacheKey] = codes;

                if (codes.length === 0) {
                    this.showEmpty('No products found for this category.');
                } else if (this.state.category === 'paper') {
                    // Paper categories: skip code selection, show all products with images directly
                    const seenIds = new Set();
                    let allPaperProducts = [];

                    // Legacy path: extractProductCodes populates entry.products — use directly
                    for (const entry of codes) {
                        for (const p of (entry.products || [])) {
                            if (!seenIds.has(p.id)) { seenIds.add(p.id); allPaperProducts.push(p); }
                        }
                    }

                    // Shop-endpoint path: series objects have no products — fetch each code individually
                    if (allPaperProducts.length === 0 && codes.length > 0) {
                        const results = await Promise.all(
                            codes.map(({ code }) =>
                                API.getShopData({ brand: this.state.brand, category: apiCategory, code, limit: 200 })
                                    .then(r => (r.ok && r.data?.products) ? r.data.products : [])
                                    .catch(() => [])
                            )
                        );
                        if (navVersion !== undefined && this.navigationVersion !== navVersion) return;
                        for (const products of results) {
                            for (const p of products) {
                                if (!seenIds.has(p.id)) { seenIds.add(p.id); allPaperProducts.push(p); }
                            }
                        }
                    }
                    // Trust product.source — backend canonical field (search audit, 2026-05-03).
                    const isCompatibleProduct = (p) => p.source === 'compatible';
                    let genuine = allPaperProducts.filter(p => !isCompatibleProduct(p));
                    let compatible = allPaperProducts.filter(p => isCompatibleProduct(p));
                    if (this.state.type === 'genuine') compatible = [];
                    else if (this.state.type === 'compatible') genuine = [];
                    await this.displayProductInfo(allPaperProducts);
                    if (navVersion !== undefined && this.navigationVersion !== navVersion) return;
                    this.renderProducts(compatible, this.elements.compatibleProducts, this.elements.compatibleSection, true);
                    this.renderProducts(genuine, this.elements.genuineProducts, this.elements.genuineSection, false);
                    if (genuine.length === 0 && compatible.length === 0) {
                        this.showEmpty('No products found for this category.');
                    } else {
                        this.state.level = 'products';
                        this.elements.levelProducts.hidden = false;
                    }
                } else {
                    this.renderProductCodes(codes);
                    this.elements.levelCodes.hidden = false;
                }
            } catch (error) {
                DebugLog.error('Failed to load product codes:', error);
                // Check if navigation changed
                if (navVersion !== undefined && this.navigationVersion !== navVersion) return;
                // shop-transient-failure-recovery-may2026.md — api.js already
                // retried 5xx/network/timeout on idempotent GETs; reaching here
                // means the backend is truly unavailable (or returned a
                // structured error we don't classify as retryable). Show a
                // recoverable error state with a Retry button instead of the
                // permanent-looking "No products found / Failed to load…" pane.
                this.showError(
                    "We couldn't load products. The server may be warming up — please try again.",
                    (v) => this.loadProductCodes(v)
                );
            }

            this.showLoading(false);
        },

        extractProductCodes(products) {
            if (!products || products.length === 0) return [];

            const codeMap = new Map();
            const brand = this.state.brand.toLowerCase();

            // Brand-specific regex patterns for extracting product codes
            // These patterns match the manufacturer part number format
            const patterns = {
                // Brother: LC (ink), TN (toner), DR (drum), TZe/DK (labels), PC (fax), BU/WT (belt/waste), BT (bottles), HC, PRINK, PR (laser), LEB (maintenance), HL (printer model)
                brother: /\b((?:IB)?LC[-]?\d{2,5}(?:X{1,3}L)?[A-Z]{0,3}|(?:IB)?TN[-]?\d{3,4}(?:X{1,3}L)?[A-Z]{0,4}|(?:IB)?DR[-]?\d{3,4}[A-Z]{0,5}|TZE?[-]?[A-Z]{0,3}\d{3,4}|DK[-]?\d{4,5}|PC[-]?\d{3}|BU[-]?\d{3}[A-Z]{0,2}|WT[-]?\d{3,6}[A-Z]{0,2}|BT[-]?\d{3,4}[A-Z]{0,3}|HC\d{2,4}[A-Z]{0,3}|PRINK[A-Z]?|PR[-]?\d{4}[A-Z0-9]*|LEB[-]?\d{5,6}|HLL?\d{4,5}[A-Z]*)\b/gi,
                // Canon: PG/CL/PGI/CLI/BCI (ink), GI (bottles), PFI (pro ink), CART (toner), FX (fax), EP, NPG, TG/GPR, T, LK, NB, MC, WT
                canon: /\b((?:ICPGI|PG|CL|PGI|CLI|BCI|GI|PFI)[-]?\d{1,4}(?:X{1,3}L)?[A-Z]{0,3}|RP[-]?\d{2,3}|CART[-]?\d{3}[A-Z]{0,4}(?:II)?|EP[-]?\d{2,3}|NPG[-]?\d{2,3}|TG[-]?\d{2,3}|GPR[-]?\d{2,3}|FX[-]?\d{1,2}|T\d{2}[A-Z]?|LK[-]?\d{2,3}|NB[-]?CP\d[A-Z]*|MC[-]?G\d{2}|WT[-]?[A-Z]\d|\d[A-Z]{2}\d{2}[A-Z])\b/gi,
                // Epson: T series, C13T (OEM), ERC (ribbon), N-suffix codes (73N, 81N), numeric codes
                epson: /\b((?:IET)\d{3,4}(?:X{1,3}L)?|T\d{2,4}(?:X{1,3}L)?[A-Z]?|C13T\d+|ERC[-]?\d{2,3}|\d{2,3}N|\d{2,3}(?:ML|XXL|XL|S)|S\d{4,5}|\d{2,5}(?:XL)?)\b/gi,
                // HP: numeric series, CF/CE/CC/W/Q/C series, alphanumeric large format codes
                hp: /\b((?:IHP|HI)\d{2,4}[A-Z]?|\d{2,3}(?:X{1,3}L)?[A-Z]?|C[A-Z]?\d{3,4}[A-Z]{0,2}|CC\d{3}[A-Z]{0,2}|CF\d{3}[A-Z]{0,2}|CE\d{3}[A-Z]{0,2}|W\d{4}[A-Z]{0,2}|Q\d{4}[A-Z]{0,2}|[A-Z]\d[A-Z]\d{2}[A-Z]|\d[A-Z]{1,2}\d{2}[A-Z])\b/gi,
                // Samsung: MLT-D/R/W (toner/drum/waste), CLT-C/K/M/Y/W/R/P (color toner/waste/drum/pack)
                samsung: /\b((?:IS)\d{3}|(?:MLT[-]?[DRW]|CLT[-]?[CKMYWRP])\d{3}[A-Z]?|(?:ML|CLP|CLX|SCX|SL[-]?[MC])\d{3,5})\b/gi,
                // Lexmark: 7-char alphanumeric codes (20N3HC0, C540H1CG, 50F3000, 78C6UCE, etc.)
                lexmark: /\b((?:LX)\d{3,4}[A-Z]?|\d{5}[A-Z]{2}|\d{2}[A-Z][A-Z0-9]{4,5}|[CBXETW]\d{2,4}[A-Z0-9]{2,5})\b/gi,
                // OKI: B/C/MC model codes (with optional DN suffix)
                oki: /\b((?:IOC|O)\d{3,4}|[BCM]{1,2}\d{3,4}[A-Z]{0,2}|\d{7,8})\b/gi,
                // Fuji Xerox: CT, CWAA, Xerox numeric (106R, 108R), E/EC/EL prefix codes
                'fuji-xerox': /\b((?:IX|XCP)\d{3}|CT\d{6}|CWAA\d{4}|\d{3}[A-Z]\d{5}|E[CL]?\d{5,7})\b/gi,
                // Kyocera: TK (toner), DK (drum), WT (waste) — allow color suffix on TK
                kyocera: /\b((?:IKTK)\d{3,4}|TK[-]?\d{3,4}[A-Z]?|DK[-]?\d{3,4}|WT[-]?\d{3,4})\b/gi
            };

            // Brand prefixes used in SKUs (internal codes, not manufacturer codes)
            const brandPrefixes = {
                brother: 'B',
                canon: 'C',
                epson: 'E',
                hp: 'H',
                samsung: 'S',
                lexmark: 'L',
                oki: 'O',
                'fuji-xerox': 'F',
                kyocera: 'K'
            };

            products.forEach(product => {
                const name = product.name || '';
                const sku = product.sku || '';
                const mpn = product.manufacturer_part_number || '';
                const pattern = patterns[brand];

                // Collect ALL codes found in this product
                const foundCodes = new Set();

                // Trust backend-supplied `series_codes` (the only path now).
                //
                // The May 2026 catalog overhaul (api-changes-may2026.md §2) ships
                // `series_codes: string[]` on /api/shop responses, and backend
                // commit 5c99462 (series-codes-thin-extractor, May 2026) extends
                // the same projection to /api/products. Both endpoints now run
                // the canonical server-side `extractSeriesCodes`, so the legacy
                // client-side fallback ladder (per-brand name/MPN regex,
                // IB-combo splitter, B-code inference, SKU-prefix-strip,
                // boilerplate name-split) has been deleted — those branches
                // generated phantom chips like `LC37LC57`, `IB3757`, and
                // `LC39KCMY2` whenever the regex over-matched a multi-code
                // pack name. With backend authoritative, the cache key is
                // bumped to v8 to invalidate any stale in-memory chip counts
                // from the previous SPA navigation. The additive SKU regex
                // below is preserved as a no-op safety net (it only adds
                // codes the per-brand pattern already matches; with v8 it
                // should never fire because series_codes already covers
                // every product the regex would match).
                if (Array.isArray(product.series_codes) && product.series_codes.length) {
                    for (const raw of product.series_codes) {
                        const code = this.normalizeCode(String(raw || ''), brand);
                        if (code && code.length >= 2) foundCodes.add(code);
                    }
                }

                // Defensive SKU sweep — kept intentionally un-gated so a
                // product without series_codes (transient backend issue) still
                // surfaces something parseable from its SKU. Backend canonical
                // path covers this in steady state; series_codes coverage on
                // /api/products went live with backend commit 5c99462.
                if (pattern && sku) {
                    pattern.lastIndex = 0;
                    const skuMatches = sku.matchAll(pattern);
                    for (const match of skuMatches) {
                        const code = this.normalizeCode(match[0], brand);
                        if (code && code.length >= 2) {
                            foundCodes.add(code);
                        }
                    }
                }

                // For HP: prefer numeric series codes over OEM part numbers
                // Product names like "HP 62 Ink Cartridge Black (C2P04AA)" contain both
                // the series (62) and OEM code (C2P04) — only keep the numeric series
                if (brand === 'hp' && foundCodes.size > 1) {
                    const numericCodes = new Set();
                    const otherCodes = new Set();
                    foundCodes.forEach(code => {
                        if (/^\d{2,3}$/.test(code)) {
                            numericCodes.add(code);
                        } else {
                            otherCodes.add(code);
                        }
                    });
                    if (numericCodes.size > 0 && otherCodes.size > 0) {
                        foundCodes.clear();
                        numericCodes.forEach(code => foundCodes.add(code));
                    }
                }

                // Add product to EACH code it matches
                foundCodes.forEach(code => {
                    if (!codeMap.has(code)) {
                        codeMap.set(code, { code, count: 0, products: [] });
                    }
                    const entry = codeMap.get(code);
                    entry.count++;
                    entry.products.push(product);
                });
            });

            // Sort codes alphabetically/numerically
            return Array.from(codeMap.values()).sort((a, b) => {
                // Extract numeric portion for comparison
                const numA = parseInt(a.code.replace(/\D/g, '')) || 0;
                const numB = parseInt(b.code.replace(/\D/g, '')) || 0;
                if (numA !== numB) return numA - numB;
                return a.code.localeCompare(b.code);
            });
        },

        formatPaperCodeLabel(code) {
            let s = code;
            // Strip brand prefix (e.g. CANON-KC-18IS → KC-18IS)
            s = s.replace(/^(CANON|BROTHER|EPSON|HP|SAMSUNG)[-\s]?/i, '');
            // Size patterns: 4X6 → 4×6, 5X5 → 5×5, 10X15 → 10×15
            s = s.replace(/(\d+)X(\d+)/gi, (_, a, b) => `${a}×${b}`);
            // Long descriptive words → clean equivalents
            s = s.replace(/GLOSSYPHOTOPAPER/gi, ' Glossy Photo ');
            s = s.replace(/PHOTOPAPER/gi, ' Photo Paper ');
            s = s.replace(/GLOSSY/gi, ' Glossy ');
            // Pack/sheet suffixes: -100P → 100-Pack, 20SHEETS → 20 Sheets
            s = s.replace(/-?(\d+)P$/i, ' $1-Pack');
            s = s.replace(/-?(\d+)SHEETS$/i, ' $1 Sheets');
            // Clean up whitespace
            return s.replace(/\s+/g, ' ').trim();
        },

        normalizeCode(code, brand = null) {
            // Remove hyphens and spaces, uppercase
            let normalized = code.replace(/[-\s]/g, '').toUpperCase();

            // Strip internal prefixes (IB = Ink Brother, etc.)
            if (normalized.startsWith('IB')) {
                normalized = normalized.substring(2);
            }

            // For Brother: LC/TN/DR/TZe/DK/PC/BU/WT/BT/HC/PRINK
            if (brand === 'brother') {
                // LC (ink) — strip color suffix, support XXL
                const lcMatch = normalized.match(/^(LC\d{2,5}(?:X{1,3}L)?)/i);
                if (lcMatch) return lcMatch[1];
                // TN (toner) — strip color suffix, support XXL
                const tnMatch = normalized.match(/^(TN\d{3,4}(?:X{1,3}L)?)/i);
                if (tnMatch) return tnMatch[1];
                // DR (drum) — strip CL/color suffix
                const drMatch = normalized.match(/^(DR\d{3,4})/i);
                if (drMatch) return drMatch[1];
                // TZe label tapes (TZe231, TZEFX431, etc.) — normalize to TZE + digits
                const tzeMatch = normalized.match(/^TZE?[A-Z]{0,3}(\d{3,4})/i);
                if (tzeMatch) return 'TZE' + tzeMatch[1];
                // DK label rolls
                const dkMatch = normalized.match(/^(DK\d{4,5})/i);
                if (dkMatch) return dkMatch[1];
                // PC fax film
                const pcMatch = normalized.match(/^(PC\d{3})/i);
                if (pcMatch) return pcMatch[1];
                // BU belt unit — strip suffix
                const buMatch = normalized.match(/^(BU\d{3})/i);
                if (buMatch) return buMatch[1];
                // WT waste toner — strip suffix
                const wtMatch = normalized.match(/^(WT\d{3})/i);
                if (wtMatch) return wtMatch[1];
                // BT ink bottles — strip color suffix
                const btMatch = normalized.match(/^(BT\d{3,4})/i);
                if (btMatch) return btMatch[1];
                // HC high-capacity ink
                const hcMatch = normalized.match(/^(HC\d{2,4})/i);
                if (hcMatch) return hcMatch[1];
                // PRINK ribbon
                if (normalized.startsWith('PRINK')) return 'PRINK';
                // PR laser toner — strip color/suffix
                const prMatch = normalized.match(/^(PR\d{4})/i);
                if (prMatch) return prMatch[1];
                // LEB maintenance box
                const lebMatch = normalized.match(/^(LEB\d{5,6})/i);
                if (lebMatch) return lebMatch[1];
                // HL printer model (e.g., HLL5210) — normalize to HL-L series
                const hlMatch = normalized.match(/^(HLL?\d{4,5})/i);
                if (hlMatch) return hlMatch[1];
                return null;
            }
            // For Canon: PG/CL/PGI/CLI/BCI/GI/PFI (ink), CART (toner), FX (fax), EP, NPG, TG, GPR, T, LK, NB, MC, WT
            else if (brand === 'canon') {
                // ICPGI prefix (internal code for ink cartridge packs) → strip IC prefix
                const icpgiMatch = normalized.match(/^ICPGI(\d{1,4}(?:X{1,3}L)?)/i);
                if (icpgiMatch) return 'PGI' + icpgiMatch[1];
                // RP series (photo paper/ink combo packs)
                const rpMatch = normalized.match(/^(RP\d{2,3})/i);
                if (rpMatch) return rpMatch[1];
                // Ink: PG, CL, PGI, CLI, BCI, GI, PFI — support single-digit and XXL
                const inkMatch = normalized.match(/^((?:PGI?|CLI?|BCI|GI|PFI)\d{1,4}(?:X{1,3}L)?)/i);
                if (inkMatch) return inkMatch[1];
                // Toner/drum: CART + number (strip color/HY suffixes, keep II)
                const cartMatch = normalized.match(/^(CART\d{3}(?:II)?)/i);
                if (cartMatch) return cartMatch[1];
                // FX fax series
                const fxMatch = normalized.match(/^(FX\d{1,2})/i);
                if (fxMatch) return fxMatch[1];
                // EP series
                const epMatch = normalized.match(/^(EP\d{2,3})/i);
                if (epMatch) return epMatch[1];
                // NPG series (strip color suffix)
                const npgMatch = normalized.match(/^(NPG\d{2,3})/i);
                if (npgMatch) return npgMatch[1];
                // TG/GPR series (strip color suffix)
                const tgMatch = normalized.match(/^(TG\d{2,3})/i);
                if (tgMatch) return tgMatch[1];
                const gprMatch = normalized.match(/^(GPR\d{2,3})/i);
                if (gprMatch) return gprMatch[1];
                // T series toner (T10, T12)
                const tMatch = normalized.match(/^(T\d{2})/i);
                if (tMatch) return tMatch[1];
                // LK, NB, MC, WT series
                const miscMatch = normalized.match(/^(LK\d{2,3}|NBCP\d[A-Z]*|MCG\d{2}|WT[A-Z]\d)/i);
                if (miscMatch) return miscMatch[1];
                // OEM alphanumeric part numbers (e.g., 3ED49A)
                const oemMatch = normalized.match(/^(\d[A-Z]{2}\d{2}[A-Z])/i);
                if (oemMatch) return oemMatch[1];
                return null;
            }
            // For Epson: T series, ERC ribbons, N-suffix codes
            else if (brand === 'epson') {
                // IET value pack codes → strip IET prefix, normalize to T-series
                const ietMatch = normalized.match(/^IET(\d{3,4}(?:X{1,3}L)?)/i);
                if (ietMatch) return 'T' + ietMatch[1];
                const tMatch = normalized.match(/^(T\d{2,4}(?:X{1,3}L)?)/i);
                if (tMatch) return tMatch[1];
                // C13T OEM codes — extract base T-series (C13T306696 → T306)
                const c13Match = normalized.match(/^C13T(\d{2,4})/i);
                if (c13Match) return 'T' + c13Match[1].substring(0, 3);
                const ercMatch = normalized.match(/^(ERC\d{2,3})/i);
                if (ercMatch) return ercMatch[1];
                // S-series maintenance codes (e.g., S2100)
                const sMatch = normalized.match(/^(S\d{4,5})/i);
                if (sMatch) return sMatch[1];
                // N-suffix codes (e.g., 73N, 81N)
                const nMatch = normalized.match(/^(\d{2,3}N)/i);
                if (nMatch) return nMatch[1];
                // Numeric+suffix codes (e.g., 26ML, 46S, 50ML, 80ML, 812XXL)
                const numSuffixMatch = normalized.match(/^(\d{2,3}(?:ML|XXL|XL|S))/i);
                if (numSuffixMatch) return numSuffixMatch[1];
                // Numeric codes (e.g., 502, 522, 277, 288)
                const numMatch = normalized.match(/^(\d{2,5})(?:XL)?/i);
                if (numMatch) return numMatch[1];
                return null;
            }
            // For HP: numeric codes, part number codes (CE, CF, CC, W, Q, C series), alphanumeric large format
            else if (brand === 'hp') {
                // Internal HP prefix codes (IHP564, HI712) → strip prefix, keep number
                const ihpMatch = normalized.match(/^(?:IHP|HI)(\d{2,4})/i);
                if (ihpMatch) return ihpMatch[1];
                // Numeric codes like 05, 119, 143 (strip letter/XL suffix)
                const numMatch = normalized.match(/^(\d{2,3})(?:X{1,3}L)?[A-Z]?/i);
                if (numMatch) return numMatch[1];
                // Part number codes (CB459A, CE505A, CF226X, CC530A, W2090A, Q3984A, C4096A)
                const partMatch = normalized.match(/^(C[A-Z]?\d{3,4}|W\d{3,4}|Q\d{3,4})[A-Z]{0,2}/i);
                if (partMatch) return partMatch[1];
                // Alphanumeric large format codes (P2V68A, L0R08A)
                const alphaMatch = normalized.match(/^([A-Z]\d[A-Z]\d{2})/i);
                if (alphaMatch) return alphaMatch[1];
                // Digit-starting alphanumeric codes (3WX35A, 3ED50A)
                const digitAlphaMatch = normalized.match(/^(\d[A-Z]{1,2}\d{2})/i);
                if (digitAlphaMatch) return digitAlphaMatch[1];
                return null;
            }
            // For Samsung: MLT-D/R/W, CLT-C/K/M/Y/W/R/P, printer models (ML, CLP, CLX, SCX, SL)
            else if (brand === 'samsung') {
                // Internal Samsung prefix (IS365 → CLT365)
                const isMatch = normalized.match(/^IS(\d{3})/i);
                if (isMatch) return 'CLT' + isMatch[1];
                // MLT/CLT toner codes — strip suffix letter (S/L/C etc.)
                const samsungMatch = normalized.match(/^((?:MLT[DRW]|CLT[CKMYWRP])\d{3})/i);
                if (samsungMatch) return samsungMatch[1];
                // Samsung printer model codes as fallback (ML1660, CLP360, CLX3305, etc.)
                const modelMatch = normalized.match(/^((?:ML|CLP|CLX|SCX|SL[MC]?)\d{3,5})/i);
                if (modelMatch) return modelMatch[1];
                return null;
            }
            // For Lexmark: 7-char alphanumeric codes (diverse formats)
            else if (brand === 'lexmark') {
                // Internal Lexmark prefix (LX203H → keep as LX203)
                const lxMatch = normalized.match(/^(LX\d{3,4})/i);
                if (lxMatch) return lxMatch[1];
                // 5-digit + 2-letter OEM codes: 12017SR, 24017SR, 64017HR, 64080HW
                const oemMatch = normalized.match(/^(\d{5}[A-Z]{2})/i);
                if (oemMatch) return oemMatch[1];
                // Numeric-start 7-char codes: 20N3HC0, 50F3000, 71C1HC0, 78C6UCE, etc.
                const numMatch = normalized.match(/^(\d{2}[A-Z][A-Z0-9]{4,5})/i);
                if (numMatch) return numMatch[1];
                // Letter-prefix codes: C540H1CG, C236HK0, X203A11G, B226H00, E250A11P, T650A11P, W850H21G
                const letterMatch = normalized.match(/^([CBXETW]\d{2,4}[A-Z0-9]{2,5})/i);
                if (letterMatch) return letterMatch[1];
                return null;
            }
            // For OKI: B/C/MC model codes — strip DN suffix
            else if (brand === 'oki') {
                // Internal OKI prefix (IOC301 → C301, O301 → C301)
                const ioMatch = normalized.match(/^(?:IOC|O)(\d{3,4})/i);
                if (ioMatch) return 'C' + ioMatch[1];
                // Model codes — strip letter suffixes (C711N → C711)
                const okiMatch = normalized.match(/^([BCM]{1,2}\d{3,4})/i);
                if (okiMatch) return okiMatch[1];
                // 8-digit OEM part numbers (42126676, 43487728)
                const oemMatch = normalized.match(/^(\d{7,8})/);
                if (oemMatch) return oemMatch[1];
                return null;
            }
            // For Fuji Xerox: CT, CWAA, Xerox numeric codes (106R, 108R), E/EC/EL prefix
            else if (brand === 'fuji-xerox') {
                // Internal Xerox prefix (IX105 → CT105, XCP225 → CT225)
                const ixMatch = normalized.match(/^(?:IX|XCP)(\d{3})/i);
                if (ixMatch) return 'CT' + ixMatch[1];
                const ctMatch = normalized.match(/^(CT\d{6})/i);
                if (ctMatch) return ctMatch[1];
                const cwaaMatch = normalized.match(/^(CWAA\d{4})/i);
                if (cwaaMatch) return cwaaMatch[1];
                // Xerox numeric codes: 106R01160, 108R00645, 013R00623, 604K91170
                const xeroxMatch = normalized.match(/^(\d{3}[A-Z]\d{5})/);
                if (xeroxMatch) return xeroxMatch[1];
                // E/EC/EL prefix codes: E3300067, EC101791, EL300637
                const eMatch = normalized.match(/^(E[CL]?\d{5,7})/i);
                if (eMatch) return eMatch[1];
                return null;
            }
            // For Kyocera: TK (strip color suffix), DK, WT
            else if (brand === 'kyocera') {
                // Internal Kyocera prefix (IKTK5144 → TK5144)
                const ikMatch = normalized.match(/^IKTK(\d{3,4})/i);
                if (ikMatch) return 'TK' + ikMatch[1];
                const tkMatch = normalized.match(/^(TK\d{3,4})/i);
                if (tkMatch) return tkMatch[1];
                const dkMatch = normalized.match(/^(DK\d{3,4})/i);
                if (dkMatch) return dkMatch[1];
                const wtMatch = normalized.match(/^(WT\d{3,4})/i);
                if (wtMatch) return wtMatch[1];
                return null;
            }
            // For other brands, try to extract a valid-looking code
            else {
                const genericMatch = normalized.match(/^([A-Z]{1,4}\d{1,6}(?:XL)?)/i);
                if (genericMatch) {
                    return genericMatch[1];
                }
            }

            return null; // Reject unrecognized codes
        },

        renderProductCodes(codes) {
            const grid = this.elements.codesGrid;
            grid.innerHTML = '';

            codes.forEach(({ code, count, products }) => {
                const box = document.createElement('button');
                box.className = 'drilldown-box drilldown-box--code';
                box.dataset.code = code;
                box.innerHTML = `
                    <span class="drilldown-box__code">${
                        (this.state.category === 'paper')
                            ? this.formatPaperCodeLabel(code)
                            : code.replace(/-/g, '')
                    }</span>
                    <span class="drilldown-box__count">${count} product${count > 1 ? 's' : ''}</span>
                `;
                box.addEventListener('click', () => this.navigateTo('products', { code }));
                grid.appendChild(box);
            });
        },

        // Lookup the raw yield aliases (e.g. ['604', '604XL']) that collapsed
        // into the given consolidated chip code. Returns null when no chip
        // cache is populated yet — caller falls back to a single-code request.
        _codeAliasesFor(collapsedCode) {
            if (!collapsedCode) return null;
            const target = String(collapsedCode).trim().toUpperCase();
            const categoryId = this.state.category;
            const typeKey = this.state.type || 'all';
            const cacheKey = `${this.state.brand}-${categoryId}-${typeKey}-codes-v8-final`;
            const cached = this.cache.products[cacheKey];
            if (!Array.isArray(cached)) return null;
            const entry = cached.find(c => c && c.code && String(c.code).toUpperCase() === target);
            if (!entry || !Array.isArray(entry.aliases) || entry.aliases.length === 0) return null;
            return entry.aliases.slice();
        },

        async loadProducts(navVersion) {
            this.showLoading(true);

            try {
                const code = this.state.code;
                const categoryId = this.state.category;
                const typeKey = this.state.type || 'all';

                // Per-code product cache key
                const productCacheKey = `${this.state.brand}-${categoryId}-${typeKey}-products-${code}`;

                let mergedProducts = this.cache.products[productCacheKey] || [];

                if (mergedProducts.length === 0) {
                    // Try the codes cache, newest first
                    // (v8 May 2026 series_codes-only extractor, v7 yield-collapse,
                    //  v6 specialty collapse, v5 /api/shop legacy, v4 client-side legacy).
                    const codesCacheKey8 = `${this.state.brand}-${categoryId}-${typeKey}-codes-v8-final`;
                    const codesCacheKey7 = `${this.state.brand}-${categoryId}-${typeKey}-codes-v7-final`;
                    const codesCacheKey6 = `${this.state.brand}-${categoryId}-${typeKey}-codes-v6-final`;
                    const codesCacheKey5 = `${this.state.brand}-${categoryId}-${typeKey}-codes-v5-final`;
                    const codesCacheKey4 = `${this.state.brand}-${categoryId}-${typeKey}-codes-v4-final`;

                    for (const cacheKey of [codesCacheKey8, codesCacheKey7, codesCacheKey6, codesCacheKey5, codesCacheKey4]) {
                        if (this.cache.products[cacheKey]) {
                            const codeEntry = this.cache.products[cacheKey].find(c => c.code === code);
                            if (codeEntry?.products) {
                                mergedProducts = codeEntry.products;
                                break;
                            }
                        }
                    }
                }

                // If still no products, fetch via /api/shop or legacy.
                //
                // Yield-variant fan-out: a chip's `aliases` list contains
                // every raw code that collapsed into it (e.g. chip "604"
                // → aliases ['604', '604XL']). The /api/shop?code=X filter
                // is strict — series_codes must contain X exactly — so to
                // populate the consolidated tile we issue one request per
                // alias in parallel. Falls back to a single request with
                // the bare collapsed code when the chip cache hasn't been
                // populated yet (deep-link / hard refresh path).
                if (mergedProducts.length === 0) {
                    if (this._shopEndpointAvailable) {
                        const loadCategoryConfig = this.categories.find(c => c.id === this.state.category);
                        const loadApiCategory = loadCategoryConfig?.apiCategory || this.state.category;

                        const aliases = this._codeAliasesFor(code) || [code];
                        const responses = await Promise.all(aliases.map(alias =>
                            API.getShopData({
                                brand: this.state.brand,
                                category: loadApiCategory,
                                code: alias,
                                limit: 200
                            }).catch(() => null)
                        ));
                        if (navVersion !== undefined && this.navigationVersion !== navVersion) return;

                        const seenIds = new Set();
                        for (const response of responses) {
                            if (response && response.ok && response.data?.products) {
                                for (const p of response.data.products) {
                                    const key = (p && (p.id || p.sku)) || null;
                                    if (key == null || seenIds.has(key)) continue;
                                    seenIds.add(key);
                                    mergedProducts.push(p);
                                }
                            }
                        }
                    }

                    // Legacy fallback: trigger loadProductCodes to populate cache
                    if (mergedProducts.length === 0) {
                        await this.loadProductCodes(navVersion);
                        this.elements.levelCodes.hidden = true;
                        if (navVersion !== undefined && this.navigationVersion !== navVersion) return;

                        const codesCacheKey8 = `${this.state.brand}-${categoryId}-${typeKey}-codes-v8-final`;
                        const codesCacheKey7 = `${this.state.brand}-${categoryId}-${typeKey}-codes-v7-final`;
                        const codesCacheKey6 = `${this.state.brand}-${categoryId}-${typeKey}-codes-v6-final`;
                        const codesCacheKey5 = `${this.state.brand}-${categoryId}-${typeKey}-codes-v5-final`;
                        const codesCacheKey4 = `${this.state.brand}-${categoryId}-${typeKey}-codes-v4-final`;
                        for (const cacheKey of [codesCacheKey8, codesCacheKey7, codesCacheKey6, codesCacheKey5, codesCacheKey4]) {
                            if (this.cache.products[cacheKey]) {
                                const codeEntry = this.cache.products[cacheKey].find(c => c.code === code);
                                if (codeEntry?.products) {
                                    mergedProducts = codeEntry.products;
                                    break;
                                }
                            }
                        }
                    }

                    // Cache the fetched products for this code
                    if (mergedProducts.length > 0) {
                        this.cache.products[productCacheKey] = mergedProducts;
                    }
                }

                // Check if navigation changed before rendering
                if (navVersion !== undefined && this.navigationVersion !== navVersion) return;

                // Separate genuine and compatible — trust the API's source field
                // (search audit, 2026-05-03; the previous name-substring fallback
                // was for legacy data that no longer exists).
                const isCompatibleProduct = (product) => product.source === 'compatible';

                let genuine = mergedProducts.filter(p => !isCompatibleProduct(p));
                let compatible = mergedProducts.filter(p => isCompatibleProduct(p));

                // Apply type filter if specified (from URL parameter)
                if (this.state.type === 'genuine') {
                    compatible = []; // Hide compatible products
                } else if (this.state.type === 'compatible') {
                    genuine = []; // Hide genuine products
                }

                // Extract and display product info (yield) and fetch compatible printers
                await this.displayProductInfo(mergedProducts);

                // Check if navigation changed before rendering
                if (navVersion !== undefined && this.navigationVersion !== navVersion) return;

                this.renderProducts(compatible, this.elements.compatibleProducts, this.elements.compatibleSection, true);
                this.renderProducts(genuine, this.elements.genuineProducts, this.elements.genuineSection, false);

                if (genuine.length === 0 && compatible.length === 0) {
                    this.showEmpty('No products found for this code.');
                } else {
                    this.elements.levelProducts.hidden = false;
                }
            } catch (error) {
                DebugLog.error('Failed to load products:', error);
                // Check if navigation changed
                if (navVersion !== undefined && this.navigationVersion !== navVersion) return;
                this.showError(
                    "We couldn't load products for this code. The server may be warming up — please try again.",
                    (v) => this.loadProducts(v)
                );
            }

            this.showLoading(false);
        },

        // Load products compatible with a specific printer
        async loadPrinterProducts(navVersion) {
            this.showLoading(true);

            // Backend returns 404 NOT_FOUND for unknown/retired printer slugs
            // (thrown by API layer), and 400 VALIDATION_FAILED for slugs that
            // don't match the backend's allowed-character regex (returned
            // as { ok:false, code:'VALIDATION_FAILED' }). Both mean "this
            // slug isn't a real printer" — redirect to /shop rather than
            // showing a "Failed to load" error so stale sitemap entries
            // and old crawler URLs never look like a broken page.
            const isPrinterNotFound = (err) => /printer (?:model )?not found|NOT_FOUND/i.test(err && err.message || '');
            const isBadPrinterSlug = (resp) => resp && resp.ok === false && (resp.code === 'NOT_FOUND' || resp.code === 'VALIDATION_FAILED');

            try {
                // Fetch compatible products for the printer slug.
                // The backend lives on Render and can cold-start: the first call
                // may 5xx or time out. Retry once after a short delay before
                // surfacing a "Failed to load products" error to the user.
                let response;
                try {
                    response = await API.getProductsByPrinter(this.state.printer);
                } catch (firstErr) {
                    if (navVersion !== undefined && this.navigationVersion !== navVersion) return;
                    if (isPrinterNotFound(firstErr)) {
                        window.location.replace('/shop');
                        return;
                    }
                    await new Promise(r => setTimeout(r, 800));
                    response = await API.getProductsByPrinter(this.state.printer);
                }

                // Check if navigation changed during fetch
                if (navVersion !== undefined && this.navigationVersion !== navVersion) return;

                if (isBadPrinterSlug(response)) {
                    window.location.replace('/shop');
                    return;
                }

                if (response.ok && response.data) {
                    const printerData = response.data.printer;
                    // API returns 'products' array (per product_pages.md documentation)
                    const products = response.data.products || response.data.compatible_products || [];

                    // Store printer name for display
                    this.state.printerName = printerData?.full_name || this.state.printer;
                    this.updateBreadcrumb();
                    this.updateTitle();

                    // Trust product.source — backend canonical field (search audit, 2026-05-03).
                    const isCompatibleProduct = (product) => product.source === 'compatible';

                    let genuine = products.filter(p => !isCompatibleProduct(p));
                    let compatible = products.filter(p => isCompatibleProduct(p));

                    // Apply type filter if specified (from URL parameter)
                    if (this.state.type === 'genuine') {
                        compatible = []; // Hide compatible products
                    } else if (this.state.type === 'compatible') {
                        genuine = []; // Hide genuine products
                    }

                    const printerDisplayName = this.state.printerName || '';
                    this.elements.compatibleTitleText.textContent = `${printerDisplayName} Compatible Products`;
                    this.elements.genuineTitleText.textContent = `${printerDisplayName} Original Products`;

                    // Render compatible first, then genuine
                    this.renderProducts(compatible, this.elements.compatibleProducts, this.elements.compatibleSection, true);
                    this.renderProducts(genuine, this.elements.genuineProducts, this.elements.genuineSection, false);

                    if (genuine.length === 0 && compatible.length === 0) {
                        this.showEmpty('No compatible products found for this printer.');
                    } else {
                        this.elements.levelProducts.hidden = false;
                        // Load color packs (non-blocking)
                        this.loadColorPacks(this.state.printer);
                    }
                } else {
                    this.showError(
                        "We couldn't load compatible products for this printer. The server may be warming up — please try again.",
                        (v) => this.loadPrinterProducts(v)
                    );
                }
            } catch (error) {
                DebugLog.error('Failed to load printer products:', error);
                // Check if navigation changed
                if (navVersion !== undefined && this.navigationVersion !== navVersion) return;
                if (isPrinterNotFound(error)) {
                    window.location.replace('/shop');
                    return;
                }
                this.showError(
                    "We couldn't load products for this printer. The server may be warming up — please try again.",
                    (v) => this.loadPrinterProducts(v)
                );
            }

            this.showLoading(false);
        },

        // Load and render color pack bundles for a printer
        async loadColorPacks(printerSlug) {
            const section = document.getElementById('color-packs-section');
            const grid = document.getElementById('color-packs-grid');
            if (!section || !grid) return;

            try {
                const res = await API.getColorPacks(printerSlug);
                if (!res.ok || !res.data) return;

                const data = res.data;
                const allPacks = [];
                if (data.genuine?.packs?.length) {
                    data.genuine.packs.forEach(p => allPacks.push({ ...p, source: 'genuine' }));
                }
                if (data.compatible?.packs?.length) {
                    data.compatible.packs.forEach(p => allPacks.push({ ...p, source: 'compatible' }));
                }
                if (allPacks.length === 0) return;

                const colorHex = { Black: '#1a1a1a', Cyan: '#00bcd4', Magenta: '#e91e63', Yellow: '#ffc107' };

                grid.innerHTML = allPacks.map(pack => {
                    const items = pack.items || [];
                    const swatches = items.map(item => {
                        const hex = item.color_hex || colorHex[item.color] || '#888';
                        return `<span class="color-pack-card__swatch" style="background:${hex}" title="${Security.escapeHtml(item.color || '')}"></span>`;
                    }).join('');

                    const itemList = items.map(item =>
                        `<li>${Security.escapeHtml(item.color || '')} - ${formatPrice(item.retail_price)}</li>`
                    ).join('');

                    const originalTotal = items.reduce((sum, i) => sum + (i.retail_price || 0), 0);
                    const packPrice = pack.pack_price || originalTotal;
                    const savings = originalTotal - packPrice;
                    const savingsPct = originalTotal > 0 ? Math.round((savings / originalTotal) * 100) : 0;
                    const sourceLabel = pack.source === 'genuine' ? 'Genuine' : 'Compatible';
                    const sourceClass = pack.source === 'genuine' ? 'genuine' : 'compatible';
                    const packName = pack.pack_type === 'KCMY' ? 'KCMY Full Set' : 'CMY Colour Pack';

                    return `
                        <div class="color-pack-card" data-pack='${Security.escapeAttr(JSON.stringify({ items: items.map(i => ({ product_id: i.product_id || i.id, name: i.name, price: i.retail_price })) }))}'>
                            ${savingsPct > 0 ? `<span class="color-pack-card__badge">SAVE ${savingsPct}%</span>` : ''}
                            <div class="color-pack-card__source color-pack-card__source--${sourceClass}">${sourceLabel}</div>
                            <div class="color-pack-card__name">${Security.escapeHtml(packName)}</div>
                            <div class="color-pack-card__swatches">${swatches}</div>
                            <ul class="color-pack-card__items">${itemList}</ul>
                            <div class="color-pack-card__pricing">
                                <span class="color-pack-card__pack-price">${formatPrice(packPrice)}</span>
                                ${savings > 0 ? `<span class="color-pack-card__original-price">${formatPrice(originalTotal)}</span>` : ''}
                            </div>
                            <button type="button" class="color-pack-card__add-btn">Add All to Cart</button>
                        </div>`;
                }).join('');

                // Bind add-all-to-cart buttons
                grid.querySelectorAll('.color-pack-card__add-btn').forEach(btn => {
                    btn.addEventListener('click', async function() {
                        const card = this.closest('.color-pack-card');
                        const packData = JSON.parse(card.dataset.pack);
                        this.disabled = true;
                        this.textContent = 'Adding...';
                        try {
                            for (const item of packData.items) {
                                await Cart.addItem({
                                    id: item.product_id,
                                    name: item.name,
                                    price: item.price,
                                    quantity: 1,
                                    product_source: item.source || null
                                });
                            }
                            this.textContent = 'Added!';
                            setTimeout(() => {
                                this.textContent = 'Add All to Cart';
                                this.disabled = false;
                            }, 2000);
                        } catch (e) {
                            this.textContent = 'Error - Try Again';
                            this.disabled = false;
                        }
                    });
                });

                section.hidden = false;
            } catch (e) {
                // Color packs are non-critical
            }
        },

        // Mapping of printer models to compatible product codes
        printerProductCodes: {
            // Samsung
            'CLP-365': ['CLT-406', 'K406', 'C406', 'M406', 'Y406'],
            'CLP-415N': ['CLT-504', 'K504', 'C504', 'M504', 'Y504'],
            'CLX-3305': ['CLT-406', 'K406', 'C406', 'M406', 'Y406'],
            'CLX-4195FN': ['CLT-504', 'K504', 'C504', 'M504', 'Y504'],
            'ML-2165': ['MLT-D101', 'D101'],
            'ML-2955ND': ['MLT-D103', 'D103'],
            'Xpress M2020': ['MLT-D111', 'D111'],
            'Xpress M2070': ['MLT-D111', 'D111'],
            'Xpress C460FW': ['CLT-406', 'K406', 'C406', 'M406', 'Y406'],
            // Brother
            'DCP-135C': ['LC37', 'LC-37'],
            'DCP 135C': ['LC37', 'LC-37'],
            'DCP-150C': ['LC37', 'LC-37'],
            'DCP-330C': ['LC37', 'LC-37'],
            'DCP-540CN': ['LC37', 'LC-37'],
            'DCP-J140W': ['LC77', 'LC-77', 'LC73', 'LC-73'],
            'DCP-J4110DW': ['LC133', 'LC-133'],
            'DCP J4110DW': ['LC133', 'LC-133'],
            'MFC-230C': ['LC37', 'LC-37'],
            'MFC-240C': ['LC37', 'LC-37'],
            'MFC-J615W': ['LC77', 'LC-77', 'LC73', 'LC-73'],
            'MFC-J4510DW': ['LC133', 'LC-133'],
            'MFC J4510DW': ['LC133', 'LC-133'],
            'HL-2140': ['TN2150', 'TN-2150', 'DR2125', 'DR-2125'],
            'HL-2240D': ['TN2250', 'TN-2250', 'DR2225', 'DR-2225'],
            'HL-3040CN': ['TN240', 'TN-240'],
            // Canon
            'PIXMA iP4850': ['CLI-526', 'PGI-525'],
            'PIXMA MG5150': ['CLI-526', 'PGI-525'],
            'PIXMA MG5250': ['CLI-526', 'PGI-525'],
            'MAXIFY MB2050': ['PGI-1600', 'PGI1600'],
            'MAXIFY MB2350': ['PGI-1600', 'PGI1600'],
            // HP
            'DeskJet 1000': ['HP 61', '61XL', 'CH561', 'CH563'],
            'DeskJet 2050': ['HP 61', '61XL', 'CH561', 'CH563'],
            'ENVY 4500': ['HP 61', '61XL'],
            'ENVY 5530': ['HP 564', '564XL'],
            'OfficeJet 4630': ['HP 61', '61XL'],
            'LaserJet P1102': ['CE285A', '85A'],
            'LaserJet Pro M1212nf': ['CE285A', '85A'],
            // Epson
            'XP-200': ['200', 'T200'],
            'XP-400': ['200', 'T200'],
            'XP-600': ['277', 'T277'],
            'WF-2520': ['200', 'T200'],
            'WF-2540': ['200', 'T200'],
            'WF-3520': ['252', 'T252'],
            'WF-7510': ['252', 'T252']
        },

        async loadPrinterModelProducts(navVersion) {
            this.showLoading(true);

            try {
                const printerModel = this.state.printerModel;
                // Use printerBrand (from ink-finder) or fallback to brand parameter
                const printerBrand = this.state.printerBrand || this.state.brand;
                const brandName = this.brandInfo[printerBrand]?.name || printerBrand || '';

                // Store printer model name for display
                this.state.printerModelDisplay = printerModel;

                let allProducts = [];
                let inkCodes = []; // Ink codes to search for (e.g., "LC37")

                // Get or create Supabase client - ensure it's properly initialized
                let supabaseClient = null;
                try {
                    if (typeof Auth !== 'undefined' && Auth.supabase) {
                        supabaseClient = Auth.supabase;
                    } else if (typeof supabase !== 'undefined' && supabase.createClient && typeof Config !== 'undefined' && Config.SUPABASE_URL && Config.SUPABASE_ANON_KEY) {
                        // Create our own client if Auth isn't ready
                        supabaseClient = supabase.createClient(Config.SUPABASE_URL, Config.SUPABASE_ANON_KEY);
                    }
                } catch (clientError) {
                    // Supabase client creation failed - will fall back to API search
                }

                // Strategy 1: Resolve printer slug, then use the dedicated printer-products
                // endpoint which strictly filters via product_compatibility (no fuzzy name match).
                let resolvedSlug = null;
                if (supabaseClient) {
                    try {
                        let printerData = null;

                        const exactResult = await supabaseClient
                            .from('printer_models')
                            .select('id, full_name, model_name, slug')
                            .ilike('full_name', printerModel)
                            .single();

                        if (exactResult.data) {
                            printerData = exactResult.data;
                        } else {
                            const partialResult = await supabaseClient
                                .from('printer_models')
                                .select('id, full_name, model_name, slug')
                                .ilike('full_name', `%${printerModel}%`)
                                .limit(1);

                            if (partialResult.data && partialResult.data.length > 0) {
                                printerData = partialResult.data[0];
                            } else {
                                const modelNameOnly = printerModel.replace(/^(BROTHER|CANON|EPSON|HP|SAMSUNG|LEXMARK|OKI|FUJI\s*XEROX|KYOCERA)\s+/i, '');

                                const modelResult = await supabaseClient
                                    .from('printer_models')
                                    .select('id, full_name, model_name, slug')
                                    .ilike('model_name', `%${modelNameOnly}%`)
                                    .limit(1);

                                if (modelResult.data && modelResult.data.length > 0) {
                                    printerData = modelResult.data[0];
                                }

                                if (!printerData) {
                                    const fullNamePartial = await supabaseClient
                                        .from('printer_models')
                                        .select('id, full_name, model_name, slug')
                                        .ilike('full_name', `%${modelNameOnly}%`)
                                        .limit(1);

                                    if (fullNamePartial.data && fullNamePartial.data.length > 0) {
                                        printerData = fullNamePartial.data[0];
                                    }
                                }
                            }
                        }

                        if (printerData?.slug) resolvedSlug = printerData.slug;
                    } catch (e) {
                        // Printer lookup failed - will fall back below
                    }
                }

                // Use canonical printer-products endpoint with the resolved slug —
                // strict compatibility filter (no fuzzy name matching).
                if (resolvedSlug) {
                    try {
                        const resp = await API.getProductsByPrinter(resolvedSlug, { limit: 200 });
                        if (resp.ok && resp.data) {
                            const list = resp.data.compatible_products || resp.data.products || [];
                            if (Array.isArray(list) && list.length > 0) {
                                // Belt-and-suspenders: the canonical endpoint returns
                                // brand as { name, slug }, but legacy responses ship
                                // brand as a bare string. Normalize so card rendering
                                // (product.brand?.name) works uniformly.
                                allProducts = list.map(p => {
                                    const brandObj = (typeof p.brand === 'string')
                                        ? { name: p.brand, slug: null }
                                        : (p.brand || null);
                                    return {
                                        ...p,
                                        brand: brandObj,
                                        brand_name: brandObj?.name || p.brand_name || '',
                                        brand_slug: brandObj?.slug || p.brand_slug || null
                                    };
                                });
                            }
                        }
                    } catch (e) {
                        // Dedicated endpoint failed - fall through to search fallbacks
                    }
                }

                // Strategy 2: Fallback - search-by-printer endpoint (also uses product_compatibility)
                if (allProducts.length === 0) {
                    try {
                        const printerResponse = await API.searchByPrinter(printerModel, { limit: 100 });
                        if (printerResponse.ok && printerResponse.data?.products) {
                            allProducts = printerResponse.data.products;
                        }
                    } catch (e) {
                        // searchByPrinter failed - continue to generic search
                    }
                }

                // Strategy 3: Fallback - smart search (backend now filters by matched_printer)
                if (allProducts.length === 0) {
                    try {
                        const smart = await API.smartSearch(printerModel, 100);
                        if (smart.ok && smart.data?.matched_printer && Array.isArray(smart.data.products)) {
                            allProducts = smart.data.products;
                        }
                    } catch (e) {
                        // smartSearch failed - fall through
                    }
                }

                // Strategy 4: Fallback - search by printer model name via generic API
                if (allProducts.length === 0) {

                    // Search for the printer model name
                    const searchResponse = await API.getProducts({ search: printerModel, limit: 100 });

                    if (searchResponse.ok && searchResponse.data?.products) {
                        allProducts = searchResponse.data.products;
                    }

                    // Also search for the brand name to get genuine products
                    if (brandName) {
                        const brandResponse = await API.getProducts({ search: brandName, limit: 100 });
                        if (brandResponse.ok && brandResponse.data?.products) {
                            // Merge and deduplicate by ID
                            const existingIds = new Set(allProducts.map(p => p.id));
                            const newProducts = brandResponse.data.products.filter(p => !existingIds.has(p.id));
                            allProducts = [...allProducts, ...newProducts];
                        }
                    }
                }

                // Check if navigation changed during fetch
                if (navVersion !== undefined && this.navigationVersion !== navVersion) return;

                // Use static product code mapping only as a fallback when
                // Strategies 1-3 returned no results from the database
                let filteredProducts = allProducts;

                if (allProducts.length === 0) {
                    const modelNameOnly = printerModel.replace(/^(BROTHER|CANON|EPSON|HP|SAMSUNG|LEXMARK|OKI|FUJI\s*XEROX|KYOCERA)\s+/i, '');
                    const compatibleCodes = this.printerProductCodes[printerModel]
                        || this.printerProductCodes[modelNameOnly]
                        || this.printerProductCodes[modelNameOnly.replace(/\s+/g, '-')]
                        || [];

                    if (compatibleCodes.length > 0 && supabaseClient) {
                        try {
                            for (const code of compatibleCodes) {
                                const { data: codeProducts } = await supabaseClient
                                    .from('products')
                                    .select('*, brand:brands(name, slug)')
                                    .ilike('name', `%${code}%`)
                                    .eq('is_active', true)
                                    .limit(100);

                                if (codeProducts && codeProducts.length > 0) {
                                    const existingIds = new Set(filteredProducts.map(p => p.id));
                                    const newProducts = codeProducts
                                        .filter(p => !existingIds.has(p.id))
                                        .map(p => ({ ...p, brand_name: p.brand?.name, brand_slug: p.brand?.slug }));
                                    filteredProducts = [...filteredProducts, ...newProducts];
                                }
                            }
                        } catch (e) {
                            // Static code search failed
                        }
                    }
                }

                if (filteredProducts.length > 0) {

                    // Trust product.source — backend canonical field (search audit, 2026-05-03).
                    const isCompatibleProduct = (product) => product.source === 'compatible';

                    let genuine = filteredProducts.filter(p => !isCompatibleProduct(p));
                    let compatible = filteredProducts.filter(p => isCompatibleProduct(p));

                    // Apply type filter if specified (from URL parameter)
                    if (this.state.type === 'genuine') {
                        compatible = []; // Hide compatible products
                    } else if (this.state.type === 'compatible') {
                        genuine = []; // Hide genuine products
                    }

                    // Update section titles with printer model
                    this.elements.compatibleTitleText.textContent = `Compatible Products for ${printerModel}`;
                    this.elements.genuineTitleText.textContent = `Original Products for ${printerModel}`;

                    // Render compatible first, then genuine
                    this.renderProducts(compatible, this.elements.compatibleProducts, this.elements.compatibleSection, true);
                    this.renderProducts(genuine, this.elements.genuineProducts, this.elements.genuineSection, false);

                    if (genuine.length === 0 && compatible.length === 0) {
                        this.showEmpty(`No compatible products found for ${printerModel}.`);
                    } else {
                        this.elements.levelProducts.hidden = false;
                    }
                } else {
                    this.showError(
                        `We couldn't load compatible products for ${this.state.printerModel}. The server may be warming up — please try again.`,
                        (v) => this.loadPrinterModelProducts(v)
                    );
                }
            } catch (error) {
                DebugLog.error('Failed to load printer model products:', error);
                // Check if navigation changed
                if (navVersion !== undefined && this.navigationVersion !== navVersion) return;
                this.showError(
                    "We couldn't load products for this printer model. The server may be warming up — please try again.",
                    (v) => this.loadPrinterModelProducts(v)
                );
            }

            this.showLoading(false);
        },

        async loadSearchResults(navVersion) {
            this.showLoading(true);

            try {
                const searchQuery = this.state.search;
                // Page-based pagination — backend caps `limit` at 100 on every
                // search endpoint, so to surface the full result set ("compat"
                // returns 600+ rows) the frontend has to walk pages. We always
                // request `limit: 100` and pass `state.page` straight through;
                // the page number arrives via the URL and is wired through
                // parseURLState/updateURL so the back button works.
                const SEARCH_PAGE_SIZE = 100;
                const requestedPage = Math.max(1, parseInt(this.state.page, 10) || 1);

                // ─────────────────────────────────────────────────────────────
                // Branch decision: which API path do we take?
                //
                // Single-path search: backend /smart owns intent classification
                // (`data.intent.type/category/source/matched_brand_slug`),
                // ribbon inclusion (intent.type==='ribbon' returns ribbon rows
                // inline at score 150), and source filtering (intent.source
                // populated from `genuine`/`compatible` queries — `q=genuine`
                // returns 1000 source=genuine rows). The pre-flight type-detect
                // and source-keyword shims plus the parallel `getRibbons`
                // refetch were retired 2026-05-11 once the backend search
                // contract shipped (Vieland verified live: ribbon=116 inline,
                // genuine=1000, compatible=911).
                let products = [];
                // Smart-search envelope (matched_printer / did_you_mean /
                // corrected_from / facets / pagination / intent / recovery).
                let smartData = null;
                let pagination = null;

                {
                    const response = await API.smartSearch(searchQuery, {
                        limit: SEARCH_PAGE_SIZE,
                        page: requestedPage,
                        include: 'compat,description'
                    });
                    if (navVersion !== undefined && this.navigationVersion !== navVersion) return;
                    smartData = (response && response.ok) ? (response.data || null) : null;
                    products = (smartData && Array.isArray(smartData.products)) ? smartData.products : [];
                    if (smartData && smartData.pagination && smartData.pagination.total_pages != null) {
                        pagination = smartData.pagination;
                    }

                    // matched_printer with no products → user typed a printer
                    // model and the backend has no compat-mapped cartridges.
                    // Hand off to the dedicated printer-products page so they
                    // get the strict view (which can fall back to brand-level
                    // recovery) instead of an ambiguous mixed result set.
                    if (products.length === 0 && smartData?.matched_printer?.slug) {
                        const p2 = smartData.matched_printer;
                        // Canonical printer URL per brand-canonical audit (May 2026):
                        // /shop?brand=<brand_slug>&printer_slug=<slug>. /smart's
                        // matched_printer payload carries brand_slug/brand_name;
                        // buildPrinterUrl slugifies the name as a last-resort
                        // fallback. If even that yields no brand_slug, we still
                        // emit the unbranded form (history-only URL — this is a
                        // user-already-typed-something flow, not an indexed
                        // anchor); a follow-up crawl 301s it via slug_redirects.
                        const branded = (typeof buildPrinterUrl === 'function')
                            ? buildPrinterUrl(p2)
                            : null;
                        const printerHref = branded
                            || (typeof buildPrinterUrl === 'function'
                                ? buildPrinterUrl(p2, { allowUnbranded: true })
                                : `/shop?printer_slug=${encodeURIComponent(p2.slug)}`);
                        history.replaceState({}, '', printerHref);
                        this.state.search = null;
                        this.state.printer = p2.slug;
                        this.state.printerName = p2.name || '';
                        this.state.level = 'printer-products';
                        await this.loadPrinterProducts(navVersion);
                        return;
                    }
                    // ── Reconcile /smart against the literal query ──────────
                    // /smart classifies "intent" and will autocorrect a query
                    // it judges ambiguous. The typeahead dropdown hits a
                    // different endpoint (/api/search/suggest — plain literal
                    // substring match), so the two surfaces could disagree.
                    // For numeric / short cartridge codes /smart's autocorrect
                    // misfires hard: q=511 → corrected_from:"511",
                    // did_you_mean:"Lexmark MX 511", and a result set of four
                    // Lexmark products that contain "511" NOWHERE — while the
                    // dropdown correctly shows the CL511 / CT3511xx family.
                    // We reconcile here so the results page shows what the
                    // dropdown promised. Pinned by
                    // tests/search-results-parity-may2026.test.js.
                    //
                    // Fallback fires in three cases, all routed through the
                    // same literal-substring path the dropdown uses:
                    //   hardMiss — /smart returned no products at all.
                    //   softMiss — digit query, /smart returned a thin (<50)
                    //              set with no printer match. Empirically
                    //              "650" makes /smart return only the ~15
                    //              cartridges with "(650 pages)" in their copy
                    //              and zero Canon PGI650 rows; /api/products
                    //              ?search=650 ships PGI650/PGI650XL via
                    //              substring matching on name+sku.
                    //   hijack   — /smart admits it corrected the query AND
                    //              none of its products literally match the
                    //              original input. A genuine typo ("cannon")
                    //              also trips this, but the literal endpoints
                    //              return zero rows for a typo so the swap is
                    //              declined and /smart's correction stands.
                    const queryHasDigits = /\d/.test(String(searchQuery || ''));
                    const smartCount = products.length;
                    const SOFT_MISS_THRESHOLD = 50;
                    const smartHasLiteralMatch = products.some(p => productMatchesQuery(p, searchQuery));
                    const smartCorrected = !!(smartData?.corrected_from || smartData?.did_you_mean);
                    const hardMiss = products.length === 0 && !smartData?.matched_printer;
                    const softMiss = queryHasDigits
                        && smartCount > 0
                        && smartCount < SOFT_MISS_THRESHOLD
                        && !smartData?.matched_printer
                        && !smartData?.did_you_mean;
                    const hijack = smartCorrected
                        && smartCount > 0
                        && !smartHasLiteralMatch
                        && !smartData?.matched_printer;
                    if (hardMiss || softMiss || hijack) {
                        // /api/products?search= → the full, paginated literal
                        // set. /api/search/suggest → the dropdown's exact
                        // ranked shortlist (incl. loose digit matches that
                        // /products misses, e.g. the "165.11" ribbon for
                        // q=511). Fired in parallel; suggest only on page 1
                        // (it is a typeahead endpoint with no pager).
                        const [fallback, suggestList] = await Promise.all([
                            API.getProducts({ search: searchQuery, limit: SEARCH_PAGE_SIZE, page: requestedPage }),
                            requestedPage === 1
                                ? API.searchSuggest(searchQuery, 20)
                                : Promise.resolve([]),
                        ]);
                        if (navVersion !== undefined && this.navigationVersion !== navVersion) return;
                        const fallbackProducts = (fallback?.ok && fallback.data?.products) ? fallback.data.products : [];
                        // Union dropdown shortlist + full literal set, dropdown
                        // order first, deduped — guarantees the results page is
                        // a superset of (never a subset of) the dropdown.
                        const merged = mergeLiteralResults(suggestList, fallbackProducts);
                        // /api/products?search=<digits> matches the digits as a
                        // bare substring, so e.g. q=220 drags in "220V" fuser
                        // kits, "(220 pages)" copy, and embedded codes
                        // (72200.01, IDK22205, 106R01220). For digit queries,
                        // strip those to genuine "220"-code products (keeps
                        // 220 + 220XL). Safety: never let the filter empty the
                        // set or trim it to nothing — fall back to `merged`.
                        let mergedUsed = merged;
                        let mergedFiltered = false;
                        if (queryHasDigits) {
                            const onTopic = merged.filter(p => queryCodeMatch(p, searchQuery));
                            if (onTopic.length > 0 && onTopic.length < merged.length) {
                                mergedUsed = onTopic;
                                mergedFiltered = true;
                            }
                        }
                        // hijack / hardMiss: any literal hit beats /smart's set
                        // (it is empty or provably wrong). softMiss: only swap
                        // when the literal set strictly out-counts /smart, so
                        // we never trade away a good ranking for a flat one.
                        const shouldUseFallback = (hijack || hardMiss)
                            ? mergedUsed.length > 0
                            : mergedUsed.length > smartCount;
                        if (shouldUseFallback) {
                            products = mergedUsed;
                            smartData = null;
                            // A filtered set is a curated single page — the
                            // backend's total_pages counts the unfiltered union,
                            // so suppress the pager to avoid phantom pages.
                            if (!mergedFiltered && fallback.meta && fallback.meta.total_pages != null) {
                                pagination = {
                                    total: fallback.meta.total,
                                    page: fallback.meta.page,
                                    limit: fallback.meta.limit,
                                    total_pages: fallback.meta.total_pages,
                                    has_next: !!fallback.meta.has_next,
                                    has_prev: !!fallback.meta.has_prev,
                                };
                            } else {
                                pagination = null;
                            }
                        }
                    }
                }


                // Spec §2.2 — banners for did-you-mean / corrected_from /
                // matched_printer must show on results AND on the empty state,
                // so render before either branch.
                //
                // did_you_mean sanity: when /smart kept its own products AND
                // those products literally match the query (e.g. q=664 →
                // real T664 cartridges plus a spurious did_you_mean:
                // "Triumph-Adler 64"), the correction banner contradicts the
                // results. Drop it — clone first so the SWR-cached envelope is
                // never mutated.
                let bannerData = smartData;
                if (smartData && smartData.did_you_mean && !smartData.matched_printer
                    && Array.isArray(smartData.products)
                    && smartData.products.some(p => productMatchesQuery(p, searchQuery))) {
                    bannerData = Object.assign({}, smartData, { did_you_mean: null });
                }
                this.renderSearchBanners(bannerData, searchQuery);

                // Spec §3.3 Case A — when /smart matched a printer, every
                // product in the pool is fits-the-printer. Tag for the card
                // renderer (mutates the array we render, not the API cache).
                if (smartData?.matched_printer?.name) {
                    const printerName = smartData.matched_printer.name;
                    for (const p of products) p._fitsPrinter = printerName;
                }

                // Backend intent: type/source/matched_brand_slug come from
                // /smart's `data.intent`. `isTypeQuery` is true when the user
                // typed a category-shaped query (`ribbon`, `toner`, …) — used
                // below to switch section titles to "Compatible Toner Products"
                // instead of "Compatible Products for 'toner'".
                const isTypeQuery = !!(smartData?.intent?.type);

                if (products.length > 0) {
                    let filteredProducts = products;

                    // Brand-narrowing: when /smart's intent classifier said the
                    // query named a single brand (e.g. "brother toner"), narrow
                    // the result set to that brand. The first-product fallback
                    // (used pre-2026-05-11) is gone — backend classifier is the
                    // single source of truth, so unranked soft-miss results
                    // never get spuriously brand-narrowed.
                    let detectedBrand = null;
                    if (!isTypeQuery) {
                        const intentBrand = smartData?.intent?.matched_brand_slug;
                        if (intentBrand && this.brandInfo[intentBrand]) {
                            const narrowed = products.filter(p => p.brand?.slug === intentBrand);
                            // Only narrow if the candidate brand actually
                            // dominates the result set (≥40%). Prevents a single
                            // Brother result in a mostly-Canon page from
                            // filtering out the Canon products.
                            if (narrowed.length >= Math.max(2, products.length * 0.4)) {
                                detectedBrand = intentBrand;
                                filteredProducts = narrowed;
                            }
                        }
                    }

                    // Separate genuine and compatible by `product.source` —
                    // backend canonical field. The previous fallback that
                    // checked `product.name.includes(this.compatiblePrefix)`
                    // was for legacy data that no longer exists.
                    const isCompatibleProduct = (product) => product.source === 'compatible';

                    let genuine = filteredProducts.filter(p => !isCompatibleProduct(p));
                    let compatible = filteredProducts.filter(p => isCompatibleProduct(p));

                    // Apply type filter if specified
                    if (this.state.type === 'genuine') {
                        compatible = [];
                    } else if (this.state.type === 'compatible') {
                        genuine = [];
                    }

                    // Update section titles
                    const brandDisplay = detectedBrand ? this.brandInfo[detectedBrand].name + ' ' : '';
                    const typeDisplay = isTypeQuery ? searchQuery.charAt(0).toUpperCase() + searchQuery.slice(1).toLowerCase() + ' ' : '';
                    this.elements.compatibleTitleText.textContent = isTypeQuery
                        ? `Compatible ${typeDisplay}Products`
                        : `${brandDisplay}Compatible Products for "${searchQuery}"`;
                    this.elements.genuineTitleText.textContent = isTypeQuery
                        ? `Original ${typeDisplay}Products`
                        : `${brandDisplay}Original Products for "${searchQuery}"`;


                    await this.displayProductInfo(filteredProducts, { skipPrinters: true });


                    if (navVersion !== undefined && this.navigationVersion !== navVersion) return;

                    // Render in /smart's API order — sortByRelevance is now
                    // server-side (May 2026 catalog hierarchy + relevance
                    // tiebreak), and bundle-pack pinning when matched_printer
                    // is set is also server-side. No client resort.
                    this.renderProducts(compatible, this.elements.compatibleProducts, this.elements.compatibleSection, true);
                    this.renderProducts(genuine, this.elements.genuineProducts, this.elements.genuineSection, false);

                    if (genuine.length === 0 && compatible.length === 0) {
                        this.renderSearchPagination(null);
                        await this.renderZeroResultsRecovery(searchQuery, navVersion, smartData);
                    } else {
                        this.elements.levelProducts.hidden = false;
                        this.renderSearchPagination(pagination);
                    }
                } else {
                    this.renderSearchPagination(null);
                    await this.renderZeroResultsRecovery(searchQuery, navVersion, smartData);
                }
            } catch (error) {
                DebugLog.error('Failed to search products:', error);
                if (navVersion !== undefined && this.navigationVersion !== navVersion) return;
                this.showError(
                    "We couldn't load search results. The server may be warming up — please try again.",
                    (v) => this.loadSearchResults(v)
                );
            }

            this.showLoading(false);
        },

        // Render the search-results pager beneath the genuine/compatible
        // grids. Backend caps `limit` at 100 on every search endpoint, so
        // queries with more than 100 hits ("compat" → 600+) need a real
        // pager — without one only the first 100 cards are reachable.
        //
        // Pagination shape is normalised in loadSearchResults to the
        // smart-search envelope: { total, page, limit, total_pages,
        // has_next, has_prev }. Pass `null` to tear down any existing pager.
        renderSearchPagination(pagination) {
            const existing = document.getElementById('search-pagination');
            if (existing) existing.remove();

            // Hide pager when there's only one page or no metadata.
            if (!pagination || pagination.total_pages == null || pagination.total_pages <= 1) return;

            const current = pagination.page;
            const total = pagination.total_pages;
            const limit = pagination.limit || 100;
            const totalItems = pagination.total != null ? pagination.total : 0;

            // Page-number range (1, 2, 3, …, last) — same algorithm as
            // products.js Products.renderPagination so the look matches the
            // shop pager.
            const range = (() => {
                if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
                if (current <= 3) return [1, 2, 3, 4, 5, '...', total];
                if (current >= total - 2) return [1, '...', total - 4, total - 3, total - 2, total - 1, total];
                return [1, '...', current - 1, current, current + 1, '...', total];
            })();

            const start = (current - 1) * limit + 1;
            const end = Math.min(current * limit, totalItems);

            const nav = document.createElement('nav');
            nav.id = 'search-pagination';
            nav.className = 'pagination search-pagination';
            nav.setAttribute('aria-label', 'Search results pagination');

            const pageButtons = range.map(p => {
                if (p === '...') return '<span class="pagination__ellipsis" aria-hidden="true">…</span>';
                const isActive = p === current;
                const ariaCurrent = isActive ? ' aria-current="page"' : '';
                return `<button type="button" class="pagination__btn pagination__btn--page${isActive ? ' active' : ''}" data-page="${p}"${ariaCurrent}>${p}</button>`;
            }).join('');

            nav.innerHTML = `
                <p class="pagination__info">
                    Showing ${start}–${end} of ${totalItems} products
                </p>
                <div class="pagination__controls">
                    <button type="button" class="pagination__btn pagination__btn--prev" data-page="${current - 1}"${pagination.has_prev ? '' : ' disabled'} aria-label="Previous page">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>
                        <span>Previous</span>
                    </button>
                    ${pageButtons}
                    <button type="button" class="pagination__btn pagination__btn--next" data-page="${current + 1}"${pagination.has_next ? '' : ' disabled'} aria-label="Next page">
                        <span>Next</span>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>
                    </button>
                </div>
            `;

            // Mount inside #level-products so the pager sits under both the
            // compatible and genuine sections, and so it gets cleared along
            // with the rest of the search-level DOM on the next navigation.
            this.elements.levelProducts.appendChild(nav);

            nav.querySelectorAll('.pagination__btn[data-page]').forEach(btn => {
                btn.addEventListener('click', () => {
                    if (btn.disabled) return;
                    const targetPage = parseInt(btn.dataset.page, 10);
                    if (!Number.isInteger(targetPage) || targetPage < 1) return;
                    if (targetPage === this.state.page) return;
                    this.state.page = targetPage;
                    this.updateURL();
                    this.navigationVersion++;
                    const v = this.navigationVersion;
                    // Scroll to the top of the results so the pager click
                    // doesn't leave the user mid-grid on the previous page.
                    const anchor = document.getElementById('search-banners')
                        || this.elements.levelProducts;
                    if (anchor && anchor.scrollIntoView) {
                        anchor.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    } else {
                        window.scrollTo({ top: 0, behavior: 'smooth' });
                    }
                    this.loadSearchResults(v);
                });
            });
        },

        // Spec §2.2 / §3.1 — render the corrected_from / did_you_mean /
        // matched_printer notices. Mounted just inside #level-products so the
        // banners appear above the genuine/compatible grids whether or not
        // we have results.
        renderSearchBanners(smartData, searchQuery) {
            // Tear down any previous banners on this load
            const existing = document.querySelector('#search-banners');
            if (existing) existing.remove();

            if (!smartData) return;

            const matchedPrinter = smartData.matched_printer;
            const didYouMean = smartData.did_you_mean;
            if (!matchedPrinter && !didYouMean) return;

            const wrap = document.createElement('div');
            wrap.id = 'search-banners';
            wrap.className = 'search-banners';

            // Hero banner — printer match takes precedence (spec §3.1).
            if (matchedPrinter && matchedPrinter.name) {
                const total = smartData.total != null ? smartData.total : (Array.isArray(smartData.products) ? smartData.products.length : 0);
                const subtext = total > 0
                    ? `${total} cartridge${total === 1 ? '' : 's'} available — genuine and compatible options below.`
                    : `Cartridges that fit your printer.`;
                const hero = document.createElement('div');
                hero.className = 'printer-hero';
                hero.innerHTML = `
                    <div class="printer-hero__icon" aria-hidden="true">
                        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>
                    </div>
                    <div class="printer-hero__body">
                        <h2 class="printer-hero__title">Cartridges for ${Security.escapeHtml(matchedPrinter.name)}</h2>
                        <p class="printer-hero__subtitle">${Security.escapeHtml(subtext)}</p>
                    </div>
                `;
                wrap.appendChild(hero);
            }

            // category-page-contract-may2026.md §3 — when did_you_mean is
            // present, the banner reads "Did you mean X?" with X linking to
            // /search?q=<encoded>. The previous "Showing similar results.
            // Search instead for X" copy was misleading: the original query
            // was never asked for again. The honest framing is the one the
            // backend already powers — both the zero-result fallback and the
            // weak-result fallback (May 2026, F1) populate did_you_mean, and
            // both branches share the same banner now.
            if (didYouMean) {
                const banner = document.createElement('div');
                banner.className = 'search-did-you-mean';
                banner.innerHTML = `
                    Did you mean
                    <a href="/search?q=${Security.escapeAttr(didYouMean)}"><strong>${Security.escapeHtml(didYouMean)}</strong></a>?
                `;
                wrap.appendChild(banner);
            }

            // Insert at the top of #level-products (which holds the grids).
            const host = this.elements.levelProducts;
            if (host) host.insertBefore(wrap, host.firstChild);
        },

        // Spec §2.3 — recovery rails when /smart returns no products.
        // Three rails: (1) compatible printers for SKU-shaped queries,
        // (2) cartridges-for-your-printer via /by-printer,
        // (3) static popular categories.
        async renderZeroResultsRecovery(query, navVersion, smartData) {
            // Hide both genuine/compatible sections; we'll render our own UI.
            this.elements.compatibleSection.hidden = true;
            this.elements.genuineSection.hidden = true;
            this.elements.empty.hidden = true;
            this.elements.levelProducts.hidden = false;

            // Tear down any previous recovery panel
            const old = document.querySelector('#search-recovery');
            if (old) old.remove();

            const panel = document.createElement('div');
            panel.id = 'search-recovery';
            panel.className = 'search-recovery';
            panel.innerHTML = `
                <div class="search-recovery__head">
                    <h2 class="search-recovery__title">No results for “${Security.escapeHtml(query)}”</h2>
                    <p class="search-recovery__subtitle">Here are some ways to find what you need.</p>
                </div>
                <div class="search-recovery__rails"></div>
            `;
            const railsHost = panel.querySelector('.search-recovery__rails');
            this.elements.levelProducts.appendChild(panel);

            // Backend `data.recovery.rails[]` lists exactly which rails to
            // fire (compat-printers when SKU lookup hit ≥1 printer, by-printer
            // when /by-printer would return ≥1 product). Pre-2026-05-11 we
            // ran a `looksLikeSku` regex + always-fire-by-printer heuristic;
            // both retired now that backend tells us upfront.
            const backendRails = Array.isArray(smartData?.recovery?.rails)
                ? smartData.recovery.rails
                : [];

            // The compat-printers rail ships its `printers: [...]` inline, so
            // we skip the second `API.getCompatiblePrinters` round-trip when
            // the payload is present. Same for `popular` (products inline).
            // by-printer still needs a follow-up fetch for the product cards.
            const railPromises = [];
            for (const rail of backendRails) {
                if (rail.kind === 'compat-printers') {
                    if (Array.isArray(rail.printers)) {
                        railPromises.push(Promise.resolve({ kind: 'compat', data: { compatible_printers: rail.printers } }));
                    } else {
                        const sku = rail.sku || query;
                        railPromises.push(
                            API.getCompatiblePrinters(sku)
                                .then(r => ({ kind: 'compat', data: r?.ok ? r.data : null }))
                                .catch(() => ({ kind: 'compat', data: null }))
                        );
                    }
                } else if (rail.kind === 'by-printer') {
                    const q = rail.query || query;
                    railPromises.push(
                        API.searchByPrinter(q, { limit: 6 })
                            .then(r => ({ kind: 'by-printer', data: r?.ok ? r.data : null }))
                            .catch(() => ({ kind: 'by-printer', data: null }))
                    );
                }
                // 'popular' rail handled below as the safety net (backend may
                // also ship `rail.products` inline; we render the curated
                // category tiles regardless).
            }

            const results = await Promise.all(railPromises);
            if (navVersion !== undefined && this.navigationVersion !== navVersion) return;

            let renderedAny = false;

            for (const r of results) {
                if (r.kind === 'compat') {
                    const printers = (r.data && Array.isArray(r.data.compatible_printers)) ? r.data.compatible_printers : [];
                    if (printers.length === 0) continue;
                    const cards = printers.slice(0, 4).map(p => {
                        const name = Security.escapeHtml(p.name || p.full_name || p.model_name || '');
                        // Canonical printer URL per brand-canonical audit (May
                        // 2026): /shop?brand=&printer_slug=. compatible_printers
                        // ships brand.slug + brand_name, so buildPrinterUrl in
                        // strict mode always yields the branded shape. If a
                        // future payload is missing brand, hide the card rather
                        // than emit a non-canonical <a> (these tiles are
                        // publicly indexed via /shop search-result pages).
                        const href = (typeof buildPrinterUrl === 'function')
                            ? buildPrinterUrl(p)
                            : null;
                        if (!href) return '';
                        return `<a class="recovery-printer-card" href="${Security.escapeAttr(href)}">
                                    <span class="recovery-printer-card__name">${name}</span>
                                </a>`;
                    }).filter(Boolean).join('');
                    if (!cards) continue;
                    renderedAny = true;
                    railsHost.insertAdjacentHTML('beforeend', `
                        <section class="search-recovery__rail">
                            <h3 class="search-recovery__rail-title">This cartridge fits these printers</h3>
                            <div class="search-recovery__rail-grid">${cards}</div>
                        </section>
                    `);
                } else if (r.kind === 'by-printer') {
                    const list = (r.data && Array.isArray(r.data.products)) ? r.data.products : [];
                    if (list.length === 0) continue;
                    renderedAny = true;
                    const cards = list.slice(0, 6).map((p, i) => Products.renderCard(p, i)).join('');
                    railsHost.insertAdjacentHTML('beforeend', `
                        <section class="search-recovery__rail">
                            <h3 class="search-recovery__rail-title">Cartridges for your printer</h3>
                            <div class="search-recovery__rail-grid product-grid">${cards}</div>
                        </section>
                    `);
                }
            }

            // Rail 3: popular categories — always render as the safety net.
            const popular = [
                { label: 'Brother Ink',   href: '/shop?brand=brother&category=ink' },
                { label: 'HP Toner',      href: '/shop?brand=hp&category=toner' },
                { label: 'Canon Ink',     href: '/shop?brand=canon&category=ink' },
                { label: 'Epson Ink',     href: '/shop?brand=epson&category=ink' },
                { label: 'Samsung Toner', href: '/shop?brand=samsung&category=toner' },
                { label: 'OKI Toner',     href: '/shop?brand=oki&category=toner' },
            ];
            const popularCards = popular.map(p =>
                `<a class="recovery-tile" href="${Security.escapeAttr(p.href)}">${Security.escapeHtml(p.label)}</a>`
            ).join('');
            railsHost.insertAdjacentHTML('beforeend', `
                <section class="search-recovery__rail">
                    <h3 class="search-recovery__rail-title">Browse popular categories</h3>
                    <div class="search-recovery__rail-grid">${popularCards}</div>
                </section>
            `);

            // Bind add-to-cart on any product cards in the by-printer rail
            if (typeof Products !== 'undefined' && Products.attachCardListeners) {
                Products.attachCardListeners(railsHost);
            }

            // If even the popular tiles didn't render (unreachable, but safe),
            // fall back to the legacy empty state.
            if (!renderedAny && railsHost.children.length === 0) {
                panel.remove();
                this.showEmpty(`No products found for "${query}".`);
            }
        },

        // Get color style (delegates to shared ProductColors utility)
        getColorStyle(colorName) {
            // Use shared utility with default gray fallback for unknown colors
            return ProductColors.getStyle(colorName, 'background-color: #e0e0e0;');
        },

        // Check if product is a value pack / multi-pack
        isValuePack(product) {
            const name = (product.name || '').toLowerCase();
            const color = (product.color || '').toLowerCase();

            // Check for value packs / multi-packs
            if (name.includes('value pack') || name.includes('combo') || name.includes('bundle') ||
                name.includes('multi') || name.includes('-pack') || name.includes(' pack')) {
                return true;
            }

            // Check for multi-color (CMY, BCMY, etc.)
            if (color === 'cmy' || color === 'bcmy' || color === 'cmyk' ||
                color.includes('tri-colo') || color === 'color' || color === 'colour') {
                return true;
            }

            return false;
        },

        // Render products with the canonical (code → yield → color) override.
        //
        // The May 2026 catalog overhaul makes the backend authoritative for
        // `(accessoryTier, yieldTier, seriesBase, colorOrder, packRank, name)`.
        // The storefront then imposes the customer-facing convention:
        //
        //   645    K, C, M, Y, CMY, KCMY      ← std yield      row 1
        //   645XL  K, C, M, Y, CMY, KCMY      ← XL/HY yield    row 2
        //   645XXL K, C, M, Y, CMY, KCMY      ← XXL yield      row 3
        //
        // `ProductSort.byCodeThenColor` groups by familyKey (preserving
        // backend order between families), then forces yield ascending and
        // color into K→KCMY canonical order. `rowBreakIndices` returns the
        // boundaries where (familyKey, yieldTier) changes; we splice in a
        // zero-height flex breaker so each yield-code starts a fresh row in
        // the wrapping flex grid.
        //
        // Spec: readfirst/code-yield-grouping-may2026.md
        // Pinned by tests/code-yield-grouping-may2026.test.js.
        /**
         * Client-side comparator for the Filter & Sort sheet. Never computes or
         * mutates prices — it reads the backend's canonical `retail_price`
         * (GST-inclusive) and `name` only. Missing prices sink to the bottom in
         * both directions so a null price can't hijack the top of the list.
         */
        _sortProductsBy(list, mode) {
            const arr = list.slice();
            const priceOf = (p) => {
                const n = parseFloat(p.retail_price);
                return Number.isFinite(n) ? n : null;
            };
            const nameOf = (p) => (p.name || '').toLowerCase();
            const byPrice = (dir) => (a, b) => {
                const pa = priceOf(a); const pb = priceOf(b);
                if (pa === null && pb === null) return 0;
                if (pa === null) return 1;   // nulls last
                if (pb === null) return -1;
                return dir * (pa - pb);
            };
            switch (mode) {
                case 'price_asc':  arr.sort(byPrice(1)); break;
                case 'price_desc': arr.sort(byPrice(-1)); break;
                case 'name_asc':   arr.sort((a, b) => nameOf(a).localeCompare(nameOf(b))); break;
                case 'name_desc':  arr.sort((a, b) => nameOf(b).localeCompare(nameOf(a))); break;
            }
            return arr;
        },

        renderProducts(products, container, section, isCompatible = false, _options = {}) {
            container.innerHTML = '';

            // Mobile Filter & Sort refinements (mobile-ux-audit-jul2026 §2b).
            // Applied here so EVERY product-list level (code drilldown, printer,
            // printer-model, search results, paper) inherits it — they all funnel
            // through renderProducts. 'recommended' preserves the server-canonical
            // byCodeThenColor yield-grouping + row breaks; an explicit price/name
            // sort flattens to a single sorted run (grouping no longer applies).
            // The in-stock filter narrows `products` in place first so the
            // byCodeThenColor(products) grouping below still sees the same array.
            if (this.state.inStock) {
                products = products.filter((p) => {
                    const st = (typeof getStockStatus === 'function') ? getStockStatus(p) : null;
                    return !st || st.class === 'in-stock';
                });
            }

            if (products.length === 0) {
                section.hidden = true;
                return;
            }

            section.hidden = false;

            const sortMode = this.state.sort || 'recommended';
            let sortedProducts;
            let breaks;
            if (sortMode !== 'recommended') {
                sortedProducts = this._sortProductsBy(products, sortMode);
                breaks = new Set(); // flat sorted run — no yield-group row breaks
            } else {
                sortedProducts = (typeof ProductSort !== 'undefined' && ProductSort.byCodeThenColor)
                    ? ProductSort.byCodeThenColor(products)
                    : products;
                breaks = (typeof ProductSort !== 'undefined' && ProductSort.rowBreakIndices)
                    ? new Set(ProductSort.rowBreakIndices(sortedProducts))
                    : new Set();
            }

            sortedProducts.forEach((product, i) => {
                if (breaks.has(i)) {
                    const breaker = document.createElement('div');
                    breaker.className = 'products-row__break';
                    breaker.setAttribute('aria-hidden', 'true');
                    container.appendChild(breaker);
                }
                const card = this.createProductCard(product, isCompatible);
                container.appendChild(card);
            });

            // Bind image error fallback handlers
            if (typeof Products !== 'undefined' && Products.bindImageFallbacks) {
                Products.bindImageFallbacks(container);
            }
        },

        createProductCard(product, isCompatible) {
            const card = document.createElement('article');
            card.className = 'product-card';

            // Use retail_price from backend API
            const price = product.retail_price || 0;
            // Savings fields: backend now sends original_price + discount_amount +
            // discount_percent on every discounted product (May 2026 enrichment —
            // search-enrichment-may2026.md). Fall back to compare_price for
            // legacy responses (e.g. /by-printer RPC path may omit these). Never
            // compute the discount client-side when the backend has supplied the
            // canonical numbers — the backend does GST-aware rounding that a
            // client-side `compare - retail` won't replicate.
            const originalPrice = product.original_price != null
                ? product.original_price
                : (product.compare_price && product.compare_price > price ? product.compare_price : null);
            const discountAmount = product.discount_amount != null
                ? product.discount_amount
                : (originalPrice ? originalPrice - price : null);
            const discountPercent = product.discount_percent != null
                ? product.discount_percent
                : (originalPrice && originalPrice > 0 ? Math.round(((originalPrice - price) / originalPrice) * 100) : null);
            const showDiscount = originalPrice && originalPrice > price;

            // GST trust label is the static "Incl. GST" copy (no dollar
            // breakdown — pinned by tests/inc-gst-amount-removed.test.js).
            const stockStatus = getStockStatus(product);
            const inStock = stockStatus.class === 'in-stock';
            const brandName = product.brand?.name || '';
            const color = product.color || '';

            // Keep full product name including "Compatible" prefix; de-double the
            // redundant compact code token in genuine names (display only —
            // stored name/slug untouched). See ProductName in utils.js.
            const displayName = (typeof ProductName !== 'undefined') ? ProductName.clean(product) : (product.name || '');

            // Show product image if available, otherwise color block for compatible only, or placeholder for genuine
            const placeholderSvg = `<svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
                        <rect x="6" y="2" width="12" height="20" rx="2"/>
                        <path d="M9 6h6M9 10h6"/>
                    </svg>`;
            let imageContent;
            // Prefer the backend's optimized image fields (mobile-ux-audit-jul2026
            // §3a/§6), falling back to the hand-built /api/images/optimize URLs.
            // Must stay in parity with Products.getProductImageHTML (products.js).
            const resolvedImageUrl = product.image_thumbnail_url
                || (typeof storageUrl === 'function' ? storageUrl(product.image_url) : product.image_url);
            const srcsetAttr = product.image_srcset
                || (typeof imageSrcset === 'function' && product.image_url ? imageSrcset(product.image_url) : '');
            const sizesAttr = '(max-width: 480px) 200px, (max-width: 768px) 300px, 400px';
            const colorStyle = ProductColors.getProductStyle(product);
            // Get raw (non-optimized) image URL for fallback when optimization endpoint fails (429/error)
            const rawImageUrl = product.image_url && typeof storageUrlRaw === 'function' ? storageUrlRaw(product.image_url) : product.image_url;
            // Stale-swatch fallback — see Products.getProductImageHTML in
            // products.js for the rationale. We strip the static swatch image
            // and fall through to a freshly-styled color block whenever the
            // canonical `color` is set, so admin color edits propagate
            // visually without an image re-upload.
            const swatchStale = ProductColors.isPlaceholderSwatchImage(product.image_url) && colorStyle;
            if (resolvedImageUrl && resolvedImageUrl !== '/assets/images/placeholder-product.svg' && !swatchStale) {
                const srcsetHtml = srcsetAttr ? ` srcset="${Security.escapeAttr(srcsetAttr)}" sizes="${sizesAttr}"` : '';
                const rawAttr = rawImageUrl && rawImageUrl !== resolvedImageUrl ? ` data-raw-src="${Security.escapeAttr(rawImageUrl)}"` : '';
                if (colorStyle) {
                    imageContent = `<img src="${Security.escapeAttr(resolvedImageUrl)}" alt="${Security.escapeAttr(product.name)}"${srcsetHtml} loading="lazy" data-fallback="color-block"${rawAttr}>
                        <div class="product-card__color-block" style="${colorStyle}; display: none;"></div>`;
                } else {
                    imageContent = `<img src="${Security.escapeAttr(resolvedImageUrl)}" alt="${Security.escapeAttr(product.name)}"${srcsetHtml} loading="lazy" data-fallback="placeholder"${rawAttr}>`;
                }
            } else if (isCompatible) {
                imageContent = `<div class="product-card__color-block" style="${colorStyle || 'background-color: #1a1a1a;'}"></div>`;
            } else {
                imageContent = `<img src="/assets/images/placeholder-product.svg" alt="${Security.escapeAttr(product.name)}" loading="lazy">`;
            }

            // Check if product is already a favourite
            const isFav = typeof Favourites !== 'undefined' && Favourites.isFavourite && Favourites.isFavourite(product.id);

            // Spec §3.3 — "Fits Your Printer" badge when /smart matched a printer.
            const fitsPrinterBadge = product._fitsPrinter
                ? `<span class="product-card__badge product-card__badge--fits-printer" title="Fits ${Security.escapeAttr(product._fitsPrinter)}">Fits Your Printer</span>`
                : '';

            // source-chip-removal-may2026.md — the per-card
            // COMPATIBLE/GENUINE chip is retired. The section heading above
            // each grid (e.g. "Brother Compatible Inkjet Cartridges") and
            // the product name itself already declare source; the per-card
            // chip was redundant. The fits-printer chip keeps the top-left
            // chip-stack alive on its own.

            // Spec §4 — bundle-pack visual differentiation.
            const packTypeRibbon = (() => {
                const pt = (product.pack_type || '').toLowerCase();
                if (pt === 'value_pack') return `<span class="product-card__ribbon product-card__ribbon--value-pack">Value Pack</span>`;
                if (pt === 'multipack')  return `<span class="product-card__ribbon product-card__ribbon--multipack">Multipack</span>`;
                return '';
            })();

            // Prefer backend-supplied canonical_url (absolute). Reduce to a
            // path so router-based navigation stays in-app, falling back to the
            // legacy slug/sku reconstruction when canonical_url is missing.
            const cardHref = (() => {
                if (product.canonical_url) {
                    try { return new URL(product.canonical_url).pathname; }
                    catch (_) { return product.canonical_url; }
                }
                return product.slug && product.sku
                    ? `/products/${encodeURIComponent(product.slug)}/${encodeURIComponent(product.sku)}`
                    : `/p/${encodeURIComponent(product.sku || '')}`;
            })();

            // Info-row pills (rendered as a tight horizontal strip beneath the
            // image — never on top of the photo). Empty string when neither
            // pill applies, so the layout collapses cleanly. Free-shipping
            // qualification is delegated to qualifiesForFreeShipping (api.js)
            // so the threshold matches Config + cart + PDP surfaces.
            const showSavingsPill = showDiscount && discountAmount != null;
            const showFreeShipPill = qualifiesForFreeShipping(product);
            // FREE SHIPPING is rendered first so it always sits on the top
            // line of the info-row — gives a consistent visual baseline across
            // cards that have both pills vs only one.
            const infoRowHTML = (showSavingsPill || showFreeShipPill)
                ? `<div class="product-card__info-row">
                        ${showFreeShipPill ? '<span class="product-card__free-shipping">Free Shipping</span>' : ''}
                        ${showSavingsPill ? `<span class="product-card__savings">Save ${formatPrice(discountAmount)}${(discountPercent && !((product.pack_type || '').toString().toLowerCase() === 'value_pack' || (product.pack_type || '').toString().toLowerCase() === 'multipack')) ? ` (${discountPercent}%)` : ''}</span>` : ''}
                    </div>`
                : '';

            card.innerHTML = `
                <a href="${Security.escapeAttr(cardHref)}" class="product-card__link">
                    <div class="product-card__image-wrapper">
                        ${imageContent}
                        ${fitsPrinterBadge ? `<div class="product-card__chip-stack">${fitsPrinterBadge}</div>` : ''}
                        ${packTypeRibbon}
                    </div>
                    <div class="product-card__content">
                        ${infoRowHTML}
                        <h3 class="product-card__title" title="${Security.escapeAttr(displayName)}">${Security.escapeHtml(displayName)}</h3>
                        <div class="product-card__footer">
                            <div class="product-card__footer-row">
                                ${color ? `<span class="product-card__color">${Security.escapeHtml(color)}</span>` : '<span></span>'}
                                <span class="product-card__stock product-card__stock--${stockStatus.class}">${stockStatus.text}</span>
                            </div>
                            <div class="product-card__footer-row">
                                <div class="product-card__pricing">
                                    <span class="product-card__price">${formatPrice(price)}</span>
                                    ${showDiscount ? ` <span class="product-card__compare-price" aria-label="Was ${formatPrice(originalPrice)}">${formatPrice(originalPrice)}</span>` : ''}
                                    ${price > 0 ? `<span class="product-card__gst">Incl. GST</span>` : ''}
                                </div>
                                ${(() => {
                                    // contact-button-may2026.md — any OOS product
                                    // (out_of_stock, contact_us, or
                                    // stock_quantity≤0) renders ONE primary
                                    // "Contact us" CTA navigating to /contact. The
                                    // waitlist_available field is intentionally
                                    // ignored; the waitlist API stays mounted but
                                    // no UI surface calls it. Spec wants <a> for
                                    // anchor semantics; we render <button> because
                                    // the card is wrapped in a parent <a> and a
                                    // nested <a> auto-closes the outer one,
                                    // breaking the layout. The handler below
                                    // navigates to /contact and stops the bubble.
                                    const oos = product.in_stock === false
                                        || product.stock_status === 'out_of_stock'
                                        || product.stock_status === 'contact_us'
                                        || (product.in_stock === undefined && (product.stock_quantity || 0) <= 0);
                                    if (oos) {
                                        return `<button type="button"
                                                class="btn btn--primary btn--sm product-card__cart-btn product-card__contact-btn"
                                                data-action="contact"
                                                aria-label="Contact us about ${Security.escapeAttr(displayName)}">
                                            Contact us
                                        </button>`;
                                    }
                                    // type="button" — defensive against any future surface
                                    // (search dropdown, modal) that mounts the shop card list
                                    // inside a <form>. Bare <button> defaults to type="submit"
                                    // and would become an implicit-Enter target.
                                    // Pinned by tests/search-enter-key-may2026.test.js.
                                    return `<button type="button" class="btn btn--primary btn--sm product-card__cart-btn"
                                            data-product-id="${product.id}"
                                            aria-label="Add ${Security.escapeAttr(displayName)} to cart">
                                        Add to Cart
                                    </button>`;
                                })()}
                            </div>
                        </div>
                    </div>
                </a>
                <button type="button" class="favourite-btn product-card__fav-btn ${isFav ? 'favourite-btn--active' : ''}"
                        data-product-id="${Security.escapeAttr(product.id)}"
                        data-product-sku="${Security.escapeAttr(product.sku || '')}"
                        data-product-name="${Security.escapeAttr(displayName)}"
                        data-product-price="${Security.escapeAttr(price)}"
                        data-product-image="${Security.escapeAttr(resolvedImageUrl || '')}"
                        data-product-brand="${Security.escapeAttr(brandName)}"
                        data-product-color="${Security.escapeAttr(color)}"
                        aria-pressed="${isFav}"
                        title="${isFav ? 'Remove from favourites' : 'Add to favourites'}">
                    <svg class="favourite-btn__icon favourite-btn__icon--outline" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
                    </svg>
                    <svg class="favourite-btn__icon favourite-btn__icon--filled" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2">
                        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
                    </svg>
                </button>
            `;

            // Add cart button event listener.
            //   - Contact-us (OOS CTA per contact-button-may2026.md): navigate
            //     to /contact and stop the click bubbling up to the wrapping
            //     card-link <a> (which targets the PDP).
            //   - Add-to-cart: standard handler.
            const cartBtn = card.querySelector('.product-card__cart-btn');
            if (cartBtn && cartBtn.dataset.action === 'contact') {
                cartBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    window.location.href = '/contact';
                });
            } else if (cartBtn) {
                cartBtn.addEventListener('click', async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    await this.addToCart(product, cartBtn);
                });
            }

            return card;
        },

        // Add to cart functionality using Cart.addItem (server-first)
        async addToCart(product, button) {
            const originalText = button.textContent;
            button.textContent = 'Adding...';
            button.disabled = true;

            try {
                // Use Cart.addItem - server-first for authenticated users,
                // localStorage for guest users
                await Cart.addItem({
                    id: product.id,
                    name: product.name,
                    price: product.retail_price || 0,
                    sku: product.sku || '',
                    image: typeof storageUrl === 'function' ? storageUrl(product.image_url) : (product.image_url || ''),
                    brand: product.brand?.name || '',
                    color: product.color || '',
                    quantity: 1,
                    product_source: product.source || null
                });

                button.textContent = 'Added!';
                button.classList.add('btn--success');

                setTimeout(() => {
                    button.textContent = originalText;
                    button.classList.remove('btn--success');
                    button.disabled = false;
                }, 1500);
            } catch (error) {
                DebugLog.error('Add to cart error:', error);
                button.textContent = 'Error';
                button.classList.add('btn--error');

                setTimeout(() => {
                    button.textContent = originalText;
                    button.classList.remove('btn--error');
                    button.disabled = false;
                }, 2000);
            }
        },

        // =========================================
        // UI UPDATES
        // =========================================
        updateBreadcrumb() {
            const list = this.elements.breadcrumbList;
            list.innerHTML = '';

            // Always show Shop
            const shopItem = this.createBreadcrumbItem('Shop', this.state.level === 'brands', () => {
                this.navigateTo('brands');
            });
            list.appendChild(shopItem);

            // Brand level
            if (this.state.brand) {
                const brandName = this.brandInfo[this.state.brand]?.name || this.state.brand;
                const isCurrent = this.state.level === 'categories';
                const brandItem = this.createBreadcrumbItem(brandName, isCurrent, () => {
                    this.navigateTo('categories', { brand: this.state.brand });
                });
                list.appendChild(brandItem);
            }

            // Category level
            if (this.state.category) {
                const cat = this.categories.find(c => c.id === this.state.category);
                const catName = cat?.name || this.state.category;
                const isCurrent = this.state.level === 'codes';
                const catItem = this.createBreadcrumbItem(catName, isCurrent, () => {
                    this.navigateTo('codes', { category: this.state.category });
                });
                list.appendChild(catItem);
            }

            // Code level
            if (this.state.code) {
                const codeItem = this.createBreadcrumbItem(this.state.code, true);
                list.appendChild(codeItem);
            }

            // Printer level (special case for printer-based navigation)
            if (this.state.printer) {
                const printerItem = this.createBreadcrumbItem(this.state.printerName || this.state.printer, true);
                list.appendChild(printerItem);
            }

            // Printer model level (from ink finder)
            if (this.state.printerModel) {
                const printerModelItem = this.createBreadcrumbItem(this.state.printerModelDisplay || this.state.printerModel, true);
                list.appendChild(printerModelItem);
            }

            // Search results level
            if (this.state.search) {
                const searchItem = this.createBreadcrumbItem(`Search: "${this.state.search}"`, true);
                list.appendChild(searchItem);
            }

            this.updateSchemaLD();
        },

        updateSchemaLD() {
            const el = document.getElementById('shop-schema');
            if (!el) return;
            const base = 'https://www.inkcartridges.co.nz';
            const shopUrl = base + '/shop';
            const items = [
                { "@type": "ListItem", "position": 1, "name": "Home", "item": base + '/' },
                { "@type": "ListItem", "position": 2, "name": "Shop", "item": shopUrl }
            ];
            let pageUrl = shopUrl;
            let pageName = 'Shop Ink Cartridges & Toner NZ';
            if (this.state.brand) {
                const brandName = this.brandInfo?.[this.state.brand]?.name || this.state.brand;
                pageUrl = shopUrl + '?brand=' + encodeURIComponent(this.state.brand);
                pageName = brandName + ' Ink Cartridges';
                items.push({ "@type": "ListItem", "position": 3, "name": brandName, "item": pageUrl });
            }
            if (this.state.category) {
                const cat = this.categories?.find(c => c.id === this.state.category);
                const catName = cat?.name || this.state.category;
                // Canonical slug in the URL, internal id for the display name.
                pageUrl += (pageUrl.includes('?') ? '&' : '?') + 'category=' + encodeURIComponent(this.CATEGORY_CANONICAL_BY_INTERNAL[this.state.category] || this.state.category);
                pageName = pageName + ' \u2014 ' + catName;
                items.push({ "@type": "ListItem", "position": items.length + 1, "name": catName, "item": pageUrl });
            }
            el.textContent = JSON.stringify({
                "@context": "https://schema.org",
                "@type": "CollectionPage",
                "name": pageName,
                "url": pageUrl,
                // dateModified — May 2026 AI search readiness.
                // The backend prerender already emits MAX(items.updated_at)
                // for crawlers; AI agents that read the rendered DOM (Gemini
                // live, Bing live) should see a matching freshness signal
                // here instead of a stale, static stamp. The SPA doesn't
                // have a single MAX(updated_at), so render time is the
                // honest proxy — products were fetched moments ago.
                "dateModified": this._collectionDateModified(),
                "breadcrumb": { "@type": "BreadcrumbList", "itemListElement": items }
            });
        },

        // Returns MAX(updated_at) across products in the current view if
        // any product carries an updated_at field; falls back to render
        // time. Matches the contract in readfirst/ai-search-readiness-may2026.md.
        _collectionDateModified() {
            try {
                const pools = [this.allProducts, this.products, this.state?.products].filter(Array.isArray);
                let max = 0;
                for (const pool of pools) {
                    for (const p of pool) {
                        const t = p && p.updated_at ? Date.parse(p.updated_at) : NaN;
                        if (!isNaN(t) && t > max) max = t;
                    }
                }
                return new Date(max || Date.now()).toISOString();
            } catch (_) {
                return new Date().toISOString();
            }
        },

        createBreadcrumbItem(text, isCurrent, onClick = null) {
            const li = document.createElement('li');
            li.className = 'drilldown-breadcrumb__item';

            if (isCurrent) {
                li.classList.add('drilldown-breadcrumb__item--current');
                li.innerHTML = `<span>${text}</span>`;
            } else {
                const link = document.createElement('button');
                link.className = 'drilldown-breadcrumb__link';
                link.textContent = text;
                if (onClick) link.addEventListener('click', onClick);
                li.appendChild(link);
            }

            return li;
        },

        // Base product-type label for the current category, WITHOUT any
        // genuine/compatible prefix. The section headers add their own
        // "Compatible"/"Original" word, so they must use this base to avoid
        // "Compatible Compatible …" / "Original Original …" (MC audit, Jul 2026).
        getBaseProductTypeLabel() {
            const typeMap = {
                'ink': 'Inkjet Cartridges',
                'toner': 'Toner Cartridges',
                'consumable': 'Drums & Supplies',
                'paper': 'Paper'
            };
            return typeMap[this.state.category] || 'Cartridges';
        },

        // Product type label with the active type-filter prefix applied. Used by
        // updateSEO (single-heading contexts), NOT by the two section headers.
        getProductTypeLabel() {
            let label = this.getBaseProductTypeLabel();

            // Add type filter prefix if specified
            if (this.state.type === 'genuine') {
                label = 'Original ' + label;
            } else if (this.state.type === 'compatible') {
                label = 'Compatible ' + label;
            }

            return label;
        },

        // Update section titles + yield info. The "For Use In: …"
        // aggregation has been retired from list pages per
        // category-page-contract-may2026.md §2 — that block now lives
        // ONLY on the PDP. The skipPrinters parameter is kept for call-
        // site compatibility but is no longer load-bearing.
        async displayProductInfo(products, { skipPrinters = false } = {}) {
            this.elements.yieldBanner.hidden = true;

            const brandName = this.brandInfo[this.state.brand]?.name || this.state.brand || '';
            // Base label only — each header adds its own "Compatible"/"Original"
            // word, so using the prefixed label here produced "Brother Compatible
            // Compatible Inkjet Cartridges" under ?type= filters (MC audit).
            const productType = this.getBaseProductTypeLabel();

            this.elements.compatibleTitleText.textContent = `${brandName} Compatible ${productType}`;
            this.elements.genuineTitleText.textContent = `${brandName} Original ${productType}`;
        },

        updateSEO() {
            const BASE = 'https://www.inkcartridges.co.nz';
            const brand = this.state.brand;
            const category = this.state.category;
            const code = this.state.code;
            const brandName = this.brandInfo[brand]?.name || brand || '';
            // Keys are the INTERNAL tab ids (see this.categories).
            const categoryLabels = {
                ink: 'Ink Cartridges', toner: 'Toner Cartridges',
                consumable: 'Drums & Supplies', label_tape: 'Label Tape',
                paper: 'Photo Paper'
            };
            const catLabel = categoryLabels[category] || 'Printing Supplies';

            let title, description, canonical;

            // Canonical URL: lowercase brand/category/printer slugs (the consolidation
            // spec requires a single canonical form per page so Google doesn't see
            // /shop?brand=Canon and /shop?brand=canon as separate URLs). Product
            // codes preserve case (PG-540 etc.). Search 'q' preserves user input.
            //
            // Category-only states canonical to the dedicated landing URLs
            // (/ink-cartridges, /toner-cartridges) per brand-canonical audit
            // (May 2026). The backend's CollectionPage schema nominates these
            // URLs so the rendered page URL must match.
            const lc = (v) => (v == null ? v : String(v).toLowerCase());
            const isCategoryOnly = !brand && !code && !this.state.printer && !this.state.search;
            const categoryLandings = { ink: '/ink-cartridges', toner: '/toner-cartridges' };
            if (isCategoryOnly && category && categoryLandings[lc(category)]) {
                canonical = `${BASE}${categoryLandings[lc(category)]}`;
            } else {
                const params = new URLSearchParams();
                if (brand)                params.set('brand',        lc(brand));
                if (category)             params.set('category',     lc(this.CATEGORY_CANONICAL_BY_INTERNAL[category] || category));
                if (code)                 params.set('code',         code);
                if (this.state.printer)   params.set('printer_slug', lc(this.state.printer));
                if (this.state.search)    params.set('q',            this.state.search);
                const qs = params.toString() ? '?' + params.toString() : '';
                canonical = `${BASE}/shop${qs}`;
            }

            switch (this.state.level) {
                case 'categories':
                    title       = `${brandName} Ink Cartridges & Toner NZ | InkCartridges.co.nz`;
                    description = `Shop genuine and compatible ${brandName} ink cartridges, toner, and printing supplies. Free NZ-wide shipping over $100.`;
                    break;
                case 'codes':
                    title       = `${brandName} ${catLabel} NZ | InkCartridges.co.nz`;
                    description = `Browse all ${brandName} ${catLabel.toLowerCase()} — genuine and compatible options with free NZ shipping over $100.`;
                    break;
                case 'products': {
                    const codeStr = code ? code.replace(/-/g, ' ').toUpperCase() : '';
                    title       = `${brandName} ${codeStr} ${catLabel} NZ | InkCartridges.co.nz`;
                    description = `Shop ${brandName} ${codeStr} ${catLabel.toLowerCase()} — genuine and compatible. Free NZ shipping over $100.`;
                    break;
                }
                case 'search-results':
                    title       = `Search: "${this.state.search}" | InkCartridges.co.nz`;
                    description = `Search results for "${this.state.search}" — ink cartridges, toner, and printing supplies NZ.`;
                    break;
                case 'printer-products':
                case 'printer-model-products': {
                    const printerDisplay = this.state.printerModelDisplay || this.state.printerModel || this.state.printer || '';
                    const pBrandName = this.state.printerBrand
                        ? (this.brandInfo[this.state.printerBrand]?.name || this.state.printerBrand) : '';
                    const printerFull = [pBrandName, printerDisplay].filter(Boolean).join(' ');
                    title       = `Compatible Ink for ${printerFull} NZ | InkCartridges.co.nz`;
                    description = `Shop compatible ink cartridges for the ${printerFull}. Free NZ-wide shipping over $100.`;
                    break;
                }
                default: // brands level
                    title       = 'Shop Ink Cartridges & Toner NZ | InkCartridges.co.nz';
                    description = 'Browse all printing supplies — ink cartridges, toner, drums and accessories. Filter by brand, type, and compatibility.';
                    // No canonical overwrite here (IA reorg Jul 2026): the
                    // category-only landings run at the brands level too (the
                    // S0.3 brand picker), and a hardcoded `${BASE}/shop` was
                    // stomping their computed canonical (/ink-cartridges,
                    // /shop?category=drums, …). The builder above already
                    // yields `${BASE}/shop` when no filter is set.
            }

            document.title = title;

            const set = (id, attr, val) => { const el = document.getElementById(id); if (el) el[attr] = val; };
            set('meta-description', 'content', description);
            set('og-title',         'content', title);
            set('og-description',   'content', description);
            set('og-url',           'content', canonical);
            set('canonical-url',    'href',    canonical);
            // Keep hreflang alternates pointed at the live canonical (single
            // locale, self-referential) so filtered views don't go stale.
            set('hreflang-en',      'href',    canonical);
            set('hreflang-default', 'href',    canonical);

            // Update JSON-LD CollectionPage schema
            const schemaEl = document.getElementById('shop-schema');
            if (schemaEl) {
                const breadcrumbItems = [
                    { "@type": "ListItem", "position": 1, "name": "Home", "item": `${BASE}/` },
                    { "@type": "ListItem", "position": 2, "name": "Shop", "item": `${BASE}/shop` }
                ];
                if (brandName) breadcrumbItems.push({ "@type": "ListItem", "position": 3, "name": brandName, "item": canonical });
                if (catLabel && brandName) breadcrumbItems.push({ "@type": "ListItem", "position": 4, "name": catLabel, "item": canonical });

                schemaEl.textContent = JSON.stringify({
                    "@context": "https://schema.org",
                    "@type": "CollectionPage",
                    "name": title.replace(' | InkCartridges.co.nz', ''),
                    "description": description,
                    "url": canonical,
                    "breadcrumb": { "@type": "BreadcrumbList", "itemListElement": breadcrumbItems }
                }, null, 2);
            }

            // Noindex deep filter combinations to avoid thin content
            let robotsMeta = document.querySelector('meta[name="robots"]');
            if (brand && category && code) {
                if (!robotsMeta) {
                    robotsMeta = document.createElement('meta');
                    robotsMeta.name = 'robots';
                    document.head.appendChild(robotsMeta);
                }
                robotsMeta.content = 'noindex, follow';
            } else if (robotsMeta) {
                robotsMeta.content = 'index, follow';
            }

            // SERP title + meta-description parity (seo-meta-rewrite-may2026).
            // The strings set above are the immediate, no-network values and
            // remain authoritative for surfaces that have NO bot prerender
            // (search results, code-filtered/deep-filter views, category-only
            // /shop). For the prerendered surfaces (/shop landing, brand hub,
            // printer hub, /ink-cartridges, /toner-cartridges) SeoMeta mirrors
            // the backend's exact <title>/<meta name=description> so the SPA
            // render is byte-identical to what crawlers are served (no cloaking
            // penalty). SeoMeta derives the surface + prerender endpoint from
            // window.location and is a no-op when there is no prerender. The
            // hints feed only the fail-open fallback copy (prerender down).
            if (typeof SeoMeta !== 'undefined') {
                const printerFull = [
                    this.state.printerBrand
                        ? (this.brandInfo[this.state.printerBrand]?.name || this.state.printerBrand)
                        : '',
                    this.state.printerModelDisplay || this.state.printerModel || this.state.printer || '',
                ].filter(Boolean).join(' ');
                SeoMeta.render({
                    hints: {
                        brand: brandName || null,
                        printer: printerFull || null,
                    },
                });
            }
        },

        updateTitle() {
            // Hide product type label by default
            this.elements.productTypeLabel.hidden = true;

            if (this.state.level === 'products' || this.state.level === 'printer-products' || this.state.level === 'printer-model-products' || this.state.level === 'search-results') {
                // Hide main title on products level (keep accessible for SEO)
                this.elements.title.hidden = false;
                this.elements.title.classList.add('visually-hidden');

                // Show product type inline with breadcrumb
                let productType = this.getProductTypeLabel();
                if (this.state.level === 'printer-products') {
                    const name = this.state.printerName || this.state.printer || '';
                    productType = name ? `Compatible Ink for ${name}` : 'Compatible Ink';
                } else if (this.state.level === 'printer-model-products') {
                    productType = this.state.printerModelDisplay || this.state.printerModel || 'Products';
                } else if (this.state.level === 'search-results') {
                    productType = `Search Results for "${this.state.search}"`;
                }
                this.elements.productTypeLabel.textContent = productType;
                this.elements.productTypeLabel.hidden = false;
                // Note: yieldBanner is shown/hidden by displayProductInfo based on data
            } else {
                // Hide yield banner on non-product levels
                this.elements.yieldBanner.hidden = true;

                const titles = {
                    categories: `${this.brandInfo[this.state.brand]?.name || ''} - Select a Category`,
                    codes: `Select a Product Code`
                };

                const titleText = titles[this.state.level] || '';
                if (titleText) {
                    this.elements.title.textContent = titleText;
                    this.elements.title.hidden = false;
                    this.elements.title.classList.remove('visually-hidden');
                } else {
                    // Brands level — visible H1 for SEO and heading hierarchy
                    this.elements.title.textContent = 'Shop Ink Cartridges & Toner NZ';
                    this.elements.title.hidden = false;
                    this.elements.title.classList.remove('visually-hidden');
                }
            }
        }
    };

    // Initialize when DOM is ready
    document.addEventListener('DOMContentLoaded', () => {
        DrilldownNav.init();
    });
