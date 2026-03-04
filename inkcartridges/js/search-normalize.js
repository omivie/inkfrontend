/**
 * SEARCH-NORMALIZE.JS
 * ====================
 * Client-side query normalization, spelling correction, and printer model detection.
 * Preprocesses search input before sending to the backend API.
 *
 * Exposes global `SearchNormalize` with:
 *   - normalize(query)         — deterministic string transforms (always runs)
 *   - correctSpelling(query)   — Levenshtein-based correction (on 0 results)
 *   - detectPrinterModel(query) — checks if query matches a known printer model
 */

'use strict';

const SearchNormalize = (() => {

    // =========================================================================
    // 1a. QUERY NORMALIZATION
    // =========================================================================

    /**
     * Brand+code patterns for smart space/dash insertion.
     * Order matters — more specific patterns first.
     *
     * Each entry: [regex, replacement]
     * All patterns are case-insensitive.
     */
    const CODE_PATTERNS = [
        // Brother toner/drum: TN-2450, DR-2425 (use dashes)
        [/\b(TN|DR)(\d{3,5})(XL|XXL)?\b/gi, '$1-$2$3'],
        // Brother ink: LC231, LC233, LC3317 (NO dash — product codes don't use them)
        // Left as-is intentionally — no transform needed
        // Canon: PGI-680, CLI-681, PG-645, CL-646, CART-335
        [/\b(PGI|CLI|PG|CL|CART)(\d{3,4})(XL|XXL)?\b/gi, '$1-$2$3'],
        // Samsung: CLT-K406S, CLT-C404S
        [/\b(CLT)([KCMY]\d{3,4}\w?)\b/gi, '$1-$2'],
        // Kyocera: TK-1184, TK-5244
        [/\b(TK)(\d{3,5})\b/gi, '$1-$2'],
        // Epson: T502, T552, C13T502 — no dash, just space from brand
        [/\b(C13T|T)(\d{3,4})(XL|XXL)?\b/gi, '$1$2$3'],
        // HP: HP 63, HP 67XL — insert space between HP and number
        [/\b(HP)(\d{1,4})(XL|XXL)?\b/gi, '$1 $2$3'],
    ];

    /**
     * Abbreviation expansions — whole-word only.
     */
    const ABBREVIATIONS = {
        'blk': 'black',
        'clr': 'colour',
        'cart': 'cartridge',
        'mag': 'magenta',
        'cyn': 'cyan',
        'yel': 'yellow',
        'compat': 'compatible',
        'gen': 'genuine',
    };

    // Pre-build abbreviation regex (word boundaries, case-insensitive)
    const ABBREV_REGEX = new RegExp(
        '\\b(' + Object.keys(ABBREVIATIONS).join('|') + ')\\b', 'gi'
    );

    /**
     * Normalize a search query — deterministic, always runs.
     * @param {string} query - Raw user input
     * @returns {{ normalized: string, original: string, changed: boolean }}
     */
    function normalize(query) {
        if (!query || typeof query !== 'string') {
            return { normalized: '', original: '', changed: false };
        }

        const original = query;
        let q = query;

        // 1. Basic cleanup: trim, collapse spaces, strip # symbols
        q = q.trim();
        q = q.replace(/\s+/g, ' ');
        q = q.replace(/#/g, '');

        // 2. Dash normalization: em/en dashes → ASCII hyphen
        q = q.replace(/[\u2013\u2014\u2015]/g, '-');

        // 3. Smart space/dash insertion for brand+code patterns
        for (const [pattern, replacement] of CODE_PATTERNS) {
            q = q.replace(pattern, replacement);
        }

        // 4. XL/XXL normalization: case-normalize, remove space before XL
        q = q.replace(/\s+(xxl)\b/gi, 'XXL');
        q = q.replace(/\s+(xl)\b/gi, 'XL');
        q = q.replace(/\b(xxl)\b/gi, 'XXL');
        q = q.replace(/\b(xl)\b/gi, 'XL');

        // 5. Abbreviation expansion (whole-word only)
        q = q.replace(ABBREV_REGEX, (match) => {
            return ABBREVIATIONS[match.toLowerCase()] || match;
        });

        // Collapse any double spaces introduced by transforms
        q = q.replace(/\s+/g, ' ').trim();

        return {
            normalized: q,
            original: original,
            changed: q.toLowerCase() !== original.toLowerCase()
        };
    }


    // =========================================================================
    // 1b. SPELLING CORRECTION
    // =========================================================================

    /**
     * Common misspelling map — checked before Levenshtein for speed.
     */
    const MISSPELLINGS = {
        'brotehr': 'brother',
        'borther': 'brother',
        'broher': 'brother',
        'brothr': 'brother',
        'bother': 'brother',
        'brohter': 'brother',
        'epsom': 'epson',
        'espon': 'epson',
        'epsion': 'epson',
        'canno': 'canon',
        'cannin': 'canon',
        'connon': 'canon',
        'conon': 'canon',
        'samsun': 'samsung',
        'samung': 'samsung',
        'samsumg': 'samsung',
        'lexmar': 'lexmark',
        'lexmakr': 'lexmark',
        'kyocrea': 'kyocera',
        'kyocrea': 'kyocera',
        'kycera': 'kyocera',
        'xerx': 'xerox',
        'xeox': 'xerox',
        'fujixerox': 'fuji xerox',
        'cartrige': 'cartridge',
        'cartrdige': 'cartridge',
        'cartrige': 'cartridge',
        'catrridge': 'cartridge',
        'catridge': 'cartridge',
        'cartrdge': 'cartridge',
        'cartiridge': 'cartridge',
        'tonner': 'toner',
        'tonar': 'toner',
        'tonr': 'toner',
        'compatable': 'compatible',
        'compatiable': 'compatible',
        'compatble': 'compatible',
        'compatibel': 'compatible',
        'geniune': 'genuine',
        'genuien': 'genuine',
        'geunine': 'genuine',
        'genuinue': 'genuine',
        'lazerjet': 'laserjet',
        'laserjet': 'laserjet',
        'laserget': 'laserjet',
        'lasrjet': 'laserjet',
        'deskejt': 'deskjet',
        'deskket': 'deskjet',
        'desjet': 'deskjet',
        'officejet': 'officejet',
        'oficjet': 'officejet',
        'offiecjet': 'officejet',
        'magneta': 'magenta',
        'maganta': 'magenta',
        'mangeta': 'magenta',
        'yelow': 'yellow',
        'yello': 'yellow',
        'yelloow': 'yellow',
        'priner': 'printer',
        'pritner': 'printer',
        'pirinter': 'printer',
        'ribben': 'ribbon',
        'ribon': 'ribbon',
        'ribbion': 'ribbon',
        'pixam': 'pixma',
        'pxima': 'pixma',
        'pixa': 'pixma',
        'ecotank': 'ecotank',
        'eckotank': 'ecotank',
        'ecosank': 'ecotank',
        'colur': 'colour',
        'colout': 'colour',
        'collor': 'colour',
        'coour': 'colour',
        'balck': 'black',
        'blakc': 'black',
        'blaack': 'black',
    };

    /**
     * Dictionary for Levenshtein matching.
     */
    const DICTIONARY = [
        // Brands
        'hp', 'brother', 'canon', 'epson', 'samsung', 'lexmark', 'oki',
        'kyocera', 'fuji', 'xerox', 'ricoh', 'dell', 'konica', 'minolta',
        // Product types
        'cartridge', 'toner', 'drum', 'ink', 'ribbon', 'inkjet', 'laser',
        // Attributes
        'compatible', 'genuine', 'original', 'black', 'cyan', 'magenta',
        'yellow', 'colour', 'color', 'photo', 'high', 'yield', 'standard',
        'value', 'pack', 'twin', 'combo', 'xl', 'xxl',
        // Printer series
        'deskjet', 'laserjet', 'officejet', 'envy', 'pixma', 'ecotank',
        'workforce', 'expression', 'mfc', 'dcp', 'imageclass', 'smarttank',
        // Product terms
        'printer', 'cartridges', 'toners', 'inks', 'ribbons', 'refill',
    ];

    /**
     * NZ spelling pairs — try both variants.
     */
    const SPELLING_PAIRS = [
        ['colour', 'color'],
        ['grey', 'gray'],
    ];

    /**
     * Damerau-Levenshtein distance (supports transpositions).
     */
    function damerauLevenshtein(a, b) {
        const la = a.length;
        const lb = b.length;

        if (la === 0) return lb;
        if (lb === 0) return la;

        const d = [];
        for (let i = 0; i <= la; i++) {
            d[i] = [i];
        }
        for (let j = 0; j <= lb; j++) {
            d[0][j] = j;
        }

        for (let i = 1; i <= la; i++) {
            for (let j = 1; j <= lb; j++) {
                const cost = a[i - 1] === b[j - 1] ? 0 : 1;
                d[i][j] = Math.min(
                    d[i - 1][j] + 1,       // deletion
                    d[i][j - 1] + 1,        // insertion
                    d[i - 1][j - 1] + cost  // substitution
                );
                // Transposition
                if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
                    d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + cost);
                }
            }
        }

        return d[la][lb];
    }

    /**
     * Find the best dictionary match for a single word.
     * @returns {string|null} corrected word or null
     */
    function findBestMatch(word) {
        const lower = word.toLowerCase();

        // Check direct misspelling map first
        if (MISSPELLINGS[lower]) {
            return MISSPELLINGS[lower];
        }

        // Skip very short words (1-2 chars) — too ambiguous
        if (lower.length < 3) return null;

        // Skip words that look like product codes (contain digits)
        if (/\d/.test(lower)) return null;

        // Set max distance threshold based on word length
        const maxDist = lower.length <= 5 ? 1 : 2;

        let bestMatch = null;
        let bestDist = maxDist + 1;

        for (const dictWord of DICTIONARY) {
            // Quick length check — skip if too different
            if (Math.abs(lower.length - dictWord.length) > maxDist) continue;

            const dist = damerauLevenshtein(lower, dictWord);
            if (dist < bestDist) {
                bestDist = dist;
                bestMatch = dictWord;
            }
        }

        return bestDist <= maxDist ? bestMatch : null;
    }

    /**
     * Correct spelling in a query — runs only when search returns 0 results.
     * @param {string} query - Normalized query
     * @returns {{ corrected: string, original: string, didCorrect: boolean }}
     */
    function correctSpelling(query) {
        if (!query || typeof query !== 'string') {
            return { corrected: '', original: '', didCorrect: false };
        }

        const original = query;
        const words = query.split(/\s+/);
        let anyChanged = false;

        const correctedWords = words.map(word => {
            const match = findBestMatch(word);
            if (match && match !== word.toLowerCase()) {
                anyChanged = true;
                // Preserve original casing style if possible
                if (word[0] === word[0].toUpperCase() && word.length > 1) {
                    return match.charAt(0).toUpperCase() + match.slice(1);
                }
                return match;
            }
            return word;
        });

        const corrected = correctedWords.join(' ');

        return {
            corrected: corrected,
            original: original,
            didCorrect: anyChanged
        };
    }

    /**
     * Get NZ spelling alternative for a query.
     * E.g., if query has "colour", returns variant with "color" and vice versa.
     * @param {string} query
     * @returns {string|null} alternative query or null
     */
    function getSpellingAlternative(query) {
        const lower = query.toLowerCase();
        for (const [nz, us] of SPELLING_PAIRS) {
            if (lower.includes(nz)) {
                return query.replace(new RegExp(nz, 'gi'), us);
            }
            if (lower.includes(us)) {
                return query.replace(new RegExp(us, 'gi'), nz);
            }
        }
        return null;
    }


    // =========================================================================
    // 1c. PRINTER MODEL DETECTION
    // =========================================================================

    /**
     * Check if query matches a known printer model.
     * Reuses PrinterData.SERIES_PATTERNS if loaded.
     * @param {string} query
     * @returns {{ matched: true, brand: string, brandName: string, modelQuery: string }|null}
     */
    function detectPrinterModel(query) {
        if (!query || typeof PrinterData === 'undefined' || !PrinterData.SERIES_PATTERNS) {
            return null;
        }

        const q = query.trim();

        // Brand display names
        const brandNames = {
            brother: 'Brother',
            canon: 'Canon',
            epson: 'Epson',
            hp: 'HP',
            samsung: 'Samsung',
            lexmark: 'Lexmark',
            kyocera: 'Kyocera',
            oki: 'OKI',
            'fuji-xerox': 'Fuji Xerox',
            ricoh: 'Ricoh',
            dell: 'Dell',
        };

        for (const [brand, patterns] of Object.entries(PrinterData.SERIES_PATTERNS)) {
            for (const pat of patterns) {
                const prefix = pat.prefix;
                // Check if the query starts with or matches a series prefix
                if (q.toLowerCase().startsWith(prefix.toLowerCase())) {
                    return {
                        matched: true,
                        brand: brand,
                        brandName: brandNames[brand] || brand,
                        modelQuery: q
                    };
                }
            }
        }

        // Also check for brand name + model pattern (e.g., "Brother MFC-J480DW")
        for (const [brand, displayName] of Object.entries(brandNames)) {
            const lowerQ = q.toLowerCase();
            const lowerBrand = displayName.toLowerCase();
            if (lowerQ.startsWith(lowerBrand + ' ') && lowerQ.length > lowerBrand.length + 2) {
                const modelPart = q.slice(displayName.length).trim();
                // Check if the model part matches a series pattern for this brand
                const patterns = PrinterData.SERIES_PATTERNS[brand] || [];
                for (const pat of patterns) {
                    if (modelPart.toLowerCase().startsWith(pat.prefix.toLowerCase())) {
                        return {
                            matched: true,
                            brand: brand,
                            brandName: displayName,
                            modelQuery: q
                        };
                    }
                }
            }
        }

        return null;
    }


    // =========================================================================
    // 1d. PRODUCT TYPE DETECTION
    // =========================================================================

    // Maps single-word queries to the correct API filter params.
    // Backend valid type values: cartridge, consumable, printer, ribbon, label_tape
    // Backend valid category values: ink, toner, printer, laser, inkjet, consumable
    const PRODUCT_TYPE_KEYWORDS = {
        'ribbon':  { productParams: { type: 'ribbon' }, fetchRibbons: true },
        'ribbons': { productParams: { type: 'ribbon' }, fetchRibbons: true },
        'toner':   { productParams: { category: 'toner' }, fetchRibbons: false },
        'toners':  { productParams: { category: 'toner' }, fetchRibbons: false },
        'ink':     { productParams: { category: 'ink' }, fetchRibbons: false },
        'inks':    { productParams: { category: 'ink' }, fetchRibbons: false },
    };

    /**
     * Detect if a query is a single product-type keyword (e.g. "ribbon", "toner").
     * Multi-word queries are NOT treated as type keywords.
     * @param {string} query
     * @returns {{ keyword: string, productParams: object, fetchRibbons: boolean }|null}
     */
    function detectProductType(query) {
        if (!query || typeof query !== 'string') return null;
        const q = query.trim().toLowerCase();
        if (/\s/.test(q)) return null; // multi-word = not a type keyword
        const config = PRODUCT_TYPE_KEYWORDS[q];
        if (!config) return null;
        return {
            keyword: q,
            productParams: config.productParams,
            fetchRibbons: config.fetchRibbons,
        };
    }


    // =========================================================================
    // PUBLIC API
    // =========================================================================

    return {
        normalize,
        correctSpelling,
        detectPrinterModel,
        detectProductType,
        getSpellingAlternative,
    };

})();

window.SearchNormalize = SearchNormalize;
