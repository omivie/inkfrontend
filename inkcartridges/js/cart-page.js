// Cart page entry point
//
// Responsibilities:
// 1. Track cart_viewed analytics event.
// 2. Auto-apply ?coupon=RECOVER... when arriving from a recovery email,
//    then strip the param so refreshes don't double-apply.

document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
        if (typeof CartAnalytics !== 'undefined') {
            CartAnalytics.trackCartViewed();
        }
    }, 500);

    autoApplyCouponFromUrl();
    initStickyCheckoutBar();
    initCouponForm();
    initLoyaltyControl();
    // Async and additive: a business account gets the promo field disabled with
    // its reason. Guests and retail shoppers fire no request and see no change.
    initBusinessCouponLock();
});

/**
 * Copy for the business-account coupon exclusion, used when the backend does
 * not supply its own. Module-level because three call sites need it: the
 * preview, the apply, and the ?coupon= recovery-link path.
 */
const B2B_COUPON_COPY = 'Business accounts get automatic volume pricing — promo codes can’t be combined. Your loyalty points still work.';

/**
 * True when a response is the business-account coupon exclusion.
 *
 * Two shapes, because the backend answers on two different channels:
 *   apply   -> 400 { code: 'B2B_COUPON_EXCLUDED' }  (an envelope from api.js,
 *              or a thrown Error carrying .code on any path api.js still
 *              throws — both are read, so neither can go dark)
 *   preview -> 200 { valid: false, reason: 'b2b_volume_pricing' }
 *
 * This is a RULE, not a bad code: the customer already has a better discount.
 * It must never reach setFailure(), which would attach a "try SAVE10 instead"
 * nudge for a code that also cannot be combined — one wasted attempt against an
 * endpoint that locks out, and a contradiction on screen.
 *
 * @param {object|Error|null} source
 * @returns {boolean}
 */
function isB2BCouponExcluded(source) {
    if (!source) return false;
    if (source.code === 'B2B_COUPON_EXCLUDED') return true;
    const data = source.data && typeof source.data === 'object' ? source.data : source;
    return !!data && data.reason === 'b2b_volume_pricing';
}

/**
 * The backend's own wording when it sent some, ours otherwise.
 * @param {object|Error|null} source
 * @returns {string}
 */
function b2bCouponText(source) {
    const data = source && source.data && typeof source.data === 'object' ? source.data : source;
    const msg = (data && data.message) || (source && source.error);
    return typeof msg === 'string' && msg.trim() ? msg.trim() : B2B_COUPON_COPY;
}

/**
 * mobile-parity-may2026 S3.1 — sticky checkout bar.
 *
 * Mirrors the PDP .sticky-atc pattern: an IntersectionObserver watches the
 * real "Proceed to Checkout" button inside the Order Summary. While that
 * button is off-screen (and the cart is non-empty), a fixed bottom bar slides
 * up carrying the live total + a checkout CTA. The CTA wears
 * `.cart-summary__checkout-btn`, so cart.js's existing delegation runs the
 * same stock/price validation before navigating. The total mirrors #cart-total
 * via a MutationObserver so it never drifts from the summary.
 */
function initStickyCheckoutBar() {
    const bar = document.getElementById('cart-sticky-bar');
    const realBtn = document.getElementById('checkout-btn');
    const totalEl = document.getElementById('cart-total');
    const stickyTotal = document.getElementById('cart-sticky-total');
    if (!bar || !realBtn) return;

    const cartHasItems = () => {
        if (typeof Cart !== 'undefined' && typeof Cart.getItemCount === 'function') {
            return Cart.getItemCount() > 0 || (Cart.hasServerPricing && Cart.hasServerPricing());
        }
        // Fallback: the summary button only renders when the cart has items.
        return realBtn.offsetParent !== null;
    };

    const setVisible = (show) => {
        const visible = show && cartHasItems();
        bar.classList.toggle('is-visible', visible);
        bar.setAttribute('aria-hidden', visible ? 'false' : 'true');
    };

    let lastShouldShow = false;
    const syncTotal = () => {
        if (stickyTotal && totalEl) stickyTotal.textContent = totalEl.textContent;
        // #cart-total mutates whenever the cart changes; re-gate so the bar
        // never lingers over a cart that was just emptied.
        if (!cartHasItems()) setVisible(false);
        else setVisible(lastShouldShow);
    };
    syncTotal();
    if (totalEl && stickyTotal && 'MutationObserver' in window) {
        new MutationObserver(syncTotal).observe(totalEl, { childList: true, characterData: true, subtree: true });
    }

    if ('IntersectionObserver' in window) {
        const io = new IntersectionObserver(([entry]) => {
            // Show the sticky bar only once the real button has scrolled away.
            lastShouldShow = !entry.isIntersecting;
            setVisible(lastShouldShow);
        }, { threshold: 0 });
        io.observe(realBtn);
    }
}

