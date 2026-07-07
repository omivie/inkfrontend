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
        // Mirrors backend src/utils/trustSignals.js — single source of truth
        // for the Google Ads "Business Transparency" appeal. Updating these
        // values without also updating the backend is a cloaking risk.
        tradingName: 'InkCartridges.co.nz',
        legalEntity: 'Office Consumables Ltd',          // NZ-registered limited company
        gstNumber:   '94-509-459',                      // formatted with dashes — IRD form
        nzbn:        '9429033934204',                   // New Zealand Business Number
        companyNumber: '1853414',                       // NZ Companies Office registration number
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
        email:         'support@inkcartridges.co.nz',
        hoursDisplay:  'Monday – Friday, 9:00am – 5:00pm NZT',
        responseSLA:   'within one business day',

        // Geo (used for LocalBusiness schema + the static map embed on /contact).
        // Pinned to 1/37 Archibald Road — the actual office on the corner of
        // Archlynn Road, opposite Kelston Boys High School.
        geo: { lat: -36.9005, lng: 174.6669 },          // 1/37 Archibald Rd, Kelston

        // ─── Privacy / data handling ──────────────────────────────────────
        privacyOfficerName:  'Privacy Officer, Office Consumables Ltd',
        privacyOfficerEmail: 'support@inkcartridges.co.nz',
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
        handlingTime:           'Auckland metro orders placed before 2:00pm NZT on a business day are dispatched same-day. Orders placed after 2:00pm, on weekends, or on NZ public holidays dispatch the next working day. Outside Auckland metro, dispatch is the next working day after order placement.',
        shippingZones: [
            { zone: 'Auckland metro',        urban: '$7.00', rural: '$14.00', eta: '1–2 working days' },
            { zone: 'North Island',          urban: '$7.00 – $12.00', rural: '$14.00 – $20.00', eta: '1–3 working days' },
            { zone: 'South Island',          urban: '$7.00 – $22.00', rural: '$14.00 – $30.00', eta: '2–4 working days' },
        ],
        // ─── Returns ──────────────────────────────────────────────────────
        // Two windows mirror the backend trustSignals.js contract:
        //   - returnWindowDaysFaulty  — faulty/damaged/incorrect (30 days)
        //   - returnWindowDaysChange  — change-of-mind, unopened (30 days)
        // `returnWindowDays` is preserved as the faulty-default for any
        // historical `[data-legal-bind="return-window"]` binding.
        // Change-of-mind aligned to 30 days (backend SITE_CHANGE_OF_MIND_DAYS,
        // 2026-07-07) so /api/site/trust.returns.change_of_mind_days matches.
        returnWindowDays:        30,
        returnWindowDaysFaulty:  30,
        returnWindowDaysChange:  30,
        compatibleWarrantyMonths: 12,
        dispatchCutoffDisplay:   '2pm NZT, Auckland metro, business days',
        returnsAddressSameAsBusiness: true,
        // CGA-aligned return rules. Note: faulty / not-as-described returns
        // are NEVER time-barred by the 30-day window — that's a Consumer
        // Guarantees Act §43 right which a retailer cannot contract out of
        // for consumer transactions ("In Trade").
        restockingFeePercent:   0,                      // No restocking fee on unopened, change-of-mind returns

        // ─── Invoicing ────────────────────────────────────────────────────
        // Seeds the admin Invoices page seller block + bank-payment footer.
        // Seller identity/address/GST are read from the fields above
        // (legalEntity, gstNumber, formatAddressMultiLine); these are the
        // invoice-specific extras the storefront config doesn't already hold.
        // Values mirror the operator's existing invoice template; the seller
        // block + footer remain editable per-invoice on the page.
        invoice: {
            contactName:    'Trevor Walker',
            phone:          '09 813 3882',          // invoice contact line (differs from storefront phoneDisplay)
            bankAcctName:   'Office Consumables Ltd',
            bankAcctNumber: '01 0186 0335027 00',
            thankYou:       'Thank you very much for your business and for checking out InkCartridges.co.nz.',
        },

        // ─── Operations ───────────────────────────────────────────────────
        paymentMethods: ['Visa', 'Mastercard', 'American Express', 'PayPal', 'Apple Pay', 'Google Pay', 'Klarna'],
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
        // Plain-text disambiguation sentence required by Google Ads
        // "Business Transparency" — surfaced on every page the trading
        // name appears prominently (footer, About hero, contact card).
        // Backend mirror: src/utils/trustSignals.js disambiguationLine().
        disambiguationLine: function () {
            return this.tradingName
                + ' is operated by ' + this.legalEntity
                + ' (NZBN ' + this.nzbn + ', GST ' + this.gstNumber + ').';
        },
        // Returns "© 2026 Office Consumables Ltd. All rights reserved." —
        // the canonical copyright string for SPA + prerender parity. The
        // year is computed at render time so it auto-rolls each Jan 1.
        copyrightLine: function () {
            return '© ' + new Date().getFullYear()
                + ' ' + this.legalEntity + '. All rights reserved.';
        },
    };

    root.LegalConfig = LegalConfig;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
