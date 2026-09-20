/**
 * The admin "Compatible Devices / For Use In" panel — ERR-244, then ERR-272.
 * ==========================================================================
 *
 * WHAT CHANGED, AND WHY THIS FILE EXISTS
 *
 * Until 2026-09-10 this panel was a rich-text editor bound to
 * `products.compatible_devices_html`: it read that column straight off
 * PostgREST and wrote it back on Save. Backend migration 132 DROPPED the
 * column. The list now lives in `product_compat_devices` (RLS on, service-role
 * only), readable through `GET /api/products/:sku/for-use-in`.
 *
 * For ten days after that the two halves of this panel were not symmetrical,
 * and this file existed to say so honestly: READ worked, WRITE did not exist,
 * and the product PUT answered 200 for the field while discarding it. So the
 * panel was read-only, and it named the missing route (BF-062) rather than
 * saying "coming soon" — ERR-131 spent a month invisible behind that sentence.
 *
 * 🚨 2026-09-20: THE WRITE ROUTE EXISTS, AND IT ALWAYS DID.
 *
 * The backend's reply to BF-062 (`inbox/fe-open-asks-backend-response-sep2026.md`)
 * says `PUT /api/admin/products/:productId` has accepted `compatible_devices_html`
 * and written it to `product_compat_devices` since 6 Aug 2026 — that the route
 * we measured as discarding it was `by-sku/:sku`, whose Joi schema declared
 * three fields while `stripUnknown: true` deleted the other twenty-seven.
 *
 * We did not take their word for it, and we did not take our own. `npm run
 * probe:product-write -- --write` creates a throwaway product, writes, and asks
 * an INDEPENDENT reader whether the write landed. Measured 2026-09-20, 21/0:
 *
 *   PUT /api/admin/products/:id  { compatible_devices_html }  → 200
 *     → GET /api/admin/products/:id        HAS the new list
 *     → omitting the key on a later PUT    LEAVES it alone
 *     → compatible_devices_html: ""        CLEARS it
 *     → an unknown key, and `for_use_in_html`, are still accepted and DISCARDED
 *
 * ***AN ECHO IS NOT A MEASUREMENT — AND THE ECHO ISN'T THERE ANYWAY.*** Their
 * reply proposes that the route echo the field back so a caller can tell a real
 * write from a silent strip. Two things. It cannot: a route that strips the
 * field can still hand back the string it was given, which is precisely how
 * every decoy in this codebase has worked (ERR-151). And measured, the echo is
 * absent — a `compatible_devices_html` key does not come back at all. Anything
 * built on it would read every good write as a strip.
 *
 * So `writeForUseIn` below PUTs and then RE-READS, and the re-read is the
 * verdict. Which is possible because of the second correction:
 *
 * ***THEIR REPLY IS WRONG THAT A RE-FETCH CANNOT CARRY THE LIST.*** It says the
 * field "is not a `products` column (migration 132 dropped that mirror), so a
 * re-fetch cannot carry it". `GET /api/admin/products/:id` carries it, and on
 * three products holding real lists it was BYTE-IDENTICAL to the public
 * endpoint (123, 183, 232 chars). That route joins `product_compat_devices`.
 * `probe:product-write` §1 keeps that true, read-only, on every run.
 *
 * ── THE SANITISER REWRITES WHAT YOU TYPE, AND THAT IS NOT AN ERROR ─────────
 *
 * Measured: `<br>` comes back as `<br />`. So a byte comparison between what
 * the operator typed and what came back reports a failure on a perfectly good
 * save — this probe's own first run failed three assertions that way, and
 * ERR-243 had already recorded the same transform a fortnight earlier.
 * `normaliseForUseIn()` below names the transforms we have measured and ignores
 * only those. Everything else is still a difference.
 *
 * That is also why a successful save RE-SEEDS the editor from the canonical
 * re-read: the operator's textarea should hold what is stored, not what they
 * typed, or the next reopen looks unsaved.
 *
 * ── WHY A SOURCE TEXTAREA AND NOT A RICH-TEXT EDITOR ───────────────────────
 *
 * `description_html` survives the backend's narrow sanitiser only because
 * `AdminAPI.persistRichTextColumns` re-writes it straight to Supabase afterwards
 * (ERR-034, ERR-244). That repair CANNOT reach this field: `product_compat_devices`
 * is RLS'd to the service role, so whatever their sanitiser does to the machine
 * list is final. A rich-text editor would emit markup into a filter we cannot
 * repair. A source textarea sends exactly what the operator can see, and their
 * allow-list here is deliberately WIDER than for descriptions — `<div>`, `<b>`,
 * `<span>` and `<br>` all survive, because the description sanitiser would strip
 * them and collapse the list into one run-on paragraph.
 *
 * ── THREE STATES ON READ, FOUR ON WRITE ────────────────────────────────────
 *
 * Read (ERR-243, unchanged): `null` used to mean both "this product has no list"
 * and "the read failed". A failed read that paints an empty box tells an
 * operator their content is GONE, and the honest reaction is to retype it.
 *
 *   ok          — the endpoint answered with a non-empty list
 *   none        — the endpoint ANSWERED and said there is no list
 *   unavailable — 429 / 5xx / network / an envelope with no such key
 *
 * `hasOwnProperty` decides, never `?? null`: ABSENT ≠ null (ERR-199), and a 429
 * body carries no `for_use_in_html` key at all (ERR-243, where reading a
 * refusal as an absence nearly sent the backend a data-loss alarm).
 *
 * Write adds a fourth, and it is the one that matters:
 *
 *   saved             — written AND confirmed by a re-read
 *   saved-unverified  — the route accepted it; the re-read could not confirm
 *   list-failed       — the PRODUCT saved and the LIST did not (their §1: that
 *                       case returns 500 with a retry message even though the
 *                       row itself is written — two different sentences, and an
 *                       operator who is told "save failed" will retype a name
 *                       that is already correct)
 *   refused           — the write was rejected outright
 *
 * `saved-unverified` is deliberately NOT folded into `saved`. Absence of
 * confirmation is not confirmation; that conflation is ERR-063/068/073/075/076/
 * 149/150, every one of them.
 */

