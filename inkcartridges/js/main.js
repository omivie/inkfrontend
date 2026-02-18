/**
 * MAIN.JS
 * =======
 * Main JavaScript file for InkCartridges.co.nz
 *
 * This file contains:
 * - Global site initialization
 * - Navigation functionality
 * - Header interactions
 * - Common UI behaviors
 *
 * This is a structural placeholder. Full functionality
 * will be implemented when building pages in PART 3.
 */

'use strict';

/**
 * SITE INITIALIZATION
 * ===================
 */

document.addEventListener('DOMContentLoaded', function() {
    initNavigation();
    initSearch();
    initCurrentYear();
    initDropdowns();
    initMegaPanels();
});


/**
 * NAVIGATION
 * ==========
 */

function initNavigation() {
    const navToggle = $('.nav-toggle');
    const navMenu = $('#nav-menu');

    if (navToggle && navMenu) {
        navToggle.addEventListener('click', function() {
            const isOpen = navMenu.classList.toggle('is-open');
            navToggle.setAttribute('aria-expanded', isOpen);
        });
    }

    // Close mobile menu when clicking outside
    document.addEventListener('click', function(e) {
        if (navMenu && navMenu.classList.contains('is-open')) {
            if (!e.target.closest('.primary-nav')) {
                navMenu.classList.remove('is-open');
                navToggle.setAttribute('aria-expanded', 'false');
            }
        }
    });

    // Handle dropdown navigation for keyboard users
    const dropdownItems = $$('.nav-menu__item--has-dropdown');
    dropdownItems.forEach(function(item) {
        const link = item.querySelector('a');
        const dropdown = item.querySelector('.nav-dropdown');

        link.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                const isExpanded = link.getAttribute('aria-expanded') === 'true';
                link.setAttribute('aria-expanded', !isExpanded);
            }
        });
    });
}


/**
 * MEGA PANELS
 * ===========
 */

function initMegaPanels() {
    const megaToggles = document.querySelectorAll('.nav-mega-toggle');

    megaToggles.forEach(function(toggle) {
        toggle.addEventListener('click', function() {
            const targetId = this.getAttribute('data-target');
            const targetPanel = document.getElementById(targetId);
            const isExpanded = this.getAttribute('aria-expanded') === 'true';

            // Close all other panels first
            megaToggles.forEach(function(otherToggle) {
                if (otherToggle !== toggle) {
                    otherToggle.setAttribute('aria-expanded', 'false');
                    const otherId = otherToggle.getAttribute('data-target');
                    const otherPanel = document.getElementById(otherId);
                    if (otherPanel) {
                        otherPanel.hidden = true;
                    }
                }
            });

            // Toggle this panel
            if (targetPanel) {
                const newState = !isExpanded;
                this.setAttribute('aria-expanded', newState);
                targetPanel.hidden = !newState;
            }
        });
    });

    // Close panels when clicking outside
    document.addEventListener('click', function(e) {
        if (!e.target.closest('.nav-mega-toggle') && !e.target.closest('.mega-panel')) {
            megaToggles.forEach(function(toggle) {
                toggle.setAttribute('aria-expanded', 'false');
                const targetId = toggle.getAttribute('data-target');
                const targetPanel = document.getElementById(targetId);
                if (targetPanel) {
                    targetPanel.hidden = true;
                }
            });
        }
    });
}


/**
 * SEARCH WITH AUTOCOMPLETE
 * ========================
 * Searches for products and printers, shows autocomplete suggestions
 */

