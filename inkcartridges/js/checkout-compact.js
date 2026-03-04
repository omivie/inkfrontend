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
    // 5. ACCORDION CHECKOUT
    // ============================

    var SECTIONS = [
        { key: 'contact',  label: 'Contact Information', requiredIds: ['email', 'phone'] },
        { key: 'shipping', label: 'Shipping Address',    requiredIds: ['first-name', 'last-name', 'address1', 'city', 'region', 'postcode'] }
    ];

    var accFieldsets = [];  // populated in initAccordion
    var accCurrentKey = null;

    function initAccordion() {
        var form = document.getElementById('checkout-form');
        if (!form) return;

        var fieldsets = form.querySelectorAll('[data-acc-section]');
        if (fieldsets.length === 0) return;

        // Add accordion marker class to form
        form.classList.add('checkout-form--accordion');

        // Build fieldset map
        for (var i = 0; i < SECTIONS.length; i++) {
            var sec = SECTIONS[i];
            var fs = form.querySelector('[data-acc-section="' + sec.key + '"]');
            if (!fs) continue;
            accFieldsets.push({ key: sec.key, label: sec.label, requiredIds: sec.requiredIds, el: fs, index: i });
        }

        // Inject accordion UI into each fieldset
        for (var j = 0; j < accFieldsets.length; j++) {
            setupAccordionSection(accFieldsets[j], j);
        }

        // Open first section
        openSection('contact');

        // Listen for continue-to-payment click
        var payBtn = document.getElementById('continue-to-payment-btn');
        if (payBtn) {
            payBtn.addEventListener('click', function (e) {
                var incomplete = findFirstIncompleteSection();
                if (incomplete) {
                    e.stopImmediatePropagation();
                    openSection(incomplete.key);
                    var firstInvalid = getFirstInvalidField(incomplete);
                    if (firstInvalid) {
                        firstInvalid.reportValidity();
                        firstInvalid.focus();
                    }
                }
            });
        }
    }

    function setupAccordionSection(sec, index) {
        var fs = sec.el;
        var legend = fs.querySelector('legend');
        var stepNum = index + 1;
        var panelId = 'acc-panel-' + sec.key;

        // --- Create accordion header button ---
        var header = document.createElement('button');
        header.type = 'button';
        header.className = 'acc-header';
        header.setAttribute('aria-expanded', 'false');
        header.setAttribute('aria-controls', panelId);

        // Step circle with number + check
        header.innerHTML =
            '<span class="acc-step">' +
                '<span class="acc-step-num">' + stepNum + '</span>' +
                '<span class="acc-check"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>' +
            '</span>' +
            '<span class="acc-label">' + escapeHtml(sec.label) + '</span>' +
            '<svg class="acc-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>';

        // --- Create summary line (shown when collapsed + complete) ---
        var summary = document.createElement('div');
        summary.className = 'acc-summary';
        summary.setAttribute('aria-hidden', 'true');

        // --- Create panel wrapper ---
        var panel = document.createElement('div');
        panel.className = 'acc-panel';
        panel.id = panelId;
        panel.setAttribute('role', 'region');
        panel.setAttribute('hidden', '');

        // Move all children after legend into panel
        var children = [];
        var child = legend.nextSibling;
        while (child) {
            children.push(child);
            child = child.nextSibling;
        }
        for (var c = 0; c < children.length; c++) {
            panel.appendChild(children[c]);
        }

        // Add "Next" button for contact, shipping, billing (not notes)
        if (sec.key !== 'notes') {
            var nextSec = getNextSection(sec.key);
            if (nextSec) {
                var nextBtn = document.createElement('button');
                nextBtn.type = 'button';
                nextBtn.className = 'acc-next btn btn--primary btn--sm';
                nextBtn.textContent = 'Next: ' + nextSec.label;
                nextBtn.addEventListener('click', createNextHandler(sec, nextSec));
                panel.appendChild(nextBtn);
            }
        }

        // Insert into fieldset: header, summary, panel (legend stays but is hidden via CSS)
        fs.appendChild(header);
        fs.appendChild(summary);
        fs.appendChild(panel);

        // Header click toggles
        header.addEventListener('click', function () {
            var isOpen = header.getAttribute('aria-expanded') === 'true';
            if (isOpen) {
                closeSection(sec.key);
            } else {
                openSection(sec.key);
            }
        });

        // Auto-advance: listen for blur on required fields
        var reqIds = getEffectiveRequiredIds(sec);
        for (var r = 0; r < reqIds.length; r++) {
            var input = document.getElementById(reqIds[r]);
            if (input) {
                input.addEventListener('blur', createBlurHandler(sec));
            }
        }

        // Completion re-evaluation on input/change
        fs.addEventListener('input', function () { updateCompletion(sec); });
        fs.addEventListener('change', function () { updateCompletion(sec); });
    }

    function createNextHandler(currentSec, nextSec) {
        return function () {
            if (isSectionComplete(currentSec)) {
                openSection(nextSec.key);
            } else {
                var firstInvalid = getFirstInvalidField(currentSec);
                if (firstInvalid) {
                    firstInvalid.reportValidity();
                    firstInvalid.focus();
                }
            }
        };
    }

    function createBlurHandler(sec) {
        return function () {
            // Short delay to allow focus to settle
            setTimeout(function () {
                if (isSectionComplete(sec)) {
                    var next = getNextSection(sec.key);
                    if (next) {
                        openSection(next.key);
                    }
                }
                updateCompletion(sec);
            }, 100);
        };
    }

    function openSection(key) {
        accCurrentKey = key;
        for (var i = 0; i < accFieldsets.length; i++) {
            var sec = accFieldsets[i];
            var fs = sec.el;
            var header = fs.querySelector('.acc-header');
            var panel = fs.querySelector('.acc-panel');
            var summaryEl = fs.querySelector('.acc-summary');

            if (sec.key === key) {
                if (header) header.setAttribute('aria-expanded', 'true');
                if (panel) panel.removeAttribute('hidden');
                if (summaryEl) summaryEl.style.display = 'none';
            } else {
                if (header) header.setAttribute('aria-expanded', 'false');
                if (panel) panel.setAttribute('hidden', '');
                // Show summary if section is complete
                if (summaryEl) {
                    var hasCustomContent = summaryEl.querySelector('.saved-address-picker__buttons');
                    if (hasCustomContent) {
                        // Custom picker already in summary — just show/hide based on completion
                        summaryEl.style.display = isSectionComplete(sec) ? '' : 'none';
                    } else {
                        var text = getSummaryText(sec);
                        if (text && isSectionComplete(sec)) {
                            summaryEl.textContent = text;
                            summaryEl.style.display = '';
                        } else {
                            summaryEl.style.display = 'none';
                        }
                    }
                }
            }
            updateCompletion(sec);
        }
    }

    function closeSection(key) {
        for (var i = 0; i < accFieldsets.length; i++) {
            if (accFieldsets[i].key === key) {
                var fs = accFieldsets[i].el;
                var header = fs.querySelector('.acc-header');
                var panel = fs.querySelector('.acc-panel');
                if (header) header.setAttribute('aria-expanded', 'false');
                if (panel) panel.setAttribute('hidden', '');
                accCurrentKey = null;
                // Show summary if complete
                var summaryEl = fs.querySelector('.acc-summary');
                if (summaryEl) {
                    var hasCustomContent = summaryEl.querySelector('.saved-address-picker__buttons');
                    if (hasCustomContent) {
                        summaryEl.style.display = isSectionComplete(accFieldsets[i]) ? '' : 'none';
                    } else {
                        var text = getSummaryText(accFieldsets[i]);
                        if (text && isSectionComplete(accFieldsets[i])) {
                            summaryEl.textContent = text;
                            summaryEl.style.display = '';
                        } else {
                            summaryEl.style.display = 'none';
                        }
                    }
                }
                break;
            }
        }
    }

    function getEffectiveRequiredIds(sec) {
        return sec.requiredIds;
    }

    function isSectionComplete(sec) {
        var ids = getEffectiveRequiredIds(sec);
        for (var i = 0; i < ids.length; i++) {
            var input = document.getElementById(ids[i]);
            if (!input) continue;
            if (!input.value || !input.checkValidity()) return false;
        }
        return ids.length > 0;
    }

    function updateCompletion(sec) {
        var complete = isSectionComplete(sec);
        if (complete) {
            sec.el.classList.add('is-complete');
        } else {
            sec.el.classList.remove('is-complete');
        }
    }

    function getFirstInvalidField(sec) {
        var ids = getEffectiveRequiredIds(sec);
        for (var i = 0; i < ids.length; i++) {
            var input = document.getElementById(ids[i]);
            if (input && (!input.value || !input.checkValidity())) return input;
        }
        return null;
    }

    function findFirstIncompleteSection() {
        for (var i = 0; i < accFieldsets.length; i++) {
            if (!isSectionComplete(accFieldsets[i])) return accFieldsets[i];
        }
        return null;
    }

    function getNextSection(key) {
        for (var i = 0; i < accFieldsets.length; i++) {
            if (accFieldsets[i].key === key && i + 1 < accFieldsets.length) {
                return accFieldsets[i + 1];
            }
        }
        return null;
    }

    function getSummaryText(sec) {
        if (sec.key === 'contact') {
            var email = document.getElementById('email');
            var phone = document.getElementById('phone');
            var parts = [];
            if (email && email.value) parts.push(email.value);
            if (phone && phone.value) {
                var countryCode = document.getElementById('phone-country');
                var prefix = countryCode ? countryCode.value + ' ' : '';
                parts.push(prefix + phone.value);
            }
            return parts.join(', ');
        }
        if (sec.key === 'shipping') {
            var firstName = document.getElementById('first-name');
            var lastName = document.getElementById('last-name');
            var address = document.getElementById('address1');
            var city = document.getElementById('city');
            var region = document.getElementById('region');
            var parts2 = [];
            if (firstName && firstName.value && lastName && lastName.value) {
                parts2.push(firstName.value + ' ' + lastName.value);
            }
            if (address && address.value) parts2.push(address.value);
            var cityRegion = [];
            if (city && city.value) cityRegion.push(city.value);
            if (region && region.value) {
                var selectedOption = region.options[region.selectedIndex];
                if (selectedOption) cityRegion.push(selectedOption.textContent);
            }
            if (cityRegion.length) parts2.push(cityRegion.join(', '));
            return parts2.join(', ');
        }
        return '';
    }


    // ============================
    // INIT
    // ============================

    function init() {
        initSupportFormsCollapsed();
        initSupportForms();
        initCollapsibleSections();

        // Accordion runs after a tick so CheckoutPage inline script initializes first
        if (document.getElementById('checkout-form')) {
            setTimeout(initAccordion, 0);
        }
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    return { init: init };
})();
