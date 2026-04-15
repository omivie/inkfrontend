    const pick = (obj, ...keys) => {
        if (!obj) return undefined;
        for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
        return undefined;
    };
    const num = (v, d = 0) => {
        const n = typeof v === 'string' ? parseFloat(v) : v;
        return Number.isFinite(n) ? n : d;
    };

    const FinancialHealthPage = {
        charts: {},
        data: {},
        currentDays: 30,

        async init() {
            this.bindEvents();
            await this.loadData();
        },

        bindEvents() {
            document.querySelectorAll('.admin-chart__period-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    document.querySelectorAll('.admin-chart__period-btn').forEach(b =>
                        b.classList.remove('admin-chart__period-btn--active'));
                    e.target.classList.add('admin-chart__period-btn--active');
                    this.currentDays = this.periodToDays(e.target.dataset.period);
                    this.loadData();
                });
            });

            document.getElementById('add-expense-btn')?.addEventListener('click', () => {
                document.getElementById('expense-form-card').style.display = 'block';
                document.getElementById('expense-date').valueAsDate = new Date();
            });
            document.getElementById('close-expense-form')?.addEventListener('click', () => {
                document.getElementById('expense-form-card').style.display = 'none';
            });
            document.getElementById('cancel-expense')?.addEventListener('click', () => {
                document.getElementById('expense-form-card').style.display = 'none';
            });
            document.getElementById('expense-form')?.addEventListener('submit', async (e) => {
                e.preventDefault();
                await this.saveExpense();
            });

            document.getElementById('cashflow-period')?.addEventListener('change', (e) => {
                this.loadCashflow(parseInt(e.target.value));
            });
            document.getElementById('profit-period')?.addEventListener('change', (e) => {
                this.loadProfitChart(parseInt(e.target.value));
            });
            document.getElementById('pnl-period')?.addEventListener('change', (e) => {
                const map = { current: 30, last: 30, quarter: 90, year: 365 };
                this.loadPnL(map[e.target.value] || 90);
            });
        },

        periodToDays(p) {
            return ({ '1h': 1, '12h': 1, '24h': 1, '7d': 7, '1m': 30, '3m': 90, '6m': 180, '1y': 365, '2y': 730 })[p] || 30;
        },

        async loadData() {
            try {
                const [overview, burnRunway, forecasts] = await Promise.all([
                    AdminAPI.getAdminAnalyticsOverview(this.currentDays),
                    AdminAPI.getAdminAnalyticsBurnRunway(),
                    AdminAPI.getAdminAnalyticsForecasts(),
                ]);
                this.data.overview = overview;
                this.data.burnRunway = burnRunway;
                this.data.forecasts = forecasts;

                this.renderKPIs();
                this.renderForecasts();
                this.renderBreakEven();
                this.checkRunwayAlert();

                await Promise.all([
                    this.loadCashflow(12),
                    this.loadProfitChart(12),
                    this.loadPnL(90),
                    this.loadExpenses(),
                ]);
            } catch (error) {
                if (typeof DebugLog !== 'undefined') DebugLog.error('Financial data load failed:', error);
            }
        },

        renderKPIs() {
            const ov = this.data.overview || {};
            const br = this.data.burnRunway || {};

            const cashBalance = num(pick(br, 'cashBalance', 'cash_balance', 'balance'));
            const grossMargin = num(pick(ov, 'grossMargin', 'gross_margin'));
            const prevGrossMargin = num(pick(ov, 'prevGrossMargin', 'previousGrossMargin', 'prev_gross_margin'));
            const monthlyBurn = num(pick(br, 'monthlyBurn', 'monthly_burn', 'burnRate', 'burn_rate'));
            const runwayMonths = pick(br, 'runwayMonths', 'runway_months', 'runway');

            document.getElementById('cash-balance').textContent = formatPrice(cashBalance);
            document.getElementById('gross-margin').textContent = grossMargin.toFixed(1) + '%';

            const marginTrend = document.getElementById('margin-trend');
            if (marginTrend && prevGrossMargin !== undefined) {
                const diff = grossMargin - prevGrossMargin;
                const dir = diff >= 0 ? 'up' : 'down';
                marginTrend.className = `kpi-card__trend kpi-card__trend--${dir}`;
                marginTrend.innerHTML = `<span>${diff >= 0 ? '+' : ''}${diff.toFixed(1)} pts</span>`;
            }

            const burnEl = document.getElementById('monthly-burn');
            burnEl.textContent = monthlyBurn > 0 ? formatPrice(monthlyBurn) : '$0 (profitable)';

            const runwayEl = document.getElementById('runway-months');
            const runwayDays = document.getElementById('runway-days');
            if (runwayMonths === null || runwayMonths === undefined || runwayMonths === Infinity || runwayMonths > 999) {
                runwayEl.textContent = '∞';
                runwayDays.textContent = 'Business is profitable';
            } else {
                const r = num(runwayMonths);
                runwayEl.textContent = r.toFixed(1) + ' mo';
                runwayDays.textContent = `~${Math.round(r * 30)} days at current burn`;
            }
        },

        renderForecasts() {
            const f = this.data.forecasts || {};
            const f30 = num(pick(f, 'forecast30', 'days30', 'd30', 'next30'));
            const f60 = num(pick(f, 'forecast60', 'days60', 'd60', 'next60'));
            const f90 = num(pick(f, 'forecast90', 'days90', 'd90', 'next90'));
            document.getElementById('forecast-30').textContent = formatPrice(f30);
            document.getElementById('forecast-60').textContent = formatPrice(f60);
            document.getElementById('forecast-90').textContent = formatPrice(f90);
        },

        renderBreakEven() {
            const ov = this.data.overview || {};
            const netProfit = num(pick(ov, 'netProfit', 'net_profit'));
            const indicator = document.getElementById('breakeven-indicator');
            const status = document.getElementById('breakeven-status');
            const gap = document.getElementById('breakeven-gap');
            if (netProfit >= 0) {
                indicator.style.background = '#10b981';
                status.textContent = 'Profitable';
                gap.textContent = `Net profit: ${formatPrice(netProfit)} this period`;
            } else {
                indicator.style.background = 'var(--magenta-primary)';
                status.textContent = 'Below Break-Even';
                gap.textContent = `Need ${formatPrice(Math.abs(netProfit))} more revenue`;
            }
        },

        checkRunwayAlert() {
            const r = num(pick(this.data.burnRunway || {}, 'runwayMonths', 'runway_months', 'runway'), Infinity);
            if (r >= 90 || !Number.isFinite(r)) return;
            const banner = document.getElementById('runway-alert');
            if (!banner) return;
            banner.style.display = 'flex';
            if (r < 3) {
                banner.className = 'alert-banner alert-banner--critical';
                document.getElementById('alert-title').textContent = 'Critical: Low Cash Runway';
                document.getElementById('alert-text').textContent = `Only ${r.toFixed(1)} months of runway remaining. Immediate action required.`;
            } else {
                banner.className = 'alert-banner alert-banner--warning';
                document.getElementById('alert-title').textContent = 'Warning: Cash Runway Below Target';
                document.getElementById('alert-text').textContent = `${r.toFixed(1)} months runway. Target is 6+ months.`;
            }
        },

        async loadCashflow(months) {
            const ctx = document.getElementById('cashflow-chart');
            if (!ctx) return;
            const data = await AdminAPI.getAdminAnalyticsCashflow(months);
            const series = Array.isArray(data) ? data : (data?.months || data?.series || []);

            const labels = [], inflows = [], outflows = [], netFlow = [];
            for (const row of series.slice(-months)) {
                const label = pick(row, 'monthLabel', 'label', 'month', 'period');
                const d = label ? new Date(label) : null;
                labels.push(d && !isNaN(d) ? d.toLocaleDateString('en-NZ', { month: 'short', year: '2-digit' }) : (label || ''));
                const inflow = num(pick(row, 'inflow', 'inflows', 'revenue', 'income'));
                const outflow = num(pick(row, 'outflow', 'outflows', 'expenses', 'costs'));
                inflows.push(inflow);
                outflows.push(outflow);
                netFlow.push(num(pick(row, 'net', 'netFlow', 'net_cashflow'), inflow - outflow));
            }

            if (this.charts.cashflow) this.charts.cashflow.destroy();
            this.charts.cashflow = new Chart(ctx, {
                type: 'bar',
                data: { labels, datasets: [
                    { label: 'Inflows', data: inflows, backgroundColor: '#10b981', borderRadius: 4 },
                    { label: 'Outflows', data: outflows.map(v => -Math.abs(v)), backgroundColor: '#C71F6E', borderRadius: 4 },
                    { label: 'Net Cash Flow', data: netFlow, type: 'line', borderColor: '#267FB5', backgroundColor: 'transparent', borderWidth: 3, pointRadius: 4, pointBackgroundColor: '#267FB5' },
                ]},
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { position: 'top' } },
                    scales: { x: { stacked: false }, y: { beginAtZero: true, ticks: { callback: v => '$' + (v/1000).toFixed(0) + 'k' } } }
                }
            });
        },

        async loadProfitChart(months) {
            const ctx = document.getElementById('profit-chart');
            if (!ctx) return;

            const daysBack = months * 31;
            const daily = await AdminAPI.getAdminAnalyticsDailyRevenue(daysBack);
            const rows = Array.isArray(daily) ? daily : (daily?.days || daily?.series || []);

            const grossMargin = num(pick(this.data.overview || {}, 'grossMargin', 'gross_margin')) / 100;
            const monthlyExpenses = num(pick(this.data.burnRunway || {}, 'monthlyExpenses', 'monthly_expenses'));

            const buckets = new Map();
            for (let i = months - 1; i >= 0; i--) {
                const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
                const key = `${d.getFullYear()}-${d.getMonth()}`;
                buckets.set(key, { label: d.toLocaleDateString('en-NZ', { month: 'short', year: '2-digit' }), revenue: 0 });
            }
            for (const r of rows) {
                const dateStr = pick(r, 'date', 'day', 'period');
                if (!dateStr) continue;
                const d = new Date(dateStr);
                if (isNaN(d)) continue;
                const key = `${d.getFullYear()}-${d.getMonth()}`;
                const b = buckets.get(key);
                if (b) b.revenue += num(pick(r, 'revenue', 'total', 'sales'));
            }

            const labels = [], grossProfits = [], netProfits = [];
            for (const b of buckets.values()) {
                labels.push(b.label);
                const gross = b.revenue * grossMargin;
                grossProfits.push(parseFloat(gross.toFixed(2)));
                netProfits.push(parseFloat((gross - monthlyExpenses).toFixed(2)));
            }

            const totalGross = grossProfits.reduce((a, b) => a + b, 0);
            const totalNet = netProfits.reduce((a, b) => a + b, 0);
            const totalsEl = document.getElementById('profit-chart-totals');
            if (totalsEl) {
                const netColor = totalNet >= 0 ? '#059669' : 'var(--magenta-primary)';
                totalsEl.innerHTML =
                    `<span style="color:#059669;">Gross <strong>${formatPrice(totalGross)}</strong></span>` +
                    `<span style="color:${netColor};">Net <strong>${formatPrice(totalNet)}</strong></span>`;
            }

            if (this.charts.profit) this.charts.profit.destroy();
            this.charts.profit = new Chart(ctx, {
                type: 'line',
                data: { labels, datasets: [
                    { label: 'Gross Profit', data: grossProfits, borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,0.08)', borderWidth: 2, pointRadius: 4, pointBackgroundColor: '#10b981', fill: true, tension: 0.3 },
                    { label: 'Net Profit', data: netProfits, borderColor: '#267FB5', backgroundColor: 'rgba(38,127,181,0.08)', borderWidth: 2, pointRadius: 4, pointBackgroundColor: '#267FB5', fill: true, tension: 0.3 },
                ]},
                options: {
                    responsive: true, maintainAspectRatio: false,
                    plugins: { legend: { position: 'top' }, tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${formatPrice(ctx.parsed.y)}` } } },
                    scales: { x: { grid: { display: false } }, y: { ticks: { callback: v => '$' + (v/1000).toFixed(0) + 'k' }, grid: { color: 'rgba(0,0,0,0.05)' } } }
                }
            });
        },

        async loadPnL(days) {
            const pnl = await AdminAPI.getAdminAnalyticsPnL(days);
            if (!pnl) return;

            const grossSales = num(pick(pnl, 'grossSales', 'gross_sales', 'revenue'));
            const prevGrossSales = num(pick(pnl, 'prevGrossSales', 'prev_gross_sales', 'previousRevenue'));
            const discounts = num(pick(pnl, 'discounts', 'returns', 'discountsAndReturns'));
            const prevDiscounts = num(pick(pnl, 'prevDiscounts', 'prev_discounts'));
            const netRevenue = num(pick(pnl, 'netRevenue', 'net_revenue'), grossSales - discounts);
            const prevNetRevenue = num(pick(pnl, 'prevNetRevenue', 'prev_net_revenue'), prevGrossSales - prevDiscounts);
            const cogs = num(pick(pnl, 'cogs', 'productCosts'));
            const prevCogs = num(pick(pnl, 'prevCogs', 'prev_cogs'));
            const shipping = num(pick(pnl, 'shippingCosts', 'shipping'));
            const prevShipping = num(pick(pnl, 'prevShippingCosts', 'prev_shipping'));
            const grossProfit = num(pick(pnl, 'grossProfit', 'gross_profit'), netRevenue - cogs - shipping);
            const prevGrossProfit = num(pick(pnl, 'prevGrossProfit', 'prev_gross_profit'));
            const marketing = num(pick(pnl, 'marketing', 'marketingExpense'));
            const prevMarketing = num(pick(pnl, 'prevMarketing', 'prev_marketing'));
            const platform = num(pick(pnl, 'platform', 'platformFees'));
            const prevPlatform = num(pick(pnl, 'prevPlatform', 'prev_platform'));
            const otherOps = num(pick(pnl, 'otherOperating', 'other_operating', 'other'));
            const prevOtherOps = num(pick(pnl, 'prevOtherOperating', 'prev_other_operating'));
            const netProfit = num(pick(pnl, 'netProfit', 'net_profit'), grossProfit - marketing - platform - otherOps);
            const prevNetProfit = num(pick(pnl, 'prevNetProfit', 'prev_net_profit'));
            const netMargin = grossSales > 0 ? (netProfit / grossSales * 100) : 0;
            const prevNetMargin = prevGrossSales > 0 ? (prevNetProfit / prevGrossSales * 100) : 0;

            const set = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
            const setNeg = (id, val) => set(id, '-' + formatPrice(Math.abs(val)));

            set('pnl-gross-sales', formatPrice(grossSales));
            set('pnl-gross-sales-prev', formatPrice(prevGrossSales));
            set('pnl-gross-sales-change', this.calculateChange(grossSales, prevGrossSales));

            setNeg('pnl-discounts', discounts);
            setNeg('pnl-discounts-prev', prevDiscounts);
            set('pnl-discounts-change', this.calculateChange(discounts, prevDiscounts));

            set('pnl-net-revenue', formatPrice(netRevenue));
            set('pnl-net-revenue-prev', formatPrice(prevNetRevenue));
            set('pnl-net-revenue-change', this.calculateChange(netRevenue, prevNetRevenue));

            setNeg('pnl-cogs', cogs);
            setNeg('pnl-cogs-prev', prevCogs);
            set('pnl-cogs-change', this.calculateChange(cogs, prevCogs));

            setNeg('pnl-shipping', shipping);
            setNeg('pnl-shipping-prev', prevShipping);
            set('pnl-shipping-change', this.calculateChange(shipping, prevShipping));

            set('pnl-gross-profit', formatPrice(grossProfit));
            set('pnl-gross-profit-prev', formatPrice(prevGrossProfit));
            set('pnl-gross-profit-change', this.calculateChange(grossProfit, prevGrossProfit));

            setNeg('pnl-marketing', marketing);
            setNeg('pnl-marketing-prev', prevMarketing);
            set('pnl-marketing-change', this.calculateChange(marketing, prevMarketing));

            setNeg('pnl-platform', platform);
            setNeg('pnl-platform-prev', prevPlatform);
            set('pnl-platform-change', this.calculateChange(platform, prevPlatform));

            setNeg('pnl-other', otherOps);
            setNeg('pnl-other-prev', prevOtherOps);
            set('pnl-other-change', this.calculateChange(otherOps, prevOtherOps));

            const npEl = document.getElementById('pnl-net-profit');
            const npPrevEl = document.getElementById('pnl-net-profit-prev');
            const npChEl = document.getElementById('pnl-net-profit-change');
            if (npEl) {
                npEl.innerHTML = '<strong>' + formatPrice(netProfit) + '</strong>';
                npEl.className = (netProfit >= 0 ? 'pnl-table__positive' : 'pnl-table__negative') + ' pnl-table__total';
            }
            if (npPrevEl) npPrevEl.innerHTML = '<strong>' + formatPrice(prevNetProfit) + '</strong>';
            if (npChEl) npChEl.innerHTML = '<strong>' + this.calculateChange(netProfit, prevNetProfit) + '</strong>';

            set('pnl-net-margin', netMargin.toFixed(1) + '%');
            set('pnl-net-margin-prev', prevNetMargin.toFixed(1) + '%');
            set('pnl-net-margin-change', (netMargin - prevNetMargin >= 0 ? '+' : '') + (netMargin - prevNetMargin).toFixed(1) + ' pts');
        },

        async loadExpenses() {
            const tbody = document.getElementById('recent-expenses-tbody');
            if (!tbody) return;
            const data = await AdminAPI.getAdminAnalyticsExpenses(20);
            const rows = Array.isArray(data) ? data : (data?.expenses || []);
            if (!rows.length) {
                tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:var(--spacing-6);color:var(--color-text-muted);">No expenses recorded yet. Click "Add Expense" to get started.</td></tr>';
                return;
            }
            const esc = window.Security?.escapeHtml || (s => String(s ?? ''));
            tbody.innerHTML = rows.map(r => {
                const date = pick(r, 'date', 'expense_date', 'created_at') || '';
                const dateStr = date ? new Date(date).toLocaleDateString('en-NZ') : '';
                const cat = pick(r, 'category', 'category_name') || '';
                const vendor = pick(r, 'vendor', 'description') || '';
                const amount = num(pick(r, 'amount', 'total'));
                return `<tr><td>${esc(dateStr)}</td><td>${esc(cat)}</td><td>${esc(vendor)}</td><td class="pnl-table__negative">-${formatPrice(amount)}</td></tr>`;
            }).join('');
        },

        calculateChange(current, previous) {
            if (!previous) return current > 0 ? '+∞' : '0%';
            const change = ((current - previous) / previous) * 100;
            return (change >= 0 ? '+' : '') + change.toFixed(1) + '%';
        },

        async saveExpense() {
            const category = document.getElementById('expense-category').value;
            const amount = parseFloat(document.getElementById('expense-amount').value);
            const date = document.getElementById('expense-date').value;
            const vendor = document.getElementById('expense-vendor').value;

            if (!category || !amount || !date) {
                alert('Please fill in all required fields');
                return;
            }
            try {
                await AdminAPI.addAdminAnalyticsExpense({ category, amount, date, vendor });
                document.getElementById('expense-form').reset();
                document.getElementById('expense-form-card').style.display = 'none';
                await this.loadData();
            } catch (error) {
                if (typeof DebugLog !== 'undefined') DebugLog.error('Error saving expense:', error);
                alert('Failed to save expense: ' + (error.message || 'Please try again.'));
            }
        }
    };

    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(() => { FinancialHealthPage.init(); }, 500);
    });