function initSearch() {
    const searchForm = $('.search-form');
    const searchInput = $('#search-input');

    if (!searchForm || !searchInput) return;

    // Create autocomplete dropdown
    let dropdown = searchForm.querySelector('.search-autocomplete');
    if (!dropdown) {
        dropdown = document.createElement('div');
        dropdown.className = 'search-autocomplete';
        dropdown.innerHTML = '<ul class="search-autocomplete__list"></ul>';
        searchForm.appendChild(dropdown);
    }
    const list = dropdown.querySelector('.search-autocomplete__list');

    let debounceTimer = null;
    let selectedIndex = -1;

    // Handle input changes
    searchInput.addEventListener('input', function() {
        const query = this.value.trim();

        clearTimeout(debounceTimer);

        if (query.length < 2) {
            hideDropdown();
            return;
        }

        debounceTimer = setTimeout(() => fetchSuggestions(query), 300);
    });

    // Fetch autocomplete suggestions
    async function fetchSuggestions(query) {
        try {
            // Fetch both products and printers
            const [autocompleteRes, printersRes] = await Promise.all([
                API.getAutocomplete(query, 5),
                API.searchPrinters(query)
            ]);

            const suggestions = [];

            // Add printer suggestions first (higher priority for printer searches)
            if (printersRes.success && printersRes.data) {
                const printers = Array.isArray(printersRes.data) ? printersRes.data : printersRes.data.printers || [];
                printers.slice(0, 4).forEach(printer => {
                    suggestions.push({
                        type: 'printer',
                        id: printer.id,
                        name: printer.full_name || printer.model_name,
                        slug: printer.slug,
                        brand: printer.brand?.name || '',
                        productCount: printer.compatible_product_count || 0
                    });
                });
            }

            // Add product suggestions
            if (autocompleteRes.success && autocompleteRes.data) {
                const products = autocompleteRes.data.suggestions || autocompleteRes.data || [];
                products.slice(0, 4).forEach(item => {
                    if (item.type === 'product' || item.sku) {
                        suggestions.push({
                            type: 'product',
                            id: item.id,
                            name: item.name,
                            sku: item.sku,
                            price: item.retail_price
                        });
                    }
                });
            }

            renderSuggestions(suggestions, query);
        } catch (error) {
            console.error('Search error:', error);
            hideDropdown();
        }
    }

    // Render suggestions
    function renderSuggestions(suggestions, query) {
        if (suggestions.length === 0) {
            list.innerHTML = `
                <li class="search-autocomplete__empty">
                    No results for "${Security.escapeHtml(query)}"
                </li>
            `;
            showDropdown();
            return;
        }

        list.innerHTML = suggestions.map((item, index) => {
            if (item.type === 'printer') {
                return `
                    <li class="search-autocomplete__item search-autocomplete__item--printer"
                        data-index="${index}" data-type="printer" data-slug="${Security.escapeAttr(item.slug)}">
                        <span class="search-autocomplete__icon">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="6 9 6 2 18 2 18 9"></polyline>
                                <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path>
                                <rect x="6" y="14" width="12" height="8"></rect>
                            </svg>
                        </span>
                        <span class="search-autocomplete__content">
                            <span class="search-autocomplete__name">${Security.escapeHtml(item.name)}</span>
                            <span class="search-autocomplete__meta">Printer • ${Security.escapeHtml(String(item.productCount))} compatible products</span>
                        </span>
                    </li>
                `;
            } else {
                return `
                    <li class="search-autocomplete__item search-autocomplete__item--product"
                        data-index="${index}" data-type="product" data-sku="${Security.escapeAttr(item.sku)}">
                        <span class="search-autocomplete__icon">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/>
                            </svg>
                        </span>
                        <span class="search-autocomplete__content">
                            <span class="search-autocomplete__name">${Security.escapeHtml(item.name)}</span>
                            <span class="search-autocomplete__meta">Product ${item.price ? '• ' + formatPrice(item.price) : ''}</span>
                        </span>
                    </li>
                `;
            }
        }).join('');

        // Add click handlers
        list.querySelectorAll('.search-autocomplete__item').forEach(item => {
            item.addEventListener('click', () => selectItem(item));
        });

        showDropdown();
        selectedIndex = -1;
    }

    // Select an item
    function selectItem(item) {
        const type = item.dataset.type;

        if (type === 'printer') {
            // Navigate to printer products page
            const slug = item.dataset.slug;
            window.location.href = `/html/shop.html?printer=${slug}`;
        } else if (type === 'product') {
            // Navigate to product detail page
            const sku = item.dataset.sku;
            window.location.href = `/html/product/index.html?sku=${sku}`;
        }

        hideDropdown();
    }

    // Keyboard navigation
    searchInput.addEventListener('keydown', function(e) {
        const items = list.querySelectorAll('.search-autocomplete__item');

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
            updateSelection(items);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            selectedIndex = Math.max(selectedIndex - 1, -1);
            updateSelection(items);
        } else if (e.key === 'Enter' && selectedIndex >= 0) {
            e.preventDefault();
            selectItem(items[selectedIndex]);
        } else if (e.key === 'Escape') {
            hideDropdown();
        }
    });

    function updateSelection(items) {
        items.forEach((item, i) => {
            item.classList.toggle('is-selected', i === selectedIndex);
        });
    }

    function showDropdown() {
        dropdown.classList.add('is-open');
    }

    function hideDropdown() {
        dropdown.classList.remove('is-open');
        selectedIndex = -1;
    }

    // Hide dropdown when clicking outside
    document.addEventListener('click', function(e) {
        if (!searchForm.contains(e.target)) {
            hideDropdown();
        }
    });

    // Handle form submission - search for products
    searchForm.addEventListener('submit', function(e) {
        e.preventDefault();
        const query = searchInput.value.trim();
        if (query) {
            window.location.href = `/html/shop.html?search=${encodeURIComponent(query)}`;
        }
    });
}


