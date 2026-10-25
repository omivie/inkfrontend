/**
 * Reorder reminders (checklist 2026-10-22 item 40, ERR-372)
 * ==========================================================
 * A signed-in customer asks for an email every N weeks that loads their
 * reorder into the cart in one click. NOTHING is ordered or charged
 * automatically — so it is never called "auto-reorder", "subscription",
 * "Subscribe & Save", "save", "%" or "never run out" (backend copy rule).
 *
 * ONE module, two surfaces:
 *   - the PDP control under the fit line (ink cartridges, ink bottles, toner);
 *   - the account dashboard's "Reorder reminders" section.
 *
 * API (Bearer; JSON; errors {ok:false, error:{code, message, details}}):
 *   GET   /api/account/subscriptions         newest first, ≤ 50
 *   POST  /api/account/subscriptions         {items:[{sku, quantity}], interval_days}
 *   PATCH /api/account/subscriptions/:id     {interval_days | status | items | next_due}
 * A reminder's `email` is a sign-up copy and is NEVER shown: reminders go to
 * the current account email.
 */
'use strict';

const ReorderReminders = {
    /** The same list everywhere (weeks). */
    INTERVAL_WEEKS: [4, 6, 8, 10, 12, 16, 26],
    PRODUCT_TYPES: ['ink_cartridge', 'ink_bottle', 'toner_cartridge'],
    MANAGE_HREF: '/account#reorder-reminders',

    _listPromise: null,

    // ── API ────────────────────────────────────────────────────────────────

    /** One GET per visit. Resolves to an array, or null when it could not be read. */
    list(fresh = false) {
        if (fresh || !this._listPromise) {
            this._listPromise = API.get('/api/account/subscriptions')
                .then((r) => (r && r.ok && r.data && Array.isArray(r.data.subscriptions)) ? r.data.subscriptions : null)
                .catch(() => null);
        }
        return this._listPromise;
    },

    async create(items, intervalDays) {
        this._listPromise = null;
        return this._call(() => API.post('/api/account/subscriptions', { items, interval_days: intervalDays }));
    },

    async patch(id, body) {
        this._listPromise = null;
        return this._call(() => API.patch(`/api/account/subscriptions/${encodeURIComponent(id)}`, body));
    },

    /** Normalise thrown 400s (request() throws for most codes) into an envelope. */
    async _call(fn) {
        try {
            const r = await fn();
            return r || { ok: false, code: 'UNKNOWN' };
        } catch (e) {
            return { ok: false, code: (e && e.code) || 'NETWORK_ERROR', details: e && e.details };
        }
    },

    // ── PURE helpers ───────────────────────────────────────────────────────

    /** "Every 6 weeks", or "Every 45 days" when not a whole number of weeks. */
    everyText(days) {
        const d = Number(days);
        if (!Number.isFinite(d) || d <= 0) return '';
        return d % 7 === 0 ? `Every ${d / 7} week${d === 7 ? '' : 's'}` : `Every ${d} day${d === 1 ? '' : 's'}`;
    },

    /** "every 6 weeks" for inside a sentence. */
    everyLower(days) {
        const t = this.everyText(days);
        return t ? t.charAt(0).toLowerCase() + t.slice(1) : '';
    },

    /** 'YYYY-MM-DD' → "9 December 2026" (en-NZ); anything else unchanged. */
    dateText(ymd) {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
        if (!m) return String(ymd || '');
        const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
        return d.toLocaleDateString('en-NZ', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    },

    /**
     * Default interval (weeks): the customer's existing ACTIVE reminder's, so
     * every cartridge lands on one schedule and one email; otherwise 6 weeks
     * for ink cartridges, 8 for toner and ink bottles.
     */
    defaultWeeks(productType, subs) {
        const active = (subs || []).find((s) => s && s.status === 'active' && Number(s.interval_days) % 7 === 0
            && this.INTERVAL_WEEKS.includes(Number(s.interval_days) / 7));
        if (active) return Number(active.interval_days) / 7;
        return productType === 'ink_cartridge' ? 6 : 8;
    },

    /** Which reminder already holds this SKU: {state:'active'|'paused', sub} or null. */
    coverFor(sku, subs) {
        const has = (s) => s && Array.isArray(s.items) && s.items.some((it) => it && it.sku === sku);
        const active = (subs || []).find((s) => s.status === 'active' && has(s));
        if (active) return { state: 'active', sub: active };
        const paused = (subs || []).find((s) => s.status === 'paused' && has(s));
        return paused ? { state: 'paused', sub: paused } : null;
    },

    /** The line after a create (copy from the backend's spec, item 40 §1). PURE. */
    createdText(res) {
        const sub = (res && res.data && res.data.subscription) || {};
        const when = this.dateText(sub.next_due);
        const every = this.everyLower(sub.interval_days);
        if (res && res.data && res.data.merged === true) {
            return `Added to your reorder reminder. We'll email you around ${when}, then ${every}, with all its items ready to add to your cart in one click. Nothing is ordered or charged until you check out.`;
        }
        return `Reminder set. We'll email you around ${when}, then ${every}, with this item ready to add to your cart in one click. Nothing is ordered or charged until you check out. You can pause or change it any time in your account.`;
    },

    _esc(s) { return Security.escapeHtml(String(s == null ? '' : s)); },

    // ── PDP ────────────────────────────────────────────────────────────────

    /**
     * Mount the control into #product-reminder for `product` (raw API row).
     * Guests: one sign-in link back to this page — no control, no email capture.
     */
    async mountPdp(product) {
        const el = document.getElementById('product-reminder');
        if (!el) return;
        const type = product && product.product_type;
        if (!product || !product.sku || !this.PRODUCT_TYPES.includes(type)) { el.hidden = true; el.innerHTML = ''; return; }
        const signedIn = typeof Auth !== 'undefined' && Auth.isAuthenticated && Auth.isAuthenticated();
        if (!signedIn) {
            const back = window.location.pathname + window.location.search;
            el.innerHTML = `<a class="product-reminder__signin" href="/account/login?redirect=${encodeURIComponent(back)}">Sign in to get a reorder reminder for this item.</a>`;
            el.hidden = false;
            el.dataset.reminder = 'guest';
            return;
        }
        const subs = await this.list();
        if (subs === null) { el.hidden = true; el.dataset.reminder = 'unavailable'; return; }
        const cover = this.coverFor(product.sku, subs);
        if (cover) {
            el.innerHTML = cover.state === 'active'
                ? `<p class="product-reminder__set">Reminder set: ${this._esc(this.everyLower(cover.sub.interval_days))}. Next email around ${this._esc(this.dateText(cover.sub.next_due))}.</p>`
                    + ` <a class="product-reminder__manage" href="${this.MANAGE_HREF}">Manage reminders</a>`
                : `<p class="product-reminder__set">Your reminder for this item is paused.</p> <a class="product-reminder__manage" href="${this.MANAGE_HREF}">Manage reminders</a>`;
            el.hidden = false;
            el.dataset.reminder = cover.state;
            return;
        }
        const weeks = this.defaultWeeks(type, subs);
        const opts = this.INTERVAL_WEEKS.map((w) => `<option value="${w}"${w === weeks ? ' selected' : ''}>${w}</option>`).join('');
        el.innerHTML = `<label class="product-reminder__label">Email me a reminder to reorder this every <select id="product-reminder-weeks" aria-label="Weeks between reminders">${opts}</select> weeks</label>`
            + ` <button type="button" class="btn btn--secondary btn--sm" id="product-reminder-btn">Set reminder</button>`
            + `<p class="product-reminder__status" id="product-reminder-status" role="status" aria-live="polite" hidden></p>`;
        el.hidden = false;
        el.dataset.reminder = 'offer';
        const btn = document.getElementById('product-reminder-btn');
        btn.addEventListener('click', async () => {
            if (btn.disabled) return;
            btn.disabled = true;
            const w = Number(document.getElementById('product-reminder-weeks').value) || weeks;
            const qtyInput = document.getElementById('qty-input');
            const qty = Math.min(20, Math.max(1, parseInt(qtyInput && qtyInput.value, 10) || 1));
            const res = await this.create([{ sku: product.sku, quantity: qty }], w * 7);
            const status = document.getElementById('product-reminder-status');
            if (res.ok && res.data && res.data.subscription) {
                el.innerHTML = `<p class="product-reminder__set" role="status">${this._esc(this.createdText(res))}</p>`;
                el.dataset.reminder = res.data.merged ? 'merged' : 'created';
                return;
            }
            btn.disabled = false;
            status.textContent = res.code === 'NO_ORDERABLE_ITEMS'
                ? "Reminders aren't available for this item."
                : "We couldn't set the reminder just now. Please try again.";
            status.hidden = false;
            el.dataset.reminder = 'error';
        });
    },

    // ── Account ────────────────────────────────────────────────────────────

    /** Product names for SKUs (GET /api/products/:sku follows renames). SKU on failure. */
    async _names(skus) {
        const out = {};
        await Promise.all([...new Set(skus)].map(async (sku) => {
            try {
                const r = await API.getProduct(sku);
                const p = r && r.ok && r.data;
                out[sku] = p ? (((typeof ProductName !== 'undefined') ? ProductName.clean(p) : p.name) || sku) : sku;
            } catch (_) { out[sku] = sku; }
        }));
        return out;
    },

    /** Mount the dashboard section into #reorder-reminders. */
    async mountAccount() {
        const el = document.getElementById('reorder-reminders');
        if (!el) return;
        const body = el.querySelector('.reorder-reminders__body');
        const subs = await this.list(true);
        el.hidden = false;
        if (subs === null) {
            body.innerHTML = '<p class="reorder-reminders__empty">We couldn\'t load your reorder reminders just now. Please refresh the page.</p>';
            el.dataset.reminders = 'error';
            return;
        }
        const shown = subs.filter((s) => s && s.status !== 'cancelled');
        if (!shown.length) {
            body.innerHTML = '<p class="reorder-reminders__empty">No reorder reminders yet. You can set one on any ink or toner product page.</p>';
            el.dataset.reminders = 'empty';
            return;
        }
        const names = await this._names(shown.flatMap((s) => (s.items || []).map((i) => i.sku)));
        body.innerHTML = shown.map((s) => this._reminderHtml(s, names)).join('');
        el.dataset.reminders = 'ok';
        if (!el.dataset.bound) {
            el.dataset.bound = '1';
            el.addEventListener('click', (e) => this._onAccountClick(e));
        }
    },

    _reminderHtml(s, names) {
        const id = this._esc(s.id);
        const items = (s.items || []).map((it, i) => `<li>${this._esc(names[it.sku] || it.sku)} × ${this._esc(it.quantity)}`
            + ` <button type="button" class="reorder-reminders__link" data-act="${(s.items || []).length > 1 ? 'remove' : 'delete'}" data-id="${id}" data-index="${i}">${(s.items || []).length > 1 ? 'Remove item' : 'Delete reminder'}</button></li>`).join('');
        const weeksNow = Number(s.interval_days) % 7 === 0 ? Number(s.interval_days) / 7 : null;
        const opts = this.INTERVAL_WEEKS.map((w) => `<option value="${w}"${w === weeksNow ? ' selected' : ''}>${w} weeks</option>`).join('');
        const state = s.status === 'paused'
            ? '<p class="reorder-reminders__state">Paused. No reminder emails are sent. We also pause a reminder ourselves when none of its items can be ordered any more.</p>'
            : `<p class="reorder-reminders__state">Next reminder: ${this._esc(this.dateText(s.next_due))}, then ${this._esc(this.everyLower(s.interval_days))}.</p>`;
        return `<article class="reorder-reminder" data-id="${id}">`
            + `<ul class="reorder-reminder__items">${items}</ul>`
            + `<p class="reorder-reminder__every">${this._esc(this.everyText(s.interval_days))}</p>`
            + state
            + `<div class="reorder-reminder__actions">`
            + `<label>Change how often <select data-role="weeks" data-id="${id}">${opts}</select></label>`
            + ` <button type="button" class="btn btn--secondary btn--sm" data-act="interval" data-id="${id}">Save</button>`
            + (s.status === 'paused'
                ? ` <button type="button" class="btn btn--secondary btn--sm" data-act="resume" data-id="${id}">Turn reminders back on</button>`
                : ` <button type="button" class="btn btn--secondary btn--sm" data-act="pause" data-id="${id}">Pause reminders</button>`)
            + ` <button type="button" class="reorder-reminders__link" data-act="delete" data-id="${id}">Delete reminder</button>`
            + `</div><p class="reorder-reminder__msg" role="status" aria-live="polite" hidden></p></article>`;
    },

    async _onAccountClick(e) {
        const btn = e.target.closest('[data-act]');
        if (!btn || btn.disabled) return;
        const card = btn.closest('.reorder-reminder');
        const id = btn.dataset.id;
        const subs = (await this.list()) || [];
        const sub = subs.find((s) => String(s.id) === String(id));
        if (!sub || !card) return;
        let body;
        switch (btn.dataset.act) {
            case 'interval': {
                const sel = card.querySelector('select[data-role="weeks"]');
                body = { interval_days: Number(sel && sel.value) * 7 };
                break;
            }
            case 'pause': body = { status: 'paused' }; break;
            case 'resume': body = { status: 'active' }; break;
            case 'delete': body = { status: 'cancelled' }; break;
            case 'remove': {
                const i = Number(btn.dataset.index);
                body = { items: (sub.items || []).filter((_, k) => k !== i).map((it) => ({ sku: it.sku, quantity: it.quantity })) };
                break;
            }
            default: return;
        }
        btn.disabled = true;
        const res = await this.patch(id, body);
        const msg = card.querySelector('.reorder-reminder__msg');
        if (!res.ok) {
            btn.disabled = false;
            if (msg) { msg.textContent = "That didn't save. Please try again."; msg.hidden = false; }
            return;
        }
        await this.mountAccount();
        const after = document.querySelector(`.reorder-reminder[data-id="${CSS.escape(String(id))}"] .reorder-reminder__msg`);
        const next = res.data && res.data.subscription;
        let note = '';
        if (btn.dataset.act === 'resume') note = "Turned back on. If the next reminder date has passed, we'll send it within a day.";
        else if (btn.dataset.act === 'interval' && next) note = `Saved. Next reminder: ${this.dateText(next.next_due)}, then ${this.everyLower(next.interval_days)}.`;
        if (after && note) { after.textContent = note; after.hidden = false; }
    },
};
if (typeof window !== 'undefined') window.ReorderReminders = ReorderReminders;
if (typeof module !== 'undefined' && module.exports) module.exports = { ReorderReminders };
