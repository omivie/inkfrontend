    const OrderDetailPage = {
        orderData: null,

        async init() {
            // Get order ID from URL
            const urlParams = new URLSearchParams(window.location.search);
            const orderNumber = urlParams.get('id');

            if (!orderNumber) {
                this.showError('No order specified');
                return;
            }

            await this.loadOrder(orderNumber);
        },

        async loadOrder(orderNumber) {
            let order = null;

            // Try API first
            try {
                const response = await API.getOrder(orderNumber);
                if (response.success && response.data) {
                    order = response.data;
                    DebugLog.log('Order loaded from API');
                }
            } catch (error) {
                DebugLog.log('Could not load from API:', error.message);
            }

            if (order) {
                this.orderData = order;
                this.renderOrder();
            } else {
                this.showError('Order not found');
            }
        },

        renderOrder() {
            const order = this.orderData;

            // Update page title
            document.title = `Order #${order.order_number} | InkCartridges.co.nz`;

            // Update heading
            const heading = document.querySelector('.account-content__heading');
            if (heading) heading.textContent = `Order #${order.order_number}`;

            // Update status
            const statusEl = document.querySelector('.order-status');
            if (statusEl && order.status) {
                const statusClass = this.getStatusClass(order.status);
                statusEl.className = `order-status order-status--${statusClass}`;
                statusEl.textContent = this.formatStatus(order.status);
            }

            // Update date
            const dateEl = document.querySelector('.order-date');
            if (dateEl && order.created_at) {
                const date = new Date(order.created_at);
                dateEl.textContent = `Placed on ${date.toLocaleDateString('en-NZ', {
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric'
                })}`;
            }

            // Render items
            const itemsContainer = document.querySelector('.order-items');
            if (itemsContainer) {
                const items = order.order_items || [];
                itemsContainer.innerHTML = `
                    <h2>Items Ordered</h2>
                    <div class="order-items-list">
                        ${items.map(item => {
                            const imageUrl = item.product?.image_url || item.image_url || null;
                            return `
                            <div class="order-item">
                                <div class="order-item__image">
                                    ${imageUrl
                                        ? `<img src="${imageUrl}" alt="${item.product_name}">`
                                        : this.getColorPlaceholder(item.product_name)
                                    }
                                </div>
                                <div class="order-item__details">
                                    <h3>${item.product_name}</h3>
                                    <p class="order-item__sku">SKU: ${item.product_sku || 'N/A'}</p>
                                    <p class="order-item__qty">Qty: ${item.quantity} × ${formatPrice(item.unit_price)}</p>
                                </div>
                                <div class="order-item__price">${formatPrice(item.line_total || (item.unit_price * item.quantity))}</div>
                            </div>
                        `}).join('')}
                    </div>
                `;
            }

            // Render summary
            const summaryContainer = document.querySelector('.order-summary');
            if (summaryContainer) {
                const subtotal = order.subtotal || order.total;
                const shipping = order.shipping_cost || 0;
                const total = order.total;

                summaryContainer.innerHTML = `
                    <h2>Order Summary</h2>
                    <dl class="order-summary__list">
                        <dt>Subtotal</dt><dd>${formatPrice(subtotal)}</dd>
                        <dt>Shipping</dt><dd>${shipping === 0 ? 'FREE' : formatPrice(shipping)}</dd>
                        <dt>GST (15%)</dt><dd>Included</dd>
                        <dt class="order-summary__total">Total</dt><dd class="order-summary__total">${formatPrice(total)}</dd>
                    </dl>
                `;
            }

            // Render shipping address
            const shippingContainer = document.querySelector('.order-shipping');
            if (shippingContainer) {
                const name = order.shipping_recipient_name || '';

                const parts = [
                    name ? `<strong>${name}</strong>` : '',
                    order.shipping_address_line1,
                    order.shipping_address_line2,
                    order.shipping_city,
                    `${order.shipping_region || ''} ${order.shipping_postal_code || ''}`.trim(),
                    order.shipping_country || 'New Zealand'
                ].filter(Boolean);

                shippingContainer.innerHTML = `
                    <h2>Shipping Address</h2>
                    <address>${parts.join('<br>')}</address>
                `;
            }

            // Update breadcrumb
            const breadcrumb = document.querySelector('.breadcrumb__item--current');
            if (breadcrumb) breadcrumb.textContent = `Order #${order.order_number}`;
        },

        getStatusClass(status) {
            const statusMap = {
                'pending': 'pending',
                'paid': 'processing',
                'processing': 'processing',
                'shipped': 'shipped',
                'completed': 'delivered',
                'delivered': 'delivered',
                'cancelled': 'cancelled',
                'test_completed': 'processing'
            };
            return statusMap[status] || 'pending';
        },

        formatStatus(status) {
            const statusMap = {
                'pending': 'Pending',
                'paid': 'Paid',
                'processing': 'Processing',
                'shipped': 'Shipped',
                'completed': 'Completed',
                'delivered': 'Delivered',
                'cancelled': 'Cancelled',
                'test_completed': 'Test Order'
            };
            return statusMap[status] || status;
        },

        getColorPlaceholder(productName) {
            const name = (productName || '').toLowerCase();
            const colors = {
                'black': '#1a1a1a',
                'cyan': '#00bcd4',
                'magenta': '#e91e63',
                'yellow': '#ffeb3b',
                'red': '#f44336',
                'blue': '#2196f3',
                'green': '#4caf50'
            };

            // Check for color in name
            for (const [colorName, colorValue] of Object.entries(colors)) {
                if (name.includes(colorName)) {
                    return `<div style="width: 60px; height: 60px; background-color: ${colorValue}; border-radius: 8px;"></div>`;
                }
            }

            // Check for multi-color packs
            if (name.includes('4-pack') || name.includes('4 pack') || name.includes('combo') || name.includes('value')) {
                return `<div style="width: 60px; height: 60px; background: linear-gradient(to right, #1a1a1a 25%, #00bcd4 25%, #00bcd4 50%, #e91e63 50%, #e91e63 75%, #ffeb3b 75%); border-radius: 8px;"></div>`;
            }

            // Default placeholder
            return `<svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="6" y="2" width="12" height="20" rx="2"/><line x1="9" y1="6" x2="15" y2="6"/></svg>`;
        },

        showError(message) {
            const content = document.querySelector('.account-content');
            if (content) {
                content.innerHTML = `
                    <div class="account-empty">
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                            <circle cx="12" cy="12" r="10"/>
                            <line x1="12" y1="8" x2="12" y2="12"/>
                            <line x1="12" y1="16" x2="12.01" y2="16"/>
                        </svg>
                        <p>${message}</p>
                        <a href="/html/account/orders.html" class="btn btn--primary">View All Orders</a>
                    </div>
                `;
            }
        }
    };

    document.addEventListener('DOMContentLoaded', () => {
        OrderDetailPage.init();
    });
