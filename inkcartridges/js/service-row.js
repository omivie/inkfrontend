/**
 * ServiceRow — the compact "why buy here" line beside Add to Cart (FE master
 * checklist, 2026-10-05, item 5).
 *
 * The ads now lead with service, not price, so the landing page has to show
 * it: speed, a person to call, paperwork, a safety net. Every fact comes from
 * GET /api/site/trust (via TrustStats.raw(), which already caches it) and,
 * on a PDP, the product's own `delivery_estimate`. NOTHING HERE IS A FACT OF
 * ITS OWN: a field that is absent drops its fact, it is never defaulted.
 *
 *   - speed      "Auckland metro orders by 2pm ship same day · most of NZ in
 *                1–3 business days". Scoped to Auckland metro always (Part 2
 *                invariant: never an unscoped "same-day dispatch"). The days
 *                half needs `delivery_estimate.label`, which only a product
 *                carries; /api/site/trust has no structured days (BF-100), so
 *                on a series page the speed fact is the cutoff half alone.
 *   - people     phone + email from `contact` (tel: and mailto: links).
 *   - paperwork  "GST tax invoice emailed with every order" ONLY while the
 *                API says we are GST-registered (`organization.gst_number`).
 *                The tax-invoice claim has no field of its own (BF-100); the
 *                owner chose to gate it on the GST number (2026-10-05).
 *   - returns    "30-day returns on unopened items" from `returns`.
 *
 * Afterpay is deliberately ABSENT: the checklist lists it, but no API field
 * says it is offered and nothing on the site offers it (owner, 2026-10-05).
 *
 * Fail-soft is LOUD: when the trust read comes back empty the row stays
 * hidden and DebugLog says why — an empty row is never shown as "no service".
 */
const ServiceRow = {
    /** "14:00" → "2pm", "09:30" → "9:30am". Anything else → null. */
    formatCutoff(hhmm) {
        const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
        if (!m) return null;
        const h = Number(m[1]);
        const min = Number(m[2]);
        if (h > 23 || min > 59) return null;
        const suffix = h >= 12 ? 'pm' : 'am';
        const h12 = h % 12 === 0 ? 12 : h % 12;
        return min ? `${h12}:${m[2]}${suffix}` : `${h12}${suffix}`;
    },

    _str(v) {
        return typeof v === 'string' && v.trim() ? v.trim() : null;
    },

    /**
     * The facts, in display order. Pure: no DOM, no fetch.
     * @param {Object} trust  `data` of GET /api/site/trust (or a product's trust_signals)
     * @param {{deliveryEstimate?: Object}} [opts]
     * @returns {Array<{key:string, text:string, links?:Array<{href:string,text:string}>}>}
     */
    facts(trust, opts) {
        const t = (trust && typeof trust === 'object') ? trust : {};
        const d = (opts && opts.deliveryEstimate && typeof opts.deliveryEstimate === 'object') ? opts.deliveryEstimate : {};
        const s = this._str;
        const out = [];

        const cutoff = s(d.dispatch_cutoff_human)
            || this.formatCutoff(d.dispatch_cutoff_nzt)
            || this.formatCutoff(t.shipping_promise && t.shipping_promise.dispatch_cutoff_nzt);
        const label = s(d.label);
        const days = label ? label.replace(/\s*NZ-wide\s*$/i, '') : null;
        if (cutoff) {
            out.push({
                key: 'speed',
                text: `Auckland metro orders by ${cutoff} ship same day` + (days ? ` · most of NZ in ${days}` : ''),
            });
        } else if (days) {
            out.push({ key: 'speed', text: `Delivered in ${days} NZ-wide` });
        }

        const c = (t.contact && typeof t.contact === 'object') ? t.contact : {};
        const phone = s(c.phone_display);
        const tel = s(c.phone_tel_href);
        const email = s(c.support_email);
        if (phone || email) {
            const links = [];
            if (phone) links.push({ href: tel ? `tel:${tel.replace(/^tel:/i, '')}` : null, text: phone });
            if (email) links.push({ href: `mailto:${email}`, text: email });
            const text = phone && email ? `Questions? Call ${phone} or email ${email}`
                : phone ? `Questions? Call ${phone}` : `Questions? Email ${email}`;
            out.push({ key: 'people', text, links });
        }

        if (s(t.organization && t.organization.gst_number)) {
            out.push({ key: 'paperwork', text: 'GST tax invoice emailed with every order' });
        }

        const r = (t.returns && typeof t.returns === 'object') ? t.returns : {};
        const rDays = Number.isInteger(r.change_of_mind_days) && r.change_of_mind_days > 0 ? r.change_of_mind_days : null;
        if (rDays) {
            out.push({ key: 'returns', text: `${rDays}-day returns on unopened items` });
        } else {
            const cp = s(t.compatibility_promise && t.compatibility_promise.label);
            if (cp) out.push({ key: 'returns', text: cp.replace(/^Not sure it fits\?\s*/i, '') });
        }
        return out;
    },

    /** One fact as HTML; link text replaces its own span inside the sentence. */
    _factHtml(f) {
        const esc = (v) => Security.escapeHtml(String(v));
        let html = esc(f.text);
        (f.links || []).forEach((l) => {
            if (!l.href) return;
            const a = `<a href="${Security.escapeAttr(l.href)}" class="service-row__link">${esc(l.text)}</a>`;
            html = html.replace(esc(l.text), a);
        });
        return `<li class="service-row__item service-row__item--${esc(f.key)}">${html}</li>`;
    },

    render(el, facts) {
        if (!el) return false;
        if (!facts.length) {
            el.hidden = true;
            el.innerHTML = '';
            return false;
        }
        el.innerHTML = `<ul class="service-row__list">${facts.map((f) => this._factHtml(f)).join('')}</ul>`;
        el.hidden = false;
        return true;
    },

    /**
     * Fill `el` from /api/site/trust. Resolves `{shown, facts, reason}`.
     * @param {HTMLElement} el
     * @param {{deliveryEstimate?: Object}} [opts]
     */
    async mount(el, opts) {
        if (!el || typeof TrustStats === 'undefined') {
            return { shown: false, facts: [], reason: el ? 'no-trust-module' : 'no-element' };
        }
        const trust = await TrustStats.raw();
        const facts = this.facts(trust, opts);
        if (!trust || !Object.keys(trust).length) {
            if (typeof DebugLog !== 'undefined') {
                DebugLog.warn('ServiceRow: GET /api/site/trust returned nothing — service row ' +
                    (facts.length ? 'shows product-only facts' : 'hidden'));
            }
        }
        const shown = this.render(el, facts);
        return { shown, facts, reason: shown ? 'ok' : 'no-facts' };
    },
};

if (typeof window !== 'undefined') window.ServiceRow = ServiceRow;
if (typeof module !== 'undefined' && module.exports) {
    module.exports = ServiceRow;
}
