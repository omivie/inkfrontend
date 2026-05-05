/**
 * LEGAL-CONFIG.JS
 * ===============
 * Single source of truth for every business variable used across the
 * compliance / legal / info pages (Terms, Privacy, Returns, Shipping,
 * About, FAQ, Contact). Updating any value here propagates to all
 * pages on the next render — never hardcode these in HTML.
 *
 * Pulls the existing storefront facts (address, phone, email, hours,
 * free-shipping threshold) so the legal pages stay consistent with the
 * rest of the site.
 *
 * Optional fields (gstNumber, nzbn) render conditionally — leave the
 * empty string to hide. Do NOT fill these with placeholders; the pages
 * deliberately omit them rather than risk misrepresentation.
 */
(function (root) {
    'use strict';

    var FREE_SHIPPING_THRESHOLD = (
        typeof Config !== 'undefined' && Config.FREE_SHIPPING_THRESHOLD
    ) || 100;

    var LegalConfig = {
        // ─── Identity ─────────────────────────────────────────────────────
        tradingName: 'InkCartridges.co.nz',
        legalEntity: 'InkCartridges.co.nz',           // Sole trader / operating name
        gstNumber:   '',                                // e.g. '123-456-789' — empty hides the line
        nzbn:        '',                                // e.g. '9429012345678' — empty hides the line
        nzOwned:     true,                              // controls "100% NZ Owned" framing

        // ─── Contact ──────────────────────────────────────────────────────
        address: {
            street:     '37A Archibald Road',
            suburb:     'Kelston',
            city:       'Auckland',
            postcode:   '0602',
            country:    'New Zealand',
            countryISO: 'NZ',
        },
        phoneDisplay:  '027 474 0115',
        phoneE164:     '+64274740115',
        email:         'inkandtoner@windowslive.com',
        hoursDisplay:  'Monday – Friday, 9:00am – 5:00pm NZT',
        responseSLA:   'within one business day',

        // Geo (used for LocalBusiness schema + the static map embed on /contact).
        geo: { lat: -36.9020, lng: 174.6555 },          // Kelston, Auckland

        // ─── Privacy / data handling ──────────────────────────────────────
        privacyOfficerName:  'Privacy Officer, InkCartridges.co.nz',
        privacyOfficerEmail: 'inkandtoner@windowslive.com',
        // Cookie / processor disclosure — every party in our CSP that
        // touches user data, named explicitly so the Privacy Policy is
        // not vague (Privacy Act 2020 §22 IPP3 transparency requirement).
        dataProcessors: [
            { name: 'Supabase, Inc.',           purpose: 'Account, authentication, and order data hosting',     region: 'United States / EU' },
            { name: 'Stripe Payments NZ Ltd.',  purpose: 'Card payment processing',                              region: 'New Zealand / United States' },
            { name: 'PayPal Pte. Ltd.',         purpose: 'PayPal payment processing',                            region: 'Singapore / United States' },
            { name: 'Render Services, Inc.',    purpose: 'Backend application hosting',                          region: 'United States' },
            { name: 'Vercel Inc.',              purpose: 'Frontend hosting and CDN',                             region: 'Global edge / United States' },
            { name: 'Cloudflare, Inc.',         purpose: 'Bot protection (Turnstile CAPTCHA) and edge security', region: 'Global edge / United States' },
            { name: 'Google LLC',               purpose: 'Analytics (GA4), Customer Reviews, Tag Manager',       region: 'United States' },
            { name: 'New Zealand Post Ltd.',    purpose: 'Order delivery (tracked courier)',                     region: 'New Zealand' },
            { name: 'Aramex New Zealand Ltd.',  purpose: 'Order delivery (tracked courier)',                     region: 'New Zealand' },
        ],
        cookies: [
            { category: 'Strictly necessary',    examples: 'Session, cart, CSRF, Cloudflare Turnstile',       optional: false },
            { category: 'Functional',            examples: 'Saved address, login persistence (Supabase)',     optional: false },
            { category: 'Analytics',             examples: 'Google Analytics 4 (anonymised IP)',              optional: true  },
            { category: 'Advertising / reviews', examples: 'Google Customer Reviews opt-in survey',           optional: true  },
        ],

        // ─── Shipping ─────────────────────────────────────────────────────
        // These mirror inkcartridges/js/shipping.js so the policy text
        // stays in lock-step with the calculator. Update both together.
        currency:               'NZD',
        currencySymbol:         '$',
        freeShippingThreshold:  FREE_SHIPPING_THRESHOLD,
        carriers:               ['NZ Post', 'Aramex (CourierPost network)'],
        handlingTime:           'Same-day dispatch on orders placed before 2:00pm NZT, Monday – Friday. Orders placed after 2:00pm, on weekends, or on NZ public holidays dispatch the next working day.',
        shippingZones: [
            { zone: 'Auckland metro',        urban: '$7.00', rural: '$14.00', eta: '1–2 working days' },
            { zone: 'North Island',          urban: '$7.00 – $12.00', rural: '$14.00 – $20.00', eta: '1–3 working days' },
            { zone: 'South Island',          urban: '$7.00 – $22.00', rural: '$14.00 – $30.00', eta: '2–4 working days' },
        ],
        // Dropshipping transparency — a small minority of low-volume SKUs
        // are dispatched directly from the supplier's NZ warehouse, which
        // adds 1–2 business days to handling. The product page surfaces
        // this on a per-SKU basis; the policy explains the model in prose.
        supplierFulfillment:    'Most stocked SKUs ship from our Auckland warehouse. A small number of low-velocity SKUs are dispatched directly by our New Zealand supplier partners; this is disclosed on the relevant product page and adds 1–2 working days to handling.',

        // ─── Returns ──────────────────────────────────────────────────────
        returnWindowDays:       30,
        returnsAddressSameAsBusiness: true,
        // CGA-aligned return rules. Note: faulty / not-as-described returns
        // are NEVER time-barred by the 30-day window — that's a Consumer
        // Guarantees Act §43 right which a retailer cannot contract out of
        // for consumer transactions ("In Trade").
        restockingFeePercent:   0,                      // No restocking fee on unopened, change-of-mind returns

        // ─── Operations ───────────────────────────────────────────────────
        paymentMethods: ['Visa', 'Mastercard', 'American Express', 'PayPal', 'Apple Pay', 'Google Pay'],
        // Effective / last-updated date for all policy pages. Bumped on
        // any substantive policy change. Read by legal-page.js to render
        // the "Last updated" stamp.
        policyEffectiveDate:    '2026-05-05',
        policyVersion:          '2026.05',

        // ─── Helpers ──────────────────────────────────────────────────────
        formatAddressOneLine: function () {
            var a = this.address;
            return a.street + ', ' + a.suburb + ', ' + a.city + ' ' + a.postcode + ', ' + a.country;
        },
        formatAddressMultiLine: function () {
            var a = this.address;
            return [a.street, a.suburb + ', ' + a.city + ' ' + a.postcode, a.country];
        },
        formatPolicyDate: function () {
            // Renders "5 May 2026" from policyEffectiveDate ISO string.
            var parts = (this.policyEffectiveDate || '').split('-');
            if (parts.length !== 3) return this.policyEffectiveDate || '';
            var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
            var d = parseInt(parts[2], 10);
            var m = parseInt(parts[1], 10) - 1;
            var y = parts[0];
            if (isNaN(d) || isNaN(m) || m < 0 || m > 11) return this.policyEffectiveDate;
            return d + ' ' + months[m] + ' ' + y;
        },
        // True if any GST/NZBN identifier was filled in. Used to gate the
        // "GST registration" line on the legal pages — we never render the
        // line empty, since "GST: " with no number reads as a defect.
        hasTaxIdentifiers: function () {
            return !!(this.gstNumber || this.nzbn);
        },
    };

    root.LegalConfig = LegalConfig;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
