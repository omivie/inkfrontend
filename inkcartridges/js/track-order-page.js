/**
 * TRACK-ORDER-PAGE.JS — customer tracking REQUEST controller (May 2026).
 *
 * Request-based tracking model
 * ============================
 * We deliberately no longer reveal tracking automatically. A customer submits
 * their order number (plus the email used to place the order) and we record a
 * request + notify the opted-in admins. An admin then enters the carrier,
 * tracking number, and status in the admin panel — that action is what emails
 * the customer their tracking details. So this page NEVER renders a tracking
 * number, carrier, timeline, or live events; it only confirms the request was
 * received.
 *
 * One controller, two mounts
 * ==========================
 *   • Public page  /track-order            — standalone, works logged-out.
 *   • Account page /account/track-order    — same form inside the account
 *                                            sidebar; auth-gated like its peers.
 * The account mount is detected by the presence of `.account-sidebar`. Only the
 * account mount redirects unauthenticated visitors to login — the public mount
 * is usable by anyone with an order number.
 *
 * When the visitor IS signed in we prefill their email and list their recent
 * orders, each with a one-click "Request tracking" button.
 *
 * Shared DOM contract (present on both pages):
 *   #track-order-form  #track-order-number  #track-email  #track-submit
 *   #track-result      #recent-orders-list (optional)
 */