export const FOR_USE_IN_STATE = Object.freeze({
    OK: 'ok',
    NONE: 'none',
    UNAVAILABLE: 'unavailable',
});

export const FOR_USE_IN_WRITE = Object.freeze({
    SAVED: 'saved',
    SAVED_UNVERIFIED: 'saved-unverified',
    LIST_FAILED: 'list-failed',
    REFUSED: 'refused',
});

/**
 * Is there an admin route that can WRITE the machine list, and which one?
 *
 * A single named constant rather than a scatter of route strings, so every
 * surface reads one answer and a test can assert they agree — ERR-187/192,
 * where one rule grew six copies, one of them in CSS.
 *
 * `by-sku` also works as of 2026-09-20 (probe §6), but by-id is the one we use:
 * every admin surface already holds the UUID, and `AdminAPI.persistRichTextColumns`
 * is keyed `.eq('id', productId)`, so a move to by-sku would silently break
 * `description_html`'s repair on the same save.
 */
export const FOR_USE_IN_WRITE_ROUTE = Object.freeze({
    verb: 'PUT',
    path: '/api/admin/products/:id',
    field: 'compatible_devices_html',
    measured: '2026-09-20 — npm run probe:product-write -- --write (21/0)',
});
export const canWriteForUseIn = () => FOR_USE_IN_WRITE_ROUTE !== null;

/**
 * The transforms the backend's sanitiser is MEASURED to apply, and nothing else.
 *
 * Used to decide (a) whether the operator has actually edited the field and
 * (b) whether a save round-tripped. A looser normaliser would hide real loss,
 * so this one names what it forgives: self-closing style on void elements, and
 * collapsed whitespace. A dropped tag or lost text is still a difference.
 */
export function normaliseForUseIn(html) {
    if (typeof html !== 'string') return '';
    return html
        .replace(/<(br|hr|img)\s*\/?>/gi, '<$1>')
        .replace(/\s+/g, ' ')
        .trim();
}

/** True when `a` and `b` differ by more than the sanitiser's known rewrites. */
export const forUseInChanged = (a, b) => normaliseForUseIn(a) !== normaliseForUseIn(b);

/**
 * Read one product's machine list through the public endpoint.
 *
 * `getForUseIn` goes through `API.getPublic()` deliberately: the endpoint is
 * edge-cached (`s-maxage=300`) and a bearer on it is the ERR-124/159 hazard —
 * one shared cache entry, per-visitor headers. The admin is not special here;
 * it reads exactly what a customer reads, which is also the point (an admin
 * looking at a stale or different list could not tell).
 *
 * @param {string} sku
 * @param {object} [deps] - injectable for tests: { api }
 * @returns {Promise<{state: string, html: string|null, reason: string|null}>}
 */
