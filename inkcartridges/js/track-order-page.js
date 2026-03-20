    const TrackOrderPage = {

        async init() {
            // Auth guard
            if (typeof Auth !== 'undefined' && !Auth.initialized) {
                const maxWait = 3000;
                let waited = 0;
                while (!Auth.initialized && waited < maxWait) {
                    await new Promise(r => setTimeout(r, 50));
                    waited += 50;
                }
            }

            if (typeof Auth === 'undefined' || !Auth.isAuthenticated()) {
                window.location.href = '/html/account/login.html?redirect=' + encodeURIComponent(window.location.pathname);
                return;
            }

            const accountEl = document.querySelector('.account-page');
            if (accountEl) accountEl.classList.add('auth-ready');

            // Load recent orders
            this.loadRecentOrders();

            // Auto-load from URL param
            const params = new URLSearchParams(window.location.search);
            const orderParam = params.get('order');
            if (orderParam) {
                const input = document.getElementById('order-number');
                if (input) input.value = orderParam;
                this.loadTracking(orderParam);
            }

            // Form submit
            document.getElementById('track-order-form')?.addEventListener('submit', (e) => {
                e.preventDefault();
                const orderNumber = document.getElementById('order-number').value.trim();
                if (orderNumber) this.loadTracking(orderNumber);
            });
        },

        async loadRecentOrders() {
            const container = document.getElementById('recent-orders-list');
            if (!container) return;

            container.innerHTML = '<p class="text-muted" style="padding: 0.5rem 0;">Loading recent orders…</p>';

            try {
                const response = await API.getRecentTracking();
                if (response.ok && response.data?.orders) {
                    this.renderRecentOrders(response.data.orders);
                } else {
                    container.innerHTML = '';
                }
            } catch (err) {
                container.innerHTML = '';
            }
        },

        renderRecentOrders(orders) {
            const container = document.getElementById('recent-orders-list');
            if (!container) return;

            if (!orders.length) {
                container.innerHTML = '<p class="text-muted">No recent orders to display.</p>';
                return;
            }

            const esc = Security.escapeHtml;
            const rows = orders.map(order => {
                const date = new Date(order.created_at).toLocaleDateString('en-NZ', {
                    day: 'numeric', month: 'short', year: 'numeric'
                });
                const trackBtn = order.has_tracking
                    ? `<button class="btn btn--sm btn--secondary recent-order-track-btn" data-order="${esc(order.order_number)}">Track</button>`
                    : '';
                return `
                    <div class="recent-order-row">
                        <div class="recent-order-row__main">
                            <button class="recent-order-row__number" data-order="${esc(order.order_number)}">${esc(order.order_number)}</button>
                            <span class="order-status-badge order-status-badge--${esc(order.status)}">${esc(order.status_label)}</span>
                            <span class="recent-order-row__date">${date}</span>
                        </div>
                        <div class="recent-order-row__actions">
                            <span class="recent-order-row__total">${formatPrice(order.total)}</span>
                            ${trackBtn}
                        </div>
                    </div>
                `;
            }).join('');

            container.innerHTML = rows;

            container.querySelectorAll('[data-order]').forEach(btn => {
                btn.addEventListener('click', () => {
                    const num = btn.dataset.order;
                    const input = document.getElementById('order-number');
                    if (input) input.value = num;
                    this.loadTracking(num);
                });
            });
        },

        async loadTracking(orderNumber) {
            const resultEl = document.getElementById('tracking-result');
            if (!resultEl) return;

            resultEl.style.display = 'block';
            resultEl.innerHTML = '<p class="text-muted" style="padding: 1rem 0;">Loading tracking…</p>';

            try {
                const response = await API.getOrderTracking(orderNumber);
                if (response.ok && response.data) {
                    this.renderTracking(response.data);
                } else {
                    const msg = response.error?.message || 'Order not found.';
                    resultEl.innerHTML = `<div class="tracking-detail tracking-detail--error"><p>${Security.escapeHtml(msg)}</p></div>`;
                }
            } catch (err) {
                resultEl.innerHTML = `<div class="tracking-detail tracking-detail--error"><p>Could not load tracking information.</p></div>`;
            }
        },

        renderTracking(data) {
            const resultEl = document.getElementById('tracking-result');
            if (!resultEl) return;

            const esc = Security.escapeHtml;
            const isCancelled = data.status === 'cancelled';

            // Timeline HTML
            const timelineHtml = this.buildTimelineHtml(data.timeline, isCancelled);

            // Tracking info
            let trackingInfoHtml = '';
            if (data.tracking_number) {
                trackingInfoHtml += `
                    <div class="tracking-info-row">
                        <span class="tracking-info-label">Tracking Number</span>
                        <span class="tracking-info-value">${esc(data.tracking_number)}</span>
                    </div>
                `;
            }
            if (data.carrier) {
                trackingInfoHtml += `
                    <div class="tracking-info-row">
                        <span class="tracking-info-label">Carrier</span>
                        <span class="tracking-info-value">${esc(data.carrier)}</span>
                    </div>
                `;
            }
            if (data.estimated_delivery) {
                const estDate = new Date(data.estimated_delivery + 'T00:00:00').toLocaleDateString('en-NZ', {
                    day: 'numeric', month: 'short', year: 'numeric'
                });
                trackingInfoHtml += `
                    <div class="tracking-info-row">
                        <span class="tracking-info-label">Est. Delivery</span>
                        <span class="tracking-info-value">${estDate}</span>
                    </div>
                `;
            }

            // Tracking events or fallback
            let eventsHtml = '';
            if (data.tracking_events && data.tracking_events.length) {
                // Show newest first
                const events = [...data.tracking_events].reverse();
                const eventItems = events.map(ev => {
                    const evDate = ev.date
                        ? new Date(ev.date).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' })
                        : '';
                    const location = ev.location ? ` — ${esc(ev.location)}` : '';
                    return `
                        <div class="tracking-event">
                            <div class="tracking-event__dot"></div>
                            <div class="tracking-event__body">
                                <span class="tracking-event__label">${esc(ev.event)}${location}</span>
                                ${evDate ? `<span class="tracking-event__date">${evDate}</span>` : ''}
                            </div>
                        </div>
                    `;
                }).join('');
                eventsHtml = `
                    <div class="tracking-events">
                        <h3 class="tracking-events__heading">Live Tracking</h3>
                        ${eventItems}
                    </div>
                `;
            } else if (data.status === 'shipped' && data.tracking_number && data.tracking_url) {
                eventsHtml = `
                    <div class="tracking-fallback">
                        <p>Live tracking data unavailable. <a href="${Security.escapeAttr(data.tracking_url)}" target="_blank" rel="noopener noreferrer">Track on NZ Post →</a></p>
                    </div>
                `;
            } else if (data.status !== 'shipped' && data.status !== 'completed' && data.status !== 'cancelled') {
                eventsHtml = `<p class="text-muted" style="margin-top: 1rem;">Your order hasn't shipped yet.</p>`;
            }

            resultEl.innerHTML = `
                <div class="tracking-detail">
                    <div class="tracking-detail__header">
                        <span class="tracking-detail__order-number">${esc(data.order_number)}</span>
                        <span class="order-status-badge order-status-badge--${esc(data.status)}">${esc(data.status_label)}</span>
                    </div>
                    ${timelineHtml}
                    ${trackingInfoHtml ? `<div class="tracking-info">${trackingInfoHtml}</div>` : ''}
                    ${eventsHtml}
                </div>
            `;
        },

        buildTimelineHtml(timeline, isCancelled) {
            if (!timeline || !timeline.length) return '';

            const steps = timeline.map(step => {
                const cls = isCancelled && step.step === 'cancelled'
                    ? 'timeline-step timeline-step--completed timeline-step--cancelled'
                    : step.completed
                        ? 'timeline-step timeline-step--completed'
                        : 'timeline-step';
                const dateStr = step.date
                    ? new Date(step.date).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short' })
                    : '';
                return `
                    <div class="${cls}">
                        <div class="timeline-step__dot"></div>
                        <div class="timeline-step__label">${Security.escapeHtml(step.label)}</div>
                        ${dateStr ? `<div class="timeline-step__date">${dateStr}</div>` : ''}
                    </div>
                `;
            }).join('');

            return `<div class="order-timeline">${steps}</div>`;
        }
    };

    document.addEventListener('DOMContentLoaded', () => {
        TrackOrderPage.init();
    });
