/**
 * TRACK-ORDER-PAGE.JS — customer INLINE tracking controller (Jun 2026).
 *
 * Inline-tracking model
 * =====================
 * The customer enters their order number + the email used at checkout and we
 * look the order up via POST /api/orders/track-lookup, then render the result
 * RIGHT ON THE PAGE: a status badge, a progress timeline (Order placed →
 * Processing → Shipped → Delivered), the tracking number + carrier + estimated
 * delivery, a "Track with {carrier}" link, and the live courier scan history.
 *
 * This supersedes the May-2026 request-only model (where the page only queued an
 * email and showed "we'll reply within one business day"). We still keep that
 * email path as a FALLBACK: when a lookup succeeds but the order hasn't shipped
 * yet (tracking_number === null) we quietly fire POST /api/orders/track-request
 * so the customer is emailed the moment it dispatches and the admin Tracking
 * Requests queue is fed. See API.trackLookup / API.requestOrderTracking.
 *
 * Anti-enumeration: the backend returns the SAME generic 404 for "no such
 * order" AND "email doesn't match", so a stranger guessing order numbers learns
 * nothing. We surface that message verbatim and NEVER reveal which field failed.
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
 * orders, each with a one-click "Track order" button.
 *
 * Shared DOM contract (present on both pages):
 *   #track-order-form  #track-order-number  #track-email  #track-submit
 *   #track-result      #recent-orders-list (optional)
 */
