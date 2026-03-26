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
                        <a href="/html/index.html" class="footer-brand__logo">
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
                        </ul>
                    </div>

                    <div class="footer-column">
                        <p class="footer-column__heading">Contact</p>
                        <ul class="footer-links">
                            <li>
                                <strong>Phone:</strong><br>
                                <a href="tel:0274740115">027 474 0115</a>
                            </li>
                            <li>
                                <strong>Email:</strong><br>
                                <a href="mailto:inkandtoner@windowslive.com">inkandtoner@windowslive.com</a>
                            </li>
                            <li>
                                <strong>Hours:</strong><br>
                                8am - 8pm, 7 days a week
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
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initFooter);
  } else {
    initFooter();
  }
})();
