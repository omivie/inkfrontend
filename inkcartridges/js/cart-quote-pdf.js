/**
 * "Download PDF quote" — the current cart as a branded quote (proforma) a
 * business buyer can send for internal approval.
 *
 * Backend: GET /api/cart/quote.pdf (CRO handoff, backend-docs/inbox/
 * cro-search-quote-points-FE-handoff-oct2026.md §2). It reads the same
 * figures as GET /api/cart, so the quote cannot disagree with checkout —
 * this module never computes or prints a price itself.
 *
 * A plain <a href> cannot send the cart's identity headers, so the PDF is
 * fetched with Authorization (signed in) or X-Guest-Session (guest) and saved
 * as a blob. The file name comes from Content-Disposition (exposed by the
 * backend's CORS config since this handoff).
 *
 * Mount: any element carrying `data-quote-pdf` (cart summary, checkout
 * summary). `data-quote-pdf="checkout"` also sends the shipping zone the
 * shopper has entered (region, 4-digit postcode, urban/rural) so the quote
 * shows that zone's exact shipping instead of the cart's estimate.
 *
 * Wording: "quote", never "official" or "invoice" — the document says it is
 * not a tax invoice; the tax invoice is emailed on payment.
 *
 * Every failure is shown to the shopper in the status line: an empty cart,
 * the 10-a-minute limit, a server message, or a network failure. Nothing
 * fails silently.
 */
'use strict';

