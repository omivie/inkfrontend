/**
 * GTAG.JS
 * =======
 * Google Analytics initialization (extracted from inline scripts for CSP compliance)
 */
window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('consent', 'default', {
    analytics_storage: localStorage.getItem('cookie_consent') === 'accepted' ? 'granted' : 'denied'
});
gtag('js', new Date());
// cookie_flags ensures first-party GA/Ads cookies (_ga, _gcl_au) carry the
// Secure attribute — the site is HTTPS-only (HSTS in vercel.json), so Secure
// is always honoured. Google's documented mechanism for flagging the
// conversion-linker cookie (FE audit Jun 2026, ERR-049).
const GTAG_COOKIE_FLAGS = { cookie_flags: 'SameSite=None;Secure' };
gtag('config', 'G-SDQELG0FGD', GTAG_COOKIE_FLAGS);
gtag('config', 'G-YJXTSGLM28', GTAG_COOKIE_FLAGS);
gtag('config', 'AW-18032498762', GTAG_COOKIE_FLAGS);

// First-party traffic tracker — loaded alongside GA so it lands on every page
// that already includes gtag.js. Skips admin pages internally.
(function loadTrafficTracker() {
    try {
        const s = document.createElement('script');
        s.src = '/js/traffic-tracker.js';
        s.defer = true;
        (document.head || document.documentElement).appendChild(s);
    } catch (_) { /* non-fatal */ }
})();
