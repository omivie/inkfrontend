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

    const discountLabel = (c) => {
        if (!c) return '';
        if (c.discount_type === 'fixed_amount') return `${fmtMoney(c.discount_value)} off`;
        if (c.discount_type === 'percentage') return `${Number(c.discount_value)}% off`;
        return 'Discount';
    };

    // Ledger row labels (spec §3)
    const TYPE_LABEL = {
        earn: 'Earned',
        bonus: 'Bonus',
        redeem: 'Redeemed',
        clawback: 'Reversed',
        restore: 'Restored',
        adjust: 'Adjustment'
    };

    const LoyaltyPage = {
        loyalty: null,
        ledger: [],
        orders: [],
        coupons: [],
        page: 1,
        totalPages: 1,

        async init() {
            await this.waitForAuth();
            if (!Auth.isAuthenticated()) {
                window.location.href = '/account/login?redirect=/account/loyalty';
                return;
            }

            this.bindInfoModal();

            try {
                const [loyaltySettled, couponsSettled, ordersSettled] = await Promise.allSettled([
                    API.getLoyalty({ page: 1, limit: 20 }),
                    API.getLoyaltyCoupons(),
                    API.getOrders({ limit: 200 })
                ]);

                // Coupons + orders are independent of the points-balance endpoint, so
                // they still populate the rewards list and the order-savings graph line
                // even if /api/user/loyalty isn't live yet.
                this.coupons = (couponsSettled.status === 'fulfilled' && Array.isArray(couponsSettled.value?.data))
                    ? couponsSettled.value.data : [];
                const od = (ordersSettled.status === 'fulfilled') ? ordersSettled.value?.data : null;
                this.orders = Array.isArray(od) ? od : (Array.isArray(od?.orders) ? od.orders : []);

                // Points balance + ledger. May be unavailable (e.g. GET /api/user/loyalty
                // not deployed yet) — degrade gracefully rather than blanking the page.
                const res = (loyaltySettled.status === 'fulfilled') ? loyaltySettled.value : null;
                const loyaltyOk = !!(res && res.ok !== false && res.data);
                if (loyaltyOk) {
                    this.loyalty = res.data;
                    this.ledger = Array.isArray(res.data.ledger) ? res.data.ledger : [];
                    this.page = (res.meta && res.meta.page) || 1;
                    this.totalPages = (res.meta && res.meta.total_pages) || 1;
                } else {
                    this.loyalty = null;
                    this.ledger = [];
                    if (typeof DebugLog !== 'undefined') {
                        DebugLog.warn('Loyalty balance unavailable:', loyaltySettled.reason || (res && res.error));
                    }
                }

                document.getElementById('loyalty-loading').hidden = true;

                // Program switched off entirely — show a neutral notice and stop.
                if (loyaltyOk && this.loyalty.program_active === false) {
                    const off = document.getElementById('loyalty-disabled');
                    if (off) off.hidden = false;
                    return;
                }

                // Nothing at all to show (points down AND no orders AND no coupons) → hard error.
                if (!loyaltyOk && !this.orders.length && !this.coupons.length) {
                    document.getElementById('loyalty-error').hidden = false;
                    return;
                }

                if (loyaltyOk) {
                    this.setInfoCopy();
                    const balance = this.loyalty.points_balance || 0;
                    if (balance === 0 && !this.ledger.length && !this.coupons.length) {
                        const empty = document.getElementById('loyalty-empty');
                        if (empty) empty.hidden = false;
                        this.renderBalance();
                        return;
                    }
                    this.renderBalance();
                    this.renderHistory();
                } else {
                    // Soft, honest notice: points balance/history need the backend endpoint.
                    const notice = document.getElementById('loyalty-balance-unavailable');
                    if (notice) notice.hidden = false;
                }

                // Graph renders from whatever is available — the order-savings line comes
                // from /api/orders alone; the points-accrued line needs the ledger.
                this.renderGraph();
                this.renderCoupons();
            } catch (err) {
                if (typeof DebugLog !== 'undefined') DebugLog.error('Loyalty load failed:', err);
                document.getElementById('loyalty-loading').hidden = true;
                document.getElementById('loyalty-error').hidden = false;
            }
        },

        async waitForAuth(timeout = 5000) {
            const start = Date.now();
            while (typeof Auth === 'undefined' || Auth.isAuthenticated === undefined) {
                if (Date.now() - start > timeout) return;
                await new Promise((r) => setTimeout(r, 50));
            }
            if (typeof Auth.waitForReady === 'function') {
                try { await Auth.waitForReady(); } catch {}
            } else {
                await new Promise((r) => setTimeout(r, 300));
            }
        },

        setInfoCopy() {
            const el = document.getElementById('loyalty-info-text');
            if (!el) return;
            const rate = this.loyalty.redemption_rate || 100;
            const min = this.loyalty.min_redemption_points || 500;
            el.textContent = `Earn 1 point for every $1 you spend (excluding shipping), credited once your order is paid. `
                + `${rate} points = $1. Redeem from ${min} points directly at checkout — just hit “Use loyalty points”.`;
        },

        renderBalance() {
            const section = document.getElementById('loyalty-balance-section');
            if (!section) return;
            const rate = this.loyalty.redemption_rate || 100;
            const balance = this.loyalty.points_balance || 0;
            const valueDollars = (this.loyalty.points_value_dollars != null)
                ? this.loyalty.points_value_dollars
                : balance / rate;
            const lifetime = this.loyalty.lifetime_earned || 0;

            const ptsEl = document.getElementById('loyalty-balance-points');
            const valEl = document.getElementById('loyalty-balance-value');
            const lifeEl = document.getElementById('loyalty-balance-lifetime');
            if (ptsEl) ptsEl.textContent = `${balance.toLocaleString('en-NZ')}`;
            if (valEl) valEl.textContent = `${fmtMoney(valueDollars)} to spend`;
            if (lifeEl) lifeEl.textContent = lifetime ? `${lifetime.toLocaleString('en-NZ')} points earned all-time` : '';

            section.hidden = false;
        },

        /**
         * Inline SVG dual-line chart (no external library).
         * Series A — cumulative dollar value of points accrued (ledger earn + bonus).
         * Series B — cumulative order savings (order subtotal − total).
         * Both are derived client-side; the order-savings line is total discount per
         * order (it can't be split by type without a backend field).
         */
        renderGraph() {
            const host = document.getElementById('loyalty-graph');
            const legend = document.getElementById('loyalty-graph-legend');
            const emptyEl = document.getElementById('loyalty-graph-empty');
            const section = document.getElementById('loyalty-graph-section');
            if (!host || !section) return;
            section.hidden = false;

            const rate = (this.loyalty && this.loyalty.redemption_rate) || 100;

            const accrual = this.ledger
                .filter((r) => (r.type === 'earn' || r.type === 'bonus') && r.points > 0 && r.created_at)
                .map((r) => ({ t: new Date(r.created_at).getTime(), v: r.points / rate }))
                .filter((p) => !isNaN(p.t))
                .sort((a, b) => a.t - b.t);

            // Per-order savings comes from the dedicated discount_amount column
            // (coupon + loyalty + B2B combined). NOT subtotal − total: in this data
            // model subtotal is ex-GST and total includes GST + shipping, so that
            // subtraction goes negative. discount_amount is 0 when no discount applied.
            const savings = this.orders
                .map((o) => ({ t: new Date(o.created_at).getTime(), v: Math.max(0, Number(o.discount_amount) || 0) }))
                .filter((p) => !isNaN(p.t) && p.v > 0)
                .sort((a, b) => a.t - b.t);

            const cum = (arr) => { let s = 0; return arr.map((p) => ({ t: p.t, v: (s += p.v) })); };
            const seriesA = cum(accrual);
            const seriesB = cum(savings);

            if (!seriesA.length && !seriesB.length) {
                host.innerHTML = '';
                if (legend) legend.hidden = true;
                if (emptyEl) emptyEl.hidden = false;
                return;
            }
            if (emptyEl) emptyEl.hidden = true;
            if (legend) legend.hidden = false;

            const allT = [...seriesA, ...seriesB].map((p) => p.t);
            const allV = [...seriesA, ...seriesB].map((p) => p.v);
            const minT = Math.min(...allT);
            const maxT = Math.max(...allT);
            const maxV = Math.max(1, ...allV);
            const spanT = (maxT - minT) || 1;

            const W = 600, H = 240, padL = 48, padR = 14, padT = 14, padB = 30;
            const x = (t) => padL + ((t - minT) / spanT) * (W - padL - padR);
            const y = (v) => (H - padB) - (v / maxV) * (H - padT - padB);

            const toPoly = (s) => {
                if (!s.length) return '';
                const pts = [];
                if (s[0].t > minT) pts.push(`${x(minT).toFixed(1)},${y(0).toFixed(1)}`);
                s.forEach((p) => pts.push(`${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`));
                const last = s[s.length - 1];
                if (last.t < maxT) pts.push(`${x(maxT).toFixed(1)},${y(last.v).toFixed(1)}`);
                return pts.join(' ');
            };

            const polyA = toPoly(seriesA);
            const polyB = toPoly(seriesB);
            const baselineY = y(0).toFixed(1);

            const startLabel = esc(fmtDate(new Date(minT).toISOString()));
            const endLabel = esc(fmtDate(new Date(maxT).toISOString()));
            const maxLabel = esc(fmtMoney(maxV));

            host.innerHTML = `
                <svg class="loyalty-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Loyalty value and order savings over time">
                    <line class="loyalty-chart__axis" x1="${padL}" y1="${padT}" x2="${padL}" y2="${baselineY}"></line>
                    <line class="loyalty-chart__axis" x1="${padL}" y1="${baselineY}" x2="${W - padR}" y2="${baselineY}"></line>
                    <text class="loyalty-chart__tick" x="${padL - 6}" y="${(padT + 8).toFixed(1)}" text-anchor="end">${maxLabel}</text>
                    <text class="loyalty-chart__tick" x="${padL - 6}" y="${baselineY}" text-anchor="end">$0</text>
                    <text class="loyalty-chart__tick" x="${padL}" y="${H - 8}" text-anchor="start">${startLabel}</text>
                    <text class="loyalty-chart__tick" x="${W - padR}" y="${H - 8}" text-anchor="end">${endLabel}</text>
                    ${polyB ? `<polyline class="loyalty-chart__line loyalty-chart__line--savings" points="${polyB}" fill="none"></polyline>` : ''}
                    ${polyA ? `<polyline class="loyalty-chart__line loyalty-chart__line--accrued" points="${polyA}" fill="none"></polyline>` : ''}
                </svg>
            `;

            if (legend) {
                legend.innerHTML = `
                    <span class="loyalty-legend__item"><span class="loyalty-legend__swatch loyalty-legend__swatch--accrued"></span>Points value earned</span>
                    <span class="loyalty-legend__item"><span class="loyalty-legend__swatch loyalty-legend__swatch--savings"></span>Order savings</span>
                `;
            }
        },

        renderHistory() {
            const section = document.getElementById('loyalty-history-section');
            const list = document.getElementById('loyalty-history-list');
            const empty = document.getElementById('loyalty-history-empty');
            const moreBtn = document.getElementById('loyalty-history-more');
            if (!section || !list) return;
            section.hidden = false;

            if (!this.ledger.length) {
                list.innerHTML = '';
                if (empty) empty.hidden = false;
                if (moreBtn) moreBtn.hidden = true;
                return;
            }
            if (empty) empty.hidden = true;

            list.innerHTML = this.ledger.map((row) => {
                const label = TYPE_LABEL[row.type] || row.type || 'Activity';
                const pts = Number(row.points) || 0;
                const sign = pts > 0 ? '+' : '';
                const dir = pts > 0 ? 'pos' : (pts < 0 ? 'neg' : 'zero');
                const after = (row.balance_after != null) ? `Balance ${Number(row.balance_after).toLocaleString('en-NZ')}` : '';
                return `
                    <li class="loyalty-ledger">
                        <div class="loyalty-ledger__main">
                            <span class="loyalty-ledger__label">${esc(label)}</span>
                            <span class="loyalty-ledger__date">${esc(fmtDate(row.created_at))}</span>
                        </div>
                        <div class="loyalty-ledger__amounts">
                            <span class="loyalty-ledger__points loyalty-ledger__points--${dir}">${sign}${pts.toLocaleString('en-NZ')} pts</span>
                            <span class="loyalty-ledger__balance">${esc(after)}</span>
                        </div>
                    </li>
                `;
            }).join('');

            if (moreBtn) {
                if (this.page < this.totalPages) {
                    moreBtn.hidden = false;
                    moreBtn.disabled = false;
                } else {
                    moreBtn.hidden = true;
                }
            }
        },

        async loadMoreHistory(btn) {
            if (this.page >= this.totalPages) return;
            const next = this.page + 1;
            if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
            try {
                const res = await API.getLoyalty({ page: next, limit: 20 });
                const rows = (res && res.data && Array.isArray(res.data.ledger)) ? res.data.ledger : [];
                this.ledger = this.ledger.concat(rows);
                this.page = (res.meta && res.meta.page) || next;
                this.totalPages = (res.meta && res.meta.total_pages) || this.totalPages;
                this.renderHistory();
            } catch (err) {
                if (typeof DebugLog !== 'undefined') DebugLog.warn('Load more ledger failed:', err && err.message);
                if (btn) { btn.disabled = false; btn.textContent = 'Load more'; }
            }
        },

        renderCoupons() {
            const section = document.getElementById('loyalty-rewards-section');
            const list = document.getElementById('loyalty-rewards-list');
            const empty = document.getElementById('loyalty-rewards-empty');
            if (!section || !list) return;
            section.hidden = false;

            const rows = this.coupons || [];
            if (!rows.length) {
                list.innerHTML = '';
                if (empty) empty.hidden = false;
                return;
            }
            if (empty) empty.hidden = true;

            const statusLabel = { active: 'Active', used: 'Redeemed', expired: 'Expired', deactivated: 'Inactive' };

            list.innerHTML = rows.map((row) => {
                const c = (row && row.coupon) ? row.coupon : (row || {});
                let status = row && row.status;
                if (!status) {
                    status = c.is_used ? 'used' : (c.is_expired ? 'expired' : (c.is_active === false ? 'deactivated' : 'active'));
                }
                const canCopy = status === 'active';
                const conditions = [];
                if (c.minimum_order_amount) conditions.push(`Valid on orders over ${fmtMoney(c.minimum_order_amount)}`);
                if (c.exclude_genuine) conditions.push('Compatible products only');
                if (c.expires_at) conditions.push(`Expires ${fmtDate(c.expires_at)}`);
                conditions.push('Single use');

                return `
                    <article class="loyalty-reward loyalty-reward--${esc(status)}">
                        <header class="loyalty-reward__head">
                            <span class="loyalty-reward__tier">Reward coupon</span>
                            <span class="loyalty-reward__status loyalty-reward__status--${esc(status)}">${esc(statusLabel[status] || status)}</span>
                        </header>
                        <div class="loyalty-reward__code-row">
                            <code class="loyalty-reward__code">${esc(c.code || '')}</code>
                            ${canCopy ? `<button type="button" class="btn btn--secondary loyalty-reward__copy" data-code="${esc(c.code || '')}">Copy code</button>` : ''}
                        </div>
                        <p class="loyalty-reward__discount">${esc(discountLabel(c))}${c.description ? ' — ' + esc(c.description) : ''}</p>
                        <ul class="loyalty-reward__conditions">
                            ${conditions.map((t) => `<li>${esc(t)}</li>`).join('')}
                        </ul>
                    </article>
                `;
            }).join('');

            list.querySelectorAll('.loyalty-reward__copy').forEach((btn) => {
                btn.addEventListener('click', () => this.copyCode(btn.dataset.code, btn));
            });
        },

        async copyCode(code, btn) {
            if (!code) return;
            try {
                await navigator.clipboard.writeText(code);
                this.toast(`Copied ${code}`);
                const original = btn.textContent;
                btn.textContent = 'Copied!';
                btn.disabled = true;
                setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1800);
            } catch {
                this.toast('Press ⌘/Ctrl+C to copy');
            }
        },

        toast(msg) {
            const el = document.getElementById('loyalty-toast');
            if (!el) return;
            el.textContent = msg;
            el.hidden = false;
            clearTimeout(this._toastT);
            this._toastT = setTimeout(() => { el.hidden = true; }, 2200);
        },

        bindInfoModal() {
            const btn = document.getElementById('loyalty-info-btn');
            const modal = document.getElementById('loyalty-info-modal');
            const closeBtn = document.getElementById('loyalty-info-close');
            const backdrop = modal?.querySelector('.modal__backdrop');
            if (!btn || !modal) return;

            const open = () => { modal.hidden = false; document.body.style.overflow = 'hidden'; };
            const close = () => { modal.hidden = true; document.body.style.overflow = ''; };

            btn.addEventListener('click', open);
            closeBtn?.addEventListener('click', close);
            backdrop?.addEventListener('click', close);
            document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.hidden) close(); });

            const moreBtn = document.getElementById('loyalty-history-more');
            if (moreBtn) moreBtn.addEventListener('click', () => this.loadMoreHistory(moreBtn));
        }
    };

    document.addEventListener('DOMContentLoaded', () => LoyaltyPage.init());
    window.LoyaltyPage = LoyaltyPage;
})();
