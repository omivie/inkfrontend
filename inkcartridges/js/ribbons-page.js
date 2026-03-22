// ============================================
// RIBBONS PAGE - Shows all ribbon products, optionally filtered by brand
// ============================================
const RibbonsPage = {
    // Current state
    state: {
        brand: null,        // device_brand (what machine the customer has)
        model: null,        // device_model (specific model drill-down)
        ribbonBrand: null,  // manufacturer brand (API param: 'brand')
        color: null,
        sort: 'name',
        page: 1
    },

    // Navigation version to prevent race conditions
    navigationVersion: 0,

    // Products per page
    pageLimit: 48,

    // Per-brand model cache
    _modelsCache: {},

    // DOM Elements
    elements: {
        breadcrumbList: document.getElementById('breadcrumb-list'),
        title: document.getElementById('drilldown-title'),
        levelProducts: document.getElementById('level-products'),
        productsGrid: document.getElementById('ribbon-products-grid'),
        pagination: document.getElementById('ribbon-pagination'),
        loading: document.getElementById('drilldown-loading'),
        empty: document.getElementById('drilldown-empty'),
        emptyMessage: document.getElementById('empty-message'),
        skeletonProducts: document.getElementById('skeleton-products')
    },

    // =========================================
    // INITIALIZATION
    // =========================================
    async init() {
        // Hide the brand grid level — no longer used
        const levelBrands = document.getElementById('level-brands');
        if (levelBrands) levelBrands.hidden = true;

        this.parseURLState();
        this.initFilterControls();
        this.syncFilterUI();

        // Load ribbon manufacturer brands for dropdown (non-blocking)
        this.loadRibbonBrands();

        this.navigationVersion++;
        await this.loadProducts(this.navigationVersion);

        // Browser back/forward
        window.addEventListener('popstate', (e) => {
            if (e.state) {
                this.state = e.state;
            } else {
                this.parseURLState();
            }
            this.syncFilterUI();
            this.navigationVersion++;
            this.loadProducts(this.navigationVersion);
        });
    },

    initFilterControls() {
        // Color filter buttons
        document.querySelectorAll('.ribbon-color-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                this.state.color = btn.dataset.color || null;
                this.state.page = 1;
                this.syncFilterUI();
                this.navigationVersion++;
                this.updateURL();
                this.loadProducts(this.navigationVersion);
            });
        });

        // Ribbon manufacturer brand select
        const brandSelect = document.getElementById('ribbon-brand-filter');
        if (brandSelect) {
            brandSelect.addEventListener('change', () => {
                this.state.ribbonBrand = brandSelect.value || null;
                this.state.page = 1;
                this.navigationVersion++;
                this.updateURL();
                this.loadProducts(this.navigationVersion);
            });
        }

        // Sort select
        const sortSelect = document.getElementById('ribbon-sort');
        if (sortSelect) {
            sortSelect.addEventListener('change', () => {
                this.state.sort = sortSelect.value;
                this.state.page = 1;
                this.navigationVersion++;
                this.updateURL();
                this.loadProducts(this.navigationVersion);
            });
        }
    },

    syncFilterUI() {
        document.querySelectorAll('.ribbon-color-btn').forEach(btn => {
            const btnColor = btn.dataset.color || null;
            btn.classList.toggle('ribbon-color-btn--active', btnColor === this.state.color);
        });
        const brandSelect = document.getElementById('ribbon-brand-filter');
        if (brandSelect) brandSelect.value = this.state.ribbonBrand || '';
        const sortSelect = document.getElementById('ribbon-sort');
        if (sortSelect) sortSelect.value = this.state.sort || 'name';
    },

    parseURLState() {
        const params = new URLSearchParams(window.location.search);
        this.state.brand = params.get('device_brand');
        this.state.model = params.get('device_model');
        this.state.ribbonBrand = params.get('brand');
        this.state.color = params.get('color');
        this.state.sort = params.get('sort') || 'name';
        this.state.page = parseInt(params.get('page')) || 1;
    },

    updateURL() {
        const params = new URLSearchParams();
        if (this.state.brand) params.set('device_brand', this.state.brand);
        if (this.state.model) params.set('device_model', this.state.model);
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

    showLoading(show) {
        this.elements.loading.hidden = !show;
        if (this.elements.skeletonProducts) {
            this.elements.skeletonProducts.hidden = !show;
        }
    },

    showEmpty(message) {
        if (this.elements.emptyMessage) {
            this.elements.emptyMessage.textContent = message;
        }
        this.elements.empty.hidden = false;
    },

    // =========================================
    // MODEL DRILL-DOWN
    // =========================================
    async loadModels(brand) {
        const container = document.getElementById('ribbon-model-pills');
        const inner = document.getElementById('ribbon-model-pills-inner');
        if (!container || !inner) return;

        if (!this._modelsCache[brand]) {
            try {
                const res = await API.getRibbonDeviceModels({ device_brand: brand });
                this._modelsCache[brand] = res?.data?.device_models || [];
            } catch (e) {
                this._modelsCache[brand] = [];
            }
        }

        // Guard: brand may have changed while we were fetching
        if (this.state.brand !== brand) return;

        const models = this._modelsCache[brand];
        // Only show if there are specific models beyond "All Models"
        if (models.length <= 1) {
            container.hidden = true;
            return;
        }

        inner.innerHTML = models.map(m => {
            const isActive = m.value === (this.state.model || 'all-models');
            return `<button class="ribbon-model-btn${isActive ? ' ribbon-model-btn--active' : ''}" data-model="${Security.escapeAttr(m.value)}" type="button">${Security.escapeHtml(m.label)}</button>`;
        }).join('');

        inner.querySelectorAll('.ribbon-model-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const val = btn.dataset.model;
                this.state.model = (val === 'all-models') ? null : val;
                this.state.page = 1;
                inner.querySelectorAll('.ribbon-model-btn').forEach(b =>
                    b.classList.toggle('ribbon-model-btn--active', b.dataset.model === (this.state.model || 'all-models'))
                );
                this.navigationVersion++;
                this.updateURL();
                this.loadProducts(this.navigationVersion);
            });
        });

        container.hidden = false;
    },

    clearModelPills() {
        const container = document.getElementById('ribbon-model-pills');
        if (container) container.hidden = true;
        const inner = document.getElementById('ribbon-model-pills-inner');
        if (inner) inner.innerHTML = '';
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
            ribbon.image_url = typeof storageUrl === 'function' ? storageUrl(ribbon.image_path) : ribbon.image_path;
        }
        if (ribbon.in_stock == null && ribbon.stock_quantity != null) {
            ribbon.in_stock = ribbon.stock_quantity > 0;
        }
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
        this.elements.levelProducts.hidden = true;
        this.elements.empty.hidden = true;

        // Clear model pills when no brand is selected
        if (!this.state.brand) {
            this.clearModelPills();
        }

        try {
            const params = {
                page: this.state.page,
                limit: this.pageLimit,
                sort: this.state.sort
            };
            if (this.state.brand) params.device_brand = this.state.brand;
            if (this.state.model) params.device_model = this.state.model;
            if (this.state.ribbonBrand) params.brand = this.state.ribbonBrand;
            if (this.state.color) params.color = this.state.color;

            // Load models in parallel when a device brand is selected
            if (this.state.brand) {
                this.loadModels(this.state.brand);
            }

            const res = await API.getRibbons(params);

            if (this.navigationVersion !== navVersion) return;
            this.showLoading(false);

            if (!res.ok || !res.data) {
                this.showEmpty('Failed to load ribbons. Please try again.');
                return;
            }

            let ribbons = res.data.products || res.data.ribbons || res.data || [];
            const pagination = res.meta || res.data.pagination || null;

            if (!Array.isArray(ribbons)) ribbons = [];
            ribbons = ribbons.map(r => this.normalizeRibbon(r));

            if (ribbons.length === 0) {
                const msg = this.state.brand
                    ? `No ribbons found for ${Security.escapeHtml(this.state.brand)}.`
                    : 'No ribbons found.';
                this.showEmpty(msg);
                return;
            }

            this.renderProducts(ribbons);
            this.renderPagination(pagination, ribbons.length);
            this.elements.levelProducts.hidden = false;
            this.updateBreadcrumb();
            this.updateTitle();

        } catch (error) {
            if (this.navigationVersion !== navVersion) return;
            DebugLog.error('Failed to load ribbons:', error);
            this.showLoading(false);
            this.showEmpty('Failed to load ribbons. Please try again.');
        }
    },

    renderProducts(ribbons) {
        const grid = this.elements.productsGrid;
        grid.innerHTML = '';

        ribbons.forEach(ribbon => {
            const card = this.createRibbonCard(ribbon);
            grid.appendChild(card);
        });

        grid.querySelectorAll('img[data-fallback]').forEach(img => {
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

        const price = ribbon.sale_price || ribbon.retail_price || 0;
        const inStock = ribbon.in_stock !== false;
        const brandName = ribbon._brandName || '';
        const color = ribbon.color || '';
        const displayName = ribbon.name || '';
        const sku = ribbon.sku || '';
        const imageUrl = ribbon.image_url || '';
        const ribbonId = ribbon.id;

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
                    ${color ? `<span class="product-card__color">${Security.escapeHtml(color)}</span>` : ''}
                    <div class="product-card__pricing">
                        <span class="product-card__price">${formatPrice(price)}</span>
                    </div>
                    <span class="product-card__stock ${inStock ? 'product-card__stock--in' : 'product-card__stock--out'}">
                        ${inStock ? 'In Stock' : 'Out of Stock'}
                    </span>
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
            <button class="btn btn--primary btn--sm product-card__cart-btn"
                    data-product-id="${ribbonId}"
                    aria-label="Add ${Security.escapeAttr(displayName)} to cart"
                    ${!inStock ? 'disabled' : ''}>
                Add to Cart
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

        if (this.state.brand) {
            // Show: Ribbons > Brand
            const ribbonsItem = this.createBreadcrumbItem('Ribbons', false, () => {
                this.state.brand = null;
                this.state.model = null;
                this.state.page = 1;
                this.clearModelPills();
                this.navigationVersion++;
                this.updateURL();
                window.scrollTo(0, 0);
                this.loadProducts(this.navigationVersion);
            });
            list.appendChild(ribbonsItem);

            const brandItem = this.createBreadcrumbItem(this.state.brand, true);
            list.appendChild(brandItem);
        } else {
            const ribbonsItem = this.createBreadcrumbItem('Ribbons', true);
            list.appendChild(ribbonsItem);
        }

        this.updateSchemaLD();
    },

    updateSchemaLD() {
        const el = document.getElementById('ribbons-schema');
        if (!el) return;
        const base = 'https://inkcartridges.co.nz';
        const ribbonsUrl = base + '/html/ribbons';
        const items = [
            { "@type": "ListItem", "position": 1, "name": "Home", "item": base + '/' },
            { "@type": "ListItem", "position": 2, "name": "Ribbons", "item": ribbonsUrl }
        ];
        let pageUrl = ribbonsUrl;
        let pageName = 'Typewriter & Printer Ribbons NZ';
        if (this.state.brand) {
            pageUrl = ribbonsUrl + '?device_brand=' + encodeURIComponent(this.state.brand);
            pageName = this.state.brand + ' Ribbons';
            items.push({ "@type": "ListItem", "position": 3, "name": this.state.brand, "item": pageUrl });
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
        if (this.state.brand) {
            title.textContent = `${this.state.brand} Ribbons`;
            title.hidden = false;
        } else {
            title.textContent = 'All Ribbons';
            title.hidden = false;
        }
    }
};

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    RibbonsPage.init();
});
