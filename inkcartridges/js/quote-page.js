/**
 * QUOTE-PAGE.JS
 * =============
 * Drives /quote — the business "Request a trade quote" form. It is the landing
 * target for the printed QR code (see /quote-qr generator tool).
 *
 * There is no dedicated backend quote endpoint yet, so this reuses the proven
 * POST /api/contact pipeline: it folds the business-specific fields (business
 * name, printers, products & quantities, delivery address, notes) into a
 * structured `message` body and posts with subject "Trade quote request", so
 * every request lands in the existing support inbox with zero backend changes.
 * A structured /api/quote endpoint is a future backend follow-up.
 *
 * Mirrors contact-page.js deliberately (honeypot + Turnstile + envelope-aware
 * send()) so the two stay consistent; keep them in sync when either changes.
 */

(function () {
    'use strict';

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

    function val(form, name) {
        var el = form.querySelector('[name="' + name + '"]');
        return (el && el.value) ? el.value : '';
    }

    // Assemble the free-text message body the support inbox receives. Only
    // include sections the business actually filled in, so the email stays
    // readable. Escaping is unnecessary — this is a plain-text email body, not
    // HTML, and the backend treats /api/contact `message` as text.
    function composeMessage(fields) {
        var lines = ['Trade quote request via /quote', ''];
        lines.push('Business: ' + fields.business);
        if (fields.phone)   lines.push('Phone: ' + fields.phone);
        if (fields.printers) lines.push('Printer(s): ' + fields.printers);
        lines.push('');
        lines.push('Products & quantities:');
        lines.push(fields.items);
        if (fields.delivery) {
            lines.push('');
            lines.push('Delivery address:');
            lines.push(fields.delivery);
        }
        if (fields.notes) {
            lines.push('');
            lines.push('Notes:');
            lines.push(fields.notes);
        }
        return lines.join('\n');
    }

    function initTurnstile() {
        var siteKey = (typeof Config !== 'undefined' && Config.TURNSTILE_SITE_KEY) || '';
        var holder = document.getElementById('quote-turnstile');
        if (!siteKey || !holder) return { getToken: function () { return null; }, reset: function () {} };

        var widgetId = null;
        var lastToken = null;

        function render() {
            if (typeof window.turnstile === 'undefined') return;
            if (widgetId !== null) return;
            try {
                widgetId = window.turnstile.render('#quote-turnstile', {
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
        var form = document.getElementById('quote-form');
        if (!form) return;
        var resultEl = document.getElementById('quote-result');
        var submitBtn = document.getElementById('quote-submit');

        var ts = initTurnstile();

        form.addEventListener('submit', function (e) {
            e.preventDefault();
            submit(form, submitBtn, resultEl, ts);
        });
    }

    function submit(form, submitBtn, resultEl, ts) {
        if (resultEl) { resultEl.hidden = true; resultEl.textContent = ''; resultEl.className = 'contact-form__result'; }

        var business = val(form, 'business_name').trim();
        var name     = val(form, 'name').trim();
        var email    = val(form, 'email').trim();
        var phone    = val(form, 'phone').trim();
        var printers = val(form, 'printers').trim();
        var items    = val(form, 'items').trim();
        var delivery = val(form, 'delivery_address').trim();
        var notes    = val(form, 'notes').trim();
        var honeypot = val(form, 'website');

        // Bot honeypot — silently succeed. Don't reveal the trap.
        if (honeypot) {
            showResult(resultEl, 'success', "Thanks — we'll email your quote within one business day.");
            form.reset();
            ts.reset();
            return;
        }

        var businessInput = form.querySelector('[name="business_name"]');
        var nameInput     = form.querySelector('[name="name"]');
        var emailInput    = form.querySelector('[name="email"]');
        var itemsInput    = form.querySelector('[name="items"]');
        setInvalid(businessInput, false);
        setInvalid(nameInput, false);
        setInvalid(emailInput, false);
        setInvalid(itemsInput, false);

        if (!business)                 { setInvalid(businessInput, true); showResult(resultEl, 'error', 'Please enter your business name.'); focusFirstError(form); return; }
        if (!name)                     { setInvalid(nameInput, true);     showResult(resultEl, 'error', 'Please enter your name.'); focusFirstError(form); return; }
        if (!email || !isValidEmail(email)) { setInvalid(emailInput, true); showResult(resultEl, 'error', 'Please enter a valid email address.'); focusFirstError(form); return; }
        if (!items || items.length < 3) {
            setInvalid(itemsInput, true); showResult(resultEl, 'error', 'Please list the products and quantities you need.'); focusFirstError(form); return;
        }

        var token = ts.getToken();
        if (!token) {
            showResult(resultEl, 'error', 'Please complete the CAPTCHA before sending.');
            return;
        }

        var message = composeMessage({
            business: business,
            phone: phone,
            printers: printers,
            items: items,
            delivery: delivery,
            notes: notes,
        });

        var payload = {
            name: name,
            email: email,
            subject: 'Trade quote request',
            message: message,
            turnstile_token: token,
        };
        if (phone) payload.phone = phone;

        var originalText = submitBtn.textContent;
        submitBtn.disabled = true;
        submitBtn.textContent = 'Sending…';

        send(payload).then(function () {
            showResult(resultEl, 'success',
                "Thanks " + name.split(' ')[0] + " — we'll email your quote within one business day. " +
                "If it's urgent, call 027 474 0115."
            );
            form.reset();
            ts.reset();
            try { if (typeof gtag === 'function') gtag('event', 'quote_form_submit', { business: business }); } catch (_) {}
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
                    if (res.request_id && typeof DebugLog !== 'undefined') DebugLog.warn('[quote] submit failed', { code: res.code, request_id: res.request_id });
                    var mapped = (typeof API.mapError === 'function') ? API.mapError(res) : null;
                    throw new Error((mapped && mapped.message) || 'Server hiccup — please try again, or call 027 474 0115.');
                }
                var msg = (res && res.error && res.error.message) || (res && res.error) || 'Could not send your request.';
                throw new Error(typeof msg === 'string' ? msg : 'Could not send your request.');
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
                var msg = (data && data.error && data.error.message) || (data && data.error) || 'Could not send your request.';
                if (r.status >= 500) {
                    if (rid && typeof DebugLog !== 'undefined') DebugLog.warn('[quote] submit failed', { status: r.status, request_id: rid });
                    var ref = rid ? ' (ref ' + String(rid).slice(0, 8) + ')' : '';
                    throw new Error('Server hiccup — please try again, or call 027 474 0115.' + ref);
                }
                throw new Error(typeof msg === 'string' ? msg : 'Could not send your request.');
            });
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
