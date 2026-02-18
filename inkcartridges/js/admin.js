/**
 * ADMIN.JS
 * ========
 * Admin dashboard controller for InkCartridges.co.nz
 * Loaded LAST — depends on: AdminAuth, Dashboard, DashboardState, CommandPalette, API, Auth
 */

'use strict';

const Admin = {
    state: {
        activeTab: 'overview',
        sidebarCollapsed: false,
        theme: 'dark',
        loading: true,
        data: null
    },

    async init() {
        // 1. Auth via AdminAuth (no duplicated logic)
        var hasAccess = false;
        try {
            hasAccess = await AdminAuth.init();
        } catch (e) {
            console.warn('AdminAuth.init failed:', e);
        }
        if (!hasAccess) return;

        // 2. Load preferences
        this.loadPreferences();
        this.applyTheme();

        // 3. Init global filter state
        DashboardState.load();
        this.state.activeTab = localStorage.getItem('admin-tab') || 'overview';

        // 4. Set initial UI
        this.updateDateDisplay();
        this.updateAdminUserInfo();
        this.syncPeriodButtons();
        this.syncActiveTab();

        // 5. Bind events
        this.bindEvents();

        // 6. Init drawer
        Dashboard.initDrawerEvents();

        // 7. Show skeletons, then load data
        Dashboard.renderKPISkeletons();
        await this.loadDashboard();
    },

    /* ================================================================
       PREFERENCES
       ================================================================ */

    loadPreferences: function() {
        this.state.theme = localStorage.getItem('admin-theme') || 'dark';
        this.state.sidebarCollapsed = localStorage.getItem('admin-sidebar') === 'collapsed';

        if (this.state.sidebarCollapsed) {
            var sidebar = document.getElementById('admin-sidebar');
            if (sidebar) sidebar.classList.add('admin-sidebar--collapsed');
        }
    },

    applyTheme: function() {
        document.documentElement.setAttribute('data-theme', this.state.theme);
    },

    /* ================================================================
       EVENTS
       ================================================================ */

    bindEvents: function() {
        var self = this;

        // Sidebar toggle
        var sidebarBtn = document.getElementById('sidebar-toggle');
        if (sidebarBtn) sidebarBtn.addEventListener('click', function() { self.toggleSidebar(); });

        // Date range buttons
        var dateButtons = document.querySelectorAll('.admin-daterange__btn');
        dateButtons.forEach(function(btn) {
            btn.addEventListener('click', function() {
                dateButtons.forEach(function(b) { b.classList.remove('admin-daterange__btn--active'); });
                btn.classList.add('admin-daterange__btn--active');
                DashboardState.setPeriod(btn.dataset.period);
                // Re-render active tab with new period
                Dashboard.destroyAllCharts();
                Dashboard.renderedTabs.clear();
                Dashboard.renderTab(self.state.activeTab, self.state.data);
            });
        });

        // Tab buttons
        var tabBtns = document.querySelectorAll('.admin-tab');
        tabBtns.forEach(function(btn) {
            btn.addEventListener('click', function() { self.switchTab(btn.dataset.tab); });
        });

        // Sidebar nav tab links
        var navTabLinks = document.querySelectorAll('.admin-nav__link[data-tab]');
        navTabLinks.forEach(function(link) {
            link.addEventListener('click', function(e) {
                e.preventDefault();
                self.switchTab(link.dataset.tab);
            });
        });

        // Theme toggle
        var themeBtn = document.getElementById('theme-toggle');
        if (themeBtn) themeBtn.addEventListener('click', function() { self.toggleTheme(); });

        // Command palette
        var searchTrigger = document.getElementById('search-trigger');
        if (searchTrigger) searchTrigger.addEventListener('click', function() { CommandPalette.open(); });

        document.addEventListener('keydown', function(e) {
            if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
                e.preventDefault();
                CommandPalette.toggle();
            }
        });
    },

    /* ================================================================
       TAB MANAGEMENT
       ================================================================ */

    switchTab: function(tabId) {
        this.state.activeTab = tabId;
        localStorage.setItem('admin-tab', tabId);

        // Update tab buttons
        document.querySelectorAll('.admin-tab').forEach(function(t) {
            t.classList.toggle('admin-tab--active', t.dataset.tab === tabId);
        });

        // Update panels
        document.querySelectorAll('.admin-tab-panel').forEach(function(p) {
            p.classList.toggle('admin-tab-panel--active', p.id === 'tab-' + tabId);
        });

        // Render tab content
        if (this.state.data) {
            Dashboard.renderTab(tabId, this.state.data);
        }
    },

    syncActiveTab: function() {
        this.switchTab(this.state.activeTab);
    },

    syncPeriodButtons: function() {
        var period = DashboardState.filters.period;
        document.querySelectorAll('.admin-daterange__btn').forEach(function(btn) {
            btn.classList.toggle('admin-daterange__btn--active', btn.dataset.period === period);
        });
    },

    /* ================================================================
       SIDEBAR
       ================================================================ */

    toggleSidebar: function() {
        var sidebar = document.getElementById('admin-sidebar');
        if (!sidebar) return;
        this.state.sidebarCollapsed = !this.state.sidebarCollapsed;
        sidebar.classList.toggle('admin-sidebar--collapsed');
        localStorage.setItem('admin-sidebar', this.state.sidebarCollapsed ? 'collapsed' : 'expanded');
    },

    /* ================================================================
       THEME
       ================================================================ */

    toggleTheme: function() {
        this.state.theme = this.state.theme === 'dark' ? 'light' : 'dark';
        localStorage.setItem('admin-theme', this.state.theme);
        this.applyTheme();
        // Destroy all charts and re-render to avoid flicker
        if (this.state.data) {
            Dashboard.onThemeChange(this.state.data);
        }
    },

    /* ================================================================
       DATA LOADING (core first, analytics async)
       ================================================================ */

    async loadDashboard() {
        this.state.loading = true;

        try {
            // Phase 1: Core data (non-blocking, essential)
            var results = await Promise.allSettled([
                API.getAdminProducts({ limit: 100 }),
                API.getAdminOrders({ limit: 100 }),
                API.getBrands()
            ]);

            this.state.data = this.processResponses(results[0], results[1], results[2]);

            // Render immediately with core data
            Dashboard.renderKPIs(this.state.data);
            Dashboard.renderTab(this.state.activeTab, this.state.data);

            // Update sidebar badges
            this.updateEl('orders-badge', String(this.state.data.totalOrders || 0));

        } catch (error) {
            console.error('Dashboard core load error:', error);
            Dashboard.renderError();
        }

        this.state.loading = false;

        // Phase 2: Analytics hydration (async, non-blocking)
        this.hydrateAnalytics();
    },

    async hydrateAnalytics() {
        if (!this.state.data) return;

        // Try to load analytics overview
        try {
            var overview = await API.getAdminAnalyticsOverview(DashboardState.periodToDays());
            if (overview && overview.success && overview.data) {
                Object.assign(this.state.data.analytics, overview.data);
            }
        } catch (e) { /* endpoint may not exist */ }

        // Try executive dashboard
        try {
            var exec = await AnalyticsAPI.getExecutiveDashboard();
            if (exec && exec.success && exec.data) {
                if (exec.data.grossProfit !== undefined) this.state.data.grossProfit = exec.data.grossProfit;
                if (exec.data.netProfit !== undefined) this.state.data.netProfit = exec.data.netProfit;
                if (exec.data.refundRate !== undefined) this.state.data.refundRate = exec.data.refundRate;
                if (exec.data.avgFulfilmentTime !== undefined) this.state.data.avgFulfilmentTime = exec.data.avgFulfilmentTime;
                if (exec.data.revenueSparkline) this.state.data.analytics.revenueSparkline = exec.data.revenueSparkline;
                if (exec.data.ordersSparkline) this.state.data.analytics.ordersSparkline = exec.data.ordersSparkline;
                if (exec.data.revenueTrend) this.state.data.analytics.revenueTrend = exec.data.revenueTrend;
                if (exec.data.ordersTrend) this.state.data.analytics.ordersTrend = exec.data.ordersTrend;
            }
        } catch (e) { /* endpoint may not exist */ }

        // Try loading customers for the customers tab
        try {
            var custRes = await API.getAdminCustomers({ limit: 100 });
            if (custRes && custRes.success) {
                this.state.data.customers = custRes.data.customers || custRes.data || [];
            }
        } catch (e) { /* graceful */ }

        // Re-render KPIs with enriched data
        Dashboard.renderKPIs(this.state.data);
    },

    processResponses: function(productsRes, ordersRes, brandsRes) {
        var products = productsRes.status === 'fulfilled' && productsRes.value && productsRes.value.success
            ? (productsRes.value.data.products || productsRes.value.data || []) : [];
        var orders = ordersRes.status === 'fulfilled' && ordersRes.value && ordersRes.value.success
            ? (ordersRes.value.data.orders || ordersRes.value.data || []) : [];
        var brands = brandsRes.status === 'fulfilled' && brandsRes.value && brandsRes.value.success
            ? (brandsRes.value.data || []) : [];

        var LOW = 10;
        try { LOW = Config.getSetting('LOW_STOCK_THRESHOLD', 10); } catch(e) {}

        var lowStock = products.filter(function(p) { return p.in_stock && p.stock_quantity <= LOW && p.stock_quantity > 0; });
        var outOfStock = products.filter(function(p) { return !p.in_stock || p.stock_quantity === 0; });
        var totalRevenue = orders.reduce(function(s, o) { return s + (o.total || 0); }, 0);
        var totalOrders = orders.length;
        var aov = totalOrders > 0 ? totalRevenue / totalOrders : 0;

        return {
            products: products,
            orders: orders,
            brands: brands,
            customers: [],
            analytics: {},
            totalProducts: products.length,
            productsInStock: products.filter(function(p) { return p.in_stock; }).length,
            lowStockProducts: lowStock,
            outOfStockProducts: outOfStock,
            totalRevenue: totalRevenue,
            totalOrders: totalOrders,
            aov: aov,
            grossProfit: null,
            netProfit: null,
            refundRate: null,
            avgFulfilmentTime: null
        };
    },

    /* ================================================================
       UI HELPERS
       ================================================================ */

    updateEl: function(id, text) {
        var el = document.getElementById(id);
        if (el) el.textContent = text;
    },

    updateDateDisplay: function() {
        var el = document.getElementById('current-date');
        if (el) {
            el.textContent = new Date().toLocaleDateString('en-NZ', {
                weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
            });
        }
    },

    updateAdminUserInfo: function() {
        if (typeof Auth === 'undefined' || !Auth.user) return;
        var user = Auth.user;
        var name = user.user_metadata && user.user_metadata.full_name
            ? user.user_metadata.full_name
            : (user.email ? user.email.split('@')[0] : 'Admin');

        this.updateEl('admin-name', name);
        this.updateEl('admin-email', user.email || '');

        var avatar = document.getElementById('admin-avatar');
        if (avatar) avatar.textContent = name.charAt(0).toUpperCase();
    }
};

// Init on DOMContentLoaded
document.addEventListener('DOMContentLoaded', function() {
    if (document.querySelector('.admin-body')) {
        Admin.init();
    }
});

window.Admin = Admin;
