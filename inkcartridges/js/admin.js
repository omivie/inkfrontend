/**
 * ADMIN.JS
 * ========
 * Admin Dashboard functionality for InkCartridges.co.nz
 */

'use strict';

const Admin = {
    // Dashboard state
    state: {
        period: 'week',
        loading: true,
        data: null,
        isAdmin: false
    },

    // Chart instances
    charts: {},

    /**
     * Initialize admin dashboard
     */
    async init() {
        // Check authentication and admin role
        const hasAccess = await this.checkAdminAccess();
        if (!hasAccess) {
            return;
        }

        // Update date display
        this.updateDateDisplay();

        // Update admin user info
        this.updateAdminUserInfo();

        // Bind events
        this.bindEvents();

        // Load dashboard data
        await this.loadDashboard();
    },

    /**
     * Check if user has admin access
     */
    async checkAdminAccess() {
        if (typeof Auth !== 'undefined') {
            await this.waitForAuth();

            if (!Auth.isAuthenticated()) {
                this.redirectToLogin();
                return false;
            }

            const isAdmin = await this.verifyAdminRole();
            if (!isAdmin) {
                this.redirectNonAdmin();
                return false;
            }

            this.state.isAdmin = true;
            return true;
        }

        this.redirectToLogin();
        return false;
    },

    /**
     * Wait for Auth to be fully initialized
     */
    async waitForAuth() {
        return new Promise((resolve) => {
            let attempts = 0;
            const maxAttempts = 50;

            const check = () => {
                attempts++;
                if (Auth.initialized) {
                    resolve();
                } else if (attempts >= maxAttempts) {
                    resolve();
                } else {
                    setTimeout(check, 100);
                }
            };
            check();
        });
    },

    /**
     * Verify user has admin role
     * Checks metadata, server API, and temporary dev fallback
     */
    async verifyAdminRole() {
        try {
            const user = Auth.user;
            if (!user) return false;

            // Check user metadata first (set by server during auth)
            if (user.user_metadata?.role === 'admin') return true;
            if (user.app_metadata?.role === 'admin') return true;

            // Verify with server API - this is the authoritative check
            if (typeof API !== 'undefined') {
                try {
                    const response = await API.verifyAdmin();
                    if (response.success && response.data?.is_admin) return true;
                } catch (apiError) {
                    console.error('Admin verification failed:', apiError.message);
                }
            }

            return false;
        } catch (error) {
            console.error('Error verifying admin role:', error);
            return false;
        }
    },

    /**
     * Redirect to login page
     */
    redirectToLogin() {
        window.location.href = '/html/account/login.html?redirect=' + encodeURIComponent(window.location.href);
    },

    /**
     * Redirect non-admin users
     */
    redirectNonAdmin() {
        window.location.href = '/html/404.html';
    },

    /**
     * Update admin user info in sidebar
     */
    updateAdminUserInfo() {
        const user = Auth.user;
        if (!user) return;

        const nameEl = document.getElementById('admin-name');
        const emailEl = document.getElementById('admin-email');
        const avatarEl = document.getElementById('admin-avatar');
        const welcomeEl = document.getElementById('welcome-text');

        const firstName = user.user_metadata?.first_name || user.email?.split('@')[0] || 'Admin';
        const fullName = user.user_metadata?.full_name || firstName;

        if (nameEl) nameEl.textContent = fullName;
        if (emailEl) emailEl.textContent = user.email;
        if (avatarEl) avatarEl.textContent = firstName.charAt(0).toUpperCase();
        if (welcomeEl) welcomeEl.textContent = `Welcome back, ${firstName}!`;
    },

    /**
     * Update date display
     */
    updateDateDisplay() {
        const dateEl = document.getElementById('current-date');
        if (dateEl) {
            const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
            dateEl.textContent = new Date().toLocaleDateString('en-NZ', options);
        }
    },

    /**
     * Bind dashboard events
     */
    bindEvents() {
        // Period selector
        document.querySelectorAll('.admin-period-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.admin-period-btn').forEach(b => {
                    b.classList.remove('admin-period-btn--active');
                });
                e.target.classList.add('admin-period-btn--active');
                this.state.period = e.target.dataset.period;
                this.loadDashboard();
            });
        });
    },

    /**
     * Load dashboard data
     */
    async loadDashboard() {
        this.state.loading = true;

        try {
            const [productsResponse, brandsResponse, ordersResponse] = await Promise.all([
                API.getAdminProducts({ limit: 100 }),
                API.getBrands(),
                API.getAdminOrders({ limit: 100 }).catch(() => ({ success: false, data: { orders: [] } }))
            ]);

            if (productsResponse.success && productsResponse.data?.products) {
                const products = productsResponse.data.products;
                const pagination = productsResponse.data.pagination || { total: products.length };
                const orders = ordersResponse.success ? (ordersResponse.data?.orders || []) : [];
                const brands = brandsResponse.success ? brandsResponse.data : [];

                const LOW_STOCK_THRESHOLD = Config.getSetting('LOW_STOCK_THRESHOLD', 10);
                const lowStockProducts = products.filter(p =>
                    p.in_stock && p.stock_quantity !== undefined && p.stock_quantity <= LOW_STOCK_THRESHOLD
                );

                const totalRevenue = orders.reduce((sum, o) => sum + (o.total || 0), 0);
                const totalOrders = orders.length;
                const avgOrderValue = totalOrders > 0 ? totalRevenue / totalOrders : 0;

                this.state.data = {
                    totalProducts: pagination.total,
                    productsInStock: products.filter(p => p.in_stock).length,
                    lowStockProducts: lowStockProducts,
                    outOfStockProducts: products.filter(p => !p.in_stock),
                    brands: brands,
                    products: products,
                    topProducts: products.slice(0, 5),
                    recentOrders: orders,
                    totalRevenue,
                    totalOrders,
                    avgOrderValue
                };

                this.renderDashboard();
            }
        } catch (error) {
            console.error('Error loading dashboard:', error);
        }

        this.state.loading = false;
    },

    /**
     * Render dashboard with current data
     */
    renderDashboard() {
        const data = this.state.data;
        if (!data) return;

        // Update KPIs
        this.updateElement('revenue-value', formatPrice(data.totalRevenue));
        this.updateElement('orders-value', data.totalOrders.toString());
        this.updateElement('aov-value', formatPrice(data.avgOrderValue));
        this.updateElement('products-value', data.totalProducts.toString());

        // Update badges
        this.updateElement('orders-badge', data.totalOrders.toString());
        this.updateElement('inventory-badge', data.lowStockProducts.length.toString());
        this.updateElement('db-products', data.totalProducts.toString());
        this.updateElement('db-brands', data.brands.length.toString());

        // Render components
        this.renderTopProducts(data.topProducts);
        this.renderInventoryAlerts(data.lowStockProducts);
        this.renderRecentOrders(data.recentOrders);
        this.renderRevenueChart(data.recentOrders);
        this.renderOrdersChart(data.recentOrders);
        this.renderStockHealthChart(data);
        this.renderBrandChart(data.brands, data.products);
        this.renderConversionFunnel(data.recentOrders);
    },

    /**
     * Helper to update element text
     */
    updateElement(id, text) {
        const el = document.getElementById(id);
        if (el) el.textContent = text;
    },

    /**
     * Render top products table
     */
    renderTopProducts(products) {
        const tbody = document.getElementById('top-products-table');
        if (!tbody) return;

        if (!products || products.length === 0) {
            tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; padding: 40px; color: var(--color-text-muted);">No products found</td></tr>';
            return;
        }

        tbody.innerHTML = products.map(product => `
            <tr>
                <td>
                    <div style="font-weight: 500;">${product.name}</div>
                    <div style="font-size: 12px; color: var(--color-text-muted);">${product.sku}</div>
                </td>
                <td>${formatPrice(product.retail_price)}</td>
                <td>
                    <span class="admin-badge ${product.in_stock ? 'admin-badge--success' : 'admin-badge--danger'}">
                        ${product.in_stock ? product.stock_quantity : 'Out'}
                    </span>
                </td>
            </tr>
        `).join('');
    },

    /**
     * Render inventory alerts
     */
    renderInventoryAlerts(products) {
        const container = document.getElementById('inventory-alerts');
        if (!container) return;

        if (!products || products.length === 0) {
            container.innerHTML = `
                <li style="text-align: center; padding: 40px; color: #059669;">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin: 0 auto 8px; display: block;">
                        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                        <polyline points="22 4 12 14.01 9 11.01"/>
                    </svg>
                    All products well stocked
                </li>
            `;
            return;
        }

        container.innerHTML = products.slice(0, 5).map(product => {
            const CRITICAL_THRESHOLD = Config.getSetting('CRITICAL_STOCK_THRESHOLD', 2);
            const isCritical = product.stock_quantity <= CRITICAL_THRESHOLD;
            return `
                <li class="admin-alert-item">
                    <div class="admin-alert-item__info">
                        <span class="admin-alert-item__name">${product.name}</span>
                        <span class="admin-alert-item__meta">SKU: ${product.sku}</span>
                    </div>
                    <span class="admin-badge ${isCritical ? 'admin-badge--danger' : 'admin-badge--warning'}">
                        ${product.stock_quantity} left
                    </span>
                </li>
            `;
        }).join('');
    },

    /**
     * Render recent orders table
     */
    renderRecentOrders(orders) {
        const tbody = document.getElementById('recent-orders-table');
        if (!tbody) return;

        if (!orders || orders.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 40px; color: var(--color-text-muted);">No orders found</td></tr>';
            return;
        }

        tbody.innerHTML = orders.slice(0, 5).map(order => {
            const statusColors = {
                pending: 'warning',
                paid: 'info',
                processing: 'info',
                shipped: 'info',
                completed: 'success',
                cancelled: 'danger'
            };

            return `
                <tr>
                    <td><strong>${order.order_number}</strong></td>
                    <td>${order.shipping_recipient_name || order.email || 'Customer'}</td>
                    <td>${new Date(order.created_at).toLocaleDateString('en-NZ')}</td>
                    <td><span class="admin-badge admin-badge--${statusColors[order.status] || 'neutral'}">${order.status}</span></td>
                    <td><strong>${formatPrice(order.total)}</strong></td>
                </tr>
            `;
        }).join('');
    },

    /**
     * Get period configuration based on selected period
     */
    getPeriodConfig() {
        const configs = {
            '1h': { points: 12, unit: 'minute', step: 5, isTime: true },
            '12h': { points: 24, unit: 'minute', step: 30, isTime: true },
            '24h': { points: 24, unit: 'hour', step: 1, isTime: true },
            '7d': { points: 7, unit: 'day', step: 1, isTime: false },
            '1m': { points: 30, unit: 'day', step: 1, isTime: false },
            '3m': { points: 12, unit: 'week', step: 1, isTime: false },
            '6m': { points: 26, unit: 'week', step: 1, isTime: false },
            '1y': { points: 12, unit: 'month', step: 1, isTime: false },
            '2y': { points: 24, unit: 'month', step: 1, isTime: false }
        };
        return configs[this.state.period] || configs['7d'];
    },

    /**
     * Render revenue chart
     */
    renderRevenueChart(orders) {
        const ctx = document.getElementById('revenueChart');
        if (!ctx) return;

        if (this.charts.revenue) this.charts.revenue.destroy();

        const { labels, data } = this.aggregateByPeriod(orders, 'total');

        const gradient = ctx.getContext('2d').createLinearGradient(0, 0, 0, 280);
        gradient.addColorStop(0, 'rgba(38, 127, 181, 0.3)');
        gradient.addColorStop(1, 'rgba(38, 127, 181, 0)');

        this.charts.revenue = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Revenue',
                    data: data,
                    borderColor: '#267FB5',
                    backgroundColor: gradient,
                    fill: true,
                    tension: 0.4,
                    borderWidth: 3,
                    pointBackgroundColor: '#267FB5',
                    pointBorderColor: '#fff',
                    pointBorderWidth: 2,
                    pointRadius: 4,
                    pointHoverRadius: 6
                }]
            },
            options: this.getChartOptions('$')
        });
    },

    /**
     * Render orders chart
     */
    renderOrdersChart(orders) {
        const ctx = document.getElementById('ordersChart');
        if (!ctx) return;

        if (this.charts.orders) this.charts.orders.destroy();

        const { labels, data } = this.aggregateByPeriod(orders, 'count');

        this.charts.orders = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Orders',
                    data: data,
                    backgroundColor: '#C71F6E',
                    borderRadius: 4
                }]
            },
            options: this.getChartOptions('')
        });
    },

    /**
     * Render stock health chart
     */
    renderStockHealthChart(data) {
        const ctx = document.getElementById('stockHealthChart');
        if (!ctx) return;

        if (this.charts.stockHealth) this.charts.stockHealth.destroy();

        const inStock = data.productsInStock - data.lowStockProducts.length;
        const lowStock = data.lowStockProducts.length;
        const outOfStock = data.outOfStockProducts.length;

        this.charts.stockHealth = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: ['In Stock', 'Low Stock', 'Out of Stock'],
                datasets: [{
                    data: [inStock, lowStock, outOfStock],
                    backgroundColor: ['#059669', '#F4C430', '#C71F6E'],
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: { padding: 16, usePointStyle: true }
                    }
                },
                cutout: '60%'
            }
        });

        // Update stats
        const statsEl = document.getElementById('stock-health-stats');
        if (statsEl) {
            statsEl.innerHTML = `
                <div style="display: flex; justify-content: space-around; text-align: center;">
                    <div>
                        <div style="font-size: 20px; font-weight: 600; color: #059669;">${inStock}</div>
                        <div style="font-size: 12px; color: var(--color-text-muted);">Healthy</div>
                    </div>
                    <div>
                        <div style="font-size: 20px; font-weight: 600; color: #F4C430;">${lowStock}</div>
                        <div style="font-size: 12px; color: var(--color-text-muted);">Low</div>
                    </div>
                    <div>
                        <div style="font-size: 20px; font-weight: 600; color: #C71F6E;">${outOfStock}</div>
                        <div style="font-size: 12px; color: var(--color-text-muted);">Out</div>
                    </div>
                </div>
            `;
        }
    },

    /**
     * Render conversion funnel with real order data
     */
    renderConversionFunnel(orders) {
        // Count orders by status
        const completedStatuses = ['completed', 'shipped', 'delivered'];
        const checkoutStatuses = ['pending', 'processing', 'paid', ...completedStatuses];

        const purchases = orders.filter(o => completedStatuses.includes(o.status)).length;
        const checkouts = orders.filter(o => checkoutStatuses.includes(o.status)).length;

        // For visitors, views, cart - we estimate based on typical e-commerce conversion rates
        // Until proper analytics tracking is implemented
        // Typical rates: ~2-3% visitor->purchase, ~10% visitor->cart, ~40% cart->checkout
        const estimatedVisitors = purchases > 0 ? Math.round(purchases / 0.025) : 0;
        const estimatedViews = purchases > 0 ? Math.round(estimatedVisitors * 0.6) : 0;
        const estimatedCarts = purchases > 0 ? Math.round(checkouts * 2.5) : 0;

        // Update funnel values
        this.updateElement('funnel-visitors', estimatedVisitors > 0 ? estimatedVisitors.toLocaleString() : '--');
        this.updateElement('funnel-views', estimatedViews > 0 ? estimatedViews.toLocaleString() : '--');
        this.updateElement('funnel-cart', estimatedCarts > 0 ? estimatedCarts.toLocaleString() : '--');
        this.updateElement('funnel-checkout', checkouts > 0 ? checkouts.toLocaleString() : '0');
        this.updateElement('funnel-purchase', purchases > 0 ? purchases.toLocaleString() : '0');

        // Calculate percentages (relative to visitors or previous step)
        const viewsPercent = estimatedVisitors > 0 ? Math.round((estimatedViews / estimatedVisitors) * 100) : 0;
        const cartPercent = estimatedVisitors > 0 ? Math.round((estimatedCarts / estimatedVisitors) * 100) : 0;
        const checkoutPercent = estimatedVisitors > 0 ? Math.round((checkouts / estimatedVisitors) * 100) : 0;
        const purchasePercent = estimatedVisitors > 0 ? Math.round((purchases / estimatedVisitors) * 100) : 0;

        // Update funnel bars
        const visitorsBar = document.getElementById('funnel-visitors-bar');
        const viewsBar = document.getElementById('funnel-views-bar');
        const cartBar = document.getElementById('funnel-cart-bar');
        const checkoutBar = document.getElementById('funnel-checkout-bar');
        const purchaseBar = document.getElementById('funnel-purchase-bar');

        if (visitorsBar) {
            visitorsBar.style.width = '100%';
            visitorsBar.textContent = estimatedVisitors > 0 ? '100%' : '--';
        }
        if (viewsBar) {
            viewsBar.style.width = `${Math.max(viewsPercent, 5)}%`;
            viewsBar.textContent = estimatedVisitors > 0 ? `${viewsPercent}%` : '--';
        }
        if (cartBar) {
            cartBar.style.width = `${Math.max(cartPercent, 5)}%`;
            cartBar.textContent = estimatedVisitors > 0 ? `${cartPercent}%` : '--';
        }
        if (checkoutBar) {
            checkoutBar.style.width = `${Math.max(checkoutPercent, 5)}%`;
            checkoutBar.textContent = checkouts > 0 ? `${checkoutPercent}%` : '0%';
        }
        if (purchaseBar) {
            purchaseBar.style.width = `${Math.max(purchasePercent, 5)}%`;
            purchaseBar.textContent = purchases > 0 ? `${purchasePercent}%` : '0%';
        }
    },

    /**
     * Render brand performance chart
     */
    renderBrandChart(brands, products) {
        const ctx = document.getElementById('brandChart');
        if (!ctx) return;

        if (this.charts.brands) this.charts.brands.destroy();

        // Count products per brand
        const brandCounts = {};
        products.forEach(p => {
            const brandName = p.brand?.name || 'Unknown';
            brandCounts[brandName] = (brandCounts[brandName] || 0) + 1;
        });

        const sortedBrands = Object.entries(brandCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6);

        const colors = ['#267FB5', '#C71F6E', '#F4C430', '#059669', '#8b5cf6', '#6366f1'];

        this.charts.brands = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: sortedBrands.map(b => b[0]),
                datasets: [{
                    label: 'Products',
                    data: sortedBrands.map(b => b[1]),
                    backgroundColor: colors
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                indexAxis: 'y',
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    x: {
                        beginAtZero: true,
                        grid: { display: false }
                    },
                    y: {
                        grid: { display: false }
                    }
                }
            }
        });
    },

    /**
     * Aggregate orders by selected period
     */
    aggregateByPeriod(orders, type) {
        const config = this.getPeriodConfig();
        const labels = [];
        const dataPoints = [];
        const now = new Date();

        // Generate time points based on period config
        for (let i = config.points - 1; i >= 0; i--) {
            const d = new Date(now);
            let label, startTime, endTime;

            switch (config.unit) {
                case 'minute':
                    d.setMinutes(d.getMinutes() - i * config.step);
                    d.setSeconds(0, 0);
                    label = d.toLocaleTimeString('en-NZ', { hour: 'numeric', minute: '2-digit' });
                    startTime = new Date(d);
                    endTime = new Date(d.getTime() + config.step * 60 * 1000);
                    break;
                case 'hour':
                    d.setHours(d.getHours() - i * config.step);
                    d.setMinutes(0, 0, 0);
                    label = d.toLocaleTimeString('en-NZ', { hour: 'numeric', minute: '2-digit' });
                    startTime = new Date(d);
                    endTime = new Date(d.getTime() + config.step * 60 * 60 * 1000);
                    break;
                case 'day':
                    d.setDate(d.getDate() - i * config.step);
                    d.setHours(0, 0, 0, 0);
                    label = config.points <= 7
                        ? d.toLocaleDateString('en-NZ', { weekday: 'short' })
                        : d.toLocaleDateString('en-NZ', { month: 'short', day: 'numeric' });
                    startTime = new Date(d);
                    endTime = new Date(d.getTime() + 24 * 60 * 60 * 1000);
                    break;
                case 'week':
                    d.setDate(d.getDate() - i * 7);
                    d.setHours(0, 0, 0, 0);
                    label = d.toLocaleDateString('en-NZ', { month: 'short', day: 'numeric' });
                    startTime = new Date(d);
                    endTime = new Date(d.getTime() + 7 * 24 * 60 * 60 * 1000);
                    break;
                case 'month':
                    d.setMonth(d.getMonth() - i);
                    d.setDate(1);
                    d.setHours(0, 0, 0, 0);
                    label = d.toLocaleDateString('en-NZ', { month: 'short', year: '2-digit' });
                    startTime = new Date(d);
                    endTime = new Date(d.getFullYear(), d.getMonth() + 1, 1);
                    break;
                default:
                    d.setDate(d.getDate() - i);
                    label = d.toLocaleDateString('en-NZ', { month: 'short', day: 'numeric' });
                    startTime = new Date(d);
                    endTime = new Date(d.getTime() + 24 * 60 * 60 * 1000);
            }

            labels.push(label);

            // Count/sum orders in this time range
            let value = 0;
            if (orders && orders.length > 0) {
                orders.forEach(order => {
                    const orderDate = new Date(order.created_at);
                    if (orderDate >= startTime && orderDate < endTime) {
                        if (type === 'total') {
                            value += order.total || 0;
                        } else {
                            value += 1;
                        }
                    }
                });
            }
            dataPoints.push(value);
        }

        return { labels, data: dataPoints };
    },

    /**
     * Get common chart options
     */
    getChartOptions(prefix) {
        return {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                intersect: false,
                mode: 'index'
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: '#1F2937',
                    titleColor: '#F9FAFB',
                    bodyColor: '#F9FAFB',
                    padding: 12,
                    displayColors: false,
                    callbacks: {
                        label: function(context) {
                            return prefix + context.raw.toFixed(prefix === '$' ? 2 : 0);
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { color: '#9CA3AF' }
                },
                y: {
                    beginAtZero: true,
                    grid: { color: '#E5E7EB' },
                    ticks: {
                        color: '#9CA3AF',
                        callback: function(value) {
                            if (prefix === '$') {
                                return value >= 1000 ? '$' + (value / 1000) + 'k' : '$' + value;
                            }
                            return value;
                        }
                    }
                }
            }
        };
    }
};

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    if (document.querySelector('.admin-body')) {
        Admin.init();
    }
});

window.Admin = Admin;
