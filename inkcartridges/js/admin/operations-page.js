    const OperationsPage = {
        charts: {},
        products: [],
        orderItems: [],
        currentTab: 'all',
        currentSort: 'velocity-desc',

        async init() {
            const container = document.querySelector('.operations-container') || document.querySelector('main');
            if (container) {
                container.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-secondary);font-size:15px;">Stock tracking has been disabled</div>';
            }
            return;
            this.bindEvents();
            await this.loadData();
        },

        bindEvents() {
            // Period filter buttons
            document.querySelectorAll('.admin-chart__period-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    document.querySelectorAll('.admin-chart__period-btn').forEach(b =>
                        b.classList.remove('admin-chart__period-btn--active'));
                    e.target.classList.add('admin-chart__period-btn--active');
                    this.currentPeriod = e.target.dataset.period;
                    this.loadData();
                });
            });

            // Tab navigation
            document.querySelectorAll('.tab-nav__btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    document.querySelectorAll('.tab-nav__btn').forEach(b => b.classList.remove('tab-nav__btn--active'));
                    btn.classList.add('tab-nav__btn--active');
                    this.currentTab = btn.dataset.tab;
                    this.renderInventoryTable();
                });
            });

            // Sort select
            document.getElementById('sort-select').addEventListener('change', (e) => {
                this.currentSort = e.target.value;
                this.renderInventoryTable();
            });
        },

        async loadData() {
            try {
                // Load products
                const productsResponse = await API.getProducts({ limit: 500 });
                this.products = productsResponse.ok ? (productsResponse.data?.products || []) : [];

                // Load orders to calculate sales velocity
                const ordersResponse = await API.getOrders({ limit: 500 });
                const orders = ordersResponse.ok ? (ordersResponse.data?.orders || []) : [];

                // Extract order items
                this.orderItems = [];
                orders.forEach(order => {
                    if (order.status === 'cancelled' || order.status === 'refunded') return;
                    (order.items || order.order_items || []).forEach(item => {
                        this.orderItems.push({
                            ...item,
                            order_date: new Date(order.created_at)
                        });
                    });
                });

                // Calculate metrics for each product
                this.calculateProductMetrics();

                // Update KPIs
                this.updateKPIs();

                // Render charts
                this.renderInventoryStatusChart();
                this.renderVelocityChart();

                // Render table
                this.renderInventoryTable();

                // Check alerts
                this.checkAlerts();

            } catch (error) {
                DebugLog.error('Error loading operations data:', error);
            }
        },

        calculateProductMetrics() {
            const now = new Date();
            const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000);
            const ninetyDaysAgo = new Date(now - 90 * 24 * 60 * 60 * 1000);

            // Group sales by product
            const salesByProduct = {};
            this.orderItems.forEach(item => {
                const productId = item.product_id || item.sku;
                if (!salesByProduct[productId]) {
                    salesByProduct[productId] = {
                        totalUnits: 0,
                        recentUnits: 0, // Last 30 days
                        lastSaleDate: null,
                        totalRevenue: 0
                    };
                }

                salesByProduct[productId].totalUnits += item.quantity || 1;
                salesByProduct[productId].totalRevenue += item.line_total || 0;

                if (item.order_date > thirtyDaysAgo) {
                    salesByProduct[productId].recentUnits += item.quantity || 1;
                }

                if (!salesByProduct[productId].lastSaleDate || item.order_date > salesByProduct[productId].lastSaleDate) {
                    salesByProduct[productId].lastSaleDate = item.order_date;
                }
            });

            // Calculate metrics for each product
            this.products = this.products.map(product => {
                const sales = salesByProduct[product.id] || salesByProduct[product.sku] || {
                    totalUnits: 0,
                    recentUnits: 0,
                    lastSaleDate: null,
                    totalRevenue: 0
                };

                const stockQuantity = product.stock_quantity || 0;
                const costPrice = product.cost_price || product.price * 0.6; // Estimate 60% cost if not set
                const stockValue = stockQuantity * costPrice;

                // Monthly velocity (based on last 30 days)
                const monthlyVelocity = sales.recentUnits;

                // Days of stock
                const daysOfStock = monthlyVelocity > 0
                    ? Math.round(stockQuantity / (monthlyVelocity / 30))
                    : 9999;

                // Annual turnover rate
                const annualSales = sales.totalUnits * (365 / 365); // Simplified
                const turnoverRate = stockValue > 0 ? (annualSales * costPrice) / stockValue : 0;

                // Determine status
                let stockStatus = 'active';
                let daysSinceLastSale = sales.lastSaleDate
                    ? Math.floor((now - sales.lastSaleDate) / (1000 * 60 * 60 * 24))
                    : 9999;

                if (daysSinceLastSale > 180 || !sales.lastSaleDate) {
                    stockStatus = 'dead';
                } else if (daysSinceLastSale > 90) {
                    stockStatus = 'dead';
                } else if (daysSinceLastSale > 45) {
                    stockStatus = 'slow';
                } else if (monthlyVelocity >= 10) {
                    stockStatus = 'fast';
                }

                return {
                    ...product,
                    stockValue,
                    monthlyVelocity,
                    daysOfStock,
                    turnoverRate,
                    stockStatus,
                    lastSaleDate: sales.lastSaleDate,
                    daysSinceLastSale,
                    totalUnitsSold: sales.totalUnits,
                    totalRevenue: sales.totalRevenue
                };
            });
        },

        updateKPIs() {
            const productsWithStock = this.products.filter(p => (p.stock_quantity || 0) > 0);

            // Inventory turnover (weighted average)
            const totalCOGS = this.products.reduce((sum, p) => sum + (p.totalUnitsSold * (p.cost_price || p.price * 0.6)), 0);
            const avgInventory = productsWithStock.reduce((sum, p) => sum + p.stockValue, 0) / 2;
            const turnoverRate = avgInventory > 0 ? (totalCOGS / avgInventory).toFixed(1) : 0;
            document.getElementById('turnover-rate').textContent = `${turnoverRate}x`;

            // Dead stock value
            const deadStock = productsWithStock.filter(p => p.stockStatus === 'dead');
            const deadStockValue = deadStock.reduce((sum, p) => sum + p.stockValue, 0);
            document.getElementById('dead-stock-value').textContent = formatPrice(deadStockValue);
            document.getElementById('dead-stock-count').textContent = `${deadStock.length} SKUs (90+ days)`;

            // Update card styling based on dead stock value
            const deadStockCard = document.getElementById('dead-stock-card');
            if (deadStockValue > 10000) {
                deadStockCard.classList.add('kpi-card--critical');
            } else if (deadStockValue > 5000) {
                deadStockCard.classList.add('kpi-card--warning');
            }

            // Average velocity
            const totalVelocity = productsWithStock.reduce((sum, p) => sum + p.monthlyVelocity, 0);
            const avgVelocity = productsWithStock.length > 0 ? (totalVelocity / productsWithStock.length).toFixed(1) : 0;
            document.getElementById('avg-velocity').textContent = `${avgVelocity}/mo`;

            // Cash lockup
            const totalStockValue = productsWithStock.reduce((sum, p) => sum + p.stockValue, 0);
            document.getElementById('cash-lockup').textContent = formatPrice(totalStockValue);

            const avgDaysOfStock = productsWithStock.length > 0
                ? productsWithStock.reduce((sum, p) => sum + Math.min(p.daysOfStock, 365), 0) / productsWithStock.length
                : 0;
            document.getElementById('days-of-stock').textContent = `~${Math.round(avgDaysOfStock)} avg days of stock`;

            // Summary cards
            const activeSkus = productsWithStock.filter(p => p.daysSinceLastSale <= 30).length;
            const slowSkus = productsWithStock.filter(p => p.stockStatus === 'slow').length;
            const deadSkus = deadStock.length;

            document.getElementById('active-skus').textContent = activeSkus;
            document.getElementById('slow-moving-skus').textContent = slowSkus;
            document.getElementById('dead-skus').textContent = deadSkus;
        },

        renderInventoryStatusChart() {
            const ctx = document.getElementById('inventory-status-chart');
            if (!ctx) return;

            if (this.charts.status) this.charts.status.destroy();

            const productsWithStock = this.products.filter(p => (p.stock_quantity || 0) > 0);

            const statusValues = {
                'Active': productsWithStock.filter(p => p.stockStatus === 'active' || p.stockStatus === 'fast').reduce((sum, p) => sum + p.stockValue, 0),
                'Slow Moving': productsWithStock.filter(p => p.stockStatus === 'slow').reduce((sum, p) => sum + p.stockValue, 0),
                'Dead Stock': productsWithStock.filter(p => p.stockStatus === 'dead').reduce((sum, p) => sum + p.stockValue, 0)
            };

            this.charts.status = new Chart(ctx, {
                type: 'doughnut',
                data: {
                    labels: Object.keys(statusValues),
                    datasets: [{
                        data: Object.values(statusValues),
                        backgroundColor: ['#10b981', '#F4C430', '#C71F6E']
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { position: 'bottom' },
                        tooltip: {
                            callbacks: {
                                label: (ctx) => `${ctx.label}: ${formatPrice(ctx.raw)}`
                            }
                        }
                    }
                }
            });
        },

        renderVelocityChart() {
            const ctx = document.getElementById('velocity-chart');
            if (!ctx) return;

            if (this.charts.velocity) this.charts.velocity.destroy();

            // Create velocity distribution buckets
            const buckets = {
                '0': 0,
                '1-5': 0,
                '6-10': 0,
                '11-20': 0,
                '21-50': 0,
                '50+': 0
            };

            this.products.filter(p => (p.stock_quantity || 0) > 0).forEach(p => {
                const v = p.monthlyVelocity;
                if (v === 0) buckets['0']++;
                else if (v <= 5) buckets['1-5']++;
                else if (v <= 10) buckets['6-10']++;
                else if (v <= 20) buckets['11-20']++;
                else if (v <= 50) buckets['21-50']++;
                else buckets['50+']++;
            });

            this.charts.velocity = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: Object.keys(buckets),
                    datasets: [{
                        label: 'Products',
                        data: Object.values(buckets),
                        backgroundColor: '#267FB5',
                        borderRadius: 4
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        y: { beginAtZero: true, title: { display: true, text: 'Number of Products' } },
                        x: { title: { display: true, text: 'Units/Month' } }
                    }
                }
            });
        },

        renderInventoryTable() {
            const tbody = document.getElementById('inventory-tbody');

            // Filter by tab
            let filtered = this.products.filter(p => (p.stock_quantity || 0) > 0);

            if (this.currentTab === 'dead') {
                filtered = filtered.filter(p => p.stockStatus === 'dead');
            } else if (this.currentTab === 'slow') {
                filtered = filtered.filter(p => p.stockStatus === 'slow');
            } else if (this.currentTab === 'fast') {
                filtered = filtered.filter(p => p.stockStatus === 'fast' || p.monthlyVelocity >= 10);
            }

            // Sort
            const [sortField, sortDir] = this.currentSort.split('-');
            filtered.sort((a, b) => {
                let aVal, bVal;
                switch (sortField) {
                    case 'velocity':
                        aVal = a.monthlyVelocity;
                        bVal = b.monthlyVelocity;
                        break;
                    case 'value':
                        aVal = a.stockValue;
                        bVal = b.stockValue;
                        break;
                    case 'days':
                        aVal = a.daysOfStock;
                        bVal = b.daysOfStock;
                        break;
                    case 'margin':
                        aVal = a.price - (a.cost_price || a.price * 0.6);
                        bVal = b.price - (b.cost_price || b.price * 0.6);
                        break;
                    default:
                        aVal = a.monthlyVelocity;
                        bVal = b.monthlyVelocity;
                }
                return sortDir === 'desc' ? bVal - aVal : aVal - bVal;
            });

            if (filtered.length === 0) {
                tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; padding: var(--spacing-6); color: var(--color-text-muted);">No products match the selected filter</td></tr>';
                return;
            }

            const maxVelocity = Math.max(...filtered.map(p => p.monthlyVelocity), 1);

            tbody.innerHTML = filtered.slice(0, 50).map(product => {
                const statusClass = {
                    'active': 'active',
                    'fast': 'active',
                    'slow': 'slow',
                    'dead': 'dead'
                }[product.stockStatus] || 'moderate';

                const velocityPct = (product.monthlyVelocity / maxVelocity) * 100;

                return `
                    <tr>
                        <td>
                            <div style="font-weight: var(--font-weight-medium);">${product.name || 'Unknown Product'}</div>
                        </td>
                        <td><code style="font-size: var(--font-size-xs);">${product.sku || '--'}</code></td>
                        <td>${product.stock_quantity || 0}</td>
                        <td>${formatPrice(product.stockValue)}</td>
                        <td>${product.daysOfStock < 9999 ? Math.round(product.daysOfStock) + ' days' : '∞'}</td>
                        <td>
                            <div style="display: flex; align-items: center; gap: 8px;">
                                <div class="velocity-bar">
                                    <div class="velocity-bar__fill" style="width: ${velocityPct}%;"></div>
                                </div>
                                <span style="font-size: var(--font-size-xs);">${product.monthlyVelocity}/mo</span>
                            </div>
                        </td>
                        <td><span class="status-badge status-badge--${statusClass}">${product.stockStatus}</span></td>
                        <td>
                            ${product.lastSaleDate
                                ? `<div>${product.lastSaleDate.toLocaleDateString('en-NZ')}</div>
                                   <div style="font-size: var(--font-size-xs); color: var(--color-text-muted);">${product.daysSinceLastSale} days ago</div>`
                                : '<span style="color: var(--color-text-muted);">Never</span>'
                            }
                        </td>
                    </tr>
                `;
            }).join('');
        },

        checkAlerts() {
            const deadStock = this.products.filter(p => p.stockStatus === 'dead' && (p.stock_quantity || 0) > 0);
            const deadStockValue = deadStock.reduce((sum, p) => sum + p.stockValue, 0);

            if (deadStockValue > 5000 || deadStock.length > 20) {
                const alertBanner = document.getElementById('dead-stock-alert');
                alertBanner.style.display = 'flex';

                if (deadStockValue > 10000) {
                    alertBanner.className = 'alert-banner alert-banner--critical';
                    document.getElementById('dead-stock-alert-title').textContent = 'Critical: High Dead Stock Value';
                    document.getElementById('dead-stock-alert-text').textContent =
                        `${formatPrice(deadStockValue)} locked in ${deadStock.length} dead stock items. Consider clearance or write-off.`;
                } else {
                    document.getElementById('dead-stock-alert-text').textContent =
                        `${deadStock.length} items totaling ${formatPrice(deadStockValue)} haven't sold in 90+ days.`;
                }
            }
        },

        scrollToDeadStock() {
            document.querySelector('[data-tab="dead"]').click();
            document.querySelector('.inventory-table').scrollIntoView({ behavior: 'smooth' });
        }
    };

    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(() => { OperationsPage.init(); }, 500);
    });
