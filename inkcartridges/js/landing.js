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

        summary.addEventListener('click', (e) => {
            e.preventDefault();

            if (details.open) {
                // Closing
                content.style.maxHeight = content.scrollHeight + 'px';
                requestAnimationFrame(() => {
                    content.style.maxHeight = '0';
                    content.style.opacity = '0';
                });
                content.addEventListener('transitionend', function handler() {
                    details.open = false;
                    content.removeEventListener('transitionend', handler);
                }, { once: true });
            } else {
                // Opening
                details.open = true;
                const height = content.scrollHeight;
                content.style.maxHeight = '0';
                content.style.opacity = '0';
                requestAnimationFrame(() => {
                    content.style.maxHeight = height + 'px';
                    content.style.opacity = '1';
                });
            }
        });
    });

    // ============================================
    // NEWSLETTER FORM
    // ============================================

    const newsletterForm = document.querySelector('.newsletter__form');

    if (newsletterForm) {
        // Init Turnstile if configured
        let newsletterTurnstileToken = null;
        const siteKey = typeof Config !== 'undefined' && Config.TURNSTILE_SITE_KEY;
        if (siteKey && typeof turnstile !== 'undefined') {
            turnstile.render('#newsletter-turnstile', {
                sitekey: siteKey,
                callback: (token) => { newsletterTurnstileToken = token; },
                'expired-callback': () => { newsletterTurnstileToken = null; }
            });
        }

        newsletterForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            const emailInput = newsletterForm.querySelector('input[type="email"]');
            const submitBtn = newsletterForm.querySelector('button[type="submit"]');
            const email = emailInput.value.trim();

            if (!email) return;

            const originalText = submitBtn.textContent;
            submitBtn.textContent = 'Subscribing...';
            submitBtn.disabled = true;

            try {
                if (typeof API !== 'undefined' && API.subscribe) {
                    const payload = { email: email, source: 'landing' };
                    if (newsletterTurnstileToken) payload.turnstile_token = newsletterTurnstileToken;
                    const res = await API.subscribe(payload);

                    if (res && res.ok === false) {
                        // Validation: per-field message wins. Server hiccup (500/INTERNAL_ERROR):
                        // run through API.mapError so the customer sees a friendly message AND
                        // a short reference id we can grep against Render's stderr.
                        let fieldMsg;
                        if (Array.isArray(res.details) && res.details[0]?.message) {
                            fieldMsg = res.details[0].message;
                        } else if (res.code === 'INTERNAL_ERROR' || (typeof res.status === 'number' && res.status >= 500)) {
                            fieldMsg = (typeof API.mapError === 'function')
                                ? API.mapError(res).message
                                : 'Server hiccup — please try again.';
                        } else {
                            fieldMsg = res.error || 'Could not subscribe. Please try again.';
                        }
                        if (res.request_id) {
                            // Always log to console so dev tools / customer screenshots include
                            // the full request_id, even if the toast only shows a short prefix.
                            console.warn('[newsletter] subscribe failed', { code: res.code, request_id: res.request_id });
                        }
                        if (typeof showToast === 'function') showToast(fieldMsg, 'error');
                        if (siteKey && typeof turnstile !== 'undefined') turnstile.reset('#newsletter-turnstile');
                        newsletterTurnstileToken = null;
                        submitBtn.textContent = originalText;
                        submitBtn.disabled = false;
                        return;
                    }
                }

                if (typeof showToast === 'function') {
                    showToast('Thank you for subscribing!', 'success');
                }
                emailInput.value = '';
                newsletterTurnstileToken = null;
                if (siteKey && typeof turnstile !== 'undefined') turnstile.reset('#newsletter-turnstile');
            } catch (err) {
                if (err && err.request_id) {
                    console.warn('[newsletter] subscribe threw', { code: err.code, status: err.status, request_id: err.request_id });
                }
                const mapped = (typeof API !== 'undefined' && typeof API.mapError === 'function')
                    ? API.mapError(err) : null;
                const msg = (mapped && mapped.message)
                    || err.message
                    || 'Could not subscribe. Please try again.';
                if (typeof showToast === 'function') {
                    if (msg.includes('temporarily unavailable')) {
                        showToast('Service temporarily unavailable. Please try again later.', 'error');
                    } else {
                        showToast(msg, 'error');
                    }
                }
                if (siteKey && typeof turnstile !== 'undefined') turnstile.reset('#newsletter-turnstile');
                newsletterTurnstileToken = null;
            }

            submitBtn.textContent = originalText;
            submitBtn.disabled = false;
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
