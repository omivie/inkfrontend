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
            'photo black', 'matte black', 'light cyan', 'light magenta',
            'light gray', 'light grey', 'black', 'cyan', 'magenta',
            'yellow', 'red', 'blue', 'green', 'gray', 'grey'
        ];
        for (const color of colorWords) {
            if (lowerName.includes(color)) {
                return color;
            }
        }

        return null;
    }
};

// Make ProductColors available globally
window.ProductColors = ProductColors;


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
 * Build the canonical printer-page URL.
 *
 * Spec contract (docs: search-dropdown-routing.md, May 2026):
 *   `/shop?brand=<brand_slug>&printer_slug=<slug>`
 *
 * The bot-prerender middleware only rewrites to the SEO prerender API when
 * BOTH `brand` and `printer_slug` are present. Anything else (e.g. legacy
 * `?printer=<slug>`) gets the empty SPA shell from Googlebot, breaks the
 * sitemap canonical, and creates duplicate-content for the printer page.
 *
 * The spec is explicit: prefer hiding the drill-in row over rendering a
 * partial URL. Callers that get `null` back must hide the affordance, not
 * fall back to a non-canonical shape.
 *
 * The unbranded `/shop?printer_slug=<slug>` form is permitted only as a
 * documented last resort (e.g. an older deploy without `brand_slug`),
 * surfaced via `buildPrinterUrl(p, { allowUnbranded: true })`.
 *
 * @param {Object|null} printer - Printer-shaped object: { slug, brand_slug?, brand?: { slug } }
 * @param {{ allowUnbranded?: boolean }} [opts]
 * @returns {string|null} Canonical URL or null when required fields are missing.
 */
function buildPrinterUrl(printer, opts) {
    if (!printer || typeof printer !== 'object') return null;
    const slug = printer.slug || printer.printer_slug || '';
    if (!slug) return null;
    // Accept either flat (matched_printer shape) or nested (search-printers shape).
    const brandSlug = printer.brand_slug
        || (printer.brand && (typeof printer.brand === 'object' ? printer.brand.slug : null))
        || '';
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
window.DebugLog = DebugLog;


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
 * Shared KCMY color/yield ordering + product-family grouping.
 * Used by shop-page.js and search.js so the two can never drift.
 *
 * Color order mirrors the product-page convention:
 *   K (Black / Photo / Matte) → C / LC → M / LM → Y → R/B/G → grays → multipacks (CMY, KCMY, CMYK).
 */
const ProductSort = (function() {
    const COLOR_ORDER = [
        'black', 'photo black', 'matte black',
        'cyan', 'light cyan',
        'magenta', 'light magenta',
        'yellow',
        'red', 'blue', 'green',
        'gray', 'grey', 'light gray', 'light grey',
        'cmy', 'kcmy', 'cmyk', 'bcmy'
    ];

    function yieldTier(product) {
        const n = (product.name || '').toLowerCase();
        if (n.includes('xxl') || n.includes('super high')) return 2;
        if (n.includes('xl') || n.includes('high yield') || /\bhy\b/.test(n)) return 1;
        const sku = (product.sku || '').toUpperCase();
        if (/CART\d{3,}H(?=[A-Z]|-|$)/.test(sku)) return 1;
        return 0;
    }

    function colorIndex(product) {
        const i = COLOR_ORDER.indexOf((product.color || '').toLowerCase());
        return i === -1 ? 999 : i;
    }

    // Source tier: genuine first, then compatible, then anything else.
    function sourceTier(product) {
        const s = (product.source || '').toString().toLowerCase();
        if (s === 'genuine') return 0;
        if (s === 'compatible') return 1;
        return 2;
    }

    function compareByYieldAndColor(a, b) {
        // Within a family, group by source (genuine → compatible),
        // then by yield tier (std → HY → XXL), then by KCMY color order.
        const sa = sourceTier(a);
        const sb = sourceTier(b);
        if (sa !== sb) return sa - sb;
        const ya = yieldTier(a);
        const yb = yieldTier(b);
        if (ya !== yb) return ya - yb;
        return colorIndex(a) - colorIndex(b);
    }

    // Extract a brand + base product code as the family key.
    // Handles real backend SKUs like `G-CAN-CART069HK-TNR-BK`, `GEN-PACK-CAN-CART069-CMY`,
    // `G-DYM-S0720690-LBL-BK`, `G-EPS-S41069-PPR`, etc. — these don't parse cleanly from
    // SKU suffixes, so we extract from the name which always contains the product code.
    //
    // e.g. "Canon Genuine CART069HK Toner Cartridge Black"  → B:CANON:CART069
    //      "Canon Genuine CART069 Value Pack CMY 3-Pack"    → B:CANON:CART069
    //      "Canon Genuine CART069H Value Pack KCMY 4-Pack"  → B:CANON:CART069
    function familyKey(product) {
        const name = (product.name || '').toUpperCase();
        const brand = (product.brand?.name || product.brand || '')
            .toString().toUpperCase().replace(/\s+/g, '');

        // First token shaped like a product code: letters + digits + optional trailing letters.
        // Matches CART069, CART069HK, CART069H, S0720690, S41069, CT351069, PG-40, etc.
        const m = name.match(/\b([A-Z]{1,6})(\d{2,})([A-Z]{0,3})\b/);
        let base;
        if (m) {
            const prefix = m[1];
            const digits = m[2];
            let suffix = m[3] || '';
            // Reduce suffix: strip color letter(s), then yield marker H/HY
            suffix = suffix.replace(/(BK|CY|MG|YL|PK|MK|LC|LM|GY)$/, '');
            suffix = suffix.replace(/(K|C|M|Y|R|G|B)$/, '');
            suffix = suffix.replace(/(HY|H)$/, '');
            base = prefix + digits + suffix;
        } else {
            // Fallback: color-stripped name
            base = name.toLowerCase()
                .replace(/\b(photo black|matte black|light cyan|light magenta|tri[- ]?colou?r|black|cyan|magenta|yellow|red|blue|green|gray|grey|cmyk|kcmy|bcmy|cmy|value pack|\d+[- ]?pack)\b/gi, '')
                .replace(/\s+/g, ' ')
                .trim();
        }
        return (brand ? 'B:' + brand + ':' : '') + base;
    }

    // Sort in place: yield tier → color order. Returns the same array.
    function byYieldAndColor(products) {
        return products.sort(compareByYieldAndColor);
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
        COLOR_ORDER,
        yieldTier,
        sourceTier,
        colorIndex,
        compareByYieldAndColor,
        familyKey,
        byYieldAndColor,
        groupByFamilyScored
    };
})();

// Export for module use (if needed in future)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        $, $$, on,
        getStorage, setStorage,
        debounce,
        storageUrl,
        esc, escAttr,
        buildPrinterUrl
    };
}