export async function readForUseIn(sku, deps = {}) {
    const api = deps.api || (typeof window !== 'undefined' ? window.API : null);
    const done = (state, html, reason) => ({ state, html: html || null, reason: reason || null });

    if (!sku) return done(FOR_USE_IN_STATE.UNAVAILABLE, null, 'no SKU on this product yet');
    if (!api || typeof api.getForUseIn !== 'function') {
        return done(FOR_USE_IN_STATE.UNAVAILABLE, null, 'the API client is not loaded');
    }

    let resp;
    try {
        resp = await api.getForUseIn(sku);
    } catch (e) {
        // API.request() THROWS on a transport failure rather than answering a
        // falsy envelope, so this catch is load-bearing, not decorative
        // (ERR-216: the same assumption made a fallback dead code).
        return done(FOR_USE_IN_STATE.UNAVAILABLE, null, transportReason(e));
    }
    if (!resp || resp.ok !== true || !resp.data) {
        return done(FOR_USE_IN_STATE.UNAVAILABLE, null, envelopeReason(resp));
    }
    if (!Object.prototype.hasOwnProperty.call(resp.data, 'for_use_in_html')) {
        // A 429 body has no such key. Absence is a REFUSAL, not an empty list.
        return done(FOR_USE_IN_STATE.UNAVAILABLE, null,
            'the server answered without a for_use_in_html key — usually a rate-limit refusal');
    }
    const html = resp.data.for_use_in_html;
    const usable = typeof html === 'string' && html.trim() ? html : null;
    return usable
        ? done(FOR_USE_IN_STATE.OK, usable, null)
        : done(FOR_USE_IN_STATE.NONE, null, null);
}

function transportReason(e) {
    if (e && e.code === 'RATE_LIMITED') return 'the endpoint is rate-limited right now (40/min) — try again shortly';
    if (e && e.status) return `the server answered ${e.status}`;
    return 'the request could not be sent';
}

function envelopeReason(resp) {
    if (resp && resp.code === 'RATE_LIMITED') return 'the endpoint is rate-limited right now (40/min) — try again shortly';
    if (resp && resp.code === 'NOT_FOUND') return 'the endpoint does not recognise this SKU';
    if (resp && resp.code) return `the server refused: ${resp.code}`;
    return 'the server did not answer with a usable envelope';
}

/**
 * Read the machine list from the ADMIN mirror.
 *
 * 🚨 THIS EXISTS BECAUSE THE PUBLIC READ CANNOT SEE AN UNPUBLISHED PRODUCT, and
 * an unpublished product is precisely the one an operator is still preparing.
 *
 * The first version of this panel seeded itself from `readForUseIn()` alone —
 * the customer-facing endpoint — on the good reasoning that an admin should see
 * what a shopper sees. But `GET /api/products/:sku/for-use-in` 404s for
 * `is_active: false`, which the panel correctly classifies as `unavailable`,
 * and the editor deliberately refuses to open over a failed read (typing into a
 * box we could not populate would replace a list nobody could prove was gone).
 * Net effect: **the machine list of an inactive product could never be edited.**
 * Found by driving the real panel against a real inactive product, not by
 * reading the code — the logic is correct in isolation and wrong in place.
 *
 * So the ADMIN mirror is the seed, and the public read becomes a cross-check.
 * Measured 2026-09-20: the two are byte-identical on 3/3 products with lists,
 * because `GET /api/admin/products/:id` joins `product_compat_devices`.
 *
 * Same three states as `readForUseIn`, and `hasOwnProperty` decides for the
 * same reason: a response that simply lacks the key told us nothing, and a
 * cleared list is a real `null` (ERR-199).
 *
 * @param {string} productId
 * @param {object} [deps] - injectable for tests: { adminApi }
 */