/**
 * mobile-parity-may2026 S3.2 — coupon entry UI.
 *
 * The apply/preview/remove API + ?coupon= auto-apply already shipped; this
 * wires the customer-facing input. Idle/blur previews the code (read-only,
 * surfaces the specific failure reason); submit applies it for real.
 */
function initCouponForm() {
    const form = document.getElementById('cart-coupon-form');
    const input = document.getElementById('cart-coupon-input');
    const feedback = document.getElementById('cart-coupon-feedback');
    if (!form || !input || typeof API === 'undefined') return;

    const setFeedback = (msg, kind) => {
        if (!feedback) return;
        feedback.textContent = msg || '';
        feedback.classList.remove('cart-coupon__feedback--ok', 'cart-coupon__feedback--err');
        if (kind === 'ok') feedback.classList.add('cart-coupon__feedback--ok');
        else if (kind === 'err') feedback.classList.add('cart-coupon__feedback--err');
    };

    /**
     * Failure feedback + the optional "try this instead" nudge
     * (traffic-conversion-jul2026 §5).
     *
     * The suggested code is rendered as a click-to-FILL button rather than
     * click-to-apply. Auto-submitting would spend one of the shopper's limited
     * coupon attempts without them asking, and the endpoint locks out after too
     * many invalid tries — one wasted attempt on a code they didn't choose is a
     * bad trade for one saved click.
     *
     * CouponSuggestion.pick() returns null for a rate-limited/locked response,
     * so the lockout can never carry a nudge even if a future backend adds one.
     */
    const setFailure = (msg, source) => {
        setFeedback(msg, 'err');
        if (!feedback || typeof CouponSuggestion === 'undefined') return;
        const suggestion = CouponSuggestion.pick(source);
        const text = suggestion && CouponSuggestion.text(suggestion);
        if (!text) return;

        // textContent above already escaped the message; build the nudge with
        // DOM nodes so the backend-supplied code/label can never inject markup.
        feedback.textContent = '';
        const parts = text.split(suggestion.code);
        feedback.appendChild(document.createTextNode(parts[0] || ''));
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cart-coupon__suggestion';
        btn.textContent = suggestion.code;
        btn.setAttribute('aria-label', `Use coupon code ${suggestion.code}`);
        btn.addEventListener('click', () => {
            input.value = suggestion.code;
            input.focus();
            setFeedback('', null);
        });
        feedback.appendChild(btn);
        feedback.appendChild(document.createTextNode(parts.slice(1).join(suggestion.code) || ''));
    };

    /**
     * True when the response is the coupon-attempt security lockout. Handled
     * separately because it must NEVER show a suggestion and its copy is about
     * waiting, not about the code. `COUPON_LOCKED` is the documented code;
     * `RATE_LIMITED` is what api.js normalises a bare 429 to.
     */
    const isLockout = (source) => {
        const code = source && source.code;
        return code === 'COUPON_LOCKED' || code === 'RATE_LIMITED';
    };

    const reasonText = (data) => {
        if (data && data.message) return data.message;
        switch (data && data.reason) {
            case 'minimum_order_required': return 'Add more to your cart to use this coupon.';
            case 'account_too_new': return 'This coupon isn’t available on your account yet.';
            case 'already_used': return 'This coupon has already been used.';
            case 'expired': return 'This coupon has expired.';
            default: return 'That coupon code isn’t valid.';
        }
    };

    let idleTimer = null;
    const preview = async () => {
        const code = input.value.trim();
        if (!code || !API.previewCoupon) { setFeedback('', null); return; }
        try {
            const res = await API.previewCoupon(code);
            const data = res && res.data;
            if (res && res.ok && data && data.valid) {
                const saved = data.discount_amount;
                setFeedback(
                    data.message || (saved && typeof formatPrice === 'function'
                        ? `Save ${formatPrice(saved)} when you apply.`
                        : 'Coupon looks good — tap Apply.'),
                    'ok'
                );
            } else if (isB2BCouponExcluded(res) || isB2BCouponExcluded(data)) {
                setFeedback(b2bCouponText(data), 'err');
            } else if (isLockout(res)) {
                setFeedback('Too many tries — wait a minute and retry.', 'err');
            } else {
                // Preview failure is HTTP 200 with data.valid === false, so the
                // suggestion rides on `data`, not on an error envelope.
                setFailure(reasonText(data), data);
            }
        } catch (_) { /* network — stay quiet until submit */ }
    };

    input.addEventListener('input', () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(preview, 600);
    });
    input.addEventListener('blur', () => { clearTimeout(idleTimer); preview(); });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const code = input.value.trim();
        if (!code || !API.applyCoupon) return;
        setFeedback('Applying…', null);
        try {
            const res = await API.applyCoupon(code);
            if (res && res.ok) {
                if (typeof Cart !== 'undefined') {
                    Cart.appliedCoupon = res.data?.code || code;
                    Cart.discountAmount = res.data?.discount_amount || 0;
                    if (typeof Cart.loadFromServer === 'function') await Cart.loadFromServer();
                    if (typeof Cart.updateUI === 'function') Cart.updateUI();
                }
                const saved = res.data?.discount_amount;
                setFeedback(
                    saved && typeof formatPrice === 'function'
                        ? `Coupon applied — you saved ${formatPrice(saved)}.`
                        : 'Coupon applied.',
                    'ok'
                );
            } else if (isB2BCouponExcluded(res)) {
                setFeedback(b2bCouponText(res), 'err');
            } else if (isLockout(res)) {
                // The cart had no 429 branch at all before Jul 2026 — a lockout
                // fell through to the generic "isn't valid" copy, which told the
                // shopper their code was wrong when it was actually their pace.
                setFeedback('Too many tries — wait a minute and retry.', 'err');
            } else {
                setFailure(res?.error || reasonText(res && res.data), res);
            }
        } catch (err) {
            // A plain 400 THROWS (request() only returns envelopes for a known
            // set of codes), so the suggestion arrives on err.details here and
            // on res.details above. Both shapes must be read or the nudge is
            // invisible on whichever path the backend happens to take. The same
            // reasoning applies to the B2B exclusion: api.js gives it an
            // envelope now, but the throw path is still read so a change there
            // degrades to the right copy instead of the generic one.
            if (isB2BCouponExcluded(err)) {
                setFeedback(b2bCouponText(err), 'err');
            } else if (isLockout(err)) {
                setFeedback('Too many tries — wait a minute and retry.', 'err');
            } else {
                setFailure('Couldn’t apply that coupon right now. Please try again.', err);
            }
        }
    });
}

