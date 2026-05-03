/**
 * SEARCH-NORMALIZE.JS
 * ====================
 * Thin shim that holds frontend-side query-intent detection until the backend
 * starts emitting `data.intent` on `/api/search/{suggest,smart}` responses.
 *
 * History: this file used to be 481 lines and contained four functions:
 *
 *   - normalize()              — query rewriting (abbreviations, code patterns, dashes)
 *   - correctSpelling()        — Damerau-Levenshtein over a hardcoded dictionary
 *   - detectPrinterModel()     — printer-series prefix lookup
 *   - getSpellingAlternative() — NZ↔US spelling pairs
 *   - detectProductType()      — single-word "ribbon"/"toner"/"ink" → API filter
 *
 * Audit (readfirst/SEARCH_AUDIT.md, 2026-05-03) found that only `detectProductType`
 * was ever called; the other four were pure dead code. Of the four:
 *   - normalize / correctSpelling / detectPrinterModel are already done by the
 *     backend (the `/api/search/smart` envelope already returns `did_you_mean`,
 *     `corrected_from`, and `matched_printer`).
 *   - getSpellingAlternative was never wired in.
 *
 * `detectProductType` stays for one reason: when the user types `ribbon`, the
 * backend's `/api/search/smart` doesn't include the `ribbons` table, so the
 * frontend has to fire a parallel `/api/ribbons` request and merge by SKU.
 * Backend task in `readfirst/backend-passover.md` ("Search — thin-frontend
 * contract", task 1 + 4) replaces this shim with `data.intent` on the search
 * envelope. Once that ships, `shop-page.js` will read `intent.type` from the
 * response, and this file deletes entirely.
 */

'use strict';

const SearchNormalize = (() => {

    // Maps single-word queries to the correct API filter params.
    //
    // Backend valid type values:     cartridge, consumable, printer, ribbon, label_tape
    // Backend valid category values: ink, toner, printer, laser, inkjet, consumable
    //
    // The backend's /api/search/smart endpoint *does* honor the `category` and
    // `type` query params, but it does NOT search the ribbons table — so the
    // `ribbon`/`ribbons` keyword needs the parallel ribbons fetch in shop-page.js
    // until the backend includes ribbons in /smart natively.
    const PRODUCT_TYPE_KEYWORDS = {
        ribbon:  { productParams: { type: 'ribbon' },     fetchRibbons: true  },
        ribbons: { productParams: { type: 'ribbon' },     fetchRibbons: true  },
        toner:   { productParams: { category: 'toner' },  fetchRibbons: false },
        toners:  { productParams: { category: 'toner' },  fetchRibbons: false },
        ink:     { productParams: { category: 'ink' },    fetchRibbons: false },
        inks:    { productParams: { category: 'ink' },    fetchRibbons: false },
    };

    /**
     * Detect if a single-word query matches a product-type keyword.
     * Multi-word queries are NOT treated as type keywords (they may contain
     * the keyword as part of a brand or model name).
     *
     * @param {string} query
     * @returns {{ keyword: string, productParams: object, fetchRibbons: boolean }|null}
     */
    function detectProductType(query) {
        if (!query || typeof query !== 'string') return null;
        const q = query.trim().toLowerCase();
        if (/\s/.test(q)) return null;
        const config = PRODUCT_TYPE_KEYWORDS[q];
        if (!config) return null;
        return {
            keyword: q,
            productParams: config.productParams,
            fetchRibbons: config.fetchRibbons,
        };
    }

    return { detectProductType };
})();

window.SearchNormalize = SearchNormalize;