export async function readForUseInAdmin(productId, deps = {}) {
    const adminApi = deps.adminApi || (typeof window !== 'undefined' ? window.AdminAPI : null);
    const done = (state, html, reason) => ({ state, html: html || null, reason: reason || null });

    if (!productId) return done(FOR_USE_IN_STATE.UNAVAILABLE, null, 'this product has no id yet');
    if (!adminApi || typeof adminApi.getProduct !== 'function') {
        return done(FOR_USE_IN_STATE.UNAVAILABLE, null, 'the admin API client is not loaded');
    }
    let fresh;
    try {
        fresh = await adminApi.getProduct(productId);
    } catch (e) {
        return done(FOR_USE_IN_STATE.UNAVAILABLE, null, transportReason(e));
    }
    if (!fresh || !Object.prototype.hasOwnProperty.call(fresh, 'compatible_devices_html')) {
        return done(FOR_USE_IN_STATE.UNAVAILABLE, null,
            'the product record came back without a machine-list field');
    }
    const html = fresh.compatible_devices_html;
    const usable = typeof html === 'string' && html.trim() ? html : null;
    return usable ? done(FOR_USE_IN_STATE.OK, usable, null) : done(FOR_USE_IN_STATE.NONE, null, null);
}

/**
 * Write one product's machine list, then PROVE it landed.
 *
 * The PUT's own 200 is not the verdict and neither is its echo (which does not
 * exist — see the header). The verdict is the re-read, and the re-read is a
 * DIFFERENT route from the one that just answered.
 *
 * `html` is sent verbatim. An empty string CLEARS the list — measured, and the
 * caller must mean it; `writeForUseIn` never invents one. `null`/`undefined`
 * are refused rather than coerced to `''`, because "I have nothing to send" and
 * "delete what is there" are the two answers this field must never confuse.
 *
 * @param {{id: string, sku: string}} ids
 * @param {string} html - verbatim; '' clears
 * @param {object} [deps] - injectable for tests: { adminApi }
 * @returns {Promise<{state: string, html: string|null, reason: string|null, verified: boolean}>}
 */
export async function writeForUseIn(ids, html, deps = {}) {
    const adminApi = deps.adminApi || (typeof window !== 'undefined' ? window.AdminAPI : null);
    const done = (state, out, reason) => ({
        state,
        html: typeof out === 'string' ? out : null,
        reason: reason || null,
        verified: state === FOR_USE_IN_WRITE.SAVED,
    });

    const id = ids && ids.id;
    const sku = ids && ids.sku;
    if (!id) return done(FOR_USE_IN_WRITE.REFUSED, null, 'this product has no id yet — save it first');
    if (typeof html !== 'string') {
        return done(FOR_USE_IN_WRITE.REFUSED, null,
            'nothing to send. Use an empty string to clear the list deliberately.');
    }
    if (!adminApi || typeof adminApi.updateProduct !== 'function') {
        return done(FOR_USE_IN_WRITE.REFUSED, null, 'the admin API client is not loaded');
    }

    // The route requires `sku` and `retail_price` on every product update, and
    // a partial PUT no longer defaults what it was not sent (their §2, pinned by
    // probe §4). So this body is deliberately minimal: the one field we own,
    // plus the identifiers the route demands. It must NOT carry anything else —
    // a write that quietly resends a stale form value is how a save on one field
    // reverts another (the ERR-244 family, and why `stock_quantity` is kept off
    // the main product payload).
    const payload = { [FOR_USE_IN_WRITE_ROUTE.field]: html };
    if (sku) payload.sku = sku;
    if (deps.retailPrice != null) payload.retail_price = deps.retailPrice;

    try {
        await adminApi.updateProduct(id, payload);
    } catch (e) {
        // Their §1: if the list fails to save the route answers 500 WITH the
        // product row already written. That is a different sentence from "the
        // save failed", and an operator told the wrong one will retype work
        // that is already stored.
        const status = e && (e.status || e.code);
        if (status === 500 || status === 'INTERNAL_ERROR') {
            return done(FOR_USE_IN_WRITE.LIST_FAILED, null,
                'the product saved but the machine list did not — the two are written separately. '
                + 'Try the list again; nothing else on this product needs re-entering.');
        }
        return done(FOR_USE_IN_WRITE.REFUSED, null, transportReason(e));
    }

    // ── The verdict: a reader that did not take part in the write ──────────
    //
    // 🚨 `confirmed` is tracked with a SEPARATE FLAG, not by testing it against
    // null, and that is not fussiness — a cleared list reads back as exactly
    // `null`. Keying on `confirmed === null` made every successful CLEAR report
    // itself as "could not confirm", which is the ABSENT ≠ null ≠ '' hazard
    // (ERR-199) landing inside the very function written to avoid it. Caught by
    // §2 of tests/for-use-in-write-sep2026.test.js before it shipped.
    let confirmed;
    let confirmedKnown = false;
    if (typeof adminApi.getProduct === 'function') {
        try {
            const fresh = await adminApi.getProduct(id);
            if (fresh && Object.prototype.hasOwnProperty.call(fresh, 'compatible_devices_html')) {
                confirmed = fresh.compatible_devices_html;
                confirmedKnown = true;
            }
        } catch (_) {
            // A failed confirmation is not a failed write. Fall through to
            // saved-unverified, which says exactly that.
        }
    }

    if (!confirmedKnown) {
        return done(FOR_USE_IN_WRITE.SAVED_UNVERIFIED, html,
            'the server accepted it, but the list could not be read back to confirm. '
            + 'Reopen the product to check before editing it again.');
    }
    if (!forUseInChanged(confirmed, html)) {
        // Return the SERVER's copy, not ours: the sanitiser rewrites `<br>` as
        // `<br />`, and the editor should hold what is stored. A cleared list
        // comes back as null, which `done()` renders as `html: null` — the
        // caller's cue to paint the "no list" state rather than an empty box.
        return done(FOR_USE_IN_WRITE.SAVED, confirmed, null);
    }
    return done(FOR_USE_IN_WRITE.SAVED_UNVERIFIED, confirmed,
        'the server accepted it but read back something different — check the list below '
        + 'before editing it again.');
}