/**
 * loyalty-points-jun2026 — apply loyalty points directly to the cart.
 *
 * Points & promo coupons are mutually exclusive (one discount per order). The
 * Max button sends `loyalty.max_redeemable_points` verbatim; the amount field
 * accepts multiples of 100 from the server-driven min up to the cart/balance
 * ceiling. Backend re-validates + clamps and returns the full cart, which we
 * re-render from. All economic values are read from the response — never hardcoded.
 */
function setLoyaltyFeedback(msg, kind) {
    const feedback = document.getElementById('cart-loyalty-feedback');
    if (!feedback) return;
    feedback.textContent = msg || '';
    feedback.classList.remove('cart-loyalty__feedback--ok', 'cart-loyalty__feedback--err');
    if (kind === 'ok') feedback.classList.add('cart-loyalty__feedback--ok');
    else if (kind === 'err') feedback.classList.add('cart-loyalty__feedback--err');
}

function loyaltyErrorMessage(code, fallbackMsg, minPts) {
    switch (code) {
        case 'EMAIL_NOT_VERIFIED': return 'Verify your email to use points.';
        case 'NOT_MULTIPLE_OF_100': return 'Enter points in multiples of 100.';
        case 'BELOW_MIN_POINTS': return minPts ? `Minimum redemption is ${minPts} points.` : 'That’s below the minimum redemption.';
        case 'CONFLICTS_WITH_COUPON': return 'Remove your coupon to use points.';
        case 'EXCEEDS_AVAILABLE_BALANCE': return 'You don’t have that many points.';
        case 'EXCEEDS_CART_SUBTOTAL': return 'That’s more than your cart total.';
        case 'LOYALTY_DISABLED': return 'Loyalty points are unavailable right now.';
        case 'RATE_LIMITED': return 'Too many tries — wait a minute and retry.';
        default:
            return (typeof API !== 'undefined' && API.extractErrorMessage)
                ? API.extractErrorMessage(fallbackMsg, 'Couldn’t apply your points right now.')
                : (fallbackMsg || 'Couldn’t apply your points right now.');
    }
}