(function () {
    // Format a YYYY-MM-DD or ISO date for display; '' for null/invalid input so
    // callers can conditionally omit the surrounding element.
    function fmtDate(x) {
        if (!x) return '';
        const d = new Date(x);
        if (isNaN(d.getTime())) return '';
        return d.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' });
    }

    // Carrier scan timestamps carry a time component worth showing.
    function fmtDateTime(x) {
        if (!x) return '';
        const d = new Date(x);
        if (isNaN(d.getTime())) return '';
        return d.toLocaleString('en-NZ', {
            day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
        });
    }

    const TrackOrderPage = {

        // Re-running a lookup (the "Check again" button / recent-order clicks)
        // reuses these. _lastRefreshAt debounces the refresh against the
        // backend's 15-requests/15-minutes-per-IP rate limit.
        _lastQuery: null,
        _lastRefreshAt: 0,
        REFRESH_MIN_GAP_MS: 8000,

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
                    this.submitLookup(
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
                const date = fmtDate(order.created_at);
                return `
                    <div class="recent-order-row">
                        <div class="recent-order-row__main">
                            <span class="recent-order-row__number">${esc(order.order_number)}</span>
                            <span class="order-status-badge order-status-badge--${esc(order.status)}">${esc(order.status_label || order.status)}</span>
                            ${date ? `<span class="recent-order-row__date">${esc(date)}</span>` : ''}
                        </div>
                        <div class="recent-order-row__actions">
                            <span class="recent-order-row__total">${typeof formatPrice === 'function' ? formatPrice(order.total) : ''}</span>
                            <button type="button" class="btn btn--sm btn--secondary recent-order-track-btn" data-order="${esc(order.order_number)}">Track order</button>
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
                    this.submitLookup(num, email);
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

        setSubmitting(busy, label) {
            const btn = document.getElementById('track-submit');
            if (!btn) return;
            btn.disabled = busy;
            btn.classList.toggle('is-loading', busy);
            // Preserve innerHTML (the SVG icon), not just textContent, so the
            // button doesn't lose its icon after the first submit.
            if (busy) {
                if (btn._originalHtml == null) btn._originalHtml = btn.innerHTML;
                btn.textContent = label || 'Checking…';
            } else if (btn._originalHtml != null) {
                btn.innerHTML = btn._originalHtml;
                btn._originalHtml = null;
            }
        },

        /**
         * Validate inputs and look the order up. Renders the tracking card on
         * success and a friendly inline message on every documented failure.
         * The form is always left in place so the customer can correct + retry.
         */
        async submitLookup(orderNumber, email) {
            const esc = Security.escapeHtml;

            if (!orderNumber) {
                this.showResult('<p>Please enter your order number so we can find your delivery.</p>', 'error');
                document.getElementById('track-order-number')?.focus();
                return;
            }

            // Email is mandatory — it's how the backend confirms ownership (the
            // lookup is matched on order number + email). For signed-in customers
            // we fall back to the session email so a valid one is always sent
            // even if the visible field was cleared.
            const authed = typeof Auth !== 'undefined' && Auth.isAuthenticated();
            const effectiveEmail = email || (authed && Auth.user?.email) || '';
            if (!effectiveEmail) {
                this.showResult('<p>Please enter the email address you used to place the order.</p>', 'error');
                document.getElementById('track-email')?.focus();
                return;
            }

            // Remember the query so "Check again" can re-run the same lookup.
            this._lastQuery = { order_number: orderNumber, email: effectiveEmail };

            this.setSubmitting(true, 'Checking…');
            this.showResult('<p class="text-muted">Looking up your order…</p>', null);

            try {
                const response = await API.trackLookup({ order_number: orderNumber, email: effectiveEmail });

                if (response.ok && response.data) {
                    this.renderTracking(response.data, effectiveEmail);
                } else if (response.code === 'RATE_LIMITED') {
                    this.showResult('<p>You\'ve checked a few times in quick succession. Please wait a minute and try again.</p>', 'error');
                } else if (response.code === 'VALIDATION_FAILED') {
                    // Malformed order number / email. Lead with a friendly line;
                    // append the backend's per-field hints when present.
                    const detail = Array.isArray(response.details) && response.details.length
                        ? ' ' + response.details.map(d => esc(d && d.message)).filter(Boolean).join(' ')
                        : '';
                    this.showResult(`<p>Please double-check your order number and the email you used to place the order, then try again. Your order number is in your confirmation email.${detail}</p>`, 'error');
                } else if (response.code === 'NOT_FOUND') {
                    // Anti-enumeration: the backend returns one generic message
                    // whether the order is missing or the email mismatches. Show
                    // it verbatim — NEVER reveal which field failed.
                    const msg = esc(response.error || 'We couldn\'t find an order matching those details. Double-check your order number and the email you used at checkout.');
                    this.showResult(`<p>${msg}</p><p class="text-muted">Still stuck? <a href="/contact">Contact us</a> and we'll look it up for you.</p>`, 'error');
                } else {
                    const fallback = (typeof API.extractErrorMessage === 'function')
                        ? API.extractErrorMessage(response, 'We couldn\'t look up your order.')
                        : (response.error || 'We couldn\'t look up your order.');
                    this.showResult(`<p>${esc(fallback)} Please try again, or <a href="/contact">contact us</a>.</p>`, 'error');
                }
            } catch (err) {
                this.showResult('<p>We couldn\'t reach the server. Please check your connection and try again, or <a href="/contact">contact us</a>.</p>', 'error');
            } finally {
                this.setSubmitting(false);
            }
        },

        /**
         * Render the tracking detail card from a successful lookup payload.
         * Every field is treated defensively — the timeline length varies
         * (5 normal, 4 for Net-30, [placed, cancelled] when cancelled) and
         * tracking_number / tracking_url / carrier / events may all be null.
         */
        renderTracking(data, email) {
            const esc = Security.escapeHtml;
            const status = data.status || 'pending';
            const statusLabel = data.status_label || status;
            const notShipped = data.tracking_number == null;
            const orderNumber = data.order_number || this._lastQuery?.order_number || '';

            const html = `
                <div class="tracking-detail">
                    <div class="tracking-detail__header">
                        <span class="tracking-detail__order-number">${esc(orderNumber)}</span>
                        <span class="order-status-badge order-status-badge--${esc(status)}">${esc(statusLabel)}</span>
                    </div>
                    ${this.buildTimeline(data.timeline)}
                    ${notShipped ? this.buildNotShippedNote() : ''}
                    ${this.buildInfoRows(data)}
                    ${this.buildTrackButton(data)}
                    ${this.buildEvents(data.tracking_events)}
                    ${this.buildRefreshRow()}
                </div>
            `;
            this.showResult(html, 'tracking');

            // Not shipped yet → register a notify-me in the background so the
            // customer is emailed on dispatch and the admin queue is fed. Its
            // body is intentionally ignored (always a generic 200).
            if (notShipped && orderNumber) {
                API.requestOrderTracking({ order_number: orderNumber, email }).catch(() => {});
            }

            this.bindRefresh();
            document.getElementById('track-result')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        },

        // Progress stepper. Map over the array — never hardcode the step count.
        buildTimeline(timeline) {
            if (!Array.isArray(timeline) || !timeline.length) return '';
            const esc = Security.escapeHtml;
            const steps = timeline.map(step => {
                const cancelled = step && step.step === 'cancelled';
                const mod = cancelled ? ' timeline-step--cancelled'
                    : (step && step.completed) ? ' timeline-step--completed' : '';
                const date = fmtDate(step && step.date);
                return `
                    <div class="timeline-step${mod}">
                        <span class="timeline-step__dot"></span>
                        <span class="timeline-step__label">${esc((step && step.label) || '')}</span>
                        ${date ? `<span class="timeline-step__date">${esc(date)}</span>` : ''}
                    </div>`;
            }).join('');
            return `<div class="order-timeline">${steps}</div>`;
        },

        // Tracking number / carrier / ETA / shipped rows — only the present ones.
        buildInfoRows(data) {
            const esc = Security.escapeHtml;
            const rows = [];
            if (data.tracking_number) rows.push(this._infoRow('Tracking number', data.tracking_number));
            if (data.carrier) rows.push(this._infoRow('Carrier', data.carrier));
            const eta = fmtDate(data.estimated_delivery);
            if (eta) {
                rows.push(`<div class="tracking-info-row"><span class="tracking-info-label">Estimated delivery</span><span class="tracking-info-value tracking-info-value--eta">${esc(eta)}</span></div>`);
            }
            const shipped = fmtDate(data.shipped_at);
            if (shipped) rows.push(this._infoRow('Shipped', shipped));
            return rows.length ? `<div class="tracking-info">${rows.join('')}</div>` : '';
        },

        _infoRow(label, value) {
            const esc = Security.escapeHtml;
            return `<div class="tracking-info-row"><span class="tracking-info-label">${esc(label)}</span><span class="tracking-info-value">${esc(value)}</span></div>`;
        },

        // "Track with {carrier}" — only when a usable tracking_url is present.
        buildTrackButton(data) {
            if (!data.tracking_url) return '';
            const href = Security.sanitizeUrl(data.tracking_url);
            if (!href || href === '#') return ''; // rejected (e.g. javascript:) — don't render a dead link
            const carrier = data.carrier ? Security.escapeHtml(data.carrier) : 'the carrier';
            return `<p class="tracking-cta"><a class="btn btn--primary" href="${Security.escapeAttr(href)}" target="_blank" rel="noopener noreferrer">Track with ${carrier}</a></p>`;
        },

        // Live courier scans. Backend lists newest-first; render in array order.
        buildEvents(events) {
            if (!Array.isArray(events) || !events.length) return '';
            const esc = Security.escapeHtml;
            const items = events.map(ev => {
                const label = esc((ev && ev.status) || '');
                const loc = ev && ev.location ? ` · ${esc(ev.location)}` : '';
                const when = fmtDateTime(ev && ev.timestamp);
                if (!label && !loc && !when) return '';
                return `
                    <div class="tracking-event">
                        <span class="tracking-event__dot"></span>
                        <div class="tracking-event__body">
                            <span class="tracking-event__label">${label}${loc}</span>
                            ${when ? `<span class="tracking-event__date">${esc(when)}</span>` : ''}
                        </div>
                    </div>`;
            }).join('');
            if (!items.trim()) return '';
            return `<div class="tracking-events"><h4 class="tracking-events__heading">Tracking history</h4>${items}</div>`;
        },

        buildNotShippedNote() {
            return '<p class="tracking-note">Not shipped yet — we\'ll email you the moment it\'s on its way.</p>';
        },

        buildRefreshRow() {
            return '<div class="tracking-refresh"><button type="button" id="track-refresh" class="btn btn--sm btn--secondary">Check again</button></div>';
        },

        // Debounced re-lookup so a customer mashing "Check again" can't trip the
        // 15-requests/15-minutes-per-IP limit.
        bindRefresh() {
            const btn = document.getElementById('track-refresh');
            if (!btn) return;
            btn.addEventListener('click', () => {
                const now = Date.now();
                const since = now - this._lastRefreshAt;
                if (this._lastRefreshAt && since < this.REFRESH_MIN_GAP_MS) {
                    const wait = Math.ceil((this.REFRESH_MIN_GAP_MS - since) / 1000);
                    btn.textContent = `Please wait ${wait}s…`;
                    return;
                }
                this._lastRefreshAt = now;
                if (this._lastQuery) {
                    this.submitLookup(this._lastQuery.order_number, this._lastQuery.email);
                }
            });
        }
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => TrackOrderPage.init());
    } else {
        TrackOrderPage.init();
    }
})();
