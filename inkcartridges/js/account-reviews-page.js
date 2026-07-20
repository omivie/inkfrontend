/**
 * ACCOUNT-REVIEWS-PAGE.JS
 * =======================
 * Controller for /account/reviews — the customer's "My Reviews" page and the
 * fallback landing target for a one-click email rating when the product has no
 * slug (review-flywheel FE handoff, Jul 2026, §1.1).
 *
 * Responsibilities:
 *   • Auth-gate (guests → /account/login?redirect=…), mirroring the other
 *     dedicated account controllers (favourites-page.js).
 *   • Welcome a customer back from a one-click rating: ?rated=N (1–5) → success
 *     toast, then strip the param so a refresh/back doesn't re-toast.
 *   • List the signed-in user's own reviews via GET /api/user/reviews (all
 *     statuses), including one-click star ratings. Empty state when none.
 *   • Fail LOUD, not soft: a load error shows an error panel with a retry, never
 *     a silent empty list read as a healthy "no reviews" (project rule:
 *     fail-soft-must-be-loud). The sidebar/auth is owned by account.js; this file
 *     never touches dashboard DOM.
 */

(function () {
    'use strict';

    const STAR_SVG = (filled) =>
        `<svg width="18" height="18" viewBox="0 0 24 24" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;

    function renderStars(rating) {
        const full = Math.round(Number(rating) || 0);
        return Array.from({ length: 5 }, (_, i) => STAR_SVG(i < full)).join('');
    }

    // Build a product link only when the review row carries enough identity.
    // Prefer the backend-owned canonical_url when present (the canonical-URL
    // contract — polished-slugs §4); otherwise construct /products/:slug/:sku
    // (or a sku-only path the backend redirects to canonical), else no link.
    function productHref(review) {
        if (review.canonical_url) return review.canonical_url;
        const sku = review.product_sku || review.sku;
        const slug = review.product_slug || review.slug;
        if (slug && sku) return `/products/${encodeURIComponent(slug)}/${encodeURIComponent(sku)}`;
        if (sku) return `/products/${encodeURIComponent(slug || 'product')}/${encodeURIComponent(sku)}`;
        return null;
    }

    function productName(review) {
        return review.product_name || review.product_title || review.name || 'Your reviewed product';
    }

    function formatDate(iso) {
        if (!iso) return '';
        const d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        return d.toLocaleDateString('en-NZ', { year: 'numeric', month: 'short', day: 'numeric' });
    }

    function reviewCard(review) {
        const rating = parseInt(review.rating, 10) || 0;
        const name = productName(review);
        const href = productHref(review);
        const nameHtml = href
            ? `<a class="account-review-card__product" href="${Security.escapeAttr(href)}">${Security.escapeHtml(name)}</a>`
            : `<span class="account-review-card__product">${Security.escapeHtml(name)}</span>`;
        const status = (review.status || 'approved').toLowerCase();
        const statusBadge = status === 'approved'
            ? ''
            : `<span class="account-review-card__status account-review-card__status--${Security.escapeAttr(status)}">${status === 'pending' ? 'Awaiting approval' : Security.escapeHtml(status)}</span>`;
        const date = formatDate(review.created_at || review.updated_at);
        const title = review.title ? `<h3 class="account-review-card__title">${Security.escapeHtml(review.title)}</h3>` : '';
        const body = review.body ? `<p class="account-review-card__body">${Security.escapeHtml(review.body)}</p>` : '';
        // A one-click rating has no written text — say so plainly rather than
        // leaving an empty card that reads like missing data.
        const ratingOnly = (!review.title && !review.body)
            ? '<p class="account-review-card__rating-only">Quick star rating</p>'
            : '';
        return `
            <article class="account-review-card">
                <div class="account-review-card__head">
                    ${nameHtml}
                    ${statusBadge}
                </div>
                <div class="account-review-card__stars" aria-label="Rated ${rating} out of 5">${renderStars(rating)}</div>
                ${title}
                ${body}
                ${ratingOnly}
                ${date ? `<p class="account-review-card__date">${Security.escapeHtml(date)}</p>` : ''}
            </article>
        `;
    }

    function normalizeList(resp) {
        // Tolerate the documented bare-array body AND an envelope-wrapped one.
        if (Array.isArray(resp)) return resp;
        if (resp && Array.isArray(resp.data)) return resp.data;
        if (resp && resp.data && Array.isArray(resp.data.reviews)) return resp.data.reviews;
        if (resp && Array.isArray(resp.reviews)) return resp.reviews;
        return null; // null = couldn't read → error state (NOT an empty success)
    }

    function showError(listEl, emptyEl, message) {
        if (emptyEl) emptyEl.hidden = true;
        listEl.innerHTML = `
            <div class="account-error" role="alert">
                <p>${Security.escapeHtml(message || 'We couldn’t load your reviews just now.')}</p>
                <button type="button" class="btn btn--secondary" id="reviews-retry">Try again</button>
            </div>
        `;
        const retry = document.getElementById('reviews-retry');
        if (retry) retry.addEventListener('click', () => loadReviews());
    }

    async function loadReviews() {
        const listEl = document.getElementById('reviews-list');
        const emptyEl = document.getElementById('reviews-empty');
        if (!listEl) return;

        listEl.setAttribute('aria-busy', 'true');
        listEl.innerHTML = '<div class="account-loading"><span class="skeleton" style="display:block;width:100%;height:96px;border-radius:12px;"></span></div>';

        let resp;
        try {
            resp = await API.getUserReviews();
        } catch (err) {
            listEl.removeAttribute('aria-busy');
            const mapped = (typeof API.mapError === 'function') ? API.mapError(err) : null;
            showError(listEl, emptyEl, mapped && mapped.message);
            return;
        }
        listEl.removeAttribute('aria-busy');

        // Envelope-level failure (e.g. { ok:false, error }) — fail loud.
        if (resp && resp.ok === false) {
            const mapped = (typeof API.mapError === 'function') ? API.mapError(resp) : null;
            showError(listEl, emptyEl, (mapped && mapped.message) || resp.error);
            return;
        }

        const reviews = normalizeList(resp);
        if (reviews === null) {
            showError(listEl, emptyEl);
            return;
        }

        if (reviews.length === 0) {
            listEl.innerHTML = '';
            if (emptyEl) emptyEl.hidden = false;
            return;
        }

        if (emptyEl) emptyEl.hidden = true;
        // Newest first when timestamps are present.
        reviews.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
        listEl.innerHTML = reviews.map(reviewCard).join('');
    }

    // ?rated=N welcome (fallback landing target). Toast, then strip the param.
    function handleRatedParam() {
        const params = new URLSearchParams(window.location.search);
        const rated = parseInt(params.get('rated'), 10);
        if (!(rated >= 1 && rated <= 5)) return;
        if (typeof showToast === 'function') {
            showToast(`Thanks for your ${rated}-star rating!`, 'success', 6000);
        }
        try {
            const url = new URL(window.location.href);
            url.searchParams.delete('rated');
            window.history.replaceState({}, '', url.pathname + url.search + url.hash);
        } catch (_) { /* best-effort */ }
    }

    document.addEventListener('DOMContentLoaded', async () => {
        // Wait for Auth to initialize (mirrors favourites-page.js).
        if (typeof Auth !== 'undefined' && !Auth.initialized) {
            const maxWait = 3000;
            let waited = 0;
            while (!Auth.initialized && waited < maxWait) {
                await new Promise((r) => setTimeout(r, 50));
                waited += 50;
            }
        }

        if (typeof Auth === 'undefined' || !Auth.isAuthenticated()) {
            window.location.href = '/account/login?redirect=' + encodeURIComponent(window.location.pathname);
            return;
        }

        const accountEl = document.querySelector('.account-page');
        if (accountEl) accountEl.classList.add('auth-ready');

        handleRatedParam();
        await loadReviews();
    });
})();
