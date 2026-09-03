/**
 * Party search — the ONE lookup behind every "who is this invoice for?" picker.
 *
 * Two admin surfaces ask the same question: the Invoices editor's
 * "Fill details from…" box and Quick Order's party box. They used to carry
 * byte-identical copies of the fetch, which is how they also carried an
 * identical blind spot for four months.
 *
 * ── THE THREE SOURCES, and why the third one was missing ────────────────────
 *
 * A customer can exist in exactly three places, and a picker that reads two of
 * them reports "No matches" for a real, paying human:
 *
 *   1. `contacts`   — manually-entered billing parties (address book, ~9.4k rows)
 *   2. `customers`  — registered accounts (`user_profiles`, ~33 rows)
 *   3. `orders`     — EVERY website checkout, including GUESTS (`user_id: null`)
 *
 * Order 20260819000002 (Michael Wright, a guest) is in (3) only: no account row,
 * no contact row. Searching (1)+(2) for him is not "not found", it is "not
 * looked". Orders are now a first-class source here, and picking one fills the
 * bill-to DETAILS ONLY — no line items, no freight. Importing the goods is what
 * the separate "Existing order" picker is for.
 *
 * ── ENVELOPE SHAPES ARE NOT UNIFORM. MEASURED, NOT ASSUMED ──────────────────
 *
 *   GET /api/admin/orders     → { ok, data: [ …rows… ] }   ← data is a BARE ARRAY
 *   GET /api/admin/customers  → { ok, data: { customers: [ … ] } }
 *   GET /api/admin/contacts   → { ok, data: { contacts: [ … ], pagination } }
 *
 * `AdminAPI.getOrders` hands back `resp.data`, so for orders that IS the array.
 * The invoice order picker read `data?.orders || data?.items || []` from it and
 * therefore returned `[]` for every query ever typed — a valid order number
 * included. Every other caller in the repo already normalises
 * (orders.js, refunds.js, customers.js, dashboard's firstArray); these
 * normalisers exist so there is one place to be right about it. ERR-176.
 *
 * ── MULTI-WORD NAMES ────────────────────────────────────────────────────────
 *
 * Measured 2026-08-28: `customers?search=Mark Leask` → 0 rows, `search=Mark` → 1.
 * First and last name are separate columns there, so a full name — the most
 * natural thing to type — can never match. Contacts (label) and Orders
 * (customer_name) both match multi-word server-side, so ONLY customers is
 * widened: retry on the longest token, then keep the rows that carry every
 * token. Widening a search can only add rows a stricter query would have shown;
 * it never hides one.
 *
 * Pure except for the injected `api` — no DOM, no module state — so
 * tests/admin-invoice-party-picker-aug2026.test.js drives it with stubs.
 */

import { foldFilterPunct } from './pgrst.js';

/** Rows out of any envelope this backend has ever used. See the shape note above. */
export function ordersFrom(data) {
  if (Array.isArray(data)) return data;
  return data?.orders || data?.data || data?.items || [];
}

export function contactsFrom(data) {
  if (Array.isArray(data)) return data;
  return data?.contacts || data?.data || data?.items || [];
}

export function customersFrom(data) {
  if (Array.isArray(data)) return data;
  return data?.customers || data?.data || data?.items || [];
}

/** The customer display name, with the same fallback chain both pickers render. */
export function customerName(c) {
  const o = c || {};
  return String(o.full_name || `${o.first_name || ''} ${o.last_name || ''}`.trim() || '');
}

/**
 * The operator's query, split into comparable tokens.
 *
 * `, ( )` are folded to whitespace FIRST (ERR-202). The remote leg of this
 * search cannot see them — the backend's Sep-2026 escaper strips them, and our
 * own PostgREST calls quote them — so a local half that kept them was holding
 * the returned rows to a stricter standard than the query that fetched them.
 * Typing "Walker, Vieland" produced the token "walker," and then discarded a
 * stored "Vieland Walker", i.e. the picker reported a customer it had just been
 * handed as "no match". Both halves fold identically or the widening below
 * stops being the pure widening its header promises.
 */
export function queryTokens(q) {
  return foldFilterPunct(q).toLowerCase().split(/\s+/).filter(Boolean);
}

export function matchesAllTokens(haystack, tokens) {
  const hay = foldFilterPunct(haystack).toLowerCase();
  return tokens.length > 0 && tokens.every((t) => hay.includes(t));
}

