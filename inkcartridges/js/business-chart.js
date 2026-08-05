/**
 * BusinessChart — the Business Centre "Performance overview" chart.
 * =================================================================
 *
 * One inline SVG, one time axis, one crosshair, one tooltip — but THREE STACKED
 * BANDS, each with its own y-scale:
 *
 *     spend    (40%)  money, left axis    · spend_incl_gst
 *     savings  (40%)  money, left axis    · b2b_savings + other_savings
 *     orders   (20%)  count, right axis   · orders
 *
 * WHY BANDS AND NOT ONE PLOT. `b2b_savings` runs 3-8% of `spend_incl_gst` — the
 * range the live six-band ladder actually produces. Drawn against spend on one
 * shared money axis the savings lines are a four-pixel smear along the baseline,
 * which is precisely the figure this page exists to show. The two obvious fixes
 * are both worse: a second money axis on the right lets spend and savings CROSS,
 * and every reader takes a crossing as an event when it is an artefact of the
 * scales; hiding spend behind a legend toggle means the card ships unreadable and
 * the fix is behind a control nobody knows to press. Separate bands make the
 * crossing structurally impossible and give savings a full-height scale on load.
 *
 * WHY NOT SavingsChart (js/savings-chart.js). That module plots on EPOCH TIME and
 * filters non-finite points away inside render(); this one plots CATEGORICALLY on
 * bucket index (uniform bars, trivial nearest-bucket hit-testing, month-length
 * differences correctly invisible) and must PRESERVE nulls as visible gaps. Those
 * two x-models are incompatible, and savings-chart.js still draws the Loyalty
 * page, so it is frozen rather than extended.
 *
 * WHY NOT Chart.js. js/admin/components/charts.js lazy-loads it from a CDN, is an
 * ES module, and reads admin-only dark-theme custom properties off document.body.
 * On a light storefront page its defaults render near-invisible.
 *
 * NULL IS NOT ZERO, AND IN BAR MODE THAT COSTS EXTRA WORK
 * ------------------------------------------------------
 * `null` means the backend did not record that figure (brief §1, R1). On a LINE a
 * missing point is self-evidently a gap. On a BAR it is not: a missing bar and a
 * $0 bar are the same pixels. So every null slot gets a positive mark — a hatched
 * `__nodata` rect — and a real measured $0 gets a 2px stub, so the two can never
 * be confused in either direction.
 *
 * In cumulative mode a null BREAKS the running total for that series and it stays
 * null (the discipline in dashboard.js accum()). Skipping the null and carrying on
 * would produce a line understated by an unknown amount that looks complete.
 *
 * STYLING IS THE CALLER'S: every emitted class derives from `blockClass`.
 *
 * PURE: no fetch, no storage, no CDN, no Math.random, no console. Given the same
 * input it emits the same markup, which is what makes it testable and what keeps
 * screenshots comparable.
 *
 * @example
 *   BusinessChart.render(host, {
 *       blockClass: 'business-chart',
 *       points: [{ period_start: '2026-01-01', spend_incl_gst: 1240.5,
 *                  b2b_savings: 98.2, other_savings: 15, orders: 4 }],
 *       grain: 'month', mode: 'period', hidden: ['other'],
 *       onToggle: (key) => { ... },
 *   });
 *   // -> { rendered, window, totals, nulls, breakIndex, buckets }
 */
