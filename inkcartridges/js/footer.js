/**
 * FOOTER.JS — site-wide footer mounted into <footer class="site-footer">.
 *
 * Google Ads "Business Transparency" contract (May 2026):
 *   - Copyright line names the legal entity (Office Consumables Ltd),
 *     not the trading name. Backend prerender mirrors this.
 *   - Disambiguation sentence is rendered in <small> beneath the © line
 *     so bots + real browsers see the same NZBN + GST identifiers.
 *   - Organization / LocalBusiness JSON-LD carry legalName + alternateName
 *     + email, matching backend trustSignals.js output. Without this,
 *     Google sees mismatched schema between the bot render and the
 *     hydrated SPA and rejects the appeal as cloaking.
 *
 * All business-fact strings come from LegalConfig (single source of
 * truth, mirrors backend src/utils/trustSignals.js). If LegalConfig
 * hasn't loaded yet we fall back to baked-in constants so the footer
 * is never blank for bots.
 */
(function () {
  // ─── Canonical business facts ────────────────────────────────────────
  const TRUST = (function () {
    const cfg = (typeof LegalConfig !== 'undefined' && LegalConfig) ? LegalConfig : null;
    return {
      tradingName : cfg ? cfg.tradingName : 'InkCartridges.co.nz',
      legalEntity : cfg ? cfg.legalEntity : 'Office Consumables Ltd',
      nzbn        : cfg ? cfg.nzbn        : '9429033934204',
      gstNumber   : cfg ? cfg.gstNumber   : '94-509-459',
      addressLine : cfg ? cfg.formatAddressOneLine() : '37A Archibald Road, Kelston, Auckland 0602, New Zealand',
      phoneDisp   : cfg ? cfg.phoneDisplay : '027 474 0115',
      phoneE164   : cfg ? cfg.phoneE164    : '+64274740115',
      phoneSchema : '+64-27-474-0115',
      email       : cfg ? cfg.email        : 'support@inkcartridges.co.nz',
      disambig    : cfg ? cfg.disambiguationLine()
                        : 'InkCartridges.co.nz is operated by Office Consumables Ltd (NZBN 9429033934204, GST 94-509-459).',
      copyright   : cfg ? cfg.copyrightLine()
                        : '© ' + new Date().getFullYear() + ' Office Consumables Ltd. All rights reserved.',
    };
  })();

  function initFooter() {
    const footer = document.querySelector('footer.site-footer');
    if (!footer) return;

    footer.innerHTML = `
        <div class="footer-main">
            <div class="container">
                <div class="footer-grid">
                    <div class="footer-brand">
                        <a href="/" class="footer-brand__logo">
                            <img class="logo__icon" src="https://lmdlgldjgcanknsjrcxh.supabase.co/storage/v1/object/public/public-assets/images/site/inklogo.png" alt="" aria-hidden="true">
                            <span class="logo__text">Ink<span>Cartridges</span>.co.nz</span>
                        </a>
                        <p class="footer-brand__description">
                            We supply New Zealand homes and businesses with genuine and
                            compatible ink and toner cartridges.
                        </p>
                        <p class="footer-brand__disambiguation" data-legal-bind="disambiguation">${TRUST.disambig}</p>
                    </div>

                    <div class="footer-column">
                        <p class="footer-column__heading">Contact</p>
                        <ul class="footer-links">
                            <li>
                                <strong>Office:</strong><br>
                                <span data-legal-bind="address-line">${TRUST.addressLine}</span>
                            </li>
                            <li>
                                <strong>Phone:</strong><br>
                                <a data-legal-bind="phone-href" href="tel:${TRUST.phoneE164}"><span data-legal-bind="phone-display">${TRUST.phoneDisp}</span></a>
                            </li>
                            <li>
                                <strong>Email:</strong><br>
                                <a data-legal-bind="email-href" href="mailto:${TRUST.email}"><span data-legal-bind="email">${TRUST.email}</span></a>
                            </li>
                            <li>
                                <strong>Hours:</strong><br>
                                Mon&ndash;Fri, 9am &ndash; 5pm
                            </li>
                        </ul>
                    </div>

                    <div class="footer-column">
                        <p class="footer-column__heading">Information</p>
                        <ul class="footer-links">
                            <li><a href="/about">About Us</a></li>
                            <li><a href="/contact">Contact Us</a></li>
                            <li><a href="/faq">FAQ</a></li>
                            <li><a href="/shop">Shop All</a></li>
                        </ul>
                    </div>

                    <div class="footer-column">
                        <p class="footer-column__heading">Policies</p>
                        <ul class="footer-links">
                            <li><a href="/shipping">Shipping &amp; Delivery</a></li>
                            <li><a href="/returns">Refunds &amp; Returns</a></li>
                            <li><a href="/terms">Terms of Service</a></li>
                            <li><a href="/privacy">Privacy Policy</a></li>
                        </ul>
                    </div>
                </div>

                <div class="footer-trust">
                    <div class="footer-trust__item">
                        <svg class="footer-trust__icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                        <span>NZ-based support</span>
                    </div>
                    <div class="footer-trust__item">
                        <svg class="footer-trust__icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>
                        <span>Tracked NZ-wide delivery</span>
                    </div>
                    <div class="footer-trust__item">
                        <svg class="footer-trust__icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                        <span>Secure checkout</span>
                    </div>
                    <div class="footer-trust__item">
                        <svg class="footer-trust__icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
                        <span>15% GST included</span>
                    </div>
                </div>
            </div>
        </div>

        <div id="google-reviews-badge"></div>

        <script type="application/ld+json" id="site-jsonld-organization">
        {
            "@context": "https://schema.org",
            "@type": "Organization",
            "name": "${TRUST.legalEntity}",
            "legalName": "${TRUST.legalEntity}",
            "alternateName": "${TRUST.tradingName}",
            "url": "https://www.inkcartridges.co.nz",
            "logo": "https://www.inkcartridges.co.nz/logo.png",
            "email": "${TRUST.email}",
            "telephone": "${TRUST.phoneSchema}",
            "taxID": "${TRUST.gstNumber}",
            "identifier": [
                { "@type": "PropertyValue", "propertyID": "NZBN", "value": "${TRUST.nzbn}" },
                { "@type": "PropertyValue", "propertyID": "GST",  "value": "${TRUST.gstNumber}" }
            ],
            "description": "New Zealand supplier of genuine and compatible ink cartridges, toner, and printer supplies.",
            "address": {
                "@type": "PostalAddress",
                "streetAddress": "37A Archibald Road",
                "addressLocality": "Kelston, Auckland",
                "addressRegion": "Auckland",
                "postalCode": "0602",
                "addressCountry": "NZ"
            },
            "contactPoint": {
                "@type": "ContactPoint",
                "telephone": "${TRUST.phoneSchema}",
                "email": "${TRUST.email}",
                "contactType": "customer service",
                "areaServed": "NZ",
                "availableLanguage": "English"
            }
        }
        </script>
        <script type="application/ld+json" id="site-jsonld-website">
        {
            "@context": "https://schema.org",
            "@type": "WebSite",
            "name": "${TRUST.tradingName}",
            "url": "https://www.inkcartridges.co.nz",
            "publisher": { "@type": "Organization", "name": "${TRUST.legalEntity}" },
            "potentialAction": {
                "@type": "SearchAction",
                "target": {
                    "@type": "EntryPoint",
                    "urlTemplate": "https://www.inkcartridges.co.nz/shop?q={search_term_string}"
                },
                "query-input": "required name=search_term_string"
            }
        }
        </script>
        <script type="application/ld+json" id="site-jsonld-localbusiness">
        {
            "@context": "https://schema.org",
            "@type": "LocalBusiness",
            "name": "${TRUST.legalEntity}",
            "legalName": "${TRUST.legalEntity}",
            "alternateName": "${TRUST.tradingName}",
            "url": "https://www.inkcartridges.co.nz",
            "telephone": "${TRUST.phoneSchema}",
            "email": "${TRUST.email}",
            "taxID": "${TRUST.gstNumber}",
            "identifier": [
                { "@type": "PropertyValue", "propertyID": "NZBN", "value": "${TRUST.nzbn}" },
                { "@type": "PropertyValue", "propertyID": "GST",  "value": "${TRUST.gstNumber}" }
            ],
            "address": {
                "@type": "PostalAddress",
                "streetAddress": "37A Archibald Road",
                "addressLocality": "Kelston, Auckland",
                "addressRegion": "Auckland",
                "postalCode": "0602",
                "addressCountry": "NZ"
            },
            "geo": {
                "@type": "GeoCoordinates",
                "latitude": -36.9005,
                "longitude": 174.6669
            },
            "priceRange": "$$",
            "currenciesAccepted": "NZD",
            "areaServed": { "@type": "Country", "name": "New Zealand" },
            "openingHoursSpecification": {
                "@type": "OpeningHoursSpecification",
                "dayOfWeek": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
                "opens": "09:00",
                "closes": "17:00"
            }
        }
        </script>

        <div class="footer-bottom">
            <div class="container">
                <nav class="footer-legal-nav" aria-label="Policies and information">
                    <ul>
                        <li><a href="/terms">Terms of Service</a></li>
                        <li class="footer-legal-nav__sep" aria-hidden="true">&middot;</li>
                        <li><a href="/privacy">Privacy Policy</a></li>
                        <li class="footer-legal-nav__sep" aria-hidden="true">&middot;</li>
                        <li><a href="/returns">Refunds &amp; Returns</a></li>
                        <li class="footer-legal-nav__sep" aria-hidden="true">&middot;</li>
                        <li><a href="/shipping">Shipping &amp; Delivery</a></li>
                        <li class="footer-legal-nav__sep" aria-hidden="true">&middot;</li>
                        <li><a href="/about">About Us</a></li>
                        <li class="footer-legal-nav__sep" aria-hidden="true">&middot;</li>
                        <li><a href="/faq">FAQ</a></li>
                        <li class="footer-legal-nav__sep" aria-hidden="true">&middot;</li>
                        <li><a href="/contact">Contact</a></li>
                    </ul>
                </nav>
                <p class="footer-copyright" data-legal-bind="copyright">
                    ${TRUST.copyright}
                </p>
                <p class="footer-disambiguation"><small data-legal-bind="disambiguation">${TRUST.disambig}</small></p>
                <p class="footer-fineprint"><small>Prices in NZD, 15% GST included. No card surcharges.</small></p>
                <div class="footer-payment">
                    <span class="footer-payment__label">We accept:</span>
                    <div class="footer-payment__icons">
                        <span title="Visa">Visa</span>
                        <span title="Mastercard">Mastercard</span>
                        <span title="PayPal">PayPal</span>
                    </div>
                </div>
            </div>
        </div>`;

    // Google Customer Reviews - badge + opt-in survey loader
    (function () {
      window.___gcfg = { lang: 'en_NZ' };
      var originalOptIn = window.renderOptIn;

      window.renderOptIn = function () {
        // Badge on all pages
        window.gapi.load('ratingbadge', function () {
          window.gapi.ratingbadge.render(
            document.getElementById('google-reviews-badge'),
            { merchant_id: 5748243992, position: 'BOTTOM_RIGHT' }
          );
        });
        // Opt-in survey on order confirmation page
        window.gapi.load('surveyoptin', function () {
          if (window._googleReviewsOptInData) {
            window.gapi.surveyoptin.render(window._googleReviewsOptInData);
          }
        });
      };

      if (!document.querySelector('script[src*="apis.google.com/js/platform.js"]')) {
        var s = document.createElement('script');
        s.src = 'https://apis.google.com/js/platform.js?onload=renderOptIn';
        s.async = true;
        s.defer = true;
        document.head.appendChild(s);
      } else if (window.gapi) {
        // platform.js already loaded — render badge directly
        window.gapi.load('ratingbadge', function () {
          window.gapi.ratingbadge.render(
            document.getElementById('google-reviews-badge'),
            { merchant_id: 5748243992, position: 'BOTTOM_RIGHT' }
          );
        });
      }
    })();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initFooter);
  } else {
    initFooter();
  }
})();
