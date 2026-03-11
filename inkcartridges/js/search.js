/**
 * SEARCH.JS
 * =========
 * Smart search autocomplete dropdown with product card grid.
 * Replaces the basic text-list autocomplete from main.js.
 *
 * Factory pattern: SmartSearch.init(form, input) creates independent instances,
 * each with its own dropdown, cache, and keyboard nav state.
 */

const searchConfig = {
    apiUrl: '/api/search/smart',
    minChars: 1,
    debounceMs: 200,
    maxResults: 100,
    cacheMaxAge: 5 * 60 * 1000,
    cacheMaxSize: 50,
    skeletonCount: 6,

    buildShopUrl(product, query) {
        const params = new URLSearchParams();
        if (query) params.set('search', query);

        const brand = product.brand?.name ?? product.brand ?? '';
        if (brand) params.set('brand', String(brand));

        const code = product.sku ?? product.code ?? product.product_code ?? '';
        if (code) params.set('code', String(code));

        const category = product.category?.name ?? product.category ?? '';
        if (category) params.set('category', String(category));

        return '/html/shop?' + params.toString();
    }
};

let _smartSearchInstanceId = 0;

function createSmartSearch() {
    const instanceId = _smartSearchInstanceId++;

    const instance = {
        _form: null,
        _input: null,
        _dropdown: null,
        _grid: null,
        _footer: null,
        _correctionBanner: null,
        _activeCorrection: null,
        _cache: new Map(),
        _debounceTimer: null,
        _selectedIndex: -1,
        _results: [],
        _currentQuery: '',
        _effectiveQuery: '',
        _isVisible: false,
        _scrollCleanup: null,
        _instanceId: instanceId,

        _init(searchForm, searchInput) {
            this._form = searchForm;
            this._input = searchInput;

            // Remove old autocomplete dropdown if present
            const old = searchForm.querySelector('.search-autocomplete');
            if (old) old.remove();

            // Ensure form is a positioning context
            const formPos = window.getComputedStyle(searchForm).position;
            if (formPos === 'static') {
                searchForm.style.position = 'relative';
            }

            this._createDropdown();
            this._setupARIA();
            this._bindEvents();
        },

        _createDropdown() {
            const listboxId = 'smart-search-listbox-' + this._instanceId;

            this._dropdown = document.createElement('div');
            this._dropdown.className = 'smart-search-dropdown';
            this._dropdown.id = listboxId;
            this._dropdown.setAttribute('role', 'listbox');
            this._dropdown.setAttribute('aria-label', 'Search results');

            this._correctionBanner = document.createElement('div');
            this._correctionBanner.className = 'smart-search__correction is-hidden';

            this._grid = document.createElement('div');
            this._grid.className = 'smart-search__grid';

            this._footer = document.createElement('div');
            this._footer.className = 'smart-search__footer is-hidden';

            this._dropdown.appendChild(this._correctionBanner);
            this._dropdown.appendChild(this._grid);
            this._dropdown.appendChild(this._footer);
            this._form.appendChild(this._dropdown);
        },

        _setupARIA() {
            const listboxId = 'smart-search-listbox-' + this._instanceId;
            this._input.setAttribute('role', 'combobox');
            this._input.setAttribute('aria-expanded', 'false');
            this._input.setAttribute('aria-controls', listboxId);
            this._input.setAttribute('aria-autocomplete', 'list');
            this._input.setAttribute('aria-haspopup', 'listbox');
        },

        _bindEvents() {
            this._input.addEventListener('input', () => this._onInput());
            this._input.addEventListener('keydown', (e) => this._onKeydown(e));
            this._grid.addEventListener('click', (e) => this._onCardClick(e));

            document.addEventListener('click', (e) => {
                if (this._isVisible && !this._form.contains(e.target)) {
                    this._hide();
                }
            });

            this._input.addEventListener('focus', () => {
                if (this._results.length > 0 && this._input.value.trim().length >= searchConfig.minChars) {
                    this._show();
                }
            });
        },

        // --- Input handling ---

        _onInput() {
            const query = this._input.value.trim();
            clearTimeout(this._debounceTimer);

            if (query.length < searchConfig.minChars) {
                this._hide();
                this._currentQuery = '';
                return;
            }

            this._debounceTimer = setTimeout(() => this._executeSearch(query), searchConfig.debounceMs);
        },

        async _executeSearch(query) {
            this._currentQuery = query;
            this._hideCorrection();

            // Step 1: Normalize the query (silent, always runs)
            let searchQuery = query;
            let normalizeResult = null;
            if (typeof SearchNormalize !== 'undefined') {
                normalizeResult = SearchNormalize.normalize(query);
                searchQuery = normalizeResult.normalized;
            }
            this._effectiveQuery = searchQuery;

            const cached = this._getCached(searchQuery);
            if (cached) {
                if (normalizeResult && normalizeResult.changed) {
                    this._showCorrection(query, searchQuery, 'normalize');
                }
                this._renderResults(cached.products, searchQuery, cached.total);
                return;
            }

            this._renderSkeletons();
            this._show();

            try {
                let result = await this._fetchResults(searchQuery);
                if (query !== this._currentQuery) return;

                // Step 2: If results found, show them (with normalize banner if changed)
                if (result && result.products && result.products.length > 0) {
                    this._setCache(searchQuery, result);
                    if (normalizeResult && normalizeResult.changed) {
                        this._showCorrection(query, searchQuery, 'normalize');
                    }
                    this._renderResults(result.products, searchQuery, result.total);
                    return;
                }

                // Step 2b: If normalization changed the query and got 0 results, retry with original
                if (normalizeResult && normalizeResult.changed) {
                    result = await this._fetchResults(query);
                    if (query !== this._currentQuery) return;

                    if (result && result.products && result.products.length > 0) {
                        this._setCache(query, result);
                        this._renderResults(result.products, query, result.total);
                        return;
                    }
                }

                // Step 3: No results — try spelling correction
                if (typeof SearchNormalize !== 'undefined') {
                    const spellingResult = SearchNormalize.correctSpelling(searchQuery);
                    if (spellingResult.didCorrect) {
                        result = await this._fetchResults(spellingResult.corrected);
                        if (query !== this._currentQuery) return;

                        if (result && result.products && result.products.length > 0) {
                            this._effectiveQuery = spellingResult.corrected;
                            this._setCache(spellingResult.corrected, result);
                            this._showCorrection(searchQuery, spellingResult.corrected, 'spelling');
                            this._renderResults(result.products, spellingResult.corrected, result.total);
                            return;
                        }
                    }

                    // Step 4: Try NZ/US spelling alternative
                    const alt = SearchNormalize.getSpellingAlternative(searchQuery);
                    if (alt) {
                        result = await this._fetchResults(alt);
                        if (query !== this._currentQuery) return;

                        if (result && result.products && result.products.length > 0) {
                            this._effectiveQuery = alt;
                            this._setCache(alt, result);
                            this._showCorrection(searchQuery, alt, 'normalize');
                            this._renderResults(result.products, alt, result.total);
                            return;
                        }
                    }
                }

                // Step 5: Try printer model lookup — find compatible products
                const printerResult = await this._fetchByPrinterModel(query);
                if (query !== this._currentQuery) return;
                if (printerResult && printerResult.products.length > 0) {
                    this._setCache(query, printerResult);
                    this._showCorrection(query, 'compatible products for ' + printerResult.printerName, 'normalize');
                    this._renderResults(printerResult.products, query, printerResult.total);
                    return;
                }

                // No results from any path
                this._renderEmpty(query);
            } catch (err) {
                if (query !== this._currentQuery) return;
                this._renderError();
            }
        },

        async _fetchResults(query) {
            let allProducts = [];
            let productTotal = 0;

            // Detect product-type keywords (e.g. "ribbon", "toner") — fetch ALL of that type
            const typeDetection = (typeof SearchNormalize !== 'undefined' && SearchNormalize.detectProductType)
                ? SearchNormalize.detectProductType(query) : null;
            const isTypeQuery = typeDetection !== null;

            // Build API params — type queries use category/type filters, normal queries use search
            const productParams = isTypeQuery
                ? { ...typeDetection.productParams, limit: searchConfig.maxResults }
                : { search: query, limit: searchConfig.maxResults };

            // Only fetch ribbons for normal searches or ribbon-specific type queries
            const shouldFetchRibbons = !isTypeQuery || typeDetection.fetchRibbons;
            const ribbonParams = shouldFetchRibbons
                ? (isTypeQuery ? { limit: searchConfig.maxResults } : { search: query, limit: searchConfig.maxResults })
                : null;

            // Use smart search for normal text queries (better full-text matching),
            // fall back to getProducts for type-specific queries (category/type filters)
            const useSmartSearch = !isTypeQuery && typeof API.smartSearch === 'function';
            const fetchPromises = useSmartSearch
                ? [API.smartSearch(query, searchConfig.maxResults)]
                : [API.getProducts(productParams)];
            if (ribbonParams) fetchPromises.push(API.getRibbons(ribbonParams));

            const [productRes, ribbonRes] = await Promise.allSettled(fetchPromises);

            // Collect product results
            if (productRes.status === 'fulfilled' && productRes.value.ok && productRes.value.data) {
                const data = productRes.value.data;
                const products = data.products || data || [];
                productTotal = data.pagination?.total ?? data.total ?? products.length;
                if (Array.isArray(products)) allProducts = products;
            }

            // Merge ribbon results (deduplicate by SKU)
            let ribbonTotal = 0;
            if (ribbonRes && ribbonRes.status === 'fulfilled' && ribbonRes.value.ok && ribbonRes.value.data) {
                const data = ribbonRes.value.data;
                let ribbons = data.ribbons || data.products || (Array.isArray(data) ? data : []);
                if (!Array.isArray(ribbons)) ribbons = [];
                ribbonTotal = data.pagination?.total ?? data.total ?? ribbons.length;

                // Client-side filter: only keep ribbons whose name/sku match the query
                // Skip for type queries — we already fetched ALL ribbons intentionally
                if (!isTypeQuery) {
                    const qWords = query.toLowerCase().split(/\s+/).filter(Boolean);
                    ribbons = ribbons.filter(r => {
                        const name = (r.name || '').toLowerCase();
                        const sku = (r.sku || '').toLowerCase();
                        return qWords.every(w => name.includes(w) || sku.includes(w));
                    });
                }

                // Normalize ribbon fields to match product schema
                for (const ribbon of ribbons) {
                    ribbon._isRibbon = true;
                    if (!ribbon.image_url && ribbon.image_path) {
                        ribbon.image_url = typeof storageUrl === 'function' ? storageUrl(ribbon.image_path) : ribbon.image_path;
                    }
                    if (ribbon.retail_price == null && ribbon.sale_price != null) {
                        ribbon.retail_price = ribbon.sale_price;
                    }
                    if (ribbon.in_stock == null && ribbon.stock_quantity != null) {
                        ribbon.in_stock = ribbon.stock_quantity > 0;
                    }
                    if (typeof ribbon.brand === 'string') {
                        ribbon.brand = { name: ribbon.brand };
                    }
                }

                const existingSkus = new Set(allProducts.map(p => p.sku));
                for (const ribbon of ribbons) {
                    if (ribbon.sku && !existingSkus.has(ribbon.sku)) {
                        existingSkus.add(ribbon.sku);
                        allProducts.push(ribbon);
                    }
                }
            }

            if (allProducts.length > 0) {
                const total = isTypeQuery
                    ? Math.max(allProducts.length, productTotal, ribbonTotal)
                    : productTotal + ribbonTotal;
                return { products: allProducts, total };
            }

            // 2-word noise-stripping fallback: if one word is a generic category term
            // (e.g. "ink LC-37"), retry with just the specific product code
            if (!isTypeQuery) {
                const twoWords = query.split(/\s+/).filter(Boolean);
                if (twoWords.length === 2) {
                    const NOISE = new Set(['ink', 'inks', 'toner', 'toners', 'cartridge', 'cartridges',
                        'drum', 'drums', 'printer', 'printers', 'ribbon', 'ribbons', 'label', 'tape']);
                    const specific = twoWords.filter(w => !NOISE.has(w.toLowerCase()));
                    if (specific.length === 1) {
                        const codeQuery = specific[0];
                        const codeParams = { search: codeQuery, limit: searchConfig.maxResults };
                        const codeRes = await API.getProducts(codeParams);
                        if (codeRes.ok && codeRes.data) {
                            const data = codeRes.data;
                            const products = data.products || data || [];
                            if (Array.isArray(products) && products.length > 0) {
                                return { products, total: data.pagination?.total ?? data.total ?? products.length };
                            }
                        }
                    }
                }
            }

            // Multi-word fallback: if no results and query has 3+ words,
            // retry with first 2 words then filter client-side for all words
            if (!isTypeQuery) {
                const queryWords = query.toLowerCase().split(/\s+/).filter(Boolean);
                if (queryWords.length >= 3) {
                    const shorterQuery = queryWords.slice(0, 2).join(' ');
                    const fbParams = { search: shorterQuery, limit: searchConfig.maxResults };
                    const fbPromises = [API.getProducts(fbParams)];
                    if (shouldFetchRibbons) fbPromises.push(API.getRibbons({ search: shorterQuery, limit: searchConfig.maxResults }));

                    const [fbProductRes, fbRibbonRes] = await Promise.allSettled(fbPromises);
                    let fbProducts = [];

                    if (fbProductRes.status === 'fulfilled' && fbProductRes.value.ok && fbProductRes.value.data) {
                        const data = fbProductRes.value.data;
                        fbProducts = data.products || data || [];
                        if (!Array.isArray(fbProducts)) fbProducts = [];
                    }

                    // Merge ribbon results from fallback
                    if (fbRibbonRes && fbRibbonRes.status === 'fulfilled' && fbRibbonRes.value.ok && fbRibbonRes.value.data) {
                        const data = fbRibbonRes.value.data;
                        let fbRibbons = data.ribbons || data.products || (Array.isArray(data) ? data : []);
                        if (!Array.isArray(fbRibbons)) fbRibbons = [];

                        for (const ribbon of fbRibbons) {
                            ribbon._isRibbon = true;
                            if (!ribbon.image_url && ribbon.image_path) {
                                ribbon.image_url = typeof storageUrl === 'function' ? storageUrl(ribbon.image_path) : ribbon.image_path;
                            }
                            if (ribbon.retail_price == null && ribbon.sale_price != null) {
                                ribbon.retail_price = ribbon.sale_price;
                            }
                            if (ribbon.in_stock == null && ribbon.stock_quantity != null) {
                                ribbon.in_stock = ribbon.stock_quantity > 0;
                            }
                            if (typeof ribbon.brand === 'string') {
                                ribbon.brand = { name: ribbon.brand };
                            }
                        }

                        const existingSkus = new Set(fbProducts.map(p => p.sku));
                        for (const ribbon of fbRibbons) {
                            if (ribbon.sku && !existingSkus.has(ribbon.sku)) {
                                existingSkus.add(ribbon.sku);
                                fbProducts.push(ribbon);
                            }
                        }
                    }

                    // Filter: keep only items where ALL original words appear in name or SKU
                    const matched = fbProducts.filter(p => {
                        const name = (p.name || '').toLowerCase();
                        const sku = (p.sku || '').toLowerCase();
                        return queryWords.every(w => name.includes(w) || sku.includes(w));
                    });

                    if (matched.length > 0) {
                        return { products: matched, total: matched.length };
                    }
                }
            }

            // Fallback: fuzzy smart search (typo-tolerant, for when standard search has no results)
            try {
                const url = searchConfig.apiUrl + '?q=' + encodeURIComponent(query) + '&limit=' + searchConfig.maxResults;
                const res = await API.get(url);

                if (res.ok && res.data) {
                    const products = res.data.products || res.data || [];
                    const total = res.data.total ?? res.data.pagination?.total ?? null;
                    return { products: Array.isArray(products) ? products : [], total };
                }
            } catch (_) {
                // Fallback failed too
            }

            return { products: [], total: null };
        },

        /**
         * Look up a printer model in the database and return compatible products.
         * Uses Supabase to query printer_models → product_compatibility → products.
         */
        async _fetchByPrinterModel(query) {
            // Need Supabase client
            const sb = (typeof Auth !== 'undefined' && Auth.supabase)
                ? Auth.supabase
                : (typeof supabase !== 'undefined' && supabase.createClient && typeof Config !== 'undefined')
                    ? supabase.createClient(Config.SUPABASE_URL, Config.SUPABASE_ANON_KEY)
                    : null;
            if (!sb) return null;

            try {
                let printerData = null;

                // Try exact match on full_name
                const exact = await sb.from('printer_models')
                    .select('id, full_name, model_name')
                    .ilike('full_name', query)
                    .single();

                if (exact.data) {
                    printerData = exact.data;
                } else {
                    // Try partial match
                    const partial = await sb.from('printer_models')
                        .select('id, full_name, model_name')
                        .ilike('full_name', '%' + query + '%')
                        .limit(1);

                    if (partial.data && partial.data.length > 0) {
                        printerData = partial.data[0];
                    } else {
                        // Try model_name only (strip brand prefix)
                        const modelOnly = query.replace(/^(BROTHER|CANON|EPSON|HP|SAMSUNG|LEXMARK|OKI|FUJI\s*XEROX|KYOCERA)\s+/i, '');
                        if (modelOnly !== query) {
                            // Try partial match on model_name with just the model number
                            const modelResult = await sb.from('printer_models')
                                .select('id, full_name, model_name')
                                .ilike('model_name', '%' + modelOnly + '%')
                                .limit(1);

                            if (modelResult.data && modelResult.data.length > 0) {
                                printerData = modelResult.data[0];
                            }

                            // Try partial match on full_name with just the model number
                            if (!printerData) {
                                const fullNamePartial = await sb.from('printer_models')
                                    .select('id, full_name, model_name')
                                    .ilike('full_name', '%' + modelOnly + '%')
                                    .limit(1);

                                if (fullNamePartial.data && fullNamePartial.data.length > 0) {
                                    printerData = fullNamePartial.data[0];
                                }
                            }
                        }

                        // Also try with model_name matching the raw query
                        if (!printerData) {
                            const rawModel = await sb.from('printer_models')
                                .select('id, full_name, model_name')
                                .ilike('model_name', '%' + query + '%')
                                .limit(1);

                            if (rawModel.data && rawModel.data.length > 0) {
                                printerData = rawModel.data[0];
                            }
                        }
                    }
                }

                if (!printerData) return null;

                // Get compatible product IDs
                const { data: compatData } = await sb.from('product_compatibility')
                    .select('product_id')
                    .eq('printer_model_id', printerData.id);

                if (!compatData || compatData.length === 0) return null;

                const productIds = compatData.map(c => c.product_id);

                // Fetch those products
                const { data: productsData } = await sb.from('products')
                    .select('*, brand:brands(name, slug)')
                    .in('id', productIds)
                    .eq('is_active', true);

                if (!productsData || productsData.length === 0) return null;

                // Normalize to match expected product schema
                const products = productsData.map(p => ({
                    ...p,
                    brand: p.brand || {},
                    retail_price: p.retail_price ?? p.price,
                    image_url: p.image_url || ''
                }));

                return {
                    products,
                    total: products.length,
                    printerName: printerData.full_name || printerData.model_name
                };
            } catch (err) {
                return null;
            }
        },

        // --- Rendering ---

        _renderResults(products, query, total) {
            this._results = products;
            this._selectedIndex = -1;

            const prefix = 'smart-search-opt-' + this._instanceId + '-';
            this._grid.innerHTML = products.map((p, i) => this._renderCompactCard(p, i, prefix)).join('');
            // Bind image error fallbacks (replaces inline onerror)
            this._grid.querySelectorAll('img[data-fallback]').forEach(img => {
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
            // Fallback for images without data-fallback (e.g. from Products.getProductImageHTML)
            this._grid.querySelectorAll('img:not([data-fallback])').forEach(img => {
                img.addEventListener('error', function() {
                    this.src = '/assets/images/placeholder-product.svg';
                }, { once: true });
            });
            this._updateFooter(query, total);
            this._show();
        },

        _renderCompactCard(product, index, prefix) {
            const stockStatus = typeof getStockStatus === 'function' ? getStockStatus(product) : { class: '', text: '' };
            const sourceBadge = typeof getSourceBadge === 'function' ? getSourceBadge(product.source) : null;

            const brand = product.brand?.name ?? product.brand ?? '';
            const name = product.name || '';
            const price = product.retail_price;
            const itemId = prefix + index;

            // Image: reuse Products.getProductImageHTML if available
            let imageHtml;
            if (typeof Products !== 'undefined' && Products.getProductImageHTML) {
                imageHtml = Products.getProductImageHTML(product);
            } else {
                const imgUrl = product.image_url || '/assets/images/placeholder-product.svg';
                imageHtml = '<img src="' + Security.escapeAttr(imgUrl) + '" alt="' + Security.escapeAttr(name) + '" loading="lazy" data-fallback="placeholder">';
            }

            const inStock = stockStatus.class === 'in-stock' || stockStatus.class === 'low-stock';
            const addToCartBtn = inStock
                ? '<button type="button" class="smart-search__add-to-cart" data-index="' + index + '">Add to Cart</button>'
                : '';

            return '<div class="product-card product-card--compact" role="option" id="' + itemId + '" aria-selected="false" data-index="' + index + '">'
                + '<div class="product-card__image-wrap">'
                    + imageHtml
                    + (sourceBadge ? '<span class="product-card__badge ' + sourceBadge.class + '">' + sourceBadge.text + '</span>' : '')
                + '</div>'
                + '<div class="product-card__content">'
                    + '<p class="product-card__brand">' + Security.escapeHtml(brand) + '</p>'
                    + '<h3 class="product-card__title">' + Security.escapeHtml(name) + '</h3>'
                    + (price != null ? '<p class="product-card__price">' + formatPrice(price) + '</p>' : '')
                    + '<p class="product-card__stock ' + stockStatus.class + '">' + Security.escapeHtml(stockStatus.text) + '</p>'
                    + addToCartBtn
                + '</div>'
            + '</div>';
        },

        _renderSkeletons() {
            let html = '';
            for (let i = 0; i < searchConfig.skeletonCount; i++) {
                html += '<div class="product-card product-card--compact product-card--skeleton">'
                    + '<div class="product-card__image-wrap"><div class="skeleton-block skeleton-block--image"></div></div>'
                    + '<div class="product-card__content">'
                        + '<div class="skeleton-block skeleton-block--text-sm"></div>'
                        + '<div class="skeleton-block skeleton-block--text"></div>'
                        + '<div class="skeleton-block skeleton-block--text-sm" style="width:60%"></div>'
                    + '</div>'
                + '</div>';
            }
            this._grid.innerHTML = html;
            this._footer.classList.add('is-hidden');
        },

        _renderEmpty(query) {
            this._results = [];
            this._selectedIndex = -1;

            this._grid.innerHTML = '<div class="smart-search__empty">'
                + '<svg class="smart-search__empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>'
                + '<p>No results for "' + Security.escapeHtml(query) + '"</p>'
                + '<p class="smart-search__empty-hint">Try checking your spelling or using different keywords</p>'
            + '</div>';
            this._footer.classList.add('is-hidden');
            this._show();
        },

        _renderError() {
            this._results = [];
            this._selectedIndex = -1;

            this._grid.innerHTML = '<div class="smart-search__error">'
                + '<p>Something went wrong. Please try again.</p>'
            + '</div>';
            this._footer.classList.add('is-hidden');
            this._show();
        },

        _updateFooter(query, total) {
            if (!query) {
                this._footer.classList.add('is-hidden');
                return;
            }

            // Use the effective (corrected/normalized) query for the "View all" link
            const footerQuery = this._effectiveQuery || query;

            const label = (total != null && typeof total === 'number' && total > 0)
                ? 'View all ' + total + ' results'
                : 'View all results';

            const href = '/html/shop?search=' + encodeURIComponent(footerQuery);

            this._footer.innerHTML = '<a class="smart-search__view-all" href="' + Security.escapeAttr(href) + '">'
                + Security.escapeHtml(label)
                + ' <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>'
            + '</a>';
            this._footer.classList.remove('is-hidden');
        },

        // --- Correction banner ---

        /**
         * Show a correction banner in the dropdown.
         * @param {string} original - What the user typed
         * @param {string} corrected - What we searched for
         * @param {'normalize'|'spelling'} type
         */
        _showCorrection(original, corrected, type) {
            this._activeCorrection = { original, corrected, type };

            if (type === 'spelling') {
                // "Did you mean" — clickable, with option to search original
                this._correctionBanner.innerHTML =
                    '<span>Did you mean <button type="button" class="smart-search__correction-link">'
                    + '<strong>' + Security.escapeHtml(corrected) + '</strong></button>?</span>'
                    + '<button type="button" class="smart-search__correction-original">'
                    + 'Search instead for &ldquo;' + Security.escapeHtml(original) + '&rdquo;</button>';
            } else {
                // Normalize — informational
                this._correctionBanner.innerHTML =
                    '<span>Showing results for <strong>' + Security.escapeHtml(corrected) + '</strong></span>'
                    + '<button type="button" class="smart-search__correction-original">'
                    + 'Search instead for &ldquo;' + Security.escapeHtml(original) + '&rdquo;</button>';
            }

            // Bind click handlers
            const corrLink = this._correctionBanner.querySelector('.smart-search__correction-link');
            if (corrLink) {
                corrLink.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    // Just update the input text and hide banner — results already showing
                    this._input.value = corrected;
                    this._currentQuery = corrected;
                    this._effectiveQuery = corrected;
                    this._hideCorrection();
                    this._updateFooter(corrected, this._results.length);
                    this._input.focus();
                });
            }

            const origLink = this._correctionBanner.querySelector('.smart-search__correction-original');
            if (origLink) {
                origLink.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this._hideCorrection();
                    this._input.value = original;
                    this._input.focus();
                    // Search with raw original, skip normalization by calling fetch directly
                    this._currentQuery = original;
                    this._effectiveQuery = original;
                    this._renderSkeletons();
                    this._fetchResults(original).then(result => {
                        if (original !== this._currentQuery) return;
                        if (result && result.products && result.products.length > 0) {
                            this._renderResults(result.products, original, result.total);
                        } else {
                            this._renderEmpty(original);
                        }
                    }).catch(() => this._renderError());
                });
            }

            this._correctionBanner.classList.remove('is-hidden');
        },

        _hideCorrection() {
            this._activeCorrection = null;
            this._correctionBanner.classList.add('is-hidden');
            this._correctionBanner.innerHTML = '';
        },

        // --- Keyboard navigation ---

        _onKeydown(e) {
            if (!this._isVisible) return;

            const cards = this._grid.querySelectorAll('.product-card--compact:not(.product-card--skeleton)');
            const count = cards.length;
            if (count === 0 && e.key !== 'Escape') return;

            const cols = this._getVisibleColumns();

            switch (e.key) {
                case 'ArrowDown':
                    e.preventDefault();
                    if (this._selectedIndex === -1) {
                        this._selectedIndex = 0;
                    } else {
                        this._selectedIndex = Math.min(this._selectedIndex + cols, count - 1);
                    }
                    this._highlightCard(cards);
                    break;

                case 'ArrowUp':
                    e.preventDefault();
                    if (this._selectedIndex <= 0) {
                        this._selectedIndex = -1;
                        this._clearHighlight(cards);
                        this._input.setAttribute('aria-activedescendant', '');
                    } else {
                        this._selectedIndex = Math.max(this._selectedIndex - cols, 0);
                        this._highlightCard(cards);
                    }
                    break;

                case 'ArrowRight':
                    if (this._selectedIndex >= 0) {
                        e.preventDefault();
                        this._selectedIndex = Math.min(this._selectedIndex + 1, count - 1);
                        this._highlightCard(cards);
                    }
                    break;

                case 'ArrowLeft':
                    if (this._selectedIndex >= 0) {
                        e.preventDefault();
                        this._selectedIndex = Math.max(this._selectedIndex - 1, 0);
                        this._highlightCard(cards);
                    }
                    break;

                case 'Enter':
                    if (this._selectedIndex >= 0 && this._results[this._selectedIndex]) {
                        e.preventDefault();
                        this._navigateToProduct(this._results[this._selectedIndex]);
                    }
                    break;

                case 'Tab':
                    if (this._selectedIndex >= 0 && this._results[this._selectedIndex]) {
                        e.preventDefault();
                        this._navigateToProduct(this._results[this._selectedIndex]);
                    }
                    break;

                case 'Escape':
                    this._hide();
                    this._input.focus();
                    break;
            }
        },

        _onCardClick(e) {
            // If the add-to-cart button was clicked, handle that instead
            const addBtn = e.target.closest('.smart-search__add-to-cart');
            if (addBtn) {
                e.preventDefault();
                e.stopPropagation();
                this._onAddToCart(addBtn);
                return;
            }

            const card = e.target.closest('.product-card--compact:not(.product-card--skeleton)');
            if (!card) return;

            const index = parseInt(card.dataset.index, 10);
            if (isNaN(index) || !this._results[index]) return;

            this._navigateToProduct(this._results[index]);
        },

        async _onAddToCart(btn) {
            const index = parseInt(btn.dataset.index, 10);
            const product = this._results[index];
            if (!product || typeof Cart === 'undefined') return;

            btn.disabled = true;
            btn.textContent = 'Adding...';

            try {
                await Cart.addItem({
                    id: product.id,
                    name: product.name,
                    price: product.retail_price ?? product.price,
                    image: product.image_url || '',
                    sku: product.sku || '',
                    brand: product.brand?.name ?? product.brand ?? '',
                    color: product.color || '',
                    quantity: 1,
                    source: product._isRibbon ? 'ribbon' : 'core',
                    slug: product.slug || ''
                });

                btn.textContent = 'Added!';
                btn.classList.add('is-added');
                setTimeout(() => {
                    btn.textContent = 'Add to Cart';
                    btn.classList.remove('is-added');
                    btn.disabled = false;
                }, 1500);
            } catch (err) {
                btn.textContent = 'Add to Cart';
                btn.disabled = false;
                if (typeof showToast === 'function') {
                    showToast('Failed to add to cart', 'error');
                }
            }
        },

        _navigateToProduct(product) {
            const sku = product.sku || product.code || product.product_code || '';
            let url;
            if (sku) {
                url = '/html/product/?sku=' + encodeURIComponent(sku);
                if (product._isRibbon) url += '&type=ribbon';
            } else {
                url = searchConfig.buildShopUrl(product, this._currentQuery);
            }
            this._hide();
            window.location.href = url;
        },

        _highlightCard(cards) {
            this._clearHighlight(cards);

            if (this._selectedIndex >= 0 && cards[this._selectedIndex]) {
                cards[this._selectedIndex].classList.add('is-selected');
                cards[this._selectedIndex].setAttribute('aria-selected', 'true');
                cards[this._selectedIndex].scrollIntoView({ block: 'nearest' });
                this._input.setAttribute('aria-activedescendant', cards[this._selectedIndex].id);
            }
        },

        _clearHighlight(cards) {
            for (let i = 0; i < cards.length; i++) {
                cards[i].classList.remove('is-selected');
                cards[i].setAttribute('aria-selected', 'false');
            }
        },

        _getVisibleColumns() {
            if (!this._grid || !this._grid.children.length) return 1;
            const style = window.getComputedStyle(this._grid);
            const cols = style.getPropertyValue('grid-template-columns').split(' ').length;
            return cols || 1;
        },

        // --- Visibility ---

        _repositionDropdown() {
            const formRect = this._form.getBoundingClientRect();
            this._dropdown.style.top = Math.round(formRect.bottom) + 'px';
            this._dropdown.style.left = Math.round(formRect.left) + 'px';
            this._dropdown.style.width = Math.round(formRect.width) + 'px';
        },

        _startRepositionWatch() {
            // Poll form width until it stabilizes (handles CSS transitions)
            if (this._repositionRaf) cancelAnimationFrame(this._repositionRaf);
            let lastWidth = 0;
            let stableFrames = 0;
            const check = () => {
                if (!this._isVisible) return;
                const w = this._form.getBoundingClientRect().width;
                if (Math.abs(w - lastWidth) < 1) {
                    stableFrames++;
                } else {
                    stableFrames = 0;
                    this._repositionDropdown();
                }
                lastWidth = w;
                // Stop after width is stable for ~20 frames (~330ms)
                if (stableFrames < 20) {
                    this._repositionRaf = requestAnimationFrame(check);
                }
            };
            this._repositionRaf = requestAnimationFrame(check);
        },

        _show() {
            // Always reposition to catch form expansion/resize
            this._repositionDropdown();

            if (!this._isVisible) {
                this._dropdown.classList.add('is-open');
                this._input.setAttribute('aria-expanded', 'true');
                this._isVisible = true;

                // Watch for form width changes during expand transition
                this._startRepositionWatch();

                // Mobile: close on scroll
                if (window.innerWidth <= 768) {
                    const onScroll = () => this._hide();
                    window.addEventListener('scroll', onScroll, { once: true, passive: true });
                    this._scrollCleanup = () => window.removeEventListener('scroll', onScroll);
                }
            }
        },

        _hide() {
            this._dropdown.classList.remove('is-open');
            this._input.setAttribute('aria-expanded', 'false');
            this._input.setAttribute('aria-activedescendant', '');
            this._selectedIndex = -1;
            this._isVisible = false;

            if (this._repositionRaf) {
                cancelAnimationFrame(this._repositionRaf);
                this._repositionRaf = null;
            }

            if (this._scrollCleanup) {
                this._scrollCleanup();
                this._scrollCleanup = null;
            }
        },

        // --- Cache ---

        _getCached(query) {
            const key = query.toLowerCase();
            const entry = this._cache.get(key);
            if (!entry) return null;
            if (Date.now() - entry.ts > searchConfig.cacheMaxAge) {
                this._cache.delete(key);
                return null;
            }
            return entry.data;
        },

        _setCache(query, data) {
            const key = query.toLowerCase();
            this._cache.set(key, { data, ts: Date.now() });

            if (this._cache.size > searchConfig.cacheMaxSize) {
                const oldest = this._cache.keys().next().value;
                this._cache.delete(oldest);
            }
        }
    };

    return instance;
}

const SmartSearch = {
    init(searchForm, searchInput) {
        const instance = createSmartSearch();
        instance._init(searchForm, searchInput);
        return instance;
    }
};

window.SmartSearch = SmartSearch;
