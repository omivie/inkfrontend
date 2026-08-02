/**
 * BusinessInvoicePdf — download the invoice PDF on /business
 * ==========================================================
 *
 * THE FILE WE SERVE IS THE FILE WE EMAILED.
 * The admin invoicing tool renders the PDF client-side and uploads it
 * (`syncStoredPdf` → POST /api/admin/invoices/:id/pdf, js/admin/pages/invoices.js)
 * precisely so the emailed bytes and the stored bytes are the same. This module
 * fetches that stored file, so a customer comparing the download against their
 * inbox copy sees one document, not two that nearly agree.
 *
 * WHY THE FALLBACK IS NARROW
 * --------------------------
 * We only re-render locally on an EXPLICIT "there is no stored file" signal
 * (409 NO_STORED_PDF, or 404). On a 5xx or a dead network we show an error and
 * a Retry instead. Falling back on *any* failure would hand someone a document
 * that differs from the one we emailed — different jsPDF build, or edits made
 * since — while they believe it is the same file. A visible error is better
 * than a silent substitution. When we do generate a copy it is stamped as one.
 *
 * The loader below is deliberately a sibling of js/order-receipt.js rather than
 * an import: that file is an IIFE with no exported doc builder, and refactoring
 * a working PDF path for zero user benefit is the wrong trade. js/order-receipt.js
 * is the source of truth for this scaffolding — the 12s timeout (onerror never
 * fires on a stalled connection), nulling _libPromise so a retry works, and
 * resolving false rather than throwing at the user. Keep them in step.
 */