async function applyLoyaltyPointsToCart(points) {
    if (typeof API === 'undefined' || !API.applyLoyaltyPoints) return;
    const minPts = (typeof Cart !== 'undefined' && Cart.loyalty && Cart.loyalty.min_redemption_points) || 0;
    setLoyaltyFeedback('Applying…', null);
    try {
        const res = await API.applyLoyaltyPoints(points);
        if (res && res.ok) {
            if (typeof Cart !== 'undefined') {
                if (typeof Cart.loadFromServer === 'function') await Cart.loadFromServer();
                if (typeof Cart.updateUI === 'function') Cart.updateUI(); // re-renders the applied state + message
            }
        } else {
            setLoyaltyFeedback(loyaltyErrorMessage(res && res.code, res && res.error, minPts), 'err');
        }
    } catch (err) {
        setLoyaltyFeedback(loyaltyErrorMessage(err && err.code, err, minPts), 'err');
    }
}

async function removeLoyaltyPointsFromCart() {
    if (typeof API === 'undefined' || !API.removeLoyaltyPoints) return;
    setLoyaltyFeedback('Removing…', null);
    try {
        const res = await API.removeLoyaltyPoints();
        if (res && res.ok) {
            if (typeof Cart !== 'undefined') {
                if (typeof Cart.loadFromServer === 'function') await Cart.loadFromServer();
                if (typeof Cart.updateUI === 'function') Cart.updateUI();
            }
            setLoyaltyFeedback('Points removed.', null);
        } else {
            setLoyaltyFeedback(loyaltyErrorMessage(res && res.code, res && res.error), 'err');
        }
    } catch (err) {
        setLoyaltyFeedback(loyaltyErrorMessage(err && err.code, err), 'err');
    }
}

/**
 * Re-render the cart loyalty control from Cart.loyalty. Called on every cart
 * render (via cart.js renderCartPage) and once at init. Idempotent.
 *
 * Wraps the renderer so the merged discount drawer is synced on EVERY path,
 * including the guest early-return inside renderCartLoyaltyControlInner.
 */
function renderCartLoyaltyControl() {
    renderCartLoyaltyControlInner();
    syncDiscountAccordion();
}

/**
 * Keep the merged coupon/points drawer honest: a live hint on the collapsed
 * row, an auto-open once a discount is actually applied, and the coupon side
 * locked while points are on (mirroring the coupon->points lock below).
 *
 * The auto-open is a ONE-SHOT latch. This runs on every cart mutation, so
 * re-opening unconditionally would fight a shopper who deliberately collapsed
 * the drawer after applying. The latch clears when the discount is removed, so
 * a later re-apply opens it again.
 *
 * It is not cosmetic: a closed <details> does not render its contents, so
 * #cart-loyalty-feedback (role="status" aria-live="polite") would never
 * announce "Points applied to this order." and "Remove points" would be
 * unreachable without first guessing to expand the drawer.
 */
