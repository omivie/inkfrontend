/**
 * VALUE-PAGES.JS — /rewards, /bulk-pricing, /value-packs
 * ======================================================
 * The three explainer pages from the conversion handoff (2026-09-23 §4.3),
 * linked from the value strip and, later, from the Ads account as sitelinks.
 *
 * EVERY FACT IS RENDERED FROM `GET /api/site/value-props` (ValueProps, in
 * utils.js). The HTML carries headings and a loading line and no numbers, so
 * the day the programme changes these pages change with it. If the read fails
 * the page says so in words — it never falls back to remembered terms.
 *
 * Copy rules (handoff §4, pinned by tests/conversion-fixes-sep2026.test.js):
 *   - no "save up to", "lowest", "best", "cheapest";
 *   - `max_discount_percent` is never printed;
 *   - packs are never said to be ALWAYS cheaper: the pack's own page shows a
 *     saving only when the backend computed one.
 */
'use strict';

const ValuePages = {
    /** Plain money for headline figures: "$100", "$1", "$0.50". */
    money(n) {
        const v = Number(n);
        if (!Number.isFinite(v)) return '';
        return Number.isInteger(v) ? `$${v}` : `$${v.toFixed(2)}`;
    },

    unavailable(el) {
        el.innerHTML = '<p class="value-page__error">We couldn\'t load the current details just now. '
            + 'Please refresh the page, or call <a href="tel:+64274740115">027 474 0115</a>.</p>';
    },

    /** Loyalty facts as a list. Pure: returns HTML for a normalised loyalty object. */
    rewardsHtml(lo) {
        const esc = Security.escapeHtml;
        const perDollarOff = lo.pointsPerDollarOff;
        const items = [
            `<li><strong>Earn:</strong> ${esc(String(lo.pointsPerDollar))} point${lo.pointsPerDollar === 1 ? '' : 's'} for every $1 you spend on goods. Shipping doesn't earn points.</li>`,
            `<li><strong>Spend:</strong> ${esc(String(perDollarOff))} points = $1 off a future order, applied at checkout.</li>`,
        ];
        if (lo.welcomeBonus) {
            items.push(`<li><strong>Welcome:</strong> new accounts get ${esc(lo.welcomeBonus.toLocaleString('en-NZ'))} points.</li>`);
        }
        items.push('<li><strong>Ordered as a guest?</strong> Create a free account with the same email and the points from those orders are added when you first sign in.</li>');
        return (lo.headline ? `<p class="value-page__lead">${esc(lo.headline)}</p>` : '')
            + `<ul class="value-page__list">${items.join('')}</ul>`
            + (lo.detail ? `<p class="value-page__detail">${esc(lo.detail)}</p>` : '');
    },

    /**
     * The tier ladder as a table: one row per price band, listing that band's
     * own breaks in order ("3+ 4% off · 4+ 5% off · 7+ 8% off"). Not a grid
     * of quantity columns: a band with no rung at 5 still gives its 4+ rate
     * at 5, and a "—" in that cell would read as "no discount". Pure;
     * `tiers` is value-props `volume_pricing.tiers`.
     */
    tiersTableHtml(tiers) {
        const esc = Security.escapeHtml;
        const rows = (Array.isArray(tiers) ? tiers : []).filter(t =>
            t && Number.isFinite(Number(t.min_price)) && Number.isFinite(Number(t.min_quantity)) && Number.isFinite(Number(t.discount_percent)));
        if (!rows.length) return '';
        const bandKey = (t) => `${Number(t.min_price)}|${t.max_price == null ? '' : Number(t.max_price)}`;
        const bands = [];
        const byBand = new Map();
        for (const t of rows) {
            const k = bandKey(t);
            if (!byBand.has(k)) { byBand.set(k, []); bands.push(t); }
            byBand.get(k).push(t);
        }
        bands.sort((a, b) => Number(a.min_price) - Number(b.min_price));
        const bandLabel = (t) => (t.max_price == null
            ? `${this.money(t.min_price)} and over`
            : `${this.money(t.min_price)} – ${this.money(t.max_price)}`);
        const pct = (p) => `${Number.isInteger(p) ? p : p.toFixed(1)}%`;
        const body = bands.map(b => {
            const breaks = byBand.get(bandKey(b))
                .slice()
                .sort((x, y) => Number(x.min_quantity) - Number(y.min_quantity))
                .map(t => `${Number(t.min_quantity)}+ ${pct(Number(t.discount_percent))} off`)
                .join(' · ');
            return `<tr><th scope="row">${esc(bandLabel(b))}</th><td>${esc(breaks)}</td></tr>`;
        }).join('');
        return '<table class="value-page__table"><caption>Price breaks when you buy more of the same cartridge</caption>'
            + '<thead><tr><th scope="col">Price of one cartridge</th><th scope="col">Buy this many, pay this much less each</th></tr></thead>'
            + `<tbody>${body}</tbody></table>`;
    },

    async renderRewards(facts, data) {
        const lo = ValueProps.loyalty(data);
        if (!lo) { this.unavailable(facts); return; }
        facts.innerHTML = this.rewardsHtml(lo);
    },

    async renderBulk(facts, data) {
        const vol = ValueProps.volume(data);
        if (!vol) { this.unavailable(facts); return; }
        const esc = Security.escapeHtml;
        // The page h1 already IS the headline here; don't print it twice.
        const h1 = document.querySelector('.value-page__title');
        const dup = h1 && vol.headline && h1.textContent.trim().toLowerCase() === vol.headline.trim().toLowerCase();
        facts.innerHTML = (vol.headline && !dup ? `<p class="value-page__lead">${esc(vol.headline)}</p>` : '')
            + (vol.detail ? `<p class="value-page__detail">${esc(vol.detail)}</p>` : '')
            + '<p class="value-page__note">The table is the general rule. Each product shows its own price at every quantity on its page and in your cart — '
            + 'on some products the drop is smaller than the table, and that product price is the one you pay.</p>';
        const wrap = document.getElementById('value-page-tiers');
        const table = this.tiersTableHtml(vol.tiers);
        if (wrap && table) { wrap.innerHTML = table; wrap.hidden = false; }
    },

    async renderPacks(facts, data) {
        const packs = ValueProps.packs(data);
        const esc = Security.escapeHtml;
        facts.innerHTML = packs && packs.detail ? `<p class="value-page__lead">${esc(packs.detail)}</p>` : '';
        const grid = document.getElementById('value-page-grid');
        const more = document.getElementById('value-page-more');
        if (!grid || typeof API === 'undefined' || typeof Products === 'undefined') return;
        let page = 1;
        const load = async () => {
            let rows = [];
            let total = null;
            try {
                const resp = await API.getProducts({ pack: 'value_pack', page, limit: 24, sort: 'recommended' });
                rows = resp && resp.ok && resp.data && Array.isArray(resp.data.products) ? resp.data.products : [];
                total = resp && resp.data && resp.data.pagination ? resp.data.pagination.total : null;
                if (!resp || !resp.ok) throw new Error('unreadable');
            } catch (_) {
                if (page === 1) this.unavailable(grid);
                if (more) more.hidden = true;
                return;
            }
            if (page === 1) grid.innerHTML = '';
            grid.insertAdjacentHTML('beforeend', Products.renderCards(rows));
            Products.bindImageFallbacks(grid);
            Products.attachCardListeners(grid);
            Products.decorateBusinessPricing(grid, rows);
            const shown = grid.querySelectorAll('.product-card').length;
            if (more) more.hidden = !(rows.length === 24 && (total == null || shown < total));
            page += 1;
        };
        if (more) more.addEventListener('click', load);
        await load();
    },

    async init() {
        const root = document.querySelector('[data-value-page]');
        const facts = document.getElementById('value-page-facts');
        if (!root || !facts || typeof ValueProps === 'undefined') return;
        const res = await ValueProps.load();
        const kind = root.getAttribute('data-value-page');
        if (!res.ok) {
            this.unavailable(facts);
            if (kind !== 'value-packs') return;
        }
        const data = res.ok ? res.data : {};
        if (kind === 'rewards') return this.renderRewards(facts, data);
        if (kind === 'bulk-pricing') return this.renderBulk(facts, data);
        if (kind === 'value-packs') return this.renderPacks(facts, data);
    },
};

if (typeof module !== 'undefined' && module.exports) module.exports = { ValuePages };
if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    window.ValuePages = ValuePages;
    document.addEventListener('DOMContentLoaded', () => { ValuePages.init(); });
}
