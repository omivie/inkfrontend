    const CustomerIntelligencePage = {
        charts: {},
        customers: [],
        selectedSegment: 'all',

        async init() {
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

            // Segment cards
            document.querySelectorAll('.segment-card').forEach(card => {
                card.addEventListener('click', () => {
                    document.querySelectorAll('.segment-card').forEach(c => c.classList.remove('segment-card--active'));
                    card.classList.add('segment-card--active');
                    this.selectedSegment = card.dataset.segment;
                    this.filterCustomers();
                });
            });

            // Health filter
            document.getElementById('health-filter').addEventListener('change', (e) => {
                this.filterCustomers(e.target.value);
            });

            // Refresh button
            document.getElementById('refresh-btn').addEventListener('click', () => {
                this.loadData();
            });
        },

        async loadData() {
            try {
                // Load orders to calculate customer metrics
                const ordersResponse = await API.getOrders({ limit: 1000 });
                const orders = ordersResponse.ok ? (ordersResponse.data?.orders || []) : [];

                // Aggregate customer data from orders
                this.processCustomerData(orders);

                // Update KPIs
                this.updateKPIs();

                // Render charts
                this.renderLTVChart();
                this.renderCACChart();
                this.renderCohortTable();

                // Render customer table
                this.renderCustomerTable();

            } catch (error) {
                DebugLog.error('Error loading customer data:', error);
            }
        },

        processCustomerData(orders) {
            const customerMap = new Map();

            orders.forEach(order => {
                if (order.status === 'cancelled' || order.status === 'refunded') return;

                const email = order.email || order.user_id || 'unknown';
                if (!customerMap.has(email)) {
                    customerMap.set(email, {
                        email,
                        name: order.shipping_recipient_name || 'Customer',
                        orders: [],
                        totalSpent: 0,
                        firstOrderDate: null,
                        lastOrderDate: null
                    });
                }

                const customer = customerMap.get(email);
                customer.orders.push(order);
                customer.totalSpent += order.total || 0;

                const orderDate = new Date(order.created_at);
                if (!customer.firstOrderDate || orderDate < customer.firstOrderDate) {
                    customer.firstOrderDate = orderDate;
                }
                if (!customer.lastOrderDate || orderDate > customer.lastOrderDate) {
                    customer.lastOrderDate = orderDate;
                }
            });

            // Calculate metrics for each customer
            this.customers = Array.from(customerMap.values()).map(customer => {
                const daysSinceLastOrder = customer.lastOrderDate
                    ? Math.floor((new Date() - customer.lastOrderDate) / (1000 * 60 * 60 * 24))
                    : 999;

                const orderCount = customer.orders.length;
                const avgOrderValue = orderCount > 0 ? customer.totalSpent / orderCount : 0;

                // Calculate LTV
                let ltv = avgOrderValue * 1.5; // Default for single order
                if (orderCount >= 2) {
                    const daysBetween = (customer.lastOrderDate - customer.firstOrderDate) / (1000 * 60 * 60 * 24);
                    const avgDaysBetweenOrders = daysBetween / (orderCount - 1);
                    const annualOrders = avgDaysBetweenOrders > 0 ? 365 / avgDaysBetweenOrders : 1;
                    ltv = avgOrderValue * annualOrders * 3;
                }

                // Determine status
                let status = 'active';
                let churnRisk = 10;
                if (daysSinceLastOrder > 180) {
                    status = 'churned';
                    churnRisk = 100;
                } else if (daysSinceLastOrder > 90) {
                    status = 'at_risk';
                    churnRisk = 75;
                } else if (daysSinceLastOrder > 45) {
                    status = 'cooling';
                    churnRisk = 50;
                } else if (daysSinceLastOrder > 21) {
                    churnRisk = 25;
                }

                // Health score
                let healthStatus = 'neutral';
                if (churnRisk >= 75) healthStatus = 'critical';
                else if (churnRisk >= 50) healthStatus = 'at-risk';
                else if (orderCount >= 3 && avgOrderValue > 100) healthStatus = 'excellent';
                else if (orderCount >= 2) healthStatus = 'good';

                return {
                    ...customer,
                    orderCount,
                    avgOrderValue,
                    daysSinceLastOrder,
                    ltv,
                    status,
                    churnRisk,
                    healthStatus
                };
            });

            // Sort by LTV descending
            this.customers.sort((a, b) => b.ltv - a.ltv);
        },

        updateKPIs() {
            const activeCustomers = this.customers.filter(c => c.status !== 'churned');

            // Average LTV
            const avgLTV = activeCustomers.length > 0
                ? activeCustomers.reduce((sum, c) => sum + c.ltv, 0) / activeCustomers.length
                : 0;
            document.getElementById('avg-ltv').textContent = formatPrice(avgLTV);

            // Estimated CAC (placeholder - would come from marketing spend / new customers)
            const estimatedCAC = 25; // Placeholder
            document.getElementById('avg-cac').textContent = formatPrice(estimatedCAC);

            // LTV:CAC Ratio
            const ratio = estimatedCAC > 0 ? (avgLTV / estimatedCAC).toFixed(1) : 0;
            document.getElementById('ltv-cac-ratio').textContent = `${ratio}:1`;

            // Churn rate
            const totalWithOrders = this.customers.length;
            const churned = this.customers.filter(c => c.status === 'churned').length;
            const churnRate = totalWithOrders > 0 ? (churned / totalWithOrders * 100) : 0;
            document.getElementById('churn-rate').textContent = churnRate.toFixed(1) + '%';

            // Update segment counts
            document.getElementById('segment-all').textContent = this.customers.length;
            document.getElementById('segment-active').textContent = this.customers.filter(c => c.daysSinceLastOrder <= 30).length;
            document.getElementById('segment-at-risk').textContent = this.customers.filter(c => c.status === 'at_risk').length;
            document.getElementById('segment-churned').textContent = this.customers.filter(c => c.status === 'churned').length;
        },

        renderLTVChart() {
            const ctx = document.getElementById('ltv-distribution-chart');
            if (!ctx) return;

            if (this.charts.ltv) this.charts.ltv.destroy();

            // Create LTV distribution buckets
            const buckets = {
                '$0-50': 0,
                '$50-100': 0,
                '$100-200': 0,
                '$200-500': 0,
                '$500-1000': 0,
                '$1000+': 0
            };

            this.customers.forEach(c => {
                if (c.ltv < 50) buckets['$0-50']++;
                else if (c.ltv < 100) buckets['$50-100']++;
                else if (c.ltv < 200) buckets['$100-200']++;
                else if (c.ltv < 500) buckets['$200-500']++;
                else if (c.ltv < 1000) buckets['$500-1000']++;
                else buckets['$1000+']++;
            });

            this.charts.ltv = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: Object.keys(buckets),
                    datasets: [{
                        label: 'Customers',
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
                        y: { beginAtZero: true, title: { display: true, text: 'Customers' } },
                        x: { title: { display: true, text: 'Lifetime Value' } }
                    }
                }
            });
        },

        renderCACChart() {
            const ctx = document.getElementById('cac-channel-chart');
            if (!ctx) return;

            if (this.charts.cac) this.charts.cac.destroy();

            // CAC by channel - data comes from attribution API
            this.charts.cac = new Chart(ctx, {
                type: 'doughnut',
                data: {
                    labels: ['Organic Search', 'Google Ads', 'Social', 'Direct', 'Referral'],
                    datasets: [{
                        data: [0, 0, 0, 0, 0],
                        backgroundColor: ['#267FB5', '#C71F6E', '#F4C430', '#10b981', '#8b5cf6']
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { position: 'bottom' },
                        tooltip: {
                            callbacks: {
                                label: (ctx) => `${ctx.label}: $${ctx.raw} CAC`
                            }
                        }
                    }
                }
            });
        },

        renderCohortTable() {
            const tbody = document.getElementById('cohort-tbody');

            // Group customers by cohort (first order month)
            const cohorts = {};
            this.customers.forEach(c => {
                if (!c.firstOrderDate) return;
                const cohortMonth = c.firstOrderDate.toISOString().slice(0, 7);
                if (!cohorts[cohortMonth]) {
                    cohorts[cohortMonth] = { total: 0, months: {} };
                }
                cohorts[cohortMonth].total++;

                // Track which months they ordered
                c.orders.forEach(order => {
                    const orderMonth = new Date(order.created_at);
                    const monthDiff = Math.floor((orderMonth - c.firstOrderDate) / (30 * 24 * 60 * 60 * 1000));
                    if (monthDiff >= 0 && monthDiff <= 6) {
                        if (!cohorts[cohortMonth].months[monthDiff]) {
                            cohorts[cohortMonth].months[monthDiff] = new Set();
                        }
                        cohorts[cohortMonth].months[monthDiff].add(c.email);
                    }
                });
            });

            // Get last 6 cohorts
            const sortedCohorts = Object.keys(cohorts).sort().reverse().slice(0, 6);

            if (sortedCohorts.length === 0) {
                tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; padding: var(--spacing-6);">No cohort data available</td></tr>';
                return;
            }

            tbody.innerHTML = sortedCohorts.map(month => {
                const cohort = cohorts[month];
                const cells = [];

                for (let i = 0; i <= 6; i++) {
                    const activeCount = cohort.months[i] ? cohort.months[i].size : 0;
                    const retention = cohort.total > 0 ? (activeCount / cohort.total * 100) : 0;

                    let cellClass = 'cohort-cell';
                    if (retention >= 80) cellClass += ' cohort-cell--80';
                    else if (retention >= 60) cellClass += ' cohort-cell--60';
                    else if (retention >= 40) cellClass += ' cohort-cell--40';
                    else if (retention >= 20) cellClass += ' cohort-cell--20';
                    else if (retention > 0) cellClass += ' cohort-cell--10';

                    cells.push(`<td><span class="${cellClass}" style="padding: 4px 8px;">${retention.toFixed(0)}%</span></td>`);
                }

                return `
                    <tr>
                        <td>${new Date(month + '-01').toLocaleDateString('en-NZ', { month: 'short', year: 'numeric' })}</td>
                        <td>${cohort.total}</td>
                        ${cells.join('')}
                    </tr>
                `;
            }).join('');
        },

        renderCustomerTable() {
            const tbody = document.getElementById('customer-health-tbody');
            const filter = document.getElementById('health-filter').value;

            let filtered = this.customers;

            // Apply segment filter
            if (this.selectedSegment === 'active') {
                filtered = filtered.filter(c => c.daysSinceLastOrder <= 30);
            } else if (this.selectedSegment === 'at-risk') {
                filtered = filtered.filter(c => c.status === 'at_risk');
            } else if (this.selectedSegment === 'churned') {
                filtered = filtered.filter(c => c.status === 'churned');
            }

            // Apply health filter
            if (filter !== 'all') {
                if (filter === 'at_risk') {
                    filtered = filtered.filter(c => c.healthStatus === 'at-risk' || c.healthStatus === 'critical');
                } else if (filter === 'critical') {
                    filtered = filtered.filter(c => c.healthStatus === 'critical');
                } else if (filter === 'excellent') {
                    filtered = filtered.filter(c => c.healthStatus === 'excellent' || c.healthStatus === 'good');
                }
            }

            if (filtered.length === 0) {
                tbody.innerHTML = '<tr><td colspan="8" style="text-align: center; padding: var(--spacing-6); color: var(--color-text-muted);">No customers match the selected filters</td></tr>';
                return;
            }

            tbody.innerHTML = filtered.slice(0, 50).map(customer => {
                const healthClass = {
                    'excellent': 'excellent',
                    'good': 'good',
                    'neutral': 'neutral',
                    'at-risk': 'at-risk',
                    'critical': 'critical'
                }[customer.healthStatus] || 'neutral';

                const riskBarClass = customer.churnRisk >= 75 ? 'high' : customer.churnRisk >= 50 ? 'medium' : 'low';

                return `
                    <tr>
                        <td>
                            <div style="font-weight: var(--font-weight-medium);">${customer.name}</div>
                            <div style="font-size: var(--font-size-xs); color: var(--color-text-muted);">${customer.email}</div>
                        </td>
                        <td><span class="health-badge health-badge--${healthClass}">${customer.healthStatus.replace('-', ' ')}</span></td>
                        <td>${customer.orderCount}</td>
                        <td>${formatPrice(customer.totalSpent)}</td>
                        <td>
                            <div>${customer.lastOrderDate ? customer.lastOrderDate.toLocaleDateString('en-NZ') : 'Never'}</div>
                            <div style="font-size: var(--font-size-xs); color: var(--color-text-muted);">${customer.daysSinceLastOrder} days ago</div>
                        </td>
                        <td>
                            <div class="risk-bar">
                                <div class="risk-bar__fill risk-bar__fill--${riskBarClass}" style="width: ${customer.churnRisk}%;"></div>
                            </div>
                            <div style="font-size: var(--font-size-xs); margin-top: 4px;">${customer.churnRisk}%</div>
                        </td>
                        <td>${formatPrice(customer.ltv)}</td>
                        <td>
                            <button class="btn btn--secondary btn--sm" data-action="view-customer" data-email="${customer.email}">View</button>
                        </td>
                    </tr>
                `;
            }).join('');

            tbody.querySelectorAll('[data-action="view-customer"]').forEach(btn => {
                btn.addEventListener('click', () => CustomerIntelligencePage.viewCustomer(btn.dataset.email));
            });
        },

        filterCustomers(healthFilter) {
            if (healthFilter) {
                document.getElementById('health-filter').value = healthFilter;
            }
            this.renderCustomerTable();
        },

        viewCustomer(email) {
            // Would open customer detail modal or navigate to customer page
            DebugLog.log('View customer:', email);
            alert('Customer detail view coming soon');
        }
    };

    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(() => { CustomerIntelligencePage.init(); }, 500);
    });
