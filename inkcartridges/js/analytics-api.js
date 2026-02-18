/**
 * ANALYTICS-API.JS
 * ================
 * Advanced Business Intelligence API for InkCartridges.co.nz Admin
 * Provides endpoints for financial health, customer analytics, and operational metrics
 */

const AnalyticsAPI = {
    // =========================================================================
    // FINANCIAL HEALTH ENDPOINTS
    // =========================================================================

    /**
     * Get Profit & Loss statement
     * @param {object} options - { startDate, endDate, granularity: 'daily'|'monthly' }
     */
    async getProfitLoss(options = {}) {
        const params = new URLSearchParams();
        if (options.startDate) params.append('start_date', options.startDate);
        if (options.endDate) params.append('end_date', options.endDate);
        if (options.granularity) params.append('granularity', options.granularity);

        return API.get(`/api/admin/analytics/pnl?${params}`);
    },

    /**
     * Get Cash Flow analysis
     * @param {object} options - { months: number, includeProjections: boolean }
     */
    async getCashFlow(options = {}) {
        const params = new URLSearchParams();
        params.append('months', options.months || 12);
        if (options.includeProjections) params.append('projections', 'true');

        return API.get(`/api/admin/analytics/cashflow?${params}`);
    },

    /**
     * Get Burn Rate and Runway projections
     */
    async getBurnRunway() {
        return API.get('/api/admin/analytics/burn-runway');
    },

    /**
     * Get Daily Revenue metrics
     * @param {number} days - Number of days to include
     */
    async getDailyRevenue(days = 30) {
        return API.get(`/api/admin/analytics/daily-revenue?days=${days}`);
    },

    /**
     * Get Financial Forecasts (30/60/90 day)
     */
    async getFinancialForecasts() {
        return API.get('/api/admin/analytics/forecasts');
    },

    /**
     * Add an expense record
     * @param {object} expense - Expense data
     */
    async addExpense(expense) {
        return API.post('/api/admin/analytics/expenses', expense);
    },

    /**
     * Get expenses with filters
     * @param {object} filters - { startDate, endDate, category, limit }
     */
    async getExpenses(filters = {}) {
        const params = new URLSearchParams();
        if (filters.startDate) params.append('start_date', filters.startDate);
        if (filters.endDate) params.append('end_date', filters.endDate);
        if (filters.category) params.append('category', filters.category);
        if (filters.limit) params.append('limit', filters.limit);

        return API.get(`/api/admin/analytics/expenses?${params}`);
    },

    /**
     * Get expense categories
     */
    async getExpenseCategories() {
        return API.get('/api/admin/analytics/expense-categories');
    },

    // =========================================================================
    // CUSTOMER ANALYTICS ENDPOINTS
    // =========================================================================

    /**
     * Get Customer Lifetime Value metrics
     * @param {object} options - { segment, sortBy, limit }
     */
    async getCustomerLTV(options = {}) {
        const params = new URLSearchParams();
        if (options.segment) params.append('segment', options.segment);
        if (options.sortBy) params.append('sort_by', options.sortBy);
        if (options.limit) params.append('limit', options.limit);

        return API.get(`/api/admin/analytics/customer-ltv?${params}`);
    },

    /**
     * Get Customer Acquisition Cost by channel
     * @param {object} options - { months, channel }
     */
    async getCAC(options = {}) {
        const params = new URLSearchParams();
        params.append('months', options.months || 12);
        if (options.channel) params.append('channel', options.channel);

        return API.get(`/api/admin/analytics/cac?${params}`);
    },

    /**
     * Get LTV:CAC ratio analysis
     */
    async getLTVCACRatio() {
        return API.get('/api/admin/analytics/ltv-cac-ratio');
    },

    /**
     * Get Cohort Analysis data
     * @param {object} options - { months, metric: 'retention'|'revenue' }
     */
    async getCohortAnalysis(options = {}) {
        const params = new URLSearchParams();
        params.append('months', options.months || 12);
        params.append('metric', options.metric || 'retention');

        return API.get(`/api/admin/analytics/cohorts?${params}`);
    },

    /**
     * Get Churn Analysis
     * @param {object} options - { includeAtRisk: boolean }
     */
    async getChurnAnalysis(options = {}) {
        const params = new URLSearchParams();
        if (options.includeAtRisk) params.append('include_at_risk', 'true');

        return API.get(`/api/admin/analytics/churn?${params}`);
    },

    /**
     * Get Customer Health Scores
     * @param {object} options - { status, sortBy, limit }
     */
    async getCustomerHealth(options = {}) {
        const params = new URLSearchParams();
        if (options.status) params.append('status', options.status); // 'excellent', 'good', 'at_risk', 'critical'
        if (options.sortBy) params.append('sort_by', options.sortBy);
        if (options.limit) params.append('limit', options.limit);

        return API.get(`/api/admin/analytics/customer-health?${params}`);
    },

    /**
     * Get NPS and Customer Feedback summary
     */
    async getNPSSummary() {
        return API.get('/api/admin/analytics/nps');
    },

    /**
     * Submit customer feedback
     * @param {object} feedback - Feedback data
     */
    async submitFeedback(feedback) {
        return API.post('/api/admin/analytics/feedback', feedback);
    },

    /**
     * Get Repeat Purchase metrics
     */
    async getRepeatPurchaseMetrics() {
        return API.get('/api/admin/analytics/repeat-purchase');
    },

    // =========================================================================
    // MARKETING ANALYTICS ENDPOINTS
    // =========================================================================

    /**
     * Get Marketing Campaign performance
     * @param {object} options - { status, channel }
     */
    async getCampaigns(options = {}) {
        const params = new URLSearchParams();
        if (options.status) params.append('status', options.status);
        if (options.channel) params.append('channel', options.channel);

        return API.get(`/api/admin/analytics/campaigns?${params}`);
    },

    /**
     * Create marketing campaign
     * @param {object} campaign - Campaign data
     */
    async createCampaign(campaign) {
        return API.post('/api/admin/analytics/campaigns', campaign);
    },

    /**
     * Record marketing spend
     * @param {object} spend - Spend data { campaignId, channel, amount, date, impressions, clicks, conversions }
     */
    async recordMarketingSpend(spend) {
        return API.post('/api/admin/analytics/marketing-spend', spend);
    },

    /**
     * Get Channel Efficiency analysis
     */
    async getChannelEfficiency() {
        return API.get('/api/admin/analytics/channel-efficiency');
    },

    /**
     * Get Conversion Funnel metrics
     */
    async getConversionFunnel() {
        return API.get('/api/admin/analytics/conversion-funnel');
    },

    // =========================================================================
    // OPERATIONAL ANALYTICS ENDPOINTS
    // =========================================================================

    /**
     * Get Inventory Turnover metrics
     * @param {object} options - { sortBy, limit }
     */
    async getInventoryTurnover(options = {}) {
        const params = new URLSearchParams();
        if (options.sortBy) params.append('sort_by', options.sortBy);
        if (options.limit) params.append('limit', options.limit);

        return API.get(`/api/admin/analytics/inventory-turnover?${params}`);
    },

    /**
     * Get Dead Stock analysis
     * @param {object} options - { daysThreshold, minValue }
     */
    async getDeadStock(options = {}) {
        const params = new URLSearchParams();
        params.append('days_threshold', options.daysThreshold || 90);
        if (options.minValue) params.append('min_value', options.minValue);

        return API.get(`/api/admin/analytics/dead-stock?${params}`);
    },

    /**
     * Get Stock Velocity per SKU
     * @param {object} options - { limit, sortBy }
     */
    async getStockVelocity(options = {}) {
        const params = new URLSearchParams();
        if (options.limit) params.append('limit', options.limit);
        if (options.sortBy) params.append('sort_by', options.sortBy);

        return API.get(`/api/admin/analytics/stock-velocity?${params}`);
    },

    /**
     * Get Inventory Cash Lockup analysis
     */
    async getInventoryCashLockup() {
        return API.get('/api/admin/analytics/inventory-cash-lockup');
    },

    /**
     * Get Product Performance metrics
     * @param {object} options - { sortBy, limit, includeUnprofitable }
     */
    async getProductPerformance(options = {}) {
        const params = new URLSearchParams();
        if (options.sortBy) params.append('sort_by', options.sortBy);
        if (options.limit) params.append('limit', options.limit);
        if (options.includeUnprofitable) params.append('include_unprofitable', 'true');

        return API.get(`/api/admin/analytics/product-performance?${params}`);
    },

    /**
     * Get Page-level Revenue Contribution
     */
    async getPageRevenueContribution() {
        return API.get('/api/admin/analytics/page-revenue');
    },

    // =========================================================================
    // ALERTS & THRESHOLDS
    // =========================================================================

    /**
     * Get active alerts
     * @param {object} options - { severity, acknowledged }
     */
    async getAlerts(options = {}) {
        const params = new URLSearchParams();
        if (options.severity) params.append('severity', options.severity);
        if (options.acknowledged !== undefined) params.append('acknowledged', options.acknowledged);

        return API.get(`/api/admin/analytics/alerts?${params}`);
    },

    /**
     * Acknowledge an alert
     * @param {string} alertId - Alert ID
     */
    async acknowledgeAlert(alertId) {
        return API.put(`/api/admin/analytics/alerts/${alertId}/acknowledge`);
    },

    /**
     * Get alert thresholds configuration
     */
    async getAlertThresholds() {
        return API.get('/api/admin/analytics/alert-thresholds');
    },

    /**
     * Update alert threshold
     * @param {string} thresholdId - Threshold ID
     * @param {object} updates - Threshold updates
     */
    async updateAlertThreshold(thresholdId, updates) {
        return API.put(`/api/admin/analytics/alert-thresholds/${thresholdId}`, updates);
    },

    // =========================================================================
    // DASHBOARD SUMMARIES
    // =========================================================================

    /**
     * Get Financial Health Dashboard summary
     */
    async getFinancialHealthSummary() {
        return API.get('/api/admin/analytics/summary/financial');
    },

    /**
     * Get Customer Intelligence Dashboard summary
     */
    async getCustomerIntelligenceSummary() {
        return API.get('/api/admin/analytics/summary/customers');
    },

    /**
     * Get Operations Intelligence Dashboard summary
     */
    async getOperationsSummary() {
        return API.get('/api/admin/analytics/summary/operations');
    },

    /**
     * Get Executive Dashboard (all key metrics)
     */
    async getExecutiveDashboard() {
        return API.get('/api/admin/analytics/summary/executive');
    }
};

