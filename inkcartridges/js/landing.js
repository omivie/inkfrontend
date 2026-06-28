/**
 * LANDING.JS
 * ==========
 * Landing page specific behaviors:
 * - Sticky header on scroll
 * - FAQ accordion animation
 * - Newsletter form handling
 */

'use strict';

(function() {

    // ============================================
    // STICKY HEADER
    // ============================================

    const header = document.querySelector('.site-header');
    const hero = document.querySelector('.hero');

    if (header && hero) {
        const observer = new IntersectionObserver(
            ([entry]) => {
                header.classList.toggle('site-header--sticky', !entry.isIntersecting);
            },
            { threshold: 0, rootMargin: '-1px 0px 0px 0px' }
        );
        observer.observe(hero);
    }

    // ============================================
    // FAQ ACCORDION ANIMATION
    // ============================================

    const faqItems = document.querySelectorAll('.faq-section details');

    faqItems.forEach(details => {
        const summary = details.querySelector('summary');
        const content = details.querySelector('.faq-answer');
        if (!summary || !content) return;

        let animating = false;

        summary.addEventListener('click', (e) => {
            e.preventDefault();
            // Ignore clicks mid-animation so rapid toggling can't desync state.
            if (animating) return;
            animating = true;

            if (details.open) {
                // Closing: pin the current height, then collapse to 0.
                content.style.maxHeight = content.scrollHeight + 'px';
                content.style.opacity = '1';
                void content.offsetHeight; // force reflow so the start value commits
                content.style.maxHeight = '0px';
                content.style.opacity = '0';
                content.addEventListener('transitionend', function handler(ev) {
                    if (ev.propertyName !== 'max-height') return;
                    details.open = false;
                    content.style.maxHeight = '';
                    content.style.opacity = '';
                    content.removeEventListener('transitionend', handler);
                    animating = false;
                });
            } else {
                // Opening: render collapsed, then expand to the measured height.
                details.open = true;
                content.style.maxHeight = '0px';
                content.style.opacity = '0';
                void content.offsetHeight; // force reflow so 0px is the start frame
                content.style.maxHeight = content.scrollHeight + 'px';
                content.style.opacity = '1';
                content.addEventListener('transitionend', function handler(ev) {
                    if (ev.propertyName !== 'max-height') return;
                    // Release the fixed height so the panel stays responsive.
                    content.style.maxHeight = 'none';
                    content.removeEventListener('transitionend', handler);
                    animating = false;
                });
            }
        });
    });

    // ============================================
    // NEWSLETTER FORM
    // ============================================
    // The signup now lives in the shared footer (footer.js renders + binds it
    // on every page). The single implementation is window.NewsletterForm.bind
    // (idempotent), so we just delegate here for any landing-specific form.
    // footer.js is defer-loaded before landing.js, so the global is ready.
    if (window.NewsletterForm) {
        document.querySelectorAll('.newsletter__form').forEach((f) => {
            window.NewsletterForm.bind(f, 'landing');
        });
    }

    // ============================================
    // FEATURED PRODUCTS
    // ============================================

    async function loadFeaturedProducts() {
        if (typeof API === 'undefined' || !API.smartSearch) return;

        const grid = document.getElementById('featured-products-grid');
        const section = document.getElementById('featured-products');
        if (!grid || !section) return;

        try {
            const response = await API.smartSearch('ink cartridge', 8);
            if (!response.ok || !response.data?.products || response.data.products.length === 0) return;

            const products = response.data.products;

            grid.innerHTML = products.map((p, i) => {
                const name = p.name || '';
                const price = parseFloat(p.retail_price || 0);
                const brandName = p.brand?.name || (typeof p.brand === 'string' ? p.brand : '') || '';
                const imageHtml = typeof Products !== 'undefined' && Products.getProductImageHTML
                    ? Products.getProductImageHTML(p, { priority: i < 4 })
                    : `<img src="${Security.escapeAttr(typeof storageUrl === 'function' ? storageUrl(p.image_url) : (p.image_url || '/assets/images/placeholder-product.svg'))}" alt="${Security.escapeAttr(name)}" data-fallback="placeholder">`;
                // Prefer backend-supplied canonical_url. Reduce absolute URLs to a path.
                const cardHref = (() => {
                    if (p.canonical_url) {
                        try { return new URL(p.canonical_url).pathname; }
                        catch (_) { return p.canonical_url; }
                    }
                    return p.slug && p.sku
                        ? `/products/${encodeURIComponent(p.slug)}/${encodeURIComponent(p.sku)}`
                        : `/p/${encodeURIComponent(p.sku || '')}`;
                })();
                // source-chip-removal-may2026.md — featured-grid cards no
                // longer ship a per-card COMPATIBLE/GENUINE chip. Source is
                // already conveyed by the product name on the card.
                return `
                    <a href="${Security.escapeAttr(cardHref)}" class="product-card">
                        <div class="product-card__image-wrapper">${imageHtml}</div>
                        <div class="product-card__info">
                            <span class="product-card__brand">${Security.escapeHtml(brandName)}</span>
                            <h3 class="product-card__name">${Security.escapeHtml(name)}</h3>
                            <span class="product-card__price">${formatPrice(price)}</span>
                        </div>
                    </a>`;
            }).join('');

            // Bind image error fallbacks
            if (typeof Products !== 'undefined' && Products.bindImageFallbacks) {
                Products.bindImageFallbacks(grid);
            }

            section.hidden = false;
        } catch (e) {
            // Featured products are optional
        }
    }

    loadFeaturedProducts();

})();