/**
 * An order → the bill-to fields of an invoice/quick-order draft.
 *
 * Live rows carry the address as FLAT columns (`shipping_address_line1`, …) and
 * a guest's contact details in `guest_email` / `guest_phone` — there is no
 * `user` object and `email` is null on a guest row. Older/enriched rows carry a
 * `shipping_address` object instead. Both are handled; drop neither.
 */
export function orderToParty(order) {
  const o = order || {};
  const addr = o.shipping_address || {};
  const name = o.customer_name || o.shipping_recipient_name || addr.recipient_name || o.user?.full_name || '';
  const address = [
    addr.address_line1 || o.shipping_address_line1,
    addr.address_line2 || o.shipping_address_line2,
    [(addr.city || o.shipping_city || ''), (addr.region || o.shipping_region || ''), (addr.postal_code || o.shipping_postal_code || '')].filter(Boolean).join(', '),
    addr.country || o.shipping_country || '',
  ].filter(Boolean).join('\n');
  return {
    attn: name,
    name,
    company: '',
    address,
    phone: addr.phone || o.shipping_phone || o.guest_phone || o.user?.phone || '',
    email: o.customer_email || o.guest_email || o.email || o.user?.email || '',
    orderNumber: o.order_number || o.id || '',
    orderDate: String(o.created_at || o.placed_at || '').slice(0, 10),
  };
}

/**
 * Search all three sources at once.
 *
 * Returns `{ sections, failed }`. `failed` names the sources that could not be
 * asked (AdminAPI reads are fail-soft and hand back `null`), because "nothing
 * found" and "could not look" are different answers and the empty state has to
 * say which one it is — an absence is only reportable when every source
 * answered.
 */
export async function searchParties(q, api, { limit = 6 } = {}) {
  const query = String(q || '').trim();
  const [ctsRaw, cusRaw, ordRaw] = await Promise.all([
    api.listContacts({ search: query }, 1, limit),
    api.getCustomers({ search: query }, 1, limit),
    api.getOrders({ search: query }, 1, limit),
  ]);

  const failed = [];
  if (ctsRaw == null) failed.push('Contacts');
  if (cusRaw == null) failed.push('Customers');
  if (ordRaw == null) failed.push('Orders');

  const contacts = contactsFrom(ctsRaw).map((x) => ({ ...x, __type: 'contact' }));
  let customers = customersFrom(cusRaw).map((x) => ({ ...x, __type: 'customer' }));
  const orders = ordersFrom(ordRaw).map((x) => ({ ...x, __type: 'order' }));

  // Full-name widening — customers only. See the header note.
  const tokens = queryTokens(query);
  if (!customers.length && tokens.length > 1 && cusRaw != null) {
    const longest = tokens.slice().sort((a, b) => b.length - a.length)[0];
    const wideRaw = await api.getCustomers({ search: longest }, 1, Math.max(limit * 2, 12));
    if (wideRaw == null) failed.push('Customers');
    customers = customersFrom(wideRaw)
      .filter((c) => matchesAllTokens(`${customerName(c)} ${c.email || ''}`, tokens))
      .slice(0, limit)
      .map((x) => ({ ...x, __type: 'customer' }));
  }

  const sections = [];
  if (contacts.length) sections.push({ title: 'Contacts', items: contacts });
  if (customers.length) sections.push({ title: 'Customers', items: customers });
  if (orders.length) sections.push({ title: 'Orders (incl. guest checkouts)', items: orders });
  return { sections, failed };
}

/**
 * The party picker's empty state. It names all three sources, so an empty
 * dropdown reads as "searched and absent" rather than "wasn't looked for" — and
 * when a source could not be reached it says so instead of claiming a miss.
 */
export function partyEmptyText(q, failed = []) {
  if (failed.length) {
    return `Couldn’t search ${[...new Set(failed)].join(' and ')} — this is not a “no match”, it’s an unanswered search.`;
  }
  return 'No contact, customer or order matches that.';
}

/**
 * The "Existing order" picker's empty state. An email-shaped query is a
 * guaranteed miss: AdminAPI.getOrders routes anything with an '@' to
 * `customer_email=`, and that param returns 0 rows for every real address
 * (measured — BF-046). The request still goes out unchanged, so if the backend
 * ever learns to match an address this message is the only thing to remove.
 */
export function orderEmptyText(q, failed = false) {
  if (failed) return 'Couldn’t search orders — this is not a “no match”, it’s an unanswered search.';
  if (String(q || '').includes('@')) {
    return 'Order search can’t match email addresses — try the customer’s name or the order #.';
  }
  return 'No orders match that.';
}