(function () {
    'use strict';

    const esc = (v) => (typeof Security !== 'undefined' && Security.escapeHtml)
        ? Security.escapeHtml(String(v ?? ''))
        : String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    /** Nullable money. `—` for "not reported", never a confident $0.00. */
    const money = (n) => (typeof OrderTotals !== 'undefined' && OrderTotals.format)
        ? OrderTotals.format(n)
        : (n === null || n === undefined ? '—' : `$${Number(n).toFixed(2)}`);

    /** `null` for anything that isn't a real number. '' and undefined are NOT 0. */
    const num = (v) => (v === null || v === undefined || v === ''
        ? null
        : (Number.isFinite(Number(v)) ? Number(v) : null));

    /**
     * `YYYY-MM-DD` parsed by COMPONENTS, never `new Date(str)`.
     * `new Date('2026-06-12')` is UTC midnight and names the wrong day in NZ for
     * the first twelve hours of every day — the same trap dashboard.js#fmtBucket
     * documents.
     */
    const parseLocalDate = (s) => {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
        if (!m) return null;
        const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        return Number.isFinite(d.getTime()) ? d : null;
    };

    const fmtDay = (d) => d.toLocaleDateString('en-NZ', { day: 'numeric' });
    const fmtMon = (d) => d.toLocaleDateString('en-NZ', { month: 'short' });

    /**
     * Bucket label, formatted by the grain the SERVER ACTUALLY SERVED.
     *
     * A week bucket is named as the SPAN it covers, not its first day: "29 Jun –
     * 5 Jul" cannot be misread as a single date the way a bare "29 Jun" can when
     * it sits in a row of twelve of them.
     */
    const fmtBucket = (iso, grain) => {
        const d = parseLocalDate(iso);
        if (!d) return String(iso || '');
        if (grain === 'week') {
            const end = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 6);
            return d.getMonth() === end.getMonth()
                ? `${fmtDay(d)}–${fmtDay(end)} ${fmtMon(end)}`
                : `${fmtDay(d)} ${fmtMon(d)} – ${fmtDay(end)} ${fmtMon(end)}`;
        }
        return d.toLocaleDateString('en-NZ', { month: 'short', year: '2-digit' });
    };

    /** Compact axis tick. The tooltip carries the exact figure; ticks are reference lines. */
    const tickMoney = (v) => {
        if (!Number.isFinite(v)) return '';
        if (v === 0) return '$0';
        if (Math.abs(v) >= 1000) {
            // One decimal until six figures. Rounding $22.5k to "$23k" puts a
            // number on a gridline that the gridline is not at.
            const k = v / 1000;
            return `$${(Math.abs(k) >= 100 ? Math.round(k) : Math.round(k * 10) / 10)}k`;
        }
        return `$${Math.round(v)}`;
    };

    /**
     * Round UP to a "nice" step. A denser ladder than the admin chart's
     * 1/2/2.5/5: with only four rungs a band whose data peaks just above a rung
     * jumps to the next one and spends half its height empty — $4.3k of spend
     * drawn against an $8k axis reads as a quiet month when it was the busiest.
     * Every rung here still divides into readable tick labels.
     */
    const NICE = [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 10];
    const niceUp = (v) => {
        if (!(v > 0)) return 1;
        const mag = Math.pow(10, Math.floor(Math.log10(v)));
        const n = v / mag;
        for (const r of NICE) if (n <= r) return r * mag;
        return 10 * mag;
    };

    /**
     * Running total that BREAKS at the first unknown and stays broken.
     * @returns {{values: Array<number|null>, breakIndex: number|null}}
     */
    const accumulate = (vals) => {
        const out = [];
        let acc = 0;
        let breakIndex = null;
        for (let i = 0; i < vals.length; i++) {
            if (vals[i] === null || breakIndex !== null) {
                if (vals[i] === null && breakIndex === null) breakIndex = i;
                out.push(null);
                continue;
            }
            acc += vals[i];
            out.push(acc);
        }
        return { values: out, breakIndex };
    };

    /** Sum, or null the moment anything is unknown. A total that skips unknowns is a wrong number. */
    const totalOrNull = (vals) => {
        let t = 0;
        for (let i = 0; i < vals.length; i++) {
            if (vals[i] === null) return null;
            t += vals[i];
        }
        return Math.round(t * 100) / 100;
    };

    const countNulls = (vals) => {
        let n = 0;
        for (let i = 0; i < vals.length; i++) if (vals[i] === null) n += 1;
        return n;
    };

    /**
     * The four series, and which band each lives in. ARRAY ORDER IS DRAW ORDER
     * and legend order. The `key`s are the modifiers pages.css declares colours
     * for — `.business-chart__line--b2b` and friends.
     */
    const SERIES = [
        { key: 'spend', band: 'spend', field: 'spend_incl_gst', label: 'Spend', money: true },
        { key: 'b2b', band: 'savings', field: 'b2b_savings', label: 'Bulk-order savings', money: true },
        { key: 'other', band: 'savings', field: 'other_savings', label: 'Coupons & loyalty', money: true },
        { key: 'orders', band: 'orders', field: 'orders', label: 'Orders', money: false }
    ];

    const BANDS = [
        { id: 'spend', label: 'Spend', weight: 0.40, money: true, axis: 'left' },
        { id: 'savings', label: 'Savings', weight: 0.40, money: true, axis: 'left' },
        { id: 'orders', label: 'Orders', weight: 0.20, money: false, axis: 'right' }
    ];

    const BusinessChart = {

        /** Geometry. The viewBox width is the MEASURED host width, so the SVG renders 1:1
         *  and glyphs are never stretched — the reason this module does not inherit
         *  savings-chart.js's `preserveAspectRatio="none"`. */
        // padT clears the first band's label, which is drawn ABOVE its band —
        // at 14 the topmost one was cropped by the viewBox.
        H: 420, padL: 60, padR: 50, padT: 26, padB: 38, bandGap: 30, minW: 320,

        SERIES,

        /**
         * @param {Element|object} host        element whose innerHTML is replaced
         * @param {object}  opts
         * @param {Array}   opts.points        raw `points[]` from /analytics/series
         * @param {string}  [opts.blockClass]  BEM block for every emitted class
         * @param {string}  [opts.grain]       'month' | 'week' — the grain the SERVER served
         * @param {string}  [opts.mode]        'period' (bars) | 'cumulative' (running total)
         * @param {Array}   [opts.hidden]      series keys toggled off in the legend
         * @param {string}  [opts.ariaLabel]
         * @param {Function} [opts.onToggle]   called with a series key when a legend chip is clicked
         * @param {number}  [opts.width]       override the measured width (tests)
         * @returns {{rendered:boolean, window?:object, totals?:object, nulls?:object,
         *           breakIndex?:object, buckets?:number}}
         */
        render(host, opts) {
            if (!host) return { rendered: false };
            const o = opts || {};
            const block = o.blockClass || 'business-chart';
            const grain = o.grain === 'week' ? 'week' : 'month';
            const cumulative = o.mode === 'cumulative';
            const hidden = new Set(Array.isArray(o.hidden) ? o.hidden : []);

            const points = (Array.isArray(o.points) ? o.points : [])
                .filter((p) => p && parseLocalDate(p.period_start));

            // No buckets is NOT an error and NOT a zero line. The caller owns the
            // empty state, because only it knows whether that means "you haven't
            // ordered", "nothing in this window" or "the fetch failed".
            if (!points.length) {
                if (typeof host.innerHTML === 'string') host.innerHTML = '';
                return { rendered: false };
            }

            const labels = points.map((p) => fmtBucket(p.period_start, grain));

            // ── Per-series values, totals and gaps ──────────────────────────
            // `totals` and `nulls` are computed from the DATA, never from what is
            // currently visible: a legend toggle must not change the figures the
            // page prints beneath the chart.
            const raw = {};
            const plotted = {};
            const totals = {};
            const nulls = {};
            const breakIndex = {};
            for (const s of SERIES) {
                const vals = points.map((p) => num(p[s.field]));
                raw[s.key] = vals;
                totals[s.key] = totalOrNull(vals);
                nulls[s.key] = countNulls(vals);
                if (cumulative) {
                    const acc = accumulate(vals);
                    plotted[s.key] = acc.values;
                    breakIndex[s.key] = acc.breakIndex;
                } else {
                    plotted[s.key] = vals;
                    breakIndex[s.key] = null;
                }
            }

            // ── Geometry ────────────────────────────────────────────────────
            const measured = Number(o.width) || (typeof host.clientWidth === 'number' ? host.clientWidth : 0);
            const W = Math.max(this.minW, Math.round(measured) || 640);
            const { H, padT, padB, bandGap } = this;
            // Tighter gutters on a phone: 110px of axis margin out of 320 leaves
            // the plot narrower than the labels either side of it.
            const narrow = W < 480;
            const padL = narrow ? 44 : this.padL;
            const padR = narrow ? 34 : this.padR;
            const plotW = W - padL - padR;
            const plotH = H - padT - padB - bandGap * (BANDS.length - 1);
            const step = plotW / points.length;

            let top = padT;
            const geom = {};
            for (const b of BANDS) {
                const h = Math.round(plotH * b.weight);
                geom[b.id] = { top, bottom: top + h, h };
                top += h + bandGap;
            }

            const centreX = (i) => padL + step * (i + 0.5);

            // Each band scales to its OWN visible series. Money axes always include
            // zero — a zoomed baseline on an absolute money figure exaggerates every
            // wiggle into a trend.
            const bandMax = {};
            const bandStep = {};
            for (const b of BANDS) {
                let max = 0;
                for (const s of SERIES) {
                    if (s.band !== b.id || hidden.has(s.key)) continue;
                    for (const v of plotted[s.key]) if (v !== null && v > max) max = v;
                }
                const steps = b.money ? 4 : 3;
                // Count axes step by whole numbers — a "1.5 orders" gridline is a
                // lie the axis tells about a quantity that cannot be fractional.
                const one = b.money ? niceUp(Math.max(max, 1) / steps) : Math.max(1, Math.ceil(Math.max(max, 1) / steps));
                bandStep[b.id] = one;
                bandMax[b.id] = one * steps;
            }
            const yFor = (bandId, v) => {
                const g = geom[bandId];
                const max = bandMax[bandId] || 1;
                return g.bottom - (Math.max(0, v) / max) * g.h;
            };

            // ── Static furniture: gridlines, ticks, band labels ──────────────
            let furniture = '';
            for (const b of BANDS) {
                const g = geom[b.id];
                const steps = b.money ? 4 : 3;
                for (let k = 0; k <= steps; k++) {
                    const v = bandStep[b.id] * k;
                    const y = yFor(b.id, v).toFixed(1);
                    furniture += `<line class="${block}__grid${k === 0 ? ` ${block}__grid--base` : ''}" x1="${padL}" y1="${y}" x2="${(W - padR).toFixed(1)}" y2="${y}"></line>`;
                    const label = b.money ? tickMoney(v) : String(v);
                    furniture += b.axis === 'right'
                        ? `<text class="${block}__tick" x="${(W - padR + 8).toFixed(1)}" y="${(Number(y) + 4).toFixed(1)}" text-anchor="start">${esc(label)}</text>`
                        : `<text class="${block}__tick" x="${padL - 8}" y="${(Number(y) + 4).toFixed(1)}" text-anchor="end">${esc(label)}</text>`;
                }
                furniture += `<text class="${block}__band-label" x="${padL}" y="${(g.top - 8).toFixed(1)}">${esc(b.label)}</text>`;
            }

            // X labels, thinned to what the plot is actually WIDE ENOUGH for. A
            // fixed cap of 12 is fine at 1440px and unreadable at 375, where the
            // labels run into each other and the axis stops being a date axis.
            // Week spans ("29 Jun – 5 Jul") need roughly twice the room.
            const labelPx = grain === 'week' ? 84 : 50;
            const maxLabels = Math.max(2, Math.min(12, Math.floor(plotW / labelPx)));
            const every = Math.max(1, Math.ceil(points.length / maxLabels));
            const shown = [];
            for (let i = 0; i < points.length; i += every) shown.push(i);
            const lastIdx = points.length - 1;
            // The final bucket is worth naming, but not at the cost of printing it
            // on top of its neighbour.
            if (shown[shown.length - 1] !== lastIdx && lastIdx - shown[shown.length - 1] > every / 2) {
                shown.push(lastIdx);
            }
            for (const i of shown) {
                furniture += `<text class="${block}__tick ${block}__tick--x" x="${centreX(i).toFixed(1)}" y="${H - 14}" text-anchor="middle">${esc(labels[i])}</text>`;
            }

            // ── Series marks ────────────────────────────────────────────────
            const hatchId = `${block}-nodata`;
            let marks = '';
            let gaps = '';

            for (const b of BANDS) {
                const visible = SERIES.filter((s) => s.band === b.id && !hidden.has(s.key));
                if (!visible.length) {
                    marks += `<text class="${block}__band-hidden" x="${(padL + plotW / 2).toFixed(1)}" y="${(geom[b.id].top + geom[b.id].h / 2).toFixed(1)}" text-anchor="middle">Hidden</text>`;
                    continue;
                }
                const asBars = !cumulative && b.id !== 'orders';
                const slot = step * 0.62;
                const barW = asBars ? slot / visible.length : 0;

                visible.forEach((s, si) => {
                    const vals = plotted[s.key];
                    if (asBars) {
                        for (let i = 0; i < vals.length; i++) {
                            const x = centreX(i) - slot / 2 + barW * si;
                            if (vals[i] === null) {
                                // A hatched slot, not an absent one. In bar mode a
                                // missing bar and a $0 bar are the same pixels.
                                gaps += `<rect class="${block}__nodata" x="${x.toFixed(1)}" y="${geom[b.id].top.toFixed(1)}" width="${barW.toFixed(1)}" height="${geom[b.id].h.toFixed(1)}" fill="url(#${hatchId})"><title>${esc(s.label)} not recorded — ${esc(labels[i])}</title></rect>`;
                                continue;
                            }
                            // A measured $0 keeps a 2px stub so it reads as "we
                            // looked and it was zero", not as nothing at all.
                            const yTop = yFor(b.id, vals[i]);
                            const h = Math.max(2, geom[b.id].bottom - yTop);
                            marks += `<rect class="${block}__bar ${block}__bar--${s.key}" x="${x.toFixed(1)}" y="${(geom[b.id].bottom - h).toFixed(1)}" width="${Math.max(1, barW - 1).toFixed(1)}" height="${h.toFixed(1)}"></rect>`;
                        }
                        return;
                    }

                    // Lines: null splits the polyline rather than bridging it.
                    let run = [];
                    const flush = () => {
                        if (run.length > 1) {
                            marks += `<polyline class="${block}__line ${block}__line--${s.key}" points="${run.join(' ')}" fill="none"></polyline>`;
                        } else if (run.length === 1) {
                            const [px, py] = run[0].split(',');
                            marks += `<circle class="${block}__dot ${block}__dot--${s.key}" cx="${px}" cy="${py}" r="2.5"></circle>`;
                        }
                        run = [];
                    };
                    for (let i = 0; i < vals.length; i++) {
                        if (vals[i] === null) {
                            flush();
                            // A break in a line is only obvious if you were watching
                            // the line. Mark the slot as well — and only up to a
                            // cumulative break, after which the whole tail is marked
                            // once by the band-level region below.
                            if (!cumulative) {
                                const gx = centreX(i) - (step * 0.62) / 2;
                                gaps += `<rect class="${block}__nodata" x="${gx.toFixed(1)}" y="${geom[b.id].top.toFixed(1)}" width="${(step * 0.62).toFixed(1)}" height="${geom[b.id].h.toFixed(1)}" fill="url(#${hatchId})"><title>${esc(s.label)} not recorded — ${esc(labels[i])}</title></rect>`;
                            }
                            continue;
                        }
                        run.push(`${centreX(i).toFixed(1)},${yFor(b.id, vals[i]).toFixed(1)}`);
                    }
                    flush();
                });

                // Everything after a cumulative break is unknowable, and saying so
                // beats a line that simply stops. Drawn ONCE per band from the
                // EARLIEST break among its visible series — two overlapping
                // translucent rects would read as two different confidences.
                if (cumulative) {
                    let first = null;
                    for (const s of visible) {
                        const bi = breakIndex[s.key];
                        if (bi !== null && (first === null || bi < first)) first = bi;
                    }
                    if (first !== null) {
                        const x0 = padL + step * first;
                        gaps += `<rect class="${block}__unknown" x="${x0.toFixed(1)}" y="${geom[b.id].top.toFixed(1)}" width="${Math.max(0, W - padR - x0).toFixed(1)}" height="${geom[b.id].h.toFixed(1)}"><title>No running total past this point — a period here has no recorded figure.</title></rect>`;
                    }
                }
            }

            // ── Hover furniture ─────────────────────────────────────────────
            let crosshair = `<line class="${block}__crosshair" x1="0" y1="${padT}" x2="0" y2="${H - padB}" hidden></line>`;
            for (const s of SERIES) {
                crosshair += `<circle class="${block}__marker ${block}__marker--${s.key}" data-marker="${s.key}" cx="0" cy="0" r="4" hidden></circle>`;
            }
            const hitRect = `<rect class="${block}__hit" x="${padL}" y="${padT}" width="${plotW.toFixed(1)}" height="${(H - padT - padB).toFixed(1)}" fill="transparent"></rect>`;

            const defs =
                `<defs><pattern id="${hatchId}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
                `<rect width="6" height="6" class="${block}__nodata-bg"></rect>` +
                `<line x1="0" y1="0" x2="0" y2="6" class="${block}__nodata-line"></line></pattern></defs>`;

            const ariaLabel = o.ariaLabel || `${cumulative ? 'Running total' : 'Per period'} spend, savings and orders across ${points.length} ${grain === 'week' ? 'weeks' : 'months'}`;

            const svg =
                `<svg class="${block}" viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="${esc(ariaLabel)}" focusable="false">` +
                defs + gaps + furniture + marks + crosshair + hitRect + '</svg>';

            // ── Legend, tooltip, readout, screen-reader table ───────────────
            const legend = `<div class="${block}__legend">` + SERIES.map((s) => {
                const off = hidden.has(s.key);
                return `<button type="button" class="${block}__chip ${block}__chip--${s.key}" data-series="${s.key}" aria-pressed="${off ? 'false' : 'true'}">` +
                    `<span class="${block}__swatch ${block}__swatch--${s.key}"></span>${esc(s.label)}</button>`;
            }).join('') + '</div>';

            const tooltip = `<div class="${block}__tooltip" role="presentation" hidden></div>`;
            const readout = `<p class="${block}__readout visually-hidden" aria-live="polite"></p>`;

            // The wrapper is LOAD-BEARING, not tidiness. `.visually-hidden` clips
            // with `overflow:hidden`, and overflow does not apply to a table box
            // — with the class on the <table> itself the full-width grid still
            // contributes to layout and the whole page scrolls sideways on a
            // phone. A <div> honours it.
            let table = `<div class="visually-hidden"><table><caption>${esc(ariaLabel)}</caption><thead><tr><th scope="col">Period</th>` +
                SERIES.map((s) => `<th scope="col">${esc(s.label)}</th>`).join('') + '</tr></thead><tbody>';
            for (let i = 0; i < points.length; i++) {
                table += `<tr><th scope="row">${esc(labels[i])}</th>` + SERIES.map((s) => {
                    const v = plotted[s.key][i];
                    if (v === null) return '<td>Not recorded</td>';
                    return `<td>${esc(s.money ? money(v) : String(Math.round(v)))}</td>`;
                }).join('') + '</tr>';
            }
            table += '</tbody></table></div>';

            const html =
                // `role="group"`, not `application` — the full data table below is
                // what a screen reader should read, and `application` would take the
                // arrow keys away from it to serve a sighted-keyboard nicety.
                `<div class="${block}__frame" tabindex="0" role="group" aria-label="${esc(ariaLabel)}. Use the left and right arrow keys to read each period.">` +
                svg + tooltip + '</div>' + legend + readout + table;

            host.innerHTML = html;

            // A plain `{innerHTML:''}` stand-in has no DOM to wire — the markup is
            // the whole contract for the test harness.
            if (typeof host.querySelector === 'function') {
                this._wire(host, {
                    block, labels, plotted, hidden, grain, cumulative,
                    centreX, yFor, geom, W, H, padL, padR, step, count: points.length,
                    onToggle: typeof o.onToggle === 'function' ? o.onToggle : null
                });
            }

            return {
                rendered: true,
                window: { from: points[0].period_start, to: points[points.length - 1].period_start },
                totals, nulls, breakIndex,
                buckets: points.length
            };
        },

        /** Pointer + keyboard interaction. Every write here is presentational. */
        _wire(host, ctx) {
            const frame = host.querySelector(`.${ctx.block}__frame`);
            const svg = host.querySelector('svg');
            const tip = host.querySelector(`.${ctx.block}__tooltip`);
            const readout = host.querySelector(`.${ctx.block}__readout`);
            const cross = host.querySelector(`.${ctx.block}__crosshair`);
            if (!frame || !svg) return;

            let focusIndex = -1;
            const markers = {};
            for (const s of BusinessChart.SERIES) {
                markers[s.key] = host.querySelector(`[data-marker="${s.key}"]`);
            }

            const rowsFor = (i) => BusinessChart.SERIES
                .filter((s) => !ctx.hidden.has(s.key))
                .map((s) => {
                    const v = ctx.plotted[s.key][i];
                    let value = 'Not recorded';
                    if (v !== null) value = s.money ? money(v) : String(Math.round(v));
                    // Savings read as a rate against the spend of the SAME bucket.
                    // Suppressed the moment either half is unknown — never x/null.
                    let rate = '';
                    if (v !== null && (s.key === 'b2b' || s.key === 'other')) {
                        const sp = ctx.plotted.spend[i];
                        if (sp !== null && sp > 0) rate = ` · ${(v / sp * 100).toFixed(1)}% of spend`;
                    }
                    return { label: s.label, key: s.key, value, rate };
                });

            const move = (i) => {
                if (!(i >= 0 && i < ctx.count)) return;
                const x = ctx.centreX(i);
                if (cross) {
                    cross.setAttribute('x1', x.toFixed(1));
                    cross.setAttribute('x2', x.toFixed(1));
                    cross.removeAttribute('hidden');
                }
                for (const s of BusinessChart.SERIES) {
                    const m = markers[s.key];
                    if (!m) continue;
                    const v = ctx.plotted[s.key][i];
                    if (ctx.hidden.has(s.key) || v === null) { m.setAttribute('hidden', ''); continue; }
                    m.setAttribute('cx', x.toFixed(1));
                    m.setAttribute('cy', ctx.yFor(s.band, v).toFixed(1));
                    m.removeAttribute('hidden');
                }

                const rows = rowsFor(i);
                if (tip) {
                    tip.innerHTML = `<p class="${ctx.block}__tooltip-title">${esc(ctx.labels[i])}</p>` +
                        rows.map((r) => `<p class="${ctx.block}__tooltip-row"><span class="${ctx.block}__swatch ${ctx.block}__swatch--${r.key}"></span>` +
                            `<span class="${ctx.block}__tooltip-label">${esc(r.label)}</span>` +
                            `<span class="${ctx.block}__tooltip-value">${esc(r.value + r.rate)}</span></p>`).join('');
                    tip.hidden = false;
                    // Flip to the left of the crosshair once the tooltip would run
                    // off the right edge of the frame.
                    const frac = x / ctx.W;
                    tip.style.left = `${(frac * 100).toFixed(2)}%`;
                    tip.classList.toggle(`${ctx.block}__tooltip--flip`, frac > 0.62);
                }
                if (readout) {
                    readout.textContent = `${ctx.labels[i]}: ` +
                        rows.map((r) => `${r.label} ${r.value}${r.rate}`).join(', ');
                }
                focusIndex = i;
            };

            const clear = () => {
                if (cross) cross.setAttribute('hidden', '');
                for (const s of BusinessChart.SERIES) {
                    if (markers[s.key]) markers[s.key].setAttribute('hidden', '');
                }
                if (tip) tip.hidden = true;
            };

            const indexFromEvent = (ev) => {
                const box = svg.getBoundingClientRect ? svg.getBoundingClientRect() : null;
                if (!box || !box.width) return -1;
                // The viewBox width is the measured width, but a mid-resize frame can
                // still be off — scale rather than assume 1:1.
                const px = (ev.clientX - box.left) * (ctx.W / box.width);
                const i = Math.floor((px - ctx.padL) / ctx.step);
                return Math.min(ctx.count - 1, Math.max(0, i));
            };

            svg.addEventListener('pointermove', (ev) => move(indexFromEvent(ev)));
            svg.addEventListener('pointerdown', (ev) => move(indexFromEvent(ev)));
            svg.addEventListener('pointerleave', clear);

            frame.addEventListener('keydown', (ev) => {
                const cur = (focusIndex >= 0 && focusIndex < ctx.count) ? focusIndex : 0;
                if (ev.key === 'ArrowRight') { move(Math.min(ctx.count - 1, cur + 1)); ev.preventDefault(); }
                else if (ev.key === 'ArrowLeft') { move(Math.max(0, cur - 1)); ev.preventDefault(); }
                else if (ev.key === 'Home') { move(0); ev.preventDefault(); }
                else if (ev.key === 'End') { move(ctx.count - 1); ev.preventDefault(); }
                else if (ev.key === 'Escape') { clear(); }
            });
            frame.addEventListener('blur', clear);

            if (ctx.onToggle) {
                host.querySelectorAll(`[data-series]`).forEach((btn) => {
                    btn.addEventListener('click', () => ctx.onToggle(btn.getAttribute('data-series')));
                });
            }
        }
    };

    if (typeof window !== 'undefined') window.BusinessChart = BusinessChart;
    if (typeof module !== 'undefined' && module.exports) module.exports = BusinessChart;
})();
