    const SalesPage = {
        charts: {},

        currentPeriod: '7d',

        async init() {
            this.bindEvents();
            await this.loadData();
        },

        bindEvents() {
            document.querySelectorAll('.admin-chart__period-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    document.querySelectorAll('.admin-chart__period-btn').forEach(b => {
                        b.classList.remove('admin-chart__period-btn--active');
                    });
                    e.target.classList.add('admin-chart__period-btn--active');
                    this.currentPeriod = e.target.dataset.period;
                    this.loadData();
                });
            });
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
            return configs[this.currentPeriod] || configs['7d'];
        },

        async loadData() {
            try {
                const ordersResponse = await API.getOrders({ limit: 100 });
                const orders = ordersResponse.ok ? (ordersResponse.data?.orders || []) : [];

                const totalRevenue = orders.reduce((sum, o) => sum + (o.total || 0), 0);
                const totalOrders = orders.length;
                const avgOrder = totalOrders > 0 ? totalRevenue / totalOrders : 0;

                this.updateKPI('total-revenue', formatPrice(totalRevenue));
                this.updateKPI('total-orders', totalOrders.toString());
                this.updateKPI('avg-order', formatPrice(avgOrder));
                this.updateKPI('conversion', '3.2%');

                this.renderRevenueChart(orders);
                this.renderOrdersStatusChart(orders);
                this.renderSalesByBrandChart(orders);
                this.renderTopProducts(orders);
                this.renderRecentOrders(orders);

            } catch (error) {
                DebugLog.error('Error loading sales data:', error);
            }
        },

        updateKPI(id, value) {
            const kpi = document.querySelector(`[data-metric="${id}"]`);
            if (kpi) {
                const valueEl = kpi.querySelector('.admin-kpi__value');
                if (valueEl) valueEl.textContent = value;
            }
        },

        renderRevenueChart(orders) {
            const ctx = document.getElementById('revenueChart');
            if (!ctx) return;

            if (this.charts.revenue) this.charts.revenue.destroy();

            const config = this.getPeriodConfig();
            const periodData = {};
            const labels = [...Array(config.points)].map((_, i) => {
                const d = new Date();
                if (config.unit === 'minute') d.setMinutes(d.getMinutes() - (config.points - 1 - i) * config.step);
                else if (config.unit === 'hour') d.setHours(d.getHours() - (config.points - 1 - i));
                else if (config.unit === 'day') d.setDate(d.getDate() - (config.points - 1 - i));
                else if (config.unit === 'week') d.setDate(d.getDate() - (config.points - 1 - i) * 7);
                else if (config.unit === 'month') d.setMonth(d.getMonth() - (config.points - 1 - i));
                const key = d.toISOString().split('T')[0];
                periodData[key] = 0;
                return {
                    key,
                    label: config.isTime ? d.toLocaleTimeString('en-NZ', config.format) : d.toLocaleDateString('en-NZ', config.format)
                };
            });

            orders.forEach(order => {
                const date = order.created_at?.split('T')[0];
                if (date && periodData[date] !== undefined) {
                    periodData[date] += order.total || 0;
                }
            });

            this.charts.revenue = new Chart(ctx, {
                type: 'line',
                data: {
                    labels: labels.map(l => l.label),
                    datasets: [{
                        label: 'Revenue',
                        data: labels.map(l => periodData[l.key] || 0),
                        borderColor: '#267FB5',
                        backgroundColor: 'rgba(38, 127, 181, 0.1)',
                        fill: true,
                        tension: 0.4
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        y: { beginAtZero: true, ticks: { callback: v => '$' + v } }
                    }
                }
            });
        },

        renderOrdersStatusChart(orders) {
            const ctx = document.getElementById('ordersStatusChart');
            if (!ctx) return;

            if (this.charts.status) this.charts.status.destroy();

            const statusCounts = { pending: 0, paid: 0, processing: 0, shipped: 0, completed: 0, cancelled: 0 };
            orders.forEach(order => {
                if (statusCounts[order.status] !== undefined) {
                    statusCounts[order.status]++;
                }
            });

            this.charts.status = new Chart(ctx, {
                type: 'doughnut',
                data: {
                    labels: ['Pending', 'Paid', 'Processing', 'Shipped', 'Completed', 'Cancelled'],
                    datasets: [{
                        data: Object.values(statusCounts),
                        backgroundColor: ['#F4C430', '#267FB5', '#8b5cf6', '#06b6d4', '#10b981', '#C71F6E']
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { position: 'bottom' } }
                }
            });
        },

        renderSalesByBrandChart(orders) {
            const ctx = document.getElementById('salesByBrandChart');
            if (!ctx) return;

            if (this.charts.brands) this.charts.brands.destroy();

            const brandSales = {};
            orders.forEach(order => {
                (order.order_items || order.items || []).forEach(item => {
                    const brand = item.product?.brand?.name || 'Unknown';
                    brandSales[brand] = (brandSales[brand] || 0) + (item.line_total || 0);
                });
            });

            const sortedBrands = Object.entries(brandSales).sort((a, b) => b[1] - a[1]).slice(0, 8);

            this.charts.brands = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: sortedBrands.map(b => b[0]),
                    datasets: [{
                        label: 'Sales',
                        data: sortedBrands.map(b => b[1]),
                        backgroundColor: '#267FB5'
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        y: { beginAtZero: true, ticks: { callback: v => '$' + v } }
                    }
                }
            });
        },

        renderTopProducts(orders) {
            const tbody = document.getElementById('topProductsTable');
            if (!tbody) return;

            const productSales = {};
            orders.forEach(order => {
                (order.order_items || order.items || []).forEach(item => {
                    const name = item.product_name || 'Unknown';
                    if (!productSales[name]) {
                        productSales[name] = { quantity: 0, revenue: 0 };
                    }
                    productSales[name].quantity += item.quantity || 0;
                    productSales[name].revenue += item.line_total || 0;
                });
            });

            const sorted = Object.entries(productSales).sort((a, b) => b[1].revenue - a[1].revenue).slice(0, 5);

            if (sorted.length === 0) {
                tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; padding: 40px; color: var(--color-text-muted);">No sales data</td></tr>';
                return;
            }

            tbody.innerHTML = sorted.map(([name, data]) => `
                <tr>
                    <td>${name}</td>
                    <td>${data.quantity}</td>
                    <td>${formatPrice(data.revenue)}</td>
                </tr>
            `).join('');
        },

        renderRecentOrders(orders) {
            const tbody = document.getElementById('recentOrdersTable');
            if (!tbody) return;

            const recent = orders.slice(0, 10);

            if (recent.length === 0) {
                tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 40px; color: var(--color-text-muted);">No orders yet</td></tr>';
                return;
            }

            tbody.innerHTML = recent.map(order => {
                const statusClass = {
                    pending: 'warning', paid: 'info', processing: 'info',
                    shipped: 'info', completed: 'success', cancelled: 'danger'
                }[order.status] || 'info';

                return `
                    <tr>
                        <td><strong>${order.order_number}</strong></td>
                        <td>${order.shipping_recipient_name || order.email || 'Guest'}</td>
                        <td>${new Date(order.created_at).toLocaleDateString('en-NZ')}</td>
                        <td>${formatPrice(order.total)}</td>
                        <td><span class="admin-table__status admin-table__status--${statusClass}">${order.status}</span></td>
                    </tr>
                `;
            }).join('');
        }
    };

    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(() => { SalesPage.init(); }, 500);
    });