function syncDiscountAccordion() {
    const det = document.getElementById('cart-discount');
    if (!det) return;

    const lo = (typeof Cart !== 'undefined') ? Cart.loyalty : null;
    const applied = (lo && lo.points_applied) || 0;
    const coupon = (typeof Cart !== 'undefined' && Cart.appliedCoupon) || '';
    const isAuthed = (typeof Auth !== 'undefined') && Auth.isAuthenticated && Auth.isAuthenticated();

    const hint = document.getElementById('cart-discount-hint');
    if (hint) {
        // textContent only — the coupon code is user/backend supplied.
        let text = '';
        if (coupon) {
            text = `${coupon} applied`;
        } else if (applied > 0) {
            text = `${applied.toLocaleString('en-NZ')} pts applied`;
        } else if (isAuthed && lo && (lo.max_redeemable_points || 0) > 0) {
            text = `${(lo.points_balance || 0).toLocaleString('en-NZ')} pts available`;
        }
        hint.textContent = text;
    }

    // The server rejects coupon + points together; saying so up front is kinder
    // than spending one of the shopper's limited coupon attempts to find out.
    //
    // A business account is locked out of coupons for the whole session for the
    // same reason and by a stronger rule — volume pricing and promo codes are
    // mutually exclusive server-side — so the two locks are OR'd and the B2B one
    // never lifts. It is set by initBusinessCouponLock() and read off the
    // <details> so this function stays synchronous.
    const b2bLocked = det.dataset.b2bLocked === '1';
    const pointsOn = applied > 0;
    const locked = pointsOn || b2bLocked;
    const couponInput = document.getElementById('cart-coupon-input');
    const couponApply = document.getElementById('cart-coupon-apply');
    const couponFeedback = document.getElementById('cart-coupon-feedback');
    if (couponInput) couponInput.disabled = locked;
    if (couponApply) couponApply.disabled = locked;
    if (couponFeedback && !b2bLocked) {
        // Own only this one message via a marker, so removing the points clears
        // it again without ever clobbering a preview/apply result from
        // initCouponForm that happens to be showing in the same element.
        // Skipped entirely under the B2B lock, whose explanation lives in its
        // own element and must not be argued with by a points notice.
        if (pointsOn && !couponFeedback.textContent) {
            couponFeedback.textContent = 'Remove your points to use a coupon.';
            couponFeedback.dataset.lockNotice = '1';
        } else if (!pointsOn && couponFeedback.dataset.lockNotice) {
            couponFeedback.textContent = '';
            delete couponFeedback.dataset.lockNotice;
        }
    }

    const active = pointsOn || !!coupon;
    if (active && !det.dataset.autoOpened) {
        det.open = true;
        det.dataset.autoOpened = '1';
    }
    if (!active) delete det.dataset.autoOpened;
}

/**
 * Lock the promo-code field for a signed-in business account.
 *
 * Business accounts receive automatic volume pricing and cannot also apply a
 * coupon: a coupon is not floor-clamped, so stacking the two could sell a line
 * below cost. The backend enforces it with a 400 `B2B_COUPON_EXCLUDED`, and
 * initCouponForm() handles that response — but letting a trade customer type a
 * code and press Apply just to be told no spends one of their limited attempts
 * against an endpoint that locks out, to teach them a rule we already knew.
 *
 * So the field is disabled with the reason stated, and the 400 stays handled as
 * the backstop for the paths that skip the field entirely (the `?coupon=`
 * recovery-email link, a stale tab, a status call that failed).
 *
 * LOYALTY POINTS ARE NOT BLOCKED — only coupons are (handoff §3). This function
 * touches nothing in the loyalty control.
 */
async function initBusinessCouponLock() {
    const det = document.getElementById('cart-discount');
    if (!det || typeof Business === 'undefined') return;

    let active = false;
    try {
        active = await Business.isActive();
    } catch (_) {
        // A failed status check must not lock a retail customer out of coupons.
        return;
    }
    if (!active) return;

    det.dataset.b2bLocked = '1';

    const note = document.getElementById('cart-coupon-blocked');
    if (note) {
        note.textContent = 'Business accounts get automatic volume pricing — promo codes can’t be combined. Your loyalty points still work.';
        note.hidden = false;
    }
    syncDiscountAccordion();
}

