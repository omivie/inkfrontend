/**
 * FAVOURITES.JS
 * =============
 * Favourites/Wishlist functionality for InkCartridges.co.nz
 *
 * - Uses localStorage for guests
 * - Uses backend API for authenticated users
 * - Syncs localStorage to server on login
 */

'use strict';

const Favourites = {
    // Storage key for localStorage
    STORAGE_KEY: 'inkcartridges_favourites',

    // Favourites data (product IDs for localStorage, full objects for API)
    items: [],

    // Track if user is authenticated
    isAuthenticated: false,

    // Loading state
    isLoading: false,

    /**
     * Initialize favourites
     */
    async init() {
        // Check authentication status
        this.isAuthenticated = typeof Auth !== 'undefined' && Auth.isAuthenticated && Auth.isAuthenticated();

        if (this.isAuthenticated) {
            // Load from server for authenticated users
            await this.loadFromServer();
        } else {
            // Load from localStorage for guests
            this.loadFromStorage();
        }

        this.updateUI();
        this.bindEvents();
    },

    /**
     * Load favourites from localStorage (for guests)
     */
    loadFromStorage() {
        try {
            const stored = localStorage.getItem(this.STORAGE_KEY);
            this.items = stored ? JSON.parse(stored) : [];
        } catch (e) {
            console.error('Failed to load favourites from storage:', e);
            this.items = [];
        }
    },

    /**
     * Save favourites to localStorage (for guests)
     */
    saveToStorage() {
        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.items));
        } catch (e) {
            console.error('Failed to save favourites to storage:', e);
        }
    },

    /**
     * Load favourites from server (for authenticated users)
     */
    async loadFromServer() {
        if (typeof API === 'undefined') {
            console.warn('API not available, falling back to localStorage');
            this.loadFromStorage();
            return;
        }

        try {
            this.isLoading = true;
            const response = await API.getFavourites();

            if (response.success && response.data) {
                // Convert server format to local format
                const favourites = Array.isArray(response.data) ? response.data : (response.data.favourites || []);
                this.items = favourites.map(fav => ({
                    id: fav.product_id,
                    sku: fav.product_sku,
                    name: fav.product?.name || '',
                    price: fav.product?.retail_price || 0,
                    image: fav.product?.image_url || '',
                    brand: fav.product?.brand?.name || '',
                    color: fav.product?.color || '',
                    in_stock: fav.product?.in_stock !== false,
                    is_active: fav.product?.is_active !== false,
                    addedAt: fav.added_at
                }));
            }
        } catch (error) {
            console.error('Failed to load favourites from server:', error);
            // Fallback to localStorage if server fails
            this.loadFromStorage();
        } finally {
            this.isLoading = false;
        }
    },

    /**
     * Sync localStorage favourites to server on login
     * Call this after successful authentication
     */
    async syncOnLogin() {
        if (typeof API === 'undefined') return;

        try {
            // Get product IDs from localStorage
            const localFavs = JSON.parse(localStorage.getItem(this.STORAGE_KEY) || '[]');
            const productIds = localFavs.map(item => item.id).filter(id => id);

            if (productIds.length === 0) {
                // No local favourites to sync, just load from server
                await this.loadFromServer();
                this.updateUI();
                return;
            }

            // Sync with server
            const response = await API.syncFavourites(productIds);

            if (response.success) {
                // Clear localStorage after successful sync
                localStorage.removeItem(this.STORAGE_KEY);
                // Reload from server to get full product data
                await this.loadFromServer();
                this.updateUI();

                if (typeof showToast === 'function' && response.data.synced > 0) {
                    showToast(`${response.data.synced} favourite(s) synced to your account`, 'success');
                }
            }
        } catch (error) {
            console.error('Failed to sync favourites:', error);
        }
    },

    /**
     * Add item to favourites
     * @param {object} product - Product data
     */
    async addItem(product) {
        // Check if already in favourites
        if (this.isFavourite(product.id)) {
            return false;
        }

        if (this.isAuthenticated && typeof API !== 'undefined') {
            // Use API for authenticated users
            try {
                const response = await API.addFavourite(product.id);
                if (response.success) {
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
                console.error('Failed to add favourite:', error);
                // Handle 409 conflict (already exists) gracefully
                if (error.message && error.message.includes('already')) {
                    if (typeof showToast === 'function') {
                        showToast('Already in favourites', 'info');
                    }
                    return false;
                }
                if (typeof showToast === 'function') {
                    showToast('Failed to add to favourites', 'error');
                }
                return false;
            }
        } else {
            // Use localStorage for guests
            this.items.push({
                id: product.id,
                sku: product.sku,
                name: product.name,
                price: product.price,
                image: product.image || '',
                brand: product.brand || '',
                color: product.color || '',
                addedAt: new Date().toISOString()
            });

            this.saveToStorage();
            this.updateUI();

            if (typeof showToast === 'function') {
                showToast('Added to favourites', 'success');
            }
            return true;
        }

        return false;
    },

    /**
     * Remove item from favourites
     * @param {string} productId - Product ID
     */
    async removeItem(productId) {
        const initialLength = this.items.length;

        if (this.isAuthenticated && typeof API !== 'undefined') {
            // Use API for authenticated users
            try {
                const response = await API.removeFavourite(productId);
                if (response.success) {
                    this.items = this.items.filter(item => item.id !== productId);
                    this.updateUI();

                    if (typeof showToast === 'function') {
                        showToast('Removed from favourites', 'info');
                    }
                    return true;
                }
            } catch (error) {
                console.error('Failed to remove favourite:', error);
                if (typeof showToast === 'function') {
                    showToast('Failed to remove from favourites', 'error');
                }
                return false;
            }
        } else {
            // Use localStorage for guests
            this.items = this.items.filter(item => item.id !== productId);

            if (this.items.length < initialLength) {
                this.saveToStorage();
                this.updateUI();

                if (typeof showToast === 'function') {
                    showToast('Removed from favourites', 'info');
                }
                return true;
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
        if (this.isAuthenticated && typeof API !== 'undefined') {
            // Remove each item via API
            const removePromises = this.items.map(item =>
                API.removeFavourite(item.id).catch(() => {})
            );
            await Promise.all(removePromises);
        }

        this.items = [];
        this.saveToStorage();
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

                // Prevent double-clicks
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
                grid.innerHTML = '<div class="loading-spinner">Loading favourites...</div>';
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
                <a href="/html/product/index.html?sku=${Security.escapeAttr(item.sku)}" class="favourite-item__link">
                    <div class="favourite-item__image">
                        ${this.getItemImageHTML(item)}
                    </div>
                    <div class="favourite-item__info">
                        <h3 class="favourite-item__name">${Security.escapeHtml(item.name)}</h3>
                        ${item.brand ? `<p class="favourite-item__brand">${Security.escapeHtml(item.brand)}</p>` : ''}
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
                return `<img src="${Security.escapeAttr(item.image)}" alt="${Security.escapeAttr(item.name)}" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                        <div class="favourite-item__color-block" style="${colorStyle} display: none;"></div>`;
            }
            return `<img src="${Security.escapeAttr(item.image)}" alt="${Security.escapeAttr(item.name)}" onerror="this.onerror=null; this.src='/assets/images/placeholder-product.svg';">`;
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
     * Refresh authentication status and reload if needed
     * Call this when auth state changes
     */
    async onAuthStateChange(isAuthenticated) {
        const wasAuthenticated = this.isAuthenticated;
        this.isAuthenticated = isAuthenticated;

        if (isAuthenticated && !wasAuthenticated) {
            // User just logged in - sync favourites
            await this.syncOnLogin();
        } else if (!isAuthenticated && wasAuthenticated) {
            // User just logged out - load from localStorage
            this.loadFromStorage();
            this.updateUI();
        }
    }
};

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    Favourites.init();
});

// Make available globally
window.Favourites = Favourites;
