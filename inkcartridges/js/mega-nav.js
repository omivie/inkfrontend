/**
 * MEGA-NAV.JS
 * ===========
 * Mega dropdowns for the top navigation.
 * - "Ink Cartridge Brands" panel: brand cards with category links
 * - "Ribbons" panel: typewriter/printer ribbon brand buttons
 */

'use strict';

(function() {

    // ============================================
    // DOM ELEMENTS — Brands panel
    // ============================================
    const brandsTrigger = document.querySelector('.nav-mega-toggle');
    const brandsPanel = document.getElementById('brands-mega');

    if (!brandsTrigger || !brandsPanel) return;

    const brandsCardsContainer = brandsPanel.querySelector('.brands-mega__cards');

    // ============================================
    // DOM ELEMENTS — Ribbons panel
    // ============================================
    const ribbonsTrigger = document.querySelector('.nav-ribbons-toggle');
    const ribbonsPanel = document.getElementById('ribbons-mega');
    const ribbonsGrid = ribbonsPanel ? ribbonsPanel.querySelector('.ribbons-mega__grid') : null;

    // ============================================
    // DATA — Ink/Toner Brands
    // ============================================
    const BRANDS = [
        { slug: 'brother', name: 'Brother', logo: '/assets/brands/brother.png',
          categories: [
              { label: 'Ink Cartridges', param: 'ink' },
              { label: 'Toner Cartridges', param: 'toner' },
              { label: 'Drums & Supplies', param: 'drums' }
          ]},
        { slug: 'canon', name: 'Canon', logo: '/assets/brands/canon.png',
          categories: [
              { label: 'Ink Cartridges', param: 'ink' },
              { label: 'Toner Cartridges', param: 'toner' },
              { label: 'Drums & Supplies', param: 'drums' }
          ]},
        { slug: 'epson', name: 'Epson', logo: '/assets/brands/epson.png',
          categories: [
              { label: 'Ink Cartridges', param: 'ink' },
              { label: 'Drums & Supplies', param: 'drums' }
          ]},
        { slug: 'hp', name: 'HP', logo: '/assets/brands/hp.png',
          categories: [
              { label: 'Ink Cartridges', param: 'ink' },
              { label: 'Toner Cartridges', param: 'toner' },
              { label: 'Drums & Supplies', param: 'drums' }
          ]},
        { slug: 'samsung', name: 'Samsung', logo: '/assets/brands/samsung.svg',
          categories: [
              { label: 'Toner Cartridges', param: 'toner' },
              { label: 'Drums & Supplies', param: 'drums' }
          ]},
        { slug: 'lexmark', name: 'Lexmark', logo: '/assets/brands/lexmark.png',
          categories: [
              { label: 'Toner Cartridges', param: 'toner' },
              { label: 'Drums & Supplies', param: 'drums' }
          ]},
        { slug: 'oki', name: 'OKI', logo: '/assets/brands/oki.svg',
          categories: [
              { label: 'Toner Cartridges', param: 'toner' },
              { label: 'Drums & Supplies', param: 'drums' }
          ]},
        { slug: 'fuji-xerox', name: 'Fuji Xerox', logo: '/assets/brands/fuji-xerox.png',
          categories: [
              { label: 'Ink Cartridges', param: 'ink' },
              { label: 'Toner Cartridges', param: 'toner' },
              { label: 'Drums & Supplies', param: 'drums' }
          ]},
        { slug: 'kyocera', name: 'Kyocera', logo: '/assets/brands/kyocera.svg',
          categories: [
              { label: 'Toner Cartridges', param: 'toner' },
              { label: 'Drums & Supplies', param: 'drums' }
          ]}
    ];

    // ============================================
    // DATA — Ribbon Brands
    // ============================================
    const RIBBON_BRANDS = [
        'Amano', 'Brother', 'Canon', 'Citizen', 'Epson',
        'Fujitsu', 'IBM', 'Nakajima', 'NEC', 'NCR',
        'OKI', 'Olivetti', 'Olympia', 'Panasonic', 'Printronix',
        'Seiko', 'Sharp', 'Star', 'Triumph-Adler', 'Universal'
    ];

    // ============================================
    // STATE
    // ============================================
    let brandsOpen = false;
    let ribbonsOpen = false;

    // ============================================
    // RENDER BRAND CARDS (Ink/Toner)
    // ============================================
    function renderBrands() {
        brandsCardsContainer.innerHTML = BRANDS.map(brand => `
            <div class="brands-mega__card">
                <div class="brands-mega__logo-wrap">
                    <img src="${Security.escapeAttr(brand.logo)}" alt="${Security.escapeAttr(brand.name)}" class="brands-mega__brand-logo brands-mega__brand-logo--${Security.escapeAttr(brand.slug)}">
                </div>
                <div class="brands-mega__card-links">
                    ${brand.categories.map(cat =>
                        `<a href="/html/shop?brand=${Security.escapeAttr(brand.slug)}&category=${Security.escapeAttr(cat.param)}" class="brands-mega__card-link">${Security.escapeHtml(cat.label)}</a>`
                    ).join('\n                    ')}
                    <a href="/html/shop?brand=${Security.escapeAttr(brand.slug)}" class="brands-mega__card-link">All Products</a>
                </div>
            </div>
        `).join('');
    }

    // ============================================
    // RENDER RIBBON BRAND BUTTONS
    // ============================================
    function renderRibbons() {
        if (!ribbonsGrid) return;
        ribbonsGrid.innerHTML = RIBBON_BRANDS.map(brand =>
            `<a href="/html/ribbons?brand=${Security.escapeAttr(brand)}" class="ribbons-mega__brand-btn">${Security.escapeHtml(brand)}</a>`
        ).join('');
    }

    // ============================================
    // OPEN / CLOSE — Brands
    // ============================================
    function openBrands() {
        closeRibbons();
        brandsPanel.hidden = false;
        brandsTrigger.setAttribute('aria-expanded', 'true');
        brandsOpen = true;
    }

    function closeBrands() {
        brandsPanel.hidden = true;
        brandsTrigger.setAttribute('aria-expanded', 'false');
        brandsOpen = false;
    }

    function toggleBrands() {
        if (brandsOpen) {
            closeBrands();
        } else {
            openBrands();
        }
    }

    // ============================================
    // OPEN / CLOSE — Ribbons
    // ============================================
    function openRibbons() {
        if (!ribbonsPanel || !ribbonsTrigger) return;
        closeBrands();
        ribbonsPanel.hidden = false;
        ribbonsTrigger.setAttribute('aria-expanded', 'true');
        ribbonsOpen = true;
    }

    function closeRibbons() {
        if (!ribbonsPanel || !ribbonsTrigger) return;
        ribbonsPanel.hidden = true;
        ribbonsTrigger.setAttribute('aria-expanded', 'false');
        ribbonsOpen = false;
    }

    function toggleRibbons() {
        if (ribbonsOpen) {
            closeRibbons();
        } else {
            openRibbons();
        }
    }

    // ============================================
    // EVENT LISTENERS
    // ============================================

    // Toggle brands panel
    brandsTrigger.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleBrands();
    });

    // Toggle ribbons panel
    if (ribbonsTrigger) {
        ribbonsTrigger.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleRibbons();
        });
    }

    // Close on click outside
    document.addEventListener('click', (e) => {
        if (brandsOpen && !brandsPanel.contains(e.target) && !brandsTrigger.contains(e.target)) {
            closeBrands();
        }
        if (ribbonsOpen && ribbonsPanel && ribbonsTrigger && !ribbonsPanel.contains(e.target) && !ribbonsTrigger.contains(e.target)) {
            closeRibbons();
        }
    });

    // Close on ESC
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (brandsOpen) {
                closeBrands();
                brandsTrigger.focus();
            }
            if (ribbonsOpen && ribbonsTrigger) {
                closeRibbons();
                ribbonsTrigger.focus();
            }
        }
    });

    // ============================================
    // INITIALIZE
    // ============================================
    renderBrands();
    renderRibbons();

})();
