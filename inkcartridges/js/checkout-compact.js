/**
 * CHECKOUT-COMPACT.JS
 * ====================
 * Enhances cart/checkout/payment pages with:
 * 1. Collapsible "Need Help?" support request form
 * 2. Collapsible checkout sections (Order Notes, Billing)
 *
 * IMPORTANT: This script must load AFTER security.js, config.js, and api.js.
 * Does NOT modify Cart, CheckoutPage, or PaymentPage objects.
 */

'use strict';

var CheckoutCompact = (function () {

    // Safe helpers — guard against missing globals
    function escapeHtml(str) {
        if (typeof Security !== 'undefined' && typeof Security.escapeHtml === 'function') {
            return Security.escapeHtml(str);
        }
        var div = document.createElement('div');
        div.appendChild(document.createTextNode(str));
        return div.innerHTML;
    }

    function getApiUrl() {
        if (typeof Config !== 'undefined' && Config.API_URL) {
            return Config.API_URL;
        }
        // Fallback — same origin
        return '';
    }

    // ============================
    // 1. SUPPORT FORM
    // ============================

    function initSupportForms() {
        var toggles = document.querySelectorAll('.support-form__toggle');
        for (var i = 0; i < toggles.length; i++) {
            toggles[i].addEventListener('click', handleToggleClick);
        }

        var forms = document.querySelectorAll('.support-form__form');
        for (var j = 0; j < forms.length; j++) {
            forms[j].addEventListener('submit', handleSupportSubmit);
        }
    }

    function handleToggleClick() {
        var toggle = this;
        var expanded = toggle.getAttribute('aria-expanded') === 'true';
        var newState = !expanded;

        toggle.setAttribute('aria-expanded', String(newState));

        var bodyId = toggle.getAttribute('aria-controls');
        var body = bodyId ? document.getElementById(bodyId) : toggle.nextElementSibling;
        if (body) {
            body.setAttribute('aria-hidden', String(!newState));

            // When collapsing, disable inputs so they aren't tabbable
            var inputs = body.querySelectorAll('input, textarea, select, button');
            for (var k = 0; k < inputs.length; k++) {
                if (newState) {
                    inputs[k].removeAttribute('tabindex');
                } else {
                    inputs[k].setAttribute('tabindex', '-1');
                }
            }
        }
    }

    function handleSupportSubmit(e) {
        e.preventDefault();
        submitSupportForm(this);
    }

    function submitSupportForm(form) {
        var submitBtn = form.querySelector('button[type="submit"]');
        var resultEl = form.querySelector('.support-form__result');
        if (!submitBtn) return;

        // Check honeypot
        var honeypot = form.querySelector('.support-form__hp input');
        if (honeypot && honeypot.value) {
            // Bot detected — silently ignore
            showResult(resultEl, 'success', 'Your request has been sent!');
            form.reset();
            return;
        }

        var name = (form.querySelector('[name="support-name"]') || {}).value || '';
        var email = (form.querySelector('[name="support-email"]') || {}).value || '';
        var phone = (form.querySelector('[name="support-phone"]') || {}).value || '';
        var printer = (form.querySelector('[name="support-printer"]') || {}).value || '';
        var cartridge = (form.querySelector('[name="support-cartridge"]') || {}).value || '';
        var message = (form.querySelector('[name="support-message"]') || {}).value || '';

        // Clear previous result
        if (resultEl) {
            resultEl.textContent = '';
            resultEl.hidden = true;
            resultEl.className = 'support-form__result';
        }

        // Validate required fields: name, email, (printerModel OR cartridgeCode), message
        if (!name.trim()) {
            showResult(resultEl, 'error', 'Please enter your name.');
            return;
        }
        if (!email.trim() || !isValidEmail(email)) {
            showResult(resultEl, 'error', 'Please enter a valid email address.');
            return;
        }
        if (!printer.trim() && !cartridge.trim()) {
            showResult(resultEl, 'error', 'Please enter either your printer model or cartridge code (or both).');
            return;
        }
        if (!message.trim()) {
            showResult(resultEl, 'error', 'Please enter a message describing how we can help.');
            return;
        }

        var originalText = submitBtn.textContent;
        submitBtn.disabled = true;
        submitBtn.textContent = 'Sending\u2026';

        // Build message with printer/cartridge context
        var fullMessage = message.trim();
        var details = [];
        if (printer.trim()) details.push('Printer: ' + printer.trim());
        if (cartridge.trim()) details.push('Cartridge: ' + cartridge.trim());
        if (details.length) fullMessage = details.join(' | ') + '\n\n' + fullMessage;

        var payload = {
            name: name.trim(),
            email: email.trim(),
            subject: 'Support Request — ' + (cartridge.trim() || printer.trim() || 'General'),
            message: fullMessage,
            phone: phone.trim() || undefined
        };

        var apiUrl = getApiUrl();
        var url = apiUrl ? apiUrl + '/api/contact' : '/api/contact';

        fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        })
        .then(function (response) {
            return response.json().then(function (data) {
                if (response.ok && data.ok) {
                    showResult(resultEl, 'success',
                        'Your request has been sent! We\'ll get back to you within 1 business day.');
                    form.reset();
                } else {
                    var errMsg = (data.error && typeof data.error === 'object') ? data.error.message : (data.error || 'Failed to send request.');
                    throw new Error(errMsg);
                }
            });
        })
        .catch(function (error) {
            showResult(resultEl, 'error',
                error.message || 'Something went wrong. Please try again or call 027 474 0115.');
        })
        .finally(function () {
            submitBtn.disabled = false;
            submitBtn.textContent = originalText;
        });
    }

    function showResult(el, type, message) {
        if (!el) return;
        el.className = 'support-form__result support-form__result--' + type;
        el.textContent = escapeHtml(message);
        el.hidden = false;
    }

    function isValidEmail(email) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    }


    // ============================
    // 2. COLLAPSIBLE SECTIONS
    // ============================

    function initCollapsibleSections() {
        var sections = document.querySelectorAll('.checkout-section--collapsible');
        for (var i = 0; i < sections.length; i++) {
            var section = sections[i];
            var heading = section.querySelector('.checkout-section__heading');
            var content = section.querySelector('.checkout-section__collapsible-content');
            if (!heading || !content) continue;

            heading.setAttribute('role', 'button');
            heading.setAttribute('tabindex', '0');

            var isExpanded = section.classList.contains('is-expanded');
            heading.setAttribute('aria-expanded', String(isExpanded));

            // When collapsed, disable tabbability of inner inputs
            if (!isExpanded) {
                setContentTabbable(content, false);
            }

            heading.addEventListener('click', createToggleHandler(section, heading, content));
            heading.addEventListener('keydown', function (e) {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    this.click();
                }
            });
        }
    }

    function createToggleHandler(section, heading, content) {
        return function () {
            var isExpanded = section.classList.toggle('is-expanded');
            heading.setAttribute('aria-expanded', String(isExpanded));
            setContentTabbable(content, isExpanded);
        };
    }

    function setContentTabbable(content, tabbable) {
        var focusable = content.querySelectorAll('input, textarea, select, button, a[href]');
        for (var i = 0; i < focusable.length; i++) {
            if (tabbable) {
                focusable[i].removeAttribute('tabindex');
            } else {
                focusable[i].setAttribute('tabindex', '-1');
            }
        }
    }




    // ============================
    // 4. SUPPORT FORM INITIAL STATE
    // ============================

    function initSupportFormsCollapsed() {
        // Ensure all support form bodies start collapsed and not tabbable
        var bodies = document.querySelectorAll('.support-form__body');
        for (var i = 0; i < bodies.length; i++) {
            var body = bodies[i];
            body.setAttribute('aria-hidden', 'true');
            var inputs = body.querySelectorAll('input, textarea, select, button');
            for (var k = 0; k < inputs.length; k++) {
                inputs[k].setAttribute('tabindex', '-1');
            }
        }
    }




    // ============================
    // INIT
    // ============================

    function init() {
        initSupportFormsCollapsed();
        initSupportForms();
        initCollapsibleSections();

    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    return { init: init };
})();