/**
 * DROPDOWNS
 * =========
 */

function initDropdowns() {
    // Generic dropdown initialization for select elements, etc.
    const dropdowns = $$('[data-dropdown]');

    dropdowns.forEach(function(dropdown) {
        const trigger = dropdown.querySelector('[data-dropdown-trigger]');
        const content = dropdown.querySelector('[data-dropdown-content]');

        if (trigger && content) {
            trigger.addEventListener('click', function() {
                const isOpen = content.classList.toggle('is-open');
                trigger.setAttribute('aria-expanded', isOpen);
            });
        }
    });
}


/**
 * CURRENT YEAR
 * ============
 * Updates copyright year automatically
 */

function initCurrentYear() {
    const yearElements = $$('#current-year');
    const currentYear = new Date().getFullYear();

    yearElements.forEach(function(el) {
        el.textContent = currentYear;
    });
}


/**
 * CART COUNT
 * ==========
 * Updates cart count badge
 */

function updateCartCount(count) {
    const cartCounts = $$('.cart-count');

    cartCounts.forEach(function(el) {
        el.textContent = count;
        el.setAttribute('aria-label', `${count} items in cart`);

        // Show/hide badge based on count
        if (count > 0) {
            el.classList.add('has-items');
        } else {
            el.classList.remove('has-items');
        }
    });
}


/**
 * TOAST NOTIFICATIONS
 * ===================
 * Display temporary messages to users
 */

function showToast(message, type = 'info', duration = 3000) {
    // Create toast element
    const toast = document.createElement('div');
    toast.className = `toast toast--${type}`;
    toast.setAttribute('role', 'alert');
    toast.innerHTML = `
        <span class="toast__message">${Security.escapeHtml(message)}</span>
        <button type="button" class="toast__close" aria-label="Close">&times;</button>
    `;

    // Add to page
    let container = $('.toast-container');
    if (!container) {
        container = document.createElement('div');
        container.className = 'toast-container';
        document.body.appendChild(container);
    }
    container.appendChild(toast);

    // Animate in
    requestAnimationFrame(function() {
        toast.classList.add('toast--visible');
    });

    // Close button
    toast.querySelector('.toast__close').addEventListener('click', function() {
        removeToast(toast);
    });

    // Auto remove
    if (duration > 0) {
        setTimeout(function() {
            removeToast(toast);
        }, duration);
    }

    return toast;
}

function removeToast(toast) {
    toast.classList.remove('toast--visible');
    toast.addEventListener('transitionend', function() {
        toast.remove();
    });
}


/**
 * SMOOTH SCROLL
 * =============
 * Handle anchor links with smooth scrolling
 */

document.addEventListener('click', function(e) {
    const anchor = e.target.closest('a[href^="#"]');

    if (anchor) {
        const targetId = anchor.getAttribute('href');
        if (targetId === '#') return;

        const target = document.querySelector(targetId);
        if (target) {
            e.preventDefault();

            // For ink-finder, center the entire wrapper box on screen
            if (targetId === '#ink-finder-heading') {
                const wrapper = document.querySelector('.ink-finder__wrapper');
                if (wrapper) {
                    const wrapperRect = wrapper.getBoundingClientRect();
                    const wrapperHeight = wrapperRect.height;
                    const windowHeight = window.innerHeight;
                    const scrollTop = window.pageYOffset + wrapperRect.top - (windowHeight - wrapperHeight) / 2;

                    window.scrollTo({
                        top: Math.max(0, scrollTop),
                        behavior: 'smooth'
                    });
                } else {
                    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            } else {
                target.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start'
                });
            }

            // Update URL without scrolling
            history.pushState(null, null, targetId);
        }
    }
});
