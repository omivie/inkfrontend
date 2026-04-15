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
            type: null          // 'genuine' or 'compatible' filter
        },

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

        // Compatible products now have "Compatible" prefix in their name
        compatiblePrefix: 'compatible',

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
            printersBanner: document.getElementById('printers-banner'),
            printersList: document.getElementById('printers-list'),
            yieldBanner: document.getElementById('yield-banner'),
            yieldValue: document.getElementById('yield-value'),
            loading: document.getElementById('drilldown-loading'),
            empty: document.getElementById('drilldown-empty'),
            emptyMessage: document.getElementById('empty-message'),
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
            });

            // Set up search form to preserve current filters
            this.setupSearchForm();
        },

        // Set up search form to preserve filters when searching
        setupSearchForm() {
            const searchForm = document.getElementById('shop-search-form');
            if (!searchForm) return;

            const brandField = document.getElementById('search-preserve-brand');
            const typeField = document.getElementById('search-preserve-type');

            searchForm.addEventListener('submit', (e) => {
                // Enable and populate hidden fields with current filter state
                if (this.state.brand && brandField) {
                    brandField.value = this.state.brand;
                    brandField.disabled = false;
                }
                if (this.state.type && typeField) {
                    typeField.value = this.state.type;
                    typeField.disabled = false;
                }
                // Form will submit naturally with preserved filters
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
                type: null
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
            this.state.category = params.get('category');
            this.state.code = params.get('code');
            this.state.printer = params.get('printer');
            this.state.printerModel = params.get('printer_model');
            this.state.printerBrand = params.get('printer_brand'); // Brand of printer (for display, not filtering)
            this.state.search = params.get('search') || params.get('q'); // Support both 'search' and 'q' params
            this.state.type = params.get('type'); // Support 'type' param for genuine/compatible filtering

            // Ribbons category → redirect to dedicated ribbons page
            if (this.state.category === 'ribbons' && this.state.brand) {
                window.location.replace(`/html/ribbons?printer_brand=${encodeURIComponent(this.state.brand)}`);
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
            } else if (this.state.category) {
                this.state.level = 'codes';
            } else if (this.state.brand) {
                this.state.level = 'categories';
            } else {
                this.state.level = 'brands';
            }

        },

        updateURL() {
            const params = new URLSearchParams();
            if (this.state.brand) params.set('brand', this.state.brand);
            if (this.state.category) params.set('category', this.state.category);
            if (this.state.code) params.set('code', this.state.code);
            if (this.state.type) params.set('type', this.state.type);
            if (this.state.search) params.set('q', this.state.search);

            const newURL = params.toString()
                ? `${window.location.pathname}?${params.toString()}`
                : window.location.pathname;

            history.pushState({ ...this.state }, '', newURL);
        },

        // =========================================
        // NAVIGATION METHODS
        // =========================================
        async navigateTo(level, data = {}) {
            // Increment navigation version to cancel any pending renders
            this.navigationVersion++;
            const thisNavVersion = this.navigationVersion;

            // Preserve type filter across navigation
            const currentType = this.state.type;

            // Update state
            switch (level) {
                case 'brands':
                    this.state = { level: 'brands', brand: null, category: null, code: null, type: currentType };
                    break;
                case 'categories':
                    this.state = { level: 'categories', brand: data.brand, category: null, code: null, type: currentType };
                    break;
                case 'codes':
                    this.state = { level: 'codes', brand: this.state.brand, category: data.category, code: null, type: currentType };
                    break;
                case 'products':
                    this.state = { level: 'products', brand: this.state.brand, category: this.state.category, code: data.code, type: currentType };
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
            }
        },

        hideAllLevels() {
            this.elements.levelBrands.hidden = true;
            this.elements.levelCategories.hidden = true;
            this.elements.levelCodes.hidden = true;
            this.elements.levelProducts.hidden = true;
            this.elements.empty.hidden = true;
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
            this.elements.emptyMessage.textContent = message;
            this.elements.empty.hidden = false;
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
                box.addEventListener('click', () => this.navigateTo('categories', { brand: brandId }));
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
                box.href = `/html/ribbons?printer_brand=${encodeURIComponent(b.value)}`;
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
                    window.location.href = `/html/ribbons?printer_brand=${encodeURIComponent(this.state.brand)}`;
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
                        window.location.href = `/html/ribbons?printer_brand=${encodeURIComponent(this.state.brand)}`;
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

                // Include type filter in cache key to prevent stale results when switching genuine/compatible
                // v5: Uses /api/shop endpoint for server-side series extraction
                const typeKey = this.state.type || 'all';
                const categoryId = this.state.category;
                const cacheKey = `${this.state.brand}-${categoryId}-${typeKey}-codes-v5`;
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

                        const brandNameLower = brandName.toLowerCase();
                        const brandNameNoSpace = brandNameLower.replace(/[\s-]/g, '');
                        const brandSlug = this.state.brand.toLowerCase();
                        const filterByBrand = (products) => {
                            return products.filter(p => {
                                const productBrandName = (p.brand?.name || '').toLowerCase();
                                const productBrandSlug = (p.brand?.slug || '').toLowerCase();
                                if (productBrandName === brandNameLower ||
                                    productBrandSlug === brandSlug ||
                                    productBrandName.replace(/[\s-]/g, '') === brandNameNoSpace) {
                                    return true;
                                }
                                const name = (p.name || '').toLowerCase();
                                const nameWithoutPrefix = name.replace(/^(compatible|genuine)\s+/i, '');
                                if (nameWithoutPrefix.startsWith(brandNameLower) ||
                                    nameWithoutPrefix.startsWith(brandNameNoSpace)) {
                                    return true;
                                }
                                return false;
                            });
                        };

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
                    const isCompatibleProduct = (p) => {
                        if (p.source) return p.source === 'compatible';
                        return (p.name || '').toLowerCase().trim().includes(this.compatiblePrefix);
                    };
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
                this.showEmpty('Failed to load products. Please try again.');
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

                // ALWAYS extract ALL codes from product name first
                // This is critical for products compatible with multiple series (e.g., LC77 LC73 LC40)
                if (pattern) {
                    const nameMatches = name.matchAll(pattern);
                    for (const match of nameMatches) {
                        const code = this.normalizeCode(match[0], brand);
                        if (code && code.length >= 2) {
                            foundCodes.add(code);
                        }
                    }
                }

                // Also check manufacturer_part_number (only if name didn't yield codes,
                // to avoid bogus codes like LC33173 from MPN "LC33173PK" when name has LC3317)
                if (mpn && foundCodes.size === 0) {
                    const normalizedMpn = this.normalizeCode(mpn, brand);
                    if (normalizedMpn && normalizedMpn.length >= 2) {
                        foundCodes.add(normalizedMpn);
                    }
                }

                // Also check SKU for additional codes
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

                // For Brother: recognize IB combo codes (e.g., "IB3757" → LC37 + LC57)
                // These are internal codes that concatenate two series numbers
                if (foundCodes.size === 0 && brand === 'brother') {
                    const ibComboPattern = /\bIB(\d{4,})\b/gi;
                    const ibMatches = name.matchAll(ibComboPattern);
                    for (const match of ibMatches) {
                        const digits = match[1];
                        // Split evenly into two series codes (e.g., "3757" → "37" + "57")
                        if (digits.length % 2 === 0) {
                            const mid = digits.length / 2;
                            const code1 = 'LC' + digits.substring(0, mid);
                            const code2 = 'LC' + digits.substring(mid);
                            const norm1 = this.normalizeCode(code1, brand);
                            const norm2 = this.normalizeCode(code2, brand);
                            if (norm1) foundCodes.add(norm1);
                            if (norm2) foundCodes.add(norm2);
                        }
                    }
                }

                // For Brother: recognize internal B-codes (e.g., "B131" → "LC131")
                // These appear in value pack products that use internal naming
                if (foundCodes.size === 0 && brand === 'brother') {
                    const bCodePattern = /\bB(\d{2,5}(?:XL)?)\b/gi;
                    const bMatches = name.matchAll(bCodePattern);
                    const productType = (product.product_type || '').toLowerCase();
                    const category = this.state.category || '';
                    for (const match of bMatches) {
                        const num = match[1].toUpperCase();
                        let mfgCode = null;
                        if (productType === 'ink_cartridge' || productType === 'ink_bottle' || category === 'ink') {
                            mfgCode = 'LC' + num;
                        } else if (productType === 'toner_cartridge' || category === 'toner') {
                            mfgCode = 'TN' + num;
                        } else if (productType === 'drum_unit' || category === 'consumable') {
                            mfgCode = 'DR' + num;
                        }
                        if (mfgCode) {
                            const normalized = this.normalizeCode(mfgCode, brand);
                            if (normalized) foundCodes.add(normalized);
                        }
                    }
                }

                // Also extract B-codes or IB combo codes from SKUs (e.g., GEN-PACK-BRO-B131-CMY, COMP-PACK-BRO-IB3757-KCMY)
                if (foundCodes.size === 0 && brand === 'brother' && sku) {
                    const skuUpper = sku.toUpperCase();
                    const productType = (product.product_type || '').toLowerCase();
                    const category = this.state.category || '';

                    // Check for IB combo codes in SKU (e.g., BRO-IB3757)
                    const skuIBCombo = skuUpper.match(/BRO-IB(\d{4,})/);
                    if (skuIBCombo) {
                        const digits = skuIBCombo[1];
                        if (digits.length % 2 === 0) {
                            const mid = digits.length / 2;
                            const norm1 = this.normalizeCode('LC' + digits.substring(0, mid), brand);
                            const norm2 = this.normalizeCode('LC' + digits.substring(mid), brand);
                            if (norm1) foundCodes.add(norm1);
                            if (norm2) foundCodes.add(norm2);
                        }
                    }

                    // Check for B-codes in SKU (e.g., BRO-B131)
                    if (foundCodes.size === 0) {
                        const skuBCode = skuUpper.match(/BRO-B(\d{2,5}(?:XL)?)/);
                        if (skuBCode) {
                            const num = skuBCode[1];
                            let mfgCode = null;
                            if (productType === 'ink_cartridge' || productType === 'ink_bottle' || category === 'ink') {
                                mfgCode = 'LC' + num;
                            } else if (productType === 'toner_cartridge' || category === 'toner') {
                                mfgCode = 'TN' + num;
                            } else if (productType === 'drum_unit' || category === 'consumable') {
                                mfgCode = 'DR' + num;
                            }
                            if (mfgCode) {
                                const normalized = this.normalizeCode(mfgCode, brand);
                                if (normalized) foundCodes.add(normalized);
                            }
                        }
                    }
                }

                // Fallback if no codes found - try generic pattern on name
                if (foundCodes.size === 0) {
                    const fallbackPattern = /\b[A-Z]{1,3}[-]?\d{1,4}(?:XL)?[A-Z]{0,3}\b/gi;
                    const paperSizes = new Set(['A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'B4', 'B5']);
                    const fallbackMatches = name.matchAll(fallbackPattern);
                    for (const match of fallbackMatches) {
                        if (paperSizes.has(match[0].toUpperCase())) continue;
                        const code = this.normalizeCode(match[0], brand);
                        if (code && code.length >= 2) {
                            foundCodes.add(code);
                        }
                    }
                }

                // PRIORITY 5: Infer manufacturer code from SKU
                // SKUs like "B431B" should become "LC431" for Brother ink cartridges
                if (foundCodes.size === 0 && sku) {
                    let skuCode = sku.toUpperCase();
                    const prefix = brandPrefixes[brand];

                    // Strip the brand prefix from SKU (e.g., B for Brother)
                    if (prefix && skuCode.startsWith(prefix)) {
                        skuCode = skuCode.substring(1);
                    }

                    // Strip "IB" prefix if present (internal code)
                    if (skuCode.startsWith('IB')) {
                        skuCode = skuCode.substring(2);
                    }

                    // Infer the manufacturer code prefix based on brand and product type
                    const productType = (product.product_type || '').toLowerCase();
                    const category = this.state.category || '';

                    // For Brother products, add the appropriate series prefix
                    if (brand === 'brother') {
                        // Check if code already has a known prefix
                        if (!skuCode.startsWith('LC') && !skuCode.startsWith('TN') && !skuCode.startsWith('DR')) {
                            if (productType === 'ink_cartridge' || productType === 'ink_bottle' || category === 'ink') {
                                skuCode = 'LC' + skuCode;
                            } else if (productType === 'toner_cartridge' || category === 'toner') {
                                skuCode = 'TN' + skuCode;
                            } else if (productType === 'drum_unit' || category === 'consumable') {
                                skuCode = 'DR' + skuCode;
                            }
                        }
                    }
                    // For Canon products
                    else if (brand === 'canon') {
                        if (!skuCode.startsWith('PG') && !skuCode.startsWith('CL') &&
                            !skuCode.startsWith('PGI') && !skuCode.startsWith('CLI') &&
                            !skuCode.startsWith('BCI') && !skuCode.startsWith('GI') &&
                            !skuCode.startsWith('PFI') && !skuCode.startsWith('CART') &&
                            !skuCode.startsWith('FX')) {
                            // Canon ink cartridges have diverse prefixes
                            // Without knowing the series, we can't reliably add prefix
                        }
                    }
                    // For Epson products
                    else if (brand === 'epson') {
                        if (!skuCode.startsWith('T') && !skuCode.startsWith('C13')) {
                            if (productType === 'ink_cartridge' || productType === 'ink_bottle' || category === 'ink') {
                                // Epson codes typically start with T
                                if (/^\d/.test(skuCode)) {
                                    skuCode = 'T' + skuCode;
                                }
                            }
                        }
                    }
                    // For OKI products: SKU like O831Y → strip O prefix + color suffix → 831 → C831
                    else if (brand === 'oki') {
                        const okiModelMatch = skuCode.match(/^(\d{3,4})/);
                        if (okiModelMatch) {
                            skuCode = 'C' + okiModelMatch[1];
                        }
                    }

                    // Normalize the code to strip color suffixes and get base code
                    skuCode = this.normalizeCode(skuCode, brand);
                    if (skuCode) {
                        foundCodes.add(skuCode);
                    }
                }

                // PRIORITY 6: Last resort - use product name
                if (foundCodes.size === 0) {
                    const nameCode = name.replace(/^(Compatible|Genuine)\s*/i, '')
                                        .split(/\s+/)
                                        .slice(0, 3)
                                        .join('-')
                                        .toUpperCase()
                                        .substring(0, 20);
                    if (nameCode) {
                        foundCodes.add(nameCode);
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
                    // Try the old codes cache (v5 from /api/shop, or v4 from legacy)
                    const codesCacheKey5 = `${this.state.brand}-${categoryId}-${typeKey}-codes-v5-final`;
                    const codesCacheKey4 = `${this.state.brand}-${categoryId}-${typeKey}-codes-v4-final`;

                    for (const cacheKey of [codesCacheKey5, codesCacheKey4]) {
                        if (this.cache.products[cacheKey]) {
                            const codeEntry = this.cache.products[cacheKey].find(c => c.code === code);
                            if (codeEntry?.products) {
                                mergedProducts = codeEntry.products;
                                break;
                            }
                        }
                    }
                }

                // If still no products, fetch via /api/shop or legacy
                if (mergedProducts.length === 0) {
                    if (this._shopEndpointAvailable) {
                        const loadCategoryConfig = this.categories.find(c => c.id === this.state.category);
                        const loadApiCategory = loadCategoryConfig?.apiCategory || this.state.category;
                        const response = await API.getShopData({
                            brand: this.state.brand,
                            category: loadApiCategory,
                            code: code,
                            limit: 200
                        });
                        if (navVersion !== undefined && this.navigationVersion !== navVersion) return;

                        if (response.ok && response.data?.products) {
                            mergedProducts = response.data.products;
                        }
                    }

                    // Legacy fallback: trigger loadProductCodes to populate cache
                    if (mergedProducts.length === 0) {
                        await this.loadProductCodes(navVersion);
                        this.elements.levelCodes.hidden = true;
                        if (navVersion !== undefined && this.navigationVersion !== navVersion) return;

                        const codesCacheKey5 = `${this.state.brand}-${categoryId}-${typeKey}-codes-v5-final`;
                        const codesCacheKey4 = `${this.state.brand}-${categoryId}-${typeKey}-codes-v4-final`;
                        for (const cacheKey of [codesCacheKey5, codesCacheKey4]) {
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

                // Separate genuine and compatible using the API's source field (more reliable than name parsing)
                const isCompatibleProduct = (product) => {
                    // Primary: use API source field
                    if (product.source) {
                        return product.source === 'compatible';
                    }
                    // Fallback: check if name starts with "Compatible"
                    const productName = (product.name || '').toLowerCase().trim();
                    return productName.includes(this.compatiblePrefix);
                };

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
                this.showEmpty('Failed to load products. Please try again.');
            }

            this.showLoading(false);
        },

        // Load products compatible with a specific printer
        async loadPrinterProducts(navVersion) {
            this.showLoading(true);

            try {
                // Fetch compatible products for the printer slug
                const response = await API.getProductsByPrinter(this.state.printer);

                // Check if navigation changed during fetch
                if (navVersion !== undefined && this.navigationVersion !== navVersion) return;

                if (response.ok && response.data) {
                    const printerData = response.data.printer;
                    // API returns 'products' array (per product_pages.md documentation)
                    const products = response.data.products || response.data.compatible_products || [];

                    // Store printer name for display
                    this.state.printerName = printerData?.full_name || this.state.printer;
                    this.updateBreadcrumb();
                    this.updateTitle();

                    // Separate genuine and compatible using the API's source field (more reliable than name parsing)
                    const isCompatibleProduct = (product) => {
                        // Primary: use API source field
                        if (product.source) {
                            return product.source === 'compatible';
                        }
                        // Fallback: check if name starts with "Compatible"
                        const productName = (product.name || '').toLowerCase().trim();
                        return productName.includes(this.compatiblePrefix);
                    };

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
                    this.showEmpty('Failed to load compatible products for this printer.');
                }
            } catch (error) {
                DebugLog.error('Failed to load printer products:', error);
                // Check if navigation changed
                if (navVersion !== undefined && this.navigationVersion !== navVersion) return;
                this.showEmpty('Failed to load products. Please try again.');
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
                                    quantity: 1
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

                // Strategy 1: Query product_compatibility table via Supabase for compatible products
                if (supabaseClient) {
                    try {
                        let printerData = null;

                        // Try exact match first
                        const exactResult = await supabaseClient
                            .from('printer_models')
                            .select('id, full_name, model_name')
                            .ilike('full_name', printerModel)
                            .single();

                        if (exactResult.data) {
                            printerData = exactResult.data;
                        } else {
                            // Try partial match with wildcards
                            const partialResult = await supabaseClient
                                .from('printer_models')
                                .select('id, full_name, model_name')
                                .ilike('full_name', `%${printerModel}%`)
                                .limit(1);

                            if (partialResult.data && partialResult.data.length > 0) {
                                printerData = partialResult.data[0];
                            } else {
                                // Try searching by model_name only (without brand prefix)
                                const modelNameOnly = printerModel.replace(/^(BROTHER|CANON|EPSON|HP|SAMSUNG|LEXMARK|OKI|FUJI\s*XEROX|KYOCERA)\s+/i, '');

                                const modelResult = await supabaseClient
                                    .from('printer_models')
                                    .select('id, full_name, model_name')
                                    .ilike('model_name', `%${modelNameOnly}%`)
                                    .limit(1);

                                if (modelResult.data && modelResult.data.length > 0) {
                                    printerData = modelResult.data[0];
                                }

                                // Also try partial match on full_name with just the model number
                                if (!printerData) {
                                    const fullNamePartial = await supabaseClient
                                        .from('printer_models')
                                        .select('id, full_name, model_name')
                                        .ilike('full_name', `%${modelNameOnly}%`)
                                        .limit(1);

                                    if (fullNamePartial.data && fullNamePartial.data.length > 0) {
                                        printerData = fullNamePartial.data[0];
                                    }
                                }
                            }
                        }

                        if (printerData) {
                            // Get all compatible product IDs
                            const { data: compatData, error: compatError } = await supabaseClient
                                .from('product_compatibility')
                                .select('product_id')
                                .eq('printer_model_id', printerData.id);

                            if (compatData && compatData.length > 0) {
                                const productIds = compatData.map(c => c.product_id);

                                // Fetch those products (these are the directly linked products)
                                const { data: productsData, error: productsError } = await supabaseClient
                                    .from('products')
                                    .select('*, brand:brands(name, slug)')
                                    .in('id', productIds)
                                    .eq('is_active', true);

                                if (productsData && productsData.length > 0) {
                                    allProducts = productsData.map(p => ({
                                        ...p,
                                        brand_name: p.brand?.name,
                                        brand_slug: p.brand?.slug
                                    }));

                                    // Extract ink codes from product names (e.g., "LC37", "PG-540", "LC133")
                                    // This helps us find compatible versions that aren't directly linked
                                    const codePattern = /\b([A-Z]{1,3}[-]?\d{2,4}[A-Z]{0,2})\b/gi;
                                    allProducts.forEach(p => {
                                        const matches = (p.name || '').match(codePattern);
                                        if (matches) {
                                            matches.forEach(code => {
                                                const upperCode = code.toUpperCase();
                                                if (!inkCodes.includes(upperCode)) {
                                                    inkCodes.push(upperCode);
                                                }
                                            });
                                        }
                                    });
                                }
                            }
                        }
                    } catch (e) {
                        // Supabase query failed - will fall back to API search
                    }
                }

                // Strategy 2: Search for compatible products using the extracted ink codes
                if (inkCodes.length > 0 && supabaseClient) {
                    try {
                        // Search for products containing any of the ink codes
                        for (const code of inkCodes) {
                            // Search in product name
                            const { data: codeProducts, error: codeError } = await supabaseClient
                                .from('products')
                                .select('*, brand:brands(name, slug)')
                                .ilike('name', `%${code}%`)
                                .eq('is_active', true)
                                .limit(100);

                            if (codeProducts && codeProducts.length > 0) {
                                // Add products not already in the list
                                const existingIds = new Set(allProducts.map(p => p.id));
                                const newProducts = codeProducts
                                    .filter(p => !existingIds.has(p.id))
                                    .map(p => ({
                                        ...p,
                                        brand_name: p.brand?.name,
                                        brand_slug: p.brand?.slug
                                    }));
                                allProducts = [...allProducts, ...newProducts];
                            }

                            // Also search in SKU
                            const { data: skuProducts } = await supabaseClient
                                .from('products')
                                .select('*, brand:brands(name, slug)')
                                .ilike('sku', `%${code}%`)
                                .eq('is_active', true)
                                .limit(50);

                            if (skuProducts && skuProducts.length > 0) {
                                const existingIds = new Set(allProducts.map(p => p.id));
                                const newSkuProducts = skuProducts
                                    .filter(p => !existingIds.has(p.id))
                                    .map(p => ({
                                        ...p,
                                        brand_name: p.brand?.name,
                                        brand_slug: p.brand?.slug
                                    }));
                                allProducts = [...allProducts, ...newSkuProducts];
                            }
                        }
                    } catch (e) {
                        // Ink code search failed - continue with existing results
                    }
                }

                // Strategy 3: Fallback - search by printer model via dedicated endpoint
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

                    // Separate genuine and compatible using the API's source field (more reliable than name parsing)
                    const isCompatibleProduct = (product) => {
                        // Primary: use API source field
                        if (product.source) {
                            return product.source === 'compatible';
                        }
                        // Fallback: check if name starts with "Compatible"
                        const productName = (product.name || '').toLowerCase().trim();
                        return productName.includes(this.compatiblePrefix);
                    };

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
                    this.showEmpty(`Failed to load compatible products for ${this.state.printerModel}.`);
                }
            } catch (error) {
                DebugLog.error('Failed to load printer model products:', error);
                // Check if navigation changed
                if (navVersion !== undefined && this.navigationVersion !== navVersion) return;
                this.showEmpty('Failed to load products. Please try again.');
            }

            this.showLoading(false);
        },

        async loadSearchResults(navVersion) {
            this.showLoading(true);

            try {
                const searchQuery = this.state.search;


                // Detect if this is a product-type keyword (e.g. "ribbon", "toner")
                const typeDetect = typeof SearchNormalize !== 'undefined'
                    ? SearchNormalize.detectProductType(searchQuery)
                    : null;

                let products = [];
                let isTypeQuery = false;

                if (typeDetect) {
                    // Type-aware fetch: use getProducts + getRibbons in parallel
                    // (same pattern as search dropdown in search.js)
                    isTypeQuery = true;
                    const promises = [API.getProducts({ ...typeDetect.productParams, limit: 200 })];
                    if (typeDetect.fetchRibbons) {
                        promises.push(API.getRibbons({ limit: 200 }));
                    }
                    const results = await Promise.allSettled(promises);

                    if (navVersion !== undefined && this.navigationVersion !== navVersion) return;

                    // Collect product results
                    if (results[0].status === 'fulfilled' && results[0].value.ok && results[0].value.data) {
                        const data = results[0].value.data;
                        const prods = data.products || data || [];
                        if (Array.isArray(prods)) products = prods;
                    }

                    // Merge ribbon results (deduplicate by SKU)
                    if (typeDetect.fetchRibbons && results[1] && results[1].status === 'fulfilled'
                        && results[1].value.ok && results[1].value.data) {
                        const data = results[1].value.data;
                        let ribbons = data.ribbons || data.products || (Array.isArray(data) ? data : []);
                        if (!Array.isArray(ribbons)) ribbons = [];

                        // Normalize ribbon fields to match product schema
                        for (const ribbon of ribbons) {
                            ribbon._isRibbon = true;
                            if (!ribbon.image_url && ribbon.image_path) {
                                ribbon.image_url = ribbon.image_path;
                            }
                            if (ribbon.retail_price == null && ribbon.sale_price != null) {
                                ribbon.retail_price = ribbon.sale_price;
                            }
                            ribbon.in_stock = true;
                            if (typeof ribbon.brand === 'string') {
                                ribbon.brand = { name: ribbon.brand };
                            }
                        }

                        const existingSkus = new Set(products.map(p => p.sku));
                        for (const ribbon of ribbons) {
                            if (ribbon.sku && !existingSkus.has(ribbon.sku)) {
                                existingSkus.add(ribbon.sku);
                                products.push(ribbon);
                            }
                        }
                    }
                } else if (searchQuery && (searchQuery.toLowerCase() === 'genuine' || searchQuery.toLowerCase() === 'compatible')) {
                    // Source filter keyword — use source API param instead of text search
                    const response = await API.getProducts({ source: searchQuery.toLowerCase(), limit: 200 });

                    if (navVersion !== undefined && this.navigationVersion !== navVersion) return;

                    products = (response.ok && response.data?.products) ? response.data.products : [];
                } else {
                    // Standard text search path
                    const response = await API.smartSearch(searchQuery, 100);

                    if (navVersion !== undefined && this.navigationVersion !== navVersion) return;

                    products = (response.ok && response.data?.products) ? response.data.products : [];


                    // Filter out irrelevant results where the search term only matches
                    // as a substring of an unrelated word (e.g. "T10" in "Pla-t10-um")
                    if (products.length > 0 && searchQuery.length <= 6) {
                        const escaped = searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        const wordBoundary = new RegExp(`(?:^|[\\s\\-\\/])${escaped}(?:[\\s\\-\\/BCMYK,.]|$)`, 'i');
                        // For numeric queries (e.g. "069"), also match product codes like CART069, CART069HK
                        const isNumeric = /^\d+$/.test(searchQuery);
                        const codePattern = isNumeric
                            ? new RegExp(`[A-Z]${escaped}(?:[A-Z]{0,3}\\b|[\\s\\-,.]|$)`, 'i')
                            : null;
                        // For numeric queries, require non-digit before the number to avoid
                        // matching "069" inside "S41069" or "CT351069"
                        const nameIncludesPattern = isNumeric
                            ? new RegExp(`(?:^|[^\\d])${escaped}(?:\\s|$)`, 'i')
                            : null;
                        const relevant = products.filter(p => {
                            const name = p.name || '';
                            const sku = p.sku || p.code || p.product_code || '';
                            const mpn = p.manufacturer_part_number || '';
                            return wordBoundary.test(name) || wordBoundary.test(sku) || wordBoundary.test(mpn)
                                || (codePattern && (codePattern.test(name) || codePattern.test(sku) || codePattern.test(mpn)))
                                || (nameIncludesPattern ? nameIncludesPattern.test(name) : name.toLowerCase().includes(searchQuery.toLowerCase() + ' '))
                                || sku.toLowerCase().startsWith(searchQuery.toLowerCase());
                        });

                        if (relevant.length > 0) products = relevant;
                    }


                    // If no product results, try searching for printer models
                    if (products.length === 0) {
                        try {
                            const printerResponse = await API.searchPrinters(searchQuery);
                            if (navVersion !== undefined && this.navigationVersion !== navVersion) return;

                            const printers = Array.isArray(printerResponse.data) ? printerResponse.data : [];
                            if (printers.length > 0) {
                                if (printers.length === 1) {
                                    const printer = printers[0];
                                    const modelName = printer.full_name || printer.model_name || '';
                                    const brand = printer.brand?.name || printer.brand || '';
                                    this.state.printerModel = modelName;
                                    this.state.printerBrand = brand;
                                    this.state.level = 'printer-model-products';
                                    this.state.search = null;

                                    // Update URL to reflect printer context so subsequent searches start clean
                                    const printerParams = new URLSearchParams({ printer_model: modelName });
                                    if (brand) printerParams.set('printer_brand', brand);
                                    if (this.state.type) printerParams.set('type', this.state.type);
                                    history.replaceState({ ...this.state }, '', `/html/shop?${printerParams}`);

                                    this.showLoading(false);
                                    await this.loadPrinterModelProducts(navVersion);
                                    return;
                                }

                                const existingIds = new Set();
                                for (const printer of printers.slice(0, 5)) {
                                    const slug = printer.slug;
                                    if (!slug) continue;
                                    try {
                                        const printerProducts = await API.getProductsByPrinter(slug);
                                        const pList = printerProducts.data?.products || printerProducts.data?.compatible_products || [];
                                        if (printerProducts.ok && pList.length > 0) {
                                            for (const p of pList) {
                                                if (!existingIds.has(p.id)) {
                                                    existingIds.add(p.id);
                                                    products.push(p);
                                                }
                                            }
                                        }
                                    } catch (e) { /* skip this printer */ }
                                }
                            }
                        } catch (e) {
                            // Printer search failed — continue with empty results
                        }
                    }

                    // If still no results, search descriptions & compatible devices via Supabase
                    if (products.length === 0) {
                        try {
                            const sb = (typeof Auth !== 'undefined' && Auth.supabase)
                                ? Auth.supabase
                                : (typeof supabase !== 'undefined' && supabase.createClient && typeof Config !== 'undefined')
                                    ? supabase.createClient(Config.SUPABASE_URL, Config.SUPABASE_ANON_KEY)
                                    : null;
                            if (sb) {
                                const words = searchQuery.trim().split(/\s+/).filter(w => w.length >= 2);
                                if (words.length > 0) {
                                    let dbQuery = sb.from('products')
                                        .select('*, brand:brands(name, slug)')
                                        .eq('is_active', true);
                                    for (const word of words) {
                                        const pattern = '%' + word + '%';
                                        dbQuery = dbQuery.or(
                                            'description.ilike.' + pattern + ',compatible_devices_html.ilike.' + pattern
                                        );
                                    }
                                    const { data } = await dbQuery.limit(100);
                                    if (navVersion !== undefined && this.navigationVersion !== navVersion) return;
                                    if (data && data.length > 0) {
                                        products = data.map(p => ({
                                            ...p,
                                            brand: p.brand || {},
                                            retail_price: p.retail_price ?? p.price,
                                            image_url: typeof storageUrl === 'function' ? storageUrl(p.image_url) : (p.image_url || '')
                                        }));
                                    }
                                }
                            }
                        } catch (e) {
                            // Description search failed — continue with empty results
                        }
                    }
                }


                if (products.length > 0) {
                    let filteredProducts = products;

                    // Skip brand detection for type queries (results span multiple brands)
                    let detectedBrand = null;
                    if (!isTypeQuery) {
                        for (const product of products) {
                            const productName = (product.name || '').toLowerCase();
                            const productNameNoSpace = productName.replace(/[\s-]/g, '');
                            for (const [brandKey, brandData] of Object.entries(this.brandInfo)) {
                                const brandNameLower = brandData.name.toLowerCase();
                                const brandNameNoSpace = brandNameLower.replace(/[\s-]/g, '');
                                if (productName.includes(brandNameLower) || productNameNoSpace.includes(brandNameNoSpace)) {
                                    detectedBrand = brandKey;
                                    break;
                                }
                            }
                            if (detectedBrand) break;
                        }

                        if (detectedBrand) {
                            const brandNameLower = this.brandInfo[detectedBrand].name.toLowerCase();
                            const brandNameNoSpace = brandNameLower.replace(/[\s-]/g, '');
                            filteredProducts = products.filter(p => {
                                const name = (p.name || '').toLowerCase();
                                const nameNoSpace = name.replace(/[\s-]/g, '');
                                return name.includes(brandNameLower) || nameNoSpace.includes(brandNameNoSpace);
                            });
                            if (filteredProducts.length === 0) filteredProducts = products;
                        }
                    }

                    // Separate genuine and compatible
                    const isCompatibleProduct = (product) => {
                        if (product.source) return product.source === 'compatible';
                        const productName = (product.name || '').toLowerCase().trim();
                        return productName.includes(this.compatiblePrefix);
                    };

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

                    this.renderProducts(compatible, this.elements.compatibleProducts, this.elements.compatibleSection, true);
                    this.renderProducts(genuine, this.elements.genuineProducts, this.elements.genuineSection, false);

                    if (genuine.length === 0 && compatible.length === 0) {
                        this.showEmpty(`No products found for "${searchQuery}".`);
                    } else {
                        this.elements.levelProducts.hidden = false;
                    }
                } else {
                    this.showEmpty(`No products found for "${searchQuery}".`);
                }
            } catch (error) {
                DebugLog.error('Failed to search products:', error);
                if (navVersion !== undefined && this.navigationVersion !== navVersion) return;
                this.showEmpty('Failed to search products. Please try again.');
            }

            this.showLoading(false);
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

        // Sort products: group by yield (standard → high → super high), then color order.
        // Delegates to ProductSort (utils.js) so search and shop share one ordering source.
        sortProducts(products) {
            return ProductSort.byYieldAndColor(products);
        },

        renderProducts(products, container, section, isCompatible = false) {
            container.innerHTML = '';

            if (products.length === 0) {
                section.hidden = true;
                return;
            }

            section.hidden = false;

            // Sort products: singles by color, then value packs at end
            const sortedProducts = this.sortProducts([...products]);

            // Render all products in a single wrapping grid
            sortedProducts.forEach(product => {
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
            const stockStatus = getStockStatus(product);
            const inStock = stockStatus.class === 'in-stock';
            const brandName = product.brand?.name || '';
            const color = product.color || '';

            // Keep full product name including "Compatible" prefix
            const displayName = product.name || '';

            // Show product image if available, otherwise color block for compatible only, or placeholder for genuine
            const placeholderSvg = `<svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
                        <rect x="6" y="2" width="12" height="20" rx="2"/>
                        <path d="M9 6h6M9 10h6"/>
                    </svg>`;
            let imageContent;
            const resolvedImageUrl = typeof storageUrl === 'function' ? storageUrl(product.image_url) : product.image_url;
            const srcsetAttr = typeof imageSrcset === 'function' && product.image_url ? imageSrcset(product.image_url) : '';
            const sizesAttr = '(max-width: 480px) 200px, (max-width: 768px) 300px, 400px';
            const colorStyle = ProductColors.getProductStyle(product);
            // Get raw (non-optimized) image URL for fallback when optimization endpoint fails (429/error)
            const rawImageUrl = product.image_url && typeof storageUrlRaw === 'function' ? storageUrlRaw(product.image_url) : product.image_url;
            if (resolvedImageUrl && resolvedImageUrl !== '/assets/images/placeholder-product.svg') {
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

            card.innerHTML = `
                <a href="${product.slug ? `/products/${Security.escapeAttr(product.slug)}/${Security.escapeAttr(product.sku)}` : `/html/product/?sku=${Security.escapeAttr(product.sku)}`}" class="product-card__link">
                    <div class="product-card__image-wrapper">
                        ${imageContent}
                        ${product.is_lowest_in_market ? `<span class="product-card__badge product-card__badge--lowest-price" title="${product.market_position ? Security.escapeAttr(product.market_position.price_diff_percent + '% less than ' + product.market_position.lowest_competitor_name) : ''}">Lowest Price in NZ</span>` : ''}
                    </div>
                    <div class="product-card__content">
                        <h3 class="product-card__title" title="${Security.escapeAttr(displayName)}">${Security.escapeHtml(displayName)}</h3>
                        ${product.compare_price && product.compare_price > price ? `<span class="product-card__savings">Save ${formatPrice(product.compare_price - price)}</span>` : ''}
                        ${stockStatus.class === 'contact-us'
                            ? `<span class="product-card__stock-banner product-card__stock-banner--contact-us">Contact Us for Stock Inquiry</span>`
                            : (product.retail_price != null && product.retail_price >= 100 ? '<span class="product-card__free-shipping">FREE SHIPPING</span>' : '')}
                        <div class="product-card__footer">
                            <div class="product-card__footer-row">
                                ${color ? `<span class="product-card__color">${Security.escapeHtml(color)}</span>` : '<span></span>'}
                                ${stockStatus.class !== 'contact-us' ? `<span class="product-card__stock product-card__stock--${stockStatus.class}">
                                    ${stockStatus.text}
                                </span>` : ''}
                            </div>
                            <div class="product-card__footer-row">
                                <div class="product-card__pricing">
                                    <span class="product-card__price">${formatPrice(price)}</span>
                                    ${product.compare_price && product.compare_price > price ? ` <span class="product-card__compare-price">${formatPrice(product.compare_price)}</span>` : ''}
                                </div>
                                ${stockStatus.class === 'contact-us' ? `
                                <a href="/html/contact/" class="btn btn--primary btn--sm product-card__cart-btn product-card__contact-btn"
                                   data-product-id="${product.id}"
                                   aria-label="Contact us about ${Security.escapeAttr(displayName)}">
                                    Contact Us
                                </a>` : `
                                <button class="btn btn--primary btn--sm product-card__cart-btn"
                                        data-product-id="${product.id}"
                                        aria-label="Add ${Security.escapeAttr(displayName)} to cart"
                                        ${!inStock ? 'disabled' : ''}>
                                    Add to Cart
                                </button>`}
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

            // Add cart button event listener (skip for contact-us links)
            const cartBtn = card.querySelector('.product-card__cart-btn');
            if (cartBtn && !cartBtn.classList.contains('product-card__contact-btn')) {
                cartBtn.addEventListener('click', async (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    await this.addToCart(product, cartBtn);
                });
            } else if (cartBtn) {
                // Contact-us link — stop propagation so the card link doesn't intercept
                cartBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
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
                    quantity: 1
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
            const shopUrl = base + '/html/shop';
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
                pageUrl += (pageUrl.includes('?') ? '&' : '?') + 'category=' + encodeURIComponent(this.state.category);
                pageName = pageName + ' \u2014 ' + catName;
                items.push({ "@type": "ListItem", "position": items.length + 1, "name": catName, "item": pageUrl });
            }
            el.textContent = JSON.stringify({
                "@context": "https://schema.org",
                "@type": "CollectionPage",
                "name": pageName,
                "url": pageUrl,
                "breadcrumb": { "@type": "BreadcrumbList", "itemListElement": items }
            });
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

        // Get product type label based on category and type filter
        getProductTypeLabel() {
            const typeMap = {
                'ink': 'Inkjet Cartridges',
                'toner': 'Toner Cartridges',
                'consumable': 'Drums & Supplies',
                'paper': 'Paper'
            };
            let label = typeMap[this.state.category] || 'Cartridges';

            // Add type filter prefix if specified
            if (this.state.type === 'genuine') {
                label = 'Original ' + label;
            } else if (this.state.type === 'compatible') {
                label = 'Compatible ' + label;
            }

            return label;
        },

        // Display compatible printers and yield info, update section titles
        async displayProductInfo(products, { skipPrinters = false } = {}) {
            // Reset banners
            this.elements.printersBanner.hidden = true;
            this.elements.yieldBanner.hidden = true;

            // Get brand name and product type for section titles
            const brandName = this.brandInfo[this.state.brand]?.name || this.state.brand || '';
            const productType = this.getProductTypeLabel();

            // Update section titles with brand name
            this.elements.compatibleTitleText.textContent = `${brandName} Compatible ${productType}`;
            this.elements.genuineTitleText.textContent = `${brandName} Original ${productType}`;

            if (!products || products.length === 0) return;

            // Get yield/page count from products
            let yieldValue = null;
            products.forEach(product => {
                if (!yieldValue && product.page_yield) {
                    yieldValue = product.page_yield;
                }
                if (!yieldValue && product.yield) {
                    yieldValue = product.yield;
                }
                if (!yieldValue && product.pages) {
                    yieldValue = product.pages;
                }
            });


            // Paper categories don't have a "For Use In" printer association
            if (this.state.category === 'paper') return;

            // Skip printer banner for search results
            if (skipPrinters) return;

            // Fetch compatible printers from API using first product's SKU
            const firstProduct = products.find(p => p.sku);
            if (firstProduct && firstProduct.sku) {
                try {
                    const response = await API.getCompatiblePrinters(firstProduct.sku);
                    if (response.ok && response.data) {
                        const printers = response.data.printers || response.data.compatible_printers || response.data;

                        if (Array.isArray(printers) && printers.length > 0) {
                            // Extract printer info with names and brands
                            const printerInfo = printers.map(p => {
                                if (typeof p === 'string') return { name: p, brand: '' };
                                const name = p.full_name || p.model_name || p.name || p.model || '';
                                const brand = p.brand_name || p.brand || '';
                                return { name, brand };
                            }).filter(p => p.name).sort((a, b) => a.name.localeCompare(b.name));

                            if (printerInfo.length > 0) {
                                const links = printerInfo.map(p => {
                                    const params = new URLSearchParams({ printer_model: p.name });
                                    if (p.brand) params.set('printer_brand', p.brand);
                                    const escapedName = p.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
                                    return `<a href="/html/shop?${params}" class="printer-link">${escapedName}</a>`;
                                }).join(', ');
                                this.elements.printersList.innerHTML = links;
                                this.elements.printersBanner.hidden = false;
                            }
                        }
                    }
                } catch (error) {
                    // Could not fetch compatible printers - continue without them
                }
            }
        },

        updateSEO() {
            const BASE = 'https://www.inkcartridges.co.nz';
            const brand = this.state.brand;
            const category = this.state.category;
            const code = this.state.code;
            const brandName = this.brandInfo[brand]?.name || brand || '';
            const categoryLabels = {
                ink: 'Ink Cartridges', toner: 'Toner Cartridges',
                drum: 'Drum Units', consumable: 'Consumables'
            };
            const catLabel = categoryLabels[category] || 'Printing Supplies';

            let title, description, canonical;

            const params = new URLSearchParams();
            if (brand)              params.set('brand', brand);
            if (category)           params.set('category', category);
            if (code)               params.set('code', code);
            if (this.state.search)  params.set('q', this.state.search);
            const qs = params.toString() ? '?' + params.toString() : '';
            canonical = `${BASE}/html/shop${qs}`;

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
                    canonical   = `${BASE}/html/shop`;
            }

            document.title = title;

            const set = (id, attr, val) => { const el = document.getElementById(id); if (el) el[attr] = val; };
            set('meta-description', 'content', description);
            set('og-title',         'content', title);
            set('og-description',   'content', description);
            set('og-url',           'content', canonical);
            set('canonical-url',    'href',    canonical);

            // Update JSON-LD CollectionPage schema
            const schemaEl = document.getElementById('shop-schema');
            if (schemaEl) {
                const breadcrumbItems = [
                    { "@type": "ListItem", "position": 1, "name": "Home", "item": `${BASE}/` },
                    { "@type": "ListItem", "position": 2, "name": "Shop", "item": `${BASE}/html/shop` }
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