function renderCartLoyaltyControlInner() {
    const root = document.getElementById('cart-loyalty');
    if (!root) return;

    const lo = (typeof Cart !== 'undefined') ? Cart.loyalty : null;
    const isAuthed = (typeof Auth !== 'undefined') && Auth.isAuthenticated && Auth.isAuthenticated();

    const form = document.getElementById('cart-loyalty-form');
    const input = document.getElementById('cart-loyalty-input');
    const maxBtn = document.getElementById('cart-loyalty-max');
    const applyBtn = document.getElementById('cart-loyalty-apply');
    const removeBtn = document.getElementById('cart-loyalty-remove');
    const balanceEl = document.getElementById('cart-loyalty-balance');
    const guestEl = document.getElementById('cart-loyalty-guest');

    // Guests: show the sign-in affordance, hide the interactive form.
    if (!isAuthed) {
        root.hidden = false;
        if (guestEl) guestEl.hidden = false;
        if (form) form.hidden = true;
        if (removeBtn) removeBtn.hidden = true;
        if (balanceEl) balanceEl.textContent = '';
        setLoyaltyFeedback('', null);
        return;
    }
    if (guestEl) guestEl.hidden = true;
    if (form) form.hidden = false;

    // No loyalty block (service down / program off / not eligible) → hide entirely.
    if (!lo) { root.hidden = true; return; }
    root.hidden = false;

    const rate = lo.redemption_rate || 100;
    const balance = lo.points_balance || 0;
    const applied = lo.points_applied || 0;
    const maxPts = lo.max_redeemable_points || 0;
    const minPts = lo.min_redemption_points || 0;

    if (balanceEl) {
        const dollars = balance / rate;
        const money = (typeof formatPrice === 'function') ? ` (${formatPrice(dollars)})` : '';
        balanceEl.textContent = `${balance.toLocaleString('en-NZ')} pts${money}`;
    }

    if (input) {
        input.min = String(minPts || 0);
        input.max = String(maxPts || 0);
        input.step = '100';
    }

    const couponApplied = (typeof Cart !== 'undefined') && !!Cart.appliedCoupon;
    const canRedeem = maxPts > 0 && !couponApplied;

    if (applyBtn) applyBtn.disabled = !canRedeem;
    if (maxBtn) maxBtn.disabled = !canRedeem;
    if (input) input.disabled = !canRedeem;

    if (applied > 0) {
        if (input && document.activeElement !== input) input.value = String(applied);
        if (removeBtn) removeBtn.hidden = false;
    } else {
        if (removeBtn) removeBtn.hidden = true;
    }

    // Feedback precedence: stale clamp > coupon conflict > applied msg > redeem hints.
    if (lo.stale_notice) {
        setLoyaltyFeedback(lo.stale_notice, 'err');
    } else if (couponApplied) {
        setLoyaltyFeedback('Remove your coupon to use points.', null);
    } else if (applied > 0) {
        setLoyaltyFeedback(lo.message || 'Points applied to this order.', 'ok');
    } else if (maxPts === 0 && balance > 0 && minPts && balance < minPts) {
        setLoyaltyFeedback(`Earn ${minPts - balance} more points to redeem.`, null);
    } else if (maxPts === 0 && minPts && balance >= minPts) {
        setLoyaltyFeedback('Add more to your cart to use points.', null);
    } else {
        setLoyaltyFeedback('', null);
    }
}

