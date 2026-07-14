/**
 * Product-type vocabulary — the single source of truth for the admin's
 * "All Types" filter.
 *
 * Two pages ship that dropdown (pages/products.js and pages/pending-changes.js)
 * and until Jul 2026 each hand-maintained its own copy of the <option> list.
 * They drifted: both offered `drum` and `paper`, which are /shop CATEGORY slugs,
 * not `product_type` values — the columns say `drum_unit` (182 products) and
 * `photo_paper` (74). Neither option had ever matched a single row. A filter
 * value that isn't a real product_type doesn't error, it just silently returns
 * nothing, so the bug was invisible. Hence one list, imported by both.
 *
 * A value in this module is one of exactly two things:
 *   - a real `product_type` column value  → applied as `.eq('product_type', v)`
 *   - a TYPE_FILTER_GROUPS key            → applied as `.in('product_type', […])`
 * Nothing else is allowed; tests/admin-ribbon-type-filter.test.js enforces it.
 */

/** Every real `product_type`, with the label the admin shows for it. */
export const PRODUCT_TYPE_LABELS = {
  ink_cartridge: 'Ink Cartridges', ink_bottle: 'Ink Bottles', toner_cartridge: 'Toner Cartridges',
  drum_unit: 'Drum Units', waste_toner: 'Waste Toner', belt_unit: 'Belt Units',
  fuser_kit: 'Fuser Kits', maintenance_kit: 'Maintenance Kits', fax_film: 'Fax Film',
  fax_film_refill: 'Fax Film Refills', printer_ribbon: 'Printer Ribbons',
  typewriter_ribbon: 'Typewriter Ribbons', correction_tape: 'Correction Tape',
  label_tape: 'Label Tape', photo_paper: 'Photo Paper', printer: 'Printers',
};

/**
 * The ribbon family: printer ribbons (82), typewriter ribbons (22) and
 * correction tape (6). Same membership as the /shop "ribbons" category and as
 * API._CATEGORY_PRODUCT_TYPES.ribbons — the three surfaces must agree.
 *
 * Also gates the product drawer's "Ribbon Brands" section: ribbon-family
 * products link to the ribbon_brands catalogue via product_ribbon_brands.
 */
export const RIBBON_PRODUCT_TYPES = ['printer_ribbon', 'typewriter_ribbon', 'correction_tape'];

/**
 * Filter values that stand for a GROUP of product_types rather than one.
 *
 * "All Ribbons" used to hang off the SOURCE dropdown as a fake source value
 * ("ribbon"), which conflated two axes — source is genuine/compatible/
 * remanufactured, ribbon-ness is a product_type. It lives here now. Keys must
 * never collide with a real product_type.
 */
export const TYPE_FILTER_GROUPS = { ribbons: RIBBON_PRODUCT_TYPES };

/** The product_type[] a filter value expands to, or null when it names a single type. */
export function typeFilterGroup(value) {
  return TYPE_FILTER_GROUPS[value] || null;
}

/** True if `type` (a product's own product_type) is matched by filter value `value`. */
export function matchesTypeFilter(value, type) {
  if (!value) return true;
  const group = typeFilterGroup(value);
  return group ? group.includes(type) : type === value;
}

/**
 * The "All Types" menu, in display order. Printers are excluded — they have
 * their own tab. The em-dashed entries sit under "All Ribbons" to read as its
 * members.
 */
export const TYPE_FILTER_OPTIONS = [
  { value: '', label: 'All Types' },
  { value: 'ink_cartridge', label: 'Ink Cartridge' },
  { value: 'ink_bottle', label: 'Ink Bottle' },
  { value: 'toner_cartridge', label: 'Toner' },
  { value: 'ribbons', label: 'All Ribbons' },
  { value: 'printer_ribbon', label: '— Printer Ribbon' },
  { value: 'typewriter_ribbon', label: '— Typewriter Ribbon' },
  { value: 'correction_tape', label: '— Correction Tape' },
  { value: 'drum_unit', label: 'Drum' },
  { value: 'belt_unit', label: 'Belt Unit' },
  { value: 'fuser_kit', label: 'Fuser Kit' },
  { value: 'waste_toner', label: 'Waste Toner' },
  { value: 'maintenance_kit', label: 'Maintenance Kit' },
  { value: 'fax_film', label: 'Fax Film' },
  { value: 'fax_film_refill', label: 'Fax Film Refill' },
  { value: 'label_tape', label: 'Label Tape' },
  { value: 'photo_paper', label: 'Paper' },
];

/**
 * <option> markup for a type <select>, marking `current` selected. Values and
 * labels are module literals, so there is nothing to escape.
 */
export function typeFilterOptions(current = '') {
  return TYPE_FILTER_OPTIONS
    .map(o => `<option value="${o.value}"${o.value === current ? ' selected' : ''}>${o.label}</option>`)
    .join('');
}
