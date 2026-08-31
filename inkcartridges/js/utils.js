/**
 * UTILS.JS
 * ========
 * Utility functions for InkCartridges.co.nz
 *
 * This file contains reusable helper functions used across the site.
 * These are framework-agnostic vanilla JavaScript utilities.
 *
 * Contents:
 * - DOM utilities
 * - Storage utilities
 * - Debounce utility
 */

'use strict';

/**
 * DOM UTILITIES
 * =============
 */

/**
 * Shorthand for querySelector
 * @param {string} selector - CSS selector
 * @param {Element} context - Optional context element
 * @returns {Element|null}
 */
function $(selector, context = document) {
    return context.querySelector(selector);
}

/**
 * Shorthand for querySelectorAll
 * @param {string} selector - CSS selector
 * @param {Element} context - Optional context element
 * @returns {NodeList}
 */
function $$(selector, context = document) {
    return context.querySelectorAll(selector);
}

/**
 * Add event listener to single or multiple elements
 * @param {Element|NodeList|string} target - Element, NodeList, or selector
 * @param {string} event - Event type
 * @param {Function} callback - Event handler
 */
function on(target, event, callback) {
    if (typeof target === 'string') {
        target = $$(target);
    }
    if (target instanceof NodeList) {
        target.forEach(el => el.addEventListener(event, callback));
    } else if (target) {
        target.addEventListener(event, callback);
    }
}


/**
 * STORAGE UTILITIES
 * =================
 */

/**
 * Get item from localStorage with JSON parsing
 * @param {string} key - Storage key
 * @param {*} defaultValue - Default value if not found
 * @returns {*}
 */
function getStorage(key, defaultValue = null) {
    try {
        const item = localStorage.getItem(key);
        return item ? JSON.parse(item) : defaultValue;
    } catch (e) {
        DebugLog.error('Error reading from localStorage:', e);
        return defaultValue;
    }
}

/**
 * Set item in localStorage with JSON stringification
 * @param {string} key - Storage key
 * @param {*} value - Value to store
 */
function setStorage(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
        DebugLog.error('Error writing to localStorage:', e);
    }
}


/**
 * COLOR UTILITIES
 * ===============
 * Shared color mapping for product display (ink/toner colors)
 */

/**
 * Color map for product colors
 * Maps color names to CSS color values or gradients
 */
const ProductColors = {
    map: {
        'black': '#1a1a1a',
        'cyan': '#00bcd4',
        'magenta': '#e91e63',
        'yellow': '#ffeb3b',
        'red': '#f44336',
        'blue': '#2196f3',
        'green': '#4caf50',
        'photo black': '#000000',
        'matte black': '#2d2d2d',
        'light cyan': '#80deea',
        'light magenta': '#f48fb1',
        'gray': '#9e9e9e',
        'grey': '#9e9e9e',
        'light gray': '#bdbdbd',
        'light grey': '#bdbdbd',
        // Specialty singles present in production (Aug 2026 census of all
        // 3,969 live products). Before this block these painted NOTHING —
        // getStyle returned the caller's fallback, so a compatible row with
        // no image showed a blank/grey tile instead of its colour. Every
        // value here is a real stored products.color string; keep this map,
        // OPTIONS and COLOR_RANK in step (pinned by the colour-vocabulary
        // tests and by `npm run audit:colours`).
        'photo cyan': '#4dd0e1',
        'photo magenta': '#f06292',
        'vivid magenta': '#d81b60',
        'vivid light magenta': '#f8bbd0',
        'light black': '#424242',
        'photo grey': '#757575',
        'photo gray': '#757575',
        'photo blue': '#5c6bc0',
        'photo': '#616161',
        'violet': '#7c4dff',
        'purple': '#9c27b0',
        'orange': '#ff9800',
        'chromatic red': '#d32f2f',
        'white': '#ffffff',
        // Finishes, not inks — a coating that adds gloss/chroma rather than
        // colour. A neutral near-white reads as "clear coat" instead of
        // implying a hue the cartridge does not print. These rely on the
        // 1px border on .product-card__color-block / .product-gallery__color-block
        // to stay visible against a white card.
        'clear': '#eceff1',
        'chroma optimizer': '#eceff1',
        'gloss enhancer': '#eceff1',
        'gloss optimiser': '#eceff1',
        'gloss optimizer': '#eceff1',
        // Dual-chamber / dual-label SINGLES — one cartridge, two inks. Two
        // stripes, same explicit-stop syntax as the pack gradients below.
        'black/red': 'linear-gradient(to right, #1a1a1a 0%, #1a1a1a 50%, #f44336 50%, #f44336 100%)',
        'blue/green': 'linear-gradient(to right, #2196f3 0%, #2196f3 50%, #4caf50 50%, #4caf50 100%)',
        'magenta/yellow': 'linear-gradient(to right, #e91e63 0%, #e91e63 50%, #ffeb3b 50%, #ffeb3b 100%)',
        // Multi-color packs - vertical stripes
        'cmy': 'linear-gradient(to right, #00bcd4 0%, #00bcd4 33.33%, #e91e63 33.33%, #e91e63 66.66%, #ffeb3b 66.66%, #ffeb3b 100%)',
        'bcmy': 'linear-gradient(to right, #1a1a1a 0%, #1a1a1a 25%, #00bcd4 25%, #00bcd4 50%, #e91e63 50%, #e91e63 75%, #ffeb3b 75%, #ffeb3b 100%)',
        'kcmy': 'linear-gradient(to right, #1a1a1a 0%, #1a1a1a 25%, #00bcd4 25%, #00bcd4 50%, #e91e63 50%, #e91e63 75%, #ffeb3b 75%, #ffeb3b 100%)',
        'cmyk': 'linear-gradient(to right, #00bcd4 0%, #00bcd4 25%, #e91e63 25%, #e91e63 50%, #ffeb3b 50%, #ffeb3b 75%, #1a1a1a 75%, #1a1a1a 100%)',
        'tri-color': 'linear-gradient(to right, #00bcd4 0%, #00bcd4 33.33%, #e91e63 33.33%, #e91e63 66.66%, #ffeb3b 66.66%, #ffeb3b 100%)',
        '4-pack': 'linear-gradient(to right, #1a1a1a 0%, #1a1a1a 25%, #00bcd4 25%, #00bcd4 50%, #e91e63 50%, #e91e63 75%, #ffeb3b 75%, #ffeb3b 100%)',
        '4 pack': 'linear-gradient(to right, #1a1a1a 0%, #1a1a1a 25%, #00bcd4 25%, #00bcd4 50%, #e91e63 50%, #e91e63 75%, #ffeb3b 75%, #ffeb3b 100%)',
        'tri-colour': 'linear-gradient(to right, #00bcd4 0%, #00bcd4 33.33%, #e91e63 33.33%, #e91e63 66.66%, #ffeb3b 66.66%, #ffeb3b 100%)',
        // Unhyphenated spellings — COLOR_RANK ranks these, so the map must be
        // able to paint them or a row sorts correctly and renders blank.
        'tricolour': 'linear-gradient(to right, #00bcd4 0%, #00bcd4 33.33%, #e91e63 33.33%, #e91e63 66.66%, #ffeb3b 66.66%, #ffeb3b 100%)',
        'tricolor': 'linear-gradient(to right, #00bcd4 0%, #00bcd4 33.33%, #e91e63 33.33%, #e91e63 66.66%, #ffeb3b 66.66%, #ffeb3b 100%)',
        'black and red': 'linear-gradient(to right, #1a1a1a 0%, #1a1a1a 50%, #f44336 50%, #f44336 100%)',
        'color': 'linear-gradient(to right, #00bcd4 0%, #00bcd4 33.33%, #e91e63 33.33%, #e91e63 66.66%, #ffeb3b 66.66%, #ffeb3b 100%)',
        'colour': 'linear-gradient(to right, #00bcd4 0%, #00bcd4 33.33%, #e91e63 33.33%, #e91e63 66.66%, #ffeb3b 66.66%, #ffeb3b 100%)',
        // Pack labels that name no colour at all. Stored on real rows
        // ("Value Pack" ×20 live), so they need a swatch or the tile is blank.
        // Black + colour set → the same K/C/M/Y stripe as 'kcmy'.
        'black/colour': 'linear-gradient(to right, #1a1a1a 0%, #1a1a1a 25%, #00bcd4 25%, #00bcd4 50%, #e91e63 50%, #e91e63 75%, #ffeb3b 75%, #ffeb3b 100%)',
        'value pack': 'linear-gradient(to right, #1a1a1a 0%, #1a1a1a 25%, #00bcd4 25%, #00bcd4 50%, #e91e63 50%, #e91e63 75%, #ffeb3b 75%, #ffeb3b 100%)',
        'multipack': 'linear-gradient(to right, #1a1a1a 0%, #1a1a1a 25%, #00bcd4 25%, #00bcd4 50%, #e91e63 50%, #e91e63 75%, #ffeb3b 75%, #ffeb3b 100%)'
    },

    /**
     * Get CSS style string for a color
     * @param {string} colorName - Color name to look up
     * @param {string} fallback - Fallback style if color not found (default: null)
     * @returns {string|null} CSS style string or null/fallback
     */
    getStyle(colorName, fallback = null) {
        const normalizedColor = (colorName || '').toLowerCase().trim();
        const colorValue = this.map[normalizedColor];

        if (colorValue) {
            if (colorValue.includes('gradient')) {
                return `background: ${colorValue};`;
            }
            return `background-color: ${colorValue};`;
        }

        return fallback;
    },

    /**
     * Get CSS style string from a color_hex array (from backend API).
     * Single hex → background-color; multiple → striped gradient.
     * @param {string[]} hexArray - Array of hex strings e.g. ["#1a1a1a"] or ["#00bcd4","#e91e63"]
     * @returns {string|null}
     */
    getStyleFromHex(hexArray) {
        if (!hexArray || !Array.isArray(hexArray) || hexArray.length === 0) return null;
        if (hexArray.length === 1) return `background-color: ${hexArray[0]};`;
        const step = 100 / hexArray.length;
        const stops = hexArray.flatMap((hex, i) => [
            `${hex} ${(i * step).toFixed(2)}%`,
            `${hex} ${((i + 1) * step).toFixed(2)}%`
        ]);
        return `background: linear-gradient(to right, ${stops.join(', ')});`;
    },

    /**
     * True when a product's image_url is one of the legacy placeholder
     * "color-swatch-vN" images we hand-uploaded per SKU folder before
     * canonical color was authoritative. These images don't update when
     * an admin changes `products.color`, so a tri-colour cartridge whose
     * folder still hosts a red swatch reads as red on the storefront —
     * the bug captured in this comment block. Detecting them lets the
     * card renderers fall through to a `getProductStyle` swatch rendered
     * from the canonical color, so admin edits flow visually without a
     * fresh image upload.
     *
     * The extension is matched loosely (png/jpg/jpeg/webp). The May 2026
     * storage migration converted 2050 product images from PNG/JPG to
     * WebP (marketing-audit-may-2026.md §3), so a swatch the DB once
     * pointed at as `color-swatch-v4.png` may now end `.webp`. The
     * `color-swatch` filename stem — never the extension — is the real
     * discriminator: genuine product photos are `<sku>-<timestamp>.webp`
     * and never contain the `color-swatch` segment, so widening the
     * extension cannot misfire on a real photo.
     *
     * May 2026 — `compatible-tile` rename. The backend re-stemmed every
     * active compatible product's per-SKU image from
     * `color-swatch-vN.{webp,png}` to `compatible-tile-v1.png`. The new
     * tiles bake a "COMPATIBLE" label into the artwork and ARE meant to
     * render, so `compatible-tile-*` deliberately does NOT match this
     * regex. Two hard rules follow, both pinned by stale-color-swatch.test.js:
     *   1. Never reintroduce the `color-swatch` stem when bumping the
     *      placeholder version — a `color-swatch-v5` path would silently
     *      re-hide the baked-in label by re-triggering the stale fallback.
     *   2. Never give a real, intended-to-render image a stem this regex
     *      matches.
     * The regex now only catches dead legacy URLs still cached in
     * pre-rendered / Google-indexed HTML; it is retained as a zero-cost
     * guard (it cannot misfire on a real photo, and still protects any
     * not-yet-migrated row) until those caches age out. Once nothing
     * references the legacy paths it may be removed outright.
     */
    isPlaceholderSwatchImage(url) {
        if (!url || typeof url !== 'string') return false;
        return /\/color-swatch(?:-v\d+)?\.(?:png|jpe?g|webp)(?:\?.*)?$/i.test(url);
    },

    /**
     * Get CSS style string for any product/item object.
     * Priority: color_hex array > color name > detectFromName fallback.
     * @param {Object} obj - Product or cart item with optional color_hex, color, name fields
     * @param {string} fallback - Fallback style if no color found
     * @returns {string|null}
     */
    getProductStyle(obj, fallback = null) {
        let ch = obj && obj.color_hex;
        if (typeof ch === 'string') {
            try { ch = JSON.parse(ch); } catch { ch = null; }
        }
        if (Array.isArray(ch) && ch.length > 0) {
            return this.getStyleFromHex(ch);
        }
        const colorName = obj && (obj.color || this.detectFromName(obj.name));
        if (colorName) return this.getStyle(colorName, fallback);
        return fallback;
    },

    /**
     * Detect color from product name
     * @param {string} name - Product name
     * @returns {string|null} Detected color name or null
     */
    detectFromName(name) {
        const lowerName = (name || '').toLowerCase();

        // Check for multi-packs first
        if (lowerName.includes('4-pack') || lowerName.includes('4 pack') || lowerName.includes('4pack')) {
            return '4-pack';
        }
        if (lowerName.includes('value pack') || lowerName.includes('combo pack')) {
            return 'kcmy';
        }
        if (lowerName.includes('tri-color') || lowerName.includes('tri-colour') || lowerName.includes('tricolor')) {
            return 'tri-color';
        }

        // Check for individual colors (order matters - check compound names first)
        const colorWords = [
            'photo black', 'matte black',
            'light cyan', 'light magenta',
            'photo cyan', 'photo magenta',
            'light gray', 'light grey',
            'black', 'cyan', 'magenta',
            'yellow', 'red', 'blue', 'green', 'gray', 'grey'
        ];
        for (const color of colorWords) {
            if (lowerName.includes(color)) {
                return color;
            }
        }

        return null;
    },

    // Canonical color options for admin product editing.
    // Values match the PascalCase strings the backend stores in `products.color`.
    // ALPHABETICAL BY LABEL — that is what the admin dropdown renders, and it is
    // the ONLY order any caller gets, because the sort is applied to the list
    // itself (see the .sort() below the literal).
    //
    // It used to be grouped semantically (K → C → M → Y → packs → specialty) to
    // mirror ProductSort.COLOR_ORDER. That grouping only helps someone who
    // already knows the taxonomy: with 43 entries, finding "Violet" meant
    // scanning the whole list, and there is no reason an editor should have to
    // learn a rank order to pick a colour. Changed on the owner's instruction,
    // Aug 2026.
    //
    // **The storefront sort is unaffected.** `ProductSort.COLOR_ORDER` is
    // derived from COLOR_RANK, not from this list, so K→C→M→Y→specialty→packs
    // still governs the shop grid, PDP related rails and product cards. The
    // only other reader, `scripts/audit-colour-vocabulary.mjs`, tests
    // membership and never order.
    //
    // THE LITERAL BELOW STAYS GROUPED BY FAMILY on purpose — it is where the
    // vocabulary is documented (which blacks exist, which entries are finishes
    // rather than inks, which are dual-chamber singles). Read it for the
    // taxonomy; the sort decides what an editor sees.
    //
    // Single source of truth — admin dropdowns and the dropdown contract test
    // both bind to this list. Extending it requires no admin/UI change, and a
    // new entry lands in the right alphabetical place on its own.
    //
    // Tri-Colour vs CMY: 'CMY' is a 3-Pack of three *separate* cartridges
    // (rank 20 in ProductSort). 'Tri-Colour' is a SINGLE cartridge that
    // holds all three inks in one body (HP 22, HP 67 Tri-Colour, Canon
    // CL-541, etc.) and sits at rank 11 alongside other specialty singles.
    // The two are deliberately distinct dropdown entries — they have
    // different prices, different print yields, and different fitments.
    //
    // 'Colour' / 'Color' are DELIBERATELY ABSENT (Aug 2026, ERR-141). They
    // remain in `map` and COLOR_RANK so the rows still stored that way keep
    // rendering and sorting correctly — but offering them here is exactly how
    // 13 tri-colour singles came to be labelled with a value that says
    // nothing about how many cartridges you get. An unlisted stored value
    // renders as "Colour (legacy)" in the admin drawer, which is the nudge an
    // editor should get. `npm run audit:colours` reports the stragglers.
    OPTIONS: [
        { value: 'Black',         label: 'Black' },
        { value: 'Photo Black',   label: 'Photo Black' },
        { value: 'Matte Black',   label: 'Matte Black' },
        { value: 'Cyan',          label: 'Cyan' },
        { value: 'Photo Cyan',    label: 'Photo Cyan' },
        { value: 'Light Cyan',    label: 'Light Cyan' },
        { value: 'Magenta',       label: 'Magenta' },
        { value: 'Photo Magenta', label: 'Photo Magenta' },
        { value: 'Light Magenta', label: 'Light Magenta' },
        { value: 'Yellow',        label: 'Yellow' },
        { value: 'CMY',           label: 'CMY (3-Pack — three separate cartridges)' },
        { value: 'KCMY',          label: 'KCMY (4-Pack — four separate cartridges)' },
        { value: 'CMYK',          label: 'CMYK (4-Pack — four separate cartridges)' },
        { value: 'Tri-Colour',    label: 'Tri-Colour (single cartridge with C/M/Y)' },
        { value: 'Photo',         label: 'Photo' },
        { value: 'Red',           label: 'Red' },
        { value: 'Chromatic Red', label: 'Chromatic Red' },
        { value: 'Blue',          label: 'Blue' },
        { value: 'Photo Blue',    label: 'Photo Blue' },
        { value: 'Green',         label: 'Green' },
        { value: 'Orange',        label: 'Orange' },
        { value: 'Violet',        label: 'Violet' },
        { value: 'Purple',        label: 'Purple' },
        { value: 'Vivid Magenta', label: 'Vivid Magenta' },
        { value: 'Vivid Light Magenta', label: 'Vivid Light Magenta' },
        { value: 'Light Black',   label: 'Light Black' },
        // British spelling is what production actually stores (33 rows as of
        // Aug 2026); the US spellings are kept so existing rows and the
        // pinned dropdown ordering stay valid, but labelled so an editor
        // never picks them by accident.
        { value: 'Grey',          label: 'Grey' },
        { value: 'Light Grey',    label: 'Light Grey' },
        { value: 'Photo Grey',    label: 'Photo Grey' },
        { value: 'Gray',          label: 'Gray (US spelling — prefer Grey)' },
        { value: 'Light Gray',    label: 'Light Gray (US spelling — prefer Light Grey)' },
        { value: 'White',         label: 'White' },
        // Finishes — coatings, not inks.
        { value: 'Clear',         label: 'Clear' },
        { value: 'Chroma Optimizer', label: 'Chroma Optimizer (finish, not an ink)' },
        { value: 'Gloss Enhancer',   label: 'Gloss Enhancer (finish, not an ink)' },
        { value: 'Gloss Optimiser',  label: 'Gloss Optimiser (finish, not an ink)' },
        // Dual-chamber / dual-label SINGLES — one cartridge, two inks.
        { value: 'Black/Red',     label: 'Black/Red' },
        { value: 'Blue/Green',    label: 'Blue/Green' },
        { value: 'Magenta/Yellow', label: 'Magenta/Yellow' },
        { value: 'Black/Colour',  label: 'Black/Colour (black + tri-colour set)' },
        { value: 'Value Pack',    label: 'Value Pack' },
        { value: 'Multipack',     label: 'Multipack' }
    // Sorted by the LABEL, because the label is what the editor reads — so
    // "CMY (3-Pack …)" files under C, not under whatever its value spells.
    //
    // Deliberately NOT localeCompare. With options its result depends on the
    // runtime's ICU data, so the same list can order differently under a
    // small-icu Node build or another browser locale — and a dropdown whose
    // order depends on where the code runs is not a sorted dropdown. An
    // uppercase code-unit comparison is total, stable and identical everywhere,
    // which also lets the contract test mirror it exactly.
    ].sort((a, b) => {
        const A = a.label.toUpperCase();
        const B = b.label.toUpperCase();
        return A < B ? -1 : A > B ? 1 : 0;
    }),

    // Multi-cartridge pack colors — the values the admin "Packs" filter matches.
    // Every entry MUST also exist in OPTIONS above (contract-tested): a value
    // that doesn't exactly match a stored products.color string silently
    // matches ZERO rows (the ERR-075 drum/paper failure mode).
    // 'Tri-Colour' is deliberately NOT here — it's ONE cartridge (see note above).
    //
    // 'CMYK' and 'Black/Colour' added Aug 2026 (ERR-141): all 5 live rows
    // carrying them are pack_type='value_pack' 4-packs (G702XLCMYK, G288CMYK,
    // G3YP09AACMYK, G932XLCMYK, G60BKCLRVP), so the admin Packs filter was
    // showing them as singles. ERR-075 cuts both ways — a pack colour MISSING
    // from this list hides real packs just as surely as a bogus value shows none.
    PACK_VALUES: ['CMY', 'KCMY', 'CMYK', 'Black/Colour', 'Value Pack', 'Multipack']
};

