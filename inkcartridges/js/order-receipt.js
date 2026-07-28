/**
 * ORDER-RECEIPT.JS
 * ================
 * The customer-facing downloadable receipt PDF.
 *
 * WHY THIS EXISTS (Jul 2026)
 * --------------------------
 * A backend handoff asked us to "add the points-earned line to the customer-facing
 * downloadable invoice PDF". There wasn't one. jsPDF was loaded on exactly one
 * page — /admin — and the only builder was `buildInvoiceDoc()` in
 * js/admin/pages/invoices.js, which renders the OPERATOR's B2B tax invoice. That
 * document reaches customers only because the admin browser uploads its bytes
 * (`syncStoredPdf()`), it is created by hand for invoiced accounts, and it has no
 * relationship to the loyalty ledger. No storefront surface offered a download at
 * all. So the ask was unbuildable as written, and this module is what makes it
 * true: a real receipt a retail customer can download from
 * /order-confirmation and /account/order-detail.
 *
 * NOT a tax invoice. It is a RECEIPT for an order already paid: no payment terms,
 * no bank details, no due date. The admin invoice document is unchanged.
 *
 * TOTALS COME FROM js/order-totals.js. The PDF walks the exact same
 * `OrderTotals.rows()` array the two HTML surfaces walk, which is the entire
 * point — a receipt that disagreed with the screen it was downloaded from would
 * be worse than no receipt. Never compute a figure here.
 *
 * TWO THINGS THE ADMIN BUILDER GETS WRONG, DELIBERATELY NOT COPIED:
 *
 * 1. PAGE OVERFLOW. `buildInvoiceDoc` walks a monotonically increasing y cursor
 *    with no bound check against A4's 841.89 pt, so on a long order the totals
 *    and payment block are written off the bottom of the page and silently
 *    vanish. Here every writer goes through `ensure(h)` first, and the totals
 *    stack reserves its full height in one call so it can never straddle a break.
 * 2. autoTable PAGINATES ITSELF but leaves the doc's "current page" wherever it
 *    started. `buildInvoiceDoc` never calls `setPage`, so a multi-page items
 *    table gets its totals drawn onto page 1 underneath the table. Here we
 *    re-anchor to the last page explicitly after the table.
 *
 * ENCODING: jsPDF's built-in fonts are WinAnsi/cp1252. "≈" (U+2248) and the
 * proper minus sign are NOT in cp1252 and vanish or corrupt silently. Every
 * string drawn goes through `OrderTotals.ascii()`. That is why the estimate marker
 * reads "~" in the PDF and "≈" on screen.
 *
 * jsPDF is LAZY-LOADED (~400 KB) — it must never be on the critical path of a
 * storefront page. cdn.jsdelivr.net is already in the CSP script-src allowlist
 * (vercel.json).
 */

'use strict';