(function () {
    const TrackOrderPage = {

        async init() {
            // Wait briefly for Auth to settle so prefill / recent-orders work.
            if (typeof Auth !== 'undefined' && !Auth.initialized) {
                const maxWait = 3000;
                let waited = 0;
                while (!Auth.initialized && waited < maxWait) {
                    await new Promise(r => setTimeout(r, 50));
                    waited += 50;
                }
            }

            const isAccountMount = !!document.querySelector('.account-sidebar');
            const authed = typeof Auth !== 'undefined' && Auth.isAuthenticated();

            // The account-embedded page is gated like its sibling account pages.
            // The public page is open to anyone holding an order number.
            if (isAccountMount && !authed) {
                window.location.href = '/account/login?redirect=' + encodeURIComponent(window.location.pathname);
                return;
            }

            const accountEl = document.querySelector('.account-page');
            if (accountEl) accountEl.classList.add('auth-ready');

            // Prefill the email for signed-in customers.
            if (authed && Auth.user?.email) {
                const emailInput = document.getElementById('track-email');
                if (emailInput && !emailInput.value) emailInput.value = Auth.user.email;
            }

            // Recent orders (signed-in only — fetch fails open when logged out).
            if (authed) {
                this.loadRecentOrders();
            } else {
                const recent = document.getElementById('recent-orders-section');
                if (recent) recent.hidden = true;
            }

            // Deep link: /track-order?order=ORD-... prefills the field.
            const params = new URLSearchParams(window.location.search);
            const orderParam = params.get('order');
            if (orderParam) {
                const input = document.getElementById('track-order-number');
                if (input) input.value = orderParam;
            }

            const form = document.getElementById('track-order-form');
            if (form) {
                form.addEventListener('submit', (e) => {
                    e.preventDefault();
                    this.submitRequest(
                        document.getElementById('track-order-number')?.value.trim(),
                        document.getElementById('track-email')?.value.trim()
                    );
                });
            }
        },

        async loadRecentOrders() {
            const container = document.getElementById('recent-orders-list');
            const section = document.getElementById('recent-orders-section');
            if (!container) return;

            container.innerHTML = '<p class="text-muted" style="padding: 0.5rem 0;">Loading recent orders…</p>';

            try {
                const response = await API.getRecentTracking();
                if (response.ok && response.data?.orders?.length) {
                    if (section) section.hidden = false;
                    this.renderRecentOrders(response.data.orders);
                } else {
                    if (section) section.hidden = true;
                }
            } catch (err) {
                if (section) section.hidden = true;
            }
        },

        renderRecentOrders(orders) {
            const container = document.getElementById('recent-orders-list');
            if (!container) return;

            const esc = Security.escapeHtml;
            const rows = orders.map(order => {
                const date = new Date(order.created_at).toLocaleDateString('en-NZ', {
                    day: 'numeric', month: 'short', year: 'numeric'
                });
                return `
                    <div class="recent-order-row">
                        <div class="recent-order-row__main">
                            <span class="recent-order-row__number">${esc(order.order_number)}</span>
                            <span class="order-status-badge order-status-badge--${esc(order.status)}">${esc(order.status_label || order.status)}</span>
                            <span class="recent-order-row__date">${date}</span>
                        </div>
                        <div class="recent-order-row__actions">
                            <span class="recent-order-row__total">${typeof formatPrice === 'function' ? formatPrice(order.total) : ''}</span>
                            <button type="button" class="btn btn--sm btn--secondary recent-order-track-btn" data-order="${esc(order.order_number)}">Request tracking</button>
                        </div>
                    </div>
                `;
            }).join('');

            container.innerHTML = rows;

            container.querySelectorAll('.recent-order-track-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const num = btn.dataset.order;
                    const input = document.getElementById('track-order-number');
                    if (input) input.value = num;
                    const email = document.getElementById('track-email')?.value.trim();
                    this.submitRequest(num, email);
                    // Bring the result into view on the (often long) account page.
                    document.getElementById('track-result')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                });
            });
        },

        showResult(html, variant) {
            const el = document.getElementById('track-result');
            if (!el) return;
            el.hidden = false;
            el.className = 'track-result' + (variant ? ` track-result--${variant}` : '');
            el.innerHTML = html;
        },

        setSubmitting(busy) {
            const btn = document.getElementById('track-submit');
            if (!btn) return;
            btn.disabled = busy;
            btn.classList.toggle('is-loading', busy);
            // Preserve innerHTML (the SVG icon), not just textContent, so the
            // button doesn't lose its icon after the first submit.
            if (busy) {
                if (btn._originalHtml == null) btn._originalHtml = btn.innerHTML;
                btn.textContent = 'Sending request…';
            } else if (btn._originalHtml != null) {
                btn.innerHTML = btn._originalHtml;
                btn._originalHtml = null;
            }
        },

        async submitRequest(orderNumber, email) {
            const esc = Security.escapeHtml;

            if (!orderNumber) {
                this.showResult('<p>Please enter your order number so we can find your delivery.</p>', 'error');
                document.getElementById('track-order-number')?.focus();
                return;
            }

            // Email is mandatory when we can't infer it from a session — it's how
            // the team confirms ownership and where the tracking reply is sent.
            const authed = typeof Auth !== 'undefined' && Auth.isAuthenticated();
            if (!email && !authed) {
                this.showResult('<p>Please enter the email address you used to place the order.</p>', 'error');
                document.getElementById('track-email')?.focus();
                return;
            }

            this.setSubmitting(true);
            this.showResult('<p class="text-muted">Sending your request…</p>', null);

            try {
                const response = await API.requestOrderTracking({ order_number: orderNumber, email });

                if (response.ok) {
                    const dest = email || (authed && Auth.user?.email) || 'the email on your order';
                    this.showResult(`
                        <div class="track-result__icon" aria-hidden="true">
                            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                        </div>
                        <h3 class="track-result__title">Request received</h3>
                        <p>Thanks — we've passed your request to our dispatch team for order
                        <strong>${esc(orderNumber)}</strong>. We'll email your tracking number and
                        delivery status to <strong>${esc(dest)}</strong>, usually within one business day.</p>
                        <p class="text-muted">Didn't get it? Check your spam folder or
                        <a href="/contact">contact us</a> and we'll help right away.</p>
                    `, 'success');
                    const form = document.getElementById('track-order-form');
                    if (form) form.reset();
                    // Re-prefill email after reset for signed-in customers.
                    if (authed && Auth.user?.email) {
                        const emailInput = document.getElementById('track-email');
                        if (emailInput) emailInput.value = Auth.user.email;
                    }
                } else if (response.code === 'RATE_LIMITED') {
                    this.showResult('<p>You\'ve sent a few requests in a short time. Please wait a minute and try again.</p>', 'error');
                } else {
                    const msg = (typeof API.extractErrorMessage === 'function')
                        ? API.extractErrorMessage(response)
                        : (response.error || 'We couldn\'t submit your request.');
                    this.showResult(`<p>${esc(msg)} Please try again, or <a href="/contact">contact us</a>.</p>`, 'error');
                }
            } catch (err) {
                this.showResult('<p>We couldn\'t reach the server. Please check your connection and try again, or <a href="/contact">contact us</a>.</p>', 'error');
            } finally {
                this.setSubmitting(false);
            }
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => TrackOrderPage.init());
    } else {
        TrackOrderPage.init();
    }
})();
