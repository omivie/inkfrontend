/**
 * QUOTE-QR-PAGE.JS
 * ================
 * Drives /quote-qr — an internal (noindex) owner tool that turns any URL into a
 * downloadable QR code (SVG for print, PNG for screens) plus a ready-to-print
 * poster. Defaults to the /quote trade-quote landing page.
 *
 * Uses the vendored, self-hosted qrcode-generator (js/vendor/qrcode.min.js →
 * global `qrcode`). No network calls, CSP-clean.
 */

(function () {
    'use strict';

    var DEFAULT_URL = 'https://www.inkcartridges.co.nz/quote';
    var EC_LEVEL = 'M'; // ~15% error correction — solid for print at this size.

    function $(id) { return document.getElementById(id); }

    // Build a QR model for `text`. typeNumber 0 = auto-pick the smallest version
    // that fits. Returns null if the text can't be encoded (e.g. too long).
    function build(text) {
        try {
            var qr = qrcode(0, EC_LEVEL);
            qr.addData(text);
            qr.make();
            return qr;
        } catch (_) {
            return null;
        }
    }

    function svgString(qr, cellSize, margin) {
        // scalable:true emits a viewBox-based SVG that stays crisp at any print size.
        return qr.createSvgTag({ cellSize: cellSize, margin: margin, scalable: true });
    }

    // Render the QR onto a canvas at a fixed pixel density for PNG export.
    function toCanvas(qr, cellSize, margin) {
        var count = qr.getModuleCount();
        var dim = (count + margin * 2) * cellSize;
        var canvas = document.createElement('canvas');
        canvas.width = dim;
        canvas.height = dim;
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, dim, dim);
        ctx.fillStyle = '#000000';
        for (var r = 0; r < count; r++) {
            for (var c = 0; c < count; c++) {
                if (qr.isDark(r, c)) {
                    ctx.fillRect((c + margin) * cellSize, (r + margin) * cellSize, cellSize, cellSize);
                }
            }
        }
        return canvas;
    }

    function download(href, filename) {
        var a = document.createElement('a');
        a.href = href;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }

    // Derive a tidy filename slug from the URL's last path segment.
    function slugFor(url) {
        try {
            var u = new URL(url);
            var seg = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean).pop();
            return (seg || u.hostname || 'qr').replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
        } catch (_) {
            return 'qr';
        }
    }

    function state() {
        return {
            urlInput: $('qr-url'),
            preview: $('qr-preview'),
            poster: $('qr-poster-code'),
            posterUrl: $('qr-poster-url'),
            error: $('qr-error'),
            svgBtn: $('qr-download-svg'),
            pngBtn: $('qr-download-png'),
        };
    }

    function refresh() {
        var s = state();
        var url = (s.urlInput.value || '').trim() || DEFAULT_URL;
        var qr = build(url);

        if (!qr) {
            s.error.hidden = false;
            s.error.textContent = 'Could not encode that text — it may be too long for a QR code.';
            s.preview.innerHTML = '';
            s.poster.innerHTML = '';
            if (s.svgBtn) s.svgBtn.disabled = true;
            if (s.pngBtn) s.pngBtn.disabled = true;
            return;
        }

        s.error.hidden = true;
        if (s.svgBtn) s.svgBtn.disabled = false;
        if (s.pngBtn) s.pngBtn.disabled = false;

        // On-screen preview + poster share the same scalable SVG.
        s.preview.innerHTML = svgString(qr, 8, 4);
        s.poster.innerHTML = svgString(qr, 8, 4);
        s.posterUrl.textContent = url;
    }

    function onDownloadSvg() {
        var s = state();
        var url = (s.urlInput.value || '').trim() || DEFAULT_URL;
        var qr = build(url);
        if (!qr) return;
        var blob = new Blob([svgString(qr, 10, 4)], { type: 'image/svg+xml;charset=utf-8' });
        var href = URL.createObjectURL(blob);
        download(href, 'qr-' + slugFor(url) + '.svg');
        setTimeout(function () { URL.revokeObjectURL(href); }, 1000);
    }

    function onDownloadPng() {
        var s = state();
        var url = (s.urlInput.value || '').trim() || DEFAULT_URL;
        var qr = build(url);
        if (!qr) return;
        var canvas = toCanvas(qr, 16, 4); // 16px/module → crisp, print-ready PNG
        download(canvas.toDataURL('image/png'), 'qr-' + slugFor(url) + '.png');
    }

    function init() {
        var s = state();
        if (!s.urlInput) return;
        if (!s.urlInput.value) s.urlInput.value = DEFAULT_URL;

        if (typeof window.qrcode === 'undefined') {
            s.error.hidden = false;
            s.error.textContent = 'QR library failed to load. Please refresh the page.';
            return;
        }

        s.urlInput.addEventListener('input', refresh);
        if (s.svgBtn) s.svgBtn.addEventListener('click', onDownloadSvg);
        if (s.pngBtn) s.pngBtn.addEventListener('click', onDownloadPng);
        var printBtn = $('qr-print');
        if (printBtn) printBtn.addEventListener('click', function () { window.print(); });

        refresh();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
