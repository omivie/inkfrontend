    function initContactForm() {
        const form = document.getElementById('contact-form');
        if (!form) return;

        // Init Turnstile CAPTCHA if configured
        let turnstileToken = null;
        const siteKey = typeof Config !== 'undefined' && Config.TURNSTILE_SITE_KEY;
        function renderTurnstile() {
            if (siteKey && typeof turnstile !== 'undefined') {
                turnstile.render('#contact-turnstile', {
                    sitekey: siteKey,
                    callback: (token) => { turnstileToken = token; },
                    'expired-callback': () => { turnstileToken = null; },
                    'error-callback': () => { showPopup('Security check failed to load. Please refresh the page and try again.', 'error'); }
                });
            }
        }
        if (typeof turnstile !== 'undefined') {
            renderTurnstile();
        } else if (siteKey) {
            // Turnstile script loads async — wait for it
            window.addEventListener('load', renderTurnstile);
        }

        // Self-contained popup notification
        function showPopup(message, type) {
            const existing = document.querySelector('.contact-popup');
            if (existing) existing.remove();

            const popup = document.createElement('div');
            popup.className = 'contact-popup';
            const isSuccess = type === 'success';
            const bg = isSuccess ? '#16a34a' : '#dc2626';
            const icon = isSuccess
                ? '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>'
                : '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';

            popup.innerHTML = `
                <div style="display:flex;align-items:center;gap:16px">
                    <div style="width:54px;height:54px;border-radius:50%;background:${bg};display:flex;align-items:center;justify-content:center;flex-shrink:0">${icon}</div>
                    <span style="color:#1e293b;font-size:21px;font-weight:500;line-height:1.4">${Security.escapeHtml(message)}</span>
                </div>
                <button onclick="this.parentElement.remove()" style="position:absolute;top:12px;right:14px;background:none;border:none;font-size:27px;color:#94a3b8;cursor:pointer;line-height:1">&times;</button>
            `;
            popup.setAttribute('style', `
                position: fixed;
                bottom: 32px;
                right: 32px;
                z-index: 10000;
                background: #fff;
                border: 1px solid #e2e8f0;
                border-radius: 16px;
                padding: 24px 60px 24px 24px;
                box-shadow: 0 12px 40px rgba(0,0,0,0.15);
                max-width: 560px;
                opacity: 0;
                transform: translateY(20px);
                transition: opacity 0.3s ease, transform 0.3s ease;
            `);

            document.body.appendChild(popup);
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    popup.style.opacity = '1';
                    popup.style.transform = 'translateY(0)';
                });
            });

            setTimeout(() => {
                popup.style.opacity = '0';
                popup.style.transform = 'translateY(20px)';
                setTimeout(() => popup.remove(), 300);
            }, 5000);
        }

        form.addEventListener('submit', async (e) => {
            e.preventDefault();

            // Basic validation
            const name = form.querySelector('#contact-name')?.value.trim();
            const email = form.querySelector('#contact-email')?.value.trim();
            const subjectEl = form.querySelector('#contact-subject');
            const subject = subjectEl?.value || '';
            const message = form.querySelector('#contact-message')?.value.trim();
            const phoneCountry = form.querySelector('#contact-phone-country')?.value || '+64';
            const phoneNumber = form.querySelector('#contact-phone')?.value.trim() || '';
            const phone = phoneNumber ? `${phoneCountry}${phoneNumber}` : '';
            const orderNumber = form.querySelector('#contact-order')?.value.trim() || '';

            if (!name || !email || !subject || !message) {
                showPopup('Please fill in all required fields.', 'error');
                return;
            }

            if (message.length < 10) {
                showPopup('Message must be at least 10 characters.', 'error');
                return;
            }

            const btn = form.querySelector('button[type="submit"]');
            const originalHTML = btn.innerHTML;
            btn.innerHTML = 'Sending...';
            btn.disabled = true;

            const payload = { name, email, subject, message };
            if (phone) payload.phone = phone;
            if (orderNumber) payload.order_number = orderNumber;
            if (turnstileToken) payload.turnstile_token = turnstileToken;

            try {
                const result = await API.submitContactForm(payload);
                if (result && result.ok === false) {
                    let msg = 'Could not send message. Please try again.';
                    if (result.details && Array.isArray(result.details)) {
                        msg = result.details.map(d => d.message || d).join(', ');
                    } else if (typeof result.error === 'string') {
                        msg = result.error;
                    }
                    showPopup(msg, 'error');
                } else {
                    showPopup('Message sent! We\'ll get back to you shortly.', 'success');
                    form.reset();
                    turnstileToken = null;
                    if (siteKey && typeof turnstile !== 'undefined') turnstile.reset('#contact-turnstile');
                }
            } catch (error) {
                console.error('Contact form error:', error);
                showPopup(error.message || 'Could not send message. Please try again.', 'error');
                turnstileToken = null;
                if (siteKey && typeof turnstile !== 'undefined') turnstile.reset('#contact-turnstile');
            }

            btn.innerHTML = originalHTML;
            btn.disabled = false;
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initContactForm);
    } else {
        initContactForm();
    }
