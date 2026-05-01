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
              { label: 'Drums & Supplies', param: 'consumable' },
              { label: 'Label Tape', param: 'label_tape' },
              { label: 'Paper', param: 'paper' }
          ]},
        { slug: 'canon', name: 'Canon', logo: '/assets/brands/canon.png',
          categories: [
              { label: 'Ink Cartridges', param: 'ink' },
              { label: 'Toner Cartridges', param: 'toner' },
              { label: 'Drums & Supplies', param: 'consumable' },
              { label: 'Paper', param: 'paper' }
          ]},
        { slug: 'epson', name: 'Epson', logo: '/assets/brands/epson.png',
          categories: [
              { label: 'Ink Cartridges', param: 'ink' },
              { label: 'Drums & Supplies', param: 'consumable' },
              { label: 'Paper', param: 'paper' }
          ]},
        { slug: 'hp', name: 'HP', logo: '/assets/brands/hp.png',
          categories: [
              { label: 'Ink Cartridges', param: 'ink' },
              { label: 'Toner Cartridges', param: 'toner' },
              { label: 'Drums & Supplies', param: 'consumable' },
              { label: 'Paper', param: 'paper' }
          ]},
        { slug: 'samsung', name: 'Samsung', logo: '/assets/brands/samsung.svg',
          categories: [
              { label: 'Toner Cartridges', param: 'toner' },
              { label: 'Drums & Supplies', param: 'consumable' }
          ]},
        { slug: 'lexmark', name: 'Lexmark', logo: '/assets/brands/lexmark.png',
          categories: [
              { label: 'Ink Cartridges', param: 'ink' },
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
              { label: 'Ink Cartridges', param: 'ink' },
              { label: 'Toner Cartridges', param: 'toner' },
              { label: 'Drums & Supplies', param: 'consumable' }
          ]},
        { slug: 'kyocera', name: 'Kyocera', logo: '/assets/brands/kyocera.svg',
          categories: [
              { label: 'Toner Cartridges', param: 'toner' },
              { label: 'Drums & Supplies', param: 'consumable' }
          ]},
        { slug: 'dymo', name: 'Dymo', logo: 'https://lmdlgldjgcanknsjrcxh.supabase.co/storage/v1/object/public/public-assets/logos/dymo.png',
          categories: [
              { label: 'Label Tape', param: 'label_tape' }
          ]}
    ];

    // ============================================
    // DATA — Ribbon Device Brands (fetched from API)
    // ============================================

    // ============================================
    // STATE
    // ============================================
    let brandsOpen = false;
    let ribbonsOpen = false;

    // Remember each panel's original DOM location so we can restore it when
    // leaving mobile / closing. On mobile we relocate the panel inside the
    // nav-menu so it scrolls with the (absolutely-positioned) menu instead of
    // being clipped behind it.
    const MOBILE_BREAKPOINT = 768;
    const isMobile = () => window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches;
    const panelOrigins = new WeakMap();
    function rememberOrigin(panel) {
        if (panel && !panelOrigins.has(panel)) {
            panelOrigins.set(panel, { parent: panel.parentNode, next: panel.nextSibling });
        }
    }
    function restoreOrigin(panel) {
        const origin = panelOrigins.get(panel);
        if (!origin || !origin.parent) return;
        if (panel.parentNode === origin.parent) return;
        origin.parent.insertBefore(panel, origin.next || null);
    }
    function moveIntoNav(panel, triggerBtn) {
        if (!panel || !triggerBtn) return;
        rememberOrigin(panel);
        const navItem = triggerBtn.closest('.nav-menu__item');
        const navMenu = triggerBtn.closest('.nav-menu');
        if (!navItem || !navMenu) return;
        if (panel.parentNode !== navMenu.parentNode && navItem.nextSibling !== panel) {
            navItem.parentNode.insertBefore(panel, navItem.nextSibling);
        }
    }
    rememberOrigin(brandsPanel);
    if (ribbonsPanel) rememberOrigin(ribbonsPanel);

    // ============================================
    // RENDER BRAND CARDS (Ink/Toner)
    // ============================================
    function renderBrands() {
        brandsCardsContainer.innerHTML = BRANDS.map(brand => {
            const brandUrl = `/brand/${Security.escapeAttr(brand.slug)}`;
            return `
            <div class="brands-mega__card">
                <div class="brands-mega__logo-wrap">
                    <a href="${brandUrl}" class="brands-mega__logo-link">
                        <img src="${Security.escapeAttr(brand.logo)}" alt="${Security.escapeAttr(brand.name)}" class="brands-mega__brand-logo brands-mega__brand-logo--${Security.escapeAttr(brand.slug)}">
                    </a>
                </div>
                <div class="brands-mega__card-links">
                    ${brand.categories.map(cat =>
                        `<a href="/html/shop?brand=${Security.escapeAttr(brand.slug)}&category=${Security.escapeAttr(cat.param)}" class="brands-mega__card-link">${Security.escapeHtml(cat.label)}</a>`
                    ).join('\n                    ')}
                </div>
            </div>`;
        }).join('');
    }

    // ============================================
    // RENDER RIBBON BRAND BUTTONS
    // ============================================
    function renderRibbons(brands) {
        if (!ribbonsGrid) return;
        ribbonsGrid.innerHTML = brands.map(b =>
            `<a href="/html/ribbons?printer_brand=${encodeURIComponent(b.value)}" class="ribbons-mega__brand-btn">${Security.escapeHtml(b.label)}</a>`
        ).join('');
    }

    async function loadAndRenderRibbons() {
        if (!ribbonsGrid) return;
        try {
            // Try new ribbon_brands table first, fall back to legacy API
            let brands = [];
            const res = await API.getRibbonBrandsList();
            const ribbonBrands = res?.data?.brands || [];
            if (ribbonBrands.length > 0) {
                brands = ribbonBrands.map(b => ({
                    value: b.slug || b.name.toLowerCase(),
                    label: b.name,
                }));
            } else {
                const legacyRes = await API.getRibbonBrands();
                const rawBrands = legacyRes?.data?.brands || [];
                const EXCLUDED_BRANDS = new Set(['universal']);
                brands = rawBrands
                    .filter(name => !EXCLUDED_BRANDS.has(name.toLowerCase()))
                    .map(name => ({ value: name.toLowerCase(), label: name }));
            }
            if (brands.length > 0) {
                renderRibbons(brands);
            }
        } catch (e) {
            // silently fail — grid stays empty
        }
    }

    // ============================================
    // OPEN / CLOSE — Brands
    // ============================================
    function openBrands() {
        closeRibbons();
        if (isMobile()) moveIntoNav(brandsPanel, brandsTrigger);
        else restoreOrigin(brandsPanel);
        brandsPanel.hidden = false;
        brandsTrigger.setAttribute('aria-expanded', 'true');
        brandsOpen = true;
    }

    function closeBrands() {
        brandsPanel.hidden = true;
        brandsTrigger.setAttribute('aria-expanded', 'false');
        brandsOpen = false;
        restoreOrigin(brandsPanel);
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
        if (isMobile()) moveIntoNav(ribbonsPanel, ribbonsTrigger);
        else restoreOrigin(ribbonsPanel);
        ribbonsPanel.hidden = false;
        ribbonsTrigger.setAttribute('aria-expanded', 'true');
        ribbonsOpen = true;
    }

    function closeRibbons() {
        if (!ribbonsPanel || !ribbonsTrigger) return;
        ribbonsPanel.hidden = true;
        ribbonsTrigger.setAttribute('aria-expanded', 'false');
        ribbonsOpen = false;
        restoreOrigin(ribbonsPanel);
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

    // Re-place panels on viewport resize so an open panel moves between
    // in-nav (mobile) and in-flow (desktop) positions correctly.
    window.addEventListener('resize', () => {
        if (brandsOpen) {
            if (isMobile()) moveIntoNav(brandsPanel, brandsTrigger);
            else restoreOrigin(brandsPanel);
        }
        if (ribbonsOpen && ribbonsPanel && ribbonsTrigger) {
            if (isMobile()) moveIntoNav(ribbonsPanel, ribbonsTrigger);
            else restoreOrigin(ribbonsPanel);
        }
    });

    // ============================================
    // INITIALIZE
    // ============================================
    renderBrands();
    loadAndRenderRibbons();

})();
