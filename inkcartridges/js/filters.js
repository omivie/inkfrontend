/**
 * FILTERS.JS
 * ==========
 * Product filtering functionality for InkCartridges.co.nz
 *
 * This file handles:
 * - Category/Shop page filters
 * - Filter state management
 * - URL synchronization
 * - Filter UI updates
 *
 * NOTE: This file is designed for a traditional sidebar filter layout
 * (pages with .shop-layout class). The main shop.html currently uses
 * DrilldownNav (inline in shop.html) for brand→category→code navigation.
 * This filters.js will activate on future pages that use the traditional
 * sidebar filter layout.
 */

'use strict';

/**
 * FILTERS STATE
 * =============
 */

const Filters = {
    // Current filter state
    state: {
        category: [],
        brand: [],
        type: [],
        colour: [],
        priceMin: null,
        priceMax: null,
        inStock: false,
        sort: 'relevance',
        page: 1
    },

    /**
     * Initialize filters
     */
    init: function() {
        // Load filters from URL
        this.loadFromURL();

        // Bind events
        this.bindEvents();

        // Update UI to match state
        this.updateUI();
    },

    /**
     * Bind filter-related events
     */
    bindEvents: function() {
        // Checkbox filters
        on('.filter-list--checkboxes input[type="checkbox"]', 'change', (e) => {
            const filterName = e.target.name;
            const filterValue = e.target.value;

            if (e.target.checked) {
                this.addFilter(filterName, filterValue);
            } else {
                this.removeFilter(filterName, filterValue);
            }
        });

        // Price filter
        const priceApplyBtn = $('.price-filter .btn');
        if (priceApplyBtn) {
            priceApplyBtn.addEventListener('click', () => {
                const minInput = $('input[name="min-price"]');
                const maxInput = $('input[name="max-price"]');

                this.state.priceMin = minInput?.value ? parseFloat(minInput.value) : null;
                this.state.priceMax = maxInput?.value ? parseFloat(maxInput.value) : null;

                this.applyFilters();
            });
        }

        // Sort dropdown
        on('.shop-toolbar__sort select', 'change', (e) => {
            this.state.sort = e.target.value;
            this.state.page = 1; // Reset to first page on sort change
            this.applyFilters();
        });

        // Clear all filters
        on('.btn--full-width', 'click', (e) => {
            if (e.target.textContent.includes('Clear')) {
                this.clearAll();
            }
        });

        // View toggle
        on('.view-toggle', 'click', (e) => {
            const toggles = $$('.view-toggle');
            toggles.forEach(t => {
                t.classList.remove('active');
                t.setAttribute('aria-pressed', 'false');
            });
            e.target.classList.add('active');
            e.target.setAttribute('aria-pressed', 'true');

            const grid = $('.product-grid');
            if (grid) {
                if (e.target.classList.contains('view-toggle--list')) {
                    grid.classList.add('product-grid--list');
                } else {
                    grid.classList.remove('product-grid--list');
                }
            }
        });
    },

    /**
     * Add a filter value
     * @param {string} filterName - Filter category name
     * @param {string} value - Filter value to add
     */
    addFilter: function(filterName, value) {
        if (Array.isArray(this.state[filterName])) {
            if (!this.state[filterName].includes(value)) {
                this.state[filterName].push(value);
            }
        }
        this.state.page = 1; // Reset to first page on filter change
        this.applyFilters();
    },

    /**
     * Remove a filter value
     * @param {string} filterName - Filter category name
     * @param {string} value - Filter value to remove
     */
    removeFilter: function(filterName, value) {
        if (Array.isArray(this.state[filterName])) {
            this.state[filterName] = this.state[filterName].filter(v => v !== value);
        }
        this.state.page = 1;
        this.applyFilters();
    },

    /**
     * Clear all filters
     */
    clearAll: function() {
        this.state = {
            category: [],
            brand: [],
            type: [],
            colour: [],
            priceMin: null,
            priceMax: null,
            inStock: false,
            sort: 'relevance',
            page: 1
        };
        this.applyFilters();
    },

    /**
     * Apply current filters and fetch products from API
     */
    async applyFilters() {
        // Update URL
        this.updateURL();

        // Update UI
        this.updateUI();

        // Build API filter params
        const apiFilters = {
            page: this.state.page,
            limit: 20
        };

        // Map category filter to API category param
        if (this.state.category.length > 0) {
            // API expects single category, use first one
            apiFilters.category = this.state.category[0];
        }

        // Map brand filter (API expects single brand slug)
        if (this.state.brand.length > 0) {
            apiFilters.brand = this.state.brand[0].toLowerCase();
        }

        // Map type filter to source (genuine/compatible)
        if (this.state.type.length > 0) {
            const type = this.state.type[0].toLowerCase();
            if (type === 'genuine' || type === 'compatible') {
                apiFilters.source = type;
            }
        }

        // Map colour to color
        if (this.state.colour.length > 0) {
            apiFilters.color = this.state.colour[0];
        }

        // Map sort
        const sortMap = {
            'relevance': 'name_asc',
            'price-low': 'price_asc',
            'price-high': 'price_desc',
            'name-asc': 'name_asc',
            'name-desc': 'name_desc'
        };
        apiFilters.sort = sortMap[this.state.sort] || 'name_asc';

        // Fetch from API
        const productGrid = document.querySelector('.product-grid');
        if (productGrid) {
            productGrid.classList.add('is-loading');
            productGrid.innerHTML = `
                <div class="products-loading">
                    <div class="spinner"></div>
                    <p>Loading products...</p>
                </div>
            `;
        }

        try {
            if (typeof API !== 'undefined' && typeof Products !== 'undefined') {
                const response = await API.getProducts(apiFilters);

                if (response.success && response.data) {
                    const { products, pagination } = response.data;

                    // Render products
                    if (productGrid) {
                        productGrid.classList.remove('is-loading');
                        productGrid.innerHTML = Products.renderCards(products);
                        Products.bindAddToCartEvents(productGrid);
                    }

                    // Update pagination
                    const paginationContainer = document.querySelector('.pagination');
                    if (paginationContainer && pagination) {
                        paginationContainer.innerHTML = Products.renderPagination(pagination);
                        this.bindPaginationEvents(paginationContainer);
                    }

                    // Update results count
                    const resultsCount = document.querySelector('.shop-toolbar__results');
                    if (resultsCount && pagination) {
                        const start = (pagination.page - 1) * pagination.limit + 1;
                        const end = Math.min(pagination.page * pagination.limit, pagination.total);
                        resultsCount.textContent = `Showing ${start}-${end} of ${pagination.total} products`;
                    }
                }
            }
        } catch (error) {
            console.error('Error fetching products:', error);
            if (productGrid) {
                productGrid.classList.remove('is-loading');
                productGrid.innerHTML = `
                    <div class="products-error">
                        <p>Failed to load products. Please try again.</p>
                        <button class="btn btn--secondary" onclick="Filters.applyFilters()">Retry</button>
                    </div>
                `;
            }
        }
    },

    /**
     * Bind pagination click events
     */
    bindPaginationEvents(container) {
        container.querySelectorAll('.pagination__btn[data-page]').forEach(btn => {
            btn.addEventListener('click', () => {
                const page = parseInt(btn.dataset.page);
                if (!isNaN(page)) {
                    this.state.page = page;
                    this.applyFilters();
                    // Scroll to top of products
                    document.querySelector('.product-grid')?.scrollIntoView({ behavior: 'smooth' });
                }
            });
        });
    },

    /**
     * Update URL to reflect filter state
     */
    updateURL: function() {
        const params = new URLSearchParams();

        // Add array filters
        ['category', 'brand', 'type', 'colour'].forEach(key => {
            if (this.state[key].length > 0) {
                params.set(key, this.state[key].join(','));
            }
        });

        // Add price filters
        if (this.state.priceMin) params.set('min', this.state.priceMin);
        if (this.state.priceMax) params.set('max', this.state.priceMax);

        // Add other filters
        if (this.state.inStock) params.set('instock', '1');
        if (this.state.sort !== 'relevance') params.set('sort', this.state.sort);
        if (this.state.page > 1) params.set('page', this.state.page);

        // Update URL without reload
        const newURL = params.toString()
            ? `${window.location.pathname}?${params.toString()}`
            : window.location.pathname;

        history.pushState(this.state, '', newURL);
    },

    /**
     * Load filter state from URL
     */
    loadFromURL: function() {
        const params = new URLSearchParams(window.location.search);

        // Load array filters
        ['category', 'brand', 'type', 'colour'].forEach(key => {
            const value = params.get(key);
            if (value) {
                this.state[key] = value.split(',');
            }
        });

        // Load price filters
        const min = params.get('min');
        const max = params.get('max');
        if (min) this.state.priceMin = parseFloat(min);
        if (max) this.state.priceMax = parseFloat(max);

        // Load other filters
        if (params.get('instock')) this.state.inStock = true;
        if (params.get('sort')) this.state.sort = params.get('sort');
        if (params.get('page')) this.state.page = parseInt(params.get('page'));
    },

    /**
     * Update UI to reflect current state
     */
    updateUI: function() {
        // Update checkboxes
        $$('.filter-list--checkboxes input[type="checkbox"]').forEach(checkbox => {
            const filterName = checkbox.name;
            const filterValue = checkbox.value;

            if (Array.isArray(this.state[filterName])) {
                checkbox.checked = this.state[filterName].includes(filterValue);
            }
        });

        // Update price inputs
        const minInput = $('input[name="min-price"]');
        const maxInput = $('input[name="max-price"]');
        if (minInput && this.state.priceMin) minInput.value = this.state.priceMin;
        if (maxInput && this.state.priceMax) maxInput.value = this.state.priceMax;

        // Update sort dropdown
        const sortSelect = $('.shop-toolbar__sort select');
        if (sortSelect) sortSelect.value = this.state.sort;

        // Update active filters display
        this.renderActiveFilters();
    },

    /**
     * Render active filters chips
     */
    renderActiveFilters: function() {
        const container = $('.active-filters');
        if (!container) return;

        const chips = [];

        // Collect active array filters
        const filterLabels = {
            category: 'Category',
            brand: 'Brand',
            type: 'Type',
            colour: 'Colour'
        };

        ['category', 'brand', 'type', 'colour'].forEach(key => {
            this.state[key].forEach(value => {
                chips.push({
                    filterName: key,
                    label: filterLabels[key],
                    value: value
                });
            });
        });

        // Price range
        if (this.state.priceMin || this.state.priceMax) {
            const priceLabel = this.state.priceMin && this.state.priceMax
                ? `$${this.state.priceMin} - $${this.state.priceMax}`
                : this.state.priceMin
                    ? `From $${this.state.priceMin}`
                    : `Up to $${this.state.priceMax}`;
            chips.push({ filterName: 'price', label: 'Price', value: priceLabel });
        }

        // In stock only
        if (this.state.inStock) {
            chips.push({ filterName: 'inStock', label: 'Stock', value: 'In Stock Only' });
        }

        // Render or clear
        if (chips.length === 0) {
            container.innerHTML = '';
            return;
        }

        const chipHTML = chips.map(chip => `
            <button class="active-filters__chip"
                    data-filter="${Security.escapeAttr(chip.filterName)}"
                    data-value="${Security.escapeAttr(chip.value)}">
                ${Security.escapeHtml(chip.label)}: ${Security.escapeHtml(chip.value)}
                <svg viewBox="0 0 24 24" fill="none"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        `).join('');

        container.innerHTML = `
            <span class="active-filters__label">Active filters:</span>
            <div class="active-filters__list">${chipHTML}</div>
            <button class="active-filters__clear">Clear All</button>
        `;

        // Bind chip removal
        container.querySelectorAll('.active-filters__chip').forEach(chip => {
            chip.addEventListener('click', () => {
                const filterName = chip.dataset.filter;
                const value = chip.dataset.value;

                if (filterName === 'price') {
                    this.state.priceMin = null;
                    this.state.priceMax = null;
                    const minInput = $('input[name="min-price"]');
                    const maxInput = $('input[name="max-price"]');
                    if (minInput) minInput.value = '';
                    if (maxInput) maxInput.value = '';
                } else if (filterName === 'inStock') {
                    this.state.inStock = false;
                } else {
                    this.removeFilter(filterName, value);
                    return; // removeFilter already calls applyFilters
                }
                this.applyFilters();
            });
        });

        // Bind clear all
        const clearBtn = container.querySelector('.active-filters__clear');
        if (clearBtn) {
            clearBtn.addEventListener('click', () => this.clearAll());
        }
    }
};

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', function() {
    // Only initialize on shop/category pages
    if ($('.shop-layout')) {
        Filters.init();
    }
});

// Handle browser back/forward
window.addEventListener('popstate', function(e) {
    if (e.state) {
        Filters.state = e.state;
        Filters.updateUI();
        // Refetch products with restored filter state
        Filters.applyFilters();
    } else {
        // No state - reload from URL
        Filters.loadFromURL();
        Filters.updateUI();
        Filters.applyFilters();
    }
});
