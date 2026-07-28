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
    // TRUST STATS  (traffic-conversion-jul2026 §2)
    // ============================================
    // Sitewide social proof under the hero trust bar: "47+ customers served".
    //
    // Counts are floored to honest bands server-side, hence the trailing "+".
    // A null count means NOT COMPUTED, not zero — its tile is dropped rather
    // than painted as "0+", and when all three are null the section stays
    // hidden and the homepage is byte-identical to before. That IS the current
    // production state (the backend's nightly sweep has never run), so this
    // ships invisible and switches itself on later with no deploy.
    //
    // Fail-open: TrustStats.raw() resolves to {} on any error.

    async function loadTrustStats() {
        const section = document.getElementById('trust-stats');
        const list = document.getElementById('trust-stats-list');
        if (!section || !list || typeof TrustStats === 'undefined') return;

        const lines = TrustStats.lines(await TrustStats.stats());
        if (!lines.length) {
            section.hidden = true;
            return;
        }
        list.innerHTML = lines.map((row) => `
            <li class="trust-stats__item" data-stat="${Security.escapeAttr(row.key)}">
                <span class="trust-stats__value">${Security.escapeHtml(row.value)}</span>
                <span class="trust-stats__label">${Security.escapeHtml(row.label)}</span>
            </li>`).join('');
        section.hidden = false;
    }

    loadTrustStats();

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
                // Aggregate review stars (traffic-conversion-jul2026 §1) — same
                // gate as products.js / shop-page.js: nothing at all when
                // review_count is 0, never an empty star row or "0 reviews".
                const ratingHtml = (p.average_rating && p.review_count > 0 && typeof Products !== 'undefined' && Products._miniStars)
                    ? `<div class="product-card__rating">${Products._miniStars(Math.round(parseFloat(p.average_rating)))} <span class="product-card__review-count">(${parseInt(p.review_count, 10)})</span></div>`
                    : '';
                return `
                    <a href="${Security.escapeAttr(cardHref)}" class="product-card">
                        <div class="product-card__image-wrapper">${imageHtml}</div>
                        <div class="product-card__info">
                            <span class="product-card__brand">${Security.escapeHtml(brandName)}</span>
                            <h3 class="product-card__name">${Security.escapeHtml(name)}</h3>
                            ${ratingHtml}
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
