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
        // Multi-color packs - vertical stripes
        'cmy': 'linear-gradient(to right, #00bcd4 0%, #00bcd4 33.33%, #e91e63 33.33%, #e91e63 66.66%, #ffeb3b 66.66%, #ffeb3b 100%)',
        'bcmy': 'linear-gradient(to right, #1a1a1a 0%, #1a1a1a 25%, #00bcd4 25%, #00bcd4 50%, #e91e63 50%, #e91e63 75%, #ffeb3b 75%, #ffeb3b 100%)',
        'kcmy': 'linear-gradient(to right, #1a1a1a 0%, #1a1a1a 25%, #00bcd4 25%, #00bcd4 50%, #e91e63 50%, #e91e63 75%, #ffeb3b 75%, #ffeb3b 100%)',
        'cmyk': 'linear-gradient(to right, #00bcd4 0%, #00bcd4 25%, #e91e63 25%, #e91e63 50%, #ffeb3b 50%, #ffeb3b 75%, #1a1a1a 75%, #1a1a1a 100%)',
        'tri-color': 'linear-gradient(to right, #00bcd4 0%, #00bcd4 33.33%, #e91e63 33.33%, #e91e63 66.66%, #ffeb3b 66.66%, #ffeb3b 100%)',
        '4-pack': 'linear-gradient(to right, #1a1a1a 0%, #1a1a1a 25%, #00bcd4 25%, #00bcd4 50%, #e91e63 50%, #e91e63 75%, #ffeb3b 75%, #ffeb3b 100%)',
        '4 pack': 'linear-gradient(to right, #1a1a1a 0%, #1a1a1a 25%, #00bcd4 25%, #00bcd4 50%, #e91e63 50%, #e91e63 75%, #ffeb3b 75%, #ffeb3b 100%)',
        'tri-colour': 'linear-gradient(to right, #00bcd4 0%, #00bcd4 33.33%, #e91e63 33.33%, #e91e63 66.66%, #ffeb3b 66.66%, #ffeb3b 100%)',
        'color': 'linear-gradient(to right, #00bcd4 0%, #00bcd4 33.33%, #e91e63 33.33%, #e91e63 66.66%, #ffeb3b 66.66%, #ffeb3b 100%)',
        'colour': 'linear-gradient(to right, #00bcd4 0%, #00bcd4 33.33%, #e91e63 33.33%, #e91e63 66.66%, #ffeb3b 66.66%, #ffeb3b 100%)'
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
    // Order mirrors ProductSort COLOR_ORDER (K → C → M → Y → CMY → KCMY → specialty).
    // Single source of truth — admin dropdowns and the dropdown contract test
    // both bind to this list. Extending it requires no admin/UI change.
    //
    // Tri-Colour vs CMY: 'CMY' is a 3-Pack of three *separate* cartridges
    // (rank 20 in ProductSort). 'Tri-Colour' is a SINGLE cartridge that
    // holds all three inks in one body (HP 22, HP 67 Tri-Colour, Canon
    // CL-541, etc.) and sits at rank 11 alongside other specialty singles.
    // The two are deliberately distinct dropdown entries — they have
    // different prices, different print yields, and different fitments.
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
        { value: 'Tri-Colour',    label: 'Tri-Colour (single cartridge with C/M/Y)' },
        { value: 'Photo',         label: 'Photo' },
        { value: 'Red',           label: 'Red' },
        { value: 'Blue',          label: 'Blue' },
        { value: 'Green',         label: 'Green' },
        { value: 'Gray',          label: 'Gray' },
        { value: 'Light Gray',    label: 'Light Gray' },
        { value: 'White',         label: 'White' },
        { value: 'Clear',         label: 'Clear' },
        { value: 'Black/Red',     label: 'Black/Red' },
        { value: 'Value Pack',    label: 'Value Pack' },
        { value: 'Multipack',     label: 'Multipack' }
    ]
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
        'light cyan':          6,
        'lc':                  6,
        'photo cyan':          6.5,
        'pc':                  6.5,
        'light magenta':       7,
        'lm':                  7,
        'photo magenta':       7.5,
        'pm':                  7.5,
        'vivid light magenta': 8,
        'vlm':                 8,
        'grey':                9,
        'gray':                9,
        'light grey':          9.3,
        'light gray':          9.3,
        'photo grey':          9.6,
        'photo gray':          9.6,
        'violet':             10,
        'tri-colour':         11,
        'tri-color':          11,
        'tricolour':          11,
        'tricolor':           11,
        'colour':             11,   // single tri-colour cartridge label
        'color':              11,
        'red':                12,
        'r':                  12,
        'blue':               13,
        'b':                  13,
        'green':              14,
        'g':                  14,
        'orange':             15,
        'o':                  15,
        'white':              16,
        'w':                  16,
        'black/red':          17,
        'black and red':      17,

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
        // PRIMARY: the backend signal yield_tier: 'STD'|'XL'|'XXL' (from
        // detectYieldTier()). When present it always wins — but as of Jun 2026
        // the live API does NOT emit it on any list endpoint (confirmed null on
        // /api/search/smart, /api/products, /api/shop), so the detector below is
        // doing the real work today. Keep this branch first so the field takes
        // over automatically once the backend ships it.
        const yt = (product && product.yield_tier || '').toString().toUpperCase();
        if (yt === 'XXL') return 2;
        if (yt === 'XL')  return 1;
        if (yt === 'STD') return 0;

        // ---- FE detection (mirror of backend detectYieldTier) ----
        // The old fallback only read XL/XXL/HY as whole words, so it silently
        // missed digit-glued high-yield ("200HY", "220HYBK": no \b between 0 and
        // HY) and HP short-series letters ("975X"), merging two model codes onto
        // one row. We now read the name + sku, using `color` as a guard so a
        // trailing colour Y ("220Y" Yellow) is never mistaken for a yield marker.
        const n = (product && product.name || '').toLowerCase();
        const sku = (product && product.sku || '').toUpperCase();
        // XXL / super-high-yield.
        if (n.includes('xxl') || n.includes('super high')
            || /\bxll\b/.test(n) || /\bshy\b/.test(n) || /\d{2,}xxhy/i.test(n)) return 2;
        // XL / high-yield, incl. digit-glued HY/EHY ("200HY", "220HYBK"),
        // digit-glued single H ("220H", "CART069H"), and HP short-series X
        // ("975X"). None of these match a bare trailing colour Y.
        if (n.includes('xl') || n.includes('high yield') || /\bhy\b/.test(n)
            || /\d{2,}e?hy/i.test(n) || /\d{2,}h\b/i.test(n) || /\b\d{3,}x\b/i.test(n)) return 1;
        if (/CART\d{3,}H(?=[A-Z]|-|$)/.test(sku) || /\d{2,}E?HY/.test(sku)) return 1;
        // NOTE (stopgap limit): HP short-series Y → XXL and Lexmark bare-letter
        // yields (503H/808S/503U) are intentionally NOT detected here — the
        // trailing-Y/letter cases collide with colour/model data the FE can't
        // disambiguate. Those stay STD until the backend yield_tier ships.
        return 0;
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
                // Strip yield prefix from the chosen base so std/XL/XXL all
                // resolve to the same family even if the backend included
                // them as separate codes.
                let base = codes[0];
                base = base.replace(/^([A-Z]+\d+)(XXL|XL|HY|H)([A-Z]*)$/, '$1$3');
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
        const letterMatches = [...name.matchAll(/\b([A-Z]{1,6})(\d+)([A-Z]{0,8})\b/g)];
        let m;
        if (letterMatches.length > 0) {
            m = letterMatches[letterMatches.length - 1];
        } else {
            const numMatches = [...name.matchAll(/\b()(\d+)([A-Z]{0,8})\b/g)];
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
            suffix = suffix.replace(/(BK|CY|MG|YL|PK|MK|LC|LM|GY|PC|PM)$/, '');
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

    return {
        collapseYieldSuffix,
        hasYieldSuffix,
        collapseList,
        collapseChipList,
        YIELD_SUFFIX_PATTERN: YIELD_SUFFIX
    };
})();

if (typeof window !== 'undefined') window.SeriesCodes = SeriesCodes;

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
        SeriesCodes
    };
}
