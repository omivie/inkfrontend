/**
 * Slide-in cart drawer (ERR-316, owner 2026-10-12: "look like smartink").
 *
 * Opens on every non-silent `cart:item-added` (the event cart.js reserved for
 * exactly this, ERR-276). It replaces three older surfaces: the "added to
 * cart" toast, the "Customers also bought" modal and the PDP's in-flow
 * confirmation strip. Every way on (View cart, Checkout) is in its footer,
 * so unlike the old modal it is safe on a phone (D-P0-3).
 *
 * It never computes a price:
 *   - line figures come from Cart.lineTotalHtml (the cart page's own owner);
 *   - the subtotal is the server's `summary.subtotal`; while a change is in
 *     flight it says "Updating…"; with no server summary it says so in words
 *     instead of adding the lines up (fail-soft must be LOUD).
 *
 * "You may also like" reads the add's own frequently-bought-together payload
 * (Cart._crossSellProducts), else /api/products/:sku/related. No rows ⇒ the
 * section is hidden — an empty upsell is not partial data. Its Add buttons
 * wear `.add-to-cart-btn`, so the document delegate in Cart.bindEvents does
 * the add; nothing here adds to the cart.
 *
 * Not opened on /cart, /checkout or /payment: those pages already show the
 * cart, and there cart.js keeps its toast (see Cart.drawerHandlesAdds).
 */
'use strict';

