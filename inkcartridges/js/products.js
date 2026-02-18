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
        const color = product.color || this.detectColorFromName(product.name);
        const colorStyle = color ? this.getColorStyle(color) : null;

        if (product.image_url) {
            // Has image URL - use it with onerror fallback
            if (colorStyle) {
                // Fallback to color block on error
                return `<img src="${Security.escapeAttr(product.image_url)}"
                             alt="${Security.escapeAttr(product.name)}"
                             class="product-card__image"
                             loading="lazy"
                             onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                        <div class="product-card__color-block" style="${colorStyle}; display: none;"></div>`;
            } else {
                // Fallback to placeholder on error
                return `<img src="${Security.escapeAttr(product.image_url)}"
                             alt="${Security.escapeAttr(product.name)}"
                             class="product-card__image"
                             loading="lazy"
                             onerror="this.onerror=null; this.src='/assets/images/placeholder-product.svg';">`;
            }
        } else if (colorStyle) {
            // No image but has color - show color block
            return `<div class="product-card__color-block" style="${colorStyle}"></div>`;
        } else {
            // No image, no color - show placeholder
            return `<img src="/assets/images/placeholder-product.svg"
                         alt="${Security.escapeAttr(product.name)}"
                         class="product-card__image"
                         loading="lazy">`;
        }
    },

    /**
     * Render a product card
     * @param {object} product - Product data from API
     * @returns {string} HTML string
     */
    renderCard(product) {
        const stockStatus = getStockStatus(product);
        const sourceBadge = getSourceBadge(product.source);

        return `
            <article class="product-card" data-product-id="${Security.escapeAttr(product.id)}" data-sku="${Security.escapeAttr(product.sku)}">
                <a href="/html/product/index.html?sku=${Security.escapeAttr(product.sku)}" class="product-card__link">
                    <div class="product-card__image-wrapper">
                        ${this.getProductImageHTML(product)}
                        ${sourceBadge ? `<span class="product-card__badge ${sourceBadge.class}">${sourceBadge.text}</span>` : ''}
                        ${!product.in_stock ? '<span class="product-card__badge badge-out-of-stock">Out of Stock</span>' : ''}
                    </div>
                    <div class="product-card__content">
                        <p class="product-card__brand">${Security.escapeHtml(product.brand?.name || '')}</p>
                        <h3 class="product-card__title">${Security.escapeHtml(product.name)}</h3>
                        ${product.color ? `<p class="product-card__color">${Security.escapeHtml(product.color)}</p>` : ''}
                        ${product.page_yield ? `<p class="product-card__yield">${Security.escapeHtml(product.page_yield)}</p>` : ''}
                        <p class="product-card__price">${formatPrice(product.retail_price)}</p>
                        <p class="product-card__stock ${stockStatus.class}">${stockStatus.text}</p>
                    </div>
                </a>
                <button class="product-card__add-btn btn btn--primary"
                        ${!product.in_stock ? 'disabled' : ''}
                        data-product-id="${Security.escapeAttr(product.id)}"
                        data-product-sku="${Security.escapeAttr(product.sku)}"
                        data-product-name="${Security.escapeAttr(product.name)}"
                        data-product-price="${Security.escapeAttr(product.retail_price)}"
                        data-product-image="${Security.escapeAttr(product.image_url || '')}"
                        data-product-color="${Security.escapeAttr(product.color || this.detectColorFromName(product.name) || '')}">
                    ${product.in_stock ? 'Add to Cart' : 'Out of Stock'}
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

            if (response.success && response.data) {
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

                // Bind add to cart buttons
                this.bindAddToCartEvents(container);
            }
        } catch (error) {
            console.error('Error loading products:', error);
            container.innerHTML = `
                <div class="products-error">
                    <p>Failed to load products. Please try again.</p>
                    <button class="btn btn--secondary" onclick="location.reload()">Retry</button>
                </div>
            `;
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

            if (response.success && response.data?.products) {
                // Filter for featured if field exists, otherwise just use first 4
                let products = response.data.products;
                const featured = products.filter(p => p.is_featured);
                products = featured.length >= 4 ? featured.slice(0, 4) : products.slice(0, 4);

                container.innerHTML = products.map(p => this.renderCard(p)).join('');
                this.bindAddToCartEvents(container);
            }
        } catch (error) {
            console.error('Error loading featured products:', error);
        }
    },

    /**
     * Load single product detail
     * @param {string} sku - Product SKU
     */
    async loadProductDetail(sku) {
        try {
            const response = await API.getProduct(sku);
            if (response.success && response.data) {
                return response.data;
            }
            return null;
        } catch (error) {
            console.error('Error loading product:', error);
            return null;
        }
    }
};

// Make Products available globally
window.Products = Products;