const QuotePdf = {
    ENDPOINT: '/api/cart/quote.pdf',
    FALLBACK_NAME: 'inkcartridges-quote.pdf',
    MAX_FIELD: 80,
    HEADER_FIELDS: [
        { name: 'company', label: 'Company' },
        { name: 'attention', label: 'Attention' },
        { name: 'reference', label: 'Your reference / PO number' },
    ],

    /**
     * Query string for the quote. Header fields are trimmed and clamped to
     * the backend's 80-character limit (a longer value would be a 400 the
     * shopper cannot see the reason for). The shipping zone is sent only
     * when it is complete enough for the backend's checkout rules — a
     * partial zone would quote a shipping figure for somewhere else.
     * @param {{company?:string, attention?:string, reference?:string}} header
     * @param {{region?:string, postal_code?:string, delivery_type?:string}|null} zone
     * @returns {string} '' or '?a=b&…'
     */
    buildQuery(header, zone) {
        const params = new URLSearchParams();
        this.HEADER_FIELDS.forEach(({ name }) => {
            const v = header && typeof header[name] === 'string' ? header[name].trim().slice(0, this.MAX_FIELD) : '';
            if (v) params.set(name, v);
        });
        if (zone) {
            const region = typeof zone.region === 'string' ? zone.region.trim() : '';
            const postcode = typeof zone.postal_code === 'string' ? zone.postal_code.trim() : '';
            const type = zone.delivery_type === 'rural' || zone.delivery_type === 'urban' ? zone.delivery_type : '';
            if (region && /^\d{4}$/.test(postcode)) {
                params.set('region', region);
                params.set('postal_code', postcode);
                if (type) params.set('delivery_type', type);
            }
        }
        const qs = params.toString();
        return qs ? `?${qs}` : '';
    },

    /** File name from `Content-Disposition: attachment; filename="…"`, else the fallback. */
    fileName(disposition) {
        const m = /filename="([^"]+)"/.exec(disposition || '');
        const name = m ? m[1].replace(/[\\/]/g, '').trim() : '';
        return name || this.FALLBACK_NAME;
    },

    /**
     * Identity headers for the cart: the same rule as API.request — a
     * signed-in token wins; otherwise the guest session id.
     */
    async identityHeaders() {
        const headers = {};
        const token = (typeof API !== 'undefined' && API.getToken) ? await API.getToken() : null;
        if (token) headers.Authorization = `Bearer ${token}`;
        else {
            const guest = (typeof API !== 'undefined' && API.getGuestSessionId) ? API.getGuestSessionId() : null;
            if (guest) headers['X-Guest-Session'] = guest;
        }
        return headers;
    },

    /**
     * The message for a failed response. Measured shapes (2026-10-05):
     * `{ ok:false, error:{ code:'CART_EMPTY', message:'Your cart is empty. Add
     * items before downloading a quote.' } }` and VALIDATION_FAILED with
     * `error.details[].message`. The backend's own words win; a 429 and an
     * unreadable body get ours.
     */
    async failureMessage(res) {
        if (res.status === 429) return 'Too many quote downloads. Please try again in a minute.';
        let body = null;
        try { body = await res.json(); } catch (_) { /* non-JSON error body */ }
        const err = body && body.error && typeof body.error === 'object' ? body.error : null;
        const detail = err && Array.isArray(err.details) && err.details[0] && err.details[0].message;
        const msg = (typeof detail === 'string' && detail.trim())
            || (err && typeof err.message === 'string' && err.message.trim());
        if (msg) return msg;
        if (err && err.code === 'CART_EMPTY') return 'Your cart is empty. Add items to get a quote.';
        return `We couldn't create the quote (error ${res.status}). Please try again.`;
    },

    /**
     * Fetch and save the quote.
     * @returns {Promise<{ok:true, name:string}|{ok:false, status:number|null, message:string}>}
     */
    async download(header, zone) {
        const base = (typeof Config !== 'undefined' && Config.API_URL) || '';
        let res;
        try {
            res = await fetch(`${base}${this.ENDPOINT}${this.buildQuery(header, zone)}`, {
                headers: await this.identityHeaders(),
                credentials: 'omit',
            });
        } catch (e) {
            return { ok: false, status: null, message: "Couldn't reach the server. Check your connection and try again." };
        }
        if (!res.ok) return { ok: false, status: res.status, message: await this.failureMessage(res) };
        const name = this.fileName(res.headers.get('Content-Disposition'));
        this.saveBlob(await res.blob(), name);
        return { ok: true, name };
    },

    saveBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        // Revoking synchronously cancels the download in Safari.
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    },

    /** The shipping zone the shopper entered on checkout, read from the form. */
    readCheckoutZone() {
        const val = (id) => {
            const el = document.getElementById(id);
            return el && typeof el.value === 'string' ? el.value : '';
        };
        const type = document.querySelector('input[name="delivery_type"]:checked');
        return { region: val('region'), postal_code: val('postcode'), delivery_type: type ? type.value : '' };
    },

    markup(location) {
        const id = (name) => `quote-pdf-${location}-${name}`;
        const fields = this.HEADER_FIELDS.map(({ name, label }) => `
                <div class="form-group">
                    <label class="form-label" for="${id(name)}">${label}</label>
                    <input class="form-input" type="text" id="${id(name)}" name="${name}" maxlength="${this.MAX_FIELD}" autocomplete="${name === 'company' ? 'organization' : 'off'}">
                </div>`).join('');
        return `
            <button type="button" class="btn btn--outline btn--full-width quote-pdf__button" data-testid="quote-pdf-button"
                data-track="cta_click" data-track-cta="Download PDF quote" data-track-location="${location}_summary">Download PDF quote</button>
            <details class="quote-pdf__details">
                <summary>Add company or PO reference to the quote</summary>
                ${fields}
            </details>
            <p class="form-hint quote-pdf__status" role="status" aria-live="polite" data-testid="quote-pdf-status" hidden></p>`;
    },

    mount(el) {
        if (!el || el.dataset.quotePdfMounted) return;
        el.dataset.quotePdfMounted = '1';
        const location = el.getAttribute('data-quote-pdf') === 'checkout' ? 'checkout' : 'cart';
        el.innerHTML = this.markup(location);
        const btn = el.querySelector('.quote-pdf__button');
        const status = el.querySelector('.quote-pdf__status');
        btn.addEventListener('click', async () => {
            const header = {};
            this.HEADER_FIELDS.forEach(({ name }) => {
                const input = el.querySelector(`input[name="${name}"]`);
                header[name] = input ? input.value : '';
            });
            const zone = location === 'checkout' ? this.readCheckoutZone() : null;
            btn.disabled = true;
            btn.setAttribute('aria-busy', 'true');
            status.hidden = false;
            status.textContent = 'Preparing your quote…';
            const result = await this.download(header, zone);
            btn.disabled = false;
            btn.removeAttribute('aria-busy');
            status.dataset.state = result.ok ? 'ok' : 'error';
            status.textContent = result.ok
                ? `Quote downloaded (${result.name}). It is a quote, not a tax invoice.`
                : result.message;
            if (!result.ok && typeof DebugLog !== 'undefined') {
                DebugLog.warn('[QuotePdf] download failed', result.status, result.message);
            }
        });
    },

    init() {
        document.querySelectorAll('[data-quote-pdf]').forEach((el) => this.mount(el));
    },
};

if (typeof window !== 'undefined') {
    window.QuotePdf = QuotePdf;
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => QuotePdf.init());
    else QuotePdf.init();
}
