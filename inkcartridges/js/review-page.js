/**
 * REVIEW-PAGE.JS — /review?token=… (conversion handoff 2026-09-23 §6a.2)
 * =====================================================================
 * 88% of orders are guest checkouts and `reviews.user_id` is NOT NULL, so most
 * customers cannot leave a review; there are 4 on the whole site and therefore
 * no stars in Search or Shopping. The backend half is a signed per-order link
 * (same token scheme as quick-rating) sent from `shipped_at`; this is the page
 * that link opens.
 *
 * DARK until Config.DARK_FEATURES.guestReviews — with it off the page says the
 * link is not active yet and makes no request. Contract proposed to the
 * backend (backend-docs outbox, 2026-09-27):
 *   GET  /api/reviews/by-token/:token
 *        → { ok, data: { order_number, items: [{ sku, name, image_url, reviewed }] } }
 *   POST /api/reviews/by-token  { token, sku, rating (1-5), title, body } → { ok }
 */
'use strict';

const ReviewPage = {
    MAX_TITLE: 120,
    MAX_BODY: 2000,

    /** Validate one form's values. Pure. Returns an error string or null. */
    validate({ rating, title, body }) {
        const r = Number(rating);
        if (!Number.isInteger(r) || r < 1 || r > 5) return 'Please choose a star rating from 1 to 5.';
        if (String(title || '').length > this.MAX_TITLE) return `Please keep the title under ${this.MAX_TITLE} characters.`;
        if (!String(body || '').trim()) return 'Please write a sentence or two about the cartridge.';
        if (String(body).length > this.MAX_BODY) return `Please keep the review under ${this.MAX_BODY} characters.`;
        return null;
    },

    message(el, text) {
        el.innerHTML = `<p class="value-page__detail">${Security.escapeHtml(text)}</p>`;
    },

    formHtml(item) {
        const esc = Security.escapeHtml;
        const id = `r-${String(item.sku).replace(/[^A-Za-z0-9_-]/g, '')}`;
        const stars = [5, 4, 3, 2, 1].map(n =>
            `<label class="review-page__star"><input type="radio" name="${id}-rating" value="${n}"> ${n} star${n === 1 ? '' : 's'}</label>`).join('');
        return `<form class="review-page__form" data-sku="${Security.escapeAttr(item.sku)}" novalidate>
            <h2 class="review-page__product">${esc(item.name || item.sku)}</h2>
            <fieldset class="review-page__stars"><legend>Your rating</legend>${stars}</fieldset>
            <label class="review-page__label" for="${id}-title">Title (optional)</label>
            <input class="review-page__input" id="${id}-title" name="title" maxlength="${this.MAX_TITLE}">
            <label class="review-page__label" for="${id}-body">Your review</label>
            <textarea class="review-page__input review-page__textarea" id="${id}-body" name="body" rows="4" maxlength="${this.MAX_BODY}"></textarea>
            <p class="review-page__error" role="alert" hidden></p>
            <button type="submit" class="btn btn--primary review-page__submit">Submit review</button>
        </form>`;
    },

    bind(form, token) {
        const err = form.querySelector('.review-page__error');
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const checked = form.querySelector('input[type="radio"]:checked');
            const values = {
                rating: checked ? Number(checked.value) : null,
                title: form.querySelector('[name="title"]').value.trim(),
                body: form.querySelector('[name="body"]').value.trim(),
            };
            const problem = this.validate(values);
            if (problem) { err.textContent = problem; err.hidden = false; return; }
            err.hidden = true;
            const btn = form.querySelector('.review-page__submit');
            btn.disabled = true;
            try {
                const resp = await API.submitReviewByToken({ token, sku: form.dataset.sku, ...values });
                if (resp && resp.ok) {
                    form.innerHTML = '<p class="value-page__lead">Thank you — your review has been sent.</p>';
                    return;
                }
                err.textContent = API.extractErrorMessage(resp, 'We could not save your review. Please try again.');
            } catch (_) {
                err.textContent = 'We could not save your review. Please try again.';
            }
            err.hidden = false;
            btn.disabled = false;
        });
    },

    async init() {
        const body = document.getElementById('review-page-body');
        if (!body) return;
        const on = typeof Config !== 'undefined' && Config.DARK_FEATURES && Config.DARK_FEATURES.guestReviews === true;
        if (!on) { this.message(body, "This review link isn't active yet. Thank you for your order — we'll email you when reviews open."); return; }
        const token = new URLSearchParams(window.location.search).get('token');
        if (!token) { this.message(body, 'This page needs the review link from your email.'); return; }
        let data = null;
        try {
            const resp = await API.getReviewToken(token);
            data = resp && resp.ok ? resp.data : null;
        } catch (_) { data = null; }
        const items = data && Array.isArray(data.items) ? data.items.filter(i => i && i.sku && !i.reviewed) : null;
        if (!items) { this.message(body, 'This review link has expired or could not be read. Please call 027 474 0115 and we will help.'); return; }
        if (!items.length) { this.message(body, "You've reviewed everything in this order. Thank you!"); return; }
        body.innerHTML = items.map(i => this.formHtml(i)).join('');
        body.querySelectorAll('.review-page__form').forEach(f => this.bind(f, token));
    },
};

if (typeof module !== 'undefined' && module.exports) module.exports = { ReviewPage };
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    window.ReviewPage = ReviewPage;
    document.addEventListener('DOMContentLoaded', () => { ReviewPage.init(); });
}
