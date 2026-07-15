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
  // Built lazily, inside initFooter() — NOT at IIFE-evaluation time. footer.js
  // and legal-config.js are both `defer`, which executes in document order, so
  // reading LegalConfig at load time found `undefined` on every page and fell
  // through to the baked-in copies below. The "single source of truth" contract
  // in the header comment was fiction for two months (ERR-070). By the time
  // DOMContentLoaded fires, every deferred script has run and LegalConfig is
  // really there. The fallbacks stay: a bot that fails to fetch legal-config.js
  // must still get a complete, compliant footer.
  function buildTrust() {
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
  }

  // ─── Newsletter subscribe — shared, idempotent binder ────────────────
  // One implementation, bound at most once per form (dataset guard), reused by
  // the footer (every page) and the homepage landing controller. Turnstile stays
  // optional: it only renders when a [data-newsletter-turnstile] host AND the
  // global are present, so the plain footer form submits { email, source }
  // without a token (the backend made Turnstile optional — Jun 2026 handoff).
  //
  // Feedback is INLINE — a .newsletter-feedback aria-live region right under the
  // form, mirroring the contact / track-order / review / cart-coupon pattern.
  // This replaces the old global corner toast, which was easy to miss, was the
  // only form in the app not using inline feedback, and silently no-opped on the
  // few pages that don't load main.js (forgot/reset/verify). ERR-052.
  // FE audit Jun 2026 — surfaced the dormant POST /api/newsletter/subscribe (ERR-049).

  // Inline status pill: empty msg clears + hides; otherwise shows with --kind.
  function setNewsletterFeedback(el, kind, msg) {
    if (!el) return;
    if (!msg) {
      el.hidden = true;
      el.textContent = '';
      el.className = 'newsletter-feedback';
      return;
    }
    el.className = 'newsletter-feedback newsletter-feedback--' + kind;
    el.textContent = msg;
    el.hidden = false;
  }

  // The footer template ships a .newsletter-feedback sibling; for any form bound
  // dynamically (e.g. a standalone landing form) we self-install one so feedback
  // never depends on page markup being present.
  function ensureFeedbackEl(form) {
    const next = form.nextElementSibling;
    if (next && next.classList && next.classList.contains('newsletter-feedback')) return next;
    const adjacent = form.parentNode ? form.parentNode.querySelector('.newsletter-feedback') : null;
    if (adjacent) return adjacent;
    const el = document.createElement('div');
    el.className = 'newsletter-feedback';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.hidden = true;
    form.insertAdjacentElement('afterend', el);
    return el;
  }

  // Map a backend error envelope OR a thrown Error (both carry .code/.status/
  // .request_id/.details after api.js normalisation) to friendly inline copy,
  // aligned to the Jun 2026 contract: 400 VALIDATION_* → invalid-email copy,
  // 429 RATE_LIMITED → the backend's "too many attempts" message, 5xx → hiccup.
  function newsletterErrorMessage(errLike) {
    if (!errLike) return 'Could not subscribe. Please try again.';
    const code = errLike.code || (errLike.error && errLike.error.code) || null;
    const status = typeof errLike.status === 'number' ? errLike.status : null;
    if (Array.isArray(errLike.details) && errLike.details[0] && errLike.details[0].message) {
      return errLike.details[0].message;
    }
    if (code === 'VALIDATION_ERROR' || code === 'VALIDATION_FAILED' || status === 400) {
      return 'Please enter a valid email address.';
    }
    if (code === 'RATE_LIMITED' || status === 429) {
      return (typeof API !== 'undefined' && typeof API.extractErrorMessage === 'function')
        ? API.extractErrorMessage(errLike, 'Too many attempts. Please try again later.')
        : 'Too many attempts. Please try again later.';
    }
    if (code === 'INTERNAL_ERROR' || (status !== null && status >= 500)) {
      const mapped = (typeof API !== 'undefined' && typeof API.mapError === 'function') ? API.mapError(errLike) : null;
      return (mapped && mapped.message) || 'Server hiccup — please try again in a moment.';
    }
    return (typeof API !== 'undefined' && typeof API.extractErrorMessage === 'function')
      ? API.extractErrorMessage(errLike, 'Could not subscribe. Please try again.')
      : (errLike.message || 'Could not subscribe. Please try again.');
  }

  function bindNewsletterForm(form, source) {
    if (!form || form.dataset.nlBound === '1') return;
    form.dataset.nlBound = '1';

    const feedbackEl = ensureFeedbackEl(form);

    let turnstileToken = null;
    const tsHost = form.querySelector('[data-newsletter-turnstile]');
    const siteKey = (typeof Config !== 'undefined' && Config.TURNSTILE_SITE_KEY) || null;
    if (tsHost && siteKey && typeof turnstile !== 'undefined') {
      try {
        turnstile.render(tsHost, {
          sitekey: siteKey,
          callback: (t) => { turnstileToken = t; },
          'expired-callback': () => { turnstileToken = null; },
        });
      } catch (e) { /* non-fatal */ }
    }
    const resetTurnstile = () => {
      turnstileToken = null;
      if (tsHost && siteKey && typeof turnstile !== 'undefined') {
        try { turnstile.reset(tsHost); } catch (e) { /* ignore */ }
      }
    };

    // Dismiss a stale success/error note as soon as the user edits the field.
    const emailAtBind = form.querySelector('input[type="email"]');
    if (emailAtBind) {
      emailAtBind.addEventListener('input', () => setNewsletterFeedback(feedbackEl, null, ''));
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const emailInput = form.querySelector('input[type="email"]');
      const submitBtn = form.querySelector('button[type="submit"]');
      if (!emailInput || !submitBtn) return;
      const email = emailInput.value.trim();
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        emailInput.focus();
        setNewsletterFeedback(feedbackEl, 'error', 'Please enter a valid email address.');
        return;
      }

      const originalText = submitBtn.textContent;
      submitBtn.textContent = 'Subscribing…';
      submitBtn.disabled = true;
      setNewsletterFeedback(feedbackEl, null, ''); // clear any prior note while in-flight

      try {
        if (typeof API === 'undefined' || !API.subscribe) {
          throw new Error('Subscriptions are temporarily unavailable. Please try again later.');
        }
        const payload = { email: email, source: source || 'footer' };
        if (turnstileToken) payload.turnstile_token = turnstileToken;
        const res = await API.subscribe(payload);
        if (res && res.ok === false) {
          if (res.request_id && typeof DebugLog !== 'undefined') {
            DebugLog.warn('[newsletter] subscribe failed', { code: res.code, request_id: res.request_id });
          }
          setNewsletterFeedback(feedbackEl, 'error', newsletterErrorMessage(res));
          resetTurnstile();
          return;
        }
        // Success is intentionally identical for new vs. already-subscribed
        // (anti-enumeration). Prefer the backend's message; the fallback is
        // byte-identical to the live data.message. No welcome-code promise —
        // we intentionally do not issue a newsletter coupon.
        const successMsg = (res && res.data && res.data.message)
          || 'Thanks for subscribing!';
        setNewsletterFeedback(feedbackEl, 'success', successMsg);
        emailInput.value = '';
        resetTurnstile();
      } catch (err) {
        if (err && err.request_id && typeof DebugLog !== 'undefined') {
          DebugLog.warn('[newsletter] subscribe threw', { code: err.code, status: err.status, request_id: err.request_id });
        }
        setNewsletterFeedback(feedbackEl, 'error', newsletterErrorMessage(err));
        resetTurnstile();
      } finally {
        submitBtn.textContent = originalText;
        submitBtn.disabled = false;
      }
    });
  }

  // Expose so the homepage controller (landing.js) delegates here instead of
  // shipping a second copy. footer.js is `defer`-loaded before landing.js, so
  // this global is defined by the time landing.js runs.
  if (typeof window !== 'undefined') {
    window.NewsletterForm = { bind: bindNewsletterForm };
  }

  function initFooter() {
    const footer = document.querySelector('footer.site-footer');
    if (!footer) return;

    const TRUST = buildTrust();

    footer.innerHTML = `
        <div class="footer-stripe" aria-hidden="true"></div>

        <div class="footer-main">
            <div class="container">
                <div class="footer-grid">
                    <div class="footer-brand">
                        <a href="/" class="footer-brand__logo">
                            <img class="logo__icon" src="/apple-touch-icon.png" alt="" aria-hidden="true">
                            <span class="logo__text">Ink<span>Cartridges</span>.co.nz</span>
                        </a>
                        <p class="footer-brand__description">
                            We supply New Zealand homes and businesses with genuine and
                            compatible ink and toner cartridges.
                        </p>
                        <div class="footer-newsletter">
                            <p class="footer-newsletter__text">Get printer tips &amp; deals in your inbox.</p>
                            <form class="newsletter__form footer-newsletter__form" novalidate>
                                <label class="visually-hidden" for="footer-newsletter-email">Email address</label>
                                <input type="email" id="footer-newsletter-email" name="email" class="footer-newsletter__input" placeholder="you@email.com" required autocomplete="email" maxlength="200">
                                <button type="submit" class="footer-newsletter__button">Subscribe</button>
                            </form>
                            <div class="newsletter-feedback" role="status" aria-live="polite" hidden></div>
                        </div>
                    </div>

                    <nav class="footer-column-nav" aria-label="Shop">
                        <details class="footer-column" data-footer-accordion>
                            <summary class="footer-column__heading">Shop</summary>
                            <ul class="footer-links">
                                <li><a href="/ink-cartridges">Ink Cartridges</a></li>
                                <li><a href="/toner-cartridges">Toner Cartridges</a></li>
                                <li><a href="/shop?category=drums">Drum Units</a></li>
                                <li><a href="/ribbons">Printer Ribbons</a></li>
                                <li><a href="/shop">Shop All</a></li>
                            </ul>
                        </details>
                    </nav>

                    <nav class="footer-column-nav" aria-label="Help">
                        <details class="footer-column" data-footer-accordion>
                            <summary class="footer-column__heading">Help</summary>
                            <ul class="footer-links">
                                <li><a href="/track-order">Track Order</a></li>
                                <li><a href="/shipping">Shipping &amp; Delivery</a></li>
                                <li><a href="/returns">Refunds &amp; Returns</a></li>
                                <li><a href="/faq">FAQ</a></li>
                                <li><a href="/contact">Contact Us</a></li>
                            </ul>
                        </details>
                    </nav>

                    <nav class="footer-column-nav" aria-label="Company">
                        <details class="footer-column" data-footer-accordion>
                            <summary class="footer-column__heading">Company</summary>
                            <ul class="footer-links">
                                <li><a href="/about">About Us</a></li>
                                <li><a href="/genuine-vs-compatible">Genuine vs Compatible</a></li>
                                <li><a href="/terms">Terms of Service</a></li>
                                <li><a href="/privacy">Privacy Policy</a></li>
                            </ul>
                        </details>
                    </nav>

                    <details class="footer-column" data-footer-accordion open>
                        <summary class="footer-column__heading">Contact</summary>
                        <address class="footer-contact">
                            <dl class="footer-contact__list">
                                <div class="footer-contact__row">
                                    <dt>Office</dt>
                                    <dd data-legal-bind="address-line">${TRUST.addressLine}</dd>
                                </div>
                                <div class="footer-contact__row">
                                    <dt>Phone</dt>
                                    <dd><a class="footer-contact__digits" data-legal-bind="phone-href" href="tel:${TRUST.phoneE164}"><span data-legal-bind="phone-display">${TRUST.phoneDisp}</span></a></dd>
                                </div>
                                <div class="footer-contact__row">
                                    <dt>Email</dt>
                                    <dd><a data-legal-bind="email-href" href="mailto:${TRUST.email}"><span data-legal-bind="email">${TRUST.email}</span></a></dd>
                                </div>
                                <div class="footer-contact__row">
                                    <dt>Hours</dt>
                                    <dd>Mon&ndash;Fri, 9am &ndash; 5pm</dd>
                                </div>
                            </dl>
                        </address>
                    </details>
                </div>
            </div>
        </div>

        <div class="footer-trust">
            <div class="container">
                <ul class="footer-trust__list">
                    <li class="footer-trust__item">
                        <svg class="footer-trust__icon" aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                        <span class="footer-trust__copy">
                            <span class="footer-trust__headline">NZ-based support</span>
                            <span class="footer-trust__subline">Talk to a real person</span>
                        </span>
                    </li>
                    <li class="footer-trust__item">
                        <svg class="footer-trust__icon" aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>
                        <span class="footer-trust__copy">
                            <span class="footer-trust__headline">Tracked NZ-wide delivery</span>
                            <span class="footer-trust__subline">Every order, door to door</span>
                        </span>
                    </li>
                    <li class="footer-trust__item">
                        <svg class="footer-trust__icon" aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                        <span class="footer-trust__copy">
                            <span class="footer-trust__headline">Secure checkout</span>
                            <span class="footer-trust__subline">Encrypted &amp; card-safe</span>
                        </span>
                    </li>
                    <li class="footer-trust__item">
                        <svg class="footer-trust__icon" aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 3h12l4 4v14H4z"/><path d="M8 9h8M8 13h8M8 17h5"/></svg>
                        <span class="footer-trust__copy">
                            <span class="footer-trust__headline">15% GST included</span>
                            <span class="footer-trust__subline">Prices in NZD, no surprises</span>
                        </span>
                    </li>
                </ul>
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
                <!-- No single-line legal nav here. Every policy surface an ads
                     reviewer looks for (/terms, /privacy, /returns, /shipping,
                     /genuine-vs-compatible, /about, /faq, /contact) is already one
                     click away in the Help + Company columns above, so the row was
                     pure duplication. Removed 2026-07-14 on the owner's call — if
                     you ever drop one of those links from a column, it has to
                     reappear somewhere in the footer, not vanish. -->
                <div class="footer-bottom__row">
                <div class="footer-bottom__legal">
                <p class="footer-copyright" data-legal-bind="copyright">
                    ${TRUST.copyright}
                </p>
                <!-- Google Ads "Business Transparency": the trading name appears
                     prominently in this footer, so the legal entity + NZBN + GST must
                     appear with it. legal-config.js disambiguationLine() is the single
                     source of truth and mirrors backend trustSignals.js — a drift here
                     reads as cloaking. This line was silently lost in the IA reorg and
                     was missing from the rendered footer sitewide until 2026-07-14. -->
                <p class="footer-legal-line">
                    <span data-legal-bind="disambiguation">${TRUST.disambig}</span>
                    Prices in NZD, GST inclusive. No card surcharges.
                </p>
                </div>
                <div class="footer-payment">
                    <span class="footer-payment__label">We accept</span>
                    <div class="footer-payment__cards">
                        <svg class="pay-card" viewBox="0 0 48 30" role="img" aria-label="Visa">
                            <rect width="48" height="30" rx="5" fill="#FFFFFF" stroke="#E6E8EB"/>
                            <text x="24" y="20.5" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="13" font-weight="700" font-style="italic" letter-spacing="0.6" fill="#1434CB">VISA</text>
                        </svg>
                        <svg class="pay-card" viewBox="0 0 48 30" role="img" aria-label="Mastercard">
                            <rect width="48" height="30" rx="5" fill="#FFFFFF" stroke="#E6E8EB"/>
                            <circle cx="20" cy="15" r="7.5" fill="#EB001B"/>
                            <circle cx="28" cy="15" r="7.5" fill="#F79E1B"/>
                            <path d="M24 9.4a7.49 7.49 0 0 0 0 11.2 7.49 7.49 0 0 0 0-11.2Z" fill="#FF5F00"/>
                        </svg>
                        <svg class="pay-card" viewBox="0 0 48 30" role="img" aria-label="American Express">
                            <rect width="48" height="30" rx="5" fill="#FFFFFF" stroke="#E6E8EB"/>
                            <rect x="7" y="9.5" width="34" height="11" rx="1.5" fill="#2E77BC"/>
                            <text x="24" y="18" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="7.5" font-weight="700" letter-spacing="0.3" fill="#FFFFFF">AMEX</text>
                        </svg>
                        <svg class="pay-card" viewBox="0 0 48 30" role="img" aria-label="PayPal">
                            <rect width="48" height="30" rx="5" fill="#FFFFFF" stroke="#E6E8EB"/>
                            <text x="24" y="19.5" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="11" font-weight="700" font-style="italic" letter-spacing="-0.2"><tspan fill="#003087">Pay</tspan><tspan fill="#009CDE">Pal</tspan></text>
                        </svg>
                        <svg class="pay-card" viewBox="0 0 48 30" role="img" aria-label="Google Pay">
                            <rect width="48" height="30" rx="5" fill="#FFFFFF" stroke="#E6E8EB"/>
                            <g transform="translate(9 9.4) scale(0.0225)">
                                <path fill="#4285F4" d="M533.5 278.4c0-18.5-1.5-37.1-4.7-55.3H272.1v104.8h147c-6.1 33.8-25.7 63.7-54.4 82.7v68h87.7c51.5-47.4 81.1-117.4 81.1-200.2z"/>
                                <path fill="#34A853" d="M272.1 544.3c73.4 0 135.3-24.1 180.4-65.7l-87.7-68c-24.4 16.6-55.9 26-92.6 26-71 0-131.2-47.9-152.8-112.3H28.9v70.1c46.2 91.9 140.3 149.9 243.2 149.9z"/>
                                <path fill="#FBBC04" d="M119.3 324.3c-11.4-33.8-11.4-70.4 0-104.2V150H28.9c-38.6 76.9-38.6 167.5 0 244.4l90.4-70.1z"/>
                                <path fill="#EA4335" d="M272.1 107.7c38.8-.6 76.3 14 104.4 40.8l77.7-77.7C405 24.6 339.7-.8 272.1 0 169.2 0 75.1 58 28.9 150l90.4 70.1c21.5-64.5 81.8-112.4 152.8-112.4z"/>
                            </g>
                            <text x="23" y="19.5" font-family="Arial, Helvetica, sans-serif" font-size="11" font-weight="500" fill="#5F6368">Pay</text>
                        </svg>
                        <svg class="pay-card" viewBox="0 0 48 30" role="img" aria-label="Apple Pay">
                            <rect width="48" height="30" rx="5" fill="#FFFFFF" stroke="#E6E8EB"/>
                            <path fill="#000000" transform="translate(11 7.6) scale(0.013)" d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76.5 0-103.7 40.8-165.9 40.8s-105.6-57-155.5-127C46.7 790.7 0 663 0 541.8c0-194.4 126.4-297.5 250.8-297.5 66.1 0 121.2 43.4 162.7 43.4 39.5 0 101.1-46 176.3-46 28.5 0 130.9 2.6 198.3 99.2zm-234-181.5c31.1-36.9 53.1-88.1 53.1-139.3 0-7.1-.6-14.3-1.9-20.1-50.6 1.9-110.8 33.7-147.1 75.8-28.5 32.4-55.1 83.6-55.1 135.5 0 7.8 1.3 15.6 1.9 18.1 3.2.6 8.4 1.3 13.6 1.3 45.4 0 102.5-30.4 135.5-71.3z"/>
                            <text x="25" y="19.5" font-family="Arial, Helvetica, sans-serif" font-size="11" font-weight="600" fill="#000000">Pay</text>
                        </svg>
                        <svg class="pay-card" viewBox="0 0 48 30" role="img" aria-label="Klarna">
                            <rect width="48" height="30" rx="5" fill="#FFFFFF" stroke="#E6E8EB"/>
                            <rect x="7" y="9.5" width="34" height="11" rx="1.5" fill="#FFB3C7"/>
                            <text x="24" y="18" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="7.5" font-weight="700" fill="#0A0B09">Klarna</text>
                        </svg>
                    </div>
                </div>
                </div>
            </div>
        </div>

        <div class="footer-legal">
            <div class="container">
                <p class="footer-disclaimer">
                    All product, brand, and printer names (HP, Canon, Epson, Brother, and others) are trademarks of their respective owners and are used only to indicate compatibility. Compatible cartridges sold on this site are not manufactured, endorsed, or sold by those brand owners; they are supplied by ${TRUST.legalEntity}, trading as ${TRUST.tradingName}. Your statutory rights under the New Zealand Consumer Guarantees Act 1993 are unaffected.
                </p>
            </div>
        </div>`;

    // mobile-parity-may2026 S0.5 — collapse the footer link columns into
    // accordions on mobile (the 4-column grid stacked to a 2,081px wall).
    // <details>/<summary> is natively keyboard-operable. On desktop every
    // column stays expanded (CSS also neuters the summary so it reads as a
    // plain heading); on mobile only Contact stays open, the rest collapse.
    syncFooterAccordions();

    // Wire the newsletter form now that it's in the DOM (idempotent).
    bindNewsletterForm(footer.querySelector('.newsletter__form'), 'footer');
    // The Shop column's four category links are STATIC and hand-curated. The
    // thing the owner killed on 2026-07-02 was the *feed-hydrated* Categories
    // column (GET /api/site/nav), which rendered whatever the feed happened to
    // return — that must not come back, and footer.js must never fetch. The
    // static links were re-added 2026-07-14 because the backend's crawler
    // footer lists these same categories to Googlebot, so humans were seeing
    // fewer links than bots — the wrong side of a cloaking review to be on.
    // Drum Units (/shop?category=drums) was the last bot-only category; it was
    // added here 2026-07-15 so the human Shop column lists the same four the bot
    // does (Ink · Toner · Drum Units · Ribbons) — anti-cloaking §2c, closing the
    // divergence in readfirst/footer-redesign-backend-jul2026.md.

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

  function syncFooterAccordions() {
    const items = document.querySelectorAll('.site-footer [data-footer-accordion]');
    if (!items.length || !window.matchMedia) return;
    const mq = window.matchMedia('(max-width: 768px)');
    // Which column stays open on mobile? The one the template shipped `open`
    // (Contact — the details a phone user actually wants). Read it once, BEFORE
    // the first apply() mutates .open, because the template no longer lists
    // Contact first: the Jul 2026 redesign order is Shop · Help · Company ·
    // Contact, so the old `i === 0` rule would have opened Shop instead.
    let defaultOpen = 0;
    items.forEach((d, i) => { if (d.open) defaultOpen = i; });
    const apply = () => {
      items.forEach((d, i) => {
        // Desktop: every column expanded. Mobile: only the default-open column,
        // so the footer shrinks well under one viewport.
        d.open = mq.matches ? i === defaultOpen : true;
      });
    };
    apply();
    if (mq.addEventListener) mq.addEventListener('change', apply);
    else if (mq.addListener) mq.addListener(apply); // Safari < 14
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initFooter);
  } else {
    initFooter();
  }
})();
