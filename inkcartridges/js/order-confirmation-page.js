    // Order confirmation page
    const ConfirmationPage = {
        orderData: null,

        async init() {
            // Get order number from URL or sessionStorage
            const urlParams = new URLSearchParams(window.location.search);
            const orderNumber = urlParams.get('order');

            // Handle Stripe redirect params (payment_intent, redirect_status)
            const redirectStatus = urlParams.get('redirect_status');
            const paymentIntentId = urlParams.get('payment_intent');

            if (redirectStatus && redirectStatus !== 'succeeded') {
                // Payment failed or is pending after Stripe redirect
                this.showPaymentPendingBanner(redirectStatus === 'failed' ? 'failed' : 'pending');
            }

            // If redirected from Stripe with a successful payment, clear cart
            if (redirectStatus === 'succeeded') {
                try {
                    if (typeof API !== 'undefined') await API.clearCart();
                } catch (e) { /* ignore */ }
                if (typeof Cart !== 'undefined') {
                    Cart.items = [];
                    document.querySelectorAll('.cart-count, .cart-badge, #cart-count').forEach(el => { el.textContent = '0'; });
                }
                localStorage.removeItem('inkcartridges_cart');
            }

            // Pre-fill email from sessionStorage (set by payment page)
            const storedOrder = sessionStorage.getItem('lastOrder');
            if (storedOrder) {
                try {
                    const stored = JSON.parse(storedOrder);
                    // Show email immediately while API loads
                    if (stored.email) {
                        const emailEl = document.getElementById('confirmation-email');
                        if (emailEl) emailEl.textContent = stored.email;
                    }
                    // Show order number immediately
                    if (stored.order_number) {
                        const orderNumEl = document.getElementById('order-number');
                        if (orderNumEl) orderNumEl.textContent = `#${stored.order_number}`;
                    }
                } catch (e) {
                    DebugLog.error('Failed to parse stored order:', e);
                }
                sessionStorage.removeItem('lastOrder');
            }

            // Wait for Auth so API calls include the auth token
            if (typeof Auth !== 'undefined' && Auth.readyPromise) {
                await Auth.readyPromise;
            }

            // Load full order details from API
            if (orderNumber) {
                await this.loadOrderFromAPI(orderNumber);
            }
        },

        async loadOrderFromAPI(orderNumber) {
            try {
                const response = await API.getOrder(orderNumber);
                if (response.ok && response.data) {
                    this.orderData = this.transformAPIOrder(response.data);
                    this.renderOrderDetails();
                } else {
                    this.showFallback(orderNumber);
                }
            } catch (error) {
                DebugLog.error('Failed to load order from API:', error);
                this.showFallback(orderNumber);
            }
        },

        showFallback(orderNumber) {
            const orderNumEl = document.getElementById('order-number');
            if (orderNumEl) orderNumEl.textContent = `#${orderNumber}`;

            // Clear loading states so they don't mislead
            const paymentEl = document.getElementById('payment-method');
            if (paymentEl) paymentEl.textContent = '--';
            const totalEl = document.getElementById('order-total');
            if (totalEl) totalEl.textContent = '--';
            const shippingMethodEl = document.getElementById('shipping-method');
            if (shippingMethodEl) shippingMethodEl.textContent = '--';
            const dateEl = document.getElementById('order-date');
            if (dateEl) dateEl.textContent = new Date().toLocaleDateString('en-NZ', { day: 'numeric', month: 'long', year: 'numeric' });
            const addressEl = document.getElementById('shipping-address');
            if (addressEl) addressEl.innerHTML = '<span style="color: var(--color-text-muted);">Details will be in your confirmation email</span>';
            const itemsList = document.getElementById('order-items');
            if (itemsList) itemsList.innerHTML = '<li class="confirmation-item" style="justify-content: center; padding: 2rem;"><p style="color: var(--color-text-muted);">Order details will be in your confirmation email.</p></li>';
        },

        transformAPIOrder(apiOrder) {
            // Build shipping address from flat fields (backend returns shipping_recipient_name, etc.)
            const shippingAddress = apiOrder.shipping_address || {
                recipient_name: apiOrder.shipping_recipient_name || '',
                phone: apiOrder.shipping_phone || '',
                address_line1: apiOrder.shipping_address_line1 || '',
                address_line2: apiOrder.shipping_address_line2 || '',
                city: apiOrder.shipping_city || '',
                region: apiOrder.shipping_region || '',
                postal_code: apiOrder.shipping_postal_code || '',
                country: apiOrder.shipping_country || 'NZ'
            };

            return {
                orderNumber: apiOrder.order_number || apiOrder.id,
                email: apiOrder.email || apiOrder.customer_email,
                total: apiOrder.total,
                subtotal: apiOrder.subtotal,
                gstAmount: apiOrder.gst_amount || 0,
                shipping: apiOrder.shipping_tier || apiOrder.shipping_method || 'Standard Shipping',
                deliveryZone: apiOrder.delivery_zone || null,
                estimatedDelivery: apiOrder.estimated_delivery || null,
                shippingCost: apiOrder.shipping_fee || apiOrder.shipping_cost || 0,
                items: (apiOrder.order_items || apiOrder.items || []).map(item => ({
                    name: item.product?.name || item.product_name || item.name,
                    sku: item.product?.sku || item.product_sku || item.sku,
                    quantity: item.quantity,
                    price: item.unit_price || item.price,
                    image_url: typeof storageUrl === 'function' ? storageUrl(item.product?.image_url || item.image_url) : (item.product?.image_url || item.image_url || null),
                    brand: item.product?.brand?.name || item.brand || null,
                    source: item.product?.source || item.source || null
                })),
                shippingAddress: shippingAddress,
                status: apiOrder.status,
                paymentMethod: apiOrder.payment_method,
                createdAt: apiOrder.created_at,
                customerNotes: apiOrder.customer_notes || null,
                trackingNumber: apiOrder.tracking_number || null,
                invoiceNumber: apiOrder.invoice?.invoice_number || null,
                invoiceDate: apiOrder.invoice?.invoice_date || null
            };
        },

        renderOrderDetails() {
            if (!this.orderData) return;

            const order = this.orderData;

            // Show test mode banner if applicable (support both formats)
            if (order.testMode || order.is_test_order) {
                this.showTestModeBanner();
            }

            // Show payment pending/failed banner if order is not paid
            if (order.status && order.status !== 'paid' && order.status !== 'processing' && order.status !== 'shipped' && order.status !== 'delivered') {
                this.showPaymentPendingBanner(order.status);
            }

            // Order number (support both formats)
            const orderNumEl = document.getElementById('order-number');
            if (orderNumEl) {
                orderNumEl.textContent = `#${order.orderNumber || order.order_number}`;
            }

            // Invoice number (if available)
            const invoiceNumber = order.invoiceNumber || order.invoice_number;
            if (invoiceNumber) {
                const invoiceRowEl = document.getElementById('invoice-row');
                const invoiceNumEl = document.getElementById('invoice-number');
                if (invoiceRowEl) invoiceRowEl.style.display = '';
                if (invoiceNumEl) invoiceNumEl.textContent = invoiceNumber;
            }

            // Email
            const emailEl = document.getElementById('confirmation-email');
            if (emailEl && order.email) {
                emailEl.textContent = order.email;
            }

            // Order date (support both formats)
            const dateEl = document.getElementById('order-date');
            if (dateEl) {
                const dateValue = order.createdAt || order.created_at;
                const date = dateValue ? new Date(dateValue) : new Date();
                dateEl.textContent = date.toLocaleDateString('en-NZ', {
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric'
                });
            }

            // Payment method (support both formats)
            const paymentEl = document.getElementById('payment-method');
            const paymentMethod = order.paymentMethod || order.payment_method;
            if (paymentEl && paymentMethod) {
                const paymentLabels = {
                    'stripe': 'Credit/Debit Card',
                    'card': 'Credit/Debit Card',
                    'paypal': 'PayPal'
                };
                paymentEl.textContent = paymentLabels[paymentMethod] || paymentMethod;
            }

            // Order total
            const totalEl = document.getElementById('order-total');
            if (totalEl && order.total) {
                totalEl.textContent = `$${parseFloat(order.total).toFixed(2)} NZD`;
            }

            // Shipping address (support both formats)
            const addressEl = document.getElementById('shipping-address');
            const addr = order.shippingAddress || order.shipping_address;
            if (addressEl) {
                if (addr && Object.keys(addr).length > 0) {
                    const name = addr.firstName && addr.lastName
                        ? `${addr.firstName} ${addr.lastName}`
                        : (addr.first_name && addr.last_name ? `${addr.first_name} ${addr.last_name}` : addr.recipient_name || '');

                    const parts = [
                        name ? `<strong>${name}</strong>` : '',
                        addr.company,
                        addr.address1 || addr.address_line1,
                        addr.address2 || addr.address_line2,
                        addr.city,
                        `${this.formatRegion(addr.region)} ${addr.postcode || addr.postal_code || ''}`.trim(),
                        'New Zealand'
                    ].filter(Boolean);

                    if (parts.length > 1) {
                        addressEl.innerHTML = parts.join('<br>');
                    } else {
                        addressEl.innerHTML = '<span style="color: var(--color-text-muted);">Address details not available</span>';
                    }
                } else {
                    addressEl.innerHTML = '<span style="color: var(--color-text-muted);">Address details not available</span>';
                }
            }

            // Shipping method — format shipping_tier + delivery_zone into readable label
            const shippingMethodEl = document.getElementById('shipping-method');
            if (shippingMethodEl && order.shipping) {
                const tierLabels = {
                    'urban': 'Urban Delivery',
                    'rural': 'Rural Delivery',
                    'overnight': 'Overnight Express',
                    'express': 'Express Delivery',
                    'standard': 'Standard Delivery'
                };
                const tierLabel = tierLabels[order.shipping.toLowerCase()] || order.shipping;
                const zoneLabel = order.deliveryZone
                    ? ` — ${order.deliveryZone.charAt(0).toUpperCase() + order.deliveryZone.slice(1)}`
                    : '';
                shippingMethodEl.textContent = tierLabel + zoneLabel;
            }

            // Estimated delivery — use actual date from API, fall back to tier-based estimate
            const deliveryEl = document.getElementById('estimated-delivery');
            if (deliveryEl) {
                if (order.estimatedDelivery) {
                    const d = new Date(order.estimatedDelivery);
                    deliveryEl.textContent = d.toLocaleDateString('en-NZ', { day: 'numeric', month: 'long', year: 'numeric' });
                } else {
                    const shipping = order.shipping?.toLowerCase() || '';
                    if (shipping.includes('overnight')) {
                        deliveryEl.textContent = 'Next business day';
                    } else if (shipping.includes('express')) {
                        deliveryEl.textContent = '1-2 business days';
                    } else {
                        deliveryEl.textContent = '3-5 business days';
                    }
                }
            }

            // Order items
            if (order.items && order.items.length > 0) {
                this.renderOrderItems(order.items);
            }

            // Update totals
            this.renderTotals(order);

            // Google Customer Reviews opt-in
            this.renderGoogleReviewsOptIn(order);
        },

        renderGoogleReviewsOptIn(order) {
            if (!order || !order.email || !order.orderNumber) return;

            const data = {
                merchant_id: 5748243992,
                order_id: String(order.orderNumber),
                email: order.email,
                delivery_country: 'NZ',
                estimated_delivery_date: this.getEstimatedDeliveryDate(order.shipping)
            };

            // Store for renderOptIn callback (fires when platform.js loads)
            window._googleReviewsOptInData = data;

            // If platform.js already loaded and gapi.surveyoptin is ready, render immediately
            if (window.gapi && window.gapi.surveyoptin) {
                window.gapi.surveyoptin.render(data);
            }
        },

        getEstimatedDeliveryDate(shippingMethod) {
            const shipping = (shippingMethod || '').toLowerCase();
            let businessDays;
            if (shipping.includes('overnight')) {
                businessDays = 1;
            } else if (shipping.includes('express')) {
                businessDays = 2;
            } else {
                businessDays = 5;
            }

            const date = new Date();
            let added = 0;
            while (added < businessDays) {
                date.setDate(date.getDate() + 1);
                const day = date.getDay();
                if (day !== 0 && day !== 6) added++;
            }
            return date.toISOString().split('T')[0];
        },

        // Uses ProductColors from utils.js for color lookups
        getItemImageHtml(item) {
            const colorStyle = typeof ProductColors !== 'undefined' ? ProductColors.getProductStyle(item) : null;

            // escAttr() provided by utils.js
            if (item.image_url) {
                if (colorStyle) {
                    return `<img src="${escAttr(item.image_url)}" alt="${escAttr(item.name)}" loading="lazy"
                                data-fallback="color-block">
                            <div class="confirmation-item__color-block" style="display: none; ${colorStyle} width: 100%; height: 100%; border-radius: 6px;"></div>`;
                } else {
                    return `<img src="${escAttr(item.image_url)}" alt="${escAttr(item.name)}" loading="lazy" data-fallback="placeholder-svg">`;
                }
            } else if (colorStyle) {
                return `<div class="confirmation-item__color-block" style="${colorStyle} width: 100%; height: 100%; border-radius: 6px;"></div>`;
            } else {
                return this.getPlaceholderSvg();
            }
        },

        renderOrderItems(items) {
            const itemsList = document.getElementById('order-items');
            if (!itemsList) return;

            itemsList.innerHTML = items.map(item => {
                // Create image HTML - use actual product image, color block, or placeholder
                const imageHtml = this.getItemImageHtml(item);

                // Build meta info
                const metaParts = [];
                if (item.sku) metaParts.push(`<span>SKU: ${item.sku}</span>`);
                if (item.brand) metaParts.push(`<span>${item.brand}</span>`);
                if (item.source) metaParts.push(`<span class="badge badge--${item.source === 'genuine' ? 'primary' : 'secondary'}">${item.source === 'genuine' ? 'Genuine' : 'Compatible'}</span>`);

                return `
                    <li class="confirmation-item">
                        <div class="confirmation-item__image">
                            ${imageHtml}
                        </div>
                        <div class="confirmation-item__details">
                            <h3 class="confirmation-item__title">${item.name}</h3>
                            <p class="confirmation-item__meta">${metaParts.join(' ') || 'N/A'}</p>
                        </div>
                        <div class="confirmation-item__quantity">Qty: ${item.quantity}</div>
                        <div class="confirmation-item__price">$${(item.price * item.quantity).toFixed(2)}</div>
                    </li>
                `;
            }).join('');

            // Bind image fallback handlers
            itemsList.querySelectorAll('img[data-fallback]').forEach(img => {
                img.addEventListener('error', function() {
                    if (this.dataset.fallback === 'color-block') {
                        this.style.display = 'none';
                        const sibling = this.nextElementSibling;
                        if (sibling) sibling.style.display = 'flex';
                    } else if (this.dataset.fallback === 'placeholder-svg') {
                        this.removeAttribute('data-fallback');
                        this.parentElement.innerHTML = ConfirmationPage.getPlaceholderSvg();
                    }
                }, { once: true });
            });
        },

        getPlaceholderSvg() {
            return `<svg width="60" height="60" viewBox="0 0 60 60" fill="none" aria-hidden="true">
                <rect width="60" height="60" rx="8" fill="#F3F4F6"/>
                <rect x="20" y="10" width="20" height="40" rx="3" stroke="#9CA3AF" stroke-width="2" fill="none"/>
                <rect x="25" y="35" width="10" height="10" fill="#9CA3AF"/>
            </svg>`;
        },

        renderTotals(order) {
            const subtotal = order.subtotal || order.items?.reduce((sum, item) => sum + (item.price * item.quantity), 0) || 0;
            const shippingCost = order.shippingCost || order.shipping_cost || 0;
            const total = order.total || (subtotal + shippingCost);

            // Update individual elements
            const subtotalEl = document.getElementById('totals-subtotal');
            const shippingEl = document.getElementById('totals-shipping');
            const totalEl = document.getElementById('totals-total');

            if (subtotalEl) {
                subtotalEl.textContent = `$${parseFloat(subtotal).toFixed(2)}`;
            }

            if (shippingEl) {
                if (shippingCost === 0) {
                    shippingEl.innerHTML = '<span class="text-success">FREE</span>';
                } else {
                    shippingEl.textContent = `$${parseFloat(shippingCost).toFixed(2)}`;
                }
            }

            if (totalEl) {
                totalEl.textContent = `$${parseFloat(total).toFixed(2)} NZD`;
            }
        },

        showPaymentPendingBanner(status) {
            // Update header to reflect payment status
            const titleEl = document.querySelector('.confirmation-header__title');
            const messageEl = document.querySelector('.confirmation-header__message');
            const iconEl = document.querySelector('.confirmation-header__icon');
            const headerSecure = document.querySelector('.checkout-header__secure span');

            if (status === 'pending') {
                if (titleEl) titleEl.textContent = 'Payment Pending';
                if (messageEl) messageEl.innerHTML = 'Your order was created but <strong>payment has not been completed</strong>. Please return to checkout to complete your payment, or contact us if you need assistance.';
                if (headerSecure) headerSecure.textContent = 'Payment Pending';
            } else if (status === 'cancelled' || status === 'failed') {
                if (titleEl) titleEl.textContent = 'Payment Failed';
                if (messageEl) messageEl.innerHTML = 'Your payment could not be processed. Please <a href="/html/cart.html">return to your cart</a> and try again, or contact us for assistance.';
                if (headerSecure) headerSecure.textContent = 'Payment Failed';
            }

            // Swap the green checkmark icon for a warning icon
            if (iconEl && (status === 'pending' || status === 'cancelled' || status === 'failed')) {
                const color = status === 'pending' ? '#F59E0B' : '#EF4444';
                const bgColor = status === 'pending' ? '#FFFBEB' : '#FEF2F2';
                iconEl.innerHTML = `<svg width="80" height="80" viewBox="0 0 80 80" fill="none" aria-hidden="true">
                    <circle cx="40" cy="40" r="38" stroke="${color}" stroke-width="4" fill="${bgColor}"/>
                    <path d="M40 24V46" stroke="${color}" stroke-width="5" stroke-linecap="round"/>
                    <circle cx="40" cy="54" r="3" fill="${color}"/>
                </svg>`;
            }

            // Add a warning banner
            const banner = document.createElement('div');
            banner.className = 'payment-pending-banner';
            const isPending = status === 'pending';
            banner.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                    <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                </svg>
                <span><strong>${isPending ? 'Payment Pending' : 'Payment Failed'}</strong> — ${isPending
                    ? 'This order has not been paid yet. Please complete your payment to process the order.'
                    : 'Payment was not successful. Please try placing your order again.'}</span>
            `;
            document.querySelector('.confirmation-content')?.prepend(banner);
        },

        showTestModeBanner() {
            const banner = document.createElement('div');
            banner.className = 'test-mode-banner';
            banner.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                    <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                </svg>
                <span><strong>Test Order</strong> - This order was placed in test mode. No actual payment was processed.</span>
            `;
            document.querySelector('.confirmation-content')?.prepend(banner);
        },

        formatRegion(region) {
            if (!region) return '';
            // Convert slug back to display name
            const regionMap = {
                'northland': 'Northland',
                'auckland': 'Auckland',
                'waikato': 'Waikato',
                'bay-of-plenty': 'Bay of Plenty',
                'gisborne': 'Gisborne',
                'hawkes-bay': "Hawke's Bay",
                'taranaki': 'Taranaki',
                'manawatu-wanganui': 'Manawatu-Whanganui',
                'wellington': 'Wellington',
                'tasman': 'Tasman',
                'nelson': 'Nelson',
                'marlborough': 'Marlborough',
                'west-coast': 'West Coast',
                'canterbury': 'Canterbury',
                'otago': 'Otago',
                'southland': 'Southland'
            };
            return regionMap[region.toLowerCase()] || region;
        }
    };

    // Initialize on page load
    document.addEventListener('DOMContentLoaded', () => {
        ConfirmationPage.init();

        // Show account creation prompt for guest users
        if (typeof Auth !== 'undefined') {
            Auth.readyPromise.then(() => {
                if (!Auth.isAuthenticated()) {
                    const prompt = document.getElementById('create-account-prompt');
                    if (prompt) prompt.hidden = false;
                }
            });
        }
    });