// ── Preview sanitiser ──────────────────────────────────────────────────────
//
// The backend sanitises on the way IN. That is their guarantee about new
// writes, not a fact about every row already in the table, and it is not a
// reason to hand a network value to innerHTML in an admin session that holds an
// owner JWT. The preview therefore renders through an allow-list of our own.
//
// Tag-stripping by regex is not a general-purpose XSS defence and is not
// claimed as one — this runs over a field the backend already filtered, as a
// second layer. What it guarantees is narrow and testable: no element outside
// the list survives, and no attribute of any kind does, so there is no `on*`
// handler, no `src`, no `href` and no `style` to carry a payload.
const PREVIEW_ALLOWED = ['div', 'span', 'b', 'i', 'u', 'strong', 'em', 'br', 'p', 'ul', 'ol', 'li'];

/**
 * A preview-safe version of an admin-authored machine list.
 * @param {string} html
 * @returns {string} markup with only allow-listed, attribute-free tags
 */
export function previewForUseIn(html) {
    if (typeof html !== 'string' || !html) return '';
    return html
        // Drop whole dangerous elements INCLUDING their content — a bare tag
        // strip would leave the body of a <script> as visible page text.
        .replace(/<(script|style|iframe|object|embed|template|svg|math)\b[\s\S]*?<\/\1\s*>/gi, '')
        .replace(/<(script|style|iframe|object|embed|template|svg|math)\b[^>]*>/gi, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        // Then rebuild every remaining tag with its name only, dropping ALL
        // attributes. Anything not allow-listed is removed outright.
        .replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (match, rawName) => {
            const name = rawName.toLowerCase();
            if (!PREVIEW_ALLOWED.includes(name)) return '';
            return match[1] === '/' ? `</${name}>` : `<${name}>`;
        });
}

/**
 * The panel's explanatory copy. ONE sentence-set for both product modals, so
 * the drawer and the full-page editor cannot end up explaining the same
 * constraint two different ways — the ERR-187/192 shape, where one rule grew
 * six copies and ERR-192 then relocated it instead of sharing it.
 */
export function forUseInNotice() {
    return 'Type the list as HTML — it is stored as you write it. This field keeps more '
        + 'formatting than the description does: <div>, <b>, <span> and <br> all survive. '
        + 'Leaving the box empty and saving CLEARS the list; not touching it leaves it alone. '
        + 'The list is stored separately from the product, so if it fails to save the rest of '
        + 'your changes are still written.';
}