function initLoyaltyControl() {
    const form = document.getElementById('cart-loyalty-form');
    const maxBtn = document.getElementById('cart-loyalty-max');
    const removeBtn = document.getElementById('cart-loyalty-remove');
    const input = document.getElementById('cart-loyalty-input');
    if (!form) { renderCartLoyaltyControl(); return; }

    form.addEventListener('submit', (e) => {
        e.preventDefault();
        const pts = parseInt(input && input.value, 10);
        if (!pts || pts <= 0) { setLoyaltyFeedback('Enter how many points to use.', 'err'); return; }
        applyLoyaltyPointsToCart(pts);
    });

    if (maxBtn) {
        maxBtn.addEventListener('click', () => {
            const max = (typeof Cart !== 'undefined' && Cart.loyalty && Cart.loyalty.max_redeemable_points) || 0;
            if (max <= 0) return;
            if (input) input.value = String(max);
            applyLoyaltyPointsToCart(max);
        });
    }

    if (removeBtn) removeBtn.addEventListener('click', removeLoyaltyPointsFromCart);

    renderCartLoyaltyControl();
}

async function autoApplyCouponFromUrl() {
    let url;
    try { url = new URL(window.location.href); } catch (_) { return; }
    const code = (url.searchParams.get('coupon') || '').trim();
    if (!code) return;

    // Strip the param immediately — refreshing should never re-trigger the apply.
    url.searchParams.delete('coupon');
    const cleanUrl = url.pathname + (url.searchParams.toString() ? '?' + url.searchParams.toString() : '') + url.hash;
    try { history.replaceState({}, '', cleanUrl); } catch (_) { /* ignore */ }

    if (typeof API === 'undefined' || !API.applyCoupon) return;

    // Recovery coupons are email-locked and require an authenticated session.
    // Wait briefly for Auth to initialize so we don't hit /coupon as a guest.
    if (typeof Auth !== 'undefined') {
        const start = Date.now();
        while (!Auth.initialized && Date.now() - start < 3000) {
            await new Promise(r => setTimeout(r, 50));
        }
        if (!Auth.isAuthenticated()) {
            if (typeof showToast === 'function') {
                showToast('Sign in to apply your coupon code: ' + code, 'info', 6000);
            }
            return;
        }
    }

    try {
        const res = await API.applyCoupon(code);
        if (res && res.ok) {
            if (typeof Cart !== 'undefined') {
                Cart.appliedCoupon = res.data?.code || code;
                Cart.discountAmount = res.data?.discount_amount || 0;
                if (typeof Cart.loadFromServer === 'function') {
                    await Cart.loadFromServer();
                }
                if (typeof Cart.updateUI === 'function') Cart.updateUI();
            }
            const saved = res.data?.discount_amount;
            const msg = saved && typeof formatPrice === 'function'
                ? `Coupon ${code} applied — you saved ${formatPrice(saved)}!`
                : `Coupon ${code} applied!`;
            if (typeof showToast === 'function') showToast(msg, 'success', 5000);
            // Cart.updateUI is typeof-guarded above and may have been a no-op.
            syncDiscountAccordion();
        } else if (isB2BCouponExcluded(res)) {
            // A recovery email reached a business account. The code is not
            // broken and retrying will never work, so say why once and do NOT
            // reveal + prefill the field: it is disabled by
            // initBusinessCouponLock(), and opening a dead form under a toast
            // that just explained the rule is an invitation to argue with it.
            if (typeof showToast === 'function') {
                showToast(b2bCouponText(res), 'info', 7000);
            }
        } else {
            if (typeof showToast === 'function') {
                showToast(res?.error || 'Coupon could not be applied', 'warning', 5000);
            }
            revealCouponForRetry(code);
        }
    } catch (err) {
        if (typeof DebugLog !== 'undefined') DebugLog.warn('Auto-apply coupon failed:', err && err.message);
        if (isB2BCouponExcluded(err)) {
            if (typeof showToast === 'function') showToast(b2bCouponText(err), 'info', 7000);
            return;
        }
        revealCouponForRetry(code);
    }
}

/**
 * A ?coupon= link that failed leaves the shopper with a toast and no obvious
 * next step — the field is behind a collapsed drawer. Open it and prefill the
 * code so retrying is one tap rather than a hunt.
 */
function revealCouponForRetry(code) {
    const det = document.getElementById('cart-discount');
    if (det) { det.open = true; det.dataset.autoOpened = '1'; }
    const input = document.getElementById('cart-coupon-input');
    if (input && !input.value) input.value = code;
}