// =========================================================================
// CLIENT-SIDE CALCULATIONS (for when API data needs processing)
// =========================================================================

const AnalyticsCalculations = {
    /**
     * Calculate LTV from customer data
     * @param {object} customer - Customer data with orders
     */
    calculateLTV(customer) {
        if (!customer.orders || customer.orders.length === 0) return 0;

        const totalRevenue = customer.orders.reduce((sum, o) => sum + (o.total || 0), 0);
        const orderCount = customer.orders.length;
        const avgOrderValue = totalRevenue / orderCount;

        if (orderCount < 2) {
            // First-time buyer: estimate 1.5x AOV
            return avgOrderValue * 1.5;
        }

        // Calculate purchase frequency
        const firstOrder = new Date(customer.orders[0].created_at);
        const lastOrder = new Date(customer.orders[orderCount - 1].created_at);
        const daysBetween = (lastOrder - firstOrder) / (1000 * 60 * 60 * 24);
        const avgDaysBetweenOrders = daysBetween / (orderCount - 1);

        // Estimated annual orders
        const annualOrders = 365 / avgDaysBetweenOrders;

        // LTV = AOV × Annual Orders × Expected Lifespan (3 years)
        return avgOrderValue * annualOrders * 3;
    },

    /**
     * Calculate CAC from marketing data
     * @param {number} marketingSpend - Total marketing spend
     * @param {number} newCustomers - Number of new customers acquired
     */
    calculateCAC(marketingSpend, newCustomers) {
        if (newCustomers === 0) return null;
        return marketingSpend / newCustomers;
    },

    /**
     * Calculate LTV:CAC ratio
     * @param {number} ltv - Customer Lifetime Value
     * @param {number} cac - Customer Acquisition Cost
     */
    calculateLTVCACRatio(ltv, cac) {
        if (!cac || cac === 0) return null;
        return ltv / cac;
    },

    /**
     * Calculate churn rate
     * @param {number} customersStart - Customers at period start
     * @param {number} customersEnd - Customers at period end
     * @param {number} newCustomers - New customers acquired
     */
    calculateChurnRate(customersStart, customersEnd, newCustomers) {
        if (customersStart === 0) return 0;
        const churned = customersStart + newCustomers - customersEnd;
        return (churned / customersStart) * 100;
    },

    /**
     * Calculate inventory turnover
     * @param {number} cogs - Cost of Goods Sold
     * @param {number} avgInventory - Average Inventory Value
     */
    calculateInventoryTurnover(cogs, avgInventory) {
        if (avgInventory === 0) return 0;
        return cogs / avgInventory;
    },

    /**
     * Calculate days of inventory
     * @param {number} currentStock - Current stock quantity
     * @param {number} avgDailySales - Average daily sales quantity
     */
    calculateDaysOfInventory(currentStock, avgDailySales) {
        if (avgDailySales === 0) return 9999;
        return currentStock / avgDailySales;
    },

    /**
     * Calculate gross margin percentage
     * @param {number} revenue - Total revenue
     * @param {number} cogs - Cost of Goods Sold
     */
    calculateGrossMargin(revenue, cogs) {
        if (revenue === 0) return 0;
        return ((revenue - cogs) / revenue) * 100;
    },

    /**
     * Calculate net margin percentage
     * @param {number} revenue - Total revenue
     * @param {number} totalCosts - All costs (COGS + expenses)
     */
    calculateNetMargin(revenue, totalCosts) {
        if (revenue === 0) return 0;
        return ((revenue - totalCosts) / revenue) * 100;
    },

    /**
     * Calculate burn rate and runway
     * @param {number} cashBalance - Current cash balance
     * @param {number} monthlyExpenses - Average monthly expenses
     * @param {number} monthlyRevenue - Average monthly revenue
     */
    calculateBurnRunway(cashBalance, monthlyExpenses, monthlyRevenue) {
        const netBurn = monthlyExpenses - monthlyRevenue;

        if (netBurn <= 0) {
            // Company is profitable
            return {
                monthlyBurn: netBurn,
                runwayMonths: Infinity,
                runwayDays: Infinity,
                isProfitable: true
            };
        }

        const runwayMonths = cashBalance / netBurn;
        return {
            monthlyBurn: netBurn,
            runwayMonths: runwayMonths,
            runwayDays: Math.round(runwayMonths * 30),
            isProfitable: false
        };
    },

    /**
     * Generate cohort retention matrix
     * @param {array} customers - Customer data with signup and order dates
     */
    generateCohortRetention(customers) {
        const cohorts = {};

        customers.forEach(customer => {
            if (!customer.orders || customer.orders.length === 0) return;

            const signupMonth = new Date(customer.created_at).toISOString().slice(0, 7);

            if (!cohorts[signupMonth]) {
                cohorts[signupMonth] = {
                    total: 0,
                    months: {}
                };
            }

            cohorts[signupMonth].total++;

            customer.orders.forEach(order => {
                const orderMonth = new Date(order.created_at).toISOString().slice(0, 7);
                const signupDate = new Date(signupMonth + '-01');
                const orderDate = new Date(orderMonth + '-01');
                const monthsSince = Math.round((orderDate - signupDate) / (30 * 24 * 60 * 60 * 1000));

                if (!cohorts[signupMonth].months[monthsSince]) {
                    cohorts[signupMonth].months[monthsSince] = new Set();
                }
                cohorts[signupMonth].months[monthsSince].add(customer.id);
            });
        });

        // Convert to retention percentages
        const retentionMatrix = {};
        Object.keys(cohorts).forEach(month => {
            retentionMatrix[month] = {
                total: cohorts[month].total,
                retention: {}
            };

            Object.keys(cohorts[month].months).forEach(monthsSince => {
                const activeCount = cohorts[month].months[monthsSince].size;
                retentionMatrix[month].retention[monthsSince] = {
                    active: activeCount,
                    rate: (activeCount / cohorts[month].total) * 100
                };
            });
        });

        return retentionMatrix;
    },

    /**
     * Score customer health (0-100)
     * @param {object} customer - Customer data
     */
    scoreCustomerHealth(customer) {
        let score = 50; // Base score

        const daysSinceLastOrder = customer.days_since_last_order || 999;
        const totalOrders = customer.total_orders || 0;
        const avgOrderValue = customer.avg_order_value || 0;

        // Recency scoring (-30 to +20)
        if (daysSinceLastOrder < 30) score += 20;
        else if (daysSinceLastOrder < 60) score += 10;
        else if (daysSinceLastOrder < 90) score += 0;
        else if (daysSinceLastOrder < 180) score -= 15;
        else score -= 30;

        // Frequency scoring (+5 per order, max +25)
        score += Math.min(totalOrders * 5, 25);

        // Value scoring (based on AOV percentile)
        if (avgOrderValue > 200) score += 15;
        else if (avgOrderValue > 100) score += 10;
        else if (avgOrderValue > 50) score += 5;

        return Math.max(0, Math.min(100, score));
    },

    /**
     * Identify upsell opportunities
     * @param {object} customer - Customer data with purchase history
     * @param {array} products - All products
     */
    identifyUpsellOpportunities(customer, products) {
        if (!customer.orders || customer.orders.length === 0) return [];

        // Get all purchased products
        const purchasedSkus = new Set();
        const purchasedBrands = new Set();
        const purchasedCategories = new Set();

        customer.orders.forEach(order => {
            (order.items || []).forEach(item => {
                purchasedSkus.add(item.sku);
                if (item.brand) purchasedBrands.add(item.brand);
                if (item.category) purchasedCategories.add(item.category);
            });
        });

        // Find complementary products
        const opportunities = products
            .filter(p => !purchasedSkus.has(p.sku))
            .filter(p => purchasedBrands.has(p.brand) || purchasedCategories.has(p.category))
            .slice(0, 5);

        return opportunities;
    }
};