// Make ProductColors available globally (browser-only; Node test runs skip this).
if (typeof window !== 'undefined') window.ProductColors = ProductColors;


/**
 * TIMING UTILITIES
 * ================
 */

/**
 * Debounce function - delays execution until after wait period
 * @param {Function} func - Function to debounce
 * @param {number} wait - Wait time in milliseconds
 * @returns {Function}
 */
function debounce(func, wait = 300) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}


/**
 * URL BUILDERS
 * ============
 */

/**
 * Slugify a brand display name (e.g. "Fuji Xerox" → "fuji-xerox", "HP" → "hp").
 * Used by buildPrinterUrl to recover brand_slug when the payload only carries
 * a display-name string (saved-printer rows, trending-printer fallbacks).
 */
function slugifyBrand(value) {
    if (value == null) return '';
    return String(value)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

if (typeof window !== 'undefined') {
    window.slugifyBrand = slugifyBrand;
}

/**
 * Build the canonical printer-page URL.
 *
 * Spec contract (docs: search-dropdown-routing.md, May 2026 + brand-canonical
 * audit, May-2026): `/shop?brand=<brand_slug>&printer_slug=<slug>` — ALWAYS
 * with brand. The bot-prerender middleware only rewrites to the SEO
 * prerender API when BOTH params are present. Anything else (e.g. legacy
 * `?printer=<slug>` or bare `?printer_slug=<slug>`) gets the empty SPA shell
 * from Googlebot, breaks the sitemap canonical, and creates duplicate-content
 * for the printer page.
 *
 * Brand-slug resolution ladder (any source is acceptable):
 *   1. printer.brand_slug              ← canonical /api responses
 *   2. printer.brand.slug              ← nested search-printers shape
 *   3. printer.printer_models.brand_slug  ← saved-printer join shape
 *   4. slugifyBrand(printer.brand_name) ← display-name fallback
 *   5. slugifyBrand(printer.brand) when typeof brand === 'string'
 *
 * Only when ALL five fail does `allowUnbranded` come into play. The unbranded
 * form is permitted only for user-click affordances behind auth (e.g. saved-
 * printer CTA on /account/printers, which is not in the search index) or
 * <button>-driven navigation (trending chips). Public, indexable <a> tags
 * MUST resolve to the branded form or hide the affordance.
 *
 * @param {Object|null} printer
 *   Printer-shaped object. Accepts any combination of:
 *     { slug, printer_slug, brand_slug, brand, brand_name, printer_models }
 *   where `brand` may be `{ slug }`, `{ name }`, or a display-name string.
 * @param {{ allowUnbranded?: boolean }} [opts]
 * @returns {string|null} Canonical URL or null when required fields are missing.
 */
function buildPrinterUrl(printer, opts) {
    if (!printer || typeof printer !== 'object') return null;
    const slug = printer.slug || printer.printer_slug
        || (printer.printer_models && printer.printer_models.slug)
        || '';
    if (!slug) return null;

    const nested = printer.printer_models || printer.printer || null;
    let brandSlug = printer.brand_slug
        || (printer.brand && typeof printer.brand === 'object' ? printer.brand.slug : null)
        || (nested && nested.brand_slug)
        || (nested && nested.brand && typeof nested.brand === 'object' ? nested.brand.slug : null)
        || '';

    if (!brandSlug) {
        // Display-name fallback. Saved-printer rows ship `brand` as a plain
        // string (e.g. "Brother"); slugify it so we still emit the canonical
        // branded URL.
        const brandName = printer.brand_name
            || (typeof printer.brand === 'string' ? printer.brand : null)
            || (printer.brand && typeof printer.brand === 'object' ? printer.brand.name : null)
            || (nested && nested.brand_name)
            || (nested && typeof nested.brand === 'string' ? nested.brand : null)
            || '';
        if (brandName) brandSlug = slugifyBrand(brandName);
    }

    if (brandSlug) {
        return `/shop?brand=${encodeURIComponent(brandSlug)}&printer_slug=${encodeURIComponent(slug)}`;
    }
    if (opts && opts.allowUnbranded) {
        return `/shop?printer_slug=${encodeURIComponent(slug)}`;
    }
    return null;
}

if (typeof window !== 'undefined') {
    window.buildPrinterUrl = buildPrinterUrl;
}


/**
 * STORAGE URL UTILITY
 * ===================
 */

/**
 * Resolve a Supabase Storage relative path to a full URL.
 * Routes through the backend image optimization API for WebP conversion,
 * resizing, and immutable caching. Falls back to direct Supabase URL
 * if Config.API_URL is not available.
 *
 * @param {string} path - Relative or absolute image path
 * @returns {string} Optimized image URL or placeholder
 */
function storageUrl(path) {
    if (!path) return '/assets/images/placeholder-product.svg';
    if (path.startsWith('/')) return path; // local asset
    // Route through image optimization API (WebP, cached, resized)
    return optimizedImageUrl(path, 400);
}

/**
 * Get the raw (non-optimized) Supabase Storage URL for an image.
 * Use this only when you need the original file (e.g. admin image management).
 *
 * @param {string} path - Relative or absolute image path
 * @returns {string} Direct Supabase Storage URL or placeholder
 */
function storageUrlRaw(path) {
    if (!path) return '/assets/images/placeholder-product.svg';
    if (path.startsWith('http')) return path;
    if (path.startsWith('/')) return path;
    const baseUrl = typeof Config !== 'undefined' ? Config.SUPABASE_URL : '';
    return `${baseUrl}/storage/v1/object/public/public-assets/${path}`;
}

/**
 * Route an image through the backend optimization API.
 * Returns a URL that serves the image as WebP at the requested width,
 * with immutable caching (1 year) and in-memory server cache.
 *
 * @param {string} path  - Relative Supabase path or full URL
 * @param {number} width - Target width in pixels (1-1200, default 400)
 * @param {string} format - "webp", "png", or "jpeg" (default "webp")
 * @returns {string} Optimized image URL via /api/images/optimize
 */
function optimizedImageUrl(path, width = 400, format = 'webp') {
    if (!path) return '/assets/images/placeholder-product.svg';
    if (path.startsWith('/')) return path; // local asset, skip
    const apiUrl = typeof Config !== 'undefined' ? Config.API_URL : '';
    const encoded = encodeURIComponent(path);
    return `${apiUrl}/api/images/optimize?url=${encoded}&w=${width}&format=${format}`;
}

/**
 * Generate an HTML srcset attribute value for responsive images.
 * Uses the backend image optimization API at multiple widths.
 *
 * @param {string} path   - Relative Supabase path or full URL
 * @param {number[]} widths - Array of widths (default [200, 400, 800])
 * @returns {string} srcset value, e.g. "url 200w, url 400w, url 800w"
 */
function imageSrcset(path, widths = [200, 400, 800]) {
    if (!path || path.startsWith('/')) return '';
    return widths
        .map(w => `${optimizedImageUrl(path, w)} ${w}w`)
        .join(', ');
}


/**
 * DEBUG LOGGER
 * ============
 * Conditional logger that only outputs in development (localhost).
 * Prevents information leakage in production.
 */
const DebugLog = {
    _isDev: typeof window !== 'undefined' && (
        window.location.hostname === 'localhost' ||
        window.location.hostname === '127.0.0.1'
    ),
    log(...args) { if (this._isDev) console.log(...args); },
    warn(...args) { if (this._isDev) console.warn(...args); },
    error(...args) { if (this._isDev) console.error(...args); },
    info(...args) { if (this._isDev) console.info(...args); }
};
if (typeof window !== 'undefined') window.DebugLog = DebugLog;


/**
 * ESCAPING SHORTCUTS
 * ==================
 * Safe wrappers around Security.escapeHtml / escapeAttr.
 * Falls back to identity if Security hasn't loaded (shouldn't happen in production).
 */
function esc(s) {
    return typeof Security !== 'undefined' ? Security.escapeHtml(s) : String(s);
}

function escAttr(s) {
    return typeof Security !== 'undefined' ? Security.escapeAttr(s) : String(s);
}


/**
 * Stub — admin role is no longer cached client-side (sessionStorage is user-controlled).
 * Backend re-verifies on every admin request. Always returns false.
 * @returns {boolean}
 */
function isCachedSuperAdmin() {
    return false;
}


/**
 * PRODUCTSORT
 * ===========
 * Shared catalog-sort contract. Frontend mirror of the backend's
 * `src/utils/productSort.js` so the storefront's secondary sort never
 * disturbs the backend's primary order.
 *
 * Canonical display order (May 2026 — sort-hierarchy-may2026.md):
 *
 *   Within a single (yieldTier, seriesBase) group:
 *
 *     0   Black   (K)              ─┐
 *     1   Cyan    (C)               │ standard singles
 *     2   Magenta (M)               │
 *     3   Yellow  (Y)              ─┘
 *     4   Photo Black   (PB)       ─┐
 *     5   Matte Black   (MB)        │
 *     6   Light Cyan    (LC)        │
 *     6.5 Photo Cyan    (PC)        │
 *     7   Light Magenta (LM)        │
 *     7.5 Photo Magenta (PM)        │ specialty singles
 *     8   Vivid Light Magenta (VLM) │
 *     9   Grey                      │
 *     10  Violet                    │
 *     11  Tri-Colour (single        │
 *         cartridge, e.g. HP 22)    │
 *     12  Red                       │
 *     13  Blue                      │
 *     14  Green                     │
 *     15  Orange                    │
 *     16  White                     │
 *     17  Black/Red (legacy)       ─┘
 *     19  Unknown single
 *     20  CMY 3-Pack               ─┐ packs
 *     21  KCMY 4-Pack / CMYK / BCMY ┘
 *
 * Sort key tuple: (accessoryTier, yieldTier, seriesBase, colorOrder, packRank, name)
 *
 *   - accessoryTier — cartridges (0) before paper/printers/accessories (3).
 *   - yieldTier     — std (0) → XL/HY (1) → XXL/SHY/XLL (2). HY ≡ XL.
 *   - seriesBase    — alphanumeric MPN family with yield + colour suffixes
 *                     stripped (`TN645`, `LC3317`, `BCI6`, `975A`).
 *   - colorOrder    — table above. Pack-name regex first to defend against
 *                     mislabeled feed rows (color="Black" on a KCMY pack).
 *   - packRank      — single (0) < value_pack (1) < multipack (2). Defends
 *                     against the rare colorOrder tie.
 *   - name          — final lexicographic tiebreaker.
 *
 * Why singles always rank below packs: customers shopping a series want to
 * evaluate every individual cartridge first, then decide whether the bundle
 * is worthwhile. The pre-May-2026 frontend collapsed every specialty colour
 * into the parent tier (Photo Black → K, Light Cyan → C), which inverted the
 * intended hierarchy on Epson 46S, Canon CLI42, and any printer with photo /
 * matte / light variants. The new table promotes packs to 20/21, leaving 4-17
 * for specialty singles so std → specialty → packs reads cleanly.
 *
 * Spec: readfirst/sort-hierarchy-may2026.md
 * Pinned by: tests/sort-hierarchy-may2026.test.js,
 *            tests/color-display-order.test.js,
 *            tests/code-yield-grouping-may2026.test.js
 */
const ProductSort = (function() {
    // ─── COLOR_RANK ─────────────────────────────────────────────────────
    //
    // The 22-position rank table. Source of truth for `colorOrder()`.
    //
    // All keys are lowercased canonical color strings or aliases. Float
    // ranks (e.g. 6.5 for Photo Cyan) are deliberate — they let new
    // colours slot between existing ranks without renumbering downstream
    // entries or breaking previously-pinned ordering invariants.
    const COLOR_RANK = Object.freeze({
        // Standard singles (0-3)
        'black': 0,
        'k':     0,
        'cyan':  1,
        'c':     1,
        'magenta': 2,
        'm':       2,
        'yellow':  3,
        'y':       3,

        // Specialty singles (4-17)
        'photo black':         4,
        'pb':                  4,
        'pgbk':                4,   // pigment black, often co-billed with photo black
        'matte black':         5,
        'mb':                  5,
        'mbk':                 5,
        'light black':         5.5,   // K-family, after matte black
        'lbk':                 5.5,
        'light cyan':          6,
        'lc':                  6,
        'photo cyan':          6.5,
        'pc':                  6.5,
        'light magenta':       7,
        'lm':                  7,
        'photo magenta':       7.5,
        'pm':                  7.5,
        'vivid magenta':       7.8,
        'vm':                  7.8,
        'vivid light magenta': 8,
        'vlm':                 8,
        'grey':                9,
        'gray':                9,
        'light grey':          9.3,
        'light gray':          9.3,
        'photo grey':          9.6,
        'photo gray':          9.6,
        'violet':             10,
        'purple':             10.5,
        'tri-colour':         11,
        'tri-color':          11,
        'tricolour':          11,
        'tricolor':           11,
        'colour':             11,   // single tri-colour cartridge label
        'color':              11,
        'red':                12,
        'r':                  12,
        'chromatic red':      12.5,
        'blue':               13,
        'b':                  13,
        'photo blue':         13.5,
        'green':              14,
        'g':                  14,
        'orange':             15,
        'o':                  15,
        'white':              16,
        'w':                  16,
        'black/red':          17,
        'black and red':      17,
        'blue/green':         17.2,   // dual-chamber singles join Black/Red
        'magenta/yellow':     17.4,
        // Finishes (18.x) — coatings, not inks. Last among singles but still
        // below RANK_UNKNOWN_SINGLE (19) so a genuinely unknown colour stays
        // distinguishable from a known finish, and below 20 so colorTier()
        // keeps bucketing them as SPECIALTY rather than as a pack.
        'clear':              18.0,
        'chroma optimizer':   18.2,
        'co':                 18.2,
        'gloss enhancer':     18.4,
        'gloss optimiser':    18.4,
        'gloss optimizer':    18.4,
        'photo':              18.6,   // generic "Photo", ahead of unknown

        // Pack ranks (20-21) — colorOrder values for canonical pack labels.
        // Pack-name regex still wins over these so a "Black" value pack
        // resolves correctly via PACK_NAME_REGEX.
        'cmy':       20,
        '3-pack':    20,
        '3 pack':    20,
        'kcmy':      21,
        'cmyk':      21,
        'bcmy':      21,
        '4-pack':    21,
        '4 pack':    21
    });

    // Unknown single — between specialty (4-17) and packs (20-21). A row
    // whose color string isn't in COLOR_RANK and isn't pack-shaped lands
    // here so it sits below known singles but above packs.
    const RANK_UNKNOWN_SINGLE = 19;

    // Pack-name fallback regex. Some supplier feeds ship value packs with
    // `color = "Black"` (the SKU's "primary" colour). Without this, a
    // "Brother Genuine LC3317 KCMY 4-Pack" with color="Black" would
    // inherit colorOrder=0 and rank ahead of the K single. We detect the
    // pack shape from the name FIRST, so colorOrder=21 even when color=Black.
    //
    // KCMY/CMYK/BCMY/4-pack/4 colour → 21
    // CMY/3-pack/3 colour            → 20
    // Order matters: KCMY pattern checked first because "CMY" is a strict
    // subset of "KCMY". The 4-token branch must short-circuit.
    const PACK_NAME_REGEX_4 = /\b(?:KCMY|CMYK|BCMY)\b|\b4\s*colou?r\b|\b4\s*-?\s*pack\b/i;
    const PACK_NAME_REGEX_3 = /\bCMY\b|\b3\s*colou?r\b|\b3\s*-?\s*pack\b/i;

    // Legacy COLOR_ORDER list — derived from COLOR_RANK keys, sorted by
    // their rank, with aliases deduped. Kept for back-compat with callers
    // that read `ProductSort.COLOR_ORDER` (older code referenced it for
    // membership checks). New code should use `colorOrder(product)`.
    const COLOR_ORDER = (() => {
        const seen = new Set();
        const list = [];
        for (const [name, rank] of Object.entries(COLOR_RANK)) {
            if (rank >= 20) continue;            // packs handled separately
            if (name.length <= 1 && rank === Math.floor(rank)) continue; // skip 1-letter aliases (k, c, m, y, r, b, g, o, w)
            if (seen.has(rank)) continue;
            seen.add(rank);
            list.push(name);
        }
        // Append CMY then KCMY at the end so legacy index-based callers
        // still see packs after singles.
        list.push('cmy', 'kcmy', 'cmyk', 'bcmy', '4-pack', '4 pack');
        return Object.freeze(list);
    })();

    // ─── BUCKET TIERS (legacy 8-tier view) ───────────────────────────────
    //
    // Kept so any caller still reading `ProductSort.TIERS` / `colorTier`
    // gets a coherent answer. Each tier is the broad family the colorOrder
    // rank lives in. Tests assert these specifically.
    const TIER_K = 0;            // Black/PB/MB and any black-derivative single
    const TIER_C = 1;            // Cyan only — strict standard
    const TIER_M = 2;            // Magenta only — strict standard
    const TIER_Y = 3;            // Yellow only — strict standard
    const TIER_CMY = 4;          // CMY 3-pack (and tri-colour single in legacy view)
    const TIER_KCMY = 5;         // KCMY/CMYK/BCMY 4-pack
    const TIER_SPECIALTY = 6;    // LC, LM, PC, PM, VLM, R, B, G, grays, etc.
    const TIER_UNKNOWN = 7;      // truly unknown / unrecognised

    // ─── yield + accessory + source ──────────────────────────────────────

    function yieldTier(product) {
        // Two signals, and we take the STRONGER of the two.
        //
        // The backend `yield_tier` ('STD'|'XL'|'XXL' from detectYieldTier) is
        // now emitted on every product-list endpoint AND, since Jul 2026, on
        // /api/products/:sku. Measured live across the full 3,910-product
        // catalogue: present on 3,910/3,910, and it agrees with the detector
        // below on 3,883. Of the 27 that differ, 11 have a STRONGER backend
        // value (it sees data we can't) — those keep the backend answer.
        //
        // The other 16 are backend STD over a name that plainly says high
        // yield, and the page counts confirm it:
        //   Lexmark 708H  Cyan 3,000pp  vs  708  Cyan 1,000pp   (also 808H)
        //   Lexmark 236H / 333H / C333HY0 packs
        //   Canon CART069H (+HK), CART055H, PG660XLHY
        // The detector already catches all 16 — `\d{2,}h\b` and
        // `CART\d{3,}H` below were written for exactly these. But this
        // function used to return the backend value unconditionally, so the
        // moment the backend started populating the field those 16 silently
        // collapsed into the standard-yield row beside cartridges holding a
        // third of the ink. A regression caused by a field arriving, not by
        // code changing.
        //
        // max() is one-directional and self-disabling: it can only ever RAISE
        // a tier, never lower one, so a correct backend value always survives;
        // and once detectYieldTier learns the trailing-H convention (BF-027)
        // both signals agree and this merge goes inert on its own. The earlier
        // note here said "do not work around here" — that was right while the
        // detector was the only signal and could be wrong on its own; it is
        // the wrong call now that we can cross-check the two and only ever
        // move in the direction both the name and the page count point.
        // ERR-134.
        const yt = (product && product.yield_tier || '').toString().toUpperCase();
        const backendTier = yt === 'XXL' ? 2 : yt === 'XL' ? 1 : yt === 'STD' ? 0 : -1;

        // ---- FE detection (mirror of backend detectYieldTier) ----
        // The old fallback only read XL/XXL/HY as whole words, so it silently
        // missed digit-glued high-yield ("200HY", "220HYBK": no \b between 0 and
        // HY) and HP short-series letters ("975X"), merging two model codes onto
        // one row. We now read the name + sku, using `color` as a guard so a
        // trailing colour Y ("220Y" Yellow) is never mistaken for a yield marker.
        const n = (product && product.name || '').toLowerCase();
        const sku = (product && product.sku || '').toUpperCase();
        let detected = 0;
        // XXL / super-high-yield.
        if (n.includes('xxl') || n.includes('super high')
            || /\bxll\b/.test(n) || /\bshy\b/.test(n) || /\d{2,}xxhy/i.test(n)) {
            detected = 2;
        // XL / high-yield, incl. digit-glued HY/EHY ("200HY", "220HYBK"),
        // digit-glued single H ("220H", "CART069H"), and HP short-series X
        // ("975X"). None of these match a bare trailing colour Y.
        } else if (n.includes('xl') || n.includes('high yield') || /\bhy\b/.test(n)
            || /\d{2,}e?hy/i.test(n) || /\d{2,}h\b/i.test(n) || /\b\d{3,}x\b/i.test(n)) {
            detected = 1;
        } else if (/CART\d{3,}H(?=[A-Z]|-|$)/.test(sku) || /\d{2,}E?HY/.test(sku)) {
            detected = 1;
        }
        // NOTE (stopgap limit): HP short-series Y → XXL and Lexmark bare-letter
        // yields (503U/808S) are intentionally NOT detected here — the
        // trailing-Y/letter cases collide with colour/model data the FE can't
        // disambiguate. Those stay at whatever the backend says.
        //
        // Stronger signal wins. With no backend field, backendTier is -1 and
        // the detector stands alone exactly as it used to.
        return Math.max(backendTier, detected);
    }

    // accessoryTier: cartridges first (0), drums (1), other consumable units —
    // belt / fuser / transfer / waste / maintenance / paper (2), printers /
    // everything else (3). Mirrors backend `accessoryTier`. Used both as the
    // lead sort key (sortByCatalogOrder) and — since Jun 2026 — as a within-
    // family sub-order so a model's toners and drums never interleave (OKI
    // MC853 listed Black-drum, Black-toner, Cyan-drum, … on the same row).
    //
    // The unit type is read from the NAME first, before the category check:
    // OKI / Brother routinely file a "Drum Unit" / "Fuser Unit" under
    // category 'toner', so a category-led test would wrongly tier them as
    // cartridges (0) and re-interleave them with the real toners.
    function accessoryTier(product) {
        if (!product) return 3;
        // `category` arrives as an object {name,slug} on the live API, not a
        // string — `String({...})` is "[object Object]", which silently broke
        // every cat=== check below (the name regex carried it). Normalise.
        const rawCat = product.category;
        const cat = (rawCat && typeof rawCat === 'object'
            ? (rawCat.slug || rawCat.name || '')
            : (rawCat || '')).toString().toLowerCase();
        const name = (product.name || '').toString().toLowerCase();
        if (/\bdrum\b/.test(name) || /\bdrum\b/.test(cat)) return 1;
        if (/\b(belt|fuser|transfer|waste|maintenance)\b/.test(name)
            || cat === 'paper' || /\bpaper\b/.test(name) || /\bmaintenance\b/.test(cat)) return 2;
        const isInkOrToner = cat === 'ink' || cat === 'toner'
            || /\b(ink|toner)\s+(cartridge|cartridges)\b/.test(name)
            || (/\bcartridge\b/.test(name) && !/\bprinter\b/.test(name));
        if (isInkOrToner) return 0;
        return 3;
    }

    // packRank: single (0) < value_pack (1) < multipack (2). Tiebreaker
    // when colorOrder collapses (e.g. two rows both resolve to 20 because
    // both pack-name-detect as CMY).
    function packRank(product) {
        const t = (product && product.pack_type || '').toString().toLowerCase();
        if (t === 'multipack') return 2;
        if (t === 'value_pack' || t === 'valuepack') return 1;
        return 0;
    }

    // Source-tier (genuine before compatible) is preserved for callers
    // that still rely on it; the backend now bakes this into
    // `accessoryTier` + family ordering, but internal compares keep it
    // available as a stable, documented helper.
    function sourceTier(product) {
        const s = (product && product.source || '').toString().toLowerCase();
        if (s === 'genuine') return 0;
        if (s === 'compatible') return 1;
        return 2;
    }

    // ─── color resolution ────────────────────────────────────────────────

    // Resolve the product's color string. Priority:
    //   1. product.color  (backend's canonical 'Black'/'Cyan'/'CMY'/'KCMY')
    //   2. ProductColors.detectFromName(product.name) — legacy rows missing color
    function resolveColorName(product) {
        if (!product) return '';
        const c = (product.color || '').toString().toLowerCase().trim();
        if (c) return c;
        if (typeof ProductColors !== 'undefined' && product.name) {
            const detected = ProductColors.detectFromName(product.name);
            if (detected) return detected.toLowerCase();
        }
        return '';
    }

    // colorOrder — the spec's primary sort key for a product within its
    // (accessoryTier, yieldTier, seriesBase) group. Pack-name regex wins
    // over the color field so mislabeled feed rows (KCMY pack with
    // color="Black") still sort as packs.
    function colorOrder(product) {
        if (!product) return RANK_UNKNOWN_SINGLE;
        const name = (product.name || '').toString();

        // Step 1 — pack-name regex first. A row whose NAME contains
        // KCMY/CMYK/BCMY/4-pack always ranks 21, regardless of color field.
        if (PACK_NAME_REGEX_4.test(name)) return 21;
        if (PACK_NAME_REGEX_3.test(name)) return 20;

        // Step 2 — pack_type override. A value_pack/multipack with no
        // pack-shape keyword in the name still sorts as a pack. Use the
        // color field to choose between CMY (20) and KCMY (21):
        //   - color in {cmy, color, colour, tri-color, tri-colour} → 20
        //   - everything else (including 'Black' on a misclassified pack) → 21
        const pType = packRank(product);
        if (pType >= 1) {
            const cn = resolveColorName(product);
            if (cn === 'cmy' || cn === 'color' || cn === 'colour'
                || cn === 'tri-color' || cn === 'tri-colour'
                || cn === 'tricolor' || cn === 'tricolour') return 20;
            return 21;
        }

        // Step 3 — color string lookup. Empty / unknown → RANK_UNKNOWN_SINGLE
        // so the row sits between specialty singles (≤17) and packs (≥20).
        const c = resolveColorName(product);
        if (!c) return RANK_UNKNOWN_SINGLE;
        if (Object.prototype.hasOwnProperty.call(COLOR_RANK, c)) {
            return COLOR_RANK[c];
        }
        return RANK_UNKNOWN_SINGLE;
    }

    // colorIndex — legacy alias kept for back-compat. Returns the rank
    // (or 999 for unknown), which preserves the prior semantics of
    // "missing color sorts last" if any caller still reads it.
    function colorIndex(product) {
        const r = colorOrder(product);
        return r === RANK_UNKNOWN_SINGLE ? 999 : r;
    }

    // colorTier — legacy 8-bucket classifier mapping the new rank back to
    // the broad K/C/M/Y/CMY/KCMY/specialty/unknown buckets. Used by older
    // surfaces and pinned tests; new callers should use `colorOrder()`
    // directly. The mapping reflects the *post-May-2026* rule that PB/MB,
    // LC/LM, PC/PM, VLM, grays, R, B, G, O, W, B/R all live in the
    // SPECIALTY bucket — they're singles that sort after Y but before
    // the multi-cartridge packs.
    function colorTier(product) {
        const rank = colorOrder(product);
        if (rank === 0) return TIER_K;
        if (rank === 1) return TIER_C;
        if (rank === 2) return TIER_M;
        if (rank === 3) return TIER_Y;
        if (rank === 20) return TIER_CMY;
        if (rank === 21) return TIER_KCMY;
        if (rank === RANK_UNKNOWN_SINGLE) return TIER_UNKNOWN;
        if (rank >= 4 && rank < 20) return TIER_SPECIALTY;
        return TIER_UNKNOWN;
    }

    // compareByYieldAndColor — within-a-family comparator. Walks the spec's
    // sort tuple from left to right but skips accessoryTier + seriesBase
    // because the caller has already grouped by family. Source tier is the
    // first split (genuine → compatible) so genuine cartridges always lead
    // the row; yield tier (std → HY → XXL) drives the row stack; colorOrder
    // gives K → C → M → Y → specialty → packs; packRank is the final
    // tiebreaker; name is the lexicographic guard.
    function compareByYieldAndColor(a, b) {
        const sa = sourceTier(a);
        const sb = sourceTier(b);
        if (sa !== sb) return sa - sb;
        const ya = yieldTier(a);
        const yb = yieldTier(b);
        if (ya !== yb) return ya - yb;
        const ca = colorOrder(a);
        const cb = colorOrder(b);
        if (ca !== cb) return ca - cb;
        const pa = packRank(a);
        const pb = packRank(b);
        if (pa !== pb) return pa - pb;
        const na = (a && a.name || '').toString();
        const nb = (b && b.name || '').toString();
        return na.localeCompare(nb);
    }

    // Extract a brand + base product code as the family key.
    // Handles real backend SKUs like `G-CAN-CART069HK-TNR-BK`, `GEN-PACK-CAN-CART069-CMY`,
    // `G-DYM-S0720690-LBL-BK`, `G-EPS-S41069-PPR`, etc. — these don't parse cleanly from
    // SKU suffixes, so we extract from the name which always contains the product code.
    //
    // The family key is yield-AGNOSTIC by design: XL/XXL/HY/H markers are stripped
    // so all three of `TN645BK`, `TN645XLBK`, `TN645XXLBK` collapse to `TN645`.
    // `yieldTier(p)` then provides the secondary ordering inside the family — this
    // is what lets `byCodeThenColor` group all yields of one base code together
    // and stack them std → XL → XXL on consecutive rows.
    //
    // e.g. "Canon Genuine CART069HK Toner Cartridge Black"   → B:CANON:CART069
    //      "Canon Genuine CART069 Value Pack CMY 3-Pack"     → B:CANON:CART069
    //      "Canon Genuine CART069H Value Pack KCMY 4-Pack"   → B:CANON:CART069
    //      "Brother Genuine TN645BK Toner Cartridge Black"   → B:BROTHER:TN645
    //      "Brother Genuine TN645XLBK Toner Cartridge Black" → B:BROTHER:TN645
    //      "Brother Genuine TN645XXLBK Toner Cartridge …"    → B:BROTHER:TN645
    function familyKey(product) {
        const name = (product.name || '').toUpperCase();
        const brand = (product.brand?.name || product.brand || '')
            .toString().toUpperCase().replace(/\s+/g, '');

        // PRIORITY 0: trust the backend when it ships a series code. The May
        // 2026 catalog overhaul (api-changes-may2026.md §2) added
        // `series_codes: string[]` to /api/shop responses; same code shipped
        // via the smart/by-printer endpoints in some payloads. Using the
        // backend value collapses families like Brother LC133 / LC139 / LC133
        // XL into one row even when the name regex below would fork them.
        // Prefer the SHORTEST series code so XL/HY tagged variants
        // ("LC139XL") still join the std row ("LC139") rather than starting a
        // new family — yieldTier(p) is what splits them inside the family.
        if (Array.isArray(product.series_codes) && product.series_codes.length) {
            const codes = product.series_codes
                .map(c => (c || '').toString().toUpperCase().replace(/\s+/g, ''))
                .filter(Boolean)
                .sort((a, b) => a.length - b.length || a.localeCompare(b));
            if (codes.length) {
                // Strip the yield suffix from the chosen base so std/XL/XXL all
                // resolve to the same family even if the backend included them
                // as separate codes.
                //
                // ONE YIELD VOCABULARY (Aug 2026). This used to carry its own
                // regex — /^([A-Z]+\d+)(XXL|XL|HY|H)([A-Z]*)$/ — a second,
                // subtly different grammar from SeriesCodes.YIELD_SUFFIX ~500
                // lines below in this same file. `[A-Z]+` required a letter
                // before the digits, so BARE-NUMERIC codes never collapsed:
                // '804XL' stayed '804XL' and '604XL' stayed '604XL' while
                // 'LC133XL' became 'LC133'. That forks HP 804 / Epson 604 rows
                // off their own std siblings whenever a payload carries the XL
                // code — which api.js::_enrichSeriesCodes emits for any product
                // shipped without backend series_codes.
                //
                // DO NOT "fix" this by widening to `[A-Z]*`. Measured over all
                // 1,350 distinct series_codes live on 2026-08-03, that widening
                // collapses ZERO codes correctly and MANGLES THREE — the `H`
                // branch eats a letter out of a bare-numeric body:
                // 34217HR→34217R, 64017HR→64017R, 64080HW→64080W (real Lexmark
                // SKUs). collapseYieldSuffix only strips X{1,3}L and was
                // zero-diff across all 1,350. See ERR-141.
                //
                // Reference SeriesCodes directly, NOT window.SeriesCodes: the
                // latter is undefined under require() and would silently
                // disable this in every unit test. Safe despite the const being
                // declared below — familyKey only ever runs at render/sort
                // time, long after module evaluation (same TDZ reasoning as the
                // CompatSource note further down).
                let base = codes[0];
                base = SeriesCodes.collapseYieldSuffix(base) || base;
                return (brand ? 'B:' + brand + ':' : '') + base;
            }
        }

        // First token shaped like a product code: letters + digits + optional
        // trailing letters. Suffix length up to 8 because real codes carry 5-char
        // tails like `XXLBK` (Brother TN645) and `XLCY`/`XLMG` etc.
        // Matches CART069, CART069HK, CART069H, S0720690, S41069, TN645XXLBK,
        // TN645XLBK, PG-40, etc.
        // Two-pass extraction:
        //   Pass 1 — `LETTERS DIGITS LETTERS?` (Brother TN645, Canon BCI6,
        //            Canon CART069, Epson T0731). LAST match wins so compatible
        //            names like "BCI3 BCI6 Cyan" pick BCI6 (the more specific /
        //            modern code), not BCI3.
        //   Pass 2 — bare-numeric (HP 975A, Epson 802). Only runs when pass 1
        //            finds nothing. FIRST match wins to avoid trailing page
        //            counts: "HP 975A Ink Cartridge Black (450 Pages)" picks
        //            975A, not 450.
        // Both passes use `\d+` so single-digit codes (Canon BCI6, BCI3, …)
        // resolve here instead of falling to the colour-stripped name fallback.
        //
        // PRINTER MODELS ARE NOT CARTRIDGE CODES (ERR-135). A compatible
        // cartridge's name ends with the devices it fits — "…Replacement for
        // Brother DCP-J1050DW MFC-J1010DW" — and because pass 1 is
        // LAST-match-wins, the token it picked was the trailing PRINTER, keying
        // the family to a device instead of a cartridge and silently forking or
        // merging families. Drop printer-shaped tokens before choosing.
        // This only ever runs when the backend shipped no `series_codes`;
        // PRIORITY 0 above already returned for everything else.
        // Reached via the window property, not the bare binding: `CompatSource`
        // is a `const` declared further down this same file, so a bare
        // `typeof CompatSource` would THROW (temporal dead zone) rather than
        // return 'undefined' if this ever ran mid-evaluation.
        const cs = (typeof window !== 'undefined' && window.CompatSource) || null;
        const isPrinterTok = cs ? (t) => cs.isPrinterModelToken(t) : () => false;
        const letterMatches = [...name.matchAll(/\b([A-Z]{1,6})(\d+)([A-Z]{0,8})\b/g)]
            .filter(mm => !isPrinterTok(mm[0]));
        let m;
        if (letterMatches.length > 0) {
            m = letterMatches[letterMatches.length - 1];
        } else {
            const numMatches = [...name.matchAll(/\b()(\d+)([A-Z]{0,8})\b/g)]
                .filter(mm => !isPrinterTok(mm[0]));
            if (numMatches.length > 0) m = numMatches[0];
        }
        let base;
        if (m) {
            const prefix = m[1];
            const digits = m[2];
            let suffix = m[3] || '';
            // Parse from the LEFT: yield prefix (XXL/XL/HY/H) comes first in
            // every real SKU we see, then color suffix. Strip yield by anchoring
            // to the START of the suffix so `XLC` parses as XL+C (correct) and
            // not as X+LC (Light Cyan, wrong). Longest-yield-first beats greedy
            // ambiguity (XXL must beat XL, HY must beat H).
            suffix = suffix.replace(/^(XXL|XL|HY|H)/, '');
            // Now strip color from the right. Multi-letter first so `BK` isn't
            // reduced to `B` (which would survive the single-letter pass).
            // PC = Photo Cyan, PM = Photo Magenta (Canon BCI6PC / BCI6PM).
            // CLR = Tri-Colour single (HP 804XLCLR) — must strip WHOLE here,
            // else the single-letter pass below strips only the trailing `R`
            // and leaves `...CL`, forking the tri-colour off its base family.
            // NOT `CL`: bare `CL` means Clear, a different cartridge.
            suffix = suffix.replace(/(BK|CY|MG|YL|PK|MK|LC|LM|GY|PC|PM|CLR)$/, '');
            suffix = suffix.replace(/(K|C|M|Y|R|G|B)$/, '');
            base = prefix + digits + suffix;
        } else {
            // Fallback: color-stripped, yield-stripped name
            base = name.toLowerCase()
                .replace(/\b(photo black|matte black|light cyan|light magenta|tri[- ]?colou?r|black|cyan|magenta|yellow|red|blue|green|gray|grey|cmyk|kcmy|bcmy|cmy|value pack|\d+[- ]?pack)\b/gi, '')
                .replace(/\b(xxl|xl|high yield|super high yield)\b/gi, '')
                .replace(/\s+/g, ' ')
                .trim();
        }
        return (brand ? 'B:' + brand + ':' : '') + base;
    }

    // seriesBase — alphanumeric MPN family with brand prefix stripped. The
    // spec's `seriesBase` corresponds to the family-key BASE without the
    // `B:BRAND:` prefix. We expose a thin alias for parity with the
    // backend's API; callers that need the brand-scoped key keep using
    // familyKey, which dedupes families across different brands.
    function seriesBase(product) {
        const key = familyKey(product) || '';
        const idx = key.indexOf(':');
        if (idx === -1) return key;
        // strip leading "B:BRAND:" → leave the bare base.
        const second = key.indexOf(':', idx + 1);
        return second === -1 ? key.slice(idx + 1) : key.slice(second + 1);
    }

    // Sort in place: yield tier → color order. Returns the same array.
    function byYieldAndColor(products) {
        return products.sort(compareByYieldAndColor);
    }

    // Stable sort by canonical colorOrder (the May 2026 22-rank table).
    // Returns a NEW array — callers don't have to defensively `[...products]`.
    //
    // Stability matters: products with the same colorOrder keep their
    // incoming relative order, which preserves the backend's
    // `(accessoryTier, yieldTier, seriesBase)` grouping within a rank.
    // The function is the storefront's secondary pass on top of the
    // backend's primary catalog sort.
    //
    // Array.prototype.sort is stable in V8 / SpiderMonkey / JavaScriptCore
    // (TC39 stable-sort guarantee since ES2019), so a single .sort() call
    // by colorOrder is sufficient — no decorate-sort-undecorate needed.
    function byColor(products) {
        if (!Array.isArray(products) || products.length < 2) {
            return Array.isArray(products) ? products.slice() : [];
        }
        return products.slice().sort((a, b) => colorOrder(a) - colorOrder(b));
    }

    // Stable composite sort: family code → yield tier → colorOrder → packRank.
    // Returns a NEW array. This is the May 2026 product-grid contract:
    //
    //   645   K, C, M, Y, [specialty…], CMY, KCMY    ← yield 0 (std)    row 1
    //   645XL K, C, M, Y, [specialty…], CMY, KCMY    ← yield 1 (XL/HY)  row 2
    //   645XXL K, C, M, Y, [specialty…], CMY, KCMY   ← yield 2 (XXL)    row 3
    //
    // Family order: cartridge families first, then drum-only families, then
    // belt/fuser/waste families — ranked by each family's MINIMUM accessoryTier
    // (so OKI MC853, which holds both toners and drums, ranks by its toners = 0
    // and is NOT sunk). Within an accessory tier, the incoming order is
    // preserved (first occurrence wins) so the backend's brand/relevance order
    // still drives which family appears first. This sinks scattered accessory
    // families (e.g. an HP "Fuser Kit 220V" or a Lexmark drum interleaved into a
    // /search merge) below the cartridges; it is a no-op on /shop, where the
    // backend already returns catalog order. Within a family, yield tier is
    // forced ascending (std → HY → XXL), then colorOrder, then packRank.
    //
    // Renderers pair this with `rowBreakIndices` to insert a flex-basis:100%
    // breaker so each (family, yield) group physically starts on a new row.
    //
    // Spec: readfirst/sort-hierarchy-may2026.md, readfirst/code-yield-grouping-may2026.md
    // Pinned by: tests/sort-hierarchy-may2026.test.js, tests/code-yield-grouping-may2026.test.js
    function byCodeThenColor(products) {
        if (!Array.isArray(products) || products.length < 2) {
            return Array.isArray(products) ? products.slice() : [];
        }
        // Capture each family's first-appearance index AND its minimum
        // accessoryTier across members. The family sort key is then
        // (familyMinAccessory, firstAppearance): accessory-only families sink
        // below cartridge families, but original order is otherwise preserved.
        const familyOrder = new Map();
        const familyMinAccessory = new Map();
        let nextRank = 0;
        for (const p of products) {
            const fk = familyKey(p);
            if (!familyOrder.has(fk)) {
                familyOrder.set(fk, nextRank++);
            }
            const at = accessoryTier(p);
            const prev = familyMinAccessory.get(fk);
            if (prev === undefined || at < prev) familyMinAccessory.set(fk, at);
        }
        const fRank = (p) => familyOrder.get(familyKey(p));
        const fAccessory = (p) => familyMinAccessory.get(familyKey(p));
        return products.slice().sort((a, b) => {
            const faa = fAccessory(a), fab = fAccessory(b);
            if (faa !== fab) return faa - fab;
            const fa = fRank(a), fb = fRank(b);
            if (fa !== fb) return fa - fb;
            // Within a family, the unit TYPE sub-orders before yield/colour:
            // all toners (0), then all drums (1), then belt/fuser/etc (2) — so
            // a model's drums and toners form distinct blocks instead of
            // interleaving by colour (OKI MC853 black-drum, black-toner, …).
            const aa = accessoryTier(a), ab = accessoryTier(b);
            if (aa !== ab) return aa - ab;
            const ya = yieldTier(a), yb = yieldTier(b);
            if (ya !== yb) return ya - yb;
            const ca = colorOrder(a), cb = colorOrder(b);
            if (ca !== cb) return ca - cb;
            return packRank(a) - packRank(b);
        });
    }

    // sortByCatalogOrder — frontend mirror of the backend's
    // `sortByCatalogOrder(products)`. Applies the full 6-tuple
    // (accessoryTier, yieldTier, seriesBase, colorOrder, packRank, name).
    // Returns a NEW array. Use this when the input list mixes families
    // and/or accessories and the caller wants a complete catalog-order
    // pass — e.g. a search-drilldown response that includes both ink
    // cartridges and an accessory or two.
    //
    // For per-family rendering on the storefront, prefer `byCodeThenColor`
    // which preserves the API's incoming family-appearance order.
    function sortByCatalogOrder(products) {
        if (!Array.isArray(products) || products.length < 2) {
            return Array.isArray(products) ? products.slice() : [];
        }
        return products.slice().sort((a, b) => {
            const aa = accessoryTier(a), ab = accessoryTier(b);
            if (aa !== ab) return aa - ab;
            const ya = yieldTier(a), yb = yieldTier(b);
            if (ya !== yb) return ya - yb;
            const sa = seriesBase(a), sb = seriesBase(b);
            const sCmp = sa.localeCompare(sb);
            if (sCmp !== 0) return sCmp;
            const ca = colorOrder(a), cb = colorOrder(b);
            if (ca !== cb) return ca - cb;
            const pa = packRank(a), pb = packRank(b);
            if (pa !== pb) return pa - pb;
            const na = (a && a.name || '').toString();
            const nb = (b && b.name || '').toString();
            return na.localeCompare(nb);
        });
    }

    // sortByRelevance — frontend mirror of the backend's
    // `sortByRelevance(products, scoreMap)`. Score wins across families;
    // within a family (same seriesBase + yieldTier) the colour/pack
    // hierarchy overrides score so per-row RPC variance can't invert
    // CMY/KCMY ordering. `scoreMap` keys can be sku / product_code / id.
    //
    // Used by /search?q=… payloads (smart endpoint already applies this
    // server-side; the FE pass is a no-op when the BE got it right).
    function sortByRelevance(products, scoreMap) {
        if (!Array.isArray(products) || products.length < 2) {
            return Array.isArray(products) ? products.slice() : [];
        }
        const keyOf = (p) => (p && (p.sku || p.product_code || p.code || p.id));
        const scoreOf = (p) => {
            const k = keyOf(p);
            return (scoreMap && k != null && scoreMap.has(k)) ? scoreMap.get(k) : 0;
        };
        return products.slice().sort((a, b) => {
            // Same family (seriesBase + yieldTier)? colour hierarchy wins.
            const sameFamily = seriesBase(a) === seriesBase(b)
                && yieldTier(a) === yieldTier(b);
            if (sameFamily) {
                const ca = colorOrder(a), cb = colorOrder(b);
                if (ca !== cb) return ca - cb;
                const pa = packRank(a), pb = packRank(b);
                if (pa !== pb) return pa - pb;
            }
            // Different families? Score dominates (descending).
            const ra = scoreOf(a), rb = scoreOf(b);
            if (ra !== rb) return rb - ra;
            // Score-tie fallback: full catalog order.
            const aa = accessoryTier(a), ab = accessoryTier(b);
            if (aa !== ab) return aa - ab;
            const ya = yieldTier(a), yb = yieldTier(b);
            if (ya !== yb) return ya - yb;
            const sa = seriesBase(a), sb = seriesBase(b);
            const sCmp = sa.localeCompare(sb);
            if (sCmp !== 0) return sCmp;
            const ca = colorOrder(a), cb = colorOrder(b);
            if (ca !== cb) return ca - cb;
            return packRank(a) - packRank(b);
        });
    }

    // Indices at which a row break should be inserted, given a list already
    // sorted by `byCodeThenColor`. A boundary fires when (familyKey, yieldTier)
    // changes AND both adjacent groups carry at least `opts.minGroupSize`
    // cards (default 2). The threshold avoids wasting vertical space on
    // boundaries between sparse (1-card) groups — e.g. Canon CL586 with one
    // std card + one XL card flows onto a single row instead of two rows of
    // one. Larger groups (TN645 std/XL/XXL × 6 cards each) still get their
    // break and render as the customer-expected "one row per yield-code".
    // The first item is never a boundary.
    //
    //   input  : [645-K, 645-C, 645-M, 645XL-K, 645XL-C, 645XXL-K]   (group sizes 3, 2, 1)
    //   output : [3]                       ← break before 645XL only
    //                                        (645XL → 645XXL skipped: 1<2)
    //
    // Returns [] for arrays of length < 2.
    function rowBreakIndices(sortedProducts, opts) {
        if (!Array.isArray(sortedProducts) || sortedProducts.length < 2) return [];
        const minGroupSize = (opts && Number.isFinite(opts.minGroupSize))
            ? opts.minGroupSize : 2;

        // Pass 1 — segment the sorted list into [{startIndex, key, size}, …].
        // Each segment is one (familyKey, accessoryTier, yieldTier) tuple, so a
        // family's toner block and drum block break onto separate rows (they
        // share familyKey + yieldTier but differ in accessoryTier).
        const segments = [];
        let prevKey = null;
        for (let i = 0; i < sortedProducts.length; i++) {
            const key = familyKey(sortedProducts[i])
                + '|' + accessoryTier(sortedProducts[i])
                + '|' + yieldTier(sortedProducts[i]);
            if (key !== prevKey) {
                segments.push({ startIndex: i, key, size: 1 });
                prevKey = key;
            } else {
                segments[segments.length - 1].size++;
            }
        }

        // Pass 2 — emit a break index only when both sides of the transition
        // meet the threshold, so lonely groups merge into the previous row.
        const out = [];
        for (let s = 1; s < segments.length; s++) {
            const prev = segments[s - 1];
            const curr = segments[s];
            if (prev.size >= minGroupSize && curr.size >= minGroupSize) {
                out.push(curr.startIndex);
            }
        }
        return out;
    }

    // Group products by family, order families by max member score (descending),
    // and within each family order by yield+color. `scoreMap` is a Map from
    // product id-or-sku → numeric score. Products with no score sort last.
    function groupByFamilyScored(products, scoreMap) {
        const families = new Map();
        for (const p of products) {
            const fkey = familyKey(p);
            if (!families.has(fkey)) families.set(fkey, []);
            families.get(fkey).push(p);
        }
        const keyOf = (p) => (p.sku || p.product_code || p.code || p.id);
        const scoreOf = (p) => {
            const k = keyOf(p);
            return (scoreMap && k != null && scoreMap.has(k)) ? scoreMap.get(k) : 0;
        };
        const familyList = [];
        for (const [, members] of families) {
            members.sort(compareByYieldAndColor);
            const topScore = members.reduce((m, p) => Math.max(m, scoreOf(p)), 0);
            familyList.push({ members, topScore });
        }
        familyList.sort((a, b) => b.topScore - a.topScore);
        const out = [];
        for (const f of familyList) out.push(...f.members);
        return out;
    }

    return {
        COLOR_RANK,
        COLOR_ORDER,
        RANK_UNKNOWN_SINGLE,
        PACK_NAME_REGEX_3,
        PACK_NAME_REGEX_4,
        TIERS: { K: TIER_K, C: TIER_C, M: TIER_M, Y: TIER_Y,
                 CMY: TIER_CMY, KCMY: TIER_KCMY,
                 SPECIALTY: TIER_SPECIALTY, UNKNOWN: TIER_UNKNOWN },
        accessoryTier,
        yieldTier,
        sourceTier,
        seriesBase,
        packRank,
        colorOrder,
        colorIndex,
        colorTier,
        resolveColorName,
        compareByYieldAndColor,
        familyKey,
        byYieldAndColor,
        byColor,
        byCodeThenColor,
        rowBreakIndices,
        groupByFamilyScored,
        sortByCatalogOrder,
        sortByRelevance
    };
})();

// Make ProductSort available globally so non-module callers can use byColor.
if (typeof window !== 'undefined') window.ProductSort = ProductSort;

// ─────────────────────────────────────────────────────────────────────────────
// ProductName — display-title normaliser.
//
// Backend genuine-cartridge / print-head `name` values embed a redundant compact
// code token, e.g.
//   "HP Genuine 70 130mlCY Ink Cartridge 70 130ml Cyan"
//                └─ compact ─┘              └── readable ──┘
// so "70 130ml" shows twice. clean() strips the compact token and re-emits the
// title "colour last" → "HP Genuine 70 130ml Ink Cartridge Cyan".
//
// GUARDED: only rewrites when the compact token genuinely repeats the readable
// half's leading (digit-bearing) code. Non-doubled names are returned verbatim —
// Gloss Enhancer ("…Ink Cartridge Gloss Enhancer"), compatible names
// ("Compatible … for HP 126A …"), Brother paper/labels, and already-clean names.
// This is a PURE DISPLAY helper: it never mutates the stored `name` used for the
// slug, identity, analytics or search-matching. Root cause is backend data —
// see readfirst/product-name-doubling-backend-handoff-jul2026.md.
// ─────────────────────────────────────────────────────────────────────────────
const ProductName = (function () {
    'use strict';

    const TYPE_RE = /\b(Ink Print Head|Ink Cartridge|Toner Cartridge|Print Head|Ink Tank|Toner)\b/i;
    const collapseWs = (s) => s.replace(/\s+/g, ' ').trim();

    // Trailing parentheticals on the readable half — the page-yield suffix
    // ("(600 pages)", "(30,000 pages)") and occasionally an OEM part number
    // before it ("… Colour (7FP20TA) (120 pages)"). One or more groups,
    // anchored to the end.
    const TRAILING_PARENS_RE = /(\s*\([^()]*\))+\s*$/;

    function clean(product) {
        const raw = (product && product.name != null ? String(product.name) : '').trim();
        if (!raw) return raw;

        const tm = raw.match(TYPE_RE);
        if (!tm) return raw;                                   // no product-type phrase

        const type = tm[0];
        const before = raw.slice(0, tm.index).trim();          // "HP Genuine 70 130mlCY"
        let after = raw.slice(tm.index + type.length).trim();   // "70 130ml Cyan"
        if (!before || !after) return raw;

        // brandPrefix = "<Brand> Genuine" (or the leading brand word); compact = the rest.
        const gm = before.match(/^(.*?\bGenuine)\b/i);
        const brandPrefix = gm ? gm[1].trim() : (before.split(/\s+/)[0] || '');
        const compact = before.slice(brandPrefix.length).trim();
        if (!compact) return raw;                              // nothing redundant before the type

        // Doubling guard: the readable half must lead with the same digit-bearing
        // code that the compact token starts with (else it isn't a doubled name).
        const leadCode = after.split(/\s+/)[0] || '';
        if (!/\d/.test(leadCode)) return raw;
        if (!compact.toUpperCase().startsWith(leadCode.toUpperCase())) return raw;

        // Peel any trailing parenthetical BEFORE the colour split, then put it
        // back at the very end (Aug 2026, ERR-141). Most genuine names carry a
        // page-yield tail, so without this the colour is never "trailing" and
        // every one of them fell to the type-last fallback below, emitting
        // "Brother Genuine LC133 Black (600 pages) Ink Cartridge" — the type
        // phrase stranded after the page count. Measured over all 3,969 live
        // products: 1,947 titles improve, and every previously-pinned fixture
        // (which carry no parenthetical) is byte-identical.
        let parens = '';
        const pm = after.match(TRAILING_PARENS_RE);
        if (pm) {
            parens = pm[0].trim();
            after = after.slice(0, pm.index).trim();
        }
        if (!after) return raw;   // the readable half was ONLY a parenthetical

        // Split the trailing colour off the readable half so we can re-emit it last.
        const color = (product && product.color ? String(product.color) : '').trim();
        let codeVol = after;
        if (color) {
            const tail = new RegExp('\\s*' + color.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'i');
            if (tail.test(after)) codeVol = after.replace(tail, '').trim();
        }

        if (color && codeVol && codeVol !== after) {
            return collapseWs(`${brandPrefix} ${codeVol} ${type} ${color} ${parens}`);   // colour last
        }
        // Colour unknown / not trailing → drop only the compact token, keep readable order.
        return collapseWs(`${brandPrefix} ${after} ${type} ${parens}`);
    }

    // ─────────────────────────────────────────────────────────────────────
    // compatModel — sanitise a single printer-compatibility label before it is
    // rendered. Some backend compatibility rows are corrupted, e.g.
    //   "Brother Brother HL-2130"  (doubled brand)
    //   "OKI 5%"                   (ISO yield-coverage token leaked in)
    //   "OKI 100 (3 PAGES"         (page-yield fragment leaked in)
    // Merchant Center reads these as inaccurate product data. This is a PURE
    // DISPLAY guard — it never mutates stored data; the root-cause records are
    // flagged for backend repair by scripts/audit-merchant-center-readiness.mjs.
    // ─────────────────────────────────────────────────────────────────────
    function compatModel(label, brand) {
        let s = (label == null ? '' : String(label)).replace(/\s+/g, ' ').trim();
        if (!s) return '';

        // Drop yield / coverage artifacts: "5%", "(650", "PAGES", "pages)".
        s = s.split(' ').filter(function (tok) {
            if (/^\(?\d+(\.\d+)?%\)?$/.test(tok)) return false;   // pure percentage
            if (/pages?/i.test(tok)) return false;                // page-yield word
            return true;
        }).join(' ');

        // Remove orphaned bracket fragments left behind by a dropped "(N PAGES)".
        s = s.replace(/\(\s*\d*\s*\)?/g, ' ').replace(/[()]/g, ' ');

        // Collapse a leading printer brand that duplicates the group brand.
        var b = (brand == null ? '' : String(brand)).trim();
        if (b) {
            var esc = b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            s = s.replace(new RegExp('^(' + esc + ')\\s+\\1\\b', 'i'), '$1');
        }

        // Collapse any immediate repeated word ("HP HP", "OKI OKI"), repeatedly.
        var prev;
        do { prev = s; s = s.replace(/\b([A-Za-z][\w&.-]*)\s+\1\b/gi, '$1'); } while (s !== prev);

        return s.replace(/\s+/g, ' ').trim();
    }

    return { clean, compatModel };
})();
if (typeof window !== 'undefined') window.ProductName = ProductName;

// ─────────────────────────────────────────────────────────────────────────────
// SeriesCodes — yield-suffix collapse for the /shop chip drilldown.
//
// One series, one chip. Yield variants (XL, XXL, XXXL) are the same family at
// a different page count — they MUST share a chip. Without collapsing, the
// /shop?brand=epson&category=ink grid splits "604 / 604XL", "676 / 676XL",
// "212 / 212XL" etc. across separate tiles, doubling the customer's hunt.
//
// Live evidence (2026-05-10):
//   /api/shop?brand=epson&category=ink — backend ships 604, 200, 212, 220,
//   252, 273, 676 with no XL variant; the compat-recovery sidecar in
//   api.js (see catalog-defects-may2026.md §6) injects '200XL'/'604XL'/etc.
//   chips because compat products in the catalog ship
//   `series_codes: ['604XL']` from the canonical extractor. Frontend has to
//   collapse on render or the customer sees doubled tiles.
//
// Suffixes that ARE yield (collapsed):
//   X{1,3}L   → 200XL → 200, 812XXL → 812, T312XL → T312, LC133XL → LC133.
//
// Suffixes that are NOT yield (preserved):
//   N (Epson regional code, 73N/81N), S (46S), ML (26ML / 80ML), HY/H
//   (Brother high-yield carries an XL alias and ships under that name; never
//   bare H today — re-evaluate when /api/shop adds bare H suffix).
// ─────────────────────────────────────────────────────────────────────────────
const SeriesCodes = (function () {
    'use strict';

    // ^([A-Z]*\d+)(X{1,3}L)$ — anchor whole string so partial codes like
    // "604XLBK" (a SKU body) do NOT match (we only collapse already-extracted
    // canonical codes, never raw SKUs). Letters-then-digits prefix covers
    // 200/604/812 (Epson bare-numeric), T312/T200 (Epson T-series), LC133
    // (Brother LC), PGI645 (Canon PGI), CART069 (Canon toner).
    const YIELD_SUFFIX = /^([A-Z]*\d+)(X{1,3}L)$/;

    function normalize(code) {
        if (code == null) return '';
        return String(code).trim().toUpperCase().replace(/[\s-]/g, '');
    }

    /**
     * Collapse the yield suffix on a single series code.
     *
     * @param {string} code - canonical series code (post-normalizeCode, not raw SKU).
     * @returns {string} collapsed code, or '' on falsy input.
     */
    function collapseYieldSuffix(code) {
        const upper = normalize(code);
        if (!upper) return '';
        return upper.replace(YIELD_SUFFIX, '$1');
    }

    /**
     * Returns true when the code carries a yield suffix that would collapse.
     */
    function hasYieldSuffix(code) {
        const upper = normalize(code);
        return !!upper && YIELD_SUFFIX.test(upper);
    }

    /**
     * Collapse a list of series codes: dedupe + drop yield suffixes.
     *
     * @param {string[]} list
     * @returns {string[]} collapsed unique codes, in first-seen order.
     */
    function collapseList(list) {
        if (!Array.isArray(list)) return [];
        const out = [];
        const seen = new Set();
        for (const c of list) {
            const collapsed = collapseYieldSuffix(c);
            if (!collapsed || seen.has(collapsed)) continue;
            seen.add(collapsed);
            out.push(collapsed);
        }
        return out;
    }

    /**
     * Merge a chip list by collapsed base code. Each input chip is shaped
     * `{ code, count, products?, ... }` (matching what /api/shop ships and
     * what shop-page.js::extractProductCodes builds locally).
     *
     * Output preserves first-seen entry order. Each consolidated chip carries
     * `aliases` — the raw codes that collapsed into it — so the click handler
     * can fan out to every yield variant when filtering by code.
     *
     * Counts sum across collapsed siblings (200 count=16 + 200XL count=4 → 20).
     * Per-chip `products` arrays are concatenated and de-duped by id/sku so
     * the legacy code path (extractProductCodes) keeps drilldown working.
     *
     * @param {Array<{code:string,count?:number,products?:any[]}>} chips
     * @returns {Array<{code:string,count:number,aliases:string[],products?:any[]}>}
     */
    function collapseChipList(chips) {
        if (!Array.isArray(chips)) return [];
        const byBase = new Map();
        const order = [];
        for (const chip of chips) {
            if (!chip || !chip.code) continue;
            const base = collapseYieldSuffix(chip.code);
            if (!base) continue;
            if (!byBase.has(base)) {
                const entry = {
                    code: base,
                    count: 0,
                    aliases: [],
                    _seenAliases: new Set()
                };
                if (Array.isArray(chip.products)) {
                    entry.products = [];
                    entry._seenProducts = new Set();
                }
                byBase.set(base, entry);
                order.push(base);
            }
            const entry = byBase.get(base);
            // Track every raw code that collapsed into this base so click
            // handlers can fan out to each (the backend filters /api/shop?code=X
            // by exact match in series_codes, so we must request 604 AND 604XL
            // to get every product the consolidated chip implies).
            const rawUpper = String(chip.code).trim().toUpperCase().replace(/[\s-]/g, '');
            if (rawUpper && !entry._seenAliases.has(rawUpper)) {
                entry._seenAliases.add(rawUpper);
                entry.aliases.push(rawUpper);
            }
            entry.count += Number(chip.count) || 0;
            if (entry.products && Array.isArray(chip.products)) {
                for (const p of chip.products) {
                    const key = (p && (p.id || p.sku)) || null;
                    if (key == null || entry._seenProducts.has(key)) continue;
                    entry._seenProducts.add(key);
                    entry.products.push(p);
                }
            }
        }
        // Strip private bookkeeping; preserve aliases (used by loadProducts
        // fan-out) and products (legacy path).
        return order.map(base => {
            const e = byBase.get(base);
            const out = { code: e.code, count: e.count, aliases: e.aliases };
            if (e.products) out.products = e.products;
            return out;
        });
    }

    /**
     * Split a merged pair chip into its halves. The backend labels a
     * black+colour pair as one chip ("PG510/CL511") but files each product
     * under its own single code, so callers need both halves to reconcile.
     *
     * @param {string} code
     * @returns {string[]} halves, or [] when the code carries no '/'.
     */
    function pairHalves(code) {
        const upper = normalize(code);
        if (!upper || upper.indexOf('/') === -1) return [];
        return upper.split('/').map(s => s.trim()).filter(Boolean);
    }

    /**
     * Un-truncate a series code the backend's extractor cut short, using the
     * product's SKU as the source of truth.
     *
     * The backend caps Canon's bare-`CL` prefix at two digits, so CL511 and
     * CL513 both land as "CL51" and CL641/CL646 both land as "CL64" — which
     * strands the colour half of every PGxxx/CLxxx pair chip and jams two
     * unrelated series into one tile.
     *
     * Deliberately self-disabling: the SKU code only wins when it *strictly
     * extends* the backend code with extra digits (CL51 → CL511). Once the
     * backend emits CL511 itself the derived code merely equals it, nothing
     * is overridden, and this becomes a no-op. Genuine two-digit codes
     * (CL38, CL41) are never touched because their SKUs yield no longer code.
     *
     * @param {string} sku
     * @param {string} backendCode - the code the backend extracted.
     * @returns {string} the repaired code, or `backendCode` unchanged.
     */
    function trueCodeFromSku(sku, backendCode) {
        const base = normalize(backendCode);
        const skuUpper = normalize(sku);
        if (!base || !skuUpper) return base;

        // Drop the leading genuine/compatible marker (GCL511, CCL513CLR).
        const body = skuUpper.replace(/^[GC]/, '');
        const match = body.match(/^([A-Z]+\d+)/);
        if (!match) return base;

        const derived = match[1];
        if (derived === base || !derived.startsWith(base)) return base;
        // Only extra *digits* count as truncation — a letter tail (a colour or
        // yield marker) is not a longer code.
        return /^\d+$/.test(derived.slice(base.length)) ? derived : base;
    }

    return {
        collapseYieldSuffix,
        hasYieldSuffix,
        collapseList,
        collapseChipList,
        pairHalves,
        trueCodeFromSku,
        YIELD_SUFFIX_PATTERN: YIELD_SUFFIX
    };
})();

if (typeof window !== 'undefined') window.SeriesCodes = SeriesCodes;

// ---------------------------------------------------------------------------
// BRAND SOURCE — genuine vs compatible, one vocabulary (ERR-157)
//
// NOT THE SAME THING AS `CompatSource` BELOW. Read this before using either.
//
//   BrandSource  — is this PRODUCT an OEM cartridge or a third-party one?
//                  Answers 'genuine' | 'compatible' | null. Backend field:
//                  `source` on the product row.
//   CompatSource — did this product/printer MATCH come from a trustworthy
//                  place, or did the frontend guess? Answers PROVEN |
//                  UNPROVEN. Backend table: `product_compatibility`.
//
// Two modules whose names both say "source" is a trap, so they live next to
// each other with this note rather than a file apart pretending to be unrelated.
//
// WHY THIS EXISTS
// ---------------
// Six surfaces classified genuine-vs-compatible with five different rules, and
// four of them ended in the same wrong place: `<proven compatible> ? COMPATIBLE
// : GENUINE`. That default is a claim we cannot back. It broke in production.
//
// The May 2026 catalog rename moved the word out of first position — live rows
// read "143ABK Compatible Toner Cartridge for HP 143A …" — so the leading-word
// fallback `/^compatible\b/i` returned false for every compatible cartridge in
// the catalogue, and the cart's binary default then printed **GENUINE** on
// them. It only bit server-loaded rows (the locally-added row carried
// `product_source` from the card), which is to say: it bit every cart, one
// reload after it was filled. The backend shipping `source` on the cart line
// (Aug 2026) is what makes the honest version possible.
//
// order-detail-page.js had the same default reached a worse way — an unanchored
// `(product_name || '').includes('compatible')`, which also says COMPATIBLE for
// a genuine cartridge whose name reads "compatible with DCP-J1050DW".
//
// THE RULE
// --------
//     THE FRONTEND NEVER INFERS BRAND SOURCE FROM A NAME.
//
// The backend pinned the same rule on their side (CLAUDE.md §4.2: every
// cart-items SELECT must keep projecting `source`). Ours is enforced by
// tests/cart-line-source-aug2026.test.js, which greps the whole of js/ for
// name-shaped inference and fails on a new one.
//
// UNKNOWN IS AN ANSWER, AND IT IS NOT "GENUINE"
// ---------------------------------------------
// `of()` returns null rather than picking a side, and `badgeHTML()` renders
// nothing for null. That is what the PDP has always done
// (product-detail-page.js: "we never assert a status we don't know") and what
// Merchant Center and the OEM-warranty claim rules require of us (ERR-063,
// ERR-078). A missing badge is a smaller failure than a false one, in both
// directions: calling a third-party cartridge "GENUINE" is a misrepresentation,
// and calling an OEM cartridge "COMPATIBLE" devalues it.
//
// The colour-tile gate asks a DIFFERENT question and keeps its own default:
// `isCompatible()` is false for unknown, so an unproven row falls through to
// the neutral placeholder rather than a coloured tile (the genuine-no-colour-
// tile invariant, ERR-143). Both defaults point away from an assertion; they
// just point in different directions because the two questions differ.
const BrandSource = (function () {
    const GENUINE = 'genuine';
    const COMPATIBLE = 'compatible';

    // Values the CART writes into a row's `source` slot for its own bookkeeping.
    // `cartItemKey()` builds "<subsystem>:<sku>" composite keys out of this, so
    // the field is a namespace there, NOT a brand source — and a server cart
    // line carries the brand source in the sibling `source` one level up. Any
    // row whose `source` is one of these is telling us which subsystem added it
    // and nothing at all about the manufacturer.
    const CART_NAMESPACE_SENTINELS = ['core', 'cross-sell'];

    function normalise(value) {
        const v = String(value == null ? '' : value).trim().toLowerCase();
        if (v === GENUINE) return GENUINE;
        if (v === COMPATIBLE) return COMPATIBLE;
        return null;
    }

    /**
     * The product's brand source, or null when we cannot prove one.
     *
     * Reads, in order of trustworthiness:
     *   1. `product_source`  — the cart/favourites/checkout stored-row spelling,
     *                          captured at add time from the card's data
     *                          attribute and re-derived on every server reload.
     *   2. `product.source`  — a nested catalog object (an order line, a
     *                          favourite, a cart line handed over whole).
     *   3. `source`          — the catalog spelling, ignoring the cart's own
     *                          namespace sentinels.
     *   4. `is_genuine`      — /suggest's boolean, and ONLY when it really is a
     *                          boolean. `undefined` is not `false`; treating it
     *                          as false is how `is_genuine ? 'genuine' :
     *                          'compatible'` invented a source for rows that
     *                          carried neither field.
     *
     * @param {object|null} row  a product, cart line, favourite or order line
     * @returns {'genuine'|'compatible'|null}
     */
    function of(row) {
        if (!row || typeof row !== 'object') return null;

        const stored = normalise(row.product_source);
        if (stored) return stored;

        const nested = row.product && typeof row.product === 'object'
            ? normalise(row.product.source)
            : null;
        if (nested) return nested;

        const raw = row.source;
        if (raw != null && !CART_NAMESPACE_SENTINELS.includes(String(raw).toLowerCase())) {
            const direct = normalise(raw);
            if (direct) return direct;
        }

        if (typeof row.is_genuine === 'boolean') return row.is_genuine ? GENUINE : COMPATIBLE;

        return null;
    }

    /** True only for a PROVEN compatible. Unknown ⇒ false — see the tile note above. */
    function isCompatible(row) {
        return of(row) === COMPATIBLE;
    }

    /** True only for a PROVEN genuine. Unknown ⇒ false. */
    function isGenuine(row) {
        return of(row) === GENUINE;
    }

    /** True when we can prove either answer — i.e. when a badge may be rendered. */
    function isKnown(row) {
        return of(row) !== null;
    }

    /** 'GENUINE' | 'COMPATIBLE' | null. Null means "render nothing". */
    function label(row) {
        const s = of(row);
        return s ? s.toUpperCase() : null;
    }

    /**
     * The shared `.source-badge` pill, or '' when the source is unknown.
     *
     * Returning '' rather than a placeholder is the point: callers concatenate
     * this straight into a template, so an unknown source costs one empty
     * string and no layout. Every customer-facing genuine/compatible pill goes
     * through here so there is one place to audit the claim.
     *
     * Values are drawn from a closed set ('genuine'/'compatible'), never from
     * caller input, so there is nothing here to escape.
     *
     * @param {object|null} row
     * @param {string} [baseClass='source-badge']
     * @returns {string} HTML, possibly empty
     */
    function badgeHTML(row, baseClass) {
        const s = of(row);
        if (!s) return '';
        const cls = baseClass || 'source-badge';
        return `<span class="${cls} ${cls}--${s}">${s.toUpperCase()}</span>`;
    }

    return {
        GENUINE,
        COMPATIBLE,
        CART_NAMESPACE_SENTINELS,
        of,
        isCompatible,
        isGenuine,
        isKnown,
        label,
        badgeHTML
    };
})();

if (typeof window !== 'undefined') window.BrandSource = BrandSource;

// ---------------------------------------------------------------------------
// COMPATIBILITY PROVENANCE — one vocabulary (ERR-135)
//
// NOT `BrandSource` ABOVE. This module is about whether a product/printer MATCH
// is trustworthy; `BrandSource` is about whether a PRODUCT is OEM or
// third-party. Neither answers the other's question.
//
// A customer bought a cartridge that didn't fit their printer. The backend
// removed the bad `product_compatibility` rows, but an audit of the frontend
// found it was generating wrong-family "compatible" claims of its own, from
// data that never touched `product_compatibility`:
//
//   • /shop?printer_model=<text> fell through to a BRAND-NAME keyword search
//     and rendered up to 100 results under "Compatible Products for <printer>".
//     Measured: `?search=Brother&limit=100` → 100 products across 71 series
//     families (label tapes, drums, photo paper).
//   • A hardcoded printer→code table then ran `ilike('name', '%<code>%')`.
//     Measured: `%200%` → 141 products, because "(9,200 pages)" contains 200.
//   • The PDP borrowed a sibling's printer list when a product had none of its
//     own, picking the sibling by the same unbounded substring match.
//
// The rule this module exists to enforce, and the reason it is ONE module:
//
//     THE FRONTEND NEVER ASSERTS COMPATIBILITY.
//
// Only `product_compatibility`, reached through the backend, may put a product
// under a "fits your printer" heading. Anything else is a SEARCH RESULT and
// must be labelled as one. This mirrors the older, load-bearing rule that the
// frontend never computes prices.
//
// Every compatibility decision in the storefront routes through here so there
// is a single place to audit. Two independent substring matchers is how the
// first one got away with being wrong for months.
const CompatSource = (function () {
    // The only two answers. There is deliberately no third value for "probably"
    // — an unproven product is UNPROVEN and may not be labelled compatible.
    //
    // PROVEN is earned by exactly three backend surfaces, all of which read
    // `product_compatibility` server-side:
    //   • /api/products/printer/:slug   → data.compatible_products[]
    //   • /api/search/by-printer        → data.products[]
    //   • /api/search/smart             → data.products[] ONLY when the payload
    //                                     also carries a truthy matched_printer
    const PROVEN = 'proven';
    const UNPROVEN = 'unproven';

    // Printer identity, separator-insensitive.
    //
    // `printer_models` is not internally consistent about separators — it holds
    // "Brother DCP J1050DW" (spaces) alongside "Brother DCP-J1260W" (dash) — and
    // customers type a third way again. Every FE lookup that compared raw
    // strings therefore missed: `full_name ilike '%Brother DCP-J1050DW%'`
    // returns nothing for a printer that is right there in the table. Collapse
    // to alphanumerics and the three spellings become one key.
    //
    //   "Brother DCP-J1050DW" ┐
    //   "Brother DCP J1050DW" ├→ "brotherdcpj1050dw"
    //   "brother dcpj1050dw"  ┘
    function printerKey(value) {
        return String(value == null ? '' : value).toLowerCase().replace(/[^a-z0-9]+/g, '');
    }

    // Leading manufacturer word, so a free-text model can be routed to the
    // right brand pool. Kept here rather than duplicated at each call site
    // because the list has to agree with `slugifyBrand` to be useful.
    const BRAND_PREFIX = /^(brother|canon|epson|hewlett[\s-]*packard|hp|samsung|lexmark|oki|fuji[\s-]*xerox|xerox|kyocera|ricoh|dell|sharp|toshiba)\b[\s-]*/i;

    function brandPrefixOf(value) {
        const m = String(value == null ? '' : value).match(BRAND_PREFIX);
        return m ? m[1] : null;
    }

    function stripBrandPrefix(value) {
        return String(value == null ? '' : value).replace(BRAND_PREFIX, '').trim();
    }

    // Printer-model-shaped tokens, which must never be mistaken for cartridge
    // codes. This is the wrong-family bug running in the other direction: when
    // the backend ships an empty `series_codes`, both `familyKey()` here and
    // `_enrichSeriesCodes()` in api.js fall back to scraping a code out of the
    // product NAME — and a compatible cartridge's name ends with the printers
    // it fits ("...Replacement for Brother DCP-J1050DW MFC-J1010DW"). Scraping
    // that yields "DCPJ1050DW" as a cartridge series code, which then forks or
    // merges families keyed on a printer.
    //
    // Two independent signals, either sufficient:
    //   • a known printer-line prefix (DCP, MFC, PIXMA, WorkForce, …)
    //   • a Brother/Canon-style device suffix (DW, CDW, FDW, …), which no
    //     cartridge code in the catalogue carries
    //
    // The prefix must be followed by an optional single letter and then a DIGIT
    // (`DCP-J1050DW` → `DCP` + `J1` ✓, `XP-4100` → `XP` + `4` ✓). Without that
    // lookahead the short entries eat real consumables — `ML` would swallow
    // Samsung's `MLT-D101S` toner, whose prefix is two letters deep before any
    // digit. `L` is spelled separately as `L(?=\d)` because Epson's EcoTank
    // L3110 is a printer, but the shared `[A-Z]?\d` lookahead would let a bare
    // `L` swallow Brother's entire `LC431` ink family (`L` + `C4`).
    //
    // THE ABSENCES ARE THE INTERESTING PART. Every candidate was swept against
    // all 977 distinct `series_codes` in the live catalogue; these were removed
    // because a product we actually sell collides with them:
    //   • ML  — OKI Microline ribbons are NAMED for the printer, so `ML182`,
    //           `ML590` and `ML720` are series codes, not devices.
    //   • IX  — Fuji Xerox toners `IX105` / `IX305` / `IX315` / `IX405`.
    //   • TD  — ribbon codes `TD455X25`, `TD490X29`, `TD4100X149`.
    //   • FS  — collides with OKI/Kyocera consumable spellings.
    //   • MX  — Sharp `MX-23` toner.    • MP — Ricoh `MP 2014H` toner.
    // `DN`/`CDN` are likewise absent from the suffix test: OKI ships a toner
    // whose series code is literally `332DN`.
    //
    // For an ambiguous token, calling a cartridge a printer is the WORSE
    // failure here — it would fork a real family — so ambiguity resolves to
    // "not a printer" and the guard simply declines to fire. Dropping these
    // costs nothing on the incident shapes, which are all `DCP`/`MFC` + `DW`.
    const PRINTER_LINE_PREFIX = /^(?:L(?=\d)|(?:DCP|MFC|HL|FAX|PIXMA|MAXIFY|IMAGECLASS|IMAGERUNNER|LBP|SELPHY|XP|WF|ET|SURECOLOR|WORKFORCE|ECOTANK|EXPRESSION|STYLUS|DESKJET|OFFICEJET|ENVY|LASERJET|PAGEWIDE|PHOTOSMART|SMARTTANK|NEVERSTOP|CLP|CLX|SCX|SL|XPRESS|ECOSYS|TASKALFA|AFICIO|VERSALINK|PHASER|WORKCENTRE|DOCUPRINT|QL|PT|RJ|TS|TR|MG|IP|GX)(?=[A-Z]?\d))/i;
    const DEVICE_SUFFIX = /(?:C?DWF?|FDW|DWE|NW|TN?W)$/i;

    function isPrinterModelToken(token) {
        const t = String(token == null ? '' : token).toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!t) return false;
        // Both signals require digits — a bare colour or yield word must not trip
        // them, and a device suffix on a letters-only token means nothing.
        if (!/\d/.test(t)) return false;
        if (PRINTER_LINE_PREFIX.test(t)) return true;
        return DEVICE_SUFFIX.test(t);
    }

    // Whole-token code matching. The single implementation.
    //
    // Two correct versions of this already existed (shop-page's queryCodeMatch
    // and the PDP's related-products series filter) and two incorrect ones
    // (`ilike('name','%code%')`, twice). The correct ones both agreed on the two
    // rules that matter, so those rules live here now:
    //
    //   1. BOUNDARIES, never substrings. `LC431` must not match `LC4310`, and
    //      `61XL` must not match `961XL`. Boundaries are tested against the RAW
    //      text — normalising first would collapse "9,200 pages" to "9200pages"
    //      and re-admit it.
    //   2. REJECT YIELD PROSE. A code followed by "page"/"pages" is a page
    //      count, not a code. This one rule is what stops `%200%` from matching
    //      141 products via "(9,200 pages)".
    //
    // A trailing yield marker is still a match, because LC431XL genuinely
    // belongs to the LC431 family.
    const YIELD_ALTERNATION = '(?:XL|XXL|XXHY|EHY|HY|H)?';

    function escapeForRegex(value) {
        return String(value == null ? '' : value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // Anchored: for testing one candidate code against one known code.
    function codeExactRegex(code) {
        return new RegExp('^' + escapeForRegex(code) + YIELD_ALTERNATION + '$', 'i');
    }

    // Bounded: for finding a code inside free text (a product name or SKU).
    // Global, so callers can walk every occurrence and apply rule 2 to each.
    function codeTokenRegex(code) {
        return new RegExp('(^|[^0-9A-Za-z])(' + escapeForRegex(code) + YIELD_ALTERNATION + ')([^0-9A-Za-z]|$)', 'gi');
    }

    // True when `code` appears in `text` as a real code token — boundaries
    // respected, page counts rejected. This is the function that replaces every
    // `ilike('name', '%code%')` the audit found.
    function textHasCodeToken(text, code) {
        const haystack = String(text == null ? '' : text);
        if (!haystack || !code) return false;
        const re = codeTokenRegex(code);
        let m;
        while ((m = re.exec(haystack)) !== null) {
            const afterIdx = m.index + (m[1] ? m[1].length : 0) + m[2].length;
            // Rule 2 — "<code> page(s)" is a yield, not a code.
            if (/^\s*pages?\b/i.test(haystack.slice(afterIdx))) continue;
            return true;
        }
        return false;
    }

    // Does this product belong to `code`'s family? Backend `series_codes` first
    // (authoritative), then a bounded name/SKU scan. Never a substring.
    function productMatchesCode(product, code) {
        if (!product || !code) return false;
        const exact = codeExactRegex(code);
        const codes = Array.isArray(product.series_codes) ? product.series_codes : [];
        for (const c of codes) {
            const nc = String(c == null ? '' : c).replace(/[^0-9A-Za-z]/g, '');
            if (nc && exact.test(nc)) return true;
        }
        for (const field of [product.name, product.sku]) {
            if (textHasCodeToken(field, code)) return true;
        }
        return false;
    }

    return {
        PROVEN,
        UNPROVEN,
        printerKey,
        brandPrefixOf,
        stripBrandPrefix,
        isPrinterModelToken,
        codeExactRegex,
        codeTokenRegex,
        textHasCodeToken,
        productMatchesCode,
        BRAND_PREFIX_PATTERN: BRAND_PREFIX
    };
})();

if (typeof window !== 'undefined') window.CompatSource = CompatSource;

// ---------------------------------------------------------------------------
// Category slug canonicalization (IA reorg, Jul 2026)
//
// The backend's canonical category slugs are: ink, toner, ribbon, drums,
// label, paper (its CATEGORY_TAXONOMY), and its redirect layer 301-normalizes
// everything else. This helper is the FE mirror used at every URL boundary
// (mega-nav links, shop-page URL state, PDP breadcrumbs) so the storefront
// never emits a non-canonical slug.
//
// Returns the canonical slug, or null when the input has no canonical
// equivalent ('cartridge', unknowns) — callers strip the param in that case.
function canonicalizeCategory(raw) {
    if (raw === null || raw === undefined) return null;
    const v = String(raw).trim().toLowerCase();
    const CANONICAL = ['ink', 'toner', 'ribbon', 'drums', 'label', 'paper'];
    if (CANONICAL.includes(v)) return v;
    const ALIASES = {
        consumable: 'drums',     // legacy FE mega-nav param
        drum: 'drums',           // PDP info.category (singular)
        label_tape: 'label',     // legacy FE mega-nav param
        ribbons: 'ribbon',
        'ink-cartridges': 'ink'
    };
    if (Object.prototype.hasOwnProperty.call(ALIASES, v)) return ALIASES[v];
    return null;
}
if (typeof window !== 'undefined') window.canonicalizeCategory = canonicalizeCategory;

/**
 * TRUST STATS  (traffic-conversion-jul2026 §2)
 * ============================================
 * Sitewide social-proof counts from `GET /api/site/trust` → `data.stats`:
 *
 *     { customers_served, orders_shipped, cartridges_sold,
 *       founded_year, refreshed_at }
 *
 * The counts are FLOORED TO HONEST BANDS server-side, so they render with a
 * trailing "+" ("47+ customers served"). Any count may be `null` — that means
 * "not computed yet", NOT zero, and the slot must be HIDDEN rather than shown
 * as "0+" or "null+". As of 2026-07-28 production returns null for all three
 * (the nightly sweep has never run), so every consumer of this module must
 * look correct in the all-null state — that is the state that ships today.
 *
 * WHY THIS LIVES IN utils.js
 * --------------------------
 * js/seo-meta.js already fetches the same endpoint, but it is loaded on only
 * 3 of 42 HTML pages (index, shop, ribbons). The footer renders on 36. utils.js
 * is loaded on 38, so it is the only existing sitewide home — and adding a new
 * /js/*.js file would need a matching `?v=` token in every page that loads it
 * (tests/asset-cache-tokens.test.js §1/§2). SeoMeta.getTrust() delegates here
 * so the shared pages issue ONE request, not two.
 *
 * Fail-open by design: a dead endpoint must never block or blank a page, so
 * every failure resolves to `{}` and every consumer hides its slot.
 */
const TrustStats = {
    ENDPOINT: '/api/site/trust',
    CACHE_KEY: 'ic_trust_raw_v1',
    TTL_MS: 60 * 60 * 1000,   // 1h — the backend refreshes nightly

    _promise: null,

    _apiUrl() {
        const base = (typeof Config !== 'undefined' && Config.API_URL != null) ? Config.API_URL : '';
        return `${base}${this.ENDPOINT}`;
    },

    _readCache() {
        try {
            const raw = sessionStorage.getItem(this.CACHE_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || (Date.now() - parsed.ts) > this.TTL_MS) return null;
            return parsed.payload;
        } catch { return null; }
    },

    _writeCache(payload) {
        try {
            sessionStorage.setItem(this.CACHE_KEY, JSON.stringify({ ts: Date.now(), payload }));
        } catch { /* private mode / quota — ignore */ }
    },

    /**
     * The whole `data` object from /api/site/trust, session-cached and
     * in-flight-deduped. Resolves to `{}` on any failure (fail-open).
     * @returns {Promise<Object>}
     */
    async raw() {
        const cached = this._readCache();
        if (cached) return cached;
        if (this._promise) return this._promise;
        this._promise = (async () => {
            if (typeof fetch !== 'function') return {};
            try {
                // Public trust-stats read — cookies explicitly omitted (ERR-124).
            const res = await fetch(this._apiUrl(), { headers: { 'Accept': 'application/json' }, credentials: 'omit' });
                if (!res.ok) return {};
                const json = await res.json();
                // Envelope is { ok, data } — but tolerate a bare object.
                const data = (json && typeof json === 'object' && 'data' in json) ? json.data : json;
                const payload = (data && typeof data === 'object') ? data : {};
                this._writeCache(payload);
                return payload;
            } catch {
                return {};
            } finally {
                this._promise = null;
            }
        })();
        return this._promise;
    },

    /**
     * Just the `stats` sub-object, normalised to numbers-or-null. Never throws.
     * @returns {Promise<{customersServed:number|null, ordersShipped:number|null,
     *                    cartridgesSold:number|null, foundedYear:number|null,
     *                    refreshedAt:string|null}>}
     */
    async stats() {
        const data = await this.raw();
        return this.normalize(data && data.stats);
    },

    normalize(stats) {
        const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
        const s = (stats && typeof stats === 'object') ? stats : {};
        return {
            customersServed: n(s.customers_served),
            ordersShipped: n(s.orders_shipped),
            cartridgesSold: n(s.cartridges_sold),
            foundedYear: n(s.founded_year),
            refreshedAt: typeof s.refreshed_at === 'string' ? s.refreshed_at : null,
        };
    },

    /**
     * Format a count as an honest band: 47 → "47+". Returns null — never a
     * string — for null / non-finite / <= 0, so callers hide the slot instead
     * of painting "0+" or "null+". Absence is NOT zero.
     * @param {*} value
     * @returns {string|null}
     */
    band(value) {
        if (typeof value !== 'number' || !Number.isFinite(value)) return null;
        const floored = Math.floor(value);
        if (floored <= 0) return null;
        return `${floored.toLocaleString('en-NZ')}+`;
    },

    /**
     * The three social-proof lines, in display order, already banded and with
     * the null slots dropped. Empty array = render nothing at all.
     * @param {Object} stats - output of normalize()
     * @returns {Array<{key:string, value:string, label:string}>}
     */
    lines(stats) {
        const s = stats || {};
        return [
            { key: 'customers', value: this.band(s.customersServed), label: 'customers served' },
            { key: 'orders', value: this.band(s.ordersShipped), label: 'orders shipped' },
            { key: 'cartridges', value: this.band(s.cartridgesSold), label: 'cartridges sold' },
        ].filter(row => row.value !== null);
    },
};
if (typeof window !== 'undefined') window.TrustStats = TrustStats;

/**
 * DISPATCH COUNTDOWN  (traffic-conversion-jul2026 §4)
 * ===================================================
 * "Order within 1h 59m for same-day dispatch", ticking client-side.
 *
 * Seeded from `delivery_estimate.cutoff_remaining_seconds`, which the backend
 * describes as a POINT-IN-TIME value — PDP responses are briefly cached, so it
 * must never be trusted to the exact second. The client clock owns the tick.
 *
 * The seed is converted ONCE into an ABSOLUTE deadline (`Date.now() + s*1000`)
 * and every tick recomputes `deadline - Date.now()`. That matters more than it
 * looks: a decrement-a-counter timer drifts badly when the tab is backgrounded
 * (browsers clamp setInterval to ~1/minute) and is flat wrong after a laptop
 * sleeps or a bfcache restore. Recomputing from an absolute deadline is
 * self-correcting in all three cases — the number is right the instant the
 * user looks at it again.
 *
 * `same_day_eligible === false` (incl. weekends) renders NOTHING; the static
 * "Order before 2pm NZT for same-day dispatch" copy already on the page is the
 * fallback framing, and it stays untouched.
 */
const DispatchCountdown = {
    /**
     * Human form of a remaining duration.
     *   >= 1h  → "1h 59m"   (seconds are noise at that range)
     *   <  1h  → "9m 05s"   (zero-padded so the string does not jitter in width)
     *   <  1m  → "45s"
     * @param {number} totalSeconds
     * @returns {string}
     */
    format(totalSeconds) {
        const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
        const hours = Math.floor(s / 3600);
        const minutes = Math.floor((s % 3600) / 60);
        const seconds = s % 60;
        if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m`;
        if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
        return `${seconds}s`;
    },

    /**
     * True when the payload says an order placed right now still makes today's
     * courier. Requires BOTH the flag and a positive seed — a `true` flag with
     * 0 seconds left is an expired cache, not an opportunity.
     * @param {Object} deliveryEstimate
     * @returns {boolean}
     */
    isEligible(deliveryEstimate) {
        const d = deliveryEstimate || {};
        if (d.same_day_eligible !== true) return false;
        const secs = Number(d.cutoff_remaining_seconds);
        return Number.isFinite(secs) && secs > 0;
    },

    /**
     * Mount a live countdown into `el`. Returns a handle with `.stop()`.
     * Calling mount() again on the same element stops the previous timer
     * first (Cart.renderCartSignals re-runs on every mutation — without this
     * the timers would stack and the number would tick multiple times a
     * second).
     *
     * @param {Element} el              - target element (hidden when not eligible)
     * @param {Object}  deliveryEstimate
     * @param {Object} [opts]
     * @param {Function} [opts.setInterval] - injectable for tests
     * @param {Function} [opts.clearInterval]
     * @param {Function} [opts.now]         - injectable clock for tests
     * @returns {{stop: Function}|null}
     */
    mount(el, deliveryEstimate, opts) {
        if (!el) return null;
        const o = opts || {};
        const now = typeof o.now === 'function' ? o.now : () => Date.now();
        const setI = typeof o.setInterval === 'function' ? o.setInterval : ((fn, ms) => setInterval(fn, ms));
        const clearI = typeof o.clearInterval === 'function' ? o.clearInterval : ((id) => clearInterval(id));

        // Always stop whatever was previously mounted here.
        if (el._dispatchTimer) {
            clearI(el._dispatchTimer);
            el._dispatchTimer = null;
        }

        if (!this.isEligible(deliveryEstimate)) {
            el.textContent = '';
            el.hidden = true;
            return null;
        }

        const deadline = now() + (Number(deliveryEstimate.cutoff_remaining_seconds) * 1000);

        const paint = () => {
            const remaining = Math.floor((deadline - now()) / 1000);
            if (remaining <= 0) {
                // Cutoff passed while the page was open — retire silently back
                // to the static framing rather than claiming a dispatch we
                // can no longer honour.
                stop();
                el.textContent = '';
                el.hidden = true;
                return;
            }
            el.textContent = `Order within ${this.format(remaining)} for same-day dispatch`;
            el.hidden = false;
        };

        const stop = () => {
            if (el._dispatchTimer) {
                clearI(el._dispatchTimer);
                el._dispatchTimer = null;
            }
        };

        paint();
        el._dispatchTimer = setI(paint, 1000);
        return { stop };
    },
};
if (typeof window !== 'undefined') window.DispatchCountdown = DispatchCountdown;

/**
 * COUPON SUGGESTION  (traffic-conversion-jul2026 §5)
 * ==================================================
 * When a coupon fails the API may nudge toward a currently-valid public one:
 *
 *     { code: "SAVE10", label: "10% off", condition: "on orders over $50" }
 *
 * `condition` is optional. Two transports carry it, and callers must read BOTH:
 *   - POST /api/cart/coupon          → HTTP 400 → `error.details.suggestion`
 *   - POST /api/cart/coupon/preview  → HTTP 200 → `data.suggestion`
 *
 * NEVER surface WHY the tried code failed — anti-enumeration is deliberate.
 * The 429 lockout (`COUPON_LOCKED`) intentionally carries no suggestion, and
 * `pick()` refuses to read one out of a rate-limited response even if a future
 * backend accidentally includes it.
 */
const CouponSuggestion = {
    /** Codes whose responses must never yield a suggestion (security lockout). */
    LOCKED_CODES: ['COUPON_LOCKED', 'RATE_LIMITED'],

    /**
     * Pull the suggestion out of whichever shape we were handed: a resolved
     * error envelope, a thrown Error with `.details`, or a 200 preview body.
     * Returns null when absent, malformed, or when the response is a lockout.
     * @param {*} source
     * @returns {{code:string, label:string|null, condition:string|null}|null}
     */
    pick(source) {
        if (!source || typeof source !== 'object') return null;
        const code = source.code;
        if (typeof code === 'string' && this.LOCKED_CODES.includes(code)) return null;

        const candidate =
            (source.details && source.details.suggestion)          // thrown Error / returned envelope
            || (source.error && source.error.details && source.error.details.suggestion) // raw envelope
            || (source.data && source.data.suggestion)             // preview body under `data`
            || source.suggestion                                   // already-unwrapped preview body
            || null;

        if (!candidate || typeof candidate !== 'object') return null;
        const suggestedCode = typeof candidate.code === 'string' ? candidate.code.trim() : '';
        if (!suggestedCode) return null;
        return {
            code: suggestedCode,
            label: typeof candidate.label === 'string' && candidate.label.trim() ? candidate.label.trim() : null,
            condition: typeof candidate.condition === 'string' && candidate.condition.trim() ? candidate.condition.trim() : null,
        };
    },

    /**
     * Plain-text nudge. No reason for the failure, ever.
     *   full  → 'That code didn’t work — try SAVE10 for 10% off on orders over $50.'
     *   no condition → 'That code didn’t work — try SAVE10 for 10% off.'
     *   no label     → 'That code didn’t work — try SAVE10.'
     * @param {Object} suggestion - output of pick()
     * @returns {string|null}
     */
    text(suggestion) {
        if (!suggestion || !suggestion.code) return null;
        let tail = suggestion.code;
        if (suggestion.label) {
            tail += ` for ${suggestion.label}`;
            if (suggestion.condition) tail += ` ${suggestion.condition}`;
        }
        return `That code didn’t work — try ${tail}.`;
    },
};
if (typeof window !== 'undefined') window.CouponSuggestion = CouponSuggestion;

/**
 * ADMIN ACCESS
 * ============
 * ONE vocabulary for the question "may this person use the admin area?", shared
 * by the three surfaces that ask it: `js/admin/auth.js` (the /admin gate),
 * `js/main.js` (the header shortcut) and `js/site-guard.js` (the lockdown
 * bypass). It lives here because utils.js is the only module loaded by all
 * three — the admin SPA reads it off `window`, the two classic scripts read it
 * from the shared global scope.
 *
 * WHY IT EXISTS (ERR-188). The backend was down for 22 minutes on 2026-08-31
 * and the owner could not tell a server outage from having lost their admin
 * rights, because every failure took the same exit: a silent
 * `location.href = '/account'`. Three different causes, one indistinguishable
 * symptom, no message anywhere.
 *
 * So the rule is: **refuse only on an authoritative negative.** A 403, or a 200
 * that grants nothing, is the server answering "no" — that is a refusal. A 502,
 * a timeout, a rate-limit, a 404 on the route itself, or any error we cannot
 * read is a NON-ANSWER, and a non-answer must never be rendered as "you are not
 * an admin". This is the fail-soft-must-be-loud rule applied to authorisation:
 * absence of a yes is not a no.
 *
 * TWO 5xx SHAPES, and missing the second one is what made this subtle.
 * `API.request()` handles a server error in two different ways depending on the
 * body it gets back:
 *   - a NON-JSON 5xx (the Render/Cloudflare HTML gateway page) THROWS, and
 *   - a JSON 5xx envelope RETURNS `{ ok: false, code, status }` without throwing.
 * A caller that only wraps the call in try/catch therefore handles the first and
 * silently mis-reads the second as a refusal. `classify()` takes both — pass the
 * resolved value as `resp`, or the thrown error as `err` — so neither shape can
 * be forgotten at a call site.
 */
const AdminAccess = {
    /**
     * The only recognised roles, mapped to the two privilege levels the UI has.
     * Keys are normalised (lowercased, non-letters stripped), so the backend's
     * `super_admin` and a legacy `superadmin` are the same key by construction
     * rather than by two hand-maintained spellings — which is how admin/auth.js
     * and site-guard.js had drifted to different accept-lists for one endpoint.
     */
    ROLE_MAP: { superadmin: 'owner', owner: 'owner', admin: 'admin' },

    /** Role string → 'owner' | 'admin' | null (unrecognised). */
    normalizeRole(raw) {
        const key = String(raw == null ? '' : raw).toLowerCase().replace(/[^a-z]/g, '');
        return Object.prototype.hasOwnProperty.call(this.ROLE_MAP, key) ? this.ROLE_MAP[key] : null;
    },

    /**
     * Highest role granted by a verify payload, or null.
     *
     * Reads `role` AND `roles[]`. The live response carries both
     * (`{"role":"super_admin","roles":["super_admin"]}`); reading only the
     * scalar would silently drop a future account whose privilege arrives in
     * the array. `owner` wins over `admin` when both appear.
     *
     * `is_admin: true` alone does NOT grant — an unrecognised role is refused,
     * not waved through, because this build cannot know what it permits.
     */
    roleFrom(data) {
        if (!data || typeof data !== 'object') return null;
        const candidates = [];
        if (data.role) candidates.push(data.role);
        if (Array.isArray(data.roles)) candidates.push.apply(candidates, data.roles);
        let best = null;
        for (let i = 0; i < candidates.length; i++) {
            const role = this.normalizeRole(candidates[i]);
            if (role === 'owner') return 'owner';
            if (role === 'admin') best = 'admin';
        }
        return best;
    },

    /**
     * Classify one `API.verifyAdmin()` outcome into exactly one state.
     *
     * Call as `classify(resp)` on resolve, or `classify(null, err)` on throw.
     *
     *   'granted'      — the server said yes; `.role` is 'owner' or 'admin'
     *   'refused'      — the server authoritatively said no (403, or a 200 that
     *                    grants nothing, or a role this build doesn't recognise)
     *   'signed-out'   — 401: the session is gone or expired; re-authenticate
     *   'unreachable'  — NO ANSWER. Never render this as a refusal.
     *
     * @returns {{state:string, role:(string|null), status:number,
     *            requestId:(string|null), message:string}}
     */
    classify(resp, err) {
        const out = (state, extra) => Object.assign(
            { state: state, role: null, status: 0, requestId: null, message: '' },
            extra || {}
        );

        // Thrown: a non-JSON 5xx, a network failure, or an abort. None of these
        // is the server answering the question, so none of them is a refusal.
        if (err) {
            return out('unreachable', {
                status: Number(err.status) || 0,
                requestId: err.request_id || null,
                message: err.message || ''
            });
        }

        if (!resp || typeof resp !== 'object') return out('unreachable');

        const status = Number(resp.status) || 0;
        const code = resp.code || '';
        const requestId = resp.request_id || null;
        const message = typeof resp.error === 'string' ? resp.error : '';

        if (code === 'UNAUTHORIZED' || status === 401) {
            return out('signed-out', { status: status || 401, requestId, message });
        }

        // Non-answers. NOT_FOUND belongs here and not in 'refused': a 404 on
        // /api/admin/verify means the route is missing from the deploy, which
        // is a broken backend, not a statement about this account.
        if (status >= 500 || code === 'INTERNAL_ERROR' || code === 'RATE_LIMITED'
            || code === 'NOT_FOUND' || status === 404) {
            return out('unreachable', { status, requestId, message });
        }

        if (resp.ok === false) {
            if (code === 'FORBIDDEN' || status === 403) {
                return out('refused', { status: status || 403, requestId, message });
            }
            // An error we can't read. Ambiguity resolves to 'no answer', never
            // to 'no' — the whole point of ERR-188.
            return out('unreachable', { status, requestId, message });
        }

        // The server answered 200. Whatever it granted (or didn't) is final.
        const role = this.roleFrom(resp.data);
        if (!role) return out('refused', { status: status || 200, requestId, message });
        return out('granted', { role, status: status || 200, requestId });
    },

    /** True when the state means "we could not get an answer". */
    isUnreachable(state) { return state === 'unreachable'; }
};
if (typeof window !== 'undefined') window.AdminAccess = AdminAccess;

// Export for module use (if needed in future)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        $, $$, on,
        getStorage, setStorage,
        debounce,
        storageUrl,
        esc, escAttr,
        buildPrinterUrl,
        ProductColors,
        ProductSort,
        ProductName,
        SeriesCodes,
        BrandSource,
        CompatSource,
        canonicalizeCategory,
        TrustStats,
        DispatchCountdown,
        CouponSuggestion,
        AdminAccess
    };
}
