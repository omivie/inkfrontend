/**
 * CONTACT-PAGE.JS
 * ================
 * Drives /contact — the storefront contact form. Submits to POST /api/contact
 * with a Cloudflare Turnstile token (the backend rejects requests missing
 * the token; see ALL_API_AND_ENDPOINTS.md).
 *
 * Wired by contact.html. The page is the single landing target for the
 * "Contact us" OOS CTA on every product card / PDP (contact-button-may2026.md);
 * keep the form forgiving — most arrivals here are an OOS click, not a typed
 * support request, so the friction needs to stay low.
 */

(function () {
    'use strict';

    function $(sel, root) { return (root || document).querySelector(sel); }

    function escapeHtml(str) {
        if (typeof Security !== 'undefined' && Security.escapeHtml) return Security.escapeHtml(str);
        var div = document.createElement('div');
        div.appendChild(document.createTextNode(str == null ? '' : String(str)));
        return div.innerHTML;
    }

    function isValidEmail(email) {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    }

    function showResult(el, kind, message) {
        if (!el) return;
        el.className = 'contact-form__result contact-form__result--' + kind;
        el.textContent = message;
        el.hidden = false;
        try { el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (_) { /* ignore */ }
    }

    function focusFirstError(form) {
        var first = form.querySelector('[aria-invalid="true"]');
        if (first && typeof first.focus === 'function') first.focus();
    }

    function setInvalid(input, invalid) {
        if (!input) return;
        if (invalid) input.setAttribute('aria-invalid', 'true');
        else input.removeAttribute('aria-invalid');
    }

    // Pre-fill subject from query string when the user lands here from a
    // specific OOS card (?sku=…&subject=…). Quietly graceful if absent.
    function applyQueryDefaults() {
        try {
            var params = new URLSearchParams(window.location.search);
            var subjectEl = document.getElementById('contact-subject');
            var subject = params.get('subject');
            if (subjectEl && subject) {
                var match = Array.from(subjectEl.options).find(function (o) { return o.value === subject; });
                if (match) subjectEl.value = subject;
            }
            var sku = params.get('sku');
            var msgEl = document.querySelector('#contact-form [name="message"]');
            if (sku && msgEl && !msgEl.value) {
                msgEl.value = 'Hi — I was looking at SKU ' + sku + ' and would like to know about availability and pricing.\n\n';
            }
        } catch (_) { /* ignore */ }
    }

    function initTurnstile() {
        var siteKey = (typeof Config !== 'undefined' && Config.TURNSTILE_SITE_KEY) || '';
        var holder = document.getElementById('contact-turnstile');
        if (!siteKey || !holder) return { getToken: function () { return null; }, reset: function () {} };

        var widgetId = null;
        var lastToken = null;

        function render() {
            if (typeof window.turnstile === 'undefined') return;
            if (widgetId !== null) return;
            try {
                widgetId = window.turnstile.render('#contact-turnstile', {
                    sitekey: siteKey,
                    callback: function (token) { lastToken = token; },
                    'expired-callback': function () { lastToken = null; },
                    'error-callback': function () { lastToken = null; },
                });
            } catch (_) { /* render can throw if API loads twice — non-fatal */ }
        }

        // Turnstile script may load after DOMContentLoaded; poll briefly.
        var tries = 0;
        var poll = setInterval(function () {
            if (typeof window.turnstile !== 'undefined') {
                clearInterval(poll);
                render();
            } else if (++tries > 40) { // ~10s
                clearInterval(poll);
            }
        }, 250);

        return {
            getToken: function () { return lastToken; },
            reset: function () {
                lastToken = null;
                if (widgetId !== null && typeof window.turnstile !== 'undefined') {
                    try { window.turnstile.reset(widgetId); } catch (_) { /* ignore */ }
                }
            },
        };
    }

    function init() {
        var form = document.getElementById('contact-form');
        if (!form) return;
        var resultEl = document.getElementById('contact-result');
        var submitBtn = document.getElementById('contact-submit');

        var ts = initTurnstile();
        applyQueryDefaults();

        form.addEventListener('submit', function (e) {
            e.preventDefault();
            submit(form, submitBtn, resultEl, ts);
        });
    }

    function submit(form, submitBtn, resultEl, ts) {
        if (resultEl) { resultEl.hidden = true; resultEl.textContent = ''; resultEl.className = 'contact-form__result'; }

        var name    = (form.querySelector('[name="name"]')         || {}).value || '';
        var email   = (form.querySelector('[name="email"]')        || {}).value || '';
        var phone   = (form.querySelector('[name="phone"]')        || {}).value || '';
        var orderNo = (form.querySelector('[name="order_number"]') || {}).value || '';
        var subject = (form.querySelector('[name="subject"]')      || {}).value || '';
        var message = (form.querySelector('[name="message"]')      || {}).value || '';
        var honeypot = (form.querySelector('[name="website"]')     || {}).value || '';

        // Bot honeypot — silently succeed. Don't reveal the trap.
        if (honeypot) {
            showResult(resultEl, 'success', "Thanks — we'll be in touch within one business day.");
            form.reset();
            ts.reset();
            return;
        }

        var nameInput   = form.querySelector('[name="name"]');
        var emailInput  = form.querySelector('[name="email"]');
        var msgInput    = form.querySelector('[name="message"]');
        setInvalid(nameInput, false);
        setInvalid(emailInput, false);
        setInvalid(msgInput, false);

        if (!name.trim())                  { setInvalid(nameInput, true);  showResult(resultEl, 'error', 'Please enter your name.'); focusFirstError(form); return; }
        if (!email.trim() || !isValidEmail(email)) { setInvalid(emailInput, true); showResult(resultEl, 'error', 'Please enter a valid email address.'); focusFirstError(form); return; }
        if (!message.trim() || message.trim().length < 5) {
            setInvalid(msgInput, true); showResult(resultEl, 'error', 'Please tell us a little about what you need.'); focusFirstError(form); return;
        }

        var token = ts.getToken();
        if (!token) {
            showResult(resultEl, 'error', 'Please complete the CAPTCHA before sending.');
            return;
        }

        var payload = {
            name: name.trim(),
            email: email.trim(),
            subject: (subject || 'Contact form').trim(),
            message: message.trim(),
            turnstile_token: token,
        };
        if (phone.trim())   payload.phone = phone.trim();
        if (orderNo.trim()) payload.order_number = orderNo.trim();

        var originalText = submitBtn.textContent;
        submitBtn.disabled = true;
        submitBtn.textContent = 'Sending…';

        send(payload).then(function () {
            showResult(resultEl, 'success',
                "Thanks " + payload.name.split(' ')[0] + " — we'll reply within one business day. " +
                "If it's urgent, call 027 474 0115."
            );
            form.reset();
            ts.reset();
            try { if (typeof gtag === 'function') gtag('event', 'contact_form_submit', { subject: payload.subject }); } catch (_) {}
        }).catch(function (err) {
            ts.reset();
            var msg = (err && err.message) ? err.message : 'Something went wrong. Please try again, or call 027 474 0115.';
            showResult(resultEl, 'error', msg);
        }).then(function () {
            submitBtn.disabled = false;
            submitBtn.textContent = originalText;
        });
    }

    function send(payload) {
        // Prefer the API helper for envelope handling; fall back to direct fetch
        // when the helper hasn't loaded (defensive — api.js is in the page deps).
        if (typeof API !== 'undefined' && typeof API.submitContactForm === 'function') {
            return API.submitContactForm(payload).then(function (res) {
                if (res && res.ok) return res;
                // 5xx now returns a structured envelope (api.js); route through mapError
                // so the user sees "Server hiccup — please try again. … reference XXXXXXXX."
                if (res && (res.code === 'INTERNAL_ERROR' || (typeof res.status === 'number' && res.status >= 500))) {
                    if (res.request_id) console.warn('[contact] submit failed', { code: res.code, request_id: res.request_id });
                    var mapped = (typeof API.mapError === 'function') ? API.mapError(res) : null;
                    throw new Error((mapped && mapped.message) || 'Server hiccup — please try again, or call 027 474 0115.');
                }
                var msg = (res && res.error && res.error.message) || (res && res.error) || 'Could not send your message.';
                throw new Error(typeof msg === 'string' ? msg : 'Could not send your message.');
            });
        }
        var base = (typeof Config !== 'undefined' && Config.API_URL) ? Config.API_URL : '';
        var url = base ? (base + '/api/contact') : '/api/contact';
        return fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        }).then(function (r) {
            var rid = r.headers.get('x-request-id');
            return r.json().then(function (data) {
                if (r.ok && data && data.ok) return data;
                var msg = (data && data.error && data.error.message) || (data && data.error) || 'Could not send your message.';
                if (r.status >= 500) {
                    if (rid) console.warn('[contact] submit failed', { status: r.status, request_id: rid });
                    var ref = rid ? ' (ref ' + String(rid).slice(0, 8) + ')' : '';
                    throw new Error('Server hiccup — please try again, or call 027 474 0115.' + ref);
                }
                throw new Error(typeof msg === 'string' ? msg : 'Could not send your message.');
            });
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
