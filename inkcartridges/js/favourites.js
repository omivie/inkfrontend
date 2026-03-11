/**
 * FAVOURITES.JS
 * =============
 * Favourites/Wishlist functionality for InkCartridges.co.nz
 *
 * Backend-only: requires authentication for all operations.
 * Unauthenticated users are prompted to sign in.
 */

'use strict';

const Favourites = {
    // Favourites data (full objects from API)
    items: [],

    // Loading state
    isLoading: false,

    /**
     * Initialize favourites
     */
    async init() {
        // Wait for Auth to finish initializing (async getSession)
        await this._waitForAuth();

        if (this._isAuthenticated()) {
            await this.loadFromServer();
        }

        this.updateUI();
        this.bindEvents();
    },

    /**
     * Wait for Auth to be initialized (polls until Auth.initialized is true)
     */
    _waitForAuth() {
        return new Promise(resolve => {
            if (typeof Auth !== 'undefined' && Auth.initialized) {
                resolve();
                return;
            }
            // Poll every 50ms, timeout after 3s
            let elapsed = 0;
            const interval = setInterval(() => {
                elapsed += 50;
                if ((typeof Auth !== 'undefined' && Auth.initialized) || elapsed >= 3000) {
                    clearInterval(interval);
                    resolve();
                }
            }, 50);
        });
    },

    /**
     * Check if user is currently authenticated
     */
    _isAuthenticated() {
        return typeof Auth !== 'undefined' && Auth.isAuthenticated && Auth.isAuthenticated();
    },

    /**
     * Redirect to login if not authenticated.
     * Returns true if authenticated, false if redirecting.
     */
    _requireAuth() {
        if (this._isAuthenticated()) return true;

        if (typeof showToast === 'function') {
            showToast('Please sign in to use favourites', 'info');
        }
        return false;
    },

    /**
     * Load favourites from server
     */
    async loadFromServer() {
        if (typeof API === 'undefined') {
            DebugLog.warn('API not available');
            return;
        }

        try {
            this.isLoading = true;
            const response = await API.getFavourites();

            if (response.ok && response.data) {
                const favourites = Array.isArray(response.data) ? response.data : (response.data.favourites || []);
                this.items = favourites.map(fav => ({
                    id: fav.product_id,
                    sku: fav.product_sku,
                    name: fav.product?.name || '',
                    price: fav.product?.retail_price || 0,
                    image: typeof storageUrl === 'function' ? storageUrl(fav.product?.image_url) : (fav.product?.image_url || ''),
                    brand: fav.product?.brand?.name || '',
                    color: fav.product?.color || '',
                    in_stock: fav.product?.in_stock !== false,
                    is_active: fav.product?.is_active !== false,
                    addedAt: fav.added_at
                }));
            }
        } catch (error) {
            DebugLog.error('Failed to load favourites from server:', error);
            this.items = [];
        } finally {
            this.isLoading = false;
        }
    },

    /**
     * Add item to favourites (backend only)
     * @param {object} product - Product data
     */
    async addItem(product) {
        if (!this._requireAuth()) return false;
        if (this.isFavourite(product.id)) return false;

        try {
            const response = await API.addFavourite(product.id);
            if (response.ok) {
                this.items.push({
                    id: product.id,
                    sku: product.sku,
                    name: product.name,
                    price: product.price,
                    image: product.image || '',
                    brand: product.brand || '',
                    color: product.color || '',
                    addedAt: response.data.added_at || new Date().toISOString()
                });
                this.updateUI();

                if (typeof showToast === 'function') {
                    showToast('Added to favourites', 'success');
                }
                return true;
            }
        } catch (error) {
            DebugLog.error('Failed to add favourite:', error);
            if (error.message && error.message.includes('already')) {
                if (typeof showToast === 'function') {
                    showToast('Already in favourites', 'info');
                }
                return false;
            }
            if (typeof showToast === 'function') {
                showToast('Failed to add to favourites', 'error');
            }
        }

        return false;
    },

    /**
     * Remove item from favourites (backend only)
     * @param {string} productId - Product ID
     */
    async removeItem(productId) {
        if (!this._requireAuth()) return false;

        try {
            const response = await API.removeFavourite(productId);
            if (response.ok) {
                this.items = this.items.filter(item => item.id !== productId);
                this.updateUI();

                if (typeof showToast === 'function') {
                    showToast('Removed from favourites', 'info');
                }
                return true;
            }
        } catch (error) {
            DebugLog.error('Failed to remove favourite:', error);
            if (typeof showToast === 'function') {
                showToast('Failed to remove from favourites', 'error');
            }
        }

        return false;
    },

    /**
     * Toggle favourite status
     * @param {object} product - Product data
     * @returns {Promise<boolean>} - New favourite state (true if added, false if removed)
     */
    async toggle(product) {
        if (!this._requireAuth()) return false;

        if (this.isFavourite(product.id)) {
            await this.removeItem(product.id);
            return false;
        } else {
            await this.addItem(product);
            return true;
        }
    },

    /**
     * Check if product is in favourites
     * @param {string} productId - Product ID
     * @returns {boolean}
     */
    isFavourite(productId) {
        return this.items.some(item => item.id === productId);
    },

    /**
     * Get total count
     * @returns {number}
     */
    getCount() {
        return this.items.length;
    },

    /**
     * Clear all favourites
     */
    async clear() {
        if (!this._requireAuth()) return;

        const removePromises = this.items.map(item =>
            API.removeFavourite(item.id).catch(() => {})
        );
        await Promise.all(removePromises);

        this.items = [];
        this.updateUI();
    },

    /**
     * Bind events for favourite buttons
     */
    bindEvents() {
        const self = this;

        document.addEventListener('click', async (e) => {
            const btn = e.target.closest('.favourite-btn');
            if (btn) {
                e.preventDefault();
                e.stopPropagation();

                if (!self._isAuthenticated()) {
                    if (typeof Auth !== 'undefined' && Auth.requireAuth) {
                        Auth.requireAuth();
                    } else if (typeof showToast === 'function') {
                        showToast('Please sign in to use favourites', 'info');
                    }
                    return;
                }

                if (btn.classList.contains('is-loading')) return;

                const product = {
                    id: btn.dataset.productId,
                    sku: btn.dataset.productSku || '',
                    name: btn.dataset.productName || '',
                    price: parseFloat(btn.dataset.productPrice) || 0,
                    image: btn.dataset.productImage || '',
                    brand: btn.dataset.productBrand || '',
                    color: btn.dataset.productColor || ''
                };

                if (product.id) {
                    btn.classList.add('is-loading');
                    const isNowFavourite = await self.toggle(product);
                    self.updateButtonState(btn, isNowFavourite);
                    btn.classList.remove('is-loading');
                }
            }

            // Remove from favourites page
            const removeBtn = e.target.closest('.favourite-item__remove');
            if (removeBtn) {
                const itemId = removeBtn.dataset.itemId;
                if (itemId) {
                    removeBtn.disabled = true;
                    await self.removeItem(itemId);
                    self.renderFavouritesPage();
                }
            }
        });
    },

    /**
     * Update button visual state
     * @param {HTMLElement} btn - The button element
     * @param {boolean} isFavourite - Whether item is favourited
     */
    updateButtonState(btn, isFavourite) {
        if (isFavourite) {
            btn.classList.add('favourite-btn--active');
            btn.setAttribute('aria-pressed', 'true');
            btn.setAttribute('title', 'Remove from favourites');
        } else {
            btn.classList.remove('favourite-btn--active');
            btn.setAttribute('aria-pressed', 'false');
            btn.setAttribute('title', 'Add to favourites');
        }
    },

    /**
     * Update all UI elements
     */
    updateUI() {
        // Update any favourite buttons on the page
        document.querySelectorAll('.favourite-btn').forEach(btn => {
            const productId = btn.dataset.productId;
            if (productId) {
                this.updateButtonState(btn, this.isFavourite(productId));
            }
        });

        // If on favourites page, render it
        if (document.querySelector('.favourites-page')) {
            this.renderFavouritesPage();
        }
    },

    /**
     * Render favourites page content
     */
    renderFavouritesPage() {
        const grid = document.getElementById('favourites-grid');
        const emptyState = document.getElementById('favourites-empty') || document.querySelector('.account-empty');
        const contentContainer = document.querySelector('.favourites-page') || document.querySelector('.account-content');

        if (!contentContainer) return;

        // Show loading state
        if (this.isLoading) {
            if (grid) {
                grid.innerHTML = '<div style="text-align:center; padding: 3rem 1rem;"><div class="loading-spinner"></div><p style="color: var(--color-text-muted); margin-top: 1rem; font-size: 0.875rem;">Loading favourites...</p></div>';
                grid.style.display = '';
            }
            if (emptyState) emptyState.hidden = true;
            return;
        }

        if (this.items.length === 0) {
            // Show empty state, hide grid
            if (grid) grid.style.display = 'none';
            if (emptyState) emptyState.hidden = false;
            return;
        }

        // Hide empty state, show grid
        if (emptyState) emptyState.hidden = true;
        if (!grid) return;
        grid.style.display = '';

        // Render items
        grid.innerHTML = this.items.map(item => `
            <article class="favourite-item" data-item-id="${Security.escapeAttr(item.id)}">
                <a href="/html/product/?sku=${Security.escapeAttr(item.sku)}" class="favourite-item__link">
                    <div class="favourite-item__image">
                        ${this.getItemImageHTML(item)}
                    </div>
                    <div class="favourite-item__info">
                        <span class="source-badge source-badge--${(item.name || '').toLowerCase().startsWith('compatible ') ? 'compatible' : 'genuine'}">${(item.name || '').toLowerCase().startsWith('compatible ') ? 'COMPATIBLE' : 'GENUINE'}</span>
                        <h3 class="favourite-item__name">${Security.escapeHtml(item.name)}</h3>
                        ${item.brand ? `<p class="favourite-item__brand">${Security.escapeHtml(item.brand)}</p>` : ''}
                        ${(item.color || (typeof ProductColors !== 'undefined' ? ProductColors.detectFromName(item.name) : '')) ? `<p class="favourite-item__color">${Security.escapeHtml(item.color || ProductColors.detectFromName(item.name))}</p>` : ''}
                        <p class="favourite-item__price">${typeof formatPrice === 'function' ? formatPrice(item.price) : '$' + item.price.toFixed(2)}</p>
                        ${item.in_stock === false ? '<p class="favourite-item__stock favourite-item__stock--out">Out of Stock</p>' : ''}
                    </div>
                </a>
                <div class="favourite-item__actions">
                    <button type="button" class="btn btn--primary btn--sm favourite-item__add-cart"
                            data-product-id="${Security.escapeAttr(item.id)}"
                            data-product-sku="${Security.escapeAttr(item.sku)}"
                            data-product-name="${Security.escapeAttr(item.name)}"
                            data-product-price="${Security.escapeAttr(item.price)}"
                            data-product-image="${Security.escapeAttr(item.image)}"
                            data-product-brand="${Security.escapeAttr(item.brand)}"
                            ${item.in_stock === false ? 'disabled' : ''}>
                        ${item.in_stock === false ? 'Out of Stock' : 'Add to Cart'}
                    </button>
                    <button type="button" class="favourite-item__remove" data-item-id="${Security.escapeAttr(item.id)}" aria-label="Remove from favourites">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                    </button>
                </div>
            </article>
        `).join('');

        // Bind image error fallbacks
        grid.querySelectorAll('img[data-fallback]').forEach(img => {
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

        // Bind add to cart buttons
        grid.querySelectorAll('.favourite-item__add-cart').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();

                if (btn.disabled) return;

                if (typeof Cart !== 'undefined') {
                    const product = {
                        id: btn.dataset.productId,
                        sku: btn.dataset.productSku,
                        name: btn.dataset.productName,
                        price: parseFloat(btn.dataset.productPrice),
                        image: btn.dataset.productImage,
                        brand: btn.dataset.productBrand
                    };

                    await Cart.addItem(product);

                    btn.textContent = 'Added!';
                    btn.classList.add('btn--success');
                    setTimeout(() => {
                        btn.textContent = 'Add to Cart';
                        btn.classList.remove('btn--success');
                    }, 1500);
                }
            });
        });
    },

    /**
     * Get image HTML for a favourite item (with color fallback)
     */
    getItemImageHTML(item) {
        const color = item.color || (typeof ProductColors !== 'undefined' ? ProductColors.detectFromName(item.name) : null);
        const colorStyle = color && typeof ProductColors !== 'undefined' ? ProductColors.getStyle(color) : null;

        if (item.image) {
            if (colorStyle) {
                return `<img src="${Security.escapeAttr(item.image)}" alt="${Security.escapeAttr(item.name)}" data-fallback="color-block">
                        <div class="favourite-item__color-block" style="${colorStyle} display: none;"></div>`;
            }
            return `<img src="${Security.escapeAttr(item.image)}" alt="${Security.escapeAttr(item.name)}" data-fallback="placeholder">`;
        }

        if (colorStyle) {
            return `<div class="favourite-item__color-block" style="${colorStyle}"></div>`;
        }

        return `<img src="/assets/images/placeholder-product.svg" alt="${Security.escapeAttr(item.name)}">`;
    },

    /**
     * Create a favourite button HTML
     * @param {object} product - Product data
     * @returns {string} HTML string
     */
    createButton(product) {
        const isFav = this.isFavourite(product.id);
        return `
            <button type="button"
                    class="favourite-btn ${isFav ? 'favourite-btn--active' : ''}"
                    data-product-id="${Security.escapeAttr(product.id)}"
                    data-product-sku="${Security.escapeAttr(product.sku || '')}"
                    data-product-name="${Security.escapeAttr(product.name || '')}"
                    data-product-price="${Security.escapeAttr(product.price || 0)}"
                    data-product-image="${Security.escapeAttr(product.image || '')}"
                    data-product-brand="${Security.escapeAttr(product.brand || '')}"
                    data-product-color="${Security.escapeAttr(product.color || '')}"
                    aria-pressed="${isFav}"
                    title="${isFav ? 'Remove from favourites' : 'Add to favourites'}">
                <svg class="favourite-btn__icon favourite-btn__icon--outline" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
                </svg>
                <svg class="favourite-btn__icon favourite-btn__icon--filled" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2">
                    <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
                </svg>
                <span class="visually-hidden">Add to favourites</span>
            </button>
        `;
    },

    /**
     * Handle auth state changes - reload from server on login, clear on logout
     */
    async onAuthStateChange(isAuthenticated) {
        if (isAuthenticated) {
            // Sync any guest favourites to server before loading
            const localIds = this.items.map(i => i.product_id || i.id).filter(Boolean);
            if (localIds.length > 0 && typeof API !== 'undefined') {
                await API.syncFavourites(localIds).catch(() => {});
            }
            await this.loadFromServer();
        } else {
            this.items = [];
        }
        this.updateUI();
    }
};

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    Favourites.init();
});

// Make available globally
window.Favourites = Favourites;
