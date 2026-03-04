// ============================================
// RIBBONS PAGE - Shows all ribbon products, optionally filtered by brand
// ============================================
const RibbonsPage = {
    // Current state
    state: {
        brand: null,
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
        this.navigationVersion++;
        await this.loadProducts(this.navigationVersion);

        // Browser back/forward
        window.addEventListener('popstate', (e) => {
            if (e.state) {
                this.state = e.state;
            } else {
                this.parseURLState();
            }
            this.navigationVersion++;
            this.loadProducts(this.navigationVersion);
        });
    },

    parseURLState() {
        const params = new URLSearchParams(window.location.search);
        this.state.brand = params.get('brand');
        this.state.page = parseInt(params.get('page')) || 1;
    },

    updateURL() {
        const params = new URLSearchParams();
        if (this.state.brand) params.set('brand', this.state.brand);
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

        try {
            const params = {
                page: this.state.page,
                limit: this.pageLimit
            };
            if (this.state.brand) {
                params.search = this.state.brand;
            }
            const res = await API.getRibbons(params);

            // Check for stale navigation
            if (this.navigationVersion !== navVersion) return;

            this.showLoading(false);

            if (!res.ok || !res.data) {
                this.showEmpty('Failed to load ribbons. Please try again.');
                return;
            }

            let ribbons = res.data.ribbons || res.data || [];
            const pagination = res.meta || res.data.pagination || null;

            if (!Array.isArray(ribbons) || ribbons.length === 0) {
                const msg = this.state.brand
                    ? `No ribbons found for ${Security.escapeHtml(this.state.brand)}.`
                    : 'No ribbons found.';
                this.showEmpty(msg);
                return;
            }

            ribbons = ribbons.map(r => this.normalizeRibbon(r));

            this.renderProducts(ribbons);
            this.renderPagination(pagination);
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
                    this.src = '/assets/images/placeholder-product.svg';
                }
            }, { once: true });
        });
    },

    createRibbonCard(ribbon) {
        const card = document.createElement('article');
        card.className = 'product-card';

        const price = ribbon.sale_price || ribbon.retail_price || 0;
        const inStock = ribbon.in_stock !== false;
        const brandName = ribbon._brandName || '';
        const color = ribbon.color || '';
        const displayName = ribbon.name || '';
        const sku = ribbon.sku || '';
        const imageUrl = ribbon.image_url || '';
        const ribbonId = ribbon.id;

        const imageContent = imageUrl
            ? `<img src="${Security.escapeAttr(imageUrl)}" alt="${Security.escapeAttr(displayName)}" loading="lazy" data-fallback="placeholder">`
            : `<svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
                <circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/>
            </svg>`;

        const isFav = typeof Favourites !== 'undefined' && Favourites.isFavourite && Favourites.isFavourite(ribbonId);

        card.innerHTML = `
            <a href="/html/product/index.html?sku=${Security.escapeAttr(sku)}&type=ribbon" class="product-card__link">
                <div class="product-card__image">
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
    renderPagination(pagination) {
        const container = this.elements.pagination;
        if (!container) return;

        if (!pagination || pagination.total_pages <= 1) {
            container.innerHTML = '';
            return;
        }

        if (typeof Products !== 'undefined' && Products.renderPagination) {
            container.innerHTML = Products.renderPagination(pagination);
        } else {
            const current = pagination.page;
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

            container.innerHTML = `<ul class="pagination__list">${items}</ul>`;
        }

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
                this.state.page = 1;
                this.navigationVersion++;
                this.updateURL();
                window.scrollTo(0, 0);
                this.loadProducts(this.navigationVersion);
            });
            list.appendChild(ribbonsItem);

            const brandItem = this.createBreadcrumbItem(this.state.brand, true);
            list.appendChild(brandItem);
        } else {
            // Show: Ribbons (current)
            const ribbonsItem = this.createBreadcrumbItem('Ribbons', true);
            list.appendChild(ribbonsItem);
        }
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
