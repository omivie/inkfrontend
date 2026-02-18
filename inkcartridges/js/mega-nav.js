/**
 * MEGA-NAV.JS
 * ===========
 * Brands mega dropdown for the top navigation.
 * Click "Brands" to open a panel showing all brand cards with category links.
 */

'use strict';

(function() {

    // ============================================
    // DOM ELEMENTS
    // ============================================
    const trigger = document.querySelector('.nav-mega-toggle');
    const panel = document.getElementById('brands-mega');

    if (!trigger || !panel) return;

    const cardsContainer = panel.querySelector('.brands-mega__cards');

    // ============================================
    // DATA
    // ============================================
    const BRANDS = [
        { slug: 'brother', name: 'Brother', logo: '/assets/brands/brother.png',
          categories: [
              { label: 'Ink Cartridges', param: 'ink' },
              { label: 'Toner Cartridges', param: 'toner' },
              { label: 'Drums & Supplies', param: 'consumable' }
          ]},
        { slug: 'canon', name: 'Canon', logo: '/assets/brands/canon.png',
          categories: [
              { label: 'Ink Cartridges', param: 'ink' },
              { label: 'Toner Cartridges', param: 'toner' }
          ]},
        { slug: 'epson', name: 'Epson', logo: '/assets/brands/epson.png',
          categories: [
              { label: 'Ink Cartridges', param: 'ink' }
          ]},
        { slug: 'hp', name: 'HP', logo: '/assets/brands/hp.png',
          categories: [
              { label: 'Ink Cartridges', param: 'ink' },
              { label: 'Toner Cartridges', param: 'toner' },
              { label: 'Drums & Supplies', param: 'consumable' }
          ]},
        { slug: 'samsung', name: 'Samsung', logo: '/assets/brands/samsung.svg',
          categories: [
              { label: 'Toner Cartridges', param: 'toner' },
              { label: 'Drums & Supplies', param: 'consumable' }
          ]},
        { slug: 'lexmark', name: 'Lexmark', logo: '/assets/brands/lexmark.png',
          categories: [
              { label: 'Toner Cartridges', param: 'toner' },
              { label: 'Drums & Supplies', param: 'consumable' }
          ]},
        { slug: 'oki', name: 'OKI', logo: '/assets/brands/oki.svg',
          categories: [
              { label: 'Toner Cartridges', param: 'toner' },
              { label: 'Drums & Supplies', param: 'consumable' }
          ]},
        { slug: 'fuji-xerox', name: 'Fuji Xerox', logo: '/assets/brands/fuji-xerox.png',
          categories: [
              { label: 'Toner Cartridges', param: 'toner' },
              { label: 'Drums & Supplies', param: 'consumable' }
          ]},
        { slug: 'kyocera', name: 'Kyocera', logo: '/assets/brands/kyocera.svg',
          categories: [
              { label: 'Toner Cartridges', param: 'toner' },
              { label: 'Drums & Supplies', param: 'consumable' }
          ]}
    ];

    // ============================================
    // STATE
    // ============================================
    let isOpen = false;

    // ============================================
    // RENDER BRAND CARDS
    // ============================================
    function renderBrands() {
        cardsContainer.innerHTML = BRANDS.map(brand => `
            <div class="brands-mega__card">
                <div class="brands-mega__logo-wrap">
                    <img src="${brand.logo}" alt="${brand.name}" class="brands-mega__brand-logo brands-mega__brand-logo--${brand.slug}">
                </div>
                <div class="brands-mega__card-links">
                    ${brand.categories.map(cat =>
                        `<a href="/html/shop.html?brand=${brand.slug}&category=${cat.param}" class="brands-mega__card-link">${cat.label}</a>`
                    ).join('\n                    ')}
                    <a href="/html/shop.html?brand=${brand.slug}" class="brands-mega__card-link">All Products</a>
                </div>
            </div>
        `).join('');
    }

    // ============================================
    // OPEN / CLOSE
    // ============================================
    function open() {
        panel.hidden = false;
        trigger.setAttribute('aria-expanded', 'true');
        isOpen = true;
    }

    function close() {
        panel.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
        isOpen = false;
    }

    function toggle() {
        if (isOpen) {
            close();
        } else {
            open();
        }
    }

    // ============================================
    // EVENT LISTENERS
    // ============================================

    // Toggle on trigger click
    trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        toggle();
    });

    // Close on click outside
    document.addEventListener('click', (e) => {
        if (isOpen && !panel.contains(e.target) && !trigger.contains(e.target)) {
            close();
        }
    });

    // Close on ESC
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isOpen) {
            close();
            trigger.focus();
        }
    });

    // ============================================
    // INITIALIZE
    // ============================================
    renderBrands();

})();
