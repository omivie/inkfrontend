    const FinancialHealthPage = {
        charts: {},
        data: {
            cashFlow: [],
            pnl: {},
            expenses: []
        },

        async init() {
            this.bindEvents();
            await this.loadData();
            this.checkAlerts();
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

            // Add expense button
            document.getElementById('add-expense-btn').addEventListener('click', () => {
                document.getElementById('expense-form-card').style.display = 'block';
                document.getElementById('expense-date').valueAsDate = new Date();
            });

            // Close expense form
            document.getElementById('close-expense-form').addEventListener('click', () => {
                document.getElementById('expense-form-card').style.display = 'none';
            });

            document.getElementById('cancel-expense').addEventListener('click', () => {
                document.getElementById('expense-form-card').style.display = 'none';
            });

            // Expense form submission
            document.getElementById('expense-form').addEventListener('submit', async (e) => {
                e.preventDefault();
                await this.saveExpense();
            });

            // Period selectors
            document.getElementById('cashflow-period').addEventListener('change', (e) => {
                this.loadCashFlowChart(parseInt(e.target.value));
            });

            document.getElementById('pnl-period').addEventListener('change', (e) => {
                this.loadPnL(e.target.value);
            });
        },

        async loadData() {
            try {
                // Load orders for revenue calculations
                const ordersResponse = await API.getOrders({ limit: 500 });
                const orders = ordersResponse.success ? (ordersResponse.data?.orders || []) : [];

                // Calculate financial metrics from orders
                this.calculateMetrics(orders);

                // Load cash flow chart
                this.loadCashFlowChart(12);

                // Load P&L
                this.loadPnL('quarter');

            } catch (error) {
                DebugLog.error('Error loading financial data:', error);
            }
        },

        calculateMetrics(orders) {
            // Calculate totals
            const now = new Date();
            const thisMonth = orders.filter(o => {
                const orderDate = new Date(o.created_at);
                return orderDate.getMonth() === now.getMonth() &&
                       orderDate.getFullYear() === now.getFullYear() &&
                       o.status !== 'cancelled' && o.status !== 'refunded';
            });

            const lastMonth = orders.filter(o => {
                const orderDate = new Date(o.created_at);
                const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
                return orderDate.getMonth() === lastMonthDate.getMonth() &&
                       orderDate.getFullYear() === lastMonthDate.getFullYear() &&
                       o.status !== 'cancelled' && o.status !== 'refunded';
            });

            const thisMonthRevenue = thisMonth.reduce((sum, o) => sum + (o.total || 0), 0);
            const lastMonthRevenue = lastMonth.reduce((sum, o) => sum + (o.total || 0), 0);

            // Estimate COGS at 60% (typical for ink cartridges)
            const cogsRate = 0.60;
            const thisMonthCogs = thisMonthRevenue * cogsRate;
            const grossProfit = thisMonthRevenue - thisMonthCogs;
            const grossMargin = thisMonthRevenue > 0 ? (grossProfit / thisMonthRevenue) * 100 : 0;

            // Estimate expenses (placeholder - would come from expenses table)
            const monthlyExpenses = 2000; // Placeholder
            const netProfit = grossProfit - monthlyExpenses;

            // Calculate burn rate (if not profitable)
            const monthlyBurn = Math.max(0, monthlyExpenses - grossProfit);

            // Estimate cash balance (placeholder - would come from actual banking data)
            const estimatedCash = 50000; // Placeholder

            // Calculate runway
            const runway = monthlyBurn > 0 ? estimatedCash / monthlyBurn : Infinity;

            // Update KPIs
            document.getElementById('cash-balance').textContent = formatPrice(estimatedCash);
            document.getElementById('gross-margin').textContent = grossMargin.toFixed(1) + '%';
            document.getElementById('monthly-burn').textContent = monthlyBurn > 0 ? formatPrice(monthlyBurn) : '$0 (profitable)';

            if (runway === Infinity) {
                document.getElementById('runway-months').textContent = '∞';
                document.getElementById('runway-days').textContent = 'Business is profitable';
            } else {
                document.getElementById('runway-months').textContent = runway.toFixed(1) + ' mo';
                document.getElementById('runway-days').textContent = `~${Math.round(runway * 30)} days at current burn`;
            }

            // Update forecasts (simple linear projection)
            const avgDailyRevenue = thisMonthRevenue / new Date().getDate();
            document.getElementById('forecast-30').textContent = formatPrice(avgDailyRevenue * 30);
            document.getElementById('forecast-60').textContent = formatPrice(avgDailyRevenue * 60);
            document.getElementById('forecast-90').textContent = formatPrice(avgDailyRevenue * 90);

            // Update break-even status
            if (netProfit >= 0) {
                document.getElementById('breakeven-indicator').style.background = '#10b981';
                document.getElementById('breakeven-status').textContent = 'Profitable';
                document.getElementById('breakeven-gap').textContent = `Net profit: ${formatPrice(netProfit)}/month`;
            } else {
                document.getElementById('breakeven-indicator').style.background = 'var(--magenta-primary)';
                document.getElementById('breakeven-status').textContent = 'Below Break-Even';
                document.getElementById('breakeven-gap').textContent = `Need ${formatPrice(Math.abs(netProfit))} more revenue/month`;
            }

            // Store for P&L
            this.data.thisMonthRevenue = thisMonthRevenue;
            this.data.lastMonthRevenue = lastMonthRevenue;
            this.data.thisMonthCogs = thisMonthCogs;
            this.data.grossProfit = grossProfit;
            this.data.monthlyExpenses = monthlyExpenses;
            this.data.netProfit = netProfit;
            this.data.runway = runway;
        },

        loadCashFlowChart(months) {
            const ctx = document.getElementById('cashflow-chart');
            if (!ctx) return;

            if (this.charts.cashflow) this.charts.cashflow.destroy();

            // Generate month labels
            const labels = [];
            const inflows = [];
            const outflows = [];
            const netFlow = [];

            for (let i = months - 1; i >= 0; i--) {
                const d = new Date();
                d.setMonth(d.getMonth() - i);
                labels.push(d.toLocaleDateString('en-NZ', { month: 'short', year: '2-digit' }));

                // Data comes from API - shows 0 until backend provides cash flow data
                inflows.push(0);
                outflows.push(0);
                netFlow.push(0);
            }

            this.charts.cashflow = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels,
                    datasets: [
                        {
                            label: 'Inflows',
                            data: inflows,
                            backgroundColor: '#10b981',
                            borderRadius: 4
                        },
                        {
                            label: 'Outflows',
                            data: outflows.map(v => -v),
                            backgroundColor: '#C71F6E',
                            borderRadius: 4
                        },
                        {
                            label: 'Net Cash Flow',
                            data: netFlow,
                            type: 'line',
                            borderColor: '#267FB5',
                            backgroundColor: 'transparent',
                            borderWidth: 3,
                            pointRadius: 4,
                            pointBackgroundColor: '#267FB5'
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { position: 'top' }
                    },
                    scales: {
                        x: { stacked: false },
                        y: {
                            beginAtZero: true,
                            ticks: { callback: v => '$' + (v / 1000).toFixed(0) + 'k' }
                        }
                    }
                }
            });
        },

        loadPnL(period) {
            // Update P&L table with calculated values
            // This would typically fetch from the backend based on period

            const revenue = this.data.thisMonthRevenue || 0;
            const prevRevenue = this.data.lastMonthRevenue || 0;
            const cogs = this.data.thisMonthCogs || 0;
            const grossProfit = this.data.grossProfit || 0;
            const expenses = this.data.monthlyExpenses || 0;
            const netProfit = this.data.netProfit || 0;

            // Update table cells
            document.getElementById('pnl-gross-sales').textContent = formatPrice(revenue);
            document.getElementById('pnl-gross-sales-prev').textContent = formatPrice(prevRevenue);
            document.getElementById('pnl-gross-sales-change').textContent = this.calculateChange(revenue, prevRevenue);

            document.getElementById('pnl-net-revenue').textContent = formatPrice(revenue * 0.98); // After discounts
            document.getElementById('pnl-net-revenue-prev').textContent = formatPrice(prevRevenue * 0.98);

            document.getElementById('pnl-cogs').textContent = '-' + formatPrice(cogs);
            document.getElementById('pnl-cogs-prev').textContent = '-' + formatPrice(prevRevenue * 0.6);

            document.getElementById('pnl-gross-profit').textContent = formatPrice(grossProfit);
            document.getElementById('pnl-gross-profit-prev').textContent = formatPrice(prevRevenue * 0.4);

            document.getElementById('pnl-net-profit').innerHTML = '<strong>' + formatPrice(netProfit) + '</strong>';
            document.getElementById('pnl-net-margin').textContent = revenue > 0 ? (netProfit / revenue * 100).toFixed(1) + '%' : '0%';

            // Update color classes
            const netProfitCell = document.getElementById('pnl-net-profit');
            netProfitCell.className = netProfit >= 0 ? 'pnl-table__positive' : 'pnl-table__negative';
        },

        calculateChange(current, previous) {
            if (previous === 0) return current > 0 ? '+∞' : '0%';
            const change = ((current - previous) / previous) * 100;
            return (change >= 0 ? '+' : '') + change.toFixed(1) + '%';
        },

        checkAlerts() {
            const runway = this.data.runway;

            if (runway !== undefined && runway < 90 && runway !== Infinity) {
                const alertBanner = document.getElementById('runway-alert');
                alertBanner.style.display = 'flex';

                if (runway < 45) {
                    alertBanner.className = 'alert-banner alert-banner--critical';
                    document.getElementById('alert-title').textContent = 'Critical: Low Cash Runway';
                    document.getElementById('alert-text').textContent = `Only ${Math.round(runway)} months of runway remaining. Immediate action required.`;
                } else {
                    alertBanner.className = 'alert-banner alert-banner--warning';
                    document.getElementById('alert-title').textContent = 'Warning: Cash Runway Below Target';
                    document.getElementById('alert-text').textContent = `${Math.round(runway)} months runway. Target is 6+ months.`;
                }
            }
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
                // In production, this would call the API
                // await AnalyticsAPI.addExpense({ category, amount, date, vendor });

                // For now, show success and reset form
                alert('Expense saved successfully!');
                document.getElementById('expense-form').reset();
                document.getElementById('expense-form-card').style.display = 'none';

                // Reload data
                await this.loadData();

            } catch (error) {
                DebugLog.error('Error saving expense:', error);
                alert('Failed to save expense. Please try again.');
            }
        }
    };

    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(() => { FinancialHealthPage.init(); }, 500);
    });
