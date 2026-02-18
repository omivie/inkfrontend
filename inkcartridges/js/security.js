/**
 * Security Utilities for InkCartridges.co.nz
 *
 * Centralized security functions to prevent XSS, open redirects,
 * and other client-side vulnerabilities.
 *
 * Include this script BEFORE any scripts that render dynamic content.
 */

const Security = {

    /**
     * Escape HTML special characters to prevent XSS when inserting
     * dynamic data into innerHTML templates.
     *
     * Threat: DOM XSS — attacker-controlled strings (product names,
     * search queries, user input) rendered via innerHTML execute as HTML.
     *
     * @param {*} str - Value to escape (coerced to string)
     * @returns {string} HTML-safe string
     */
    escapeHtml(str) {
        if (str == null) return '';
        const s = String(str);
        // Use a lookup object for performance over repeated replace calls
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#x27;',
            '/': '&#x2F;',
            '`': '&#96;'
        };
        return s.replace(/[&<>"'/`]/g, char => map[char]);
    },

    /**
     * Escape a value for use inside an HTML attribute (double-quoted).
     * Covers the same chars as escapeHtml — use this when building
     * attribute strings like src="...", alt="...", data-*="...".
     *
     * Threat: Attribute breakout — a `"` in a value closes the attribute,
     * allowing injection of onerror, onload, or other event handlers.
     *
     * @param {*} str - Value to escape
     * @returns {string} Attribute-safe string
     */
    escapeAttr(str) {
        // Same implementation — escapeHtml covers attribute context too
        return Security.escapeHtml(str);
    },

    /**
     * Sanitize a URL for use in href/src attributes.
     * Only allows http:, https:, and relative paths.
     *
     * Threat: JavaScript injection via javascript: URLs or data: URLs
     * in href/src attributes.
     *
     * @param {*} url - URL to sanitize
     * @param {string} fallback - Fallback URL if invalid
     * @returns {string} Safe URL string
     */
    sanitizeUrl(url, fallback = '#') {
        if (url == null) return fallback;
        const s = String(url).trim();
        // Allow relative URLs (starting with / but not //)
        if (s.startsWith('/') && !s.startsWith('//')) return s;
        // Allow http and https
        if (s.startsWith('https://') || s.startsWith('http://')) return s;
        // Allow empty string and fragment-only
        if (s === '' || s.startsWith('#')) return s;
        // Block everything else (javascript:, data:, vbscript:, //, etc.)
        return fallback;
    },

    /**
     * Validate a redirect URL to prevent open redirects.
     * Only allows same-origin paths (relative URLs starting with /).
     *
     * Threat: Open redirect — attacker crafts a login URL with
     * ?redirect=https://evil.com, and after auth the user is sent
     * to a phishing page.
     *
     * Exploit path:
     *   1. Attacker sends victim: login.html?redirect=https://evil.com/phish
     *   2. Victim logs in successfully
     *   3. Code reads redirect param, navigates to evil.com
     *   4. Phishing page mimics InkCartridges, steals credentials
     *
     * @param {string} url - The redirect target to validate
     * @param {string} fallback - Safe default if URL is invalid
     * @returns {string} A safe redirect URL (always same-origin)
     */
    safeRedirect(url, fallback = '/html/account/index.html') {
        if (!url || typeof url !== 'string') return fallback;
        const trimmed = url.trim();
        // Must start with exactly one / (not // which is protocol-relative)
        if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
            return trimmed;
        }
        // Reject absolute URLs, protocol-relative URLs, javascript:, data:, etc.
        return fallback;
    },

    /**
     * Strip sensitive data from objects before logging.
     *
     * Threat: Information leakage — full API error responses logged
     * to console may contain tokens, internal server details, or user PII.
     * An XSS attacker with console access can harvest this.
     *
     * @param {*} data - Data to sanitize for logging
     * @returns {*} Sanitized copy
     */
    sanitizeForLog(data) {
        if (data == null) return data;
        if (typeof data === 'string') return data;
        if (typeof data !== 'object') return data;

        const sensitiveKeys = [
            'token', 'access_token', 'refresh_token', 'authorization',
            'password', 'secret', 'client_secret', 'api_key',
            'credit_card', 'card_number', 'cvv', 'cvc'
        ];

        const sanitized = Array.isArray(data) ? [...data] : { ...data };
        for (const key of Object.keys(sanitized)) {
            const lowerKey = key.toLowerCase();
            if (sensitiveKeys.some(sk => lowerKey.includes(sk))) {
                sanitized[key] = '[REDACTED]';
            } else if (typeof sanitized[key] === 'object' && sanitized[key] !== null) {
                sanitized[key] = Security.sanitizeForLog(sanitized[key]);
            }
        }
        return sanitized;
    }
};

// Freeze to prevent tampering
Object.freeze(Security);
