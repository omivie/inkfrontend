/**
 * LEGAL-PAGE.JS
 * =============
 * Shared behaviour for the compliance / info pages: Terms, Privacy,
 * Returns, Shipping, About, FAQ.
 *
 * Responsibilities (intentionally narrow — pages stay readable as plain
 * HTML, this file just wires the dynamic edges):
 *
 *   1. Replace `[data-legal-bind="key"]` placeholders with values from
 *      LegalConfig (address, phone, email, hours, free-shipping
 *      threshold, etc.) — single source of truth, no duplication.
 *
 *   2. Render the "Last updated" stamp from LegalConfig.policyEffectiveDate.
 *
 *   3. Build the table-of-contents from `.policy-section[id]` h2s and
 *      smooth-scroll on click. Sticky on desktop only.
 *
 *   4. Render the contact-page mini-map (OpenStreetMap static embed) so
 *      every page that uses `[data-legal-bind="map"]` gets the same
 *      consistent location marker without an external map provider.
 *
 *   5. Wire FAQ accordions (`<details class="faq-item">` is enough — the
 *      element does the work natively; we just track open/close for GA
 *      so the team can see which questions actually get clicked).
 */
(function () {
    'use strict';

    function $(sel, root) { return (root || document).querySelector(sel); }
    function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

    function escapeHtml(str) {
        if (typeof Security !== 'undefined' && Security.escapeHtml) return Security.escapeHtml(str);
        var div = document.createElement('div');
        div.appendChild(document.createTextNode(str == null ? '' : String(str)));
        return div.innerHTML;
    }

    /** ──────────────────────────────────────────────────────────────────
     *  Bindings — replace `[data-legal-bind="key"]` placeholders with
     *  values from LegalConfig. Bindings are render-only; never read
     *  user input through them.
     *  ────────────────────────────────────────────────────────────── */
    function applyBindings() {
        if (typeof LegalConfig === 'undefined') return;
        var cfg = LegalConfig;

        var bindings = {
            'trading-name':    cfg.tradingName,
            'legal-entity':    cfg.legalEntity,
            'address-line':    cfg.formatAddressOneLine(),
            'address-block':   cfg.formatAddressMultiLine().join('\n'),
            'phone-display':   cfg.phoneDisplay,
            'phone-href':      'tel:' + cfg.phoneE164,
            'email':           cfg.email,
            'email-href':      'mailto:' + cfg.email,
            'hours':           cfg.hoursDisplay,
            'response-sla':    cfg.responseSLA,
            'free-threshold':  cfg.currencySymbol + cfg.freeShippingThreshold,
            'currency':        cfg.currency,
            'return-window':   String(cfg.returnWindowDays),
            'policy-date':     cfg.formatPolicyDate(),
            'policy-version':  cfg.policyVersion,
            'privacy-officer': cfg.privacyOfficerName,
            'privacy-email':   cfg.privacyOfficerEmail,
            'handling-time':   cfg.handlingTime,
            'supplier-fulfillment': cfg.supplierFulfillment,
        };

        Object.keys(bindings).forEach(function (key) {
            $$('[data-legal-bind="' + key + '"]').forEach(function (el) {
                var val = bindings[key];
                if (key === 'phone-href' || key === 'email-href') {
                    el.setAttribute('href', val);
                    return;
                }
                if (key === 'address-block') {
                    el.innerHTML = cfg.formatAddressMultiLine().map(escapeHtml).join('<br>');
                    return;
                }
                el.textContent = val;
            });
        });

        // Optional GST / NZBN — render the entire line only if filled in.
        $$('[data-legal-bind="tax-line"]').forEach(function (el) {
            if (!cfg.hasTaxIdentifiers()) {
                el.remove();
                return;
            }
            var bits = [];
            if (cfg.gstNumber) bits.push('GST Number: ' + escapeHtml(cfg.gstNumber));
            if (cfg.nzbn)      bits.push('NZBN: '      + escapeHtml(cfg.nzbn));
            el.innerHTML = bits.join(' &middot; ');
        });

        // Payment methods — comma-joined for "We accept" lines.
        $$('[data-legal-bind="payment-methods"]').forEach(function (el) {
            el.textContent = (cfg.paymentMethods || []).join(', ');
        });

        // Carriers list.
        $$('[data-legal-bind="carriers"]').forEach(function (el) {
            el.textContent = (cfg.carriers || []).join(' and ');
        });

        // Shipping zone table — populated only on /shipping where the
        // table host element is present.
        var zoneHost = $('[data-legal-bind="shipping-zones"]');
        if (zoneHost && cfg.shippingZones) {
            zoneHost.innerHTML = cfg.shippingZones.map(function (z) {
                return ''
                    + '<tr>'
                    +   '<th scope="row">' + escapeHtml(z.zone) + '</th>'
                    +   '<td>' + escapeHtml(z.urban) + '</td>'
                    +   '<td>' + escapeHtml(z.rural) + '</td>'
                    +   '<td>' + escapeHtml(z.eta)   + '</td>'
                    + '</tr>';
            }).join('');
        }

        // Data processors table — populated only on /privacy.
        var procHost = $('[data-legal-bind="data-processors"]');
        if (procHost && cfg.dataProcessors) {
            procHost.innerHTML = cfg.dataProcessors.map(function (p) {
                return ''
                    + '<tr>'
                    +   '<th scope="row">' + escapeHtml(p.name)    + '</th>'
                    +   '<td>'             + escapeHtml(p.purpose) + '</td>'
                    +   '<td>'             + escapeHtml(p.region)  + '</td>'
                    + '</tr>';
            }).join('');
        }

        // Cookie table — populated only on /privacy.
        var cookieHost = $('[data-legal-bind="cookies"]');
        if (cookieHost && cfg.cookies) {
            cookieHost.innerHTML = cfg.cookies.map(function (c) {
                return ''
                    + '<tr>'
                    +   '<th scope="row">' + escapeHtml(c.category) + '</th>'
                    +   '<td>'             + escapeHtml(c.examples) + '</td>'
                    +   '<td>'             + (c.optional ? 'Optional' : 'Required') + '</td>'
                    + '</tr>';
            }).join('');
        }

        // Static map embed — uses OpenStreetMap so we don't need a paid
        // Google Maps API key, and the user is never tracked by a third
        // party while reading our policy pages. Marker centred on the
        // configured geo coords with a 600m bounding box.
        $$('[data-legal-bind="map"]').forEach(function (el) {
            var lat = cfg.geo.lat;
            var lng = cfg.geo.lng;
            var bbox = [lng - 0.005, lat - 0.0035, lng + 0.005, lat + 0.0035].join(',');
            var src  = 'https://www.openstreetmap.org/export/embed.html?bbox=' + encodeURIComponent(bbox)
                + '&layer=mapnik&marker=' + lat + ',' + lng;
            el.innerHTML = ''
                + '<iframe class="legal-map__frame" loading="lazy" '
                +   'title="Map showing ' + escapeHtml(cfg.formatAddressOneLine()) + '" '
                +   'src="' + escapeHtml(src) + '"></iframe>'
                + '<a class="legal-map__link" target="_blank" rel="noopener" '
                +   'href="https://www.openstreetmap.org/?mlat=' + lat + '&amp;mlon=' + lng + '#map=17/' + lat + '/' + lng + '">'
                +   'View larger map'
                + '</a>';
        });
    }

    /** ──────────────────────────────────────────────────────────────────
     *  Table of contents — built from `.policy-section[id] > h2` so the
     *  page author writes only the section content; the TOC stays in
     *  lock-step with whatever sections exist.
     *  ────────────────────────────────────────────────────────────── */
    function buildTOC() {
        var host = $('[data-legal-toc]');
        if (!host) return;
        var sections = $$('.policy-section[id]');
        if (sections.length === 0) return;

        var items = sections.map(function (sec) {
            var h2 = sec.querySelector('h2');
            if (!h2) return '';
            var label = h2.textContent.trim();
            return '<li><a href="#' + sec.id + '">' + escapeHtml(label) + '</a></li>';
        }).filter(Boolean).join('');

        host.innerHTML = '<nav aria-label="On this page" class="legal-toc__nav">'
            + '<p class="legal-toc__heading">On this page</p>'
            + '<ol class="legal-toc__list">' + items + '</ol>'
            + '</nav>';

        // Smooth scroll without losing the URL fragment for deep-linking.
        host.addEventListener('click', function (e) {
            var a = e.target.closest('a[href^="#"]');
            if (!a) return;
            var id = a.getAttribute('href').slice(1);
            var target = document.getElementById(id);
            if (!target) return;
            e.preventDefault();
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
            history.replaceState(null, '', '#' + id);
            // Move focus to the heading for screen readers.
            var h2 = target.querySelector('h2');
            if (h2) {
                h2.setAttribute('tabindex', '-1');
                h2.focus({ preventScroll: true });
            }
        });
    }

    /** ──────────────────────────────────────────────────────────────────
     *  FAQ accordion telemetry — `<details>` does the open/close itself.
     *  We just emit a GA event when one opens so the team can see which
     *  questions are actually clicked.
     *  ────────────────────────────────────────────────────────────── */
    function wireFAQ() {
        $$('details.faq-item').forEach(function (el) {
            el.addEventListener('toggle', function () {
                if (!el.open) return;
                try {
                    if (typeof gtag === 'function') {
                        gtag('event', 'faq_open', {
                            faq_question: (el.querySelector('summary') || {}).textContent || '',
                        });
                    }
                } catch (_) { /* ignore */ }
            });
        });
    }

    function init() {
        applyBindings();
        buildTOC();
        wireFAQ();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
