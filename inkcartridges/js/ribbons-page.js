// ============================================
// RIBBONS PAGE - Brand grid → products drilldown
// ============================================

const RibbonsPage = {
    // Current state
    state: {
        brand: null,        // printer_brand value (lowercase, used for URL param and API filter)
        brandLabel: null,   // device_brand display label (e.g., "Olivetti", "Smith Corona")
        model: null,        // printer_model (specific model, used for direct URL navigation)
        ribbonBrand: null,  // manufacturer brand (API param: 'brand')
        color: null,
        sort: 'name',
        page: 1
    },

    // Navigation version to prevent race conditions
    navigationVersion: 0,

    // Products per page
    pageLimit: 48,

    // DOM Elements
    elements: {
        breadcrumbList: document.getElementById('breadcrumb-list'),
        title: document.getElementById('drilldown-title'),
        levelBrands: document.getElementById('level-brands'),
        levelProducts: document.getElementById('level-products'),
        productsGrid: document.getElementById('ribbon-products-grid'),
        pagination: document.getElementById('ribbon-pagination'),
        loading: document.getElementById('drilldown-loading'),
        empty: document.getElementById('drilldown-empty'),
        emptyMessage: document.getElementById('empty-message'),
        skeletonBrands: document.getElementById('skeleton-brands'),
        skeletonProducts: document.getElementById('skeleton-products')
    },

    // =========================================
    // INITIALIZATION
    // =========================================
    async init() {
        this.parseURLState();
        this.initFilterControls();
        this.syncFilterUI();

        if (this.state.brand || this.state.model) {
            // URL already has a brand or model — skip brand grid, show products directly
            this.showLevel('products');
            this.navigationVersion++;
            // Resolve proper brand label in parallel with loading products
            this.resolveBrandLabelFromAPI();
            await this.loadProducts(this.navigationVersion);
        } else {
            // No filter selected — show brand grid
            await this.loadBrands();
        }

        // Browser back/forward
        window.addEventListener('popstate', (e) => {
            if (e.state) {
                this.state = e.state;
            } else {
                this.parseURLState();
            }
            this.syncFilterUI();
            this.navigationVersion++;

            if (this.state.brand) {
                this.showLevel('products');
                this.loadProducts(this.navigationVersion);
            } else {
                this.showLevel('brands');
                this.updateBreadcrumb();
                this.updateTitle();
            }
        });
    },

    // =========================================
    // LEVEL MANAGEMENT
    // =========================================
    showLevel(which) {
        const levelBrands = this.elements.levelBrands;
        const levelProducts = this.elements.levelProducts;
        if (which === 'brands') {
            if (levelBrands) levelBrands.hidden = false;
            if (levelProducts) levelProducts.hidden = true;
            this.elements.empty.hidden = true;
        } else {
            if (levelBrands) levelBrands.hidden = true;
            if (levelProducts) levelProducts.hidden = false;
        }
    },

    // =========================================
    // BRAND GRID
    // =========================================
    async loadBrands() {
        const grid = document.getElementById('ribbons-brands-grid');
        if (!grid) return;

        // Show brand skeleton loading
        this.showLoadingState('brands', true);

        try {
            // Try new ribbon_brands table first, fall back to legacy API
            let brands = [];
            const res = await API.getRibbonBrandsList();
            const ribbonBrands = res?.data?.brands || [];

            if (ribbonBrands.length > 0) {
                // New system — ribbon_brands table with images and sort order
                brands = ribbonBrands.map(b => ({
                    id: b.id,
                    value: b.slug || b.name.toLowerCase(),
                    label: b.name,
                    image_url: b.image_url || null,
                    ribbon_brand_id: b.id,
                }));
            } else {
                // Fallback to legacy device-brands API
                const legacyRes = await API.getRibbonBrands();
                const rawBrands = legacyRes?.data?.brands || [];
                const EXCLUDED_BRANDS = new Set(['universal']);
                brands = rawBrands
                    .filter(name => !EXCLUDED_BRANDS.has(name.toLowerCase()))
                    .map(name => ({ value: name.toLowerCase(), label: name }));
            }

            this.showLoadingState('brands', false);

            if (brands.length === 0) {
                this.showEmpty('No ribbon brands found.');
                return;
            }

            grid.innerHTML = '';
            brands.forEach((b, i) => {
                const box = document.createElement('a');
                box.className = 'drilldown-box drilldown-box--ribbon';
                box.href = `/ribbons?printer_brand=${encodeURIComponent(b.value)}`;
                box.style.animationDelay = `${i * 30}ms`;
                // Show image if available, otherwise just the label
                if (b.image_url) {
                    box.innerHTML = `
                        <img class="drilldown-box__image" src="${Security.escapeAttr(b.image_url)}" alt="${Security.escapeAttr(b.label)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display=''">
                        <span class="drilldown-box__label" style="display:none">${Security.escapeHtml(b.label)}</span>
                        <span class="drilldown-box__label drilldown-box__label--below">${Security.escapeHtml(b.label)}</span>
                    `;
                } else {
                    box.innerHTML = `<span class="drilldown-box__label">${Security.escapeHtml(b.label)}</span>`;
                }
                box.addEventListener('click', (e) => {
                    e.preventDefault();
                    this.navigateToBrand(b.value, b.label);
                });
                grid.appendChild(box);
            });

            this.showLevel('brands');
            this.updateBreadcrumb();
            this.updateTitle();
        } catch (e) {
            this.showLoadingState('brands', false);
            this.showEmpty('Failed to load ribbon brands. Please try again.');
        }
    },

    resolveBrandLabel() {
        // If we have a brand from URL but no label, title-case it as a fallback
        // (proper label is resolved async via resolveBrandLabelFromAPI)
        if (this.state.brand && !this.state.brandLabel) {
            this.state.brandLabel = this.state.brand
                .split(/[\s-]+/)
                .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
                .join(' ');
        }
    },

    async resolveBrandLabelFromAPI() {
        // Fetch the proper label from device brands for correct casing (e.g., "IBM", "OKI")
        if (!this.state.brand) return;
        try {
            // Try new ribbon_brands table first
            const res = await API.getRibbonBrandsList();
            const ribbonBrands = res?.data?.brands || [];
            let brands;
            if (ribbonBrands.length > 0) {
                brands = ribbonBrands.map(b => ({ value: b.slug || b.name.toLowerCase(), label: b.name }));
            } else {
                const legacyRes = await API.getRibbonBrands();
                const rawBrands = legacyRes?.data?.brands || [];
                brands = rawBrands.map(name => ({ value: name.toLowerCase(), label: name }));
            }
            const match = brands.find(b => b.value === this.state.brand);
            if (match && match.label !== this.state.brandLabel) {
                this.state.brandLabel = match.label;
                this.updateTitle();
                this.updateBreadcrumb();
            }
        } catch (e) {
            // fallback title-case is already set, ignore
        }
    },


    navigateToBrand(brand, label) {
        this.state.brand = brand;
        this.state.brandLabel = label || brand;
        this.state.ribbonBrand = null;
        this.state.page = 1;
        this.updateURL();

        this.showLevel('products');
        this.navigationVersion++;
        this.loadProducts(this.navigationVersion);
        this.updateBreadcrumb();
        this.updateTitle();
    },

    goBackToBrands() {
        this.state.brand = null;
        this.state.brandLabel = null;
        this.state.ribbonBrand = null;
        this.state.page = 1;
        this.updateURL();
        window.scrollTo(0, 0);
        this.showLevel('brands');
        this.updateBreadcrumb();
        this.updateTitle();
    },

    // =========================================
    // FILTER CONTROLS
    // =========================================
    initFilterControls() {
        // Filter bar removed — no controls to initialise
    },

    syncFilterUI() {
        // Filter bar removed — nothing to sync
    },

    parseURLState() {
        const params = new URLSearchParams(window.location.search);
        this.state.brand = params.get('printer_brand');
        this.state.brandLabel = null; // resolved later from API or title-cased
        this.state.model = params.get('printer_model');
        this.state.ribbonBrand = params.get('brand');
        this.state.color = params.get('color');
        this.state.sort = params.get('sort') || 'name';
        this.state.page = parseInt(params.get('page')) || 1;
    },

    updateURL() {
        const params = new URLSearchParams();
        if (this.state.brand) params.set('printer_brand', this.state.brand);
        if (this.state.model) params.set('printer_model', this.state.model);
        if (this.state.ribbonBrand) params.set('brand', this.state.ribbonBrand);
        if (this.state.color) params.set('color', this.state.color);
        if (this.state.sort && this.state.sort !== 'name') params.set('sort', this.state.sort);
        if (this.state.page > 1) params.set('page', this.state.page);

        const newURL = params.toString()
            ? `${window.location.pathname}?${params.toString()}`
            : window.location.pathname;

        history.pushState({ ...this.state }, '', newURL);
    },

    // =========================================
    // NAVIGATION
    // =========================================
    navigateToPage(page) {
        this.navigationVersion++;
        const thisNavVersion = this.navigationVersion;
        this.state.page = page;
        this.updateURL();
        window.scrollTo(0, 0);
        this.loadProducts(thisNavVersion);
    },

    showLoadingState(type, show) {
        this.elements.loading.hidden = !show;
        if (type === 'brands') {
            if (this.elements.skeletonBrands) this.elements.skeletonBrands.hidden = !show;
            if (this.elements.skeletonProducts) this.elements.skeletonProducts.hidden = true;
        } else {
            if (this.elements.skeletonProducts) this.elements.skeletonProducts.hidden = !show;
            if (this.elements.skeletonBrands) this.elements.skeletonBrands.hidden = true;
        }
    },

    showLoading(show) {
        this.showLoadingState('products', show);
    },

    showEmpty(message) {
        if (this.elements.emptyMessage) {
            this.elements.emptyMessage.textContent = message;
        }
        this.elements.empty.hidden = false;
    },

    // =========================================
    // RIBBON MANUFACTURER BRANDS
    // =========================================
    async loadRibbonBrands() {
        const select = document.getElementById('ribbon-brand-filter');
        if (!select) return;
        try {
            const res = await API.getRibbonBrands();
            const brands = res?.data?.brands || [];
            if (brands.length > 0) {
                select.innerHTML = '<option value="">All Brands</option>' +
                    brands.map(b => `<option value="${Security.escapeAttr(b)}"${this.state.ribbonBrand === b ? ' selected' : ''}>${Security.escapeHtml(b)}</option>`).join('');
            }
        } catch (e) {
            // leave default "All Brands" option
        }
    },

    // =========================================
    // PRODUCTS
    // =========================================
    normalizeRibbon(ribbon) {
        if (!ribbon.image_url && ribbon.image_path) {
            const p = ribbon.image_path;
            ribbon.image_url = typeof storageUrl === 'function' ? storageUrl(p) : p;
        } else if (ribbon.image_url && !ribbon.image_url.startsWith('http') && typeof storageUrl === 'function') {
            ribbon.image_url = storageUrl(ribbon.image_url);
        }
        ribbon.in_stock = true;
        if (ribbon.retail_price == null && ribbon.sale_price != null) {
            ribbon.retail_price = ribbon.sale_price;
        }
        if (typeof ribbon.brand === 'string') {
            ribbon._brandName = ribbon.brand;
        } else if (ribbon.brand?.name) {
            ribbon._brandName = ribbon.brand.name;
        } else {
            ribbon._brandName = '';
        }
        return ribbon;
    },

    async loadProducts(navVersion) {
        this.showLoading(true);
        this.elements.levelProducts.hidden = false;
        this.elements.empty.hidden = true;

        // Update title/breadcrumb immediately so they reflect the brand even if the API fails
        this.resolveBrandLabel();
        this.updateBreadcrumb();
        this.updateTitle();

        try {
            const params = {
                page: this.state.page,
                limit: this.pageLimit,
                sort: this.state.sort
            };
            if (this.state.brand) params.printer_brand = this.state.brand;
            if (this.state.model) params.printer_model = this.state.model;
            if (this.state.ribbonBrand) params.brand = this.state.ribbonBrand;
            if (this.state.color) params.color = this.state.color;

            const res = this.state.brand
                ? await API.getRibbonsByBrand(this.state.brand)
                : await API.getRibbons(params);

            if (this.navigationVersion !== navVersion) return;
            this.showLoading(false);

            if (!res.ok || !res.data) {
                const activeBrand = this.state.brandLabel || this.state.brand || this.state.ribbonBrand;
                const msg = activeBrand
                    ? `No ribbons found for ${Security.escapeHtml(activeBrand)} yet. Check back soon!`
                    : 'Failed to load ribbons. Please try again.';
                this.showEmpty(msg);
                return;
            }

            let ribbons = res.data.products || res.data.ribbons || res.data || [];
            const pagination = res.meta || res.data.pagination || null;

            if (!Array.isArray(ribbons)) ribbons = [];
            ribbons = ribbons.map(r => this.normalizeRibbon(r));

            if (ribbons.length === 0) {
                const activeBrand = this.state.brandLabel || this.state.brand || this.state.ribbonBrand;
                const msg = activeBrand
                    ? `No ribbons found for ${Security.escapeHtml(activeBrand)} yet. Check back soon!`
                    : 'No ribbons found.';
                this.showEmpty(msg);
                return;
            }

            this.renderProducts(ribbons);
            this.renderPagination(pagination, ribbons.length);
            this.elements.levelProducts.hidden = false;

        } catch (error) {
            if (this.navigationVersion !== navVersion) return;
            DebugLog.error('Failed to load ribbons:', error);
            this.showLoading(false);
            this.showEmpty('Failed to load ribbons. Please try again.');
        }
    },

    renderProducts(ribbons) {
        const container = this.elements.levelProducts;
        const pagination = this.elements.pagination;

        // Remove any previously inserted section headings + grids
        container.querySelectorAll('.ribbon-section-heading, .ribbon-products-grid').forEach(el => el.remove());

        // Group ribbons by product_type
        const groups = {};
        ribbons.forEach(ribbon => {
            const type = ribbon.product_type || 'printer_ribbon';
            if (!groups[type]) groups[type] = [];
            groups[type].push(ribbon);
        });

        const sectionOrder = [
            { key: 'typewriter_ribbon', label: 'Typewriter Ribbons' },
            { key: 'printer_ribbon',    label: 'Printer Ribbons' },
            { key: 'correction_tape',   label: 'Correction Tape' },
        ];

        sectionOrder.forEach(section => {
            const items = groups[section.key];
            if (!items || items.length === 0) return;

            const heading = document.createElement('h2');
            heading.className = 'ribbon-section-heading';
            heading.textContent = section.label;
            container.insertBefore(heading, pagination);

            const grid = document.createElement('div');
            grid.className = 'ribbon-products-grid';
            items.forEach(ribbon => {
                grid.appendChild(this.createRibbonCard(ribbon));
            });
            container.insertBefore(grid, pagination);
        });

        // Image fallback listeners
        container.querySelectorAll('img[data-fallback]').forEach(img => {
            img.addEventListener('error', function() {
                if (this.dataset.fallback === 'placeholder') {
                    this.removeAttribute('data-fallback');
                    if (this.closest('.product-card')?.dataset.source === 'compatible') {
                        const placeholder = document.createElement('div');
                        placeholder.className = 'product-card__compatible-placeholder';
                        placeholder.innerHTML = '<span>COMPATIBLE</span>';
                        this.replaceWith(placeholder);
                    } else {
                        this.src = '/assets/images/placeholder-product.svg';
                    }
                }
            }, { once: true });
        });
    },

    createRibbonCard(ribbon) {
        const card = document.createElement('article');
        card.className = 'product-card';
        if (ribbon.source) card.dataset.source = ribbon.source;
        if (ribbon.device_models) {
            card.dataset.deviceModels = JSON.stringify(
                Array.isArray(ribbon.device_models)
                    ? ribbon.device_models.map(m => typeof m === 'string' ? m : (m.value || m.label || ''))
                    : []
            );
        }

        const price = ribbon.sale_price || ribbon.retail_price || 0;
        const inStock = true;
        const brandName = ribbon._brandName || '';
        const color = ribbon.color || '';
        const displayName = ribbon.name || '';
        const sku = ribbon.sku || '';
        const imageUrl = ribbon.image_url || '';
        const ribbonId = ribbon.id;

        const subtypeLabels = {
            printer_ribbon: 'Printer Ribbon',
            typewriter_ribbon: 'Typewriter Ribbon',
            correction_tape: 'Correction Tape',
        };
        const subtypeLabel = subtypeLabels[ribbon.product_type] || null;

        let imageContent;
        if (imageUrl) {
            imageContent = `<img src="${Security.escapeAttr(imageUrl)}" alt="${Security.escapeAttr(displayName)}" loading="lazy" data-fallback="placeholder">`;
        } else {
            imageContent = `<div class="product-card__color-block" style="background-color: #1a1a1a;"></div>`;
        }

        const isFav = typeof Favourites !== 'undefined' && Favourites.isFavourite && Favourites.isFavourite(ribbonId);
        const productUrl = sku ? `/ribbon/${Security.escapeAttr(sku)}` : '#';

        card.innerHTML = `
            <a href="${productUrl}" class="product-card__link">
                <div class="product-card__image-wrapper">
                    ${imageContent}
                </div>
                <div class="product-card__content">
                    <h3 class="product-card__title">${Security.escapeHtml(displayName)}</h3>
                    <div class="product-card__footer">
                        <div class="product-card__footer-row">
                            ${color ? `<span class="product-card__color">${Security.escapeHtml(color)}</span>` : '<span></span>'}
                            <span class="product-card__stock product-card__stock--${getStockStatus(ribbon).class}">${Security.escapeHtml(getStockStatus(ribbon).text)}</span>
                        </div>
                        <div class="product-card__footer-row">
                            <div class="product-card__pricing">
                                <span class="product-card__price">${formatPrice(price)}</span>
                            </div>
                            <button class="btn btn--primary btn--sm product-card__cart-btn"
                                    data-product-id="${ribbonId}"
                                    aria-label="Add ${Security.escapeAttr(displayName)} to cart"
                                    ${!inStock ? 'disabled' : ''}>
                                Add to Cart
                            </button>
                        </div>
                    </div>
                </div>
            </a>
            <button type="button" class="favourite-btn product-card__fav-btn ${isFav ? 'favourite-btn--active' : ''}"
                    data-product-id="${ribbonId}"
                    data-product-sku="${Security.escapeAttr(sku)}"
                    data-product-name="${Security.escapeAttr(displayName)}"
                    data-product-price="${price}"
                    data-product-image="${Security.escapeAttr(imageUrl)}"
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

        const cartBtn = card.querySelector('.product-card__cart-btn');
        cartBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            await this.addToCart(ribbon, cartBtn);
        });

        return card;
    },

    // =========================================
    // ADD TO CART
    // =========================================
    async addToCart(ribbon, button) {
        const originalText = button.textContent;
        button.textContent = 'Adding...';
        button.disabled = true;

        try {
            await Cart.addItem({
                id: ribbon.id,
                name: ribbon.name,
                price: ribbon.sale_price || ribbon.retail_price || 0,
                sku: ribbon.sku || '',
                image: ribbon.image_url || '',
                brand: ribbon._brandName || '',
                color: ribbon.color || '',
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
    // PAGINATION
    // =========================================
    renderPagination(pagination, ribbonCount) {
        const container = this.elements.pagination;
        if (!container) return;

        const totalItems = pagination ? (pagination.total || pagination.total_items || 0) : ribbonCount || 0;
        const current = pagination ? pagination.page : 1;
        const limit = this.pageLimit;
        const start = (current - 1) * limit + 1;
        const end = Math.min(current * limit, totalItems);
        const countHtml = totalItems > 0
            ? `<span class="pagination__count">Showing ${start}–${end} of ${totalItems} items</span>`
            : '';

        if (!pagination || pagination.total_pages <= 1) {
            container.innerHTML = totalItems > 0
                ? `<div class="pagination__bar">${countHtml}</div>`
                : '';
            return;
        }

        const total = pagination.total_pages;
        let items = '';

        items += `<li><button class="pagination__link ${!pagination.has_prev ? 'pagination__link--disabled' : ''}" data-page="${current - 1}" ${!pagination.has_prev ? 'disabled' : ''}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"></polyline></svg>
            Prev
        </button></li>`;

        for (let p = 1; p <= total; p++) {
            if (total > 7 && p > 2 && p < total - 1 && Math.abs(p - current) > 1) {
                if (p === 3 && current > 4) items += `<li class="pagination__item--ellipsis">...</li>`;
                else if (p === total - 2 && current < total - 3) items += `<li class="pagination__item--ellipsis">...</li>`;
                continue;
            }
            items += `<li><button class="pagination__link ${p === current ? 'pagination__link--active' : ''}" data-page="${p}">${p}</button></li>`;
        }

        items += `<li><button class="pagination__link ${!pagination.has_next ? 'pagination__link--disabled' : ''}" data-page="${current + 1}" ${!pagination.has_next ? 'disabled' : ''}>
            Next
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 6 15 12 9 18"></polyline></svg>
        </button></li>`;

        container.innerHTML = `<div class="pagination__center">${countHtml}<ul class="pagination__list">${items}</ul></div>`;

        container.querySelectorAll('.pagination__link[data-page]').forEach(btn => {
            btn.addEventListener('click', () => {
                const page = parseInt(btn.dataset.page);
                if (!isNaN(page) && page >= 1) {
                    this.navigateToPage(page);
                }
            });
        });
    },

    // =========================================
    // UI UPDATES
    // =========================================
    updateBreadcrumb() {
        const list = this.elements.breadcrumbList;
        list.innerHTML = '';

        const activeBrand = this.state.brandLabel || this.state.brand || this.state.ribbonBrand;
        const model = this.state.model;

        if (activeBrand && model) {
            // Show: Ribbons > Brand > Model
            list.appendChild(this.createBreadcrumbItem('Ribbons', false, () => this.goBackToBrands()));
            list.appendChild(this.createBreadcrumbItem(activeBrand, false, () => this.goBackToBrand()));
            list.appendChild(this.createBreadcrumbItem(model, true));
        } else if (activeBrand) {
            // Show: Ribbons > Brand
            list.appendChild(this.createBreadcrumbItem('Ribbons', false, () => this.goBackToBrands()));
            list.appendChild(this.createBreadcrumbItem(activeBrand, true));
        } else if (model) {
            // Show: Ribbons > Model (direct URL navigation without brand)
            list.appendChild(this.createBreadcrumbItem('Ribbons', false, () => this.goBackToBrands()));
            list.appendChild(this.createBreadcrumbItem(model, true));
        } else {
            list.appendChild(this.createBreadcrumbItem('Ribbons', true));
        }

        this.updateSchemaLD();
    },

    goBackToBrand() {
        // Keep brand, clear model — go back to brand-level products
        this.state.model = null;
        this.state.page = 1;
        this.updateURL();
        window.scrollTo(0, 0);
        this.showLevel('products');
        this.navigationVersion++;
        this.loadProducts(this.navigationVersion);
        this.updateBreadcrumb();
        this.updateTitle();
    },

    updateSchemaLD() {
        const el = document.getElementById('ribbons-schema');
        if (!el) return;
        const base = 'https://www.inkcartridges.co.nz';
        const ribbonsUrl = base + '/ribbons';
        const items = [
            { "@type": "ListItem", "position": 1, "name": "Home", "item": base + '/' },
            { "@type": "ListItem", "position": 2, "name": "Ribbons", "item": ribbonsUrl }
        ];
        let pageUrl = ribbonsUrl;
        let pageName = 'Typewriter & Printer Ribbons';
        const activeBrandLabel = this.state.brandLabel || this.state.brand || this.state.ribbonBrand;
        const model = this.state.model;
        if (activeBrandLabel) {
            const paramName = this.state.brand ? 'printer_brand' : 'brand';
            const paramValue = this.state.brand || this.state.ribbonBrand;
            const brandUrl = ribbonsUrl + `?${paramName}=` + encodeURIComponent(paramValue);
            items.push({ "@type": "ListItem", "position": 3, "name": activeBrandLabel, "item": brandUrl });
            if (model) {
                pageUrl = brandUrl + '&printer_model=' + encodeURIComponent(model);
                pageName = activeBrandLabel + ' ' + model + ' Ribbons';
                items.push({ "@type": "ListItem", "position": 4, "name": model, "item": pageUrl });
            } else {
                pageUrl = brandUrl;
                pageName = activeBrandLabel + ' Ribbons';
            }
        } else if (model) {
            pageUrl = ribbonsUrl + '?printer_model=' + encodeURIComponent(model);
            pageName = 'Ribbons for ' + model;
            items.push({ "@type": "ListItem", "position": 3, "name": model, "item": pageUrl });
        }
        el.textContent = JSON.stringify({
            "@context": "https://schema.org",
            "@type": "CollectionPage",
            "name": pageName,
            "url": pageUrl,
            "breadcrumb": { "@type": "BreadcrumbList", "itemListElement": items }
        });
    },

    createBreadcrumbItem(text, isCurrent, onClick) {
        const li = document.createElement('li');
        li.className = `drilldown-breadcrumb__item${isCurrent ? ' drilldown-breadcrumb__item--current' : ''}`;

        if (isCurrent || !onClick) {
            li.innerHTML = `<span>${Security.escapeHtml(text)}</span>`;
        } else {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'drilldown-breadcrumb__link';
            btn.textContent = text;
            btn.addEventListener('click', onClick);
            li.appendChild(btn);

            const sep = document.createElement('span');
            sep.className = 'drilldown-breadcrumb__sep';
            sep.setAttribute('aria-hidden', 'true');
            sep.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>`;
            li.appendChild(sep);
        }

        return li;
    },

    updateTitle() {
        const title = this.elements.title;
        const activeBrand = this.state.brandLabel || this.state.brand || this.state.ribbonBrand;
        const model = this.state.model;
        if (activeBrand && model) {
            title.textContent = `${activeBrand} ${model} Ribbons`;
        } else if (model) {
            title.textContent = `Ribbons for ${model}`;
        } else if (activeBrand) {
            title.textContent = `${activeBrand} Typewriter & Printer Ribbons`;
        } else {
            title.textContent = 'Typewriter & Printer Ribbons';
        }
        title.hidden = false;

        // Update document title to match
        const docPrefix = activeBrand ? `${activeBrand} ` : '';
        document.title = `${docPrefix}Typewriter & Printer Ribbons | InkCartridges.co.nz`;
    }
};

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    RibbonsPage.init();
});
