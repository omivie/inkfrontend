(function() {
    const BusinessDashboard = {
        dashboardData: null,
        activeTab: 'invoiced',

        async init() {
            if (typeof Auth !== 'undefined' && Auth.readyPromise) {
                await Auth.readyPromise;
            }

            if (typeof Auth === 'undefined' || !Auth.isAuthenticated()) {
                window.location.href = '/html/account/login.html?redirect=/html/account/business.html';
                return;
            }

            const container = document.getElementById('business-dashboard');
            if (!container) return;

            // Check B2B status
            try {
                const res = await API.getBusinessStatus();
                if (!res.ok || res.data?.status !== 'approved') {
                    container.innerHTML = `
                        <div class="account-empty">
                            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20 7h-4V4c0-1.1-.9-2-2-2h-4c-1.1 0-2 .9-2 2v3H4c-1.1 0-2 .9-2 2v11c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V9c0-1.1-.9-2-2-2zM10 4h4v3h-4V4z"/></svg>
                            <p>You don't have an active business account.</p>
                            <a href="/html/business/apply.html" class="btn btn--primary">Apply for Business Account</a>
                        </div>
                    `;
                    return;
                }
            } catch (e) {
                container.innerHTML = `
                    <div class="account-empty">
                        <p>Unable to load business account status.</p>
                        <a href="/html/business/apply.html" class="btn btn--primary">Apply for Business Account</a>
                    </div>
                `;
                return;
            }

            // Load dashboard data
            container.innerHTML = '<div class="loading-spinner" style="text-align:center;padding:40px">Loading...</div>';

            try {
                const [dashRes, reorderRes] = await Promise.allSettled([
                    API.getBusinessDashboard(),
                    API.getBusinessReorderItems()
                ]);

                this.dashboardData = dashRes.status === 'fulfilled' && dashRes.value?.ok ? dashRes.value.data : {};
                const reorderItems = reorderRes.status === 'fulfilled' && reorderRes.value?.ok ? (reorderRes.value.data?.items || reorderRes.value.data || []) : [];

                this.render(container, reorderItems);
                this.loadInvoices('invoiced');
            } catch (e) {
                container.innerHTML = '<p style="color:var(--color-text-secondary);padding:20px">Failed to load dashboard data.</p>';
            }
        },

        render(container, reorderItems) {
            const d = this.dashboardData || {};
            const fmtPrice = (v) => typeof formatPrice === 'function' ? formatPrice(v) : `$${Number(v || 0).toFixed(2)}`;

            const tierColors = {
                bronze: { bg: '#fef3c7', color: '#b45309' },
                silver: { bg: '#f3f4f6', color: '#6b7280' },
                gold: { bg: '#fef3c7', color: '#d97706' },
            };
            const tier = (d.pricing_tier || 'bronze').toLowerCase();
            const tc = tierColors[tier] || tierColors.bronze;

            container.innerHTML = `
                <h1 class="account-content__heading">Business Account</h1>

                <div class="biz-dashboard__cards">
                    <div class="biz-dashboard__card">
                        <div class="biz-dashboard__card-label">Credit Limit</div>
                        <div class="biz-dashboard__card-value">${Security.escapeHtml(fmtPrice(d.credit_limit || 0))}</div>
                    </div>
                    <div class="biz-dashboard__card">
                        <div class="biz-dashboard__card-label">Amount Due</div>
                        <div class="biz-dashboard__card-value biz-dashboard__card-value--due">${Security.escapeHtml(fmtPrice(d.amount_due || 0))}</div>
                    </div>
                    <div class="biz-dashboard__card">
                        <div class="biz-dashboard__card-label">Credit Remaining</div>
                        <div class="biz-dashboard__card-value">${Security.escapeHtml(fmtPrice(d.credit_remaining || 0))}</div>
                    </div>
                    <div class="biz-dashboard__card">
                        <div class="biz-dashboard__card-label">Pricing Tier</div>
                        <div class="biz-dashboard__card-value">
                            <span class="biz-dashboard__tier" style="background:${tc.bg};color:${tc.color}">${Security.escapeHtml(d.pricing_tier || 'Bronze')}</span>
                        </div>
                    </div>
                </div>

                <div class="biz-dashboard__section">
                    <h2 class="biz-dashboard__section-title">Orders</h2>
                    <div class="biz-dashboard__tabs">
                        <button class="biz-dashboard__tab active" data-tab="invoiced">Invoiced Orders</button>
                        <button class="biz-dashboard__tab" data-tab="paid">Paid Orders</button>
                    </div>
                    <div id="biz-orders-table">
                        <div class="loading-spinner" style="text-align:center;padding:20px">Loading...</div>
                    </div>
                </div>

                ${reorderItems.length > 0 ? `
                <div class="biz-dashboard__section">
                    <h2 class="biz-dashboard__section-title">Quick Reorder</h2>
                    <div class="biz-dashboard__reorder-grid">
                        ${reorderItems.slice(0, 5).map(item => `
                            <div class="biz-reorder-card">
                                <a href="${item.slug ? `/products/${Security.escapeAttr(item.slug)}/${Security.escapeAttr(item.sku || '')}` : `/html/product/?sku=${Security.escapeAttr(item.sku || '')}`}" class="biz-reorder-card__image-link">
                                    <img src="${Security.escapeAttr(item.image_url || item.thumbnail || '/assets/images/placeholder.png')}" alt="${Security.escapeAttr(item.name || '')}" class="biz-reorder-card__image" loading="lazy">
                                </a>
                                <div class="biz-reorder-card__info">
                                    <a href="${item.slug ? `/products/${Security.escapeAttr(item.slug)}/${Security.escapeAttr(item.sku || '')}` : `/html/product/?sku=${Security.escapeAttr(item.sku || '')}`}" class="biz-reorder-card__name">${Security.escapeHtml(item.name || 'Product')}</a>
                                    <span class="biz-reorder-card__price">${Security.escapeHtml(fmtPrice(item.price))}</span>
                                </div>
                                <button class="btn btn--primary btn--sm biz-reorder-card__btn" data-sku="${Security.escapeAttr(item.sku || '')}" data-product-id="${Security.escapeAttr(item.product_id || item.id || '')}">Add to Cart</button>
                            </div>
                        `).join('')}
                    </div>
                </div>
                ` : ''}
            `;

            // Tab switching
            container.querySelector('.biz-dashboard__tabs')?.addEventListener('click', (e) => {
                const tab = e.target.closest('[data-tab]');
                if (!tab) return;
                this.activeTab = tab.dataset.tab;
                container.querySelectorAll('.biz-dashboard__tab').forEach(t =>
                    t.classList.toggle('active', t.dataset.tab === this.activeTab));
                this.loadInvoices(this.activeTab);
            });

            // Add to cart buttons
            container.querySelectorAll('.biz-reorder-card__btn').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const productId = btn.dataset.productId;
                    if (!productId) return;
                    btn.disabled = true;
                    btn.textContent = 'Adding...';
                    try {
                        if (typeof Cart !== 'undefined' && Cart.addItem) {
                            await Cart.addItem(productId, 1);
                        } else {
                            await API.addToCart(productId, 1);
                        }
                        btn.textContent = 'Added!';
                        setTimeout(() => { btn.textContent = 'Add to Cart'; btn.disabled = false; }, 1500);
                    } catch (e) {
                        btn.textContent = 'Failed';
                        setTimeout(() => { btn.textContent = 'Add to Cart'; btn.disabled = false; }, 1500);
                    }
                });
            });
        },

        async loadInvoices(tab) {
            const tableEl = document.getElementById('biz-orders-table');
            if (!tableEl) return;
            tableEl.innerHTML = '<div class="loading-spinner" style="text-align:center;padding:20px">Loading...</div>';

            try {
                const status = tab === 'paid' ? 'paid' : 'unpaid';
                const res = await API.getBusinessInvoices({ status, limit: 20 });
                const invoices = res?.ok ? (res.data?.invoices || res.data?.items || res.data || []) : [];

                if (!invoices.length) {
                    tableEl.innerHTML = `<p style="color:var(--color-text-secondary);text-align:center;padding:20px">No ${tab === 'paid' ? 'paid' : 'invoiced'} orders found.</p>`;
                    return;
                }

                const fmtPrice = (v) => typeof formatPrice === 'function' ? formatPrice(v) : `$${Number(v || 0).toFixed(2)}`;

                tableEl.innerHTML = `
                    <table class="orders-table">
                        <thead>
                            <tr>
                                <th scope="col">Invoice #</th>
                                <th scope="col">Order #</th>
                                <th scope="col">Date</th>
                                <th scope="col">Amount</th>
                                <th scope="col">${tab === 'paid' ? 'Paid' : 'Due'}</th>
                                <th scope="col">Status</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${invoices.map(inv => {
                                const statusClass = inv.status === 'paid' ? 'delivered' : inv.status === 'overdue' ? 'cancelled' : 'processing';
                                const dateField = tab === 'paid' ? (inv.paid_at || inv.due_date) : inv.due_date;
                                return `
                                    <tr>
                                        <td>${Security.escapeHtml(inv.invoice_number || inv.id || '\u2014')}</td>
                                        <td><a href="/html/account/order-detail.html?order=${Security.escapeAttr(inv.order_number || '')}">${Security.escapeHtml(inv.order_number || '\u2014')}</a></td>
                                        <td>${dateField ? new Date(dateField).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' }) : '\u2014'}</td>
                                        <td>${Security.escapeHtml(fmtPrice(inv.amount))}</td>
                                        <td>${dateField ? new Date(dateField).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' }) : '\u2014'}</td>
                                        <td><span class="order-status order-status--${statusClass}">${Security.escapeHtml(inv.status || 'unpaid')}</span></td>
                                    </tr>
                                `;
                            }).join('')}
                        </tbody>
                    </table>
                `;
            } catch (e) {
                tableEl.innerHTML = '<p style="color:var(--color-text-secondary);text-align:center;padding:20px">Failed to load orders.</p>';
            }
        }
    };

    document.addEventListener('DOMContentLoaded', () => BusinessDashboard.init());
})();