const CartDrawer = {
    UPSELL_MAX: 3,
    root: null,
    _returnFocus: null,
    _upsell: [],
    _upsellFor: null,

    /** False on the pages that already show the cart. */
    enabled: function() {
        if (typeof window === 'undefined' || !window.location) return false;
        return !/^\/(html\/)?(cart|checkout|payment)(\/|$|\.html)/.test(window.location.pathname);
    },

    isOpen: function() {
        return !!(this.root && this.root.classList.contains('is-open'));
    },

    init: function() {
        if (!this.enabled()) return;
        document.addEventListener('cart:item-added', (e) => {
            const d = (e && e.detail) || {};
            if (d.silent) return;
            this.open();
            this._loadUpsell(d);
        });
    },

    _mount: function() {
        if (this.root) return;
        const root = document.createElement('div');
        root.className = 'cart-drawer';
        root.id = 'cart-drawer';
        root.hidden = true;
        root.innerHTML = `
            <div class="cart-drawer__backdrop" data-drawer-close></div>
            <aside class="cart-drawer__panel" role="dialog" aria-modal="true" aria-labelledby="cart-drawer-title" tabindex="-1">
                <div class="cart-drawer__head">
                    <h2 id="cart-drawer-title" class="cart-drawer__title">Cart</h2>
                    <button type="button" class="cart-drawer__close" data-drawer-close aria-label="Close cart">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12"/></svg>
                    </button>
                </div>
                <button type="button" class="cart-drawer__continue" data-drawer-close>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>
                    Continue shopping
                </button>
                <p class="cart-summary__loyalty-chip cart-drawer__loyalty" id="cart-drawer-loyalty" hidden></p>
                <div class="cart-drawer__body">
                    <ul class="cart-drawer__lines" id="cart-drawer-lines"></ul>
                    <section class="cart-drawer__upsell" id="cart-drawer-upsell" hidden aria-labelledby="cart-drawer-upsell-title">
                        <h3 class="cart-drawer__upsell-title" id="cart-drawer-upsell-title">You may also like</h3>
                        <ul class="cart-drawer__upsell-list"></ul>
                    </section>
                </div>
                <div class="cart-drawer__foot">
                    <dl class="cart-drawer__totals" id="cart-drawer-totals"></dl>
                    <div class="cart-drawer__freeship" id="cart-drawer-freeship" hidden></div>
                    <a href="/cart" class="btn btn--outline btn--full-width cart-drawer__view" data-track="cta_click" data-track-cta="drawer_view_cart">View cart</a>
                    <a href="/checkout" class="btn btn--primary btn--full-width cart-drawer__checkout" data-track="cta_click" data-track-cta="drawer_checkout">Checkout</a>
                </div>
            </aside>`;
        document.body.appendChild(root);
        this.root = root;

        root.addEventListener('click', (e) => {
            if (e.target.closest('[data-drawer-close]')) { this.close(); return; }
            const step = e.target.closest('[data-drawer-step]');
            if (step) { this._step(step); return; }
            const rm = e.target.closest('[data-drawer-remove]');
            if (rm && !rm.disabled) {
                rm.disabled = true;
                Cart.removeItem(rm.dataset.drawerRemove);
            }
        });
        root.addEventListener('keydown', (e) => this._onKey(e));
    },

    open: function() {
        this._mount();
        if (!this.isOpen()) {
            this._returnFocus = document.activeElement;
            this.root.hidden = false;
            document.documentElement.classList.add('cart-drawer-open');
            // Next frame, so the slide transition runs from off-screen.
            requestAnimationFrame(() => {
                this.root.classList.add('is-open');
                this.root.querySelector('.cart-drawer__panel').focus();
            });
        }
        this.refresh();
    },

    close: function() {
        if (!this.isOpen()) return;
        this.root.classList.remove('is-open');
        document.documentElement.classList.remove('cart-drawer-open');
        setTimeout(() => { if (!this.isOpen()) this.root.hidden = true; }, 250);
        const back = this._returnFocus;
        this._returnFocus = null;
        if (back && typeof back.focus === 'function' && document.contains(back)) back.focus();
    },

    _onKey: function(e) {
        if (e.key === 'Escape') { e.preventDefault(); this.close(); return; }
        if (e.key !== 'Tab') return;
        const focusables = Array.from(this.root.querySelectorAll(
            'a[href], button:not([disabled]), select, input, [tabindex]:not([tabindex="-1"])'
        )).filter((el) => el.offsetParent !== null);
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    },

    /** Qty buttons: the debounced cart path, capped by Cart.maxQuantityFor. */
    _step: function(btn) {
        const key = btn.dataset.key;
        const line = Cart._lineFor(key);
        if (!line) return;
        const next = line.quantity + (btn.dataset.drawerStep === 'up' ? 1 : -1);
        if (next < 1 || next > Cart.maxQuantityFor(line)) return;
        Cart._debouncedQuantityUpdate(key, next);
        this.refresh();
    },

    /** Repaint from Cart state. Called by Cart.updateUI / _updateCartSummaryDOM. */
    refresh: function() {
        if (!this.isOpen() && !(this.root && !this.root.hidden)) return;
        const items = Array.isArray(Cart.items) ? Cart.items : [];
        const list = this.root.querySelector('#cart-drawer-lines');
        list.innerHTML = items.length
            ? items.map((item) => this._lineHtml(item)).join('')
            : '<li class="cart-drawer__empty">Your cart is empty.</li>';
        if (typeof Cart.bindImageFallbacks === 'function') Cart.bindImageFallbacks(list);
        this.root.querySelector('#cart-drawer-totals').innerHTML = this._totalsHtml(items);
        const freeship = this.root.querySelector('#cart-drawer-freeship');
        if (freeship) {
            const html = items.length ? this._freeShipHtml() : '';
            freeship.innerHTML = html;
            freeship.hidden = !html;
            if (html && typeof Cart.bindImageFallbacks === 'function') Cart.bindImageFallbacks(freeship);
        }
        this.root.querySelector('.cart-drawer__foot').hidden = !items.length;
        // Same chip as the cart page, same writer (ERR-333); no message ⇒ hidden.
        const chip = this.root.querySelector('#cart-drawer-loyalty');
        if (items.length && typeof Cart._fillLoyaltyChip === 'function') Cart._fillLoyaltyChip(chip);
        else chip.hidden = true;
        this._renderUpsell();
    },

    _lineHtml: function(item) {
        const key = item.key || item.id;
        const name = (typeof ProductName !== 'undefined') ? ProductName.clean(item) : (item.name || '');
        const max = Cart.maxQuantityFor(item);
        const k = Security.escapeAttr(String(key));
        return `
            <li class="cart-drawer__line" data-item-key="${k}">
                <div class="cart-drawer__thumb">${Cart.getItemImageHTML(item)}</div>
                <div class="cart-drawer__info">
                    <div class="cart-drawer__row">
                        <span class="cart-drawer__name">${Security.escapeHtml(name)}</span>
                        <span class="cart-drawer__price">${Cart.lineTotalHtml(item)}</span>
                    </div>
                    <div class="cart-drawer__controls">
                        <div class="cart-drawer__qty" role="group" aria-label="Quantity for ${Security.escapeAttr(name)}">
                            <button type="button" data-drawer-step="down" data-key="${k}" aria-label="Decrease quantity"${item.quantity <= 1 ? ' disabled' : ''}>&minus;</button>
                            <span aria-live="polite">${Security.escapeHtml(String(item.quantity))}</span>
                            <button type="button" data-drawer-step="up" data-key="${k}" aria-label="Increase quantity"${item.quantity >= max ? ' disabled' : ''}>+</button>
                        </div>
                        <button type="button" class="cart-drawer__remove" data-drawer-remove="${k}">
                            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>
                            Remove
                        </button>
                    </div>
                </div>
            </li>`;
    },

    /**
     * Under the total (checklist item 23c, ERR-371): the server's
     * `summary.free_shipping_message`, AS IT IS, whenever
     * `summary.free_shipping_remaining` is above 0 — and nothing at 0 or while
     * a change is in flight (no stale gap). Never a gap computed here, never
     * "save" wording. When `free_shipping_unlock` is present (gap ≤ $25) its
     * filler tiles go under the line, from the cart page's own builder. A
     * quantity change repaints this from the PUT's own data.cart (Cart adopts
     * it, then calls refresh()).
     */
    _freeShipHtml: function() {
        if (typeof Cart._summaryPending === 'function' && Cart._summaryPending()) return '';
        if (!Cart.hasServerPricing || !Cart.hasServerPricing()) return '';
        const s = Cart.serverSummary || {};
        const msg = typeof s.free_shipping_message === 'string' ? s.free_shipping_message.trim() : '';
        if (!msg || !(Number(s.free_shipping_remaining) > 0)) return '';
        const unlock = Cart.serverCartMeta && Cart.serverCartMeta.free_shipping_unlock;
        const tiles = (unlock && !unlock.qualifies && Array.isArray(unlock.suggested_products)
            && typeof Cart.freeShipChipsHtml === 'function')
            ? Cart.freeShipChipsHtml(unlock.suggested_products.slice(0, 3), 'drawer') : '';
        return `<p class="cart-drawer__freeship-msg">${Security.escapeHtml(msg)}</p>`
            + (tiles ? `<div class="cart-addon-row cart-drawer__freeship-tiles">${tiles}</div>` : '');
    },

    /** Server figures only; every other state is said in words. */
    _totalsHtml: function(items) {
        const count = typeof Cart.getItemCount === 'function' ? Cart.getItemCount() : items.length;
        const label = `Subtotal (${count} item${count === 1 ? '' : 's'})`;
        let value;
        let state;
        if (typeof Cart._summaryPending === 'function' && Cart._summaryPending()) {
            value = 'Updating…'; state = 'pending';
        } else if (Cart.hasServerPricing()) {
            value = formatPrice(Cart.serverSummary.subtotal); state = 'server';
        } else {
            value = 'Confirmed in cart'; state = 'unpriced';
        }
        const s = Cart.serverSummary;
        const discount = state === 'server' && s && Number(s.discount) > 0
            ? `<div class="cart-drawer__total-row"><dt>Discount</dt><dd>&minus;${formatPrice(s.discount)}</dd></div>`
            : '';
        const note = state === 'unpriced'
            ? 'We could not confirm prices just now. Your cart shows the checked total.'
            : 'Prices include GST. Shipping calculated at checkout.';
        return `
            <div class="cart-drawer__total-row cart-drawer__total-row--main" data-pricing="${state}"><dt>${label}</dt><dd>${Security.escapeHtml(value)}</dd></div>
            ${discount}
            <p class="cart-drawer__note">${note}</p>`;
    },

    async _loadUpsell(detail) {
        const sku = detail && detail.sku;
        if (!sku || sku === this._upsellFor) return;
        this._upsellFor = sku;
        let rows = [];
        try {
            if (detail.crossSell && typeof Cart._crossSellProducts === 'function') {
                rows = await Cart._crossSellProducts(detail.crossSell);
            }
            if (!rows.length && typeof API !== 'undefined' && typeof API.getRelatedProducts === 'function') {
                const res = await API.getRelatedProducts(sku);
                const d = res && res.ok ? res.data : null;
                rows = Array.isArray(d) ? d : (d && (d.products || d.related)) || [];
            }
        } catch (_) { rows = []; }
        if (this._upsellFor !== sku) return; // a newer add owns the section
        this._upsell = rows;
        this._renderUpsell();
    },

    _renderUpsell: function() {
        const section = this.root && this.root.querySelector('#cart-drawer-upsell');
        if (!section) return;
        const inCart = new Set((Cart.items || []).map((i) => i.sku));
        const rows = (this._upsell || []).filter((p) => p && p.sku && !inCart.has(p.sku)
            && p.retail_price != null && getStockStatus(p).class !== 'contact-us').slice(0, this.UPSELL_MAX);
        section.hidden = !rows.length;
        section.querySelector('.cart-drawer__upsell-list').innerHTML = rows.map((p) => this._upsellHtml(p)).join('');
    },

    _upsellHtml: function(p) {
        const img = typeof storageUrl === 'function' ? storageUrl(p.image_url) : (p.image_url || '');
        const name = (typeof ProductName !== 'undefined') ? ProductName.clean(p) : (p.name || '');
        let link = p.slug ? `/products/${encodeURIComponent(p.slug)}/${encodeURIComponent(p.sku)}` : `/p/${encodeURIComponent(p.sku)}`;
        if (p.canonical_url) {
            try { link = new URL(p.canonical_url).pathname; } catch (_) { link = p.canonical_url; }
        }
        return `
            <li class="cart-drawer__upsell-item">
                <a class="cart-drawer__thumb" href="${Security.escapeAttr(link)}">${img ? `<img src="${Security.escapeAttr(img)}" alt="" loading="lazy">` : ''}</a>
                <div class="cart-drawer__info">
                    <a class="cart-drawer__name" href="${Security.escapeAttr(link)}">${Security.escapeHtml(name)}</a>
                    <span class="cart-drawer__upsell-price">${formatPrice(p.retail_price)}</span>
                </div>
                <button type="button" class="cart-drawer__upsell-add add-to-cart-btn"
                    data-product-id="${Security.escapeAttr(p.id || '')}"
                    data-product-sku="${Security.escapeAttr(p.sku)}"
                    data-product-name="${Security.escapeAttr(p.name || '')}"
                    data-product-price="${Security.escapeAttr(String(p.retail_price))}"
                    data-product-image="${Security.escapeAttr(img || '')}"
                    data-product-color="${Security.escapeAttr(p.color || '')}"
                    data-product-source="${Security.escapeAttr(p.source || '')}"
                    aria-label="Add ${Security.escapeAttr(name)} to cart">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.7 13.4a2 2 0 002 1.6h9.7a2 2 0 002-1.6L23 6H6"/></svg>
                </button>
            </li>`;
    },
};

if (typeof window !== 'undefined') {
    window.CartDrawer = CartDrawer;
    if (typeof document !== 'undefined' && document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => CartDrawer.init());
    } else if (typeof document !== 'undefined') {
        CartDrawer.init();
    }
}
if (typeof module !== 'undefined' && module.exports) module.exports = CartDrawer;
