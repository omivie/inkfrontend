(function () {
  function initFooter() {
    const footer = document.querySelector('footer.site-footer');
    if (!footer) return;

    const extraClass = footer.className.replace('site-footer', '').trim();

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
                            New Zealand's trusted source for quality printing supplies.
                            We help homes and businesses keep printing with genuine and
                            compatible ink and toner cartridges.
                        </p>
                    </div>

                    <div class="footer-column">
                        <p class="footer-column__heading">Support</p>
                        <ul class="footer-links">
                            <li><a href="/html/contact.html">Contact Us</a></li>
                            <li><a href="/html/business/apply.html">Business Accounts</a></li>
                            <li><a href="/html/terms.html">Terms &amp; Conditions</a></li>
                            <li><a href="/html/privacy.html">Privacy Policy</a></li>
                            <li><a href="/html/returns.html">Returns &amp; Refunds</a></li>
                            <li><a href="/html/shipping">Shipping Information</a></li>
                        </ul>
                    </div>

                    <div class="footer-column">
                        <p class="footer-column__heading">Contact</p>
                        <ul class="footer-links">
                            <li>
                                <strong>Address:</strong><br>
                                37A Archibald Road, Kelston, Auckland 0602, New Zealand
                            </li>
                            <li>
                                <strong>Phone:</strong><br>
                                <a href="tel:+64274740115">027 474 0115</a>
                            </li>
                            <li>
                                <strong>Email:</strong><br>
                                <a href="mailto:inkandtoner@windowslive.com">inkandtoner@windowslive.com</a>
                            </li>
                            <li>
                                <strong>Hours:</strong><br>
                                Mon&ndash;Fri, 9am &ndash; 5pm
                            </li>
                        </ul>
                    </div>
                </div>

                <div class="footer-trust">
                    <div class="footer-trust__item">
                        <svg class="footer-trust__icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                        <span>100% NZ Owned</span>
                    </div>
                    <div class="footer-trust__item">
                        <svg class="footer-trust__icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                        <span>Secure Checkout</span>
                    </div>
                    <div class="footer-trust__item">
                        <svg class="footer-trust__icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>
                        <span>Fast NZ Delivery</span>
                    </div>
                    <div class="footer-trust__item">
                        <svg class="footer-trust__icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                        <span>NZ-Based Support</span>
                    </div>
                </div>
            </div>
        </div>

        <div id="google-reviews-badge"></div>

        <script type="application/ld+json">
        {
            "@context": "https://schema.org",
            "@type": "Organization",
            "name": "InkCartridges.co.nz",
            "url": "https://www.inkcartridges.co.nz",
            "logo": "https://www.inkcartridges.co.nz/logo.png",
            "description": "New Zealand's trusted source for genuine and compatible ink cartridges, toner, and printer supplies.",
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
                "telephone": "+64-27-474-0115",
                "contactType": "customer service",
                "areaServed": "NZ",
                "availableLanguage": "English"
            }
        }
        </script>
        <script type="application/ld+json">
        {
            "@context": "https://schema.org",
            "@type": "WebSite",
            "name": "InkCartridges.co.nz",
            "url": "https://www.inkcartridges.co.nz",
            "potentialAction": {
                "@type": "SearchAction",
                "target": {
                    "@type": "EntryPoint",
                    "urlTemplate": "https://www.inkcartridges.co.nz/html/shop?search={search_term_string}"
                },
                "query-input": "required name=search_term_string"
            }
        }
        </script>
        <script type="application/ld+json">
        {
            "@context": "https://schema.org",
            "@type": "LocalBusiness",
            "name": "InkCartridges.co.nz",
            "url": "https://www.inkcartridges.co.nz",
            "telephone": "+64-27-474-0115",
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
                "latitude": -36.8485,
                "longitude": 174.7633
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
                <p class="footer-copyright">
                    &copy; <span id="current-year"></span> InkCartridges.co.nz. All rights reserved.
                </p>
                <div class="footer-legal">
                    <a href="/html/privacy.html">Privacy Policy</a>
                    <a href="/html/terms.html">Terms &amp; Conditions</a>
                </div>
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

    const yearEl = footer.querySelector('#current-year');
    if (yearEl) yearEl.textContent = new Date().getFullYear();

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
