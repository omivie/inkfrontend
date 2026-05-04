/**
 * PRINTER-DATA.JS
 * ================
 * Brand slug → display name lookup.
 *
 * History (May 2026): this module used to carry ~600 lines of SERIES_PATTERNS,
 * a normalised series-prefix matcher, an ink/toner classifier with brand-
 * specific NON_INK exclusion lists, and a groupPrintersBySeries helper. All of
 * that pipeline now runs server-side — `/api/printers/by-brand/<brand>?
 * grouped=true&exclude_non_ink=true` returns the dropdown shape directly with
 * the same patterns. Only BRAND_NAMES survives because the account printer-
 * save form still needs to write the human-readable brand back into the
 * printer record. See backend-passover task 5 / docs/storefront/value-pack-
 * and-product-url-contract.md §4.2.1.
 */

'use strict';

const PrinterData = {
    BRAND_NAMES: {
        brother: 'Brother',
        canon: 'Canon',
        epson: 'Epson',
        hp: 'HP',
        samsung: 'Samsung',
        lexmark: 'Lexmark',
        oki: 'OKI',
        'fuji-xerox': 'Fuji Xerox',
        kyocera: 'Kyocera'
    }
};

window.PrinterData = PrinterData;
