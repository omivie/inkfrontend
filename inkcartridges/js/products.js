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
    getProductImageHTML(product, { priority = false } = {}) {
        const colorStyle = ProductColors.getProductStyle(product);
        const imageUrl = typeof storageUrl === 'function' ? storageUrl(product.image_url) : product.image_url;
        const srcsetVal = typeof imageSrcset === 'function' && product.image_url ? imageSrcset(product.image_url) : '';
        const srcsetHtml = srcsetVal ? ` srcset="${Security.escapeAttr(srcsetVal)}" sizes="(max-width: 480px) 200px, (max-width: 768px) 300px, 400px"` : '';
        const loadAttrs = priority ? 'fetchpriority="high" decoding="async"' : 'loading="lazy" decoding="async"';
        if (imageUrl && imageUrl !== '/assets/images/placeholder-product.svg') {
            // Has image URL - use it with error fallback (listeners attached after DOM insertion)
            if (colorStyle) {
                return `<img src="${Security.escapeAttr(imageUrl)}"
                             alt="${Security.escapeAttr(product.name)}"
                             class="product-card__image"
                             width="200" height="200"
                             ${loadAttrs}${srcsetHtml}
                             data-fallback="color-block">
                        <div class="product-card__color-block" style="${colorStyle}; display: none;"></div>`;
            } else {
                return `<img src="${Security.escapeAttr(imageUrl)}"
                             alt="${Security.escapeAttr(product.name)}"
                             class="product-card__image"
                             width="200" height="200"
                             ${loadAttrs}${srcsetHtml}
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
                         ${loadAttrs}>`;
        }
    },

    /**
     * Render a product card
     * @param {object} product - Product data from API
     * @returns {string} HTML string
     */
    renderCard(product, index) {
        const sourceBadge = getSourceBadge(product.source);
        const stockInfo = getStockStatus(product);
        const resolvedImage = typeof storageUrl === 'function' ? storageUrl(product.image_url) : (product.image_url || '');
        const priority = typeof index === 'number' && index < 4;

        // Discount fields: backend now sends original_price + discount_amount +
        // discount_percent on every discounted product. Fall back to compare_price
        // for legacy responses. Never compute the discount client-side when the
        // backend has supplied the canonical numbers.
        const originalPrice = product.original_price != null
            ? product.original_price
            : (product.compare_price && product.compare_price > product.retail_price ? product.compare_price : null);
        const discountAmount = product.discount_amount != null
            ? product.discount_amount
            : (originalPrice && product.retail_price != null ? originalPrice - product.retail_price : null);
        const discountPercent = product.discount_percent != null
            ? product.discount_percent
            : (originalPrice && product.retail_price ? Math.round(((originalPrice - product.retail_price) / originalPrice) * 100) : null);
        const showDiscount = originalPrice && originalPrice > (product.retail_price || 0);

        // GST sub-line: backend sends gst_amount; fall back to local calc.
        const gstAmount = product.gst_amount != null
            ? product.gst_amount
            : (product.retail_price != null && typeof calculateGST === 'function' ? calculateGST(product.retail_price) : null);

        // Prefer backend-supplied canonical_url (absolute). Reduce to a path so
        // router-based navigation stays in-app, falling back to slug/sku — and
        // finally /p/<sku>, which the Vercel rewrite proxies to the backend's
        // 301 handler.
        const cardHref = (() => {
            if (product.canonical_url) {
                try { return new URL(product.canonical_url).pathname; }
                catch (_) { return product.canonical_url; }
            }
            if (product.slug && product.sku) return `/products/${encodeURIComponent(product.slug)}/${encodeURIComponent(product.sku)}`;
            if (product.sku) return `/p/${encodeURIComponent(product.sku)}`;
            if (product.slug) return `/product/${encodeURIComponent(product.slug)}`;
            return '#';
        })();

        return `
            <article class="product-card" data-product-id="${Security.escapeAttr(product.id)}" data-sku="${Security.escapeAttr(product.sku)}">
                <a href="${Security.escapeAttr(cardHref)}" class="product-card__link">
                    <div class="product-card__image-wrapper">
                        ${this.getProductImageHTML(product, { priority })}
                        ${sourceBadge ? `<span class="product-card__badge ${sourceBadge.class}">${sourceBadge.text}</span>` : ''}
                        ${showDiscount && discountPercent ? `<span class="product-card__badge product-card__badge--discount">Save ${discountPercent}%</span>` : ''}
                        ${product.is_lowest_in_market ? `<span class="product-card__badge product-card__badge--lowest-price" title="${product.market_position ? Security.escapeAttr(product.market_position.price_diff_percent + '% less than ' + product.market_position.lowest_competitor_name) : ''}">Lowest Price in NZ</span>` : ''}
                        ${product.retail_price != null && product.retail_price >= 100 ? '<span class="product-card__free-shipping">Free Shipping</span>' : ''}
                    </div>
                    <div class="product-card__content">
                        <p class="product-card__brand">${Security.escapeHtml(product.brand?.name || '')}</p>
                        <h3 class="product-card__title" title="${Security.escapeAttr(product.name)}">${Security.escapeHtml(product.name)}</h3>
                        ${product.average_rating && product.review_count > 0 ? `<div class="product-card__rating">${this._miniStars(Math.round(parseFloat(product.average_rating)))} <span class="product-card__review-count">(${product.review_count})</span></div>` : ''}
                        <div class="product-card__footer">
                            <div class="product-card__footer-row">
                                ${product.color ? `<p class="product-card__color">${Security.escapeHtml(product.color)}</p>` : '<span></span>'}
                                <p class="product-card__stock stock-${stockInfo.class}">${Security.escapeHtml(stockInfo.text)}</p>
                            </div>
                            <div class="product-card__footer-row">
                                <div class="product-card__price-block">
                                    <p class="product-card__price">${product.retail_price == null ? 'Price unavailable' : formatPrice(product.retail_price)}</p>
                                    ${showDiscount ? `<span class="product-card__compare-price">${formatPrice(originalPrice)}</span>` : ''}
                                    ${gstAmount != null ? `<p class="product-card__gst">Inc. GST ${formatPrice(gstAmount)}</p>` : ''}
                                </div>
                                ${(() => {
                                    // Spec §5.8: when product.in_stock === false (or
                                    // waitlist_available === true) swap "Add to Cart"
                                    // for "Notify me". The button click bubbles up to
                                    // the wrapping <a>, sending the user to the PDP
                                    // where they can submit an email.
                                    const oos = product.in_stock === false
                                        || product.stock_status === 'out_of_stock'
                                        || (product.in_stock === undefined && product.stock_quantity === 0);
                                    const waitlistOk = (product.waitlist_available === true)
                                        || (oos && product.waitlist_available !== false);
                                    if (waitlistOk) {
                                        return `<button class="product-card__add-btn btn btn--secondary product-card__notify-btn"
                                                data-action="notify"
                                                data-product-sku="${Security.escapeAttr(product.sku)}">
                                            Notify me
                                        </button>`;
                                    }
                                    const disabled = product.retail_price == null || stockInfo.class !== 'in-stock';
                                    return `<button class="product-card__add-btn btn btn--primary"
                                        ${disabled ? 'disabled' : ''}
                                        data-product-id="${Security.escapeAttr(product.id)}"
                                        data-product-sku="${Security.escapeAttr(product.sku)}"
                                        data-product-name="${Security.escapeAttr(product.name)}"
                                        data-product-price="${Security.escapeAttr(product.retail_price)}"
                                        data-product-image="${Security.escapeAttr(resolvedImage)}"
                                        data-product-color="${Security.escapeAttr(product.color || this.detectColorFromName(product.name) || '')}">
                                    ${stockInfo.class === 'contact-us' ? 'Contact Us' : 'Add to Cart'}
                                    </button>`;
                                })()}
                            </div>
                        </div>
                    </div>
                </a>
            </article>
        `;
    },

    /**
     * Render mini star icons for product cards
     */
    _miniStars(filled) {
        return Array.from({ length: 5 }, (_, i) =>
            `<svg class="product-card__star" width="14" height="14" viewBox="0 0 24 24" fill="${i < filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`
        ).join('');
    },

    /**
     * Attach Add to Cart listeners on a container of product cards.
     * Buttons with `data-action="notify"` (out-of-stock waitlist CTA) are
     * skipped — the click bubbles up to the wrapping <a> so the user lands
     * on the PDP, where the waitlist email-capture form lives.
     */
    attachCardListeners(container) {
        if (!container) return;
        container.querySelectorAll('.product-card__add-btn').forEach(btn => {
            if (btn.dataset.action === 'notify') return;
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (typeof Cart !== 'undefined' && Cart.add) {
                    Cart.add(btn.dataset.productId, 1);
                }
            });
        });
    },

    /**
     * Render multiple product cards
     * @param {array} products - Array of products
     * @returns {string} HTML string
     */
    _preloadLCPImage(product) {
        if (!product || !product.image_url) return;
        if (document.querySelector('link[rel="preload"][data-lcp-product]')) return;
        const url = typeof storageUrl === 'function' ? storageUrl(product.image_url) : product.image_url;
        if (!url) return;
        const link = document.createElement('link');
        link.rel = 'preload';
        link.as = 'image';
        link.href = url;
        link.setAttribute('fetchpriority', 'high');
        link.setAttribute('data-lcp-product', '1');
        const srcsetVal = typeof imageSrcset === 'function' ? imageSrcset(product.image_url) : '';
        if (srcsetVal) {
            link.setAttribute('imagesrcset', srcsetVal);
            link.setAttribute('imagesizes', '(max-width: 480px) 200px, (max-width: 768px) 300px, 400px');
        }
        document.head.appendChild(link);
    },

    renderCards(products) {
        if (products && products.length > 0) {
            this._preloadLCPImage(products[0]);
        }
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

        return products.map((p, i) => this.renderCard(p, i)).join('');
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
                // Try raw (non-optimized) image URL before falling back to color block/placeholder
                const rawSrc = this.dataset.rawSrc;
                if (rawSrc && this.src !== rawSrc) {
                    this.removeAttribute('srcset');
                    this.src = rawSrc;
                    return; // let it try loading the raw URL
                }
                if (this.dataset.fallback === 'color-block') {
                    this.style.display = 'none';
                    const sibling = this.nextElementSibling;
                    if (sibling) sibling.style.display = 'flex';
                } else if (this.dataset.fallback === 'placeholder') {
                    this.removeAttribute('data-fallback');
                    this.src = '/assets/images/placeholder-product.svg';
                }
            });
        });
    },

    /**
     * Bind add to cart button events. Skips notify-mode buttons so the click
     * bubbles up to the card link and the user lands on the PDP waitlist UI.
     */
    bindAddToCartEvents(container) {
        container.querySelectorAll('.product-card__add-btn').forEach(btn => {
            if (btn.dataset.action === 'notify') return;
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
