/**
 * FIRST-PAINT.JS
 * ==============
 * The only render-blocking script on shop.html. It tells CSS, before the first
 * paint, which landing this is and whether the "Find your printer" box will
 * show, so neither the h1 nor the finder repaints when the deferred
 * shop-page.js runs (checklist items 32 fix 2 and 37, ERR-370).
 *
 * It used to live at the top of gtag.js, which was render-blocking only
 * because of it. Split out so gtag.js can be `defer` (mobile-speed spec fix 4,
 * backend reply 2026-10-25). Keep this file tiny: everything here delays the
 * first frame. ShopPage._dropFirstPaintHints() removes both attributes after
 * the first render.
 */
/* Paid landing: /ink-cartridges and /toner-cartridges paint their final h1
 * at once (shop.html spans) instead of "Shop Ink Cartridges & Toner NZ". */
try {
    var _landingPath = String(location.pathname || '').replace(/\/+$/, '');
    if (_landingPath === '/ink-cartridges') document.documentElement.setAttribute('data-landing', 'ink');
    else if (_landingPath === '/toner-cartridges') document.documentElement.setAttribute('data-landing', 'toner');
    /* …and whether the "Find your printer" box will show (item 37, ERR-370), so
     * CSS reserves it from the first paint instead of shop-page.js inserting it
     * above a painted skeleton. A first-paint HINT mirroring
     * ShopPage._printerFinderBrand (pinned equal by a test): a brand page, or a
     * brand + ink/toner/drums code grid — no code, printer or search. */
    var _q = new URLSearchParams(location.search || '');
    var _cat = (_q.get('category') || '').toLowerCase();
    if (_landingPath === '/shop' && _q.get('brand')
        && !_q.get('code') && !_q.get('printer_slug') && !_q.get('printer') && !_q.get('q') && !_q.get('search')
        && (!_cat || /^(ink|toner|drums|drum|consumable)$/.test(_cat))) {
        document.documentElement.setAttribute('data-finder', 'brand');
    }
} catch (_) { /* a hint only: never block the page */ }
