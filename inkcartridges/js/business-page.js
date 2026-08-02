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
 * MONEY
 * -----
 * Every nullable figure goes through OrderTotals.format(), which renders `—`
 * for null. formatPrice(null) returns '' — an invisible field that reads as
 * "nothing here" rather than "not reported". The headline outstanding balance
 * comes from the summary endpoint and is NEVER summed from the invoice list:
 * that list is paginated, so summing page 1 understates the debt confidently.
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

    const $ = (id) => document.getElementById(id);
    const show = (id, on) => { const el = $(id); if (el) el.hidden = !on; };

    const warn = (...a) => {
        if (typeof DebugLog !== 'undefined' && DebugLog && typeof DebugLog.warn === 'function') DebugLog.warn(...a);
    };

    const STATUS_LABEL = { paid: 'Paid', unpaid: 'Unpaid', void: 'Void', draft: 'Draft' };

    const BusinessPage = {

        _tab: 'overview',
        _invoicesLoaded: false,

        async init() {
            if (!$('business-main')) return;   // not this page

            await this.waitForAuth();

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
                show('business-loading', false);
                show('business-denied', true);
                this.markGuest();
                return;
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
         * @returns {Promise<{ok:boolean, data?:object, code?:string}>}
         */
        async get(path, expectArrayAt) {
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

        async loadSummary() {
            const res = await this.get('/api/business/account/summary');
            const set = (id, v, sub) => {
                const el = $(id); if (el) el.textContent = v;
                if (sub !== undefined) { const s = $(id + '-sub'); if (s) s.textContent = sub; }
            };
            if (!res.ok) {
                // Not zero, not blank — an explicit unknown on each tile.
                set('stat-saved-value', '—', 'Unavailable just now');
                set('stat-spend-value', '—', 'Unavailable just now');
                set('stat-outstanding-value', '—', 'Unavailable just now');
                return;
            }
            const d = res.data || {};
            set('stat-outstanding-value', money(d.outstanding_balance));
            const overdue = Number(d.overdue_invoice_count) || 0;
            const outSub = $('stat-outstanding-sub');
            if (outSub) {
                outSub.textContent = overdue > 0
                    ? `${overdue} overdue · ${money(d.overdue_balance)}`
                    : (d.unpaid_invoice_count ? `${d.unpaid_invoice_count} unpaid` : 'Nothing outstanding');
                outSub.classList.toggle('business-stat__sub--alert', overdue > 0);
            }
        },

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
                return;
            }
            const d = res.data || {};
            const pts = Array.isArray(d.points) ? d.points : [];
            const totals = d.totals || {};

            const at = (p) => new Date(p.period_start).getTime();
            const num = (v) => (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

            // A null bucket is "not recorded" and is dropped, not plotted as 0.
            const b2b = pts.map((p) => ({ t: at(p), v: num(p.b2b_savings) })).filter((p) => p.v !== null);
            const other = pts.map((p) => ({ t: at(p), v: num(p.other_savings) })).filter((p) => p.v !== null);
            const spend = pts.map((p) => ({ t: at(p), v: num(p.spend_incl_gst) })).filter((p) => p.v !== null);

            const savedTotal = num(totals.lifetime_b2b_savings);
            const otherTotal = num(totals.lifetime_other_savings);
            const savedEl = $('stat-saved-value');
            if (savedEl) savedEl.textContent = money(savedTotal);
            const savedSub = $('stat-saved-sub');
            if (savedSub) {
                savedSub.textContent = otherTotal !== null
                    ? `Plus ${money(otherTotal)} from coupons, loyalty and shipping`
                    : '';
            }
            const spendEl = $('stat-spend-value');
            if (spendEl) spendEl.textContent = money(num(totals.lifetime_spend_incl_gst));

            const drawnSavings = SavingsChart.render($('savings-graph'), {
                blockClass: 'business-chart',
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
                legend.innerHTML =
                    '<span class="business-legend__item"><span class="business-legend__swatch business-legend__swatch--b2b"></span>Volume savings</span>' +
                    '<span class="business-legend__item"><span class="business-legend__swatch business-legend__swatch--other"></span>Coupons, loyalty &amp; shipping</span>';
            }

            // A partial chart has to look partial.
            const cov = d.coverage || {};
            const missing = Number(cov.orders_missing_discount_breakdown) || 0;
            const caveat = $('savings-caveat');
            if (caveat) {
                caveat.hidden = missing === 0;
                caveat.textContent = missing > 0
                    ? `${missing} order${missing === 1 ? '' : 's'} couldn't be broken down by discount type, so they're not in this chart.`
                    : '';
            }

            const drawnSpend = SavingsChart.render($('spend-graph'), {
                blockClass: 'business-chart',
                ariaLabel: 'Spend over time',
                series: [{ modifier: 'spend', points: spend }]
            });
            show('spend-graph', drawnSpend.rendered);
            show('spend-empty', !drawnSpend.rendered);
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
            const label = STATUS_LABEL[status] || 'Unknown';
            const due = inv.due_date ? `Due ${esc(fmtDate(inv.due_date))}` : '';
            return `
            <article class="business-invoice" data-invoice-id="${esc(inv.id)}">
                <div class="business-invoice__main">
                    <p class="business-invoice__number">${esc(inv.invoice_number || 'Invoice')}</p>
                    <p class="business-invoice__meta">${esc(fmtDate(inv.issue_date))}${due ? ' · ' + due : ''}</p>
                </div>
                <p class="business-invoice__total">${money(inv.total_incl_gst)}</p>
                <p class="business-invoice__status business-invoice__status--${esc(status)}">${esc(label)}</p>
                <button type="button" class="btn btn--secondary business-invoice__pdf" data-pdf="${esc(inv.id)}" data-number="${esc(inv.invoice_number || '')}">Download PDF</button>
                <p class="business-invoice__note" data-note="${esc(inv.id)}" hidden></p>
            </article>`;
        },

        wirePdf(root) {
            root.querySelectorAll('[data-pdf]').forEach((btn) => {
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
                    if (!out.ok && note) {
                        note.hidden = false;
                        note.textContent = out.message;
                    }
                });
            });
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
        },

        async loadInvoices() {
            show('invoices-error', false);
            const list = $('invoices-list');
            if (!list) return;
            list.innerHTML = '';
            const res = await this.get('/api/business/invoices' + this.invoiceQuery({ limit: 50 }), 'invoices');
            if (!res.ok) {
                // "We couldn't load them" and "you have none" are different
                // sentences; never show the empty state for a failed fetch.
                show('invoices-empty', false);
                show('invoices-error', true);
                return;
            }
            const items = (res.data && res.data.invoices) || [];
            const filtered = !!(($('invoice-filter-status') || {}).value || ($('invoice-filter-from') || {}).value || ($('invoice-filter-to') || {}).value);
            const emptyMsg = $('invoices-empty-msg');
            if (emptyMsg) emptyMsg.textContent = filtered ? 'No invoices match those filters.' : 'No invoices yet.';
            show('invoices-empty', items.length === 0);
            list.innerHTML = items.map((i) => this.invoiceRow(i)).join('');
            this.wirePdf(list);
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
