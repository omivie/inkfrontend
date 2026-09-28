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
 *
 * HERO PRELOAD (backend handoff 2026-09-28 §2). When the product arrives, a
 * <link rel=preload> for the hero image goes into <head> at once, so the LCP
 * image starts with the product response instead of after every deferred
 * script has run and renderProduct() has written the <img>. The URLs MUST be
 * the ones the <img> will ask for, or the browser downloads the image twice:
 * heroImage() mirrors storageUrl() + imageSrcset(raw, [400, 600, 800]) in
 * js/utils.js and the `sizes` in product-detail-page.js renderProduct, and
 * tests/backend-move-sep2026.test.js §2 runs both and asserts they agree.
 * The link carries `data-lcp-product`, which also stops Products.renderCards
 * from promoting the below-fold "bought together" card to high priority.
 */
'use strict';
(function () {
    // MIRROR of Config.API_URL (js/config.js), which is not loaded yet.
    // tests/conversion-fixes-sep2026.test.js runs both and asserts they agree.
    function apiBase(host) {
        return (host === 'www.inkcartridges.co.nz' || host === 'inkcartridges.co.nz')
            ? 'https://api.inkcartridges.co.nz'
            : 'https://ink-backend-sg.onrender.com';
    }

    // MIRROR of the PDP hero <img> (see the header). null ⇒ no preload: a local
    // asset or placeholder, or the legacy colour-swatch image renderProduct
    // replaces with a colour block.
    var HERO_WIDTHS = [400, 600, 800];
    var HERO_SIZES = '(max-width: 480px) 400px, (max-width: 768px) 600px, 800px';
    function heroImage(raw, base) {
        if (!raw || typeof raw !== 'string' || raw.charAt(0) === '/') return null;
        if (/\/color-swatch(?:-v\d+)?\.(?:png|jpe?g|webp)(?:\?.*)?$/i.test(raw)) return null;
        var opt = function (w) {
            return base + '/api/images/optimize?url=' + encodeURIComponent(raw) + '&w=' + w + '&format=webp';
        };
        return {
            href: opt(400),
            srcset: HERO_WIDTHS.map(function (w) { return opt(w) + ' ' + w + 'w'; }).join(', '),
            sizes: HERO_SIZES
        };
    }

    function preloadHero(doc, body, base) {
        var data = body && body.ok !== false && body.data;
        var hero = data && heroImage(data.image_url, base);
        if (!hero || !doc || !doc.head) return null;
        if (doc.querySelector('link[rel="preload"][data-lcp-product]')) return null;
        var link = doc.createElement('link');
        link.rel = 'preload';
        link.as = 'image';
        link.href = hero.href;
        link.setAttribute('imagesrcset', hero.srcset);
        link.setAttribute('imagesizes', hero.sizes);
        link.setAttribute('fetchpriority', 'high');
        link.setAttribute('data-lcp-product', 'pdp-hero');
        doc.head.appendChild(link);
        return link;
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

    function start(loc, doc) {
        var sku = skuFromLocation(loc);
        if (!sku || typeof fetch !== 'function') return null;
        var path = '/api/products/' + encodeURIComponent(sku);
        var base = apiBase(loc.hostname);
        var promise = fetch(base + path, { method: 'GET', headers: {}, credentials: 'omit' })
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
        // Side branch: a preload failure must never touch the consumed promise.
        promise.then(function (r) {
            if (r.kind === 'ok') { try { preloadHero(doc, r.body, base); } catch (e) { /* preload is a hint */ } }
        });
        return { path: path, promise: promise };
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { skuFromLocation: skuFromLocation, apiBase: apiBase, start: start, heroImage: heroImage, preloadHero: preloadHero };
    }
    if (typeof window !== 'undefined' && window.location) {
        try { window.__pdpPrefetch = start(window.location, window.document); } catch (e) { window.__pdpPrefetch = null; }
    }
})();
