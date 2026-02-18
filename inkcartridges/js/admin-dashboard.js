/**
 * ADMIN-DASHBOARD.JS
 * ==================
 * Tab renderers, chart builders, KPI logic, drawer, and table rendering
 * for the admin dashboard. All dynamic content uses Security.escapeHtml().
 *
 * UI screenshots: see docs/admin-ui/ for reference captures.
 */

'use strict';

const DashboardState = {
    filters: {
        period: '7d',
        brand: '',
        category: '',
        search: ''
    },

    load() {
        try {
            const saved = JSON.parse(localStorage.getItem('admin-dashboard-filters'));
            if (saved) Object.assign(this.filters, saved);
        } catch (e) { /* ignore */ }
    },

    save() {
        localStorage.setItem('admin-dashboard-filters', JSON.stringify(this.filters));
    },

    setPeriod(period) {
        this.filters.period = period;
        this.save();
    },

    periodToDays() {
        const map = { today: 1, '7d': 7, '30d': 30, '90d': 90, '12m': 365 };
        return map[this.filters.period] || 7;
    }
};

function getBrandName(brand) {
    if (!brand) return 'Unknown';
    if (typeof brand === 'string') return brand;
    return brand.name || brand.brand_name || String(brand);
}

const Dashboard = {
    renderedTabs: new Set(),
    charts: {},

    chartTheme: {
        dark: {
            grid: 'rgba(148, 163, 184, 0.08)',
            tick: '#64748B',
            tooltipBg: '#1E293B',
            tooltipText: '#F1F5F9',
            tooltipBorder: '#334155'
        },
        light: {
            grid: '#E2E8F0',
            tick: '#94A3B8',
            tooltipBg: '#1F2937',
            tooltipText: '#F9FAFB',
            tooltipBorder: '#374151'
        }
    },

    getTheme() {
        return document.documentElement.getAttribute('data-theme') || 'dark';
    },

    /* ================================================================
       KPI RENDERING
       ================================================================ */

    renderKPISkeletons() {
        const strip = document.getElementById('kpi-strip');
        if (!strip) return;
        const labels = ['Revenue', 'Orders', 'AOV', 'Gross Profit', 'Net Profit', 'Refund Rate', 'Fulfilment', 'Low Stock'];
        strip.innerHTML = labels.map(function(label) {
            return '<div class="admin-kpi-item">' +
                '<div class="admin-kpi-item__label">' + Security.escapeHtml(label) + '</div>' +
                '<div class="admin-kpi-item__row"><div class="skeleton skeleton--value"></div>' +
                '<div class="skeleton" style="width:48px;height:18px;"></div></div>' +
                '<div class="skeleton skeleton--text" style="width:36px;margin-top:2px;"></div></div>';
        }).join('');
    },

    renderKPIs(data) {
        const strip = document.getElementById('kpi-strip');
        if (!strip) return;

        var kpis = [
            { label: 'Revenue', value: formatPrice(data.totalRevenue || 0), trend: data.analytics.revenueTrend || null, spark: data.analytics.revenueSparkline || null },
            { label: 'Orders', value: String(data.totalOrders || 0), trend: data.analytics.ordersTrend || null, spark: data.analytics.ordersSparkline || null },
            { label: 'AOV', value: formatPrice(data.aov || 0), trend: null, spark: null },
            { label: 'Gross Profit', value: data.grossProfit !== null ? formatPrice(data.grossProfit) : '--', trend: null, spark: null },
            { label: 'Net Profit', value: data.netProfit !== null ? formatPrice(data.netProfit) : '--', trend: null, spark: null },
            { label: 'Refund Rate', value: data.refundRate !== null ? (data.refundRate.toFixed(1) + '%') : '--', trend: null, spark: null, warnIf: data.refundRate > 5 },
            { label: 'Fulfilment', value: data.avgFulfilmentTime !== null ? (data.avgFulfilmentTime.toFixed(1) + 'd') : '--', trend: null, spark: null },
            { label: 'Low Stock', value: String(data.lowStockProducts.length), trend: null, spark: null, warnIf: data.lowStockProducts.length > 5, link: '/html/admin/products.html?filter=low_stock' }
        ];

        strip.innerHTML = '';
        kpis.forEach(function(kpi) {
            var div = document.createElement('div');
            div.className = 'admin-kpi-item';

            if (kpi.link) {
                div.classList.add('admin-kpi-item--clickable');
                div.setAttribute('role', 'link');
                div.setAttribute('tabindex', '0');
                div.addEventListener('click', function() { window.location.href = kpi.link; });
                div.addEventListener('keydown', function(e) { if (e.key === 'Enter') window.location.href = kpi.link; });
            }

            var labelEl = document.createElement('div');
            labelEl.className = 'admin-kpi-item__label';
            labelEl.textContent = kpi.label;
            div.appendChild(labelEl);

            var row = document.createElement('div');
            row.className = 'admin-kpi-item__row';

            var valEl = document.createElement('div');
            valEl.className = 'admin-kpi-item__value';
            valEl.textContent = kpi.value;
            row.appendChild(valEl);

            if (kpi.spark && kpi.spark.length >= 2) {
                row.insertAdjacentHTML('beforeend', Dashboard.buildSparkSVG(kpi.spark));
            }
            div.appendChild(row);

            if (kpi.trend) {
                var trendEl = document.createElement('div');
                var dir = kpi.trend.direction || 'flat';
                trendEl.className = 'admin-kpi-item__trend admin-kpi-item__trend--' + dir;
                var arrow = dir === 'up' ? '\u2191' : dir === 'down' ? '\u2193' : '\u2192';
                trendEl.textContent = arrow + ' ' + (kpi.trend.change || 0) + '%';
                div.appendChild(trendEl);
            } else if (kpi.warnIf) {
                var warnEl = document.createElement('div');
                warnEl.className = 'admin-kpi-item__trend admin-kpi-item__trend--warn';
                warnEl.textContent = '\u26A0 attention';
                div.appendChild(warnEl);
            }

            strip.appendChild(div);
        });
    },

    buildSparkSVG(pts) {
        var w = 48, h = 18;
        var max = Math.max.apply(null, pts);
        var min = Math.min.apply(null, pts);
        var range = max - min || 1;
        var coords = pts.map(function(v, i) {
            var x = (i / (pts.length - 1)) * w;
            var y = h - ((v - min) / range) * (h - 2) - 1;
            return x.toFixed(1) + ',' + y.toFixed(1);
        }).join(' ');
        return '<svg class="admin-kpi-item__spark" viewBox="0 0 ' + w + ' ' + h + '">' +
            '<polyline points="' + coords + '" fill="none" stroke="var(--cyan-primary)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    },

    /* ================================================================
       TAB RENDERING (lazy)
       ================================================================ */

    renderTab(tabId, data, period) {
        if (!data) return;
        switch (tabId) {
            case 'overview': this.renderOverview(data); break;
            case 'revenue': this.renderRevenue(data); break;
            case 'customers-tab': this.renderCustomersTab(data); break;
            case 'inventory': this.renderInventoryTab(data); break;
            case 'operations': this.renderOperationsTab(data); break;
        }
    },

    /* ---- OVERVIEW TAB ---- */

    renderOverview(data) {
        var panel = document.getElementById('tab-overview');
        if (!panel) return;

        if (!this.renderedTabs.has('overview')) {
            panel.innerHTML =
                '<div class="admin-card" style="margin-bottom:var(--spacing-4);">' +
                    '<div class="admin-card__header"><h4 class="admin-card__title">Revenue Over Time</h4></div>' +
                    '<div class="admin-card__body"><div style="height:240px;"><canvas id="chart-ov-revenue"></canvas></div></div>' +
                '</div>' +
                '<div class="admin-grid-2" style="margin-bottom:var(--spacing-4);">' +
                    '<div class="admin-card">' +
                        '<div class="admin-card__header"><h4 class="admin-card__title">Order Volume</h4></div>' +
                        '<div class="admin-card__body"><div style="height:200px;"><canvas id="chart-ov-orders"></canvas></div></div>' +
                    '</div>' +
                    '<div class="admin-card">' +
                        '<div class="admin-card__header"><h4 class="admin-card__title">Most Sold</h4><a href="/html/admin/products.html" class="admin-card__action">View All</a></div>' +
                        '<div class="admin-card__body admin-card__body--no-padding"><table class="admin-table"><thead><tr><th>Product</th><th>Units Sold</th><th>Stock</th></tr></thead><tbody id="ov-top-sold"></tbody></table></div>' +
                    '</div>' +
                '</div>' +
                '<div class="admin-grid-2" style="margin-bottom:var(--spacing-4);">' +
                    '<div class="admin-card">' +
                        '<div class="admin-card__header"><h4 class="admin-card__title">Most Revenue</h4><a href="/html/admin/products.html" class="admin-card__action">View All</a></div>' +
                        '<div class="admin-card__body admin-card__body--no-padding"><table class="admin-table"><thead><tr><th>Product</th><th>Revenue</th><th>Stock</th></tr></thead><tbody id="ov-top-revenue"></tbody></table></div>' +
                    '</div>' +
                    '<div class="admin-card">' +
                        '<div class="admin-card__header"><h4 class="admin-card__title">Recent Orders</h4><a href="/html/admin/orders.html" class="admin-card__action">View All</a></div>' +
                        '<div class="admin-card__body admin-card__body--no-padding"><table class="admin-table"><thead><tr><th>Order</th><th>Customer</th><th>Items</th><th>Status</th><th>Total</th></tr></thead><tbody id="ov-recent-orders"></tbody></table></div>' +
                    '</div>' +
                '</div>';
            this.renderedTabs.add('overview');
        }

        var agg = this.aggregateByPeriod(data.orders, 'revenue');
        this.buildLineChart('chart-ov-revenue', agg.labels, agg.values, 'Revenue');
        var aggO = this.aggregateByPeriod(data.orders, 'count');
        this.buildBarChart('chart-ov-orders', aggO.labels, aggO.values, 'Orders');
        this.fillTopProductsAsync('ov-top-sold', 'quantity', data.products);
        this.fillTopProductsAsync('ov-top-revenue', 'revenue', data.products);
        this.fillRecentOrders('ov-recent-orders', data.orders);
    },

    /* ---- REVENUE INTELLIGENCE TAB ---- */

    renderRevenue(data) {
        var panel = document.getElementById('tab-revenue');
        if (!panel) return;

        if (!this.renderedTabs.has('revenue')) {
            panel.innerHTML =
                '<div class="admin-grid-3" style="margin-bottom:var(--spacing-4);" id="rev-summary-cards"></div>' +
                '<div class="admin-grid-2" style="margin-bottom:var(--spacing-4);">' +
                    '<div class="admin-card"><div class="admin-card__header"><h4 class="admin-card__title">Revenue Over Time</h4></div><div class="admin-card__body"><div style="height:220px;"><canvas id="chart-rev-time"></canvas></div></div></div>' +
                    '<div class="admin-card"><div class="admin-card__header"><h4 class="admin-card__title">Revenue by Brand</h4></div><div class="admin-card__body"><div style="height:220px;"><canvas id="chart-rev-brand"></canvas></div></div></div>' +
                '</div>' +
                '<div class="admin-card"><div class="admin-card__header"><h4 class="admin-card__title">Top Revenue Products</h4></div>' +
                '<div class="admin-card__body admin-card__body--no-padding"><table class="admin-table"><thead><tr><th>Product</th><th>Brand</th><th>Price</th><th>Stock</th></tr></thead><tbody id="rev-products-table"></tbody></table></div></div>';
            this.renderedTabs.add('revenue');
        }

        // Summary cards
        var cards = document.getElementById('rev-summary-cards');
        if (cards) {
            var totalRev = data.totalRevenue || 0;
            var costEst = totalRev * 0.6; // placeholder until backend P&L
            var gpEst = totalRev - costEst;
            cards.innerHTML = this.buildSummaryCard('Total Revenue', formatPrice(totalRev), 'primary') +
                this.buildSummaryCard('Est. Gross Profit', formatPrice(gpEst), 'success') +
                this.buildSummaryCard('Orders', String(data.totalOrders), 'info');
        }

        var agg = this.aggregateByPeriod(data.orders, 'revenue');
        this.buildLineChart('chart-rev-time', agg.labels, agg.values, 'Revenue');

        // Revenue by brand
        var brandMap = {};
        data.products.forEach(function(p) {
            var b = getBrandName(p.brand);
            if (!brandMap[b]) brandMap[b] = 0;
            brandMap[b] += (p.retail_price || 0);
        });
        var brandLabels = Object.keys(brandMap).sort(function(a, b) { return brandMap[b] - brandMap[a]; }).slice(0, 8);
        var brandValues = brandLabels.map(function(l) { return brandMap[l]; });
        this.buildBarChart('chart-rev-brand', brandLabels, brandValues, 'Revenue by Brand');

        this.fillTopProducts('rev-products-table', data.products, true);
    },

    /* ---- CUSTOMERS TAB ---- */

    renderCustomersTab(data) {
        var panel = document.getElementById('tab-customers-tab');
        if (!panel) return;

        if (!this.renderedTabs.has('customers-tab')) {
            panel.innerHTML =
                '<div class="admin-grid-3" style="margin-bottom:var(--spacing-4);" id="cust-summary-cards"></div>' +
                '<div class="admin-grid-2" style="margin-bottom:var(--spacing-4);">' +
                    '<div class="admin-card"><div class="admin-card__header"><h4 class="admin-card__title">Customer Breakdown</h4></div><div class="admin-card__body"><div style="height:220px;"><canvas id="chart-cust-type"></canvas></div></div></div>' +
                    '<div class="admin-card"><div class="admin-card__header"><h4 class="admin-card__title">Order Frequency</h4></div><div class="admin-card__body"><div style="height:220px;"><canvas id="chart-cust-freq"></canvas></div></div></div>' +
                '</div>' +
                '<div class="admin-card"><div class="admin-card__header"><h4 class="admin-card__title">Customer Health</h4></div>' +
                '<div class="admin-card__body admin-card__body--no-padding" id="cust-health-body"><div class="admin-empty"><div class="admin-empty__text">Customer analytics require backend endpoints</div></div></div></div>';
            this.renderedTabs.add('customers-tab');
        }

        // Summary
        var custs = data.customers || [];
        var total = custs.length;
        var vip = custs.filter(function(c) { return (c.total_spent || 0) >= 500 || (c.order_count || 0) >= 5; }).length;
        var newC = custs.filter(function(c) {
            var d = new Date(c.created_at);
            return (Date.now() - d.getTime()) < 30 * 86400000;
        }).length;

        var cards = document.getElementById('cust-summary-cards');
        if (cards) {
            cards.innerHTML = this.buildSummaryCard('Total Customers', String(total), 'primary') +
                this.buildSummaryCard('VIP Customers', String(vip), 'warning') +
                this.buildSummaryCard('New (30d)', String(newC), 'success');
        }

        // Doughnut: VIP vs Regular vs New
        this.buildDoughnutChart('chart-cust-type', ['VIP', 'Regular', 'New'], [vip, total - vip - newC, newC], ['#FBBF24', '#64748B', '#34D399']);

        // Order frequency histogram
        var freqBuckets = { '1': 0, '2-3': 0, '4-5': 0, '6+': 0 };
        custs.forEach(function(c) {
            var cnt = c.order_count || 0;
            if (cnt <= 1) freqBuckets['1']++;
            else if (cnt <= 3) freqBuckets['2-3']++;
            else if (cnt <= 5) freqBuckets['4-5']++;
            else freqBuckets['6+']++;
        });
        this.buildBarChart('chart-cust-freq', Object.keys(freqBuckets), Object.values(freqBuckets), 'Customers');
    },

    /* ---- INVENTORY TAB ---- */

    renderInventoryTab(data) {
        var panel = document.getElementById('tab-inventory');
        if (!panel) return;

        if (!this.renderedTabs.has('inventory')) {
            panel.innerHTML =
                '<div class="admin-grid-3" style="margin-bottom:var(--spacing-4);" id="inv-summary-cards"></div>' +
                '<div class="admin-grid-2" style="margin-bottom:var(--spacing-4);">' +
                    '<div class="admin-card"><div class="admin-card__header"><h4 class="admin-card__title">Stock Health</h4></div><div class="admin-card__body"><div style="height:220px;"><canvas id="chart-inv-health"></canvas></div></div></div>' +
                    '<div class="admin-card"><div class="admin-card__header"><h4 class="admin-card__title">Stock by Brand</h4></div><div class="admin-card__body"><div style="height:220px;"><canvas id="chart-inv-brand"></canvas></div></div></div>' +
                '</div>' +
                '<div class="admin-card"><div class="admin-card__header"><h4 class="admin-card__title">Low Stock Alerts</h4><a href="/html/admin/products.html" class="admin-card__action">Manage</a></div>' +
                '<div class="admin-card__body admin-card__body--no-padding"><table class="admin-table"><thead><tr><th>Product</th><th>SKU</th><th>Stock</th><th>Status</th><th></th></tr></thead><tbody id="inv-low-stock"></tbody></table></div></div>';
            this.renderedTabs.add('inventory');
        }

        var prods = data.products;
        var LOW = 10;
        try { LOW = Config.getSetting('LOW_STOCK_THRESHOLD', 10); } catch(e) {}
        var inStock = prods.filter(function(p) { return p.in_stock && p.stock_quantity > LOW; }).length;
        var lowStock = prods.filter(function(p) { return p.in_stock && p.stock_quantity <= LOW && p.stock_quantity > 0; }).length;
        var outStock = prods.filter(function(p) { return !p.in_stock || p.stock_quantity === 0; }).length;

        var cards = document.getElementById('inv-summary-cards');
        if (cards) {
            cards.innerHTML = this.buildSummaryCard('In Stock', String(inStock), 'success') +
                this.buildSummaryCard('Low Stock', String(lowStock), 'warning') +
                this.buildSummaryCard('Out of Stock', String(outStock), 'danger');
        }

        this.buildDoughnutChart('chart-inv-health', ['In Stock', 'Low Stock', 'Out of Stock'], [inStock, lowStock, outStock], ['#34D399', '#FBBF24', '#F87171']);

        // Stock by brand
        var brandStock = {};
        prods.forEach(function(p) {
            var b = getBrandName(p.brand);
            if (!brandStock[b]) brandStock[b] = 0;
            brandStock[b] += (p.stock_quantity || 0);
        });
        var bLabels = Object.keys(brandStock).sort(function(a, b) { return brandStock[b] - brandStock[a]; }).slice(0, 8);
        this.buildBarChart('chart-inv-brand', bLabels, bLabels.map(function(l) { return brandStock[l]; }), 'Stock Units');

        // Low stock table
        var tbody = document.getElementById('inv-low-stock');
        if (tbody) {
            var alertProducts = data.lowStockProducts.concat(data.outOfStockProducts).slice(0, 15);
            if (alertProducts.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" class="admin-empty" style="padding:var(--spacing-6);">No stock alerts</td></tr>';
            } else {
                tbody.innerHTML = '';
                alertProducts.forEach(function(p) {
                    var tr = document.createElement('tr');
                    var isOut = !p.in_stock || p.stock_quantity === 0;
                    tr.innerHTML =
                        '<td>' + Security.escapeHtml(p.name || '') + '</td>' +
                        '<td style="font-family:var(--font-family-mono);font-size:12px;color:var(--color-text-muted);">' + Security.escapeHtml(p.sku || '') + '</td>' +
                        '<td style="font-family:var(--font-family-mono);">' + (p.stock_quantity || 0) + '</td>' +
                        '<td><span class="admin-badge admin-badge--' + (isOut ? 'danger' : 'warning') + '">' + (isOut ? 'Out' : 'Low') + '</span></td>' +
                        '<td><a href="/html/admin/product-edit.html?sku=' + Security.escapeAttr(p.sku || '') + '" style="color:var(--color-primary);font-size:12px;">Edit</a></td>';
                    tbody.appendChild(tr);
                });
            }
        }
    },

    /* ---- OPERATIONS TAB ---- */

    renderOperationsTab(data) {
        var panel = document.getElementById('tab-operations');
        if (!panel) return;

        if (!this.renderedTabs.has('operations')) {
            panel.innerHTML =
                '<div class="admin-card" style="margin-bottom:var(--spacing-4);">' +
                    '<div class="admin-card__header"><h4 class="admin-card__title">Order Pipeline</h4></div>' +
                    '<div class="admin-card__body"><div class="admin-pipeline" id="ops-pipeline"></div></div>' +
                '</div>' +
                '<div class="admin-grid-2" style="margin-bottom:var(--spacing-4);">' +
                    '<div class="admin-card"><div class="admin-card__header"><h4 class="admin-card__title">Orders by Status</h4></div><div class="admin-card__body"><div style="height:220px;"><canvas id="chart-ops-status"></canvas></div></div></div>' +
                    '<div class="admin-card"><div class="admin-card__header"><h4 class="admin-card__title">Brand Performance</h4></div><div class="admin-card__body"><div style="height:220px;"><canvas id="chart-ops-brand"></canvas></div></div></div>' +
                '</div>' +
                '<div class="admin-card"><div class="admin-card__header"><h4 class="admin-card__title">Conversion Funnel</h4></div>' +
                '<div class="admin-card__body" id="ops-funnel"></div></div>';
            this.renderedTabs.add('operations');
        }

        // Pipeline
        var statusCounts = { pending: 0, processing: 0, shipped: 0, completed: 0, cancelled: 0 };
        (data.orders || []).forEach(function(o) {
            var s = (o.status || 'pending').toLowerCase();
            if (statusCounts.hasOwnProperty(s)) statusCounts[s]++;
        });

        var pipeline = document.getElementById('ops-pipeline');
        if (pipeline) {
            pipeline.innerHTML = '';
            ['pending', 'processing', 'shipped', 'completed', 'cancelled'].forEach(function(status) {
                var stage = document.createElement('div');
                stage.className = 'admin-pipeline__stage';
                var cnt = document.createElement('div');
                cnt.className = 'admin-pipeline__count';
                cnt.textContent = String(statusCounts[status]);
                var lbl = document.createElement('div');
                lbl.className = 'admin-pipeline__label';
                lbl.textContent = status.charAt(0).toUpperCase() + status.slice(1);
                stage.appendChild(cnt);
                stage.appendChild(lbl);
                pipeline.appendChild(stage);
            });
        }

        // Status doughnut
        var sLabels = Object.keys(statusCounts);
        var sValues = sLabels.map(function(s) { return statusCounts[s]; });
        this.buildDoughnutChart('chart-ops-status', sLabels.map(function(s) { return s.charAt(0).toUpperCase() + s.slice(1); }), sValues, ['#FBBF24', '#60A5FA', '#267FB5', '#34D399', '#F87171']);

        // Brand performance (products count per brand)
        var brandCnt = {};
        data.products.forEach(function(p) {
            var b = getBrandName(p.brand);
            if (!brandCnt[b]) brandCnt[b] = 0;
            brandCnt[b]++;
        });
        var bLabels = Object.keys(brandCnt).sort(function(a, b) { return brandCnt[b] - brandCnt[a]; }).slice(0, 8);
        this.buildBarChart('chart-ops-brand', bLabels, bLabels.map(function(l) { return brandCnt[l]; }), 'Products');

        // Conversion Funnel - try real data, fallback to placeholder
        var funnel = document.getElementById('ops-funnel');
        if (funnel) {
            this.loadConversionFunnel(funnel, data.totalOrders || 0);
        }
    },

    /* ================================================================
       CHART BUILDERS (destroy & recreate for clean theme switching)
       ================================================================ */

    destroyChart(id) {
        if (this.charts[id]) {
            this.charts[id].destroy();
            delete this.charts[id];
        }
    },

    destroyAllCharts() {
        var self = this;
        Object.keys(this.charts).forEach(function(id) {
            self.charts[id].destroy();
        });
        this.charts = {};
    },

    getBaseOptions() {
        var t = this.chartTheme[this.getTheme()];
        return {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 300 },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: t.tooltipBg,
                    titleColor: t.tooltipText,
                    bodyColor: t.tooltipText,
                    borderColor: t.tooltipBorder,
                    borderWidth: 1,
                    padding: 8,
                    cornerRadius: 4,
                    titleFont: { size: 12 },
                    bodyFont: { size: 12 }
                }
            },
            scales: {
                x: {
                    grid: { color: t.grid, drawBorder: false },
                    ticks: { color: t.tick, font: { size: 11 }, maxRotation: 0 }
                },
                y: {
                    grid: { color: t.grid, drawBorder: false },
                    ticks: { color: t.tick, font: { size: 11 } },
                    beginAtZero: true
                }
            }
        };
    },

    buildLineChart(canvasId, labels, values, label) {
        this.destroyChart(canvasId);
        var el = document.getElementById(canvasId);
        if (!el) return;
        var ctx = el.getContext('2d');
        var grad = ctx.createLinearGradient(0, 0, 0, el.parentElement.offsetHeight || 200);
        grad.addColorStop(0, 'rgba(38, 127, 181, 0.25)');
        grad.addColorStop(1, 'rgba(38, 127, 181, 0.02)');

        var opts = this.getBaseOptions();
        this.charts[canvasId] = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: label,
                    data: values,
                    borderColor: '#267FB5',
                    backgroundColor: grad,
                    fill: true,
                    tension: 0.3,
                    pointRadius: 2,
                    pointHoverRadius: 4,
                    borderWidth: 2
                }]
            },
            options: opts
        });
    },

    buildBarChart(canvasId, labels, values, label) {
        this.destroyChart(canvasId);
        var el = document.getElementById(canvasId);
        if (!el) return;
        var opts = this.getBaseOptions();
        this.charts[canvasId] = new Chart(el.getContext('2d'), {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: label,
                    data: values,
                    backgroundColor: 'rgba(38, 127, 181, 0.7)',
                    borderColor: '#267FB5',
                    borderWidth: 1,
                    borderRadius: 3,
                    maxBarThickness: 40
                }]
            },
            options: opts
        });
    },

    buildDoughnutChart(canvasId, labels, values, colors) {
        this.destroyChart(canvasId);
        var el = document.getElementById(canvasId);
        if (!el) return;
        var t = this.chartTheme[this.getTheme()];
        this.charts[canvasId] = new Chart(el.getContext('2d'), {
            type: 'doughnut',
            data: {
                labels: labels,
                datasets: [{
                    data: values,
                    backgroundColor: colors,
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 300 },
                cutout: '65%',
                plugins: {
                    legend: {
                        position: 'right',
                        labels: { color: t.tick, font: { size: 12 }, padding: 12, usePointStyle: true, pointStyleWidth: 8 }
                    },
                    tooltip: {
                        backgroundColor: t.tooltipBg,
                        titleColor: t.tooltipText,
                        bodyColor: t.tooltipText,
                        borderColor: t.tooltipBorder,
                        borderWidth: 1,
                        padding: 8,
                        cornerRadius: 4
                    }
                }
            }
        });
    },

    /* ================================================================
       DATA AGGREGATION
       ================================================================ */

    aggregateByPeriod(orders, type) {
        var days = DashboardState.periodToDays();
        var now = new Date();
        var buckets = {};
        var labels = [];

        for (var i = days - 1; i >= 0; i--) {
            var d = new Date(now);
            d.setDate(d.getDate() - i);
            var key = d.toISOString().split('T')[0];
            buckets[key] = 0;
            labels.push(this.formatDateLabel(d, days));
        }

        (orders || []).forEach(function(o) {
            var oDate = new Date(o.created_at || o.date);
            var key = oDate.toISOString().split('T')[0];
            if (buckets.hasOwnProperty(key)) {
                if (type === 'revenue') buckets[key] += (o.total || 0);
                else buckets[key]++;
            }
        });

        var values = Object.values(buckets);
        return { labels: labels, values: values };
    },

    formatDateLabel(d, totalDays) {
        var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        if (totalDays <= 7) return months[d.getMonth()] + ' ' + d.getDate();
        if (totalDays <= 90) return d.getDate() + '/' + (d.getMonth() + 1);
        return months[d.getMonth()] + ' ' + d.getFullYear().toString().slice(2);
    },

    /* ================================================================
       TABLE RENDERERS
       ================================================================ */

    // TODO: see BACKEND_ADMIN_GAPS.md #1/#2 - top products by quantity/revenue
    fillTopProductsAsync(tbodyId, metric, products) {
        var tbody = document.getElementById(tbodyId);
        if (!tbody) return;

        // Fallback: sort client-side by price (backend doesn't yet return units_sold/total_revenue)
        var sorted = products.slice().sort(function(a, b) { return (b.retail_price || 0) - (a.retail_price || 0); });
        var top = sorted.slice(0, 8);

        if (top.length === 0) {
            tbody.innerHTML = '<tr><td colspan="3" class="admin-empty" style="padding:var(--spacing-6);">No products</td></tr>';
            return;
        }
        tbody.innerHTML = '';
        top.forEach(function(p) {
            var tr = document.createElement('tr');
            tr.style.cursor = 'pointer';
            tr.onclick = function() { Dashboard.openProductDrawer(p); };

            var nameCell = document.createElement('td');
            var nameDiv = document.createElement('div');
            nameDiv.style.fontWeight = '500';
            nameDiv.textContent = p.name || '';
            var skuDiv = document.createElement('div');
            skuDiv.style.cssText = 'font-size:11px;color:var(--color-text-muted);font-family:var(--font-family-mono);';
            skuDiv.textContent = p.sku || '';
            nameCell.appendChild(nameDiv);
            nameCell.appendChild(skuDiv);
            tr.appendChild(nameCell);

            var metricCell = document.createElement('td');
            metricCell.style.fontFamily = 'var(--font-family-mono)';
            if (metric === 'quantity') {
                metricCell.textContent = p.units_sold != null ? String(p.units_sold) : '--';
            } else {
                metricCell.textContent = p.total_revenue != null ? formatPrice(p.total_revenue) : formatPrice(p.retail_price || 0);
            }
            tr.appendChild(metricCell);

            var stockCell = document.createElement('td');
            var badge = document.createElement('span');
            var isOut = !p.in_stock || (p.stock_quantity || 0) === 0;
            var isLow = p.in_stock && (p.stock_quantity || 0) <= 10;
            badge.className = 'admin-badge admin-badge--' + (isOut ? 'danger' : isLow ? 'warning' : 'success');
            badge.textContent = isOut ? 'Out' : String(p.stock_quantity || 0);
            stockCell.appendChild(badge);
            tr.appendChild(stockCell);

            tbody.appendChild(tr);
        });
    },

    fillTopProducts(tbodyId, products, showBrand) {
        var tbody = document.getElementById(tbodyId);
        if (!tbody) return;
        var sorted = products.slice().sort(function(a, b) { return (b.retail_price || 0) - (a.retail_price || 0); });
        var top = sorted.slice(0, 8);
        if (top.length === 0) {
            tbody.innerHTML = '<tr><td colspan="' + (showBrand ? 4 : 3) + '" class="admin-empty" style="padding:var(--spacing-6);">No products</td></tr>';
            return;
        }
        tbody.innerHTML = '';
        top.forEach(function(p) {
            var tr = document.createElement('tr');
            tr.style.cursor = 'pointer';
            tr.onclick = function() { Dashboard.openProductDrawer(p); };
            var nameCell = document.createElement('td');
            var nameDiv = document.createElement('div');
            nameDiv.style.fontWeight = '500';
            nameDiv.textContent = p.name || '';
            var skuDiv = document.createElement('div');
            skuDiv.style.cssText = 'font-size:11px;color:var(--color-text-muted);font-family:var(--font-family-mono);';
            skuDiv.textContent = p.sku || '';
            nameCell.appendChild(nameDiv);
            nameCell.appendChild(skuDiv);
            tr.appendChild(nameCell);

            if (showBrand) {
                var brandCell = document.createElement('td');
                brandCell.textContent = getBrandName(p.brand);
                tr.appendChild(brandCell);
            }

            var priceCell = document.createElement('td');
            priceCell.style.fontFamily = 'var(--font-family-mono)';
            priceCell.textContent = formatPrice(p.retail_price || 0);
            tr.appendChild(priceCell);

            var stockCell = document.createElement('td');
            var badge = document.createElement('span');
            var isOut = !p.in_stock || (p.stock_quantity || 0) === 0;
            var isLow = p.in_stock && (p.stock_quantity || 0) <= 10;
            badge.className = 'admin-badge admin-badge--' + (isOut ? 'danger' : isLow ? 'warning' : 'success');
            badge.textContent = isOut ? 'Out' : String(p.stock_quantity || 0);
            stockCell.appendChild(badge);
            tr.appendChild(stockCell);

            tbody.appendChild(tr);
        });
    },

    fillRecentOrders(tbodyId, orders) {
        var tbody = document.getElementById(tbodyId);
        if (!tbody) return;
        var recent = orders.slice(0, 10);
        if (recent.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" class="admin-empty" style="padding:var(--spacing-6);">No orders yet</td></tr>';
            return;
        }
        tbody.innerHTML = '';
        recent.forEach(function(o) {
            var tr = document.createElement('tr');
            tr.style.cursor = 'pointer';
            tr.onclick = function() { Dashboard.openOrderDrawer(o); };

            var idCell = document.createElement('td');
            idCell.style.cssText = 'font-family:var(--font-family-mono);font-weight:500;color:var(--color-primary);';
            idCell.textContent = '#' + (o.order_number || o.id || '');
            tr.appendChild(idCell);

            // Customer name + email subtitle
            var custCell = document.createElement('td');
            var custName = document.createElement('div');
            custName.style.fontWeight = '500';
            custName.textContent = o.shipping_recipient_name || o.customer_email || '';
            custCell.appendChild(custName);
            if (o.customer_email && o.shipping_recipient_name) {
                var custEmail = document.createElement('div');
                custEmail.style.cssText = 'font-size:11px;color:var(--color-text-muted);';
                custEmail.textContent = o.customer_email;
                custCell.appendChild(custEmail);
            }
            tr.appendChild(custCell);

            // TODO: see BACKEND_ADMIN_GAPS.md #4 - order line items
            var itemsCell = document.createElement('td');
            itemsCell.style.cssText = 'font-size:12px;color:var(--color-text-muted);';
            var lineItems = o.items || o.line_items || o.order_items || [];
            itemsCell.textContent = lineItems.length > 0 ? lineItems.length + ' item' + (lineItems.length !== 1 ? 's' : '') : '--';
            tr.appendChild(itemsCell);

            var statusCell = document.createElement('td');
            var badge = document.createElement('span');
            var st = (o.status || 'pending').toLowerCase();
            badge.className = 'admin-status admin-status--' + st;
            badge.textContent = st.charAt(0).toUpperCase() + st.slice(1);
            statusCell.appendChild(badge);
            tr.appendChild(statusCell);

            var totalCell = document.createElement('td');
            totalCell.style.cssText = 'font-family:var(--font-family-mono);font-weight:600;';
            totalCell.textContent = formatPrice(o.total || 0);
            tr.appendChild(totalCell);

            tbody.appendChild(tr);
        });
    },

    /* ================================================================
       SUMMARY CARD BUILDER
       ================================================================ */

    buildSummaryCard(label, value, variant) {
        return '<div class="admin-card admin-card--compact"><div class="admin-card__body" style="text-align:center;">' +
            '<div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.025em;color:var(--color-text-muted);margin-bottom:4px;">' + Security.escapeHtml(label) + '</div>' +
            '<div style="font-size:20px;font-weight:700;font-family:var(--font-family-mono);color:var(--color-' + Security.escapeAttr(variant) + ');">' + Security.escapeHtml(value) + '</div>' +
            '</div></div>';
    },

    /* ================================================================
       DRAWER
       ================================================================ */

    openDrawer(title, bodyHTML, footerHTML) {
        var titleEl = document.getElementById('drawer-title');
        var body = document.getElementById('drawer-body');
        var footer = document.getElementById('drawer-footer');
        var backdrop = document.getElementById('drawer-backdrop');
        var drawer = document.getElementById('admin-drawer');

        if (titleEl) titleEl.textContent = title;
        if (body) body.innerHTML = bodyHTML;
        if (footer) footer.innerHTML = footerHTML || '';
        if (backdrop) backdrop.classList.add('admin-drawer-backdrop--open');
        if (drawer) drawer.classList.add('admin-drawer--open');
    },

    closeDrawer() {
        var backdrop = document.getElementById('drawer-backdrop');
        var drawer = document.getElementById('admin-drawer');
        if (backdrop) backdrop.classList.remove('admin-drawer-backdrop--open');
        if (drawer) drawer.classList.remove('admin-drawer--open');
    },

    initDrawerEvents() {
        var closeBtn = document.getElementById('drawer-close');
        var backdrop = document.getElementById('drawer-backdrop');
        if (closeBtn) closeBtn.addEventListener('click', function() { Dashboard.closeDrawer(); });
        if (backdrop) backdrop.addEventListener('click', function() { Dashboard.closeDrawer(); });
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') Dashboard.closeDrawer();
        });
    },

    openOrderDrawer(order) {
        var html = '<div class="admin-drawer__section">' +
            '<div class="admin-drawer__section-title">Order Info</div>' +
            '<div class="admin-drawer__row"><span class="admin-drawer__label">Order #</span><span class="admin-drawer__value">' + Security.escapeHtml(order.order_number || order.id || '') + '</span></div>' +
            '<div class="admin-drawer__row"><span class="admin-drawer__label">Status</span><span class="admin-status admin-status--' + Security.escapeAttr((order.status || 'pending').toLowerCase()) + '">' + Security.escapeHtml(order.status || 'pending') + '</span></div>' +
            '<div class="admin-drawer__row"><span class="admin-drawer__label">Date</span><span class="admin-drawer__value">' + Security.escapeHtml(order.created_at ? new Date(order.created_at).toLocaleDateString('en-NZ') : '') + '</span></div>' +
            '<div class="admin-drawer__row"><span class="admin-drawer__label">Total</span><span class="admin-drawer__value">' + Security.escapeHtml(formatPrice(order.total || 0)) + '</span></div>' +
            '</div>';

        html += '<hr class="admin-drawer__divider">';
        html += '<div class="admin-drawer__section"><div class="admin-drawer__section-title">Customer</div>' +
            '<div class="admin-drawer__row"><span class="admin-drawer__label">Name</span><span class="admin-drawer__value">' + Security.escapeHtml(order.shipping_recipient_name || '') + '</span></div>' +
            '<div class="admin-drawer__row"><span class="admin-drawer__label">Email</span><span class="admin-drawer__value">' + Security.escapeHtml(order.customer_email || '') + '</span></div>';
        // TODO: see BACKEND_ADMIN_GAPS.md #5 - customer phone
        if (order.shipping_phone) {
            html += '<div class="admin-drawer__row"><span class="admin-drawer__label">Phone</span><span class="admin-drawer__value">' + Security.escapeHtml(order.shipping_phone) + '</span></div>';
        }
        html += '</div>';

        // TODO: see BACKEND_ADMIN_GAPS.md #4 - order line items
        var lineItems = order.items || order.line_items || order.order_items || [];
        if (lineItems.length > 0) {
            html += '<hr class="admin-drawer__divider">';
            html += '<div class="admin-drawer__section"><div class="admin-drawer__section-title">Items Ordered</div>';
            lineItems.forEach(function(item) {
                var itemName = Security.escapeHtml(item.product_name || item.name || 'Item');
                var qty = item.quantity || 1;
                var price = item.line_total || item.price || 0;
                html += '<div class="admin-drawer__row"><span class="admin-drawer__label">' + itemName + ' &times; ' + qty + '</span><span class="admin-drawer__value">' + Security.escapeHtml(formatPrice(price)) + '</span></div>';
            });
            html += '</div>';
        }

        // Timeline
        html += '<hr class="admin-drawer__divider">';
        html += '<div class="admin-drawer__section"><div class="admin-drawer__section-title">Status Timeline</div><ul class="admin-timeline">';
        var steps = ['pending', 'processing', 'shipped', 'completed'];
        var currentIdx = steps.indexOf((order.status || 'pending').toLowerCase());
        steps.forEach(function(step, i) {
            var dotClass = i < currentIdx ? 'admin-timeline__dot--done' : i === currentIdx ? 'admin-timeline__dot--active' : '';
            html += '<li class="admin-timeline__item"><div class="admin-timeline__dot ' + dotClass + '"></div><div class="admin-timeline__content"><div class="admin-timeline__label">' + Security.escapeHtml(step.charAt(0).toUpperCase() + step.slice(1)) + '</div></div></li>';
        });
        html += '</ul></div>';

        var footer = '<a href="/html/admin/orders.html" class="btn btn--primary btn--small" style="font-size:13px;">View Full Details</a>';
        this.openDrawer('Order #' + Security.escapeHtml(order.order_number || order.id || ''), html, footer);
    },

    openProductDrawer(product) {
        var html = '<div class="admin-drawer__section">' +
            '<div class="admin-drawer__section-title">Product Info</div>' +
            '<div class="admin-drawer__row"><span class="admin-drawer__label">Name</span><span class="admin-drawer__value" style="font-family:inherit;">' + Security.escapeHtml(product.name || '') + '</span></div>' +
            '<div class="admin-drawer__row"><span class="admin-drawer__label">SKU</span><span class="admin-drawer__value">' + Security.escapeHtml(product.sku || '') + '</span></div>' +
            '<div class="admin-drawer__row"><span class="admin-drawer__label">Brand</span><span class="admin-drawer__value" style="font-family:inherit;">' + Security.escapeHtml(getBrandName(product.brand)) + '</span></div>' +
            '<div class="admin-drawer__row"><span class="admin-drawer__label">Category</span><span class="admin-drawer__value" style="font-family:inherit;">' + Security.escapeHtml(product.category || '') + '</span></div>' +
            '</div>';

        html += '<hr class="admin-drawer__divider">';
        html += '<div class="admin-drawer__section"><div class="admin-drawer__section-title">Pricing & Stock</div>' +
            '<div class="admin-drawer__row"><span class="admin-drawer__label">Price</span><span class="admin-drawer__value">' + Security.escapeHtml(formatPrice(product.retail_price || 0)) + '</span></div>' +
            '<div class="admin-drawer__row"><span class="admin-drawer__label">Cost</span><span class="admin-drawer__value">' + Security.escapeHtml(product.cost_price ? formatPrice(product.cost_price) : '--') + '</span></div>' +
            '<div class="admin-drawer__row"><span class="admin-drawer__label">Stock</span><span class="admin-drawer__value">' + (product.stock_quantity || 0) + '</span></div>' +
            '<div class="admin-drawer__row"><span class="admin-drawer__label">Status</span><span class="admin-badge admin-badge--' + (product.in_stock ? 'success' : 'danger') + '">' + (product.in_stock ? 'In Stock' : 'Out of Stock') + '</span></div></div>';

        if (product.updated_at) {
            html += '<hr class="admin-drawer__divider">';
            html += '<div class="admin-drawer__row"><span class="admin-drawer__label">Last Updated</span><span class="admin-drawer__value" style="font-size:12px;">' + Security.escapeHtml(new Date(product.updated_at).toLocaleDateString('en-NZ')) + '</span></div>';
        }

        var footer = '<a href="/html/admin/product-edit.html?sku=' + Security.escapeAttr(product.sku || '') + '" class="btn btn--primary btn--small" style="font-size:13px;">Edit Product</a>';
        this.openDrawer(Security.escapeHtml(product.name || 'Product'), html, footer);
    },

    /* ================================================================
       ERROR / EMPTY STATES
       ================================================================ */

    renderError() {
        var panel = document.getElementById('tab-overview');
        if (!panel) return;
        panel.innerHTML = '<div class="admin-empty">' +
            '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin:0 auto var(--spacing-3);display:block;opacity:0.4;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>' +
            '<div class="admin-empty__title">Unable to load dashboard data</div>' +
            '<div class="admin-empty__text">Check your connection and try again.</div>' +
            '<button class="btn btn--primary btn--small" onclick="Admin.loadDashboard()" style="margin-top:var(--spacing-3);">Retry</button></div>';
    },

    /* ================================================================
       THEME SWITCH: destroy all charts, re-render active tab
       ================================================================ */

    onThemeChange(data) {
        // Only destroy charts in the active tab and re-render it (not all tabs)
        var activeTab = document.querySelector('.admin-tab--active');
        var activeTabId = activeTab ? activeTab.dataset.tab : null;
        if (activeTabId) {
            // Destroy only charts belonging to the active tab panel
            var panel = document.getElementById('tab-' + activeTabId);
            if (panel) {
                var canvases = panel.querySelectorAll('canvas');
                var self = this;
                canvases.forEach(function(c) { self.destroyChart(c.id); });
            }
            this.renderedTabs.delete(activeTabId);
            if (data) this.renderTab(activeTabId, data);
        }
    },

    // TODO: see BACKEND_ADMIN_GAPS.md #3 - conversion funnel endpoint
    loadConversionFunnel: function(container, totalOrders) {
        var renderFunnel = function(steps, note) {
            container.innerHTML = '<div class="admin-funnel">' + steps.map(function(s) {
                return '<div class="admin-funnel__step">' +
                    '<div class="admin-funnel__label">' + Security.escapeHtml(s.label) + '</div>' +
                    '<div class="admin-funnel__bar" style="width:' + s.pct + '%;background:' + s.color + ';"></div>' +
                    '<div class="admin-funnel__value">' + Security.escapeHtml(String(s.value)) + '</div></div>';
            }).join('') + '</div>' +
            (note ? '<p style="font-size:12px;color:var(--color-text-muted);margin-top:var(--spacing-3);">' + Security.escapeHtml(note) + '</p>' : '');
        };

        // Try backend first
        if (typeof AnalyticsAPI !== 'undefined' && AnalyticsAPI.getConversionFunnel) {
            AnalyticsAPI.getConversionFunnel().then(function(res) {
                if (res && res.success && res.data && Array.isArray(res.data.steps)) {
                    var steps = res.data.steps.map(function(s) {
                        return { label: s.label, value: s.count || s.value || 0, pct: s.percentage || 0, color: s.color || 'var(--cyan-primary)' };
                    });
                    renderFunnel(steps, null);
                    return;
                }
                throw new Error('no data');
            }).catch(function() {
                // Fallback to placeholder
                renderFunnel([
                    { label: 'Visitors', value: '--', pct: 100, color: 'var(--cyan-primary)' },
                    { label: 'Product Views', value: '--', pct: 60, color: '#8b5cf6' },
                    { label: 'Add to Cart', value: '--', pct: 25, color: 'var(--yellow-primary)' },
                    { label: 'Checkout', value: '--', pct: 10, color: 'var(--magenta-primary)' },
                    { label: 'Purchase', value: totalOrders, pct: 5, color: '#34D399' }
                ], 'Funnel data requires analytics backend endpoints');
            });
        } else {
            renderFunnel([
                { label: 'Visitors', value: '--', pct: 100, color: 'var(--cyan-primary)' },
                { label: 'Product Views', value: '--', pct: 60, color: '#8b5cf6' },
                { label: 'Add to Cart', value: '--', pct: 25, color: 'var(--yellow-primary)' },
                { label: 'Checkout', value: '--', pct: 10, color: 'var(--magenta-primary)' },
                { label: 'Purchase', value: totalOrders, pct: 5, color: '#34D399' }
            ], 'Funnel data requires analytics backend endpoints');
        }
    }
};

window.DashboardState = DashboardState;
window.Dashboard = Dashboard;
