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

            // Try the detail endpoint first
            try {
                const response = await API.getOrder(orderNumber);
                if (response.ok && response.data) {
                    order = response.data;
                    DebugLog.log('Order loaded from API');
                }
            } catch (error) {
                DebugLog.log('Could not load from API:', error.message);
            }

            // Fallback: backend detail endpoint rejects legacy order numbers whose
            // characters don't match its stricter regex (e.g. ORD-...I-...). The
            // list endpoint is more permissive, so scan recent orders for a match.
            if (!order) {
                try {
                    const listResponse = await API.getOrders({ limit: 100 });
                    const list = listResponse?.data?.orders || listResponse?.data || [];
                    const match = Array.isArray(list)
                        ? list.find(o => o && o.order_number === orderNumber)
                        : null;
                    if (match) {
                        order = match;
                        DebugLog.log('Order loaded via list fallback');
                    }
                } catch (error) {
                    DebugLog.log('List fallback failed:', error.message);
                }
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

            // Tracking-on-demand (May 2026): the order timeline / shipment
            // progress is NEVER rendered automatically on the order-detail
            // page. Customers request tracking via /account/track-order — see
            // tests/tracking-on-demand-may2026.test.js + project_tracking_on_demand_may2026.md.
            // The status badge above stays (it's order-level metadata, not a
            // step-by-step shipment progression).

            // Render items
            const itemsContainer = document.querySelector('.order-items');
            if (itemsContainer) {
                // esc() provided by utils.js
                const escAttr = typeof Security !== 'undefined' ? Security.escapeAttr : (s) => s;
                const items = order.order_items || [];
                itemsContainer.innerHTML = `
                    <h2>Items Ordered</h2>
                    <div class="order-items-list">
                        ${items.map(item => {
                            const rawImageUrl = item.product?.image_url || item.image_url || null;
                            const imageUrl = rawImageUrl && typeof storageUrl === 'function' ? storageUrl(rawImageUrl) : rawImageUrl;
                            // Stale-swatch fallback — for compatibles whose
                            // hand-uploaded swatch image is now out of date,
                            // fall through to the canonical color placeholder.
                            // Brand source via the one vocabulary (BrandSource,
                            // utils.js, ERR-157). Order lines carry `source`
                            // directly (verified live 2026-08-12); the old
                            // `/^compatible\b/i` on product_name was a second
                            // rule that disagreed with the badge two lines
                            // below, which used an UNANCHORED `.includes`.
                            const _isCompatibleLine = BrandSource.isCompatible(item);
                            const _swatchStale = typeof ProductColors !== 'undefined' && ProductColors.isPlaceholderSwatchImage(rawImageUrl) && _isCompatibleLine;
                            return `
                            <div class="order-item">
                                <div class="order-item__image">
                                    ${(imageUrl && !_swatchStale)
                                        ? `<img src="${escAttr(imageUrl)}" alt="${escAttr(item.product_name)}" data-fallback="placeholder">`
                                        : this.getColorPlaceholder(item.product_name, BrandSource.of(item), item.product?.color || item.color)
                                    }
                                </div>
                                <div class="order-item__details">
                                    ${BrandSource.badgeHTML(item)}
                                    <h3>${esc(item.product_name)}</h3>
                                    <p class="order-item__sku">SKU: ${esc(item.product_sku || 'N/A')}</p>
                                    <p class="order-item__qty">Qty: ${item.quantity} × ${formatPrice(item.unit_price)}</p>
                                </div>
                                <div class="order-item__price">${formatPrice(item.line_total || (item.unit_price * item.quantity))}</div>
                            </div>
                        `}).join('')}
                    </div>
                `;

                // Bind image error fallbacks
                if (typeof Products !== 'undefined' && Products.bindImageFallbacks) {
                    Products.bindImageFallbacks(itemsContainer);
                }
            }

            // Render summary
            //
            // Money comes from the ONE shared helper (js/order-totals.js), the
            // same array /order-confirmation and the receipt PDF walk, so the
            // three surfaces cannot disagree. See DEC-006.
            //
            // What this replaced (ERR-127): `order.subtotal || order.total`
            // printed the TOTAL under the "Subtotal" label whenever subtotal was
            // absent, there was no discount row at all, and GST was a hardcoded
            // "Included" literal. On any order with a loyalty redemption the
            // three visible figures did not add up.
            const summaryContainer = document.querySelector('.order-summary');
            if (summaryContainer) {
                const esc3 = typeof Security !== 'undefined' ? Security.escapeHtml : (s) => s;
                const email = order.customer_email || '';

                if (typeof OrderTotals === 'undefined') {
                    // order-totals.js is a defer script ahead of this one, so this
                    // is unreachable in practice. Fail LOUD rather than silently
                    // reverting to the wrong-subtotal arithmetic. Deliberately NOT
                    // an early return — the items, address and breadcrumb below
                    // are still worth rendering.
                    DebugLog.error('order-totals.js missing — cannot render the order summary');
                    summaryContainer.innerHTML = `
                        <h2>Order Summary</h2>
                        <p class="order-summary__error">We couldn't load this order's totals. Please refresh the page.</p>
                    `;
                } else {
                    this.renderSummary(summaryContainer, order, esc3, email);
                }
            }

            // Render shipping address
            const shippingContainer = document.querySelector('.order-shipping');
            if (shippingContainer) {
                const esc2 = typeof Security !== 'undefined' ? Security.escapeHtml : (s) => s;
                const addr = order.shipping_address || {};
                const name = addr.recipient_name || '';
                const phone = addr.phone || '';

                const parts = [
                    name ? `<strong>${esc2(name)}</strong>` : '',
                    phone ? esc2(phone) : '',
                    esc2(addr.address_line1 || ''),
                    addr.address_line2 ? esc2(addr.address_line2) : '',
                    addr.city && addr.region
                        ? `${esc2(addr.city)}, ${esc2(addr.region)} ${esc2(addr.postal_code || '')}`.trim()
                        : esc2(addr.city || addr.region || ''),
                    esc2(addr.country || 'New Zealand')
                ].filter(Boolean);

                shippingContainer.innerHTML = `
                    <h2>Shipping Address</h2>
                    <address>${parts.join('<br>')}</address>
                `;
            }

            // Return request (data-tracking-capture aug2026 §2.1)
            this.renderReturnRequest(order);

            // Update breadcrumb
            const breadcrumb = document.querySelector('.breadcrumb__item--current');
            if (breadcrumb) breadcrumb.textContent = `Order #${order.order_number}`;
        },

        /* ──────────────────────────────────────────────────────────────────
         * RETURN REQUEST
         *
         * There was no return surface on this site at all: `returns.html` is a
         * static policy page, and nothing anywhere called
         * POST /api/orders/:orderNumber/return-request. The backend's §2.1 added
         * `issue_type` and `printer_model` to an endpoint the frontend had never
         * once used, so the fields could not have collected anything.
         *
         * TWO QUESTIONS, NOT ONE (see API.createReturnRequest):
         *   reason      — the commercial why. Required.
         *   issue_type  — the technical why. Optional, and the field that makes
         *                 an issue RATE per (SKU × printer × supplier) real.
         * The supplier is never asked for; the server takes it from the order
         * line's own cost snapshot.
         *
         * NO DATE GATE, DELIBERATELY. It is tempting to hide this after 30 days,
         * and it would be wrong: legal-config.js states the rule in as many
         * words — "faulty / not-as-described returns are NEVER time-barred by the
         * 30-day window — that's a Consumer Guarantees Act §43 right which a
         * retailer cannot contract out of for consumer transactions". A form
         * that vanishes on day 31 would be this site telling a customer they
         * have no rights they in fact have. The gate is on ORDER STATE — you
         * cannot return an order that was never paid for or was cancelled.
         * ────────────────────────────────────────────────────────────────── */
        RETURNABLE_STATUSES: ['paid', 'processing', 'shipped', 'completed', 'delivered'],

        /**
         * The technical taxonomy, exactly as the backend enumerates it. Labels
         * are the customer's words; values are the contract's. A value that is
         * not on this list is rejected server-side, so the list is the single
         * definition on this page — never re-spelt inline.
         */
        ISSUE_TYPES: [
            ['not_recognised',  'The printer doesn’t recognise it'],
            ['print_quality',   'Poor print quality — streaks, faded, gaps'],
            ['leaking',         'It leaked'],
            ['dried_out',       'It arrived dried out or empty'],
            ['physical_damage', 'It arrived physically damaged'],
            ['wrong_item',      'The wrong item was sent'],
            ['missing_parts',   'Something was missing from the order'],
            ['other',           'Something else'],
        ],

        /**
         * The commercial reasons.
         *
         * ⚠️ Only `faulty` is confirmed against the live contract (it is the
         * value the backend's own handoff shows). The endpoint could not be
         * probed for the rest: POST /return-request is aggressively rate-limited
         * — it answers `429 RATE_LIMITED "Too many return requests. Please
         * contact support directly."` after very few attempts, deliberately, and
         * burning that limiter to enumerate an enum would have been a poor
         * trade. So a rejected value is not swallowed: submit() renders the
         * server's own `details` verbatim, which names the offending field, and
         * BF-055 asks the backend to confirm the list.
         */
        RETURN_REASONS: [
            ['faulty',          'It’s faulty or not working'],
            ['damaged',         'It arrived damaged'],
            ['wrong_item',      'I was sent the wrong item'],
            ['change_of_mind',  'I changed my mind (unopened)'],
            ['other',           'Another reason'],
        ],

        renderReturnRequest(order) {
            const host = document.getElementById('order-return');
            if (!host) return;

            const status = String(order?.status || '').toLowerCase();
            if (this.RETURNABLE_STATUSES.indexOf(status) === -1) {
                host.hidden = true;
                return;
            }

            const esc = typeof Security !== 'undefined' ? Security.escapeHtml : (x) => x;
            const escA = typeof Security !== 'undefined' ? Security.escapeAttr : (x) => x;

            // Prefill the printer from the order's own lines when §1.2 gave us
            // one. `printer_slug` is a slug; the customer's printer has a NAME.
            // De-slugging is a presentation convenience for a free-text box they
            // can correct — it is never sent as a slug, and never invented from
            // a brand or a compatibility list.
            const items = order.order_items || order.items || [];
            const slugs = [];
            items.forEach((it) => {
                const sl = it && (it.printer_slug || it.printer?.slug);
                if (sl && slugs.indexOf(sl) === -1) slugs.push(sl);
            });
            const prefill = slugs.length === 1 ? this.humaniseSlug(slugs[0]) : '';

            const opts = (list, placeholder) => [`<option value="">${esc(placeholder)}</option>`]
                .concat(list.map(([v, label]) => `<option value="${escA(v)}">${esc(label)}</option>`))
                .join('');

            host.hidden = false;
            host.innerHTML = `
                <h2>Something wrong with this order?</h2>
                <p class="order-return__intro">Tell us what happened and we’ll email you back with
                   what to do next. Faulty or incorrectly supplied items are covered for as long as is
                   reasonable under the Consumer Guarantees Act — there’s no cut-off on
                   asking. <a href="/returns">Read the returns policy</a>.</p>
                <form class="order-return__form" id="order-return-form" novalidate>
                    <div class="order-return__field">
                        <label for="return-reason">What’s the problem? <span aria-hidden="true">*</span></label>
                        <select id="return-reason" name="reason" required>
                            ${opts(this.RETURN_REASONS, 'Choose one…')}
                        </select>
                    </div>
                    <div class="order-return__field">
                        <label for="return-issue-type">What exactly went wrong? <small>Optional</small></label>
                        <select id="return-issue-type" name="issue_type">
                            ${opts(this.ISSUE_TYPES, 'Prefer not to say')}
                        </select>
                        <p class="order-return__hint">This is the single most useful thing you can tell
                           us — it’s how we spot a batch that fails on one printer model and
                           stop selling it.</p>
                    </div>
                    <div class="order-return__field">
                        <label for="return-printer-model">Which printer is it in? <small>Optional</small></label>
                        <input type="text" id="return-printer-model" name="printer_model" maxlength="120"
                               placeholder="e.g. Brother MFC-J5740DW" value="${escA(prefill)}">
                    </div>
                    <p class="order-return__error" id="return-error" hidden role="alert"></p>
                    <button type="submit" class="btn btn--primary" id="return-submit">Request a return</button>
                </form>`;

            const form = document.getElementById('order-return-form');
            if (form) form.addEventListener('submit', (e) => this.submitReturnRequest(e, order));
        },

        /**
         * "brother-mfc-j5740dw" -> "Brother MFC J5740DW". Presentation only —
         * this fills a free-text box the customer can correct, and the slug
         * itself is never sent.
         *
         * A token containing a digit is a model number and goes fully upper
         * ("j5740dw" -> "J5740DW"). A short token with no vowel is an acronym
         * ("mfc" -> "MFC", "hp" -> "HP"). Everything else is a word ("brother"
         * -> "Brother", "pro" -> "Pro").
         *
         * Length alone was the first rule and it was wrong twice: it printed
         * "J5740dw", which is not how any printer is labelled, and "PRO" for a
         * plain English word.
         */
        humaniseSlug(slug) {
            return String(slug || '')
                .split('-')
                .filter(Boolean)
                .map((w) => {
                    if (/\d/.test(w)) return w.toUpperCase();
                    if (w.length <= 4 && !/[aeiou]/.test(w)) return w.toUpperCase();
                    return w.charAt(0).toUpperCase() + w.slice(1);
                })
                .join(' ');
        },

        async submitReturnRequest(e, order) {
            e.preventDefault();
            const btn = document.getElementById('return-submit');
            const errEl = document.getElementById('return-error');
            const reason = (document.getElementById('return-reason') || {}).value || '';
            const issueType = (document.getElementById('return-issue-type') || {}).value || '';
            const printerModel = (document.getElementById('return-printer-model') || {}).value || '';

            const fail = (msg) => {
                if (!errEl) return;
                errEl.textContent = msg;
                errEl.hidden = false;
            };
            if (errEl) errEl.hidden = true;

            if (!reason) {
                fail('Please tell us what the problem is.');
                return;
            }
            if (!btn || btn.disabled) return;   // no double-submit into a rate limiter
            btn.disabled = true;
            btn.textContent = 'Sending…';

            let res = null;
            try {
                res = await API.createReturnRequest(order.order_number, {
                    reason,
                    issue_type: issueType,
                    printer_model: printerModel,
                });
            } catch (err) {
                DebugLog.warn('Return request failed:', err?.message);
            }

            if (res && res.ok) {
                const host = document.getElementById('order-return');
                if (host) {
                    host.innerHTML = `
                        <h2>Return requested</h2>
                        <p class="order-return__done">Thanks — we’ve logged it against order
                           #${(typeof Security !== 'undefined' ? Security.escapeHtml : (x) => x)(order.order_number)}
                           and we’ll email you with what to do next. You don’t need to send
                           anything back until we’ve replied.</p>`;
                }
                return;
            }

            btn.disabled = false;
            btn.textContent = 'Request a return';

            // The rate limiter on this route is real and deliberate, and it says
            // what to do instead. Passing that through beats a generic "try
            // again", which is advice that cannot work.
            const code = res?.error?.code;
            if (code === 'RATE_LIMITED') {
                fail('We’ve already had several return requests from this account recently. '
                   + 'Please email support@inkcartridges.co.nz with your order number and we’ll pick it up from there.');
                return;
            }
            if (code === 'UNAUTHORIZED') {
                fail('Please sign in again to request a return.');
                return;
            }
            // A validation failure names its own field — show that rather than
            // hiding it behind house copy, because the value we sent is the only
            // clue to what the server would accept instead.
            const detail = typeof API !== 'undefined' && typeof API.extractErrorMessage === 'function'
                ? API.extractErrorMessage(res, '')
                : '';
            fail(detail
                ? `We couldn’t send that request: ${detail}`
                : 'We couldn’t send that request just now. Please email support@inkcartridges.co.nz with your order number.');
        },

        /**
         * The money block. Every figure comes from OrderTotals.rows() — the same
         * array /order-confirmation and the receipt PDF walk (DEC-006). Nothing
         * here computes or substitutes a number.
         */
        renderSummary(summaryContainer, order, esc3, email) {
            const t = OrderTotals.normalise(order);

            // Consistency gate (the ERR-113 habit): if the rows cannot foot,
            // that is a payload problem. We still show the customer exactly
            // what they were charged — never a recomputed figure — but it is
            // loud to us instead of silently wrong on screen.
            if (t.footing.checkable && !t.footing.reconciles) {
                DebugLog.warn(
                    `order ${t.orderNumber}: summary does not foot — ` +
                    `expected ${t.footing.expected}, backend total ${t.total} (delta ${t.footing.delta})`
                );
            }

            const rowsHtml = OrderTotals.rows(t).map((r) => {
                const dtCls = r.kind === 'total' ? ' class="order-summary__total"' : '';
                let ddCls = '';
                if (r.kind === 'total') ddCls = ' class="order-summary__total"';
                else if (r.kind === 'negative') ddCls = ' class="order-summary__value--negative"';
                else if (r.kind === 'free') ddCls = ' class="order-summary__value--free"';
                else if (r.kind === 'points') ddCls = ' class="order-summary__value--points"';
                else if (r.kind === 'unknown') ddCls = ' class="order-summary__value--unknown"';
                return `<dt${dtCls}>${esc3(r.label)}</dt><dd${ddCls}>${esc3(r.value)}</dd>`;
            }).join('');

            const earned = OrderTotals.rows(t).find((r) => r.key === 'earned');
            const noteHtml = (earned && earned.note)
                ? `<p class="order-summary__note">${esc3(earned.note)}</p>`
                : '';

            summaryContainer.innerHTML = `
                <h2>Order Summary</h2>
                <dl class="order-summary__list">
                    ${email ? `<dt>Email</dt><dd>${esc3(email)}</dd>` : ''}
                    ${rowsHtml}
                </dl>
                ${noteHtml}
            `;

            // Receipt download — offered only when there is a real total and
            // real line items to put on it. A PDF full of em-dashes would look
            // authoritative and say nothing.
            const receiptBtn = document.getElementById('download-receipt-btn');
            if (receiptBtn && typeof OrderReceipt !== 'undefined') {
                if (t.total !== null && t.items.length > 0) {
                    receiptBtn.hidden = false;
                    OrderReceipt.attach(receiptBtn, () => this.orderData);
                } else {
                    receiptBtn.hidden = true;
                }
            }
        },

        // Tracking-on-demand (May 2026): renderTimeline() was removed. The
        // order-detail surface no longer paints a shipment-progress timeline;
        // customers request tracking via the /account/track-order form.
        // Pinned by tests/tracking-on-demand-may2026.test.js.

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

        getColorPlaceholder(productName, source, color) {
            // Genuine-no-color-tile invariant: when the order line is for a
            // genuine product with no image_url (e.g. the new genuine packs
            // that ship before the composite-image generator catches up),
            // never render a colored tile. Fall straight through to the
            // neutral cartridge SVG. Compatible items keep the color tile —
            // it helps customers recognize what they bought.
            // THIS GATE RUNS FIRST AND IS LOAD-BEARING — do not reorder.
            //
            // The test is "NOT PROVEN COMPATIBLE", not "has some other source"
            // (ERR-157). The old `source && source !== 'compatible'` let a line
            // with NO source at all fall through and paint a coloured tile —
            // the invariant held for proven-genuine rows and quietly failed for
            // unproven ones, which is the population it most needed to cover.
            // Callers pass BrandSource.of(item), so `source` here is already
            // 'genuine' | 'compatible' | null and never a raw payload value.
            if (source !== 'compatible') {
                return `<svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="6" y="2" width="12" height="20" rx="2"/><line x1="9" y1="6" x2="15" y2="6"/></svg>`;
            }

            // ONE colour vocabulary — ProductColors in js/utils.js (ERR-141).
            // This used to carry a private 7-word map scanned against the
            // product NAME and ignored the stored `color` entirely, so a
            // "…Tri-Colour" line matched nothing and a cartridge whose name
            // merely mentioned a printer in "Red" matched the wrong hue.
            // getProductStyle reads color_hex, then `color`, then falls back to
            // detectFromName — a strict superset of the loop it replaced.
            const style = (typeof ProductColors !== 'undefined')
                ? ProductColors.getProductStyle({ color, name: productName }, null)
                : null;
            if (style) {
                return `<div style="width: 60px; height: 60px; ${style} border-radius: 8px;"></div>`;
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
                        <a href="/account/orders" class="btn btn--primary">View All Orders</a>
                    </div>
                `;
            }
        }
    };

    document.addEventListener('DOMContentLoaded', () => {
        OrderDetailPage.init();
    });
