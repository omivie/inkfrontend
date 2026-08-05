/**
 * Business Centre — LOCAL DEMO DATA (development only)
 * ====================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * /business is correct but empty for an account with no order history: three
 * $0.00 tiles and two blank charts. That is the honest answer, and it is also
 * impossible to design against. This module feeds the page a plausible
 * fourteen-month account so the populated layout can be reviewed.
 *
 * It fabricates figures about money. So:
 *
 *   1. IT CANNOT RUN IN PRODUCTION. Two independent conditions, both required:
 *      the hostname is localhost/127.0.0.1, AND the page was opened with an
 *      explicit ?demo=1. Never `||`, never one alone. business-page.js also
 *      refuses to even fetch this file unless the same guard passes, so on
 *      inkcartridges.co.nz these bytes are never requested, let alone run.
 *
 *   2. IT SAYS SO, LOUDLY. renderBanner() pins an unmissable bar to the top of
 *      the page. Synthetic numbers that look real, on a page about what a
 *      customer owes, is precisely the failure this repo keeps logging
 *      (ERR-063/068/073/075/076/139). A quiet demo mode would be worse than
 *      no demo mode.
 *
 * INTERNAL CONSISTENCY IS THE WHOLE POINT
 * ---------------------------------------
 * The page cross-reads these payloads: the outstanding tile comes from
 * /account/summary while the invoice list comes from /invoices, and the
 * headline savings come from series totals while the chart plots the buckets.
 * Fixtures that disagree with each other would make the real page look buggy
 * and send someone hunting a bug that isn't there. So every total here is
 * SUMMED FROM the rows it summarises — never typed in independently.
 *
 * Everything is seeded and deterministic (no Math.random) so a reload produces
 * the same page and screenshots are comparable.
 *
 * NO COST OR MARGIN FIELD APPEARS ANYWHERE IN THIS FILE — see the backend
 * brief's rule R2. `unit_price_excl_gst` is the SELL price; the supplier-side
 * names are one word away and must never appear on a customer surface.
 */