/**
 * Panel markup. Pure string-building — no DOM, no fetch — so it is unit-testable
 * and so the caller controls when the read happens.
 *
 * @param {function} esc - the caller's HTML escaper (never optional: this
 *   renders admin-authored HTML, and a missing escaper must be a crash here
 *   rather than an XSS there — ERR-167, where a `window.Security?.x ? … : …`
 *   guard turned out to be an off switch).
 * @param {object} [opts] - { mode } — one of:
 *   'edit'     the drawer: textarea + preview + its own Save/Clear, which write
 *              through `writeForUseIn` and verify by re-read.
 *   'create'   the create modal: textarea + preview, NO Save of its own. The
 *              product does not exist yet, so there is no id to PUT to — the
 *              list rides along on the POST instead, which the backend fixed on
 *              2026-09-20 (probe §8). `forUseInCreateValue()` is how the create
 *              handler reads it, so the field name still lives only in here.
 *   'readonly' the old panel, for when no write route is available at all.
 */
export function forUseInPanelHtml(esc, opts = {}) {
    if (typeof esc !== 'function') throw new TypeError('forUseInPanelHtml requires an escaper');
    const mode = canWriteForUseIn() ? (opts.mode || 'edit') : 'readonly';
    const editable = mode === 'edit' || mode === 'create';

    const notice = mode === 'edit'
        ? `<p class="admin-fui__notice" role="note">${esc(forUseInNotice())}</p>`
        : mode === 'create'
            ? `<p class="admin-fui__notice" role="note">${esc('Type the list as HTML — <div>, <b>, '
                + '<span> and <br> all survive here, unlike in the description. It is saved together '
                + 'with the product when you press Create; leave it empty to add one later.')}</p>`
            : `<p class="admin-fui__notice" role="note">${esc('This list is read-only here — no admin '
                + 'route can write it. A Save would be accepted and silently discarded, so the field '
                + 'does not offer one.')}</p>`;

    const actions = mode === 'edit' ? `
        <div class="admin-fui__actions">
          <button type="button" class="admin-btn admin-btn--primary admin-btn--sm"
                  data-action="for-use-in-save">Save list</button>
          <button type="button" class="admin-btn admin-btn--sm"
                  data-action="for-use-in-clear">Clear list</button>
          <span class="admin-fui__status" id="for-use-in-status" role="status"></span>
        </div>` : '';

    const editor = editable ? `
      <div class="admin-fui__edit"${mode === 'create' ? '' : ' hidden'}>
        <div class="admin-fui__cols">
          <div class="admin-fui__col">
            <label class="admin-fui__collabel" for="for-use-in-input">Source</label>
            <textarea id="for-use-in-input" class="admin-fui__input" rows="10"
                      spellcheck="false" wrap="soft"></textarea>
          </div>
          <div class="admin-fui__col">
            <span class="admin-fui__collabel">Preview</span>
            <div class="admin-fui__preview" id="for-use-in-preview" aria-live="polite"></div>
          </div>
        </div>${actions}
      </div>` : '';

    return `
    <div class="admin-form-group" id="for-use-in-group" data-for-use-in-state="loading">
      <label>Compatible Devices / For Use In</label>
      ${notice}
      <div class="admin-fui__box" id="for-use-in-box">
        <span class="admin-text-muted" style="font-size:13px">Loading the current list…</span>
      </div>${editor}
    </div>
  `;
}

/**
 * The machine list an operator typed into a CREATE modal.
 *
 * The create handler must not reach for `#for-use-in-input` itself: the field
 * name and the element id belong to this module, and a second place that knows
 * them is how one rule became six copies (ERR-187/192).
 *
 * Returns `null` — not `''` — when there is nothing to send, because `''` is
 * the CLEAR instruction. On a create there is nothing to clear, and sending one
 * anyway would mean every product created without a list carries an explicit
 * empty write. Omission and deletion are not the same request.
 *
 * @param {HTMLElement} root
 * @returns {string|null}
 */
export function forUseInCreateValue(root) {
    if (!root || typeof root.querySelector !== 'function') return null;
    const input = root.querySelector('#for-use-in-input');
    if (!input || typeof input.value !== 'string') return null;
    const value = input.value.trim();
    return value ? input.value : null;
}

/**
 * Paint one READ state into the panel.
 *
 * On an editable panel the box is the read-state reporter and the textarea is
 * the working copy; `ok` and `none` both hand control to the editor, while
 * `unavailable` deliberately does NOT — an operator who is shown an empty
 * editable box after a failed read will type into it, and saving that would
 * replace a list nobody could prove was gone.
 */
