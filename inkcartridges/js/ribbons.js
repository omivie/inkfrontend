/**
 * RIBBONS PAGE JS
 * Fetches ribbon products from backend API and renders them dynamically.
 * Supports brand, type, device brand/model, and sort filters with pagination.
 */

(function() {
    'use strict';

    // DOM elements
    const brandFilter = document.getElementById('brand-filter');
    const typeFilter = document.getElementById('type-filter');
    const deviceBrandFilter = document.getElementById('device-brand-filter');
    const deviceModelFilter = document.getElementById('device-model-filter');
    const sortFilter = document.getElementById('sort-filter');
    const productCount = document.getElementById('product-count');
    const productsGrid = document.getElementById('ribbons-grid');
    const loadingEl = document.getElementById('ribbons-loading');
    const emptyEl = document.getElementById('ribbons-empty');
    const paginationEl = document.getElementById('ribbons-pagination');
    const categoryCards = document.querySelectorAll('.ribbon-category-card');

    // State
    let currentFilters = {
        brand: '',
        type: '',
        device_brand: '',
        device_model: '',
        sort: 'name-asc',
        page: 1,
        limit: 48
    };
    let isLoading = false;

    // Initialize
    async function init() {
        if (!productsGrid) return;

        loadFiltersFromURL();

        // Attach filter change handlers
        if (brandFilter) brandFilter.addEventListener('change', handleFilterChange);
        if (typeFilter) typeFilter.addEventListener('change', handleFilterChange);
        if (deviceBrandFilter) deviceBrandFilter.addEventListener('change', handleDeviceBrandChange);
        if (deviceModelFilter) deviceModelFilter.addEventListener('change', handleFilterChange);
        if (sortFilter) sortFilter.addEventListener('change', handleFilterChange);

        // Category card clicks apply type filter
        categoryCards.forEach(card => {
            card.addEventListener('click', (e) => {
                e.preventDefault();
                const category = card.dataset.category;
                if (category && typeFilter) {
                    typeFilter.value = category;
                    currentFilters.type = category;
                    currentFilters.page = 1;
                    updateURL();
                    fetchRibbons();

                    // Scroll to grid
                    productsGrid.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            });
        });

        // Populate filter dropdowns from API then fetch products
        await Promise.all([
            populateBrandFilter(),
            populateDeviceBrandFilter()
        ]);
        await fetchRibbons();
    }

    // --- Filter dropdown population ---

    async function populateBrandFilter() {
        if (!brandFilter) return;
        try {
            const response = await API.getRibbonBrands();
            if (response.ok && response.data) {
                const brands = response.data.brands || response.data || [];
                // Keep "All Brands" as first option
                const currentVal = brandFilter.value;
                brandFilter.innerHTML = '<option value="">All Brands</option>';
                for (const b of brands) {
                    const value = typeof b === 'string' ? b : b.value || b.name || b;
                    const label = typeof b === 'string' ? b : b.label || b.name || b;
                    const opt = document.createElement('option');
                    opt.value = value;
                    opt.textContent = label;
                    brandFilter.appendChild(opt);
                }
                if (currentVal) brandFilter.value = currentVal;
            }
        } catch (e) {
            // Keep hardcoded options as fallback
        }
    }

    async function populateDeviceBrandFilter() {
        if (!deviceBrandFilter) return;
        try {
            const response = await API.getRibbonDeviceBrands();
            if (response.ok && response.data) {
                const brands = response.data.device_brands || response.data || [];
                deviceBrandFilter.innerHTML = '<option value="">All Device Brands</option>';
                for (const b of brands) {
                    const value = typeof b === 'string' ? b : b.value || b;
                    const label = typeof b === 'string' ? b : b.label || b;
                    const count = typeof b === 'object' && b.count ? ` (${b.count})` : '';
                    const opt = document.createElement('option');
                    opt.value = value;
                    opt.textContent = label + count;
                    deviceBrandFilter.appendChild(opt);
                }
            }
        } catch (e) {
            // Hide device filters on error
            if (deviceBrandFilter) deviceBrandFilter.closest('.ribbons-toolbar__device-filters')?.classList.add('hidden');
        }
    }

    async function populateDeviceModelFilter(deviceBrand) {
        if (!deviceModelFilter) return;
        deviceModelFilter.innerHTML = '<option value="">All Models</option>';
        if (!deviceBrand) {
            deviceModelFilter.disabled = true;
            return;
        }
        try {
            const response = await API.getRibbonDeviceModels({ device_brand: deviceBrand });
            if (response.ok && response.data) {
                const models = response.data.device_models || response.data || [];
                for (const m of models) {
                    const value = typeof m === 'string' ? m : m.value || m;
                    const label = typeof m === 'string' ? m : m.label || m;
                    const count = typeof m === 'object' && m.count ? ` (${m.count})` : '';
                    const opt = document.createElement('option');
                    opt.value = value;
                    opt.textContent = label + count;
                    deviceModelFilter.appendChild(opt);
                }
                deviceModelFilter.disabled = false;
            }
        } catch (e) {
            deviceModelFilter.disabled = true;
        }
    }

    // --- URL state ---

    function loadFiltersFromURL() {
        const params = new URLSearchParams(window.location.search);
        if (params.get('brand')) {
            currentFilters.brand = params.get('brand');
            if (brandFilter) brandFilter.value = currentFilters.brand;
        }
        if (params.get('type')) {
            currentFilters.type = params.get('type');
            if (typeFilter) typeFilter.value = currentFilters.type;
        }
        if (params.get('device_brand')) {
            currentFilters.device_brand = params.get('device_brand');
            if (deviceBrandFilter) deviceBrandFilter.value = currentFilters.device_brand;
        }
        if (params.get('device_model')) {
            currentFilters.device_model = params.get('device_model');
            if (deviceModelFilter) deviceModelFilter.value = currentFilters.device_model;
        }
        if (params.get('sort')) {
            currentFilters.sort = params.get('sort');
            if (sortFilter) sortFilter.value = currentFilters.sort;
        }
        if (params.get('page')) {
            currentFilters.page = parseInt(params.get('page'), 10) || 1;
        }
    }

    function updateURL() {
        const params = new URLSearchParams();
        if (currentFilters.brand) params.set('brand', currentFilters.brand);
        if (currentFilters.type) params.set('type', currentFilters.type);
        if (currentFilters.device_brand) params.set('device_brand', currentFilters.device_brand);
        if (currentFilters.device_model) params.set('device_model', currentFilters.device_model);
        if (currentFilters.sort !== 'name-asc') params.set('sort', currentFilters.sort);
        if (currentFilters.page > 1) params.set('page', currentFilters.page);

        const newURL = params.toString()
            ? `${window.location.pathname}?${params.toString()}`
            : window.location.pathname;
        history.replaceState(null, '', newURL);
    }

    // --- Filter change handlers ---

    function handleFilterChange() {
        if (brandFilter) currentFilters.brand = brandFilter.value;
        if (typeFilter) currentFilters.type = typeFilter.value;
        if (deviceModelFilter) currentFilters.device_model = deviceModelFilter.value;
        if (sortFilter) currentFilters.sort = sortFilter.value;
        currentFilters.page = 1;
        updateURL();
        fetchRibbons();
    }

    async function handleDeviceBrandChange() {
        currentFilters.device_brand = deviceBrandFilter.value;
        currentFilters.device_model = '';
        currentFilters.page = 1;
        await populateDeviceModelFilter(currentFilters.device_brand);
        updateURL();
        fetchRibbons();
    }

    // --- Fetch and render ---

    async function fetchRibbons() {
        if (isLoading) return;
        isLoading = true;

        if (loadingEl) loadingEl.hidden = false;
        if (emptyEl) emptyEl.hidden = true;
        productsGrid.innerHTML = '';

        // Build API params
        const params = {
            page: currentFilters.page,
            limit: currentFilters.limit
        };
        if (currentFilters.brand) params.brand = currentFilters.brand;
        if (currentFilters.type) params.type = currentFilters.type;
        if (currentFilters.device_brand) params.device_brand = currentFilters.device_brand;
        if (currentFilters.device_model) params.device_model = currentFilters.device_model;
        if (currentFilters.sort) params.sort = currentFilters.sort;

        try {
            const response = await API.getRibbons(params);

            if (loadingEl) loadingEl.hidden = true;

            if (!response.ok) {
                showError('Failed to load ribbons. Please try again.');
                return;
            }

            const ribbons = response.data?.ribbons || response.data?.products || response.data || [];
            const pagination = response.data?.pagination || response.meta || {};
            const total = pagination.total || ribbons.length;

            if (productCount) {
                productCount.textContent = total;
            }

            if (ribbons.length === 0) {
                if (emptyEl) emptyEl.hidden = false;
                renderPagination(null);
                return;
            }

            // Render product cards
            const html = ribbons.map(ribbon => renderRibbonCard(ribbon)).join('');
            productsGrid.innerHTML = html;

            // Bind add to cart events
            productsGrid.querySelectorAll('.product-card__add-btn').forEach(btn => {
                btn.addEventListener('click', handleAddToCart);
            });

            // Bind image error fallback
            productsGrid.querySelectorAll('img[data-fallback]').forEach(img => {
                img.addEventListener('error', function() {
                    this.src = '/assets/images/placeholder-product.svg';
                }, { once: true });
            });

            renderPagination(pagination);
        } catch (e) {
            if (loadingEl) loadingEl.hidden = true;
            showError('Could not connect to the server. Please try again later.');
        } finally {
            isLoading = false;
        }
    }

    function renderRibbonCard(ribbon) {
        const name = ribbon.name || '';
        const sku = ribbon.sku || '';
        const id = ribbon.id || '';
        const brand = ribbon.brand || '';
        const source = ribbon.source || '';
        const price = ribbon.retail_price != null ? ribbon.retail_price : (ribbon.sale_price != null ? ribbon.sale_price : null);
        const inStock = ribbon.in_stock !== false && (ribbon.stock_quantity == null || ribbon.stock_quantity > 0);
        const imagePath = ribbon.image_url || ribbon.image_path || '';
        const imageUrl = typeof storageUrl === 'function' ? storageUrl(imagePath) : (imagePath || '/assets/images/placeholder-product.svg');
        const sourceBadge = typeof getSourceBadge === 'function' ? getSourceBadge(source) : null;

        const esc = typeof Security !== 'undefined' ? Security.escapeHtml.bind(Security) : (s) => s;
        const escAttr = typeof Security !== 'undefined' ? Security.escapeAttr.bind(Security) : (s) => s;
        const priceText = price != null ? (typeof formatPrice === 'function' ? formatPrice(price) : `$${Number(price).toFixed(2)}`) : 'Price unavailable';

        return `
            <article class="product-card" data-product-id="${escAttr(id)}" data-sku="${escAttr(sku)}">
                <a href="/html/product/?sku=${escAttr(sku)}" class="product-card__link">
                    <div class="product-card__image-wrapper">
                        <img src="${escAttr(imageUrl)}"
                             alt="${escAttr(name)}"
                             class="product-card__image"
                             loading="lazy"
                             data-fallback="placeholder">
                        ${sourceBadge ? `<span class="product-card__badge ${sourceBadge.class}">${sourceBadge.text}</span>` : ''}
                        ${!inStock ? '<span class="product-card__badge badge-out-of-stock">Out of Stock</span>' : ''}
                    </div>
                    <div class="product-card__content">
                        <p class="product-card__brand">${esc(brand)}</p>
                        <h3 class="product-card__title">${esc(name)}</h3>
                        <p class="product-card__price">${priceText}</p>
                    </div>
                </a>
                <button class="product-card__add-btn btn btn--primary"
                        ${!inStock || price == null ? 'disabled' : ''}
                        data-product-id="${escAttr(id)}"
                        data-product-sku="${escAttr(sku)}"
                        data-product-name="${escAttr(name)}"
                        data-product-price="${escAttr(price)}"
                        data-product-image="${escAttr(imageUrl)}">
                    ${inStock ? 'Add to Cart' : 'Out of Stock'}
                </button>
            </article>
        `;
    }

    // --- Pagination ---

    function renderPagination(pagination) {
        if (!paginationEl) return;
        if (!pagination || !pagination.total_pages || pagination.total_pages <= 1) {
            paginationEl.innerHTML = '';
            return;
        }

        const page = pagination.page || currentFilters.page;
        const totalPages = pagination.total_pages;
        let html = '<div class="pagination">';

        // Previous
        if (pagination.has_prev || page > 1) {
            html += `<button class="pagination__btn" data-page="${page - 1}">&laquo; Prev</button>`;
        }

        // Page numbers (show up to 7 pages around current)
        const start = Math.max(1, page - 3);
        const end = Math.min(totalPages, page + 3);

        if (start > 1) {
            html += `<button class="pagination__btn" data-page="1">1</button>`;
            if (start > 2) html += `<span class="pagination__ellipsis">&hellip;</span>`;
        }

        for (let i = start; i <= end; i++) {
            html += `<button class="pagination__btn${i === page ? ' pagination__btn--active' : ''}" data-page="${i}">${i}</button>`;
        }

        if (end < totalPages) {
            if (end < totalPages - 1) html += `<span class="pagination__ellipsis">&hellip;</span>`;
            html += `<button class="pagination__btn" data-page="${totalPages}">${totalPages}</button>`;
        }

        // Next
        if (pagination.has_next || page < totalPages) {
            html += `<button class="pagination__btn" data-page="${page + 1}">Next &raquo;</button>`;
        }

        html += '</div>';
        paginationEl.innerHTML = html;

        // Bind page buttons
        paginationEl.querySelectorAll('.pagination__btn[data-page]').forEach(btn => {
            btn.addEventListener('click', () => {
                currentFilters.page = parseInt(btn.dataset.page, 10);
                updateURL();
                fetchRibbons();
                productsGrid.scrollIntoView({ behavior: 'smooth', block: 'start' });
            });
        });
    }

    // --- Add to cart ---

    function handleAddToCart(e) {
        e.preventDefault();
        const btn = e.currentTarget;
        const productId = btn.dataset.productId;
        const sku = btn.dataset.productSku;
        const name = btn.dataset.productName;
        const price = parseFloat(btn.dataset.productPrice);
        const image = btn.dataset.productImage || '/assets/images/placeholder-product.svg';

        if (!productId || isNaN(price)) return;

        if (typeof Cart !== 'undefined' && Cart.addItem) {
            Cart.addItem({
                id: productId,
                sku: sku,
                name: name,
                price: price,
                quantity: 1,
                image: image,
                category: 'ribbon'
            });
        }

        // Visual feedback
        btn.textContent = 'Added!';
        btn.disabled = true;
        setTimeout(() => {
            btn.textContent = 'Add to Cart';
            btn.disabled = false;
        }, 1500);
    }

    // --- Helpers ---

    function showError(message) {
        if (productsGrid) {
            productsGrid.innerHTML = `
                <div class="ribbons-error">
                    <p>${typeof Security !== 'undefined' ? Security.escapeHtml(message) : message}</p>
                    <button class="btn btn--outline" onclick="location.reload()">Retry</button>
                </div>
            `;
        }
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
