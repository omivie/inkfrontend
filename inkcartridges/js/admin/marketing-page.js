    const MarketingPage = {
        charts: {},
        period: '30d',

        async init() {
            this.setupPeriodButtons();
            await this.loadData();
        },

        setupPeriodButtons() {
            document.querySelectorAll('.admin-chart__period-btn').forEach(btn => {
                btn.addEventListener('click', async (e) => {
                    document.querySelectorAll('.admin-chart__period-btn').forEach(b =>
                        b.classList.remove('admin-chart__period-btn--active'));
                    e.target.classList.add('admin-chart__period-btn--active');
                    this.period = e.target.dataset.period;
                    await this.loadData();
                });
            });
        },

        async loadData() {
            try {
                const response = await fetch(`${Config.API_URL}/api/analytics/marketing?period=${this.period}`);
                if (response.ok) {
                    const result = await response.json();
                    if (result.ok && result.data) {
                        this.updateKPIs(result.data.kpis);
                        this.updateFunnel(result.data.funnel);
                        this.updateTopPages(result.data.topPages);
                        this.updateSearchTerms(result.data.searchTerms);
                        this.renderCharts(result.data);
                        return;
                    }
                }
            } catch (error) {
                DebugLog.warn('Marketing API not available:', error.message);
            }
            // Show "No data" state if API unavailable
            this.showNoData();
        },

        updateKPIs(kpis) {
            if (!kpis) return this.showNoData();

            // Visitors
            this.updateKPI('visitors', kpis.visitors, kpis.visitorsTrend);
            // Page Views
            this.updateKPI('pageviews', kpis.pageViews, kpis.pageViewsTrend);
            // Bounce Rate
            this.updateKPI('bounce', kpis.bounceRate + '%', kpis.bounceTrend, true);
            // Session Duration
            this.updateKPI('session', this.formatDuration(kpis.avgSessionDuration), kpis.sessionTrend);
        },

        updateKPI(id, value, trend, invertTrend = false) {
            const valueEl = document.getElementById(`${id}-value`);
            const trendEl = document.getElementById(`${id}-trend`);

            if (valueEl) valueEl.textContent = typeof value === 'number' ? value.toLocaleString() : value;
            if (trendEl && trend !== undefined) {
                const isPositive = invertTrend ? trend < 0 : trend > 0;
                const trendClass = isPositive ? 'admin-kpi__trend--up' : 'admin-kpi__trend--down';
                const arrow = isPositive
                    ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>'
                    : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 18 13.5 8.5 8.5 13.5 1 6"/><polyline points="17 18 23 18 23 12"/></svg>';
                trendEl.className = `admin-kpi__trend ${trendClass}`;
                trendEl.innerHTML = `${arrow} ${trend > 0 ? '+' : ''}${trend.toFixed(1)}%`;
            }
        },

        formatDuration(seconds) {
            if (!seconds) return '--';
            const mins = Math.floor(seconds / 60);
            const secs = Math.floor(seconds % 60);
            return `${mins}m ${secs}s`;
        },

        updateFunnel(funnel) {
            if (!funnel) return;

            const visitors = funnel.visitors || 0;
            const steps = [
                { id: 'visitors', value: visitors, pct: 100 },
                { id: 'views', value: funnel.productViews || 0, pct: visitors ? ((funnel.productViews / visitors) * 100) : 0 },
                { id: 'cart', value: funnel.addToCart || 0, pct: visitors ? ((funnel.addToCart / visitors) * 100) : 0 },
                { id: 'checkout', value: funnel.checkoutStarted || 0, pct: visitors ? ((funnel.checkoutStarted / visitors) * 100) : 0 },
                { id: 'purchase', value: funnel.purchases || 0, pct: visitors ? ((funnel.purchases / visitors) * 100) : 0 }
            ];

            steps.forEach(step => {
                const valueEl = document.getElementById(`funnel-${step.id}`);
                const barEl = document.getElementById(`funnel-${step.id}-bar`);
                if (valueEl) {
                    valueEl.textContent = step.id === 'visitors'
                        ? step.value.toLocaleString()
                        : `${step.value.toLocaleString()} (${step.pct.toFixed(1)}%)`;
                }
                if (barEl) barEl.style.width = `${step.pct}%`;
            });
        },

        updateTopPages(pages) {
            const tbody = document.getElementById('top-pages-table');
            if (!tbody) return;

            if (!pages || pages.length === 0) {
                tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--color-text-muted);">No data available</td></tr>';
                return;
            }

            tbody.innerHTML = pages.map(page => `
                <tr>
                    <td>${this.escapeHtml(page.path)}</td>
                    <td>${page.views.toLocaleString()}</td>
                    <td>${page.bounceRate}%</td>
                </tr>
            `).join('');
        },

        updateSearchTerms(terms) {
            const tbody = document.getElementById('searchTermsTable');
            if (!tbody) return;

            if (!terms || terms.length === 0) {
                tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--color-text-muted);">No data available</td></tr>';
                return;
            }

            tbody.innerHTML = terms.map(term => `
                <tr>
                    <td>${this.escapeHtml(term.keyword)}</td>
                    <td>${term.searches.toLocaleString()}</td>
                    <td>${term.conversions}</td>
                </tr>
            `).join('');
        },

        escapeHtml(str) {
            const div = document.createElement('div');
            div.textContent = str;
            return div.innerHTML;
        },

        async showNoData() {
            ['visitors', 'pageviews', 'bounce', 'session'].forEach(id => {
                const valueEl = document.getElementById(`${id}-value`);
                const trendEl = document.getElementById(`${id}-trend`);
                if (valueEl) valueEl.textContent = '--';
                if (trendEl) { trendEl.className = 'admin-kpi__trend'; trendEl.textContent = '--'; }
            });

            const topPages = document.getElementById('top-pages-table');
            if (topPages) topPages.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--color-text-muted);">Analytics tracking not available</td></tr>';

            const searchTerms = document.getElementById('searchTermsTable');
            if (searchTerms) searchTerms.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--color-text-muted);">Search tracking not available</td></tr>';

            // Load real order data for funnel
            await this.loadOrderDataForFunnel();

            // Render empty charts
            this.renderCharts({});
        },

        async loadOrderDataForFunnel() {
            try {
                // Fetch both order data and cart analytics
                const [ordersResponse, analyticsResponse] = await Promise.all([
                    API.getOrders({ limit: 100 }),
                    this.fetchCartAnalytics()
                ]);

                let purchases = 0;
                let checkouts = 0;

                if (ordersResponse.ok && ordersResponse.data?.orders) {
                    const orders = ordersResponse.data.orders;
                    const completedStatuses = ['completed', 'shipped', 'delivered'];
                    const checkoutStatuses = ['pending', 'processing', 'paid', ...completedStatuses];
                    purchases = orders.filter(o => completedStatuses.includes(o.status)).length;
                    checkouts = orders.filter(o => checkoutStatuses.includes(o.status)).length;
                }

                // Use real analytics data if available
                const analytics = analyticsResponse || {};
                const cartViews = analytics.cart_viewed || 0;
                const cartsCreated = analytics.add_to_cart || cartViews;
                const checkoutStarted = analytics.checkout_started || checkouts;
                const paymentStarted = analytics.payment_started || checkouts;
                const ordersCompleted = analytics.order_completed || purchases;
                const abandoned = analytics.potential_abandonment || 0;

                // Calculate metrics
                const totalSessions = Math.max(cartsCreated, checkoutStarted, 1);
                const abandonmentRate = cartsCreated > 0 ? ((cartsCreated - ordersCompleted) / cartsCreated * 100) : 0;

                // Update funnel with real data
                const steps = [
                    { id: 'visitors', value: totalSessions, pct: 100 },
                    { id: 'views', value: cartViews || Math.round(totalSessions * 0.8), pct: 80 },
                    { id: 'cart', value: cartsCreated, pct: totalSessions ? (cartsCreated / totalSessions * 100) : 0 },
                    { id: 'checkout', value: checkoutStarted, pct: totalSessions ? (checkoutStarted / totalSessions * 100) : 0 },
                    { id: 'purchase', value: ordersCompleted, pct: totalSessions ? (ordersCompleted / totalSessions * 100) : 0 }
                ];

                steps.forEach(step => {
                    const valueEl = document.getElementById(`funnel-${step.id}`);
                    const barEl = document.getElementById(`funnel-${step.id}-bar`);
                    if (valueEl) {
                        valueEl.textContent = step.value > 0
                            ? `${step.value.toLocaleString()} (${step.pct.toFixed(1)}%)`
                            : '0';
                    }
                    if (barEl) barEl.style.width = `${Math.max(step.pct, step.value > 0 ? 5 : 0)}%`;
                });

                // Update abandonment rate display if element exists
                const abandonmentEl = document.getElementById('abandonment-rate');
                if (abandonmentEl) {
                    abandonmentEl.textContent = `${abandonmentRate.toFixed(1)}%`;
                }

                // Update abandoned carts count
                const abandonedCountEl = document.getElementById('abandoned-carts');
                if (abandonedCountEl) {
                    abandonedCountEl.textContent = abandoned.toLocaleString();
                }

            } catch (error) {
                DebugLog.warn('Could not load funnel data:', error.message);
                ['visitors', 'views', 'cart', 'checkout', 'purchase'].forEach(id => {
                    const el = document.getElementById(`funnel-${id}`);
                    if (el) el.textContent = '--';
                });
            }
        },

        async fetchCartAnalytics() {
            try {
                const apiUrl = typeof Config !== 'undefined' ? Config.API_URL : '';
                if (!apiUrl) return null;

                const response = await fetch(`${apiUrl}/api/analytics/cart-summary`, {
                    method: 'GET',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${Auth.session?.access_token || ''}`
                    },
                    credentials: 'include'
                });

                if (response.ok) {
                    const data = await response.json();
                    return data.ok ? data.data : null;
                }
                return null;
            } catch (error) {
                DebugLog.warn('Could not fetch cart analytics:', error);
                return null;
            }
        },

        renderCharts(data) {
            this.renderTrafficChart(data.trafficData);
            this.renderSourcesChart(data.sourcesData);
            this.renderDevicesChart(data.devicesData);
        },

        getPeriodConfig() {
            const configs = {
                '1h': { points: 12, unit: 'minute', step: 5, isTime: true, format: { hour: 'numeric', minute: '2-digit' } },
                '12h': { points: 24, unit: 'minute', step: 30, isTime: true, format: { hour: 'numeric', minute: '2-digit' } },
                '24h': { points: 24, unit: 'hour', step: 1, isTime: true, format: { hour: 'numeric', minute: '2-digit' } },
                '7d': { points: 7, unit: 'day', step: 1, isTime: false, format: { month: 'short', day: 'numeric' } },
                '1m': { points: 30, unit: 'day', step: 1, isTime: false, format: { month: 'short', day: 'numeric' } },
                '3m': { points: 12, unit: 'week', step: 1, isTime: false, format: { month: 'short', day: 'numeric' } },
                '6m': { points: 24, unit: 'week', step: 1, isTime: false, format: { month: 'short', day: 'numeric' } },
                '1y': { points: 12, unit: 'month', step: 1, isTime: false, format: { month: 'short', year: '2-digit' } },
                '2y': { points: 24, unit: 'month', step: 1, isTime: false, format: { month: 'short', year: '2-digit' } }
            };
            return configs[this.period] || configs['7d'];
        },

        renderTrafficChart(data) {
            const ctx = document.getElementById('trafficChart');
            if (!ctx) return;

            if (this.charts.traffic) this.charts.traffic.destroy();

            const config = this.getPeriodConfig();
            const labels = [...Array(config.points)].map((_, i) => {
                const d = new Date();
                if (config.unit === 'minute') d.setMinutes(d.getMinutes() - (config.points - 1 - i) * config.step);
                else if (config.unit === 'hour') d.setHours(d.getHours() - (config.points - 1 - i));
                else if (config.unit === 'day') d.setDate(d.getDate() - (config.points - 1 - i));
                else if (config.unit === 'week') d.setDate(d.getDate() - (config.points - 1 - i) * 7);
                else if (config.unit === 'month') d.setMonth(d.getMonth() - (config.points - 1 - i));
                return config.isTime ? d.toLocaleTimeString('en-NZ', config.format) : d.toLocaleDateString('en-NZ', config.format);
            });

            const visitors = data?.visitors || labels.map(() => 0);
            const pageViews = data?.pageViews || labels.map(() => 0);

            this.charts.traffic = new Chart(ctx, {
                type: 'line',
                data: {
                    labels,
                    datasets: [
                        {
                            label: 'Visitors',
                            data: visitors,
                            borderColor: '#267FB5',
                            backgroundColor: 'rgba(38, 127, 181, 0.1)',
                            fill: true,
                            tension: 0.4
                        },
                        {
                            label: 'Page Views',
                            data: pageViews,
                            borderColor: '#10b981',
                            backgroundColor: 'transparent',
                            tension: 0.4
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { position: 'top' } },
                    scales: { y: { beginAtZero: true } }
                }
            });
        },

        renderSourcesChart(data) {
            const ctx = document.getElementById('sourcesChart');
            if (!ctx) return;

            if (this.charts.sources) this.charts.sources.destroy();

            const labels = data?.labels || ['Organic Search', 'Direct', 'Social', 'Referral', 'Email'];
            const values = data?.values || [0, 0, 0, 0, 0];

            this.charts.sources = new Chart(ctx, {
                type: 'doughnut',
                data: {
                    labels,
                    datasets: [{
                        data: values,
                        backgroundColor: ['#267FB5', '#10b981', '#F4C430', '#8b5cf6', '#C71F6E']
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { position: 'bottom' } }
                }
            });
        },

        renderDevicesChart(data) {
            const ctx = document.getElementById('devicesChart');
            if (!ctx) return;

            if (this.charts.devices) this.charts.devices.destroy();

            const labels = data?.labels || ['Desktop', 'Mobile', 'Tablet'];
            const values = data?.values || [0, 0, 0];

            this.charts.devices = new Chart(ctx, {
                type: 'pie',
                data: {
                    labels,
                    datasets: [{
                        data: values,
                        backgroundColor: ['#267FB5', '#10b981', '#F4C430']
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { position: 'bottom' } }
                }
            });
        }
    };

    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(() => { MarketingPage.init(); }, 500);
    });