export function renderForUseIn(box, result, esc) {
    if (!box) return;
    const group = box.closest ? box.closest('#for-use-in-group') : null;
    if (group) group.setAttribute('data-for-use-in-state', result.state);

    if (result.state === FOR_USE_IN_STATE.OK) {
        box.innerHTML = `<pre class="admin-fui__pre">${esc(result.html)}</pre>`;
        return;
    }
    if (result.state === FOR_USE_IN_STATE.NONE) {
        // "Answered, and there is none" — a real, quiet fact. Distinct copy from
        // the failure below, because the two must never paint the same box.
        box.innerHTML = '<p class="admin-text-muted" style="font-size:13px;margin:0">'
            + 'No compatible-device list is set for this product.</p>';
        return;
    }
    const why = result.reason ? ` (${esc(result.reason)})` : '';
    box.innerHTML = `<p class="admin-fui__fail" style="margin:0">`
        + `The current list could not be read${why}. `
        + `<strong>This is not the same as the product having no list</strong> — do not treat a `
        + `blank box here as proof the content is gone, and do not retype it: saving would `
        + `replace a list we cannot currently see. `
        + `<button type="button" class="admin-btn admin-btn--sm" data-action="for-use-in-retry">Try again</button>`
        + `</p>`;
}

/**
 * Fetch + paint + wire, for a modal that is already in the DOM.
 *
 * @param {HTMLElement} root
 * @param {string|null} sku
 * @param {function} esc
 * @param {object} [deps] - { api, adminApi, productId, retailPrice, onSaved, toast }
 * @returns {Promise<object|null>} the read result, for a caller or a test
 */
