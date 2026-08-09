/**
 * Business accounts — the ONE vocabulary for the in-person "upgrade to Business"
 * flow, and the registry that keeps the account id the backend hands back once
 * and never again.
 *
 * ── What this is ────────────────────────────────────────────────────────────
 *
 * The sales team visits a business, and upgrades that customer's existing
 * account to a Business account on the spot — no self-submitted application.
 * `POST /api/admin/business/accounts` (super_admin) does it in one call;
 * `PATCH /api/admin/business/accounts/:id` manages it afterwards. Contract:
 * `readfirst/business-one-click-upgrade-FE-handoff-aug2026.md`; the frontend's
 * verified reply is `business-one-click-upgrade-FE-response-aug2026.md`.
 *
 * Everything here is pure — no DOM, no network — so the rules can be driven
 * directly by `tests/admin-business-upgrade-aug2026.test.js`.
 *
 * ── THE ID PROBLEM, which is the reason half this file exists ───────────────
 *
 * `business_accounts.id` is the value that PATCH needs, that links an invoice to
 * a customer's /business portal, and that nothing else in the system will tell
 * you. Probed against production 2026-08-09:
 *
 *   GET  /api/admin/business/accounts      → 404 (and /api/admin/business-accounts → 404)
 *   POST /api/admin/business/accounts      → 409 "User already has a business account"
 *                                            with NO id in the body
 *   GET  /api/business/status              → status/credit/net30, no id
 *   GET  /api/admin/business-applications  → business_applications.id, not the account's
 *
 * So the 201 response is the ONLY moment this frontend will ever see an account
 * id. `BusinessAccountRegistry` writes it down at exactly that moment. That
 * record is DEVICE-LOCAL and every surface that shows it says so out loud — it
 * is a bridge until the backend ships a read endpoint, not a source of truth,
 * and it must never be presented as the list of business accounts.
 *
 * ── THE FILTER TRAP: absence of a filter is not absence of rows ─────────────
 *
 * `GET /api/admin/business-applications` accepts `user_id=` and `search=` and
 * SILENTLY IGNORES BOTH. Verified: `?user_id=00000000-0000-0000-0000-000000000000`
 * returns the full table, and so does `?search=zzzznotreal`. Only `status=`
 * filters (Joi-validated to pending|approved|rejected; anything else 400s).
 *
 * The obvious pre-flight — "fetch this customer's applications" — would have
 * returned row 1 of the whole table and told the operator that every customer
 * was already a business account under someone else's company name. That is
 * ERR-075 inverted: a bogus filter returns EVERYTHING rather than nothing.
 *
 * Hence `matchApplications()`: matching is done HERE, on `user_id`, against rows
 * the caller fetched without any identity filter. And because a page of rows can
 * only ever prove PRESENCE, a partial read that finds nothing returns `unknown`,
 * never "no application" (see `feedback_fail_soft_must_be_loud`, ERR-063/068/
 * 073/075/076/139/149/150).
 *
 * ── Validation is a mirror, never an authority ─────────────────────────────
 *
 * Every rule below was measured against the live endpoint on 2026-08-09 so the
 * common mistakes cost no round trip. The server re-validates all of it and
 * wins; `describeCreateError()` renders whatever it says.
 */

// ── Server-measured limits (see the response doc for the probe table) ────────

/** `credit_limit` is Net 30 exposure in NZD. Decimals are accepted (250.55 passes). */
export const CREDIT_LIMIT_MIN = 0;
export const CREDIT_LIMIT_MAX = 1000000;

/** `company_name` — required, trimmed server-side ("   " → 400), ≤255. */
export const COMPANY_NAME_MAX = 255;

/** NZBN is exactly 13 digits. The server rejects spaces, so we normalise first. */
export const NZBN_DIGITS = 13;

/** `PATCH …/accounts/:id` — `status` must be one of these. */
export const ACCOUNT_STATUSES = Object.freeze(['active', 'suspended', 'closed']);

