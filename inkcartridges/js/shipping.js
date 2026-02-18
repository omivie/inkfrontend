/**
 * SHIPPING.JS
 * ===========
 * NZ shipping calculation module for InkCartridges.co.nz
 *
 * DISPLAY ONLY — All calculations here are estimates for UI display.
 * Backend is the source of truth for actual shipping costs.
 * The PaymentIntent amount is always set server-side.
 *
 * Zone-based pricing (NZD):
 *   Auckland:      Standard $7.95  | Heavy $11.95  | 1–2 business days
 *   North Island:  Standard $9.95  | Heavy $13.95  | 1–3 business days
 *   South Island:  Standard $13.95 | Heavy $17.95  | 2–4 business days
 *   FREE on all orders $100+ NZD
 *
 * Heavy = drum unit in cart, or toner qty >= 3 (+$4.00 surcharge)
 */

'use strict';

const Shipping = {
    // Free shipping threshold
    FREE_THRESHOLD: 100,

    // Heavy item surcharge
    HEAVY_SURCHARGE: 4.00,

    // Heavy toner quantity threshold
    HEAVY_TONER_QTY: 3,

    // Default zone when region is unknown (e.g. cart page before checkout)
    DEFAULT_ZONE: 'north-island',

    // Zone-based fees (DISPLAY ONLY — backend overrides these)
    FEES: {
        'auckland':     { standard: 7.95,  heavy: 11.95 },
        'north-island': { standard: 9.95,  heavy: 13.95 },
        'south-island': { standard: 13.95, heavy: 17.95 }
    },

    // Zone display names
    ZONE_LABELS: {
        'auckland': 'Auckland',
        'north-island': 'North Island',
        'south-island': 'South Island'
    },

    // Region → delivery zone mapping
    ZONES: {
        'auckland': 'auckland',
        'northland': 'north-island',
        'waikato': 'north-island',
        'bay-of-plenty': 'north-island',
        'gisborne': 'north-island',
        'hawkes-bay': 'north-island',
        'taranaki': 'north-island',
        'manawatu-wanganui': 'north-island',
        'wellington': 'north-island',
        'tasman': 'south-island',
        'nelson': 'south-island',
        'marlborough': 'south-island',
        'west-coast': 'south-island',
        'canterbury': 'south-island',
        'otago': 'south-island',
        'southland': 'south-island'
    },

    // Estimated delivery times per zone
    ETA: {
        'auckland': '1\u20132 business days',
        'north-island': '1\u20133 business days',
        'south-island': '2\u20134 business days'
    },

    /**
     * Get the delivery zone for a region
     * @param {string} region - Region value from checkout form (e.g. 'auckland', 'canterbury')
     * @returns {string|null} Zone key or null if unknown
     */
    getZone(region) {
        if (!region) return null;
        return this.ZONES[region.toLowerCase()] || null;
    },

    /**
     * Get display label for a zone
     * @param {string} zone - Zone key
     * @returns {string} Zone label (e.g. "Auckland", "South Island")
     */
    getZoneLabel(zone) {
        return this.ZONE_LABELS[zone] || '';
    },

    /**
     * Get estimated delivery time for a region
     * @param {string} region - Region value from checkout form
     * @returns {string|null} ETA string or null if region unknown
     */
    getETA(region) {
        const zone = this.getZone(region);
        return zone ? this.ETA[zone] : null;
    },

    /**
     * Check if cart contains heavy items
     * Heavy = any drum product, OR total toner quantity >= 3
     * @param {Array} items - Cart items array [{name, quantity, ...}]
     * @returns {{heavy: boolean, reason: string|null}}
     */
    isHeavy(items) {
        if (!items || items.length === 0) return { heavy: false, reason: null };

        // Check for drum products
        const hasDrum = items.some(item => {
            const name = (item.name || '').toLowerCase();
            return name.includes('drum');
        });

        if (hasDrum) {
            return { heavy: true, reason: 'Contains drum unit' };
        }

        // Check toner quantity (>= 3 total toner items)
        let tonerQty = 0;
        items.forEach(item => {
            const name = (item.name || '').toLowerCase();
            if (name.includes('toner')) {
                tonerQty += item.quantity || 1;
            }
        });

        if (tonerQty >= this.HEAVY_TONER_QTY) {
            return { heavy: true, reason: `${tonerQty} toner items` };
        }

        return { heavy: false, reason: null };
    },

    /**
     * Calculate estimated shipping cost (DISPLAY ONLY)
     * @param {Array} items - Cart items array
     * @param {number} subtotal - Cart subtotal in NZD
     * @param {string} [region] - Region value (optional — defaults to north-island zone)
     * @returns {{fee: number, tier: string, zone: string, zoneLabel: string, freeShipping: boolean, reason: string}}
     */
    calculate(items, subtotal, region) {
        const threshold = (typeof Config !== 'undefined')
            ? Config.getSetting('FREE_SHIPPING_THRESHOLD', this.FREE_THRESHOLD)
            : this.FREE_THRESHOLD;

        // Resolve zone
        const zone = this.getZone(region) || this.DEFAULT_ZONE;
        const zoneLabel = this.getZoneLabel(zone);
        const zoneFees = this.FEES[zone] || this.FEES[this.DEFAULT_ZONE];

        // Free shipping over threshold
        if (subtotal >= threshold) {
            return {
                fee: 0,
                tier: 'free',
                zone: zone,
                zoneLabel: zoneLabel,
                freeShipping: true,
                reason: `Free shipping on orders over ${this._formatPrice(threshold)}`
            };
        }

        // Check for heavy items
        const heavyCheck = this.isHeavy(items);
        if (heavyCheck.heavy) {
            return {
                fee: zoneFees.heavy,
                tier: 'heavy',
                zone: zone,
                zoneLabel: zoneLabel,
                freeShipping: false,
                reason: heavyCheck.reason
            };
        }

        // Standard shipping
        return {
            fee: zoneFees.standard,
            tier: 'standard',
            zone: zone,
            zoneLabel: zoneLabel,
            freeShipping: false,
            reason: `${zoneLabel} delivery`
        };
    },

    /**
     * Check if order may ship in multiple packages
     * True if items span different product categories (e.g. ink + printer, or drum + ink)
     * @param {Array} items - Cart items array
     * @returns {boolean}
     */
    maySplitShipment(items) {
        if (!items || items.length <= 1) return false;

        const categories = new Set();
        items.forEach(item => {
            const name = (item.name || '').toLowerCase();
            if (name.includes('printer')) categories.add('printer');
            else if (name.includes('drum')) categories.add('drum');
            else if (name.includes('toner')) categories.add('toner');
            else if (name.includes('ink')) categories.add('ink');
            else if (name.includes('paper')) categories.add('paper');
            else categories.add('accessory');
        });

        // Split shipment likely if mixing printers/drums with consumables
        return (categories.has('printer') && categories.size > 1) ||
               (categories.has('drum') && (categories.has('ink') || categories.has('paper')));
    },

    /**
     * Get amount needed to reach free shipping threshold
     * @param {number} subtotal - Current cart subtotal
     * @returns {{needed: number, qualifies: boolean}}
     */
    getSpendMore(subtotal) {
        const threshold = (typeof Config !== 'undefined')
            ? Config.getSetting('FREE_SHIPPING_THRESHOLD', this.FREE_THRESHOLD)
            : this.FREE_THRESHOLD;

        if (subtotal >= threshold) {
            return { needed: 0, qualifies: true };
        }

        return {
            needed: Math.ceil((threshold - subtotal) * 100) / 100,
            qualifies: false
        };
    },

    /**
     * Format price helper (uses global formatPrice if available)
     * @private
     */
    _formatPrice(amount) {
        if (typeof formatPrice === 'function') return formatPrice(amount);
        return '$' + amount.toFixed(2);
    }
};
