// Schema.js — JSON-LD embedding helper.
//
// Spec §5.6: every page should embed a small set of JSON-LD scripts so Googlebot
// has structured data on first paint. Backend endpoints that produce these:
//
//   GET /api/schema/site                       → Organization, WebSite, LocalBusiness
//   GET /api/products/:sku/jsonld              → Product, BreadcrumbList, FAQ
//   GET /api/schema/collection?brand=&category= → CollectionPage, BreadcrumbList
//   GET /api/schema/printer/:slug              → CollectionPage, BreadcrumbList
//
// This module:
//   - Centralises JSON-LD injection so callers don't reinvent the same loop.
//   - Auto-fetches /api/schema/site on every page load (idempotent — re-runs
//     are safe because each script tag has a stable id and gets replaced).
//   - Sanitises payloads against script-tag breakout (`</` → `<\/`) — defence
//     in depth on top of the backend's seoHelpers.jsonLdEscape.
//
// Exposed globals (no module system in this repo):
//   window.Schema = { injectSite, injectProduct, injectCollection, injectPrinter,
//                     write, remove, sanitize }

(function () {
    'use strict';

    function safeStringify(value) {
        try {
            return JSON.stringify(value).replace(/<\//g, '<\\/');
        } catch (_) {
            return null;
        }
    }

    // Append (or replace) a single JSON-LD <script> tag identified by `id`.
    function write(id, payload) {
        if (!id || payload == null) return;
        const json = safeStringify(payload);
        if (!json) return;
        let el = document.getElementById(id);
        if (!el) {
            el = document.createElement('script');
            el.type = 'application/ld+json';
            el.id = id;
            document.head.appendChild(el);
        }
        el.textContent = json;
    }

    function remove(idOrIds) {
        const ids = Array.isArray(idOrIds) ? idOrIds : [idOrIds];
        ids.forEach((id) => {
            const el = document.getElementById(id);
            if (el) el.remove();
        });
    }

    // Map a backend-supplied schema payload (object or { jsonLd }) into a
    // dictionary of { id: object } pairs, then write each. Accepts either:
    //   - { @type: 'Product', ... }                 (single doc)
    //   - { product_schema, faq_schema, ... }       (legacy multi-key)
    //   - { jsonLd: <one of the above> }            (envelope from /jsonld)
    function _writeMixed(prefix, payload) {
        if (!payload) return;
        if (payload.jsonLd) return _writeMixed(prefix, payload.jsonLd);
        if (payload['@type'] || Array.isArray(payload)) {
            write(prefix, payload);
            return;
        }
        Object.keys(payload).forEach((key) => {
            const value = payload[key];
            if (!value) return;
            write(`${prefix}-${key.replace(/_schema$/, '').replace(/_/g, '-')}`, value);
        });
    }

    // Site-level (Organization / WebSite / LocalBusiness). Run on every page.
    async function injectSite() {
        if (typeof API === 'undefined' || !API.getSiteSchema) return;
        try {
            const res = await API.getSiteSchema();
            if (!res || !res.ok || !res.data) return;
            _writeMixed('site-jsonld', res.data);
        } catch (_) {
            // Non-critical — JSON-LD is additive, not load-bearing.
        }
    }

    // Product detail page — fetch dedicated /jsonld endpoint.
    async function injectProduct(sku) {
        if (!sku || typeof API === 'undefined' || !API.getProductJsonLd) return;
        try {
            const res = await API.getProductJsonLd(sku);
            if (!res || !res.ok || !res.data) return;
            _writeMixed('product-jsonld', res.data);
        } catch (_) { /* additive */ }
    }

    // Brand / category collection pages — backend accepts brand-only,
    // category-only, or both. At least one is required.
    async function injectCollection(brand, category) {
        if (!brand && !category) {
            remove(['collection-jsonld-collection-page', 'collection-jsonld-breadcrumbs',
                    'collection-jsonld-collectionPage']);
            return;
        }
        if (typeof API === 'undefined' || !API.getCollectionSchema) return;
        try {
            const res = await API.getCollectionSchema({ brand: brand || undefined, category: category || undefined });
            if (!res || !res.ok || !res.data) {
                remove(['collection-jsonld-collection-page', 'collection-jsonld-breadcrumbs',
                        'collection-jsonld-collectionPage']);
                return;
            }
            const data = res.data;
            // Normalise both shapes the backend has shipped.
            write('collection-jsonld-collection-page', data.collectionPage || data.collection_page);
            write('collection-jsonld-breadcrumbs', data.breadcrumbs || data.breadcrumbList || data.breadcrumb);
        } catch (_) { /* additive */ }
    }

    // Printer landing page (`/shop?printer_slug=...`).
    async function injectPrinter(slug) {
        if (!slug) {
            remove(['printer-jsonld-collection-page', 'printer-jsonld-breadcrumbs']);
            return;
        }
        if (typeof API === 'undefined' || !API.getPrinterSchema) return;
        try {
            const res = await API.getPrinterSchema(slug);
            if (!res || !res.ok || !res.data) {
                remove(['printer-jsonld-collection-page', 'printer-jsonld-breadcrumbs']);
                return;
            }
            const data = res.data;
            write('printer-jsonld-collection-page', data.collectionPage || data.collection_page);
            write('printer-jsonld-breadcrumbs', data.breadcrumbs || data.breadcrumbList || data.breadcrumb);
        } catch (_) { /* additive */ }
    }

    window.Schema = { injectSite, injectProduct, injectCollection, injectPrinter,
                      write, remove, sanitize: safeStringify };

    // Auto-inject site schema on every page load. Skip admin pages — they're
    // noindex'd and don't need rich-result markup.
    function autoInjectSite() {
        const p = location.pathname || '';
        // Exact match avoids matching "/admin*" inside other URLs.
        if (p === '/admin' || p.indexOf('/admin/') === 0) return;
        if (p.indexOf('/html/' + 'admin') === 0) return;
        injectSite();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', autoInjectSite);
    } else {
        autoInjectSite();
    }
})();