export async function wireForUseInPanel(root, sku, esc, deps = {}) {
    if (!root) return null;
    const box = root.querySelector('#for-use-in-box');
    if (!box) return null;

    const editWrap = root.querySelector('.admin-fui__edit');
    const input = root.querySelector('#for-use-in-input');
    const preview = root.querySelector('#for-use-in-preview');
    const statusEl = root.querySelector('#for-use-in-status');
    const group = root.querySelector('#for-use-in-group');
    const mode = deps.mode || 'edit';
    const canEdit = !!(editWrap && input && deps.productId && canWriteForUseIn() && mode === 'edit');

    const paintPreview = () => {
        if (!preview || !input) return;
        const safe = previewForUseIn(input.value);
        preview.innerHTML = safe
            || '<span class="admin-text-muted" style="font-size:12px">Nothing to preview — '
             + 'saving an empty box clears the list.</span>';
    };
    const say = (msg, kind) => {
        if (!statusEl) return;
        statusEl.textContent = msg || '';
        statusEl.className = `admin-fui__status${kind ? ` admin-fui__status--${kind}` : ''}`;
    };

    /** The last value we know the SERVER holds — the dirty check's baseline. */
    let seeded = '';

    const load = async () => {
        // TWO READS, and which one seeds matters (see readForUseInAdmin).
        //
        // The ADMIN mirror seeds the editor: it is authoritative, it is what a
        // write is verified against, and it can see an unpublished product —
        // the public endpoint 404s those, which would leave exactly the
        // products an operator is preparing permanently uneditable.
        //
        // The PUBLIC read is kept as a cross-check, because the two answering
        // differently is a real thing worth surfacing rather than a thing to
        // pick a winner between: the storefront endpoint is edge-cached
        // (s-maxage=300), so for five minutes after a save the shop genuinely
        // is showing something else. Two surfaces disagreeing may be looking at
        // different MOMENTS, not different CODE (ERR-263).
        const primary = deps.productId ? readForUseInAdmin(deps.productId, deps) : null;
        const publicRead = readForUseIn(sku, deps);
        const result = primary ? await primary : await publicRead;
        const shopper = await publicRead;

        renderForUseIn(box, result, esc);

        // With the editor open and a list present, the read-state box and the
        // Source textarea hold the same string — two copies of one value, one of
        // which cannot be edited. Hide the box in that case only; `none` and
        // `unavailable` both still paint, because those are the two states an
        // empty textarea cannot distinguish on its own and the second of them
        // must never be mistaken for the first.
        if (canEdit && result.state === FOR_USE_IN_STATE.OK) box.hidden = true;
        else box.hidden = false;

        if (canEdit) {
            if (result.state === FOR_USE_IN_STATE.UNAVAILABLE) {
                // Do not offer an empty editor over a read we could not make.
                editWrap.hidden = true;
            } else {
                seeded = result.html || '';
                input.value = seeded;
                editWrap.hidden = false;
                paintPreview();
                // Only speak up when the shopper's copy is READABLE and DIFFERENT.
                // An unreadable public read is normal here (an inactive product
                // 404s), and reporting that as a mismatch would cry wolf on every
                // unpublished product.
                if (shopper.state !== FOR_USE_IN_STATE.UNAVAILABLE
                    && forUseInChanged(shopper.html, result.html)) {
                    say('The storefront is still showing an older version of this list — '
                        + 'its copy is cached for up to 5 minutes.', 'muted');
                } else {
                    say('');
                }
            }
        }

        const retry = box.querySelector('[data-action="for-use-in-retry"]');
        if (retry) retry.addEventListener('click', async () => {
            box.innerHTML = '<span class="admin-text-muted" style="font-size:13px">Re-reading…</span>';
            await load();
        });
        return result;
    };

    // A create modal has no product to read and nothing to save yet: it just
    // needs a live preview of what the operator is typing. Its value is picked
    // up by the create handler through forUseInCreateValue().
    if (mode === 'create') {
        if (input) {
            input.addEventListener('input', paintPreview);
            paintPreview();
        }
        if (box) {
            box.innerHTML = '<p class="admin-text-muted" style="font-size:13px;margin:0">'
                + 'This list is saved with the product when you press Create.</p>';
        }
        if (group) group.setAttribute('data-for-use-in-state', 'create');
        return null;
    }

    const result = await load();

    if (canEdit) {
        input.addEventListener('input', paintPreview);

        const commit = async (value, verb) => {
            const saveBtn = root.querySelector('[data-action="for-use-in-save"]');
            const clearBtn = root.querySelector('[data-action="for-use-in-clear"]');
            [saveBtn, clearBtn].forEach((b) => { if (b) b.disabled = true; });
            say(`${verb}…`);

            const out = await writeForUseIn(
                { id: deps.productId, sku },
                value,
                { adminApi: deps.adminApi, retailPrice: deps.retailPrice },
            );

            [saveBtn, clearBtn].forEach((b) => { if (b) b.disabled = false; });
            if (group) group.setAttribute('data-for-use-in-write', out.state);

            if (out.state === FOR_USE_IN_WRITE.SAVED) {
                // Re-seed from the SERVER's copy — the sanitiser rewrites markup,
                // and the box must hold what is stored or the next reopen reads
                // as an unsaved edit.
                seeded = out.html || '';
                input.value = seeded;
                paintPreview();
                renderForUseIn(box, seeded
                    ? { state: FOR_USE_IN_STATE.OK, html: seeded, reason: null }
                    : { state: FOR_USE_IN_STATE.NONE, html: null, reason: null }, esc);
                box.hidden = !!seeded;
                say('Saved, and read back to confirm.', 'ok');
            } else {
                // Never paint a success we cannot stand behind, and never silently
                // re-seed: the operator's text stays in the box so it is not lost.
                say(out.reason || 'The list could not be saved.', 'warn');
            }
            if (typeof deps.onSaved === 'function') deps.onSaved(out);
            return out;
        };

        const saveBtn = root.querySelector('[data-action="for-use-in-save"]');
        if (saveBtn) saveBtn.addEventListener('click', () => {
            if (!forUseInChanged(input.value, seeded)) {
                say('No changes to save.', 'muted');
                return;
            }
            return commit(input.value, 'Saving');
        });

        const clearBtn = root.querySelector('[data-action="for-use-in-clear"]');
        if (clearBtn) clearBtn.addEventListener('click', () => {
            if (!seeded) { say('There is no list to clear.', 'muted'); return; }
            // Clearing is destructive and cannot be undone from here, so it is
            // confirmed. An empty string is the ONLY way this module deletes a
            // list, and it is never reached by accident.
            const proceed = typeof deps.confirm === 'function'
                ? deps.confirm('Clear the machine list for this product? This cannot be undone here.')
                : (typeof window !== 'undefined' && window.confirm
                    ? window.confirm('Clear the machine list for this product? This cannot be undone here.')
                    : true);
            if (!proceed) return;
            input.value = '';
            paintPreview();
            return commit('', 'Clearing');
        });
    }

    return result;
}
