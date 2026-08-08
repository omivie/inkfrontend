/**
 * LANDING.JS
 * ==========
 * Landing page specific behaviors:
 * - Sticky header on scroll
 * - Ink-finder scroll target (window.InkFinderScroll)
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
    // INK FINDER SCROLL TARGET (ERR-137)
    // ============================================
    /**
     * Both entry points into the finder — the "Printer Models" nav link
     * (/?scroll=ink-finder) and the hero CTA (#ink-finder-heading) — used to
     * centre .ink-finder__wrapper in the FULL viewport. That is wrong on this
     * page, and this file is why: the observer above pins .site-header the
     * moment the hero clears the viewport, which is precisely what that scroll
     * causes. The desktop header is ~200px of contact + logo + nav rows and its
     * base rule is position:relative, so nothing reserves the space — the
     * "centred" card landed with "Find ink for your printer", the subtitle and
     * half its tab row buried behind the pinned chrome. Whether you saw the bug
     * was pure timing luck, which is why it looked intermittent.
     *
     * Centre the card in the space BELOW the pinned header instead. The header
     * height is MEASURED, never hardcoded and never taken from --header-h (a
     * mobile-only 56px token that says nothing about the desktop header).
     *
     * Lives here, not in main.js: the finder markup and this file ship on
     * exactly the same two pages (index.html + html/index.html), and keeping
     * the geometry next to the pin that necessitates it means neither can be
     * changed without seeing the other. main.js delegates via
     * window.InkFinderScroll and falls back to scrollIntoView if absent.
     */

    /**
     * Pure geometry — the document scrollTop that centres a box of
     * `wrapperHeight` in the viewport space left under a pinned header.
     * Kept free of DOM so it is directly executable in tests.
     */
    function inkFinderScrollTop(wrapperTop, wrapperHeight, viewportHeight, headerHeight) {
        const avail = Math.max(0, viewportHeight - headerHeight);
        // A card that (nearly) fills the free space top-aligns with a small gap,
        // so the title is the first thing visible rather than the last thing cut.
        const gap = wrapperHeight >= avail - 32 ? 16 : (avail - wrapperHeight) / 2;
        return Math.max(0, wrapperTop - headerHeight - gap);
    }

    /**
     * Measured height of the header if it CAN be pinned on this page, else 0.
     * When this runs on the landing page the header is still position:relative
     * and unclassed — .hero is what tells us the observer above will pin it.
     */
    function pinnedHeaderHeight() {
        const el = document.querySelector('.site-header');
        if (!el) return 0;
        const pos = window.getComputedStyle(el).position;
        const canPin = pos === 'sticky' || pos === 'fixed'
            || el.classList.contains('site-header--sticky')
            || !!document.querySelector('.hero');
        return canPin ? el.getBoundingClientRect().height : 0;
    }

    /**
     * The scrollTop at or past which the header is actually pinned: the hero's
     * bottom edge in document space (the observer flips at rootMargin -1px).
     * 0 when the header is pinned at every scroll position (mobile sticky) or
     * when there is no hero to clear.
     */
    function headerPinsFrom() {
        const el = document.querySelector('.site-header');
        if (el) {
            const pos = window.getComputedStyle(el).position;
            if (pos === 'sticky' || pos === 'fixed') return 0;
        }
        const hero = document.querySelector('.hero');
        if (!hero) return 0;
        return window.pageYOffset + hero.getBoundingClientRect().bottom;
    }

    /**
     * Current desired scrollTop for the finder card, or null if it isn't on the
     * page.
     *
     * Whether to reserve the header's height is itself a function of where we
     * land, so this picks the self-consistent answer of three:
     *
     *   bare      — the header isn't pinned that far up the page, so reserving
     *               would only shove the card down (tall viewports: the hero is
     *               still on screen at the centred position)
     *   reserved  — we land in pinned territory either way, so leave room
     *   edge      — neither is consistent: reserving lands us short of the pin
     *               threshold, where the header ISN'T pinned. Sit just below
     *               the threshold instead — no chrome, so the whole card fits
     *               (on a short viewport, reserving would crop its bottom for
     *               a header that never appears).
     *
     * Skipping the reservation only ever happens when the header is provably
     * not pinned at the destination, so the title can't end up hidden.
     */
    function inkFinderTarget() {
        const wrapper = document.querySelector('.ink-finder__wrapper');
        if (!wrapper) return null;
        const rect = wrapper.getBoundingClientRect();
        const wrapperTop = window.pageYOffset + rect.top;
        const vh = window.innerHeight;

        const bare = inkFinderScrollTop(wrapperTop, rect.height, vh, 0);
        const headerH = pinnedHeaderHeight();
        if (!headerH) return bare;

        const pinsFrom = headerPinsFrom();
        if (bare < pinsFrom) return bare;

        const reserved = inkFinderScrollTop(wrapperTop, rect.height, vh, headerH);
        if (reserved >= pinsFrom) return reserved;

        // 8px short of the threshold, not 1 — smooth-scroll lands on fractional
        // offsets and the observer flips at rootMargin -1px.
        const edge = Math.max(0, pinsFrom - 8);
        return wrapperTop - edge >= 0 ? edge : reserved;
    }

    /**
     * Re-measure once the scroll has settled and nudge if the target moved.
     * Two things shift it mid-flight: the header only becomes sticky partway
     * down, and the mobile header collapses (.site-header--scrolled shrinks the
     * document). Any user input, or landing far from where we aimed, cancels —
     * never yank a viewport the user has taken over.
     */
    function correctInkFinderScroll(aimedTop) {
        let done = false;
        const cancel = () => { done = true; };
        const inputs = ['wheel', 'touchstart', 'keydown'];
        inputs.forEach(type => window.addEventListener(type, cancel, { once: true, passive: true }));

        const settle = () => {
            if (done) return;
            done = true;
            inputs.forEach(type => window.removeEventListener(type, cancel));
            if (Math.abs(window.pageYOffset - aimedTop) > 200) return;
            const want = inkFinderTarget();
            if (want !== null && Math.abs(want - window.pageYOffset) > 8) {
                window.scrollTo({ top: want, behavior: 'auto' });
            }
        };

        if ('onscrollend' in window) {
            window.addEventListener('scrollend', settle, { once: true });
        }
        setTimeout(settle, 900); // Safari has no scrollend event
    }

    /** The one way to scroll to the finder. Both entry points call this. */
    function scrollToInkFinder(behavior) {
        const top = inkFinderTarget();
        if (top === null) {
            const heading = document.getElementById('ink-finder-heading');
            if (heading) heading.scrollIntoView({ behavior: behavior || 'smooth', block: 'start' });
            return;
        }
        window.scrollTo({ top: top, behavior: behavior || 'smooth' });
        correctInkFinderScroll(top);
    }

    window.InkFinderScroll = {
        scrollTo: scrollToInkFinder,
        target: inkFinderTarget,
        scrollTopFor: inkFinderScrollTop
    };

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
                // Aggregate review stars (traffic-conversion-jul2026 §1) — same
                // gate as products.js / shop-page.js: nothing at all when
                // review_count is 0, never an empty star row or "0 reviews".
                const ratingHtml = (p.average_rating && p.review_count > 0 && typeof Products !== 'undefined' && Products._miniStars)
                    ? `<div class="product-card__rating">${Products._miniStars(Math.round(parseFloat(p.average_rating)))} <span class="product-card__review-count">(${parseInt(p.review_count, 10)})</span></div>`
                    : '';
                return `
                    <a href="${Security.escapeAttr(cardHref)}" class="product-card" data-sku="${Security.escapeAttr(p.sku || '')}">
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

            // Bulk-price overlay — additive and request-free: the ladder rides
            // on the same payload this strip was rendered from.
            if (typeof Business !== 'undefined') {
                Business.ingest(products);
                Business.decorateCards(grid).catch(() => { /* featured strip is optional */ });
            }

            section.hidden = false;
        } catch (e) {
            // Featured products are optional
        }
    }

    loadFeaturedProducts();

})();
