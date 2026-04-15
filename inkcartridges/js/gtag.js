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
gtag('config', 'G-SDQELG0FGD');
gtag('config', 'G-YJXTSGLM28');
gtag('config', 'AW-18032498762');

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
