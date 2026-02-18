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
        console.error('Error reading from localStorage:', e);
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
        console.error('Error writing to localStorage:', e);
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


// Export for module use (if needed in future)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        $, $$, on,
        getStorage, setStorage,
        debounce
    };
}
