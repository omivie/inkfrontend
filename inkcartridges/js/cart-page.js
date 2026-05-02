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
});

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