(function () {
    'use strict';

    const PARAM = 'demo';
    const KEY = 'ink_business_demo';

    /** Same test as js/site-guard.js — a dev host, never a deployed one. */
    function isLocalHost() {
        return location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    }

    /**
     * Explicit opt-in, remembered for the tab so the #invoices hash and the
     * tab buttons don't drop it. ?demo=0 clears it.
     */
    function optedIn() {
        let stored = null;
        try { stored = sessionStorage.getItem(KEY); } catch { /* private mode */ }
        let param = null;
        try { param = new URLSearchParams(location.search).get(PARAM); } catch { /* older browser */ }

        if (param === '1' || param === 'true') {
            try { sessionStorage.setItem(KEY, '1'); } catch { /* ignore */ }
            return true;
        }
        if (param === '0' || param === 'false') {
            try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
            return false;
        }
        return stored === '1';
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Deterministic generation
    // ─────────────────────────────────────────────────────────────────────────

    /** Numerical Recipes LCG. Math.random would break screenshot comparison. */
    function seeded(seed) {
        let s = (seed >>> 0) || 1;
        return function next() {
            s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
            return s / 4294967296;
        };
    }

    const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
    const sum2 = (rows, pick) => round2(rows.reduce((t, r) => t + (pick(r) || 0), 0));
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

    /**
     * Real catalogue rows (SKU, name and canonical path captured from the live
     * /api/products). Fake SKUs would 404 the moment "Add to cart" is clicked,
     * which is the one interaction on this panel.
     *
     * `product_url` is site-relative and must never start with /html/ —
     * tests/url-consolidation.test.js bans those site-wide.
     *
     * NO PRICE FIELD, deliberately: the real endpoint omits it so reorder tiles
     * price from the live catalogue rather than re-presenting a historical
     * figure as today's price.
     */
    const CATALOGUE = [
        { sku: 'GTN2530XLBK', name: 'Brother Genuine TN2530XLBK Toner Cartridge TN2530XL Black (3,000 pages)', product_url: '/products/brother-genuine-tn2530xlbk-toner-cartridge-tn2530xl-black-3000-pages/GTN2530XLBK' },
        { sku: 'G410XBK', name: 'HP Genuine 410XBK Toner Cartridge 410X Black (6,500 pages)', product_url: '/products/hp-genuine-410xbk-toner-cartridge-410x-black-6500-pages/G410XBK' },
        { sku: 'GTN258BK', name: 'Brother Genuine TN258BK Toner Cartridge TN258 Black (1,000 pages)', product_url: '/products/brother-genuine-tn258bk-toner-cartridge-tn258-black-1000-pages/GTN258BK' },
        { sku: 'G53ABK', name: 'HP Genuine 53ABK Toner Cartridge 53A Black (3,000 pages)', product_url: '/products/hp-genuine-53abk-toner-cartridge-53a-black-3000-pages/G53ABK' },
        { sku: 'C85ABK', name: '85ABK Compatible Toner Cartridge for HP 85A (CE285A) Black', product_url: '/products/85abk-compatible-toner-cartridge-for-hp-85a-ce285a-black/C85ABK' },
        { sku: 'GPGI680XLBK', name: 'Canon Genuine PGI680XLBK Ink Cartridge PGI680XL Black (400 pages)', product_url: '/products/canon-genuine-pgi680xlbk-ink-cartridge-pgi680xl-black-400-pages/GPGI680XLBK' },
        { sku: 'GTN258C', name: 'Brother Genuine TN258C Toner Cartridge TN258 Cyan (1,000 pages)', product_url: '/products/brother-genuine-tn258c-toner-cartridge-tn258-cyan-1000-pages/GTN258C' },
        { sku: 'GCLI681C', name: 'Canon Genuine CLI681C Ink Cartridge CLI681 Cyan (250 pages)', product_url: '/products/canon-genuine-cli681c-ink-cartridge-cli681-cyan-250-pages/GCLI681C' }
    ];

    const COMPANY = 'Kereru Print & Office Ltd';
    /** How far back the generated history runs, so 2y and All are different views. */
    const BASE_MONTHS = 30;
    /** Invoices only cover the recent tail — the list is a fixture for paging, not a ledger. */
    const INVOICE_MONTHS = 14;
    // Comfortably above the outstanding balance: an account sitting at 99% of
    // its credit limit is a stressed account, not the healthy one being shown.
    const CREDIT_LIMIT = 12000;

    let _cache = null;

    /** First day of the month, `back` months before the current one. */
    function monthStart(back) {
        const now = new Date();
        return new Date(now.getFullYear(), now.getMonth() - back, 1);
    }

    /** `YYYY-MM-DD` parsed by components — `new Date(str)` is UTC and slips a day. */
    function parseISO(s) {
        const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
        return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
    }

    /** Monday of the week containing `d`. */
    function weekStart(d) {
        const back = (d.getDay() + 6) % 7;
        return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back);
    }

    /**
     * THE BASE IS DAILY, and every grain is aggregated from it.
     *
     * The page can now ask for monthly OR weekly buckets, and a fixture that
     * generated each grain independently would let the two disagree — switching
     * "Weekly" would change the customer's total spend, and the demo would be
     * teaching a bug that does not exist in the real service. One truth, two
     * views: exactly the rule the invoice fixtures already follow, where every
     * total is summed from the rows it summarises.
     *
     * Daily also preserves the weekday/weekend rhythm, which is the reason a
     * weekly view is worth offering at all.
     *
     * b2b_savings runs ~3-8% of spend, which is the range the live six-band
     * ladder actually produces (entry 0.5%, top 10%) — a demo that showed 25%
     * would misrepresent the product.
     */
    function buildBase() {
        const rnd = seeded(20260803);
        const now = new Date();
        // Normalised to midnight before the span is measured. Taken from `new
        // Date()` directly, half a day of clock time rounds the span UP and the
        // base gains a row dated TOMORROW — which any `to=today` window then
        // clips out, leaving the lifetime totals permanently ahead of the
        // all-time chart by one day's trading.
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const start = monthStart(BASE_MONTHS - 1);
        const span = Math.round((today.getTime() - start.getTime()) / 86400000);
        const rows = [];
        for (let i = 0; i <= span; i++) {
            const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
            const t = span ? i / span : 1;
            const weekend = d.getDay() === 0 || d.getDay() === 6;
            // A growing print-and-office account: busier weekdays, bigger baskets
            // over time. Weekend zeros are REAL measured zeros, not gaps.
            const chance = weekend ? 0.02 : 0.20 + t * 0.10;
            let orders = 0, spend = 0, b2b = 0, other = 0;
            if (rnd() < chance) {
                orders = 1 + (rnd() < 0.12 ? 1 : 0);
                const per = 150 + t * 260;
                spend = round2(orders * per * (0.7 + rnd() * 0.7));
                b2b = round2(spend * (0.03 + rnd() * 0.05));
                other = round2(spend * (0.004 + rnd() * 0.014));
            }
            rows.push({ date: iso(d), spend, b2b, other, orders });
        }
        return rows;
    }

    /**
     * Roll the daily base up to one grain across one window. Every bucket in the
     * window appears, including the ones that measured zero — a backend that
     * silently omitted an empty month would make a categorical axis close the gap
     * and hide it, so the fixture must not model that.
     */
    function aggregate(base, grain, from, to) {
        const map = new Map();
        const keys = [];
        for (const row of base) {
            if (from && row.date < from) continue;
            if (to && row.date > to) continue;
            const d = parseISO(row.date);
            const key = iso(grain === 'week' ? weekStart(d) : new Date(d.getFullYear(), d.getMonth(), 1));
            let b = map.get(key);
            if (!b) {
                b = { period_start: key, spend_incl_gst: 0, b2b_savings: 0, other_savings: 0, orders: 0 };
                map.set(key, b);
                keys.push(key);
            }
            b.spend_incl_gst += row.spend;
            b.b2b_savings += row.b2b;
            b.other_savings += row.other;
            b.orders += row.orders;
        }
        keys.sort();
        return keys.map((k) => {
            const b = map.get(k);
            b.spend_incl_gst = round2(b.spend_incl_gst);
            b.b2b_savings = round2(b.b2b_savings);
            b.other_savings = round2(b.other_savings);
            return b;
        });
    }

    /**
     * DEVELOPMENT ONLY, opt-in — `?demo=1&demo_profile=partial`.
     *
     * The healthy profile has no gaps, which leaves the whole "we didn't record
     * this" family of states unreachable in review: the hatched not-recorded
     * marks, the broken running total, the un-totalled range line and the
     * discount-breakdown caveat. This profile makes them all visible. Behind the
     * same AND-guard as everything else here.
     */
    function partialMode() {
        // BOTH, always — written as one AND so the source-level guard check that
        // bans `isLocalHost() ||` can see it. Either condition alone is a
        // production hazard.
        if (!(isLocalHost() && optedIn())) return false;
        try {
            return new URLSearchParams(location.search).get('demo_profile') === 'partial';
        } catch { return false; }
    }

    /**
     * Blank the discount split on two buckets a third of the way in, and report
     * exactly the orders that went unsplit. `orders` stays a real number: the
     * orders happened, it is the BREAKDOWN that is missing.
     */
    function applyPartial(points) {
        let missing = 0;
        const at = Math.floor(points.length / 3);
        for (const i of [at, at + 1]) {
            if (i < 0 || i >= points.length) continue;
            points[i].b2b_savings = null;
            points[i].other_savings = null;
            missing += points[i].orders;
        }
        return missing;
    }

    /**
     * The series endpoint, honouring `from` / `to` / `granularity` exactly as the
     * real one does — and ECHOING THE WINDOW IT ACTUALLY SERVED, clamped to the
     * history that exists, never the window it was asked for. The page checks
     * that echo and says so when it differs, so a fixture that parroted the
     * request back would hide the only bug this check exists to catch.
     */
    function seriesFor(params) {
        const d = dataset();
        const base = d.base;
        const first = base[0].date;
        const last = base[base.length - 1].date;

        const grain = params.get('granularity') === 'week' ? 'week' : 'month';
        let from = params.get('from') || '';
        let to = params.get('to') || '';
        if (!from && !to) {
            // The contract's default: the last 12 months, monthly.
            from = iso(monthStart(11));
            to = last;
        }
        if (!from || from < first) from = first;
        if (!to || to > last) to = last;

        const points = aggregate(base, grain, from, to);
        const missing = partialMode() ? applyPartial(points) : 0;

        let counted = 0;
        for (const p of points) counted += p.orders;

        return {
            granularity: grain,
            currency: 'NZD',
            from: points.length ? points[0].period_start : from,
            to: points.length ? points[points.length - 1].period_start : to,
            points,
            // LIFETIME, summed from the WHOLE base rather than the slice above —
            // the tiles say "All time" and must not move when the range moves.
            totals: d.lifetime,
            coverage: {
                // Window-scoped, and matching the rows actually returned. `0` is a
                // real value in the healthy profile: every order was broken down,
                // so the caveat stays hidden.
                orders_counted: counted,
                orders_missing_discount_breakdown: missing
            }
        };
    }

    /** Lifetime totals, summed from the daily base they summarise. */
    function buildLifetime(base) {
        let firstOrder = null;
        for (const row of base) {
            if (row.orders > 0) { firstOrder = row.date; break; }
        }
        return {
            lifetime_spend_incl_gst: sum2(base, (r) => r.spend),
            lifetime_b2b_savings: sum2(base, (r) => r.b2b),
            lifetime_other_savings: sum2(base, (r) => r.other),
            first_order_at: firstOrder ? `${firstOrder}T21:14:00Z` : null
        };
    }

    /**
     * Roughly two invoices a month across the whole window — deliberately MORE
     * than one page (the tab pages at 20), so the "Load more" control and the
     * "Showing 20 of N" line have something real to do. A fixture set that fit
     * on one page would leave that whole path unexercised.
     *
     * Most are settled; the last few stay open and one of those is past due.
     *
     * GST model matches the site's convention (reference_shipping_gst_convention
     * and the invoicing page): subtotal and freight are EX-GST, GST is 15% of
     * their sum, total is GST-inclusive. Derived from the total downward so
     * subtotal + freight + gst === total exactly, to the cent.
     */
    function buildInvoices(points) {
        const rnd = seeded(760214);
        const today = new Date();
        const rows = [];
        let n = 0;

        points.forEach((p) => {
            const perMonth = 1 + Math.floor(rnd() * 2);      // 1 or 2
            for (let k = 0; k < perMonth; k++) {
                const issue = new Date(p.period_start);
                issue.setDate(5 + k * 12 + Math.floor(rnd() * 6));
                // The newest bucket is the CURRENT month, so an unclamped day
                // can land after today and invoice for a future date.
                if (issue.getTime() > today.getTime()) continue;
                const due = new Date(issue.getFullYear(), issue.getMonth() + 1, 20);

                const total = round2((p.spend_incl_gst / perMonth) * (0.7 + rnd() * 0.35));
                const freight = rnd() > 0.55 ? 9.5 : 0;
                const exGst = round2(total / 1.15);
                const gst = round2(total - exGst);
                const subtotal = round2(exGst - freight);

                rows.push({
                    id: `demo-inv-${3300 + n}`,
                    invoice_number: `INV-${3300 + n}`,
                    issue_date: iso(issue),
                    due_date: iso(due),
                    status: 'paid',
                    paid_at: `${iso(due)}T02:31:00Z`,
                    subtotal_excl_gst: subtotal,
                    freight_excl_gst: freight,
                    gst_amount: gst,
                    total_incl_gst: total,
                    amount_outstanding: 0,
                    has_stored_pdf: false,
                    po_number: rnd() > 0.3 ? `PO-${9900 + n}` : null,
                    source_order_id: null,
                    _overdue: false
                });
                n++;
            }
        });

        // The three most recent stay open. Whether one of them is overdue is
        // DERIVED from its own due date, not asserted — the page derives the
        // same way, and a fixture that disagreed would show an "overdue" count
        // with nothing in the list marked overdue.
        rows.slice(-3).forEach((r) => {
            r.status = 'unpaid';
            r.paid_at = null;
            r.amount_outstanding = r.total_incl_gst;
            r._overdue = r.due_date < iso(today);
        });

        return rows.reverse();   // newest first, as the real list is ordered
    }

    /**
     * The outstanding tile. Every figure is derived from the invoice rows above
     * — the real endpoint exists precisely so the frontend never sums a
     * paginated list, and a fixture that disagreed with its own list would
     * fake a bug.
     */
    function buildSummary(invoices) {
        const unpaid = invoices.filter((i) => i.status === 'unpaid');
        const overdue = unpaid.filter((i) => i._overdue);
        const outstanding = sum2(unpaid, (i) => i.amount_outstanding);
        const dueDates = unpaid.map((i) => i.due_date).sort();

        return {
            outstanding_balance: outstanding,
            overdue_balance: sum2(overdue, (i) => i.amount_outstanding),
            unpaid_invoice_count: unpaid.length,
            overdue_invoice_count: overdue.length,
            oldest_due_date: dueDates[0] || null,
            credit_limit: CREDIT_LIMIT,
            credit_remaining: round2(CREDIT_LIMIT - outstanding),
            net30_approved: true,
            company_name: COMPANY,
            as_at: new Date().toISOString()
        };
    }

    function buildTopProducts(points) {
        const rnd = seeded(41177);
        const last = points[points.length - 1].period_start;
        return CATALOGUE.map((p, i) => {
            const orderCount = 9 - i + Math.floor(rnd() * 2);
            // The last tile is deliberately out of stock: a row that can't be
            // bought renders disabled WITH A REASON rather than being dropped,
            // and that state needs to be visible here too.
            const stocked = i < CATALOGUE.length - 1;
            return {
                sku: p.sku,
                name: p.name,
                product_url: p.product_url,
                quantity_ordered: orderCount * (2 + Math.floor(rnd() * 3)),
                order_count: Math.max(1, orderCount),
                last_ordered_at: `${last}T${String(9 + i).padStart(2, '0')}:05:00Z`,
                in_stock: stocked,
                purchasable: stocked
            };
        });
    }

    /**
     * `_overdue` is bookkeeping for buildSummary(), not a field the real API
     * sends. Strip it on the way out or the page could start trusting a flag
     * that will not exist against the live backend.
     */
    function publicRow(inv) {
        const copy = Object.assign({}, inv);
        delete copy._overdue;
        return copy;
    }

    /** Line items for one invoice, used by the detail panel and the PDF fallback. */
    function invoiceDetail(inv) {
        const rnd = seeded(parseInt(inv.id.replace(/\D+/g, ''), 10) || 7);
        const lines = [];
        let remaining = inv.subtotal_excl_gst;
        const count = 2 + Math.floor(rnd() * 3);
        for (let i = 0; i < count; i++) {
            const p = CATALOGUE[(i * 3 + lines.length) % CATALOGUE.length];
            const qty = 1 + Math.floor(rnd() * 5);
            const share = i === count - 1 ? remaining : round2(remaining * (0.25 + rnd() * 0.3));
            remaining = round2(remaining - share);
            lines.push({
                code: p.sku,
                description: p.name,
                qty,
                unit_price_excl_gst: round2(share / qty),
                line_total_excl_gst: share
            });
        }
        return Object.assign(publicRow(inv), {
            bill_to: {
                name: 'Aroha Ngata',
                company: COMPANY,
                email: 'accounts@example.co.nz',
                address_lines: ['Level 2, 118 Victoria Street', 'Te Aro', 'Wellington 6011']
            },
            lines,
            payment_terms: 'Net 30',
            notes: 'Demo invoice — generated locally, not a real document.',
            emailed_at: `${inv.issue_date}T04:02:00Z`
        });
    }

    function dataset() {
        if (_cache) return _cache;
        const base = buildBase();
        const monthly = aggregate(base, 'month', '', '');
        // Invoices cover only the recent tail: the list is a fixture for the
        // pager (deliberately more than one page of 20), not a full ledger.
        const invoices = buildInvoices(monthly.slice(-INVOICE_MONTHS));
        _cache = {
            base,
            monthly,
            lifetime: buildLifetime(base),
            invoices,
            summary: buildSummary(invoices),
            topProducts: buildTopProducts(monthly)
        };
        return _cache;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The banner
    // ─────────────────────────────────────────────────────────────────────────

    const BANNER_ID = 'business-demo-banner';

    /**
     * Styles are injected here rather than added to pages.css: that file's
     * cache token is shared by every page on the site, and a development-only
     * feature has no business restamping all thirty of them.
     */
    function injectStyle() {
        if (document.getElementById('business-demo-style')) return;
        const s = document.createElement('style');
        s.id = 'business-demo-style';
        s.textContent = `
#${BANNER_ID} {
    display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px;
    margin: 0 0 24px; padding: 14px 18px; border-radius: 8px;
    background: #7c2d12; color: #fff;
    border: 2px solid #f97316;
    font-size: 0.95rem; line-height: 1.45;
}
#${BANNER_ID} strong { letter-spacing: 0.06em; text-transform: uppercase; font-size: 0.8rem; }
#${BANNER_ID} a { color: #fff; text-decoration: underline; font-weight: 600; }
#${BANNER_ID} .business-demo-banner__sep { opacity: 0.55; }
#${BANNER_ID} .business-demo-banner__note {
    flex-basis: 100%; opacity: 0.85; font-size: 0.85rem;
}`;
        document.head.appendChild(s);
    }

    function renderBanner() {
        const main = document.getElementById('business-main');
        if (!main || document.getElementById(BANNER_ID)) return;
        injectStyle();

        const url = new URL(location.href);
        url.searchParams.set(PARAM, '0');

        const bar = document.createElement('div');
        bar.id = BANNER_ID;
        bar.setAttribute('role', 'status');
        bar.innerHTML =
            '<strong>Demo data</strong>' +
            '<span class="business-demo-banner__sep">·</span>' +
            '<span>Every figure on this page is generated locally for design review. ' +
            'It is not your account and none of it came from the server.</span>' +
            `<a href="${url.pathname}${url.search}${url.hash}">Turn it off</a>` +
            // The reorder tiles carry REAL SKUs and Add to cart calls the real
            // Cart.addItem, so that one button does have a real effect. Saying
            // so is cheaper than a stubbed button that quietly does nothing.
            '<span class="business-demo-banner__note">The reorder tiles use real SKUs — ' +
            '“Add to cart” really does add to your cart.</span>';
        main.insertBefore(bar, main.firstChild);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // The API surface business-page.js talks to
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Server-side filtering AND paging, mirrored. The page sends status/from/to
     * and limit/page as query parameters and does no client-side filtering, so
     * a module that ignored them would make the filter bar and the "Load more"
     * button look broken.
     *
     * `pagination.total` is the count of everything that MATCHED, before the
     * page slice — the "Showing 20 of 26" line and the Load-more visibility are
     * both computed from it, so returning the page length instead would claim
     * the first page is the whole list.
     */
    function pageInvoices(rows, params) {
        const status = params.get('status');
        const from = params.get('from');
        const to = params.get('to');
        let matched = rows.slice();
        // `overdue` and `all` are DERIVED server-side, not stored statuses:
        // `all` is every non-draft row, `overdue` is unpaid AND past due. Both
        // are offered in the status filter, so matching them literally against
        // `i.status` would return nothing and read as "you have no overdue
        // invoices" while the summary tile counts one.
        if (status === 'overdue') matched = matched.filter((i) => i.status === 'unpaid' && i._overdue);
        else if (status && status !== 'all') matched = matched.filter((i) => i.status === status);
        if (from) matched = matched.filter((i) => i.issue_date >= from);
        if (to) matched = matched.filter((i) => i.issue_date <= to);

        const limitRaw = parseInt(params.get('limit'), 10);
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : matched.length;
        const pageRaw = parseInt(params.get('page'), 10);
        const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
        const start = (page - 1) * limit;

        return {
            invoices: matched.slice(start, start + limit),
            pagination: { total: matched.length, page, limit }
        };
    }

    const BusinessDemo = {

        active() {
            // BOTH, always. Either one alone would be a production hazard.
            return isLocalHost() && optedIn();
        },

        /** The shape Business.readStatus() produces for an approved account. */
        status() {
            const s = dataset().summary;
            return {
                active: true,
                companyName: s.company_name,
                net30Approved: true,
                creditLimit: s.credit_limit,
                creditRemaining: s.credit_remaining
            };
        },

        banner: renderBanner,

        /** Public for the test harness; never call this to decide anything. */
        _dataset: dataset,

        /**
         * Same contract as BusinessPage.get(): {ok:true,data} or {ok:false,code}.
         * An unrecognised path returns a 404-ish miss rather than a fake success,
         * so a route added later shows its real error state instead of silently
         * inheriting fixtures.
         */
        get(path, expectArrayAt) {
            const [route, query] = String(path || '').split('?');
            const params = new URLSearchParams(query || '');
            const d = dataset();

            if (route === '/api/business/account/summary') {
                const s = Object.assign({}, d.summary);
                return { ok: true, data: s };
            }
            if (route === '/api/business/analytics/series') {
                return { ok: true, data: seriesFor(params) };
            }
            if (route === '/api/business/top-products') {
                const limit = parseInt(params.get('limit'), 10);
                const items = Number.isFinite(limit) && limit > 0 ? d.topProducts.slice(0, limit) : d.topProducts;
                return { ok: true, data: { items, complete: true } };
            }
            if (route === '/api/business/invoices') {
                const paged = pageInvoices(d.invoices, params);
                paged.invoices = paged.invoices.map(publicRow);
                return this._envelope(paged, expectArrayAt);
            }
            const detail = route.match(/^\/api\/business\/invoices\/([^/]+)$/);
            if (detail) {
                const inv = d.invoices.find((i) => i.id === decodeURIComponent(detail[1]));
                if (!inv) return { ok: false, code: 'NOT_FOUND' };
                return this._envelope(invoiceDetail(inv), expectArrayAt);
            }

            // An unrecognised route MISSES rather than inventing a success, so a
            // panel added later shows its real error state instead of silently
            // inheriting fixtures from a route it has nothing to do with.
            return { ok: false, code: 'NOT_FOUND' };
        },

        /** The same MALFORMED rule BusinessPage.get() applies to the real API. */
        _envelope(data, expectArrayAt) {
            if (expectArrayAt && !Array.isArray((data || {})[expectArrayAt])) {
                return { ok: false, code: 'MALFORMED' };
            }
            return { ok: true, data };
        }
    };

    if (typeof window !== 'undefined') window.BusinessDemo = BusinessDemo;
    if (typeof module !== 'undefined' && module.exports) module.exports = BusinessDemo;
})();
