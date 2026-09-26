/**
 * PDP-PREFETCH.JS — start the product read before the page's scripts run
 * (conversion handoff 2026-09-23 §2, "PDP content arrives late").
 *
 * Measured by the backend: the PDP <h1> was empty until 2.5–3.5 s on desktop
 * and 3.3–4.9 s on mobile, and paid sessions that LANDED on a product page
 * converted 0 of 91 in 120 days. The product read used to start only after
 * every deferred script had downloaded and executed (~25 files). This file is
 * loaded synchronously in <head>, is tiny, and starts that same read at once.
 *
 * It is an external file, not an inline <script>: the CSP has no
 * 'unsafe-inline', and an inline script is a file no tool can see (ERR-230).
 *
 * CONTRACT with API.getProduct (js/api.js) — it consumes this ONCE:
 *   window.__pdpPrefetch = { path, promise }
 *   path     the exact endpoint getProduct would request ("/api/products/<sku>")
 *   promise  resolves to the same {kind, status, body} shape as
 *            API._rawJsonFetch, so the consumer needs no second code path.
 *
 * Deliberately narrow — anything unusual gets NO prefetch and the page does
 * exactly what it did before:
 *   - ribbons (/ribbon/…) use a different endpoint
 *   - ?printer_slug= changes the request (and its cache key)
 *   - legacy slug-only URLs need a lookup first
 * The request is anonymous and cookieless, exactly like the public read
 * (ERR-124); an admin preview never consumes it (API._catalogRoute decides).
 */
'use strict';
(function () {
    // MIRROR of Config.API_URL (js/config.js), which is not loaded yet.
    // tests/conversion-fixes-sep2026.test.js runs both and asserts they agree.
    function apiBase(host) {
        return (host === 'www.inkcartridges.co.nz' || host === 'inkcartridges.co.nz')
            ? 'https://api.inkcartridges.co.nz'
            : 'https://ink-backend-zaeq.onrender.com';
    }

    /** SKU from the URL, or null when this page should not prefetch. */
    function skuFromLocation(loc) {
        var params = new URLSearchParams(loc.search || '');
        if (params.get('printer_slug')) return null;
        var path = loc.pathname || '';
        var m = /^\/products\/[^/]+\/([^/]+)$/.exec(path) || /^\/p\/([^/]+)$/.exec(path);
        // The raw-file spelling of the PDP (npx serve / scanners), ?sku= form.
        var raw = m ? m[1] : (/^\/html\/product(?:\/|\/index\.html)?$/.test(path) ? params.get('sku') : null);
        if (!raw) return null;
        try { raw = decodeURIComponent(raw); } catch (e) { return null; }
        return raw.trim() || null;
    }

    function start(loc) {
        var sku = skuFromLocation(loc);
        if (!sku || typeof fetch !== 'function') return null;
        var path = '/api/products/' + encodeURIComponent(sku);
        var promise = fetch(apiBase(loc.hostname) + path, { method: 'GET', headers: {}, credentials: 'omit' })
            .then(function (res) {
                return res.json().then(function (body) { return body; }, function () { return null; })
                    .then(function (body) {
                        return (res.status >= 200 && res.status < 300 && body)
                            ? { kind: 'ok', status: res.status, body: body }
                            : { kind: 'http-error', status: res.status, body: body };
                    });
            }, function (err) {
                return { kind: 'network-error', error: err && err.message };
            });
        return { path: path, promise: promise };
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { skuFromLocation: skuFromLocation, apiBase: apiBase, start: start };
    }
    if (typeof window !== 'undefined' && window.location) {
        try { window.__pdpPrefetch = start(window.location); } catch (e) { window.__pdpPrefetch = null; }
    }
})();
