/**
 * LEGAL-PAGE.JS
 * =============
 * Shared behaviour for the compliance / info pages: Terms, Privacy,
 * Returns, Shipping, About, FAQ, Contact.
 *
 * Responsibilities (intentionally narrow — pages stay readable as plain
 * HTML, this file just wires the dynamic edges):
 *
 *   0. Fetch admin-authored overrides from the Supabase
 *      `legal_content_overrides` table and apply them BEFORE bindings
 *      and TOC build. See readfirst/legal-content-cms-may2026.md for
 *      the override-key format and storage contract. Fail-open: any
 *      fetch error means the page renders the static HTML untouched.
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

    /** ──────────────────────────────────────────────────────────────────
     *  CMS overrides — admin-authored content + site-fact tweaks
     *  pulled from Supabase before the static HTML is bound.
     *  ────────────────────────────────────────────────────────────── */

    // Match the slug embedded in <link rel="canonical">. Falls back to
    // window.location.pathname so local-dev / preview environments still
    // resolve. Returns one of: about, terms, privacy, returns, shipping,
    // faq, contact, or null when this file is loaded on a non-legal page.
    var LEGAL_SLUGS = ['about', 'terms', 'privacy', 'returns', 'shipping', 'faq', 'contact'];

    function detectPageSlug() {
        var canonical = document.querySelector('link[rel="canonical"]');
        var href = (canonical && canonical.getAttribute('href')) || window.location.pathname || '';
        for (var i = 0; i < LEGAL_SLUGS.length; i++) {
            var slug = LEGAL_SLUGS[i];
            // Match either the canonical URL form or a bare path; tolerate
            // a .html suffix for serve.json local-dev parity.
            var re = new RegExp('/' + slug + '(?:\\.html|/?)(?:[?#]|$)');
            if (re.test(href)) return slug;
        }
        return null;
    }

    function siteFactsApply(rows) {
        if (typeof LegalConfig === 'undefined') return;
        var cfg = LegalConfig;
        // Allow-list — anything not in here is silently dropped so a
        // typo'd key in the admin can never blow up unrelated bindings.
        var SCALARS = {
            tradingName: 'tradingName',
            legalEntity: 'legalEntity',
            gstNumber: 'gstNumber',
            nzbn: 'nzbn',
            phoneDisplay: 'phoneDisplay',
            phoneE164: 'phoneE164',
            email: 'email',
            hoursDisplay: 'hoursDisplay',
            responseSLA: 'responseSLA',
            policyEffectiveDate: 'policyEffectiveDate',
            policyVersion: 'policyVersion',
            privacyOfficerName: 'privacyOfficerName',
            privacyOfficerEmail: 'privacyOfficerEmail',
        };
        var ADDR_KEYS = { street: 1, suburb: 1, city: 1, postcode: 1, country: 1 };

        rows.forEach(function (row) {
            var key = String(row.key || '');
            if (key.indexOf('site_facts.') !== 0) return;
            var sub = key.slice('site_facts.'.length);
            var val = row.value == null ? '' : String(row.value);

            if (SCALARS[sub]) {
                cfg[SCALARS[sub]] = val;
                return;
            }
            if (sub === 'freeShippingThreshold') {
                var num = parseFloat(val);
                if (!isNaN(num) && num >= 0) cfg.freeShippingThreshold = num;
                return;
            }
            if (sub.indexOf('address.') === 0) {
                var addrKey = sub.slice('address.'.length);
                if (ADDR_KEYS[addrKey] && cfg.address) cfg.address[addrKey] = val;
                return;
            }
            // Unknown — ignore, never throw.
        });
    }

    function findHeroEl() {
        return document.querySelector('.legal-page__hero, .about-hero, .contact-page__header');
    }

    function pageContentApply(slug, rows) {
        if (!slug) return;
        var heroPrefix = slug + '.hero';
        var sectionPrefix = slug + '.section.';

        rows.forEach(function (row) {
            var key = String(row.key || '');
            var value = row.value == null ? '' : String(row.value);

            if (key === heroPrefix) {
                var hero = findHeroEl();
                if (hero && value !== '') hero.innerHTML = value;
                return;
            }
            if (key.indexOf(sectionPrefix) === 0) {
                var sectionId = key.slice(sectionPrefix.length);
                if (!sectionId) return;
                var sec = document.querySelector('.policy-section[id="' + cssEscape(sectionId) + '"]');
                if (sec && value !== '') sec.innerHTML = value;
            }
        });
    }

    function cssEscape(str) {
        // Section ids are author-controlled (they come from the HTML), so
        // a strict alnum-dash filter is enough — never trust the override
        // key for selector building.
        return String(str || '').replace(/[^a-zA-Z0-9_-]/g, '');
    }

    function getSupabaseConfig() {
        if (typeof window.Config !== 'undefined' && window.Config.SUPABASE_URL && window.Config.SUPABASE_ANON_KEY) {
            return { url: window.Config.SUPABASE_URL, anon: window.Config.SUPABASE_ANON_KEY };
        }
        return null;
    }

    // Exposed on `window.LegalContent` so the admin page can poke it (e.g.
    // re-apply after a save without a full reload), and so tests can
    // assert the entrypoint exists.
    function fetchOverrides() {
        var sb = getSupabaseConfig();
        if (!sb) return Promise.resolve([]);
        var url = sb.url.replace(/\/+$/, '') + '/rest/v1/legal_content_overrides?select=key,value';
        var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 5000) : null;
        return fetch(url, {
            method: 'GET',
            headers: {
                'apikey': sb.anon,
                'Authorization': 'Bearer ' + sb.anon,
                'Accept': 'application/json',
            },
            signal: ctrl ? ctrl.signal : undefined,
        }).then(function (resp) {
            if (timer) clearTimeout(timer);
            if (!resp.ok) return [];
            return resp.json().catch(function () { return []; });
        }).catch(function () {
            if (timer) clearTimeout(timer);
            return [];
        }).then(function (rows) {
            return Array.isArray(rows) ? rows : [];
        });
    }

    function applyOverrides(rows) {
        if (!Array.isArray(rows) || rows.length === 0) return;
        var slug = detectPageSlug();
        siteFactsApply(rows);
        pageContentApply(slug, rows);
    }

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

    function renderStatic() {
        applyBindings();
        buildTOC();
        wireFAQ();
    }

    function init() {
        // Kick off the override fetch in parallel with rendering. We
        // render the static HTML immediately so the page is interactive
        // even when Supabase is slow / down (the fetch resolves later
        // and re-renders if it returned anything). If the fetch finishes
        // before paint, we apply once before the static render — saving
        // the user a visual swap on the happy path.
        var done = false;
        function applyAndRender(rows) {
            if (done) return;
            done = true;
            try { applyOverrides(rows); } catch (_) { /* fail-open */ }
            renderStatic();
        }
        var p = fetchOverrides();
        // 250ms grace period — long enough for a warm Supabase, short
        // enough that a cold start doesn't visibly delay the page.
        var fallbackTimer = setTimeout(function () { applyAndRender([]); }, 250);
        p.then(function (rows) {
            clearTimeout(fallbackTimer);
            if (done) {
                // Late arrival — we already rendered the defaults. Apply
                // now and re-run bindings/TOC so the swap is consistent.
                try {
                    applyOverrides(rows);
                    applyBindings();
                    buildTOC();
                    wireFAQ();
                } catch (_) { /* fail-open */ }
            } else {
                applyAndRender(rows);
            }
        });
    }

    // Expose for the admin "Legal Content" page (re-apply after save) and
    // for tests asserting the override-fetch entrypoint exists.
    window.LegalContent = {
        fetchOverrides: fetchOverrides,
        applyOverrides: applyOverrides,
        detectPageSlug: detectPageSlug,
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