/** `GET …/business-applications?status=` — anything else is a 400. */
export const APPLICATION_STATUSES = Object.freeze(['pending', 'approved', 'rejected']);

/**
 * An address is ALL-OR-NOTHING and the handoff does not say so: send
 * `billing_address` at all and address1 + city + postcode all become required
 * (verified — `{address1}` alone 400s naming the other two). `address2` and
 * `region` stay optional. Omitting the object entirely is fine; so is `null`.
 */
export const ADDRESS_REQUIRED = Object.freeze(['address1', 'city', 'postcode']);
export const ADDRESS_OPTIONAL = Object.freeze(['address2', 'region']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Deliberately loose. The server owns email validity; this only catches the
// typo that would otherwise cost a round trip.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const str = (v) => (v == null ? '' : String(v).trim());

/** Digits only — NZBNs get written "9429 0123 45678" and the server rejects that. */
export function normaliseNzbn(value) {
  return str(value).replace(/[\s-]/g, '');
}

/** True for a syntactically plausible auth user id. */
export function isUuid(value) {
  return UUID_RE.test(str(value));
}

/**
 * Build the POST body from raw form fields.
 *
 * @param {object} fields raw (string) form values
 * @returns {{payload: object|null, errors: Array<{field:string,message:string}>, notes: string[]}}
 *   `payload` is null when `errors` is non-empty. `notes` are non-blocking
 *   statements about what was deliberately LEFT OUT — they exist so a dropped
 *   half-typed address is visible rather than silent.
 *
 * EMPTY OPTIONALS ARE OMITTED, NEVER SENT AS "". Joi accepts `''` for nzbn and
 * the emails, but the backend's documented fallbacks ("defaults to the user's
 * auth email") are specified for an ABSENT field. `contact_email: ""` is the one
 * shape that could plausibly resolve to no email at all and earn the documented
 * `400 contact_email is required`. Omission is the shape proven safe.
 */
export function buildUpgradePayload(fields = {}) {
  const errors = [];
  const notes = [];
  const fail = (field, message) => errors.push({ field, message });

  const userId = str(fields.user_id);
  if (!userId) fail('user_id', 'No customer selected.');
  else if (!isUuid(userId)) fail('user_id', 'That customer id is not a valid user id — re-pick the customer.');

  const companyName = str(fields.company_name);
  if (!companyName) fail('company_name', 'Company name is required.');
  else if (companyName.length > COMPANY_NAME_MAX) {
    fail('company_name', `Company name must be ${COMPANY_NAME_MAX} characters or fewer (currently ${companyName.length}).`);
  }

  // `0` is a real, common answer — the right default for a cash/card business —
  // so this is parsed, never truthiness-tested.
  const rawCredit = str(fields.credit_limit);
  let creditLimit = null;
  if (rawCredit === '') {
    fail('credit_limit', 'Enter a credit limit. Use 0 unless Net 30 credit is being granted.');
  } else {
    const n = Number(rawCredit);
    if (!Number.isFinite(n)) {
      fail('credit_limit', 'Credit limit must be a number.');
    } else if (n < CREDIT_LIMIT_MIN || n > CREDIT_LIMIT_MAX) {
      fail('credit_limit', `Credit limit must be between ${CREDIT_LIMIT_MIN} and ${CREDIT_LIMIT_MAX.toLocaleString('en-NZ')}.`);
    } else {
      creditLimit = n;
    }
  }

  const nzbn = normaliseNzbn(fields.nzbn);
  if (nzbn && !new RegExp(`^\\d{${NZBN_DIGITS}}$`).test(nzbn)) {
    fail('nzbn', `NZBN must be ${NZBN_DIGITS} digits (found ${nzbn.length}).`);
  }

  const contactEmail = str(fields.contact_email);
  if (contactEmail && !EMAIL_RE.test(contactEmail)) fail('contact_email', 'Enter a valid contact email address.');
  const apEmail = str(fields.ap_email);
  if (apEmail && !EMAIL_RE.test(apEmail)) fail('ap_email', 'Enter a valid accounts-payable email address.');

  const billing = collectAddress(fields, 'billing_address', notes, 'Billing address');
  const shipping = collectAddress(fields, 'shipping_address', notes, 'Shipping address');

  if (errors.length) return { payload: null, errors, notes };

  const payload = {
    user_id: userId,
    company_name: companyName,
    credit_limit: creditLimit,
    // Always sent explicitly. It defaults to false server-side, but Net 30 is
    // the difference between "can place an order it hasn't paid for" and not —
    // it should be stated, not inferred from an omission.
    net30_approved: fields.net30_approved === true,
  };
  if (nzbn) payload.nzbn = nzbn;
  const contactName = str(fields.contact_name);
  if (contactName) payload.contact_name = contactName;
  if (contactEmail) payload.contact_email = contactEmail;
  if (apEmail) payload.ap_email = apEmail;
  if (billing) payload.billing_address = billing;
  if (shipping) payload.shipping_address = shipping;

  return { payload, errors, notes };
}

/**
 * Gather one address, or nothing at all.
 *
 * Three outcomes, and the middle one is the point:
 *   - every field blank  → omitted, silently (nothing was typed)
 *   - partly filled      → omitted, WITH A NOTE (something was typed and is
 *                          being dropped; a half address sent whole would 400,
 *                          and a half address dropped silently would look saved)
 *   - required trio present → returned
 */
function collectAddress(fields, prefix, notes, label) {
  const get = (key) => str(fields[`${prefix}.${key}`]);
  const required = ADDRESS_REQUIRED.map(get);
  const optional = ADDRESS_OPTIONAL.map(get);

  if (![...required, ...optional].some(Boolean)) return null;

  const missing = ADDRESS_REQUIRED.filter((key) => !get(key));
  if (missing.length) {
    notes.push(`${label} not saved — it needs ${ADDRESS_REQUIRED.join(', ')} and ${missing.join(' + ')} ${missing.length > 1 ? 'are' : 'is'} blank.`);
    return null;
  }

  const out = {};
  ADDRESS_REQUIRED.forEach((key) => { out[key] = get(key); });
  ADDRESS_OPTIONAL.forEach((key) => { const v = get(key); if (v) out[key] = v; });
  return out;
}

/** Build the PATCH body. Same discipline; the server rejects an empty object. */
export function buildAccountPatch(fields = {}) {
  const errors = [];
  const patch = {};

  if (fields.credit_limit !== undefined && str(fields.credit_limit) !== '') {
    const n = Number(str(fields.credit_limit));
    if (!Number.isFinite(n)) errors.push({ field: 'credit_limit', message: 'Credit limit must be a number.' });
    else if (n < CREDIT_LIMIT_MIN || n > CREDIT_LIMIT_MAX) {
      errors.push({ field: 'credit_limit', message: `Credit limit must be between ${CREDIT_LIMIT_MIN} and ${CREDIT_LIMIT_MAX.toLocaleString('en-NZ')}.` });
    } else patch.credit_limit = n;
  }
  if (typeof fields.net30_approved === 'boolean') patch.net30_approved = fields.net30_approved;
  if (fields.status !== undefined && str(fields.status) !== '') {
    const s = str(fields.status);
    if (!ACCOUNT_STATUSES.includes(s)) errors.push({ field: 'status', message: `Status must be one of ${ACCOUNT_STATUSES.join(', ')}.` });
    else patch.status = s;
  }

  if (!errors.length && !Object.keys(patch).length) {
    errors.push({ field: '', message: 'Nothing changed.' });
  }
  return { patch: errors.length ? null : patch, errors };
}

// ── Error copy ──────────────────────────────────────────────────────────────

/**
 * Turn a thrown AdminAPI error into operator-facing copy plus field marks.
 *
 * `details[]` entries arrive as `{field, message}` and the field can be:
 *   - "company_name"           a plain field
 *   - "billing_address.city"   a dotted path, which is exactly our input name
 *   - ""                       PATCH with an empty body says `"value" must have
 *                              at least 1 key` against a BLANK field name, so a
 *                              mapper that assumes a name would drop the only
 *                              message there is
 */
export function describeCreateError(err) {
  const code = err && err.code;
  const fields = detailFields(err);

  // POST is CORS-allowed, so unlike PATCH a network failure here is a genuine
  // transport problem — and the dangerous reading is that the request DID reach
  // the backend and only the response was lost. In that case the account exists
  // and its id is already unrecoverable. Retrying is the safe check, not a
  // gamble: a second attempt on an upgraded customer answers 409.
  if (isNetworkFailure(err)) {
    return {
      code: 'NETWORK', fields,
      title: 'No answer from the backend',
      message: 'The upgrade may or may not have gone through — the request failed before a reply arrived. Try again: if it already succeeded you will get "already has a business account", which is the confirmation.',
    };
  }

  if (code === 'CONFLICT') {
    return {
      code, fields,
      title: 'Already a business account',
      message: 'This customer already has a business account. It may be suspended or closed — manage it from the Business page rather than creating a second one.',
    };
  }
  if (code === 'NOT_FOUND') {
    return {
      code, fields,
      title: 'Customer not found',
      message: 'That customer has no profile on the backend, so there is nothing to upgrade. Close this and re-pick the customer.',
    };
  }
  if (code === 'VALIDATION_FAILED') {
    return {
      code, fields,
      title: 'Check the highlighted fields',
      message: fields.length
        ? fields.map((f) => f.message).join(' ')
        : (err && err.message) || 'The backend rejected those details.',
    };
  }
  if (code === 'UNAUTHORIZED' || code === 'FORBIDDEN') {
    return {
      code, fields,
      title: 'Not permitted',
      message: 'Upgrading a customer to a business account requires super_admin.',
    };
  }
  if (code === 'RATE_LIMITED') {
    return {
      code, fields,
      title: 'Too many requests',
      message: 'The admin rate limit is 30 requests a minute. Wait a moment and try again.',
    };
  }
  return {
    code: code || null, fields,
    title: 'Could not upgrade this customer',
    message: (err && err.message) || 'The upgrade did not go through. Nothing was changed.',
  };
}

/**
 * A request the browser never sent, or that died in transit: no HTTP status and
 * no machine code, because there was no response to read one out of. A CORS
 * preflight rejection lands here — Chrome kills the request before dispatch and
 * the only thing JS ever sees is `TypeError: Failed to fetch`.
 */
export function isNetworkFailure(err) {
  return !!err && err.status == null && !err.code;
}

/**
 * Same shape for PATCH, where NOT_FOUND means the ACCOUNT is gone, not the user.
 *
 * 🚨 BF-021 — `PATCH` IS BLOCKED BY CORS, SO THIS ENDPOINT CANNOT BE REACHED
 * FROM A BROWSER AT ALL. Measured 2026-08-09 against the production origin:
 *
 *   Access-Control-Allow-Methods: GET,POST,PUT,DELETE,OPTIONS      ← no PATCH
 *
 * and `PATCH …/business/accounts/:id` is the only verb the route answers (PUT,
 * POST and DELETE all 404), while `X-HTTP-Method-Override` is not in
 * `Access-Control-Allow-Headers`. There is no fallback to write. The invoices
 * PATCH hit this same wall in July (ERR-138) and could at least fall back to a
 * full `PUT /:id`; there is no equivalent here.
 *
 * So the failure is named rather than dressed up. "Failed to fetch" would send
 * an operator hunting their wifi for a one-line server config, and — worse —
 * looks exactly like a timeout, which is the one reading under which a write
 * might have landed. It did not. Nothing was sent.
 */
export function describeUpdateError(err) {
  const code = err && err.code;
  if (isNetworkFailure(err)) {
    return {
      code: 'CORS_BLOCKED', fields: [],
      title: 'Backend blocks this change (BF-021)',
      message: 'The request was never sent: the API does not list PATCH in Access-Control-Allow-Methods, so the browser refuses the preflight. Nothing was changed. This needs a one-line backend fix — until then, credit limit and status can only be changed server-side.',
    };
  }
  if (code === 'NOT_FOUND') {
    return {
      code, fields: detailFields(err),
      title: 'Business account not found',
      message: 'The backend has no business account with that id. If it was recorded on this device it may have been deleted server-side.',
    };
  }
  if (code === 'VALIDATION_FAILED' || code === 'UNAUTHORIZED' || code === 'FORBIDDEN' || code === 'RATE_LIMITED') {
    return describeCreateError(err);
  }
  // Everything else is an UPDATE failing, and must not borrow the create copy —
  // "Could not upgrade this customer" about an account that already exists sends
  // the operator to fix the wrong thing.
  return {
    code: code || null, fields: detailFields(err),
    title: 'Could not update that business account',
    message: (err && err.message) || 'The backend refused that change. Nothing was updated.',
  };
}

function detailFields(err) {
  const details = err && err.details;
  if (!Array.isArray(details)) return [];
  return details
    .map((d) => ({
      field: d && typeof d.field === 'string' ? d.field : '',
      message: (d && (d.message || d.msg)) || String(d),
    }))
    .filter((d) => d.message);
}

// ── Applications: match HERE, because the server will not ───────────────────

/**
 * Work out what a customer's business standing is from a page of applications.
 *
 * @param {Array|null} rows applications fetched with NO identity filter
 * @param {string} userId the customer's auth user id
 * @param {{total?:number}|null} pagination whatever the endpoint reported
 * @returns {{verdict:string, readable:boolean, complete:boolean,
 *            approved:object|null, pending:object|null, rejected:object|null,
 *            total:number|null, seen:number}}
 *
 * verdict is one of:
 *   'business_account'    an approved application exists ⇒ they were upgraded
 *   'pending_application' they applied and it is still in the queue; upgrading
 *                         auto-closes it as superseded (a documented side effect
 *                         worth showing BEFORE the click)
 *   'no_application'      proven — the read covered every row and none matched
 *   'unknown'             the read failed, or covered only part of the table.
 *                         A page of rows can prove PRESENCE; only a complete
 *                         read can prove ABSENCE.
 */
export function matchApplications(rows, userId, pagination) {
  const uid = str(userId);
  const readable = Array.isArray(rows);
  const seen = readable ? rows.length : 0;
  const total = pagination && Number.isFinite(Number(pagination.total)) ? Number(pagination.total) : null;
  const complete = readable && (total == null ? true : seen >= total);

  const empty = {
    verdict: 'unknown', readable, complete, approved: null, pending: null, rejected: null, total, seen,
  };
  if (!readable || !uid) return empty;

  const mine = rows.filter((r) => r && str(r.user_id) === uid);
  const newest = (status) => mine
    .filter((r) => str(r.status).toLowerCase() === status)
    .sort((a, b) => applicationTime(b) - applicationTime(a))[0] || null;

  const approved = newest('approved');
  const pending = newest('pending');
  const rejected = newest('rejected');

  let verdict;
  if (approved) verdict = 'business_account';
  else if (pending) verdict = 'pending_application';
  else if (complete) verdict = 'no_application';
  else verdict = 'unknown';

  return { verdict, readable, complete, approved, pending, rejected, total, seen };
}

function applicationTime(row) {
  const raw = row && (row.reviewed_at || row.submitted_at || row.created_at);
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(t) ? t : 0;
}

// ── The device-local id registry ────────────────────────────────────────────

export const REGISTRY_KEY = 'ink_admin_business_accounts';
const REGISTRY_VERSION = 1;

function storage() {
  try {
    const s = typeof window !== 'undefined' ? window.localStorage : null;
    if (!s) return null;
    return s;
  } catch (e) {
    // Safari private mode / blocked storage throws on ACCESS, not just on write.
    return null;
  }
}

/**
 * Records `business_accounts.id` values this device has seen, because the 201
 * response is the only place they appear.
 *
 * Every read returns `{accounts, readable}`. `readable:false` means "this device
 * could not be asked" and MUST NOT be rendered as "no business account" — the
 * whole point of the tri-state is that a storage failure and an empty registry
 * look identical to a naive caller and mean opposite things.
 */
export const BusinessAccountRegistry = {
  all() {
    const s = storage();
    if (!s) return { accounts: [], readable: false };
    let raw;
    try { raw = s.getItem(REGISTRY_KEY); } catch (e) { return { accounts: [], readable: false }; }
    if (raw == null) return { accounts: [], readable: true };   // genuinely empty
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { return { accounts: [], readable: false }; }
    const list = parsed && Array.isArray(parsed.accounts) ? parsed.accounts : null;
    if (!list) return { accounts: [], readable: false };        // corrupt ≠ empty
    return { accounts: list.filter((a) => a && a.business_account_id), readable: true };
  },

  /** The most recently recorded account for a customer, or null. */
  forUser(userId) {
    const { accounts, readable } = this.all();
    const uid = str(userId);
    const account = accounts
      .filter((a) => str(a.user_id) === uid)
      .sort((a, b) => Date.parse(b.recorded_at || 0) - Date.parse(a.recorded_at || 0))[0] || null;
    return { account, readable };
  },

  get(businessAccountId) {
    const { accounts, readable } = this.all();
    const id = str(businessAccountId);
    return { account: accounts.find((a) => str(a.business_account_id) === id) || null, readable };
  },

  /** Write one down. Returns `{ok}` — a failed write is reported, never swallowed. */
  record(entry, nowIso) {
    const s = storage();
    if (!s || !entry || !entry.business_account_id) return { ok: false };
    const { accounts } = this.all();
    const id = str(entry.business_account_id);
    const next = accounts.filter((a) => str(a.business_account_id) !== id);
    next.push({
      business_account_id: id,
      user_id: str(entry.user_id) || null,
      application_id: str(entry.application_id) || null,
      company_name: str(entry.company_name) || null,
      contact_email: str(entry.contact_email) || null,
      credit_limit: Number.isFinite(Number(entry.credit_limit)) ? Number(entry.credit_limit) : null,
      net30_approved: entry.net30_approved === true,
      status: str(entry.status) || 'active',
      recorded_at: nowIso || new Date().toISOString(),
      recorded_by: str(entry.recorded_by) || null,
    });
    return this._write(s, next);
  },

  /** Mirror a successful PATCH so the local card stops disagreeing with the server. */
  update(businessAccountId, patch) {
    const s = storage();
    if (!s) return { ok: false };
    const { accounts, readable } = this.all();
    if (!readable) return { ok: false };
    const id = str(businessAccountId);
    let found = false;
    const next = accounts.map((a) => {
      if (str(a.business_account_id) !== id) return a;
      found = true;
      const merged = { ...a };
      if (patch && patch.credit_limit !== undefined) merged.credit_limit = Number(patch.credit_limit);
      if (patch && patch.net30_approved !== undefined) merged.net30_approved = patch.net30_approved === true;
      if (patch && patch.status !== undefined) merged.status = str(patch.status);
      return merged;
    });
    if (!found) return { ok: false };
    return this._write(s, next);
  },

  forget(businessAccountId) {
    const s = storage();
    if (!s) return { ok: false };
    const { accounts, readable } = this.all();
    if (!readable) return { ok: false };
    const id = str(businessAccountId);
    return this._write(s, accounts.filter((a) => str(a.business_account_id) !== id));
  },

  _write(s, accounts) {
    try {
      s.setItem(REGISTRY_KEY, JSON.stringify({ version: REGISTRY_VERSION, accounts }));
      return { ok: true };
    } catch (e) {
      return { ok: false };
    }
  },
};
