/**
 * SavingsChart — inline-SVG cumulative multi-line chart. No external library.
 * =========================================================================
 *
 * Extracted from loyalty-page.js#renderGraph (Aug 2026) so the Loyalty page and
 * the Business Centre draw "savings over time" with ONE set of maths. Two pages
 * plotting the same idea with two copies of the scaling code is exactly how the
 * chip/ribbon/type-filter vocabularies drifted before (ERR-075, ERR-129).
 *
 * WHY NOT Chart.js: js/admin/components/charts.js exists, but it is an ES module
 * that lazy-loads Chart.js from a CDN and reads admin-only dark-theme CSS custom
 * properties off document.body. On a light storefront page its defaults render
 * near-invisible. This module is ~90 lines, has no network dependency, and
 * inherits whatever CSS the calling page already ships.
 *
 * STYLING IS THE CALLER'S: every class is derived from `blockClass`, so the
 * Loyalty page passes 'loyalty-chart' and keeps its existing rules in
 * css/pages.css untouched, while the Business Centre passes its own.
 *
 * @example
 *   SavingsChart.render(hostEl, {
 *       blockClass: 'loyalty-chart',
 *       ariaLabel: 'Loyalty value and order savings over time',
 *       series: [
 *           { modifier: 'savings', points: [{ t: epochMs, v: 12.5 }] },
 *           { modifier: 'accrued', points: [...] },
 *       ],
 *   });
 *   // -> { rendered: true, minT, maxT, maxV }  |  { rendered: false } when empty
 */
(function () {
    'use strict';

    const esc = (v) => (typeof Security !== 'undefined' && Security.escapeHtml)
        ? Security.escapeHtml(String(v ?? ''))
        : String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    const fmtDate = (iso) => {
        if (!iso) return '';
        try {
            return new Date(iso).toLocaleDateString('en-NZ', { year: 'numeric', month: 'short', day: 'numeric' });
        } catch { return ''; }
    };

    const fmtMoney = (n) => (typeof formatPrice === 'function') ? formatPrice(n) : `$${Number(n || 0).toFixed(2)}`;

    /** Running total. The chart plots cumulative value; callers pass per-event deltas. */
    const cumulate = (arr) => { let s = 0; return arr.map((p) => ({ t: p.t, v: (s += p.v) })); };

    const SavingsChart = {

        /** Viewport geometry. Fixed viewBox + preserveAspectRatio="none" — CSS scales it. */
        W: 600, H: 240, padL: 48, padR: 14, padT: 14, padB: 30,

        /**
         * @param {Element} host              element whose innerHTML is replaced
         * @param {object}  opts
         * @param {Array}   opts.series       [{ modifier, points:[{t,v}], cumulative? }] — ARRAY ORDER IS DRAW ORDER (last on top)
         * @param {string}  opts.blockClass   BEM block for every emitted class
         * @param {string}  opts.ariaLabel    accessible name for the <svg role="img">
         * @param {boolean} [opts.cumulative] default true; set false if points are already running totals
         * @returns {{rendered: boolean, minT?: number, maxT?: number, maxV?: number}}
         */
        render(host, opts) {
            if (!host) return { rendered: false };
            const o = opts || {};
            const blockClass = o.blockClass || 'savings-chart';
            const wantCumulative = o.cumulative !== false;

            const series = (o.series || [])
                .map((s) => {
                    const pts = (s.points || [])
                        .filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.v))
                        .sort((a, b) => a.t - b.t);
                    const useCum = s.cumulative !== undefined ? s.cumulative : wantCumulative;
                    return { modifier: s.modifier, points: useCum ? cumulate(pts) : pts };
                })
                .filter((s) => s.points.length);

            // No data is NOT an error and NOT a zero line — the caller owns the
            // empty state, because only it knows whether "nothing yet" means
            // "you haven't shopped" or "we couldn't load it" (ERR-063 family).
            if (!series.length) {
                host.innerHTML = '';
                return { rendered: false };
            }

            const flat = series.flatMap((s) => s.points);
            const minT = Math.min(...flat.map((p) => p.t));
            const maxT = Math.max(...flat.map((p) => p.t));
            const maxV = Math.max(1, ...flat.map((p) => p.v));
            const spanT = (maxT - minT) || 1;

            const { W, H, padL, padR, padT, padB } = this;
            const x = (t) => padL + ((t - minT) / spanT) * (W - padL - padR);
            const y = (v) => (H - padB) - (v / maxV) * (H - padT - padB);

            // Pad each series out to the SHARED time span, so two series with
            // different first/last events still start and end on the same axis
            // instead of appearing to begin at different dates.
            const toPoly = (pts) => {
                if (!pts.length) return '';
                const out = [];
                if (pts[0].t > minT) out.push(`${x(minT).toFixed(1)},${y(0).toFixed(1)}`);
                pts.forEach((p) => out.push(`${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`));
                const last = pts[pts.length - 1];
                if (last.t < maxT) out.push(`${x(maxT).toFixed(1)},${y(last.v).toFixed(1)}`);
                return out.join(' ');
            };

            const baselineY = y(0).toFixed(1);
            const startLabel = esc(fmtDate(new Date(minT).toISOString()));
            const endLabel = esc(fmtDate(new Date(maxT).toISOString()));
            const maxLabel = esc(fmtMoney(maxV));

            const lines = series.map((s) => {
                const poly = toPoly(s.points);
                if (!poly) return '';
                const mod = s.modifier ? ` ${blockClass}__line--${esc(s.modifier)}` : '';
                return `<polyline class="${blockClass}__line${mod}" points="${poly}" fill="none"></polyline>`;
            }).join('');

            host.innerHTML = `
                <svg class="${blockClass}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(o.ariaLabel || 'Savings over time')}">
                    <line class="${blockClass}__axis" x1="${padL}" y1="${padT}" x2="${padL}" y2="${baselineY}"></line>
                    <line class="${blockClass}__axis" x1="${padL}" y1="${baselineY}" x2="${W - padR}" y2="${baselineY}"></line>
                    <text class="${blockClass}__tick" x="${padL - 6}" y="${(padT + 8).toFixed(1)}" text-anchor="end">${maxLabel}</text>
                    <text class="${blockClass}__tick" x="${padL - 6}" y="${baselineY}" text-anchor="end">$0</text>
                    <text class="${blockClass}__tick" x="${padL}" y="${H - 8}" text-anchor="start">${startLabel}</text>
                    <text class="${blockClass}__tick" x="${W - padR}" y="${H - 8}" text-anchor="end">${endLabel}</text>
                    ${lines}
                </svg>
            `;

            return { rendered: true, minT, maxT, maxV };
        }
    };

    if (typeof window !== 'undefined') window.SavingsChart = SavingsChart;
    if (typeof module !== 'undefined' && module.exports) module.exports = SavingsChart;
})();