// =========================================================================
// DATA FORMATTING UTILITIES
// =========================================================================

const AnalyticsFormatters = {
    /**
     * Format currency with NZD symbol
     */
    formatCurrency(amount) {
        return new Intl.NumberFormat('en-NZ', {
            style: 'currency',
            currency: 'NZD'
        }).format(amount || 0);
    },

    /**
     * Format percentage
     */
    formatPercentage(value, decimals = 1) {
        return `${(value || 0).toFixed(decimals)}%`;
    },

    /**
     * Format large numbers with K/M suffix
     */
    formatCompactNumber(num) {
        if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
        if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
        return num.toString();
    },

    /**
     * Format days to human readable
     */
    formatDays(days) {
        if (days === Infinity || days > 9999) return '∞';
        if (days >= 365) return `${Math.round(days / 365)}y`;
        if (days >= 30) return `${Math.round(days / 30)}mo`;
        return `${Math.round(days)}d`;
    },

    /**
     * Get status color class
     */
    getStatusColor(status) {
        const colors = {
            excellent: 'success',
            good: 'info',
            neutral: 'warning',
            at_risk: 'warning',
            critical: 'danger',
            active: 'success',
            cooling: 'info',
            churned: 'danger'
        };
        return colors[status] || 'secondary';
    },

    /**
     * Get trend indicator
     */
    getTrendIndicator(current, previous) {
        if (!previous || previous === 0) return { direction: 'neutral', change: 0 };

        const change = ((current - previous) / previous) * 100;
        return {
            direction: change > 0 ? 'up' : change < 0 ? 'down' : 'neutral',
            change: Math.abs(change).toFixed(1)
        };
    }
};

// Make available globally
window.AnalyticsAPI = AnalyticsAPI;
window.AnalyticsCalculations = AnalyticsCalculations;
window.AnalyticsFormatters = AnalyticsFormatters;
