/**
 * SHIPPING.JS
 * ===========
 * NZ shipping calculation module for InkCartridges.co.nz
 *
 * DISPLAY ONLY — All calculations here are estimates for UI display.
 * Backend is the source of truth for actual shipping costs.
 * The PaymentIntent amount is always set server-side.
 *
 * Zone-based pricing with urban/rural delivery types (NZD):
 *   Auckland:      Urban $7   | Rural $14
 *   North Island:  Urban $7–$12 (by weight) | Rural $14–$20
 *   South Island:  Urban $7–$22 (by weight) | Rural $14–$30
 *   FREE on all orders $100+ NZD
 *
 * Weight tiers are determined by the backend; the client-side fallback
 * uses the lowest applicable tier (light) since item weights aren't
 * available on the frontend.
 */

'use strict';

const Shipping = {
    // Free shipping threshold
    FREE_THRESHOLD: 100,

    // Default zone when region is unknown (e.g. cart page before checkout)
    DEFAULT_ZONE: 'north-island',

    // Zone-based fees with urban/rural delivery types (DISPLAY ONLY — backend overrides these)
    // Client-side uses lowest weight tier as fallback since we don't have item weights
    FEES: {
        'auckland':     { urban: 7, rural: 14 },
        'north-island': { light_urban: 7, light_rural: 14, standard_urban: 12, standard_rural: 20 },
        'south-island': { light_urban: 7, light_rural: 14, standard_urban: 12, standard_rural: 20, heavy_urban: 22, heavy_rural: 30 }
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
     * Calculate estimated shipping cost (DISPLAY ONLY)
     * Uses lowest applicable weight tier as fallback since item weights aren't available client-side.
     * @param {Array} items - Cart items array
     * @param {number} subtotal - Cart subtotal in NZD
     * @param {string} [region] - Region value (optional — defaults to north-island zone)
     * @param {string} [deliveryType='urban'] - 'urban' or 'rural'
     * @returns {{fee: number, tier: string, zone: string, zoneLabel: string, freeShipping: boolean, reason: string, deliveryType: string}}
     */
    calculate(items, subtotal, region, deliveryType) {
        deliveryType = deliveryType || 'urban';

        const threshold = (typeof Config !== 'undefined')
            ? Config.getSetting('FREE_SHIPPING_THRESHOLD', this.FREE_THRESHOLD)
            : this.FREE_THRESHOLD;

        // Resolve zone
        const zone = this.getZone(region) || this.DEFAULT_ZONE;
        const zoneLabel = this.getZoneLabel(zone);

        // Free shipping over threshold
        if (subtotal >= threshold) {
            return {
                fee: 0,
                tier: 'free',
                zone: zone,
                zoneLabel: zoneLabel,
                freeShipping: true,
                deliveryType: deliveryType,
                reason: `Free shipping on orders over ${this._formatPrice(threshold)}`
            };
        }

        // Try DB-driven rates from Config.settings first, fall back to hardcoded FEES
        let fee;
        const dbTiers = (typeof Config !== 'undefined')
            ? Config.settings?.shipping?.zones?.[zone]?.tiers
            : null;

        if (dbTiers && Array.isArray(dbTiers) && dbTiers.length > 0) {
            // Each tier is { tier, delivery_type, fee, min_weight_kg, max_weight_kg }
            // Filter by delivery_type, then pick the lowest-weight tier (smallest min_weight_kg)
            const matchingTiers = dbTiers
                .filter(t => t.delivery_type === deliveryType)
                .sort((a, b) => (a.min_weight_kg || 0) - (b.min_weight_kg || 0));
            if (matchingTiers.length > 0) {
                fee = matchingTiers[0].fee;
            }
        }

        // Fall back to hardcoded fees if DB rates unavailable or didn't yield a number
        if (fee == null || isNaN(fee)) {
            const zoneFees = this.FEES[zone] || this.FEES[this.DEFAULT_ZONE];
            if (zoneFees.urban !== undefined) {
                // Auckland-style: simple urban/rural
                fee = deliveryType === 'rural' ? zoneFees.rural : zoneFees.urban;
            } else {
                // North/South Island: use standard tier as fallback to show zone differences.
                // Light tier ($7) is the same across all zones — standard ($12) reveals the Auckland advantage.
                // Backend API overrides this with weight-accurate pricing in normal operation.
                fee = deliveryType === 'rural' ? zoneFees.standard_rural : zoneFees.standard_urban;
            }
        }

        const deliveryLabel = deliveryType === 'rural' ? 'Rural' : 'Urban';

        return {
            fee: fee,
            tier: 'standard',
            zone: zone,
            zoneLabel: zoneLabel,
            freeShipping: false,
            deliveryType: deliveryType,
            reason: `${zoneLabel} ${deliveryLabel} delivery`
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

        const getItemCategory = (item) => {
            const pt = (item.product_type || '').toLowerCase();
            if (pt === 'printer') return 'printer';
            if (pt === 'drum_unit' || pt === 'waste_toner' || pt === 'belt_unit' || pt === 'fuser_kit') return 'drum';
            if (pt === 'toner_cartridge') return 'toner';
            if (pt === 'ink_cartridge' || pt === 'ink_bottle') return 'ink';
            if (pt === 'photo_paper') return 'paper';
            if (pt === 'printer_ribbon' || pt === 'typewriter_ribbon' || pt === 'correction_tape') return 'ribbon';
            const name = (item.name || '').toLowerCase();
            if (name.includes('printer')) return 'printer';
            if (name.includes('drum')) return 'drum';
            if (name.includes('toner')) return 'toner';
            if (name.includes('ink')) return 'ink';
            if (name.includes('paper')) return 'paper';
            return 'accessory';
        };
        const categories = new Set();
        items.forEach(item => categories.add(getItemCategory(item)));

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
