/**
 * RIBBONS PAGE JS
 * Handles filtering, sorting, and interactions for the ribbons page
 */

(function() {
    'use strict';

    // Ribbon products data (loaded from backend in production)
    const ribbonProducts = [
        { id: 'brother-1030-ribbon', brand: 'brother', category: 'typewriter', type: 'genuine', price: 16.99, name: 'Brother 1030 Correctable Film Ribbon' },
        { id: 'brother-3015-ribbon', brand: 'brother', category: 'typewriter', type: 'genuine', price: 9.99, name: 'Brother 3015 Lift-Off Correction Tape' },
        { id: 'ibm-wheelwriter-ribbon', brand: 'ibm', category: 'typewriter', type: 'compatible', price: 15.99, salePrice: 15.99, name: 'IBM Wheelwriter Correctable Ribbon' },
        { id: 'ibm-selectric-ribbon', brand: 'ibm', category: 'typewriter', type: 'compatible', price: 21.99, name: 'IBM Selectric II/III Ribbon Cartridge' },
        { id: 'olivetti-lettera-ribbon', brand: 'olivetti', category: 'typewriter', type: 'compatible', price: 12.99, name: 'Olivetti Lettera Universal Ribbon' },
        { id: 'swintec-1146-ribbon', brand: 'swintec', category: 'typewriter', type: 'compatible', price: 14.99, name: 'Swintec 1146 CM Typewriter Ribbon' },
        { id: 'generic-universal-nylon', brand: 'universal', category: 'typewriter', type: 'compatible', price: 7.99, salePrice: 7.99, name: 'Universal Typewriter Ribbon (Black/Red)' },
        { id: 'epson-lq590-ribbon', brand: 'epson', category: 'dot-matrix', type: 'genuine', price: 24.99, name: 'Epson LQ-590 Black Ribbon Cartridge' },
        { id: 'epson-lx350-ribbon', brand: 'epson', category: 'dot-matrix', type: 'genuine', price: 15.99, salePrice: 15.99, name: 'Epson LX-350 Fabric Ribbon' },
        { id: 'epson-fx890-comp-ribbon', brand: 'epson', category: 'dot-matrix', type: 'compatible', price: 24.99, salePrice: 24.99, name: 'Epson FX-890 Compatible Ribbon (3-Pack)' },
        { id: 'oki-ml320-ribbon', brand: 'oki', category: 'dot-matrix', type: 'genuine', price: 19.99, salePrice: 19.99, name: 'OKI ML320/321 Ribbon Cartridge' },
        { id: 'oki-ml590-ribbon', brand: 'oki', category: 'dot-matrix', type: 'genuine', price: 28.99, name: 'OKI ML590/591 Black Ribbon' },
        { id: 'citizen-dp600-ribbon', brand: 'citizen', category: 'dot-matrix', type: 'compatible', price: 14.99, name: 'Citizen DP-600 Printer Ribbon' },
        { id: 'olivetti-pr2-ribbon', brand: 'olivetti', category: 'dot-matrix', type: 'genuine', price: 32.99, name: 'Olivetti PR2 Passbook Printer Ribbon' },
        { id: 'epson-erc-09-ribbon', brand: 'epson', category: 'pos-receipt', type: 'genuine', price: 12.99, name: 'Epson ERC-09 POS Ribbon' },
        { id: 'epson-erc-38-ribbon-br', brand: 'epson', category: 'pos-receipt', type: 'genuine', price: 14.99, name: 'Epson ERC-38 Black/Red Ribbon' },
        { id: 'star-sp700-ribbon', brand: 'star', category: 'pos-receipt', type: 'genuine', price: 11.99, name: 'Star SP700 POS Ribbon Cartridge' },
        { id: 'star-sp500-ribbon-br', brand: 'star', category: 'pos-receipt', type: 'genuine', price: 11.99, salePrice: 11.99, name: 'Star SP500 Black/Red Ribbon' },
        { id: 'amano-pix-ribbon', brand: 'amano', category: 'time-clock', type: 'compatible', price: 8.99, name: 'Amano PIX Time Clock Ribbon' },
        { id: 'acroprint-125-ribbon', brand: 'acroprint', category: 'time-clock', type: 'compatible', price: 7.99, name: 'Acroprint 125/150 Time Recorder Ribbon' }
    ];

    // DOM elements
    const brandFilter = document.getElementById('brand-filter');
    const typeFilter = document.getElementById('type-filter');
    const sortFilter = document.getElementById('sort-filter');
    const productCount = document.getElementById('product-count');
    const categoryCards = document.querySelectorAll('.ribbon-category-card');

    // State
    let currentFilters = {
        brand: '',
        type: '',
        category: '',
        sort: 'relevance'
    };

    // Initialize
    function init() {
        if (!brandFilter || !typeFilter || !sortFilter) return;

        // Load filters from URL
        loadFiltersFromURL();

        // Attach event listeners
        brandFilter.addEventListener('change', handleFilterChange);
        typeFilter.addEventListener('change', handleFilterChange);
        sortFilter.addEventListener('change', handleFilterChange);

        // Category card smooth scroll with filter
        categoryCards.forEach(card => {
            card.addEventListener('click', (e) => {
                e.preventDefault();
                const category = card.dataset.category;
                const targetId = card.getAttribute('href');
                const targetSection = document.querySelector(targetId);

                if (targetSection) {
                    targetSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            });
        });

        // Add to cart buttons
        document.querySelectorAll('.product-card__add-btn').forEach(btn => {
            btn.addEventListener('click', handleAddToCart);
        });

        // Apply initial filters
        applyFilters();
    }

    // Load filters from URL parameters
    function loadFiltersFromURL() {
        const params = new URLSearchParams(window.location.search);

        if (params.get('brand')) {
            currentFilters.brand = params.get('brand');
            brandFilter.value = currentFilters.brand;
        }
        if (params.get('type')) {
            currentFilters.type = params.get('type');
            typeFilter.value = currentFilters.type;
        }
        if (params.get('category')) {
            currentFilters.category = params.get('category');
        }
        if (params.get('sort')) {
            currentFilters.sort = params.get('sort');
            sortFilter.value = currentFilters.sort;
        }
    }

    // Handle filter changes
    function handleFilterChange() {
        currentFilters.brand = brandFilter.value;
        currentFilters.type = typeFilter.value;
        currentFilters.sort = sortFilter.value;

        applyFilters();
        updateURL();
    }

    // Apply filters to product cards
    function applyFilters() {
        let visibleCount = 0;
        const allCards = document.querySelectorAll('.product-card');

        allCards.forEach(card => {
            const productId = card.querySelector('.product-card__add-btn')?.dataset.productId;
            const product = ribbonProducts.find(p => p.id === productId);

            if (!product) {
                card.style.display = '';
                visibleCount++;
                return;
            }

            let visible = true;

            // Brand filter
            if (currentFilters.brand && product.brand !== currentFilters.brand) {
                visible = false;
            }

            // Type filter
            if (currentFilters.type && product.type !== currentFilters.type) {
                visible = false;
            }

            // Category filter
            if (currentFilters.category && product.category !== currentFilters.category) {
                visible = false;
            }

            card.style.display = visible ? '' : 'none';
            if (visible) visibleCount++;
        });

        // Update count
        if (productCount) {
            productCount.textContent = visibleCount;
        }

        // Sort products within each grid
        if (currentFilters.sort !== 'relevance') {
            sortProducts();
        }
    }

    // Sort products
    function sortProducts() {
        const grids = document.querySelectorAll('.products-grid');

        grids.forEach(grid => {
            const cards = Array.from(grid.querySelectorAll('.product-card'));

            cards.sort((a, b) => {
                const aId = a.querySelector('.product-card__add-btn')?.dataset.productId;
                const bId = b.querySelector('.product-card__add-btn')?.dataset.productId;
                const aProduct = ribbonProducts.find(p => p.id === aId);
                const bProduct = ribbonProducts.find(p => p.id === bId);

                if (!aProduct || !bProduct) return 0;

                const aPrice = aProduct.salePrice || aProduct.price;
                const bPrice = bProduct.salePrice || bProduct.price;

                switch (currentFilters.sort) {
                    case 'price-low':
                        return aPrice - bPrice;
                    case 'price-high':
                        return bPrice - aPrice;
                    case 'name':
                        return aProduct.name.localeCompare(bProduct.name);
                    default:
                        return 0;
                }
            });

            // Re-append sorted cards
            cards.forEach(card => grid.appendChild(card));
        });
    }

    // Update URL with current filters
    function updateURL() {
        const params = new URLSearchParams();

        if (currentFilters.brand) params.set('brand', currentFilters.brand);
        if (currentFilters.type) params.set('type', currentFilters.type);
        if (currentFilters.category) params.set('category', currentFilters.category);
        if (currentFilters.sort !== 'relevance') params.set('sort', currentFilters.sort);

        const newURL = params.toString()
            ? `${window.location.pathname}?${params.toString()}`
            : window.location.pathname;

        history.replaceState(null, '', newURL);
    }

    // Handle add to cart
    function handleAddToCart(e) {
        const btn = e.currentTarget;
        const productId = btn.dataset.productId;
        const product = ribbonProducts.find(p => p.id === productId);

        if (!product) {
            console.error('Product not found:', productId);
            return;
        }

        // Create cart item
        const cartItem = {
            id: product.id,
            name: product.name,
            price: product.salePrice || product.price,
            quantity: 1,
            image: '/assets/images/placeholder-product.svg',
            category: 'ribbon'
        };

        // Add to cart using Cart module if available
        if (typeof Cart !== 'undefined' && Cart.addItem) {
            Cart.addItem(cartItem);

            // Visual feedback
            btn.textContent = 'Added!';
            btn.disabled = true;
            setTimeout(() => {
                btn.textContent = 'Add to Cart';
                btn.disabled = false;
            }, 1500);
        } else {
            // Fallback visual feedback
            btn.textContent = 'Added!';
            btn.disabled = true;
            setTimeout(() => {
                btn.textContent = 'Add to Cart';
                btn.disabled = false;
            }, 1500);
        }
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
