/**
 * The admin "Compatible Devices / For Use In" panel — ERR-244.
 * ============================================================
 *
 * WHAT CHANGED, AND WHY THIS FILE EXISTS
 *
 * Until 2026-09-10 this panel was a rich-text editor bound to
 * `products.compatible_devices_html`: it read that column straight off
 * PostgREST and wrote it back on Save. Backend migration 132 DROPPED the
 * column. The list now lives in `product_compat_devices` (RLS on, service-role
 * only), readable through `GET /api/products/:sku/for-use-in`.
 *
 * So the two halves of this panel are no longer symmetrical, and pretending
 * otherwise is the whole hazard:
 *
 *   READ   — works. Measured live: 200, `{ok:true,data:{sku,for_use_in_html}}`.
 *   WRITE  — DOES NOT EXIST. Measured 2026-09-10 with an owner JWT:
 *              PUT/GET /api/admin/products/:id/for-use-in        → 404
 *              PUT/GET /api/admin/products/:id/compat-devices    → 404
 *              PUT/GET /api/admin/product-compat-devices         → 404
 *            against a control where GET /api/admin/orders → 401, so a 404 here
 *            means absent, not unauthorised.
 *
 * 🚨 AND THE OLD SAVE PATH NOW LIES. `PUT /api/admin/products/:id` still
 * answers **200** for a body carrying `compatible_devices_html` — the dropped
 * column — and for `for_use_in_html`, which it has never known. Both are
 * accepted and dropped. That is the ERR-151 decoy signature: a write we cannot
 * prove landed, reported as a success. An editor whose Save silently discards
 * the operator's typing is strictly worse than no editor, because the operator
 * walks away believing the work is done.
 *
 * Hence: READ-ONLY, and it says so. Not "coming soon" — ERR-131 spent a month
 * invisible behind that sentence — but what is actually true, with the verb and
 * the route named, so the day a write route ships this file is the only thing
 * that has to change.
 *
 * THREE STATES, NOT TWO (the ERR-243 lesson, applied to the admin side).
 * `null` used to mean both "this product has no list" and "the read failed".
 * A failed read that paints an empty box tells an operator their content is
 * GONE, and the honest reaction to that is to retype it — into a field that
 * cannot save. So:
 *
 *   ok          — the endpoint answered with a non-empty list
 *   none        — the endpoint ANSWERED and said there is no list
 *   unavailable — 429 / 5xx / network / an envelope with no such key
 *
 * `hasOwnProperty` decides, never `?? null`: ABSENT ≠ null (ERR-199), and a 429
 * body carries no `for_use_in_html` key at all (ERR-243, where reading a
 * refusal as an absence nearly sent the backend a data-loss alarm).
 */

export const FOR_USE_IN_STATE = Object.freeze({
    OK: 'ok',
    NONE: 'none',
    UNAVAILABLE: 'unavailable',
});

/**
 * Is there an admin route that can WRITE the machine list?
 *
 * A single named constant rather than a scatter of `false`s, so flipping it is
 * one edit and a test can assert that every surface reads the same answer.
 * Measured 2026-09-10 — see the header. Raised with the backend as BF-062.
 */
export const FOR_USE_IN_WRITE_ROUTE = null;
export const canWriteForUseIn = () => FOR_USE_IN_WRITE_ROUTE !== null;

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
 * The read-only notice. ONE sentence-set for both product modals, so the drawer
 * and the full-page editor cannot end up explaining the same constraint two
 * different ways — the ERR-187/192 shape, where one rule grew six copies and
 * ERR-192 then relocated it instead of sharing it.
 */
export function forUseInNotice() {
    return 'This list is read-only here. It moved out of the products table into its own '
        + 'table (backend migration 132) and no admin route can write it yet — a Save would '
        + 'be accepted and silently discarded, so the field does not offer one. Raised with '
        + 'the backend as BF-062; ask them to set a list in the meantime.';
}

/**
 * Panel markup. Pure string-building — no DOM, no fetch — so it is unit-testable
 * and so the caller controls when the read happens.
 *
 * @param {function} esc - the caller's HTML escaper (never optional: this
 *   renders admin-authored HTML, and a missing escaper must be a crash here
 *   rather than an XSS there — ERR-167, where a `window.Security?.x ? … : …`
 *   guard turned out to be an off switch).
 */
export function forUseInPanelHtml(esc) {
    if (typeof esc !== 'function') throw new TypeError('forUseInPanelHtml requires an escaper');
    return `
    <div class="admin-form-group" id="for-use-in-group" data-for-use-in-state="loading">
      <label>Compatible Devices / For Use In</label>
      <p class="admin-fui__notice" role="note">${esc(forUseInNotice())}</p>
      <div class="admin-fui__box" id="for-use-in-box">
        <span class="admin-text-muted" style="font-size:13px">Loading the current list…</span>
      </div>
    </div>
  `;
}

/**
 * Paint one state into the panel.
 *
 * The rendered list is admin-authored HTML that the backend already sanitises
 * on the way in, and it is shown to an admin, not a customer — but it is still
 * escaped and shown as TEXT here rather than injected as markup. An operator
 * checking what the page will render wants to see the source; and a panel that
 * innerHTMLs a value fetched over the network is a habit worth not forming.
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
        + `blank box here as proof the content is gone. `
        + `<button type="button" class="admin-btn admin-btn--sm" data-action="for-use-in-retry">Try again</button>`
        + `</p>`;
}

/**
 * Fetch + paint + wire the retry, for a modal that is already in the DOM.
 * Returns the result so a caller (or a test) can assert on it.
 */
export async function wireForUseInPanel(root, sku, esc, deps = {}) {
    if (!root) return null;
    const box = root.querySelector('#for-use-in-box');
    if (!box) return null;
    const result = await readForUseIn(sku, deps);
    renderForUseIn(box, result, esc);
    const retry = box.querySelector('[data-action="for-use-in-retry"]');
    if (retry) {
        retry.addEventListener('click', async () => {
            box.innerHTML = '<span class="admin-text-muted" style="font-size:13px">Re-reading…</span>';
            renderForUseIn(box, await readForUseIn(sku, deps), esc);
            const again = box.querySelector('[data-action="for-use-in-retry"]');
            if (again) again.addEventListener('click', () => wireForUseInPanel(root, sku, esc, deps));
        });
    }
    return result;
}
