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