(function () {
    'use strict';

    // Same pins as js/order-receipt.js and html/admin/index.html — one jsPDF
    // generation sitewide. cdn.jsdelivr.net is the only CDN in the CSP allowlist.
    const JSPDF_URL = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js';
    const AUTOTABLE_URL = 'https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.4/dist/jspdf.plugin.autotable.min.js';
    const LOAD_TIMEOUT_MS = 12000;

    let _libPromise = null;

    const warn = (...a) => {
        if (typeof DebugLog !== 'undefined' && DebugLog && typeof DebugLog.warn === 'function') DebugLog.warn(...a);
    };

    const ascii = (s) => (typeof OrderTotals !== 'undefined' && OrderTotals.ascii)
        ? OrderTotals.ascii(String(s ?? ''))
        : String(s ?? '').replace(/[^\x20-\x7E]/g, '-');

    const money = (n) => (typeof OrderTotals !== 'undefined' && OrderTotals.format)
        ? OrderTotals.format(n)
        : (n === null || n === undefined ? '—' : `$${Number(n).toFixed(2)}`);

    function loadScript(url) {
        return new Promise((resolve, reject) => {
            let settled = false;
            const done = (err) => {
                if (settled) return;
                settled = true;
                if (timer) clearTimeout(timer);
                if (err) reject(err); else resolve();
            };
            // onerror never fires on a STALLED connection, which would leave the
            // button on "Preparing…" forever. Same reason as order-receipt.js.
            const timer = setTimeout(() => done(new Error('Timed out loading ' + url)), LOAD_TIMEOUT_MS);

            const existing = document.querySelector(`script[data-invoice-lib="${url}"]`);
            if (existing) {
                if (existing.dataset.loaded === '1') { done(); return; }
                existing.addEventListener('load', () => done());
                existing.addEventListener('error', () => done(new Error('Failed to load ' + url)));
                return;
            }
            const s = document.createElement('script');
            s.src = url;
            s.dataset.invoiceLib = url;
            s.onload = () => { s.dataset.loaded = '1'; done(); };
            s.onerror = () => done(new Error('Failed to load ' + url));
            document.head.appendChild(s);
        });
    }

    /** @returns {Promise<boolean>} false rather than throwing — callers degrade. */
    function ensureLib() {
        if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve(true);
        if (_libPromise) return _libPromise;
        _libPromise = (async () => {
            try {
                await loadScript(JSPDF_URL);
                await loadScript(AUTOTABLE_URL);
                return !!(window.jspdf && window.jspdf.jsPDF);
            } catch (err) {
                warn('[BusinessInvoicePdf] jsPDF failed to load', err);
                _libPromise = null;   // allow a retry on the next click
                return false;
            }
        })();
        return _libPromise;
    }

    function saveBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        // Revoking synchronously cancels the download in Safari.
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    const BusinessInvoicePdf = {

        /**
         * @param {string} id            invoice id
         * @param {string} number        invoice number, for the filename
         * @returns {Promise<{ok: boolean, source?: string, message?: string}>}
         */
        async download(id, number) {
            const name = `Invoice-${(number || id || 'invoice').replace(/[^\w.-]+/g, '')}.pdf`;

            let res;
            try {
                const base = (typeof Config !== 'undefined' && Config.API_URL) || '';
                const token = (typeof Auth !== 'undefined' && Auth.session && Auth.session.access_token) || null;
                res = await fetch(`${base}/api/business/invoices/${encodeURIComponent(id)}/pdf`, {
                    headers: token ? { Authorization: `Bearer ${token}` } : {},
                    credentials: 'omit'
                });
            } catch (e) {
                warn('[BusinessInvoicePdf] network', e && e.message);
                return { ok: false, message: "Couldn't reach the server. Check your connection and try again." };
            }

            if (res.ok) {
                saveBlob(await res.blob(), name);
                return { ok: true, source: 'stored' };
            }

            if (res.status === 403) {
                return { ok: false, message: "That invoice isn't on your account." };
            }

            // ONLY these two mean "there is no stored file". Everything else is a
            // fault, and a fault must not silently become a different document.
            if (res.status === 404 || res.status === 409) {
                const made = await this.generateCopy(id, name);
                return made.ok
                    ? { ok: true, source: 'generated' }
                    : { ok: false, message: made.message };
            }

            return { ok: false, message: "Couldn't fetch your invoice PDF just now. Please try again." };
        },

        /**
         * Local re-render, used only when no stored file exists. Stamped as a
         * copy so it can never be mistaken for the emailed document.
         */
        async generateCopy(id, filename) {
            const ready = await ensureLib();
            if (!ready) return { ok: false, message: "Couldn't prepare a PDF in this browser. Please try again." };

            let inv;
            try {
                const r = await API.get(`/api/business/invoices/${encodeURIComponent(id)}`);
                if (!r || r.ok === false) return { ok: false, message: "Couldn't load that invoice." };
                inv = r.data;
            } catch (e) {
                warn('[BusinessInvoicePdf] detail', e && e.message);
                return { ok: false, message: "Couldn't load that invoice." };
            }

            const JsPDF = window.jspdf.jsPDF;
            const doc = new JsPDF({ unit: 'pt', format: 'a4' });
            const M = 48;
            const FOOTER_RESERVE = 30;
            const pageH = doc.internal.pageSize.getHeight();
            let y = M;

            // Every writer asks for room FIRST. js/admin/pages/invoices.js's
            // buildInvoiceDoc has an unbounded cursor and writes off-page; that
            // bug is not being copied here.
            const ensure = (h) => {
                if (y + h > pageH - M - FOOTER_RESERVE) { doc.addPage(); y = M; }
            };
            const line = (text, size, gap) => {
                ensure(size + (gap || 6));
                doc.setFontSize(size);
                doc.text(ascii(text), M, y);
                y += size + (gap || 6);
            };

            line(`TAX INVOICE ${inv.invoice_number || ''}`, 16, 10);
            if (inv.issue_date) line(`Date: ${inv.issue_date}`, 10);
            if (inv.due_date) line(`Payment due: ${inv.due_date}`, 10);
            const billTo = inv.bill_to || {};
            if (billTo.company || billTo.name) line(`Bill to: ${billTo.company || billTo.name}`, 10);

            const rows = (inv.lines || []).map((l) => [
                ascii(l.code || ''), ascii(l.description || ''),
                String(l.qty ?? ''), money(l.unit_price_excl_gst), money(l.line_total_excl_gst)
            ]);
            if (rows.length && doc.autoTable) {
                doc.autoTable({
                    startY: y + 6,
                    head: [['Code', 'Description', 'Qty', 'Unit (excl GST)', 'Total (excl GST)']],
                    body: rows,
                    margin: { left: M, right: M },
                    styles: { fontSize: 9 }
                });
                // autoTable paginates itself; re-anchor or the totals land on
                // page 1 underneath the table (the second bug not being copied).
                doc.setPage(doc.internal.getNumberOfPages());
                y = doc.lastAutoTable.finalY + 18;
            }

            line(`Subtotal (excl GST): ${money(inv.subtotal_excl_gst)}`, 10);
            if (inv.freight_excl_gst !== null && inv.freight_excl_gst !== undefined) {
                line(`Freight (excl GST): ${money(inv.freight_excl_gst)}`, 10);
            }
            line(`GST: ${money(inv.gst_amount)}`, 10);
            line(`TOTAL (incl GST): ${money(inv.total_incl_gst)}`, 12, 12);

            ensure(20);
            doc.setFontSize(8);
            doc.text(
                ascii(`Reproduced from your account on ${new Date().toLocaleDateString('en-NZ')} — a copy of invoice ${inv.invoice_number || ''}.`),
                M, pageH - M
            );

            doc.save(filename);
            return { ok: true };
        }
    };

    if (typeof window !== 'undefined') window.BusinessInvoicePdf = BusinessInvoicePdf;
})();
