/**
 * PRODUCTS.JS
 * ===========
 * Product loading and rendering for InkCartridges.co.nz
 */

const Products = {
    /**
     * Get color style for a product color (delegates to shared ProductColors utility)
     */
    getColorStyle(colorName) {
        return ProductColors.getStyle(colorName);
    },

    /**
     * Detect color from product name (delegates to shared ProductColors utility)
     */
    detectColorFromName(name) {
        return ProductColors.detectFromName(name);
    },

    /**
     * Get image HTML for a product (with color fallback)
     */
    getProductImageHTML(product) {
        const colorStyle = ProductColors.getProductStyle(product);
        const imageUrl = typeof storageUrl === 'function' ? storageUrl(product.image_url) : product.image_url;
        if (imageUrl && imageUrl !== '/assets/images/placeholder-product.svg') {
            // Has image URL - use it with error fallback (listeners attached after DOM insertion)
            if (colorStyle) {
                return `<img src="${Security.escapeAttr(imageUrl)}"
                             alt="${Security.escapeAttr(product.name)}"
                             class="product-card__image"
                             width="200" height="200"
                             loading="lazy"
                             data-fallback="color-block">
                        <div class="product-card__color-block" style="${colorStyle}; display: none;"></div>`;
            } else {
                return `<img src="${Security.escapeAttr(imageUrl)}"
                             alt="${Security.escapeAttr(product.name)}"
                             class="product-card__image"
                             width="200" height="200"
                             loading="lazy"
                             data-fallback="placeholder">`;
            }
        } else if (colorStyle && product.source === 'compatible') {
            // Compatible with no image but has color - show color block
            return `<div class="product-card__color-block" style="${colorStyle}"></div>`;
        } else if (product.source === 'compatible') {
            // Compatible with no known color - default to black
            return `<div class="product-card__color-block" style="background-color: #1a1a1a;"></div>`;
        } else {
            // Genuine with no image, no color - show placeholder
            return `<img src="/assets/images/placeholder-product.svg"
                         alt="${Security.escapeAttr(product.name)}"
                         class="product-card__image"
                         width="200" height="200"
                         loading="lazy">`;
        }
    },

    /**
     * Render a product card
     * @param {object} product - Product data from API
     * @returns {string} HTML string
     */
    renderCard(product) {
        const sourceBadge = getSourceBadge(product.source);
        const stockInfo = getStockStatus(product);
        const resolvedImage = typeof storageUrl === 'function' ? storageUrl(product.image_url) : (product.image_url || '');

        return `
            <article class="product-card" data-product-id="${Security.escapeAttr(product.id)}" data-sku="${Security.escapeAttr(product.sku)}">
                <a href="${product.slug ? `/products/${Security.escapeAttr(product.slug)}/${Security.escapeAttr(product.sku)}` : `/html/product/?sku=${Security.escapeAttr(product.sku)}`}" class="product-card__link">
                    <div class="product-card__image-wrapper">
                        ${this.getProductImageHTML(product)}
                        ${sourceBadge ? `<span class="product-card__badge ${sourceBadge.class}">${sourceBadge.text}</span>` : ''}
                    </div>
                    <div class="product-card__content">
                        <p class="product-card__brand">${Security.escapeHtml(product.brand?.name || '')}</p>
                        <h3 class="product-card__title" title="${Security.escapeAttr(product.name)}">${Security.escapeHtml(product.name)}</h3>
                        ${product.color ? `<p class="product-card__color">${Security.escapeHtml(product.color)}</p>` : ''}
                        <p class="product-card__price">${product.retail_price == null ? 'Price unavailable' : formatPrice(product.retail_price)}${product.compare_price && product.compare_price > product.retail_price ? `<span class="product-card__compare-price">${formatPrice(product.compare_price)}</span>` : ''}</p>
                        ${product.compare_price && product.compare_price > product.retail_price ? `<p class="product-card__savings">Save ${formatPrice(product.compare_price - product.retail_price)}</p>` : ''}
                        <p class="product-card__stock stock-${stockInfo.class}">${Security.escapeHtml(stockInfo.text)}</p>
                    </div>
                </a>
                <button class="product-card__add-btn btn btn--primary"
                        ${product.retail_price == null || stockInfo.class === 'out-of-stock' ? 'disabled' : ''}
                        data-product-id="${Security.escapeAttr(product.id)}"
                        data-product-sku="${Security.escapeAttr(product.sku)}"
                        data-product-name="${Security.escapeAttr(product.name)}"
                        data-product-price="${Security.escapeAttr(product.retail_price)}"
                        data-product-image="${Security.escapeAttr(resolvedImage)}"
                        data-product-color="${Security.escapeAttr(product.color || this.detectColorFromName(product.name) || '')}">
                    Add to Cart
                </button>
            </article>
        `;
    },

    /**
     * Render multiple product cards
     * @param {array} products - Array of products
     * @returns {string} HTML string
     */
    renderCards(products) {
        if (!products || products.length === 0) {
            return `
                <div class="products-empty">
                    <svg class="products-empty__icon" xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <circle cx="11" cy="11" r="8"></circle>
                        <path d="m21 21-4.35-4.35"></path>
                    </svg>
                    <h3>No products found</h3>
                    <p>Try adjusting your filters or search terms.</p>
                </div>
            `;
        }

        return products.map(p => this.renderCard(p)).join('');
    },

    /**
     * Render pagination
     * @param {object} pagination - Pagination data from API
     * @returns {string} HTML string
     */
    renderPagination(pagination) {
        if (!pagination || pagination.total_pages <= 1) return '';

        let pages = '';
        const current = pagination.page;
        const total = pagination.total_pages;

        // Previous button
        pages += `
            <button class="pagination__btn pagination__btn--prev"
                    ${!pagination.has_prev ? 'disabled' : ''}
                    data-page="${current - 1}">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="15 18 9 12 15 6"></polyline>
                </svg>
                Previous
            </button>
        `;

        // Page numbers
        const range = this.getPaginationRange(current, total);
        range.forEach(page => {
            if (page === '...') {
                pages += '<span class="pagination__ellipsis">...</span>';
            } else {
                pages += `
                    <button class="pagination__btn pagination__btn--page ${page === current ? 'active' : ''}"
                            data-page="${page}">
                        ${page}
                    </button>
                `;
            }
        });

        // Next button
        pages += `
            <button class="pagination__btn pagination__btn--next"
                    ${!pagination.has_next ? 'disabled' : ''}
                    data-page="${current + 1}">
                Next
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="9 18 15 12 9 6"></polyline>
                </svg>
            </button>
        `;

        return `
            <nav class="pagination" aria-label="Product pagination">
                <p class="pagination__info">
                    Showing ${(current - 1) * pagination.limit + 1}-${Math.min(current * pagination.limit, pagination.total)} of ${pagination.total} products
                </p>
                <div class="pagination__controls">
                    ${pages}
                </div>
            </nav>
        `;
    },

    /**
     * Get pagination range
     */
    getPaginationRange(current, total) {
        if (total <= 7) {
            return Array.from({ length: total }, (_, i) => i + 1);
        }

        if (current <= 3) {
            return [1, 2, 3, 4, 5, '...', total];
        }

        if (current >= total - 2) {
            return [1, '...', total - 4, total - 3, total - 2, total - 1, total];
        }

        return [1, '...', current - 1, current, current + 1, '...', total];
    },

    /**
     * Load and render products into a container
     * @param {string} containerId - Container element ID
     * @param {object} filters - Filter parameters
     */
    async loadIntoContainer(containerId, filters = {}) {
        const container = document.getElementById(containerId);
        if (!container) return;

        // Show loading state
        container.innerHTML = `
            <div class="products-loading">
                <div class="spinner"></div>
                <p>Loading products...</p>
            </div>
        `;

        try {
            const response = await API.getProducts(filters);

            if (response.ok && response.data) {
                const { products, pagination } = response.data;

                // Render products
                container.innerHTML = this.renderCards(products);

                // Render pagination
                const paginationContainer = document.getElementById('pagination');
                if (paginationContainer && pagination) {
                    paginationContainer.innerHTML = this.renderPagination(pagination);
                    this.bindPaginationEvents(paginationContainer, filters);
                }

                // Update results count
                const resultsCount = document.getElementById('results-count');
                if (resultsCount && pagination) {
                    resultsCount.textContent = `Showing ${products.length} of ${pagination.total} products`;
                }

                // Bind image fallbacks and add to cart buttons
                this.bindImageFallbacks(container);
                this.bindAddToCartEvents(container);
            }
        } catch (error) {
            DebugLog.error('Error loading products:', error);
            container.innerHTML = `
                <div class="products-error">
                    <p>Failed to load products. Please try again.</p>
                    <button class="btn btn--secondary" data-action="reload">Retry</button>
                </div>
            `;
            container.querySelector('[data-action="reload"]')?.addEventListener('click', () => location.reload());
        }
    },

    /**
     * Bind pagination click events
     */
    bindPaginationEvents(container, currentFilters) {
        container.querySelectorAll('.pagination__btn[data-page]').forEach(btn => {
            btn.addEventListener('click', () => {
                const page = parseInt(btn.dataset.page);
                if (!isNaN(page)) {
                    this.loadIntoContainer('products-grid', { ...currentFilters, page });
                    // Scroll to top of products
                    document.getElementById('products-grid')?.scrollIntoView({ behavior: 'smooth' });
                }
            });
        });
    },

    /**
     * Bind image error fallback handlers (replaces inline onerror)
     */
    bindImageFallbacks(container) {
        container.querySelectorAll('img[data-fallback]').forEach(img => {
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
    },

    /**
     * Bind add to cart button events
     */
    bindAddToCartEvents(container) {
        container.querySelectorAll('.product-card__add-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();

                const productId = btn.dataset.productId;
                const productData = {
                    id: productId,
                    sku: btn.dataset.productSku,
                    name: btn.dataset.productName,
                    price: parseFloat(btn.dataset.productPrice),
                    image: btn.dataset.productImage,
                    color: btn.dataset.productColor
                };

                // Add to cart (server-first for authenticated users)
                if (typeof Cart !== 'undefined') {
                    await Cart.addItem(productData);
                }

                // Show feedback
                btn.textContent = 'Added!';
                btn.classList.add('btn--success');
                setTimeout(() => {
                    btn.textContent = 'Add to Cart';
                    btn.classList.remove('btn--success');
                }, 1500);
            });
        });
    },

    /**
     * Load featured products for homepage
     * @param {string} containerId - Container element ID
     */
    async loadFeatured(containerId) {
        const container = document.getElementById(containerId);
        if (!container) return;

        try {
            const response = await API.getProducts({ limit: 8 });

            if (response.ok && response.data?.products) {
                // Filter for featured if field exists, otherwise just use first 4
                let products = response.data.products;
                const featured = products.filter(p => p.is_featured);
                products = featured.length >= 4 ? featured.slice(0, 4) : products.slice(0, 4);

                container.innerHTML = products.map(p => this.renderCard(p)).join('');
                this.bindImageFallbacks(container);
                this.bindAddToCartEvents(container);
            }
        } catch (error) {
            DebugLog.error('Error loading featured products:', error);
        }
    },

    /**
     * Load single product detail
     * @param {string} sku - Product SKU
     */
    async loadProductDetail(sku) {
        try {
            const response = await API.getProduct(sku);
            if (response.ok && response.data) {
                return response.data;
            }
            return null;
        } catch (error) {
            DebugLog.error('Error loading product:', error);
            return null;
        }
    }
};

// Make Products available globally
window.Products = Products;