(function () {
    const JSPDF_URL = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js';
    const AUTOTABLE_URL = 'https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.4/dist/jspdf.plugin.autotable.min.js';

    // Same versions the admin shell pins in html/admin/index.html, so there is
    // one jsPDF generation in play across the whole site.

    const M = 48;                 // page margin, pt
    const FOOTER_RESERVE = 30;    // space kept clear for the "Page n of N" line

    /** Module-level so a double-click cannot inject the scripts twice. */
    let _libPromise = null;

    const warn = (msg, err) => {
        if (typeof DebugLog !== 'undefined' && DebugLog.warn) {
            DebugLog.warn('[order-receipt] ' + msg, err && err.message ? err.message : err);
        }
    };

    /**
     * A CDN script that neither loads nor errors would leave the download button
     * disabled on "Preparing..." forever, because `onerror` never fires on a
     * stalled connection. Bound the wait, same pattern as the Turnstile loader in
     * auth.js. 12s is generous for a ~400 KB jsdelivr asset and still finite.
     */
    const LOAD_TIMEOUT_MS = 12000;

    function loadScript(url) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const done = (err) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                if (err) reject(err); else resolve();
            };
            const timer = setTimeout(
                () => done(new Error('Timed out loading ' + url)),
                LOAD_TIMEOUT_MS
            );

            const existing = document.querySelector(`script[data-receipt-lib="${url}"]`);
            if (existing) {
                if (existing.dataset.loaded === '1') { done(); return; }
                existing.addEventListener('load', () => done());
                existing.addEventListener('error', () => done(new Error('Failed to load ' + url)));
                return;
            }
            const s = document.createElement('script');
            s.src = url;
            s.dataset.receiptLib = url;
            s.onload = () => { s.dataset.loaded = '1'; done(); };
            s.onerror = () => done(new Error('Failed to load ' + url));
            document.head.appendChild(s);
        });
    }

    /**
     * Load jsPDF + autotable on demand.
     * @returns {Promise<boolean>} false when unavailable — callers must degrade,
     *          never throw at the user.
     */
    function ensureLib() {
        if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve(true);
        if (_libPromise) return _libPromise;
        _libPromise = (async () => {
            try {
                await loadScript(JSPDF_URL);
                await loadScript(AUTOTABLE_URL);
                return !!(window.jspdf && window.jspdf.jsPDF);
            } catch (err) {
                warn('jsPDF failed to load', err);
                _libPromise = null;   // allow a retry on the next click
                return false;
            }
        })();
        return _libPromise;
    }

    /** en-NZ short date, or null when the input is unusable. */
    function formatDate(value) {
        if (!value) return null;
        const d = new Date(value);
        if (isNaN(d.getTime())) return null;
        return d.toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' });
    }

    /** The seller identity block, from LegalConfig only — never hardcoded here. */
    function sellerLines() {
        const L = typeof window !== 'undefined' ? window.LegalConfig : null;
        // No LegalConfig => omit the whole block. A receipt with a placeholder or
        // stale GST number is worse than a receipt without one: it is a tax
        // document artefact that says something untrue about a real company.
        if (!L) return null;
        const a = L.address || {};
        const lines = [];
        const street = [a.street, a.suburb].filter(Boolean).join(', ');
        if (street) lines.push(street);
        const cityLine = [a.city, a.postcode].filter(Boolean).join(' ');
        if (cityLine) lines.push(cityLine);
        if (a.country) lines.push(a.country);
        if (L.gstNumber) lines.push('GST ' + L.gstNumber);
        if (L.nzbn) lines.push('NZBN ' + L.nzbn);
        if (L.email) lines.push(L.email);
        if (L.phoneDisplay) lines.push(L.phoneDisplay);
        return {
            name: L.legalEntity && L.tradingName && L.legalEntity !== L.tradingName
                ? `${L.tradingName} (${L.legalEntity})`
                : (L.tradingName || L.legalEntity || ''),
            lines: lines
        };
    }

    /** Recipient block from the order's shipping address. */
    function buyerLines(t) {
        const a = t.shippingAddress || {};
        const lines = [];
        if (a.address_line1) lines.push(a.address_line1);
        if (a.address_line2) lines.push(a.address_line2);
        // City and region are frequently identical in NZ ("Auckland, Auckland",
        // "Wellington, Wellington"), which prints as "Auckland Auckland 1010".
        // Collapse the repeat rather than shipping it on a document the customer
        // keeps.
        const sameCityRegion = a.city && a.region
            && String(a.city).trim().toLowerCase() === String(a.region).trim().toLowerCase();
        const cityLine = [a.city, sameCityRegion ? null : a.region, a.postal_code]
            .filter(Boolean).join(' ');
        if (cityLine) lines.push(cityLine);
        if (a.country) lines.push(a.country);
        if (a.phone) lines.push(a.phone);
        if (t.email) lines.push(t.email);
        const name = a.recipient_name || '';
        if (!name && !lines.length) return null;
        return { name: name || (t.email || ''), lines: lines };
    }

    /**
     * Build the receipt document.
     * @param {object} order  a raw order payload OR a transformAPIOrder output
     * @returns {object|null} a jsPDF doc, or null when the lib/data is unusable
     */
    function build(order) {
        const JsPDF = window.jspdf && window.jspdf.jsPDF;
        const OT = window.OrderTotals;
        if (!JsPDF || !OT) return null;

        const t = OT.normalise(order);
        // Never render a receipt out of unknowns — an authoritative-looking
        // document full of em-dashes is worse than no document. Callers gate the
        // button on the same condition; this is the backstop.
        if (t.total === null || !t.items.length) return null;

        const esc = OT.ascii;
        const doc = new JsPDF({ unit: 'pt', format: 'a4' });
        const pageW = doc.internal.pageSize.getWidth();
        const pageH = doc.internal.pageSize.getHeight();
        const BOTTOM = pageH - M - FOOTER_RESERVE;

        let y = 0;
        /** Reserve `h` pt below the cursor, breaking the page if it will not fit. */
        const ensure = (h) => {
            if (y + h > BOTTOM) { doc.addPage(); y = M + 24; }
        };
        const text = (s, x, yy, opts) => doc.text(esc(s), x, yy, opts);

        // ── Header ───────────────────────────────────────────────────────────
        doc.setFont('times', 'bold'); doc.setFontSize(24); doc.setTextColor(25);
        doc.text('ORDER RECEIPT', M, 72);

        const meta = [];
        if (t.orderNumber) meta.push(['Order Number', t.orderNumber]);
        const dateStr = formatDate(t.createdAt);
        if (dateStr) meta.push(['Date', dateStr]);
        if (t.invoiceNumber) meta.push(['Invoice Number', t.invoiceNumber]);

        let my = 56;
        meta.forEach(([k, v]) => {
            doc.setFont('times', 'normal'); doc.setFontSize(9); doc.setTextColor(140);
            text(k.toUpperCase(), pageW - M - 110, my, { align: 'right' });
            doc.setFont('times', 'bold'); doc.setFontSize(11); doc.setTextColor(25);
            text(v, pageW - M, my, { align: 'right' });
            my += 16;
        });

        const headBottom = Math.max(86, my + 2);
        doc.setDrawColor(25); doc.setLineWidth(1.2);
        doc.line(M, headBottom, pageW - M, headBottom);

        // ── Party columns ────────────────────────────────────────────────────
        const gap = 20;
        const colW = (pageW - 2 * M - gap) / 2;
        const drawParty = (party, x, top, label) => {
            if (!party) return top;
            doc.setFont('times', 'bold'); doc.setFontSize(9); doc.setTextColor(140);
            text(label, x, top);
            doc.setFont('times', 'bold'); doc.setFontSize(12); doc.setTextColor(25);
            let yy = top + 17;
            doc.splitTextToSize(esc(party.name || ''), colW).forEach((w) => { doc.text(w, x, yy); yy += 14; });
            doc.setFont('times', 'normal'); doc.setFontSize(10.5); doc.setTextColor(45);
            yy += 2;
            party.lines.forEach((l) => {
                doc.splitTextToSize(esc(l), colW).forEach((w) => { doc.text(w, x, yy); yy += 13; });
            });
            return yy;
        };
        const colTop = headBottom + 28;
        const leftBottom = drawParty(sellerLines(), M, colTop, 'FROM');
        const rightBottom = drawParty(buyerLines(t), M + colW + gap, colTop, 'BILL TO');
        y = Math.max(leftBottom, rightBottom, colTop);
        doc.setTextColor(20);

        // ── Items ────────────────────────────────────────────────────────────
        // EVERY cell goes through esc() — including the unknown-value dashes.
        // autoTable draws these itself, so a glyph that skips the fold here is
        // just as unencodable as one passed to text().
        const body = t.items.map((it) => [
            esc(it.sku || ''),
            esc(it.name),
            esc(it.quantity === null ? '—' : String(it.quantity)),
            esc(it.lineTotal === null ? '—' : OT.format(it.lineTotal))
        ]);
        const padY = { top: 5, bottom: 5 };
        doc.autoTable({
            startY: y + 18,
            head: [['Code', 'Description', 'Qty', 'Amount']],
            body: body,
            theme: 'plain',
            styles: { font: 'times', fontSize: 10.5, cellPadding: { ...padY, left: 0, right: 8 }, overflow: 'linebreak', valign: 'top', textColor: 35 },
            headStyles: { font: 'times', fontStyle: 'bold', textColor: 90, fontSize: 9.5 },
            columnStyles: {
                0: { cellWidth: 96 },
                1: { cellWidth: 'auto' },
                2: { cellWidth: 44, halign: 'center', cellPadding: { ...padY, left: 6, right: 6 } },
                3: { cellWidth: 80, halign: 'right', cellPadding: { ...padY, left: 6, right: 0 } }
            },
            margin: { left: M, right: M, bottom: M + FOOTER_RESERVE },
            didDrawCell: (data) => {
                if (data.section !== 'head') return;
                doc.setDrawColor(30); doc.setLineWidth(0.8);
                doc.line(data.cell.x, data.cell.y + data.cell.height,
                    data.cell.x + data.cell.width, data.cell.y + data.cell.height);
            }
        });

        // autoTable may have added pages. Re-anchor to the LAST one before
        // drawing anything else — omitting this is the admin builder's bug.
        doc.setPage(doc.internal.getNumberOfPages());
        y = ((doc.lastAutoTable && doc.lastAutoTable.finalY) || y) + 28;

        // ── Totals ───────────────────────────────────────────────────────────
        const all = OT.rows(t);
        const totalRows = all.filter((r) => r.key !== 'earned');
        const earned = all.find((r) => r.key === 'earned') || null;

        // Reserve the whole stack up front so it never straddles a page break:
        // one row per line, +10 for the rule above the total, +18 breathing room.
        ensure(totalRows.length * 16 + 28);

        const labelX = pageW - M - 210;
        const valX = pageW - M;
        doc.setTextColor(20);
        totalRows.forEach((r) => {
            if (r.kind === 'total') {
                y += 6;
                doc.setDrawColor(20); doc.setLineWidth(1);
                doc.line(labelX, y - 11, valX, y - 11);
                doc.setFont('times', 'bold'); doc.setFontSize(13.5);
            } else {
                doc.setFont('times', 'normal'); doc.setFontSize(10.5);
            }
            text(r.label, labelX, y);
            text(r.value, valX, y, { align: 'right' });
            y += r.kind === 'total' ? 20 : 15;
        });

        // ── Points earned ────────────────────────────────────────────────────
        if (earned) {
            // rows() hands us "+85 pts" (confirmed) or "≈ +85 pts" (estimated).
            // Strip the marker and prefix to get the bare quantity, then say in
            // WORDS whether it is confirmed or an estimate — a lone "~" is not a
            // disclosure a customer can read.
            const isEstimate = /[~≈]/.test(earned.value);
            const amount = earned.value
                .replace(/[~≈]/g, '')
                .replace(/\+/, '')
                .trim()
                .replace(/\bpts\b/, 'points');
            const headline = isEstimate
                ? `* Estimated: about ${amount} earned on this order`
                : `* You earned ${amount} on this order`;
            const noteLines = earned.note
                ? doc.splitTextToSize(esc(earned.note), pageW - 2 * M)
                : [];
            ensure(28 + noteLines.length * 12);
            y += 10;
            doc.setDrawColor(220); doc.setLineWidth(0.8);
            doc.line(M, y - 4, pageW - M, y - 4);
            y += 14;
            doc.setFont('times', 'bold'); doc.setFontSize(11.5); doc.setTextColor(25);
            text(headline, M, y);
            y += 14;
            if (noteLines.length) {
                doc.setFont('times', 'normal'); doc.setFontSize(9); doc.setTextColor(120);
                noteLines.forEach((w) => { doc.text(w, M, y); y += 12; });
            }
            doc.setTextColor(20);
        }

        // ── Page footers ─────────────────────────────────────────────────────
        const L = typeof window !== 'undefined' ? window.LegalConfig : null;
        const brand = (L && (L.tradingName || L.legalEntity)) || '';
        const pages = doc.internal.getNumberOfPages();
        for (let p = 1; p <= pages; p++) {
            doc.setPage(p);
            doc.setFont('times', 'normal'); doc.setFontSize(8.5); doc.setTextColor(150);
            if (brand) text(brand, M, pageH - M + 12);
            text(`Page ${p} of ${pages}`, pageW - M, pageH - M + 12, { align: 'right' });
        }

        return doc;
    }

    /** Filename-safe order reference. */
    function safeName(orderNumber) {
        const cleaned = String(orderNumber || 'order').replace(/[^A-Za-z0-9._-]/g, '');
        return 'Receipt-' + (cleaned || 'order') + '.pdf';
    }

    /**
     * Build and download the receipt.
     * @returns {Promise<boolean>} false when it could not be produced.
     */
    async function download(order) {
        if (!order) return false;
        const ok = await ensureLib();
        if (!ok) return false;
        try {
            const doc = build(order);
            if (!doc) { warn('receipt could not be built from this order'); return false; }
            const OT = window.OrderTotals;
            doc.save(safeName(OT ? OT.normalise(order).orderNumber : null));
            return true;
        } catch (err) {
            warn('receipt build threw', err);
            return false;
        }
    }

    /**
     * Wire a download button. Idempotent — safe to call on every render.
     * @param {HTMLElement} btn
     * @param {function():object} getOrder  called at click time, so a late-
     *        arriving order payload is picked up without rebinding.
     */
    function attach(btn, getOrder) {
        if (!btn || typeof getOrder !== 'function') return;
        if (btn.dataset.receiptBound === '1') return;
        btn.dataset.receiptBound = '1';

        btn.addEventListener('click', async () => {
            // Captured markup is ours (it came from our own HTML), not user data.
            const originalHtml = btn.innerHTML;
            btn.disabled = true;
            btn.setAttribute('aria-busy', 'true');
            btn.textContent = 'Preparing…';
            let ok = false;
            try {
                ok = await download(getOrder());
            } finally {
                btn.disabled = false;
                btn.removeAttribute('aria-busy');
                btn.innerHTML = originalHtml;
            }
            if (!ok && typeof showToast === 'function') {
                showToast("Sorry — we couldn't build your receipt. Please try again.", 'error');
            }
        });
    }

    const OrderReceipt = {
        ensureLib: ensureLib,
        build: build,
        download: download,
        attach: attach,
        safeName: safeName,
        JSPDF_URL: JSPDF_URL,
        AUTOTABLE_URL: AUTOTABLE_URL
    };

    if (typeof window !== 'undefined') window.OrderReceipt = OrderReceipt;
})();
