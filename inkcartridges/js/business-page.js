/**
 * Business Centre — /business
 * ===========================
 *
 * The one surface an approved B2B customer gets: what their business account
 * has saved them, what they've spent, what they reorder, and their invoices —
 * so they can look an invoice up here instead of digging through their inbox.
 *
 * THREE GATE STATES, AND THE MIDDLE ONE IS THE POINT
 * --------------------------------------------------
 * Business.getStatus() folds "you are not a business account" and "we could not
 * reach the backend" into the same inactive shape. Telling a paying customer
 * they don't have a business account because a 500 happened is the ERR-139
 * failure exactly: the outage looks identical to a deliberate answer. So this
 * page reads Business._statusDegraded and renders a THIRD state — "couldn't
 * confirm, try again" — which is neither "welcome" nor "you're not eligible".
 * A signed-in user is never redirected away; a redirect makes a shared link
 * look broken and destroys the evidence of what went wrong.
 *
 * EVERY PANEL FAILS ALONE
 * -----------------------
 * Panels load independently via allSettled and each owns an error+Retry pane.
 * One dead endpoint must never blank the page, and a section that couldn't load
 * must never render as an empty state — "no invoices" and "we couldn't fetch
 * your invoices" are different sentences and the user has to get the right one.
 *
 * EACH LOADER OWNS ITS OWN TILES (ERR-141)
 * ----------------------------------------
 * The three headline tiles are fed by TWO endpoints: `saved` and `spend` come
 * from /analytics/series, `outstanding` from /account/summary. They race under
 * allSettled, so a loader that writes a tile it does not own overwrites a good
 * number with "Unavailable just now" whenever it happens to finish second.
 * loadSummary() therefore touches ONLY #stat-outstanding-*, and loadSeries()
 * (via setSeriesTiles) touches ONLY #stat-saved-* and #stat-spend-* — on
 * failure as well as success.
 *
 * MONEY
 * -----
 * Every nullable figure goes through OrderTotals.format(), which renders `—`
 * for null. formatPrice(null) returns '' — an invisible field that reads as
 * "nothing here" rather than "not reported". The headline outstanding balance
 * comes from the summary endpoint and is NEVER summed from the invoice list:
 * that list is paginated, so summing page 1 understates the debt confidently.
 *
 * ERROR CODES ARE FLAT (`res.code`), NOT `res.error.code`
 * ------------------------------------------------------
 * The backend envelope really is `{ok:false, error:{code, message}}`, but
 * js/api.js normalises it — `errorCode = data.error.code ?? data.code` — and
 * hands callers a FLAT `{ok:false, error:<message string>, code:<CODE>}`. On an
 * error envelope `res.error` is a STRING, so `res.error.code` is undefined and
 * every branch keyed off it silently takes the wrong path. Read `.code`.
 * (Pinned by tests/business-centre-aug2026.test.js §7.)
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

    const fmtDate = (iso) => {
        if (!iso) return '';
        try {
            return new Date(iso).toLocaleDateString('en-NZ', { year: 'numeric', month: 'short', day: 'numeric' });
        } catch { return ''; }
    };

    /** `null` for anything that isn't a real number. '' and undefined are NOT 0. */
    const num = (v) => (v === null || v === undefined || v === ''
        ? null
        : (Number.isFinite(Number(v)) ? Number(v) : null));

    /** Local calendar date as YYYY-MM-DD, for string-comparing date-only fields. */
    const todayISO = () => {
        const d = new Date();
        const p = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    };

    /**
     * Overdue is DERIVED, exactly as the backend derives it for `?status=overdue`:
     * unpaid AND past the due date. There is no `is_overdue` flag on a row, yet
     * the summary tile counts overdue invoices — so without this the customer is
     * told "1 overdue" and then handed a list where nothing says which one.
     *
     * Compared as YYYY-MM-DD strings on purpose: `due_date` is date-only, and
     * parsing it to a Date makes it UTC midnight, which reads as "yesterday" all
     * morning in NZ and would brand a same-day invoice overdue.
     */
    const isOverdue = (inv) => {
        if (!inv || String(inv.status || '').toLowerCase() !== 'unpaid') return false;
        const due = String(inv.due_date || '');
        if (!/^\d{4}-\d{2}-\d{2}/.test(due)) return false;
        return due.slice(0, 10) < todayISO();
    };

    const $ = (id) => document.getElementById(id);
    const show = (id, on) => { const el = $(id); if (el) el.hidden = !on; };

    const warn = (...a) => {
        if (typeof DebugLog !== 'undefined' && DebugLog && typeof DebugLog.warn === 'function') DebugLog.warn(...a);
    };

    const STATUS_LABEL = { paid: 'Paid', unpaid: 'Unpaid', void: 'Void', draft: 'Draft' };

    /** Invoices tab page size. Anything beyond it is paged in, never dropped. */
    const PAGE_SIZE = 20;

    const BusinessPage = {

        _tab: 'overview',
        _invoicesLoaded: false,
        _invoicePage: 1,
        _invoiceShown: 0,
        _detailCache: {},

        async init() {
            if (!$('business-main')) return;   // not this page

            await this.waitForAuth();

            const demo = await this.loadDemo();

            if (typeof Auth === 'undefined' || !Auth.isAuthenticated || !Auth.isAuthenticated()) {
                // A GUEST gets the explainer, not a login wall.
                //
                // This used to redirect to /account/login?redirect=/business.
                // That made the page unreachable for the one audience it most
                // needed to reach: every other B2B surface — PDP ladders, card
                // overlays, cart nudges, the account panel — already renders
                // only for a signed-in APPROVED account, so a prospective
                // business customer had NO way to discover that volume pricing
                // exists. The footer's "Business & Bulk Pricing" link led
                // straight to a sign-in form that explained nothing.
                //
                // #business-denied says exactly what they need ("this area is
                // for approved business accounts… request a quote") and carries
                // nothing account-specific, so showing it to a guest leaks
                // nothing. Signed-in-but-unapproved users already saw it.
                if (!demo) {
                    show('business-loading', false);
                    show('business-denied', true);
                    this.markGuest();
                    return;
                }
            }

            const retry = $('business-gate-retry');
            if (retry) retry.addEventListener('click', () => { Business.reset(); this.gate(); });

            document.querySelectorAll('[data-retry]').forEach((btn) => {
                btn.addEventListener('click', () => this.reload(btn.getAttribute('data-retry')));
            });
            document.querySelectorAll('[data-tab]').forEach((btn) => {
                btn.addEventListener('click', () => this.setTab(btn.getAttribute('data-tab'), true));
            });
            document.querySelectorAll('[data-tab-link]').forEach((btn) => {
                btn.addEventListener('click', () => this.setTab(btn.getAttribute('data-tab-link'), true));
            });
            ['invoice-filter-status', 'invoice-filter-from', 'invoice-filter-to'].forEach((id) => {
                const el = $(id);
                if (el) el.addEventListener('change', () => this.loadInvoices());
            });
            const clear = $('invoice-filter-clear');
            if (clear) clear.addEventListener('click', () => {
                ['invoice-filter-status', 'invoice-filter-from', 'invoice-filter-to'].forEach((id) => {
                    const el = $(id); if (el) el.value = '';
                });
                this.loadInvoices();
            });
            const more = $('invoices-more');
            if (more) more.addEventListener('click', () => this.loadInvoices(true));

            window.addEventListener('hashchange', () => this.setTab(this.readTab(), false));

            await this.gate();
        },

        /**
         * Add the sign-in route to the denied gate, for guests only.
         *
         * The gate serves two different people. A prospective customer needs
         * /quote (already in the markup). An ALREADY-APPROVED customer who is
         * simply signed out needs to be told that signing in is what turns the
         * prices on — they see plain retail everywhere and nothing on the site
         * explains why. Injected rather than shipped in the HTML so a
         * signed-in-but-unapproved user is never offered a sign-in link they
         * have already used.
         */
        markGuest() {
            const gate = $('business-denied');
            if (!gate || gate.querySelector('[data-guest-signin]')) return;
            const p = document.createElement('p');
            p.className = 'business-gate__signin';
            p.innerHTML = 'Already approved? ' +
                '<a data-guest-signin href="/account/login?redirect=/business">Sign in to see your prices.</a>';
            gate.appendChild(p);
        },

        /**
         * DEVELOPMENT ONLY — load js/business-demo.js, which fills this page with
         * generated figures so the populated layout can be reviewed on an account
         * that has no order history yet.
         *
         * The guard is repeated HERE as well as inside that module, and it has to
         * stay that way: this copy means the file is never even requested on a
         * deployed host, so fabricated money figures cannot reach a real customer
         * through a stale cache, a copied URL or a mistake in the module. Both
         * conditions are required — a dev hostname AND an explicit ?demo=1.
         *
         * @returns {Promise<boolean>} whether demo mode is on
         */
        async loadDemo() {
            const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
            if (!local) return false;

            let opted = false;
            try {
                const p = new URLSearchParams(location.search).get('demo');
                opted = p === '1' || p === 'true' ||
                    (p !== '0' && p !== 'false' && sessionStorage.getItem('ink_business_demo') === '1');
            } catch { return false; }
            if (!opted) return false;

            if (typeof BusinessDemo === 'undefined') {
                await new Promise((resolve) => {
                    const s = document.createElement('script');
                    s.src = '/js/business-demo.js';
                    s.onload = resolve;
                    s.onerror = () => { warn('[BusinessPage] demo module failed to load'); resolve(); };
                    document.head.appendChild(s);
                });
            }
            return typeof BusinessDemo !== 'undefined' && BusinessDemo.active();
        },

        /** True when the dev-only fixture module is loaded AND armed. */
        demoOn() {
            return typeof BusinessDemo !== 'undefined' && BusinessDemo.active();
        },

        /** No Auth.readyPromise in this codebase — poll Auth.initialized (50ms, 3s cap). */
        waitForAuth() {
            return new Promise((resolve) => {
                if (typeof Auth !== 'undefined' && Auth.initialized) { resolve(); return; }
                let elapsed = 0;
                const t = setInterval(() => {
                    elapsed += 50;
                    if ((typeof Auth !== 'undefined' && Auth.initialized) || elapsed >= 3000) {
                        clearInterval(t); resolve();
                    }
                }, 50);
            });
        },

        /**
         * Decide which of the three states the page is in. See the file header:
         * degraded is deliberately NOT folded into "not a business account".
         */
        async gate() {
            show('business-loading', true);
            show('business-denied', false);
            show('business-unavailable', false);
            show('business-main', false);

            // DEVELOPMENT ONLY. Demo mode owns the gate outright rather than
            // threading a flag through the three real states below — those
            // decide what a customer is told about their own account and are
            // not somewhere to add a branch that can be switched on.
            if (this.demoOn()) {
                show('business-loading', false);
                show('business-main', true);
                BusinessDemo.banner();
                this.renderAccount(BusinessDemo.status());
                this.setTab(this.readTab(), false);
                this.loadOverview();
                return;
            }

            let status;
            try {
                status = await Business.getStatus();
            } catch (e) {
                warn('[BusinessPage] status threw:', e && e.message);
                show('business-loading', false);
                show('business-unavailable', true);
                return;
            }

            show('business-loading', false);

            if (Business._statusDegraded) {
                // A non-answer. Saying "you're not a business account" here would
                // be a confident lie told by an outage.
                show('business-unavailable', true);
                return;
            }
            if (!status.active) {
                show('business-denied', true);
                return;
            }

            show('business-main', true);
            this.renderAccount(status);
            this.setTab(this.readTab(), false);
            this.loadOverview();
        },

        renderAccount(status) {
            const name = $('business-company');
            if (name) name.textContent = status.companyName || 'Business Centre';

            const net30 = $('business-net30');
            if (net30 && status.net30Approved) {
                net30.textContent = 'Net 30 approved';
                net30.hidden = false;
            }
            const credit = $('business-credit');
            // creditLimit 0 is a real answer and means "no credit"; null means
            // "not reported" and must not be rendered as a $0 limit.
            if (credit && status.creditLimit !== null && status.creditLimit > 0) {
                const remaining = status.creditRemaining !== null
                    ? ` · ${money(status.creditRemaining)} available`
                    : '';
                credit.textContent = `${money(status.creditLimit)} credit limit${remaining}`;
                credit.hidden = false;
            }
        },

        // ── Tabs ────────────────────────────────────────────────────────────

        readTab() {
            const h = (window.location.hash || '').replace(/^#/, '').split('/')[0];
            return h === 'invoices' ? 'invoices' : 'overview';
        },

        setTab(tab, push) {
            this._tab = tab === 'invoices' ? 'invoices' : 'overview';
            show('panel-overview', this._tab === 'overview');
            show('panel-invoices', this._tab === 'invoices');

            document.querySelectorAll('[data-tab]').forEach((btn) => {
                const on = btn.getAttribute('data-tab') === this._tab;
                btn.classList.toggle('business-tab--active', on);
                btn.setAttribute('aria-selected', on ? 'true' : 'false');
            });

            if (push) {
                const want = this._tab === 'invoices' ? '#invoices' : '#overview';
                if (window.location.hash !== want) history.pushState(null, '', want);
            }

            // Invoices are fetched the first time the tab is opened, not on load.
            if (this._tab === 'invoices' && !this._invoicesLoaded) {
                this._invoicesLoaded = true;
                this.loadInvoices();
            }
        },

        // ── Loading ─────────────────────────────────────────────────────────

        loadOverview() {
            // allSettled, not all: one rejected panel must not cancel the others.
            Promise.allSettled([
                this.loadSummary(),
                this.loadSeries(),
                this.loadTopProducts(),
                this.loadRecentInvoices()
            ]);
        },

        reload(what) {
            const map = {
                savings: () => this.loadSeries(),
                spend: () => this.loadSeries(),
                topProducts: () => this.loadTopProducts(),
                recentInvoices: () => this.loadRecentInvoices(),
                invoices: () => this.loadInvoices()
            };
            if (map[what]) map[what]();
        },

        /**
         * api.js maps SOME 4xx to {ok:false} envelopes and THROWS the rest, so
         * every call has to handle both shapes or a 400 takes the page down.
         *
         * `code` is FLAT — api.js already unwrapped `error.code` for us. Read the
         * file header before "fixing" this to res.error.code.
         *
         * @returns {Promise<{ok:boolean, data?:object, code?:string}>}
         */
        async get(path, expectArrayAt) {
            // DEVELOPMENT ONLY — localhost + ?demo=1. See loadDemo().
            if (this.demoOn()) return BusinessDemo.get(path, expectArrayAt);
            try {
                const res = await API.get(path);
                if (!res || res.ok === false) {
                    return { ok: false, code: (res && res.code) || 'REQUEST_FAILED' };
                }
                // A response that is missing the collection entirely is MALFORMED,
                // not empty. `[]` means "you have none"; an absent key means we
                // don't know, and rendering that as "none" is absence-as-zero
                // wearing a success envelope (ERR-063/139).
                if (expectArrayAt && !Array.isArray((res.data || {})[expectArrayAt])) {
                    warn('[BusinessPage]', path, `ok envelope without a \`${expectArrayAt}\` array`);
                    return { ok: false, code: 'MALFORMED' };
                }
                return { ok: true, data: res.data };
            } catch (e) {
                warn('[BusinessPage]', path, e && e.message);
                return { ok: false, code: (e && e.code) || 'NETWORK' };
            }
        },

        /**
         * Owns ONLY the outstanding tile. See the file header — writing the
         * saved/spend tiles from here races loadSeries() and replaces real
         * numbers with "Unavailable just now".
         */
        async loadSummary() {
            const res = await this.get('/api/business/account/summary');
            const value = $('stat-outstanding-value');
            const sub = $('stat-outstanding-sub');

            if (!res.ok) {
                // Not zero, not blank — an explicit unknown on the tile we own.
                if (value) value.textContent = '—';
                if (sub) {
                    sub.textContent = 'Unavailable just now';
                    sub.classList.remove('business-stat__sub--alert');
                }
                return;
            }
            const d = res.data || {};
            const balance = num(d.outstanding_balance);
            if (value) value.textContent = money(balance);
            if (!sub) return;

            // The counts are nullable. `Number(x) || 0` used to turn "not
            // reported" into "Nothing outstanding" — a confident claim made out
            // of missing data, and a flat contradiction whenever the balance
            // itself is rendering as `—`.
            const overdue = num(d.overdue_invoice_count);
            const unpaid = num(d.unpaid_invoice_count);
            const alert = overdue !== null && overdue > 0;
            let text;
            if (alert) text = `${overdue} overdue · ${money(num(d.overdue_balance))}`;
            else if (unpaid !== null && unpaid > 0) text = `${unpaid} unpaid`;
            else if (overdue === null && unpaid === null) text = balance === null ? 'Not reported' : '';
            else text = 'Nothing outstanding';

            sub.textContent = text;
            sub.classList.toggle('business-stat__sub--alert', alert);
        },

        /** Owns ONLY the saved + spend tiles and the two charts. */
        async loadSeries() {
            show('savings-error', false);
            show('spend-error', false);
            const res = await this.get('/api/business/analytics/series?granularity=month');
            if (!res.ok) {
                // Hide the chart frames too: an empty bordered box above an error
                // message reads as a chart that failed to draw rather than one we
                // never had data for.
                show('savings-graph', false);
                show('spend-graph', false);
                show('savings-legend', false);
                show('savings-caveat', false);
                show('savings-error', true);
                show('spend-error', true);
                show('savings-empty', false);
                show('spend-empty', false);
                this.setSeriesTiles(null);
                return;
            }
            const d = res.data || {};
            const pts = Array.isArray(d.points) ? d.points : [];
            const cov = d.coverage || {};

            const at = (p) => new Date(p.period_start).getTime();

            // A null bucket is "not recorded" and is dropped, not plotted as 0.
            // The chart is CUMULATIVE, so an unknown bucket cannot be added to a
            // running total — dropping it is the only honest option, and the
            // caveat below is what makes the resulting shortfall visible.
            const b2b = pts.map((p) => ({ t: at(p), v: num(p.b2b_savings) })).filter((p) => p.v !== null);
            const other = pts.map((p) => ({ t: at(p), v: num(p.other_savings) })).filter((p) => p.v !== null);
            const spend = pts.map((p) => ({ t: at(p), v: num(p.spend_incl_gst) })).filter((p) => p.v !== null);

            this.setSeriesTiles({ totals: d.totals || {}, coverage: cov });

            // A brand-new account gets twelve buckets of REAL zeros, not nulls.
            // Plotted, that is a flat line pinned to the axis — a chart that
            // looks like data. `orders_counted === 0` is the backend saying it
            // measured and found nothing, which is the empty state's job. An
            // account that HAS ordered but saved nothing keeps its flat line,
            // because that is a genuine result.
            const nothingToChart = num(cov.orders_counted) === 0;

            const drawnSavings = this.drawChart('savings-graph', nothingToChart, {
                ariaLabel: 'Savings over time',
                series: [
                    { modifier: 'other', points: other },
                    { modifier: 'b2b', points: b2b }
                ]
            });
            show('savings-graph', drawnSavings.rendered);
            show('savings-empty', !drawnSavings.rendered);

            const legend = $('savings-legend');
            if (legend) {
                legend.hidden = !drawnSavings.rendered;
                // NB: waived shipping is deliberately NOT part of `other_savings`
                // — the backend can't reconstruct it from recorded discounts and
                // leaves it out rather than guessing. Naming it here would claim
                // a saving this chart does not contain.
                legend.innerHTML =
                    '<span class="business-legend__item"><span class="business-legend__swatch business-legend__swatch--b2b"></span>Volume savings</span>' +
                    '<span class="business-legend__item"><span class="business-legend__swatch business-legend__swatch--other"></span>Coupons &amp; loyalty</span>';
            }

            // A partial chart has to look partial.
            const missing = num(cov.orders_missing_discount_breakdown);
            const caveat = $('savings-caveat');
            if (caveat) {
                const has = missing !== null && missing > 0;
                caveat.hidden = !has;
                caveat.textContent = has
                    ? `${missing} order${missing === 1 ? '' : 's'} couldn't be broken down by discount type, so they're not in this chart.`
                    : '';
            }

            const drawnSpend = this.drawChart('spend-graph', nothingToChart, {
                ariaLabel: 'Spend over time',
                series: [{ modifier: 'spend', points: spend }]
            });
            show('spend-graph', drawnSpend.rendered);
            show('spend-empty', !drawnSpend.rendered);
        },

        /** One chart, or an emptied host when there is measurably nothing to plot. */
        drawChart(hostId, nothingToChart, opts) {
            const host = $(hostId);
            if (nothingToChart) {
                if (host) host.innerHTML = '';
                return { rendered: false };
            }
            return SavingsChart.render(host, Object.assign({ blockClass: 'business-chart' }, opts));
        },

        /**
         * The saved + spend tiles, and nobody else's. `null` means the series
         * call failed — an explicit unknown rather than a stale figure left to
         * look current.
         */
        setSeriesTiles(payload) {
            const savedEl = $('stat-saved-value');
            const savedSub = $('stat-saved-sub');
            const spendEl = $('stat-spend-value');
            const spendSub = $('stat-spend-sub');

            if (!payload) {
                if (savedEl) savedEl.textContent = '—';
                if (savedSub) savedSub.textContent = 'Unavailable just now';
                if (spendEl) spendEl.textContent = '—';
                if (spendSub) spendSub.textContent = 'Unavailable just now';
                return;
            }

            const totals = payload.totals || {};
            const cov = payload.coverage || {};

            if (savedEl) savedEl.textContent = money(num(totals.lifetime_b2b_savings));
            const otherTotal = num(totals.lifetime_other_savings);
            if (savedSub) {
                savedSub.textContent = otherTotal !== null
                    ? `Plus ${money(otherTotal)} from coupons and loyalty`
                    : '';
            }

            if (spendEl) spendEl.textContent = money(num(totals.lifetime_spend_incl_gst));
            if (spendSub) {
                // #stat-spend-sub shipped in the markup and nothing ever wrote
                // it. Both figures are already on the payload.
                const counted = num(cov.orders_counted);
                const since = totals.first_order_at ? fmtDate(totals.first_order_at) : '';
                if (counted === null) spendSub.textContent = '';
                else if (counted === 0) spendSub.textContent = 'No orders yet';
                else spendSub.textContent = `${counted} order${counted === 1 ? '' : 's'}${since ? ` since ${since}` : ''} · incl. GST`;
            }
        },

        async loadTopProducts() {
            show('top-products-error', false);
            const res = await this.get('/api/business/top-products?limit=8', 'items');
            const list = $('top-products-list');
            if (!list) return;
            if (!res.ok) {
                list.innerHTML = '';
                show('top-products-empty', false);
                show('top-products-error', true);
                return;
            }
            const items = (res.data && res.data.items) || [];
            show('top-products-empty', items.length === 0);
            list.innerHTML = items.map((it) => {
                const buyable = it.purchasable !== false && it.in_stock !== false;
                const reason = it.in_stock === false ? 'Out of stock' : 'Unavailable';
                return `
                <article class="business-reorder__item">
                    <a class="business-reorder__name" href="${esc(it.product_url || '#')}">${esc(it.name || it.sku)}</a>
                    <p class="business-reorder__meta">${esc(it.sku)} · ordered ${esc(it.quantity_ordered)} across ${esc(it.order_count)} order${it.order_count === 1 ? '' : 's'}</p>
                    <p class="business-reorder__price" data-price-for="${esc(it.sku)}">&nbsp;</p>
                    ${buyable
                        ? `<button type="button" class="btn btn--secondary business-reorder__add" data-sku="${esc(it.sku)}">Add to cart</button>`
                        : `<button type="button" class="btn btn--secondary" disabled>${esc(reason)}</button>`}
                </article>`;
            }).join('');

            list.querySelectorAll('.business-reorder__add').forEach((btn) => {
                btn.addEventListener('click', () => {
                    // Price comes from the live cart/catalogue path — never a
                    // historical figure re-presented as today's price.
                    if (typeof Cart !== 'undefined' && Cart.addItem) Cart.addItem(btn.getAttribute('data-sku'), 1);
                });
            });

            this.decorateReorderPrices(list, items);
        },

        /**
         * Today's price on each reorder tile.
         *
         * /top-products carries NO price, deliberately — a figure from an order
         * placed in March is not what the item costs today, and re-presenting it
         * as one is exactly why the field was left off. So the price is read
         * from the live pricing path (Business.getPricing → describeLadder),
         * the same authority the PDP and the product cards use. A SKU that call
         * could not answer for renders `—`, never a guess, and nothing here
         * computes a price.
         */
        async decorateReorderPrices(root, items) {
            if (typeof Business === 'undefined' || !Business.getPricing) return;
            const skus = items.map((it) => it && it.sku).filter(Boolean);
            if (!skus.length) return;

            let pricing = null;
            try {
                pricing = await Business.getPricing(skus);
            } catch (e) {
                warn('[BusinessPage] reorder pricing', e && e.message);
            }

            const missed = new Set((pricing && pricing.missed) || []);
            root.querySelectorAll('[data-price-for]').forEach((el) => {
                const sku = el.getAttribute('data-price-for');
                const item = pricing && !missed.has(sku) ? pricing.items.get(sku) : null;
                if (!item) { el.textContent = '— price unavailable'; return; }

                const ladder = Business.describeLadder(item);
                if (ladder && ladder.entry) {
                    el.textContent = `${money(ladder.entry.businessPrice)} ea at ${Business.breakLabel(ladder.entry)}`;
                    return;
                }
                const retail = num(item.retail_price);
                el.textContent = retail !== null ? `${money(retail)} ea` : '— price unavailable';
            });
        },

        invoiceQuery(extra) {
            const p = new URLSearchParams();
            const status = ($('invoice-filter-status') || {}).value;
            const from = ($('invoice-filter-from') || {}).value;
            const to = ($('invoice-filter-to') || {}).value;
            // Filtering is SERVER-side: the list is paginated, so filtering
            // page 1 in the browser produces a confidently wrong result set.
            if (status) p.append('status', status);
            if (from) p.append('from', from);
            if (to) p.append('to', to);
            Object.entries(extra || {}).forEach(([k, v]) => p.append(k, v));
            const q = p.toString();
            return q ? `?${q}` : '';
        },

        invoiceRow(inv) {
            const status = String(inv.status || '').toLowerCase();
            const overdue = isOverdue(inv);
            const label = overdue ? 'Overdue' : (STATUS_LABEL[status] || 'Unknown');
            const cls = overdue ? 'overdue' : status;
            const due = inv.due_date ? `Due ${esc(fmtDate(inv.due_date))}` : '';
            // Operators type the prefix themselves about half the time ("PO-9921"),
            // so labelling unconditionally gives "PO PO-9921".
            const poRef = String(inv.po_number || '').trim();
            const po = poRef ? ` · ${esc(/^po\b/i.test(poRef) ? poRef : `PO ${poRef}`)}` : '';

            // `paid_at` is always null on these records, so paid-ness is read
            // from status + amount_outstanding. A part-paid invoice whose row
            // shows only the full total misstates what is actually owed.
            const outstanding = num(inv.amount_outstanding);
            const total = num(inv.total_incl_gst);
            const partial = outstanding !== null && total !== null && outstanding > 0 && outstanding !== total
                ? `<span class="business-invoice__outstanding">${esc(money(outstanding))} still owing</span>`
                : '';

            // has_stored_pdf === false means we already know there is no emailed
            // file, so this download will be a stamped reproduction. Say so
            // BEFORE the click. An absent flag changes nothing (strict === false).
            const pdfLabel = inv.has_stored_pdf === false ? 'Download copy' : 'Download PDF';

            return `
            <article class="business-invoice" data-invoice-id="${esc(inv.id)}">
                <div class="business-invoice__main">
                    <p class="business-invoice__number">${esc(inv.invoice_number || 'Invoice')}</p>
                    <p class="business-invoice__meta">${esc(fmtDate(inv.issue_date))}${due ? ' · ' + due : ''}${po}</p>
                </div>
                <p class="business-invoice__total">${esc(money(total))}${partial}</p>
                <p class="business-invoice__status business-invoice__status--${esc(cls)}">${esc(label)}</p>
                <div class="business-invoice__actions">
                    <button type="button" class="btn btn--secondary business-invoice__toggle" data-detail="${esc(inv.id)}" aria-expanded="false">View details</button>
                    <button type="button" class="btn btn--secondary business-invoice__pdf" data-pdf="${esc(inv.id)}" data-number="${esc(inv.invoice_number || '')}">${esc(pdfLabel)}</button>
                </div>
                <p class="business-invoice__note" data-note="${esc(inv.id)}" hidden></p>
                <div class="business-invoice__detail" data-detail-body="${esc(inv.id)}" hidden></div>
            </article>`;
        },

        wirePdf(root) {
            root.querySelectorAll('[data-pdf]').forEach((btn) => {
                if (btn.dataset.wired === '1') return;   // rows are appended, not replaced
                btn.dataset.wired = '1';
                btn.addEventListener('click', async () => {
                    const id = btn.getAttribute('data-pdf');
                    const note = root.querySelector(`[data-note="${id}"]`);
                    const label = btn.textContent;
                    btn.disabled = true;
                    btn.textContent = 'Preparing…';
                    if (note) { note.hidden = true; note.textContent = ''; }
                    const out = await BusinessInvoicePdf.download(id, btn.getAttribute('data-number'));
                    btn.disabled = false;
                    btn.textContent = label;
                    if (!note) return;
                    if (!out.ok) {
                        note.hidden = false;
                        note.textContent = out.message;
                    } else if (out.source === 'generated') {
                        // The substitution has to be visible on the PAGE, not
                        // only stamped inside the file. Handing someone a
                        // re-rendered document while the UI says nothing lets
                        // them believe it is the file we emailed.
                        note.hidden = false;
                        note.textContent = "We didn't have the emailed file for this one, so we've made you a copy — it's stamped as a reproduction.";
                    }
                });
            });
        },

        /**
         * The §4 detail payload — bill_to, lines, terms, notes, emailed_at — was
         * being fetched only by the PDF fallback and shown nowhere. This is the
         * panel that makes an invoice readable without downloading anything.
         */
        wireDetails(root) {
            root.querySelectorAll('[data-detail]').forEach((btn) => {
                if (btn.dataset.wired === '1') return;
                btn.dataset.wired = '1';
                btn.addEventListener('click', () => this.toggleDetail(root, btn));
            });
        },

        async toggleDetail(root, btn) {
            const id = btn.getAttribute('data-detail');
            const body = root.querySelector(`[data-detail-body="${id}"]`);
            if (!body) return;

            if (!body.hidden) {
                body.hidden = true;
                btn.setAttribute('aria-expanded', 'false');
                btn.textContent = 'View details';
                return;
            }

            body.hidden = false;
            btn.setAttribute('aria-expanded', 'true');
            btn.textContent = 'Hide details';

            if (this._detailCache[id]) { body.innerHTML = this._detailCache[id]; return; }

            body.innerHTML = '<p class="business-detail__loading">Loading invoice&hellip;</p>';
            const res = await this.get(`/api/business/invoices/${encodeURIComponent(id)}`, 'lines');
            if (!res.ok) {
                // The code is finally READ here: "that isn't yours" and "we
                // couldn't fetch it" are different sentences, and only one of
                // them is worth offering a Retry for.
                const denied = res.code === 'FORBIDDEN';
                const msg = denied
                    ? "That invoice isn't on your account."
                    : "We couldn't load this invoice's details.";
                body.innerHTML = `<p class="business-detail__error">${esc(msg)}</p>`;
                if (!denied) {
                    const again = document.createElement('button');
                    again.type = 'button';
                    again.className = 'btn btn--secondary';
                    again.textContent = 'Retry';
                    again.addEventListener('click', () => {
                        body.hidden = true;                 // toggleDetail re-opens it
                        btn.setAttribute('aria-expanded', 'false');
                        this.toggleDetail(root, btn);
                    });
                    body.appendChild(again);
                }
                return;
            }
            const html = this.detailMarkup(res.data || {});
            this._detailCache[id] = html;
            body.innerHTML = html;
        },

        detailMarkup(d) {
            const bill = d.bill_to || {};
            const addr = Array.isArray(bill.address_lines) ? bill.address_lines : [];
            const lines = Array.isArray(d.lines) ? d.lines : [];

            const facts = [];
            if (d.po_number) facts.push(`<div><dt>PO number</dt><dd>${esc(d.po_number)}</dd></div>`);
            if (d.payment_terms) facts.push(`<div><dt>Payment terms</dt><dd>${esc(d.payment_terms)}</dd></div>`);
            if (d.due_date) facts.push(`<div><dt>Due</dt><dd>${esc(fmtDate(d.due_date))}</dd></div>`);
            if (d.emailed_at) facts.push(`<div><dt>Emailed to you</dt><dd>${esc(fmtDate(d.emailed_at))}</dd></div>`);

            const billBlock = (bill.company || bill.name || addr.length)
                ? `<div class="business-detail__billto">
                        <p class="business-detail__label">Billed to</p>
                        ${bill.company ? `<p>${esc(bill.company)}</p>` : ''}
                        ${bill.name && bill.name !== bill.company ? `<p>${esc(bill.name)}</p>` : ''}
                        ${addr.map((l) => `<p>${esc(l)}</p>`).join('')}
                        ${bill.email ? `<p>${esc(bill.email)}</p>` : ''}
                   </div>`
                : '';

            // `unit_price_excl_gst` is the SELL price. The internal record calls
            // the same number unit_cost_excl_gst and stores what WE paid one
            // word away from it — the customer contract uses the unambiguous
            // name, and this renderer reads nothing else.
            const rows = lines.map((l) => `
                <tr>
                    <td>${esc(l.code || '')}</td>
                    <td>${esc(l.description || '')}</td>
                    <td class="business-detail__num">${esc(l.qty ?? '')}</td>
                    <td class="business-detail__num">${esc(money(num(l.unit_price_excl_gst)))}</td>
                    <td class="business-detail__num">${esc(money(num(l.line_total_excl_gst)))}</td>
                </tr>`).join('');

            const table = lines.length
                ? `<div class="business-detail__scroll">
                    <table class="business-detail__lines">
                        <thead><tr><th>Code</th><th>Description</th><th class="business-detail__num">Qty</th><th class="business-detail__num">Unit (excl GST)</th><th class="business-detail__num">Total (excl GST)</th></tr></thead>
                        <tbody>${rows}</tbody>
                    </table>
                   </div>`
                : '<p class="business-detail__empty">This invoice has no line items.</p>';

            const freight = (d.freight_excl_gst === null || d.freight_excl_gst === undefined)
                ? ''
                : `<div><dt>Freight (excl GST)</dt><dd>${esc(money(num(d.freight_excl_gst)))}</dd></div>`;

            return `
                ${facts.length ? `<dl class="business-detail__facts">${facts.join('')}</dl>` : ''}
                ${billBlock}
                ${table}
                <dl class="business-detail__totals">
                    <div><dt>Subtotal (excl GST)</dt><dd>${esc(money(num(d.subtotal_excl_gst)))}</dd></div>
                    ${freight}
                    <div><dt>GST</dt><dd>${esc(money(num(d.gst_amount)))}</dd></div>
                    <div class="business-detail__grand"><dt>Total (incl GST)</dt><dd>${esc(money(num(d.total_incl_gst)))}</dd></div>
                </dl>
                ${d.notes ? `<p class="business-detail__notes">${esc(d.notes)}</p>` : ''}`;
        },

        async loadRecentInvoices() {
            show('recent-invoices-error', false);
            const res = await this.get('/api/business/invoices?limit=5', 'invoices');
            const list = $('recent-invoices-list');
            if (!list) return;
            if (!res.ok) {
                list.innerHTML = '';
                show('recent-invoices-empty', false);
                show('recent-invoices-error', true);
                return;
            }
            const items = (res.data && res.data.invoices) || [];
            show('recent-invoices-empty', items.length === 0);
            list.innerHTML = items.map((i) => this.invoiceRow(i)).join('');
            this.wirePdf(list);
            this.wireDetails(list);
        },

        /**
         * @param {boolean} [append]  true = "Load more" (next page); false/absent
         *                            = a fresh query starting at page 1
         */
        async loadInvoices(append) {
            show('invoices-error', false);
            const list = $('invoices-list');
            if (!list) return;

            if (append) {
                this._invoicePage += 1;
            } else {
                this._invoicePage = 1;
                this._invoiceShown = 0;
                list.innerHTML = '';
            }
            show('invoices-more', false);

            const res = await this.get(
                '/api/business/invoices' + this.invoiceQuery({ limit: PAGE_SIZE, page: this._invoicePage }),
                'invoices'
            );
            if (!res.ok) {
                // "We couldn't load them" and "you have none" are different
                // sentences; never show the empty state for a failed fetch.
                if (append) this._invoicePage -= 1;   // that page was never shown
                show('invoices-empty', false);
                show('invoices-error', true);
                show('invoices-more', this._invoiceShown > 0);
                return;
            }

            const items = (res.data && res.data.invoices) || [];
            const total = num(((res.data && res.data.pagination) || {}).total);
            this._invoiceShown += items.length;

            const filtered = !!(($('invoice-filter-status') || {}).value || ($('invoice-filter-from') || {}).value || ($('invoice-filter-to') || {}).value);
            const emptyMsg = $('invoices-empty-msg');
            if (emptyMsg) {
                // "No invoices yet." is a claim, and for a customer who HAS been
                // invoiced but whose invoices aren't linked to their account it
                // is a false one. Give the state a way out.
                emptyMsg.innerHTML = filtered
                    ? 'No invoices match those filters.'
                    : "No invoices yet. If you've been invoiced recently and don't see it here, <a href=\"/contact\">let us know</a> and we'll connect it to your account.";
            }
            show('invoices-empty', this._invoiceShown === 0);

            list.insertAdjacentHTML('beforeend', items.map((i) => this.invoiceRow(i)).join(''));
            this.wirePdf(list);
            this.wireDetails(list);

            // No silent cap. Say how much of the list is on screen, and never let
            // a page limit quietly stand in for "that is all of them".
            const summary = $('invoices-summary');
            if (summary) {
                if (this._invoiceShown === 0) summary.textContent = '';
                else if (total === null) summary.textContent = `Showing ${this._invoiceShown} invoices`;
                else summary.textContent = `Showing ${this._invoiceShown} of ${total} invoice${total === 1 ? '' : 's'}`;
            }
            show('invoices-more', total !== null && this._invoiceShown < total);
        }
    };

    if (typeof window !== 'undefined') window.BusinessPage = BusinessPage;

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => BusinessPage.init());
        } else {
            BusinessPage.init();
        }
    }
})();
