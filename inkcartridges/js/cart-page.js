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
});

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
            } else {
                setFeedback(reasonText(data), 'err');
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
            } else {
                setFeedback(res?.error || reasonText(res && res.data), 'err');
            }
        } catch (err) {
            setFeedback('Couldn’t apply that coupon right now. Please try again.', 'err');
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
 */
function renderCartLoyaltyControl() {
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
        } else if (typeof showToast === 'function') {
            showToast(res?.error || 'Coupon could not be applied', 'warning', 5000);
        }
    } catch (err) {
        if (typeof DebugLog !== 'undefined') DebugLog.warn('Auto-apply coupon failed:', err && err.message);
    }
}
