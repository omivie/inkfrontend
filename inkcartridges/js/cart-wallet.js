/**
 * Apple Pay / Google Pay straight from the cart (ERR-305)
 * =============================================================================
 * FE master checklist (5 Oct 2026) item 2. The wallet button used to appear
 * only on /payment, after the shopper had typed name, email, phone and
 * address. Here it sits under "Proceed to Checkout" and the wallet sheet
 * supplies all of that, so cart → paid order takes no typing.
 *
 * SHIPS OFF. Enabled only when Config.DARK_FEATURES.cartWallet === true, or for
 * one visit with /cart?wallet=1 (the owner's real-device test). It takes
 * payments and we cannot drive a real Apple Pay sheet from a test browser, so
 * the first real order must be the owner's, not a customer's.
 *
 * ONE ORDER PATH. The order is created by PaymentPage.createStripeOrder — the
 * same function, with the same duplicate / idempotency / error-code triage, that
 * the card form and the /payment wallet row use. payment-page.js is loaded
 * lazily (only when the wallet is enabled) and its bootstrap does nothing off
 * /payment. We call it on a context made with Object.create(PaymentPage), which
 * carries this sale's cartItems / checkoutData / totals / turnstileToken and
 * overrides the three UI hooks (showError, showEmailVerificationRequired,
 * resetTurnstile) so their messages land on the cart.
 *
 * MONEY. Every figure comes from the server: the cart summary (subtotal,
 * discount, total, shipping estimate) and POST /api/shipping/options for the
 * address the wallet hands us. The sheet's total is subtotal − discount + the
 * server's fee for that address: the SAME display arithmetic payment-page.js
 * does for its own wallet row. The charge itself is the PaymentIntent the
 * backend creates at POST /api/orders, priced server-side.
 *
 * REGION. The wallet gives `state` (administrativeArea), which NZ wallets
 * often leave blank. We match it against the checkout's 16 regions and send
 * the slug when it matches. When it does not, the order goes WITHOUT a region
 * — never a guess: a wrong region is a wrong delivery record. BF-100 (backend,
 * 2026-10-06): `shipping_address.region` is optional; POST /api/orders zones
 * by `postal_code` first, exactly as /api/shipping/options does, and stores
 * `shipping_region` empty. `city` and a 4-digit `postal_code` stay required.
 * delivery_type is OMITTED, never guessed (the ERR-25x rule payment-page.js
 * documents): the order is priced at the URBAN rate for the postcode's zone and
 * `orders.delivery_type` stays NULL. The sheet asks /api/shipping/options
 * without delivery_type too, so the figure shown is the figure charged. A
 * rural wallet address therefore pays the urban rate — accepted by the owner.
 *
 * GUEST BOT CHECK. POST /api/orders needs a Turnstile token for a guest. An
 * invisible widget runs as soon as the wallet mounts and re-runs every 240s
 * (tokens live 300s). The sheet cannot open while we wait (Stripe's `click`
 * must resolve synchronously-ish), so a tap before the token exists says so
 * and asks for a second tap.
 */
const CartWallet = {
    STRIPE_JS: 'https://js.stripe.com/v3/',
    TURNSTILE_JS: 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit',
    // UNVERSIONED on purpose. The deploy stamp rewrites ?v= in HTML only, so a
    // token written here would go stale on the next payment-page.js change and
    // be served immutable (tests/page-load-latency-sep2026.test.js §2). An
    // unversioned URL revalidates on every load, so it is always this build.
    PAYMENT_PAGE_JS: '/js/payment-page.js',
    STRIPE_MIN_NZD_CENTS: 50,
    READY_TIMEOUT_MS: 8000,
    TURNSTILE_REFRESH_MS: 240000,

    /** checkout.html's region <select> values — the slugs the order API takes. */
    REGIONS: ['northland', 'auckland', 'waikato', 'bay-of-plenty', 'gisborne', 'hawkes-bay',
        'taranaki', 'manawatu-wanganui', 'wellington', 'tasman', 'nelson', 'marlborough',
        'west-coast', 'canterbury', 'otago', 'southland'],

    state: 'off',          // off | loading | ready | none | error — mirrored to data-wallet
    stripe: null,
    elements: null,
    ece: null,
    shipping: null,        // last server answer for the wallet's address
    turnstileToken: null,
    turnstileWidgetId: undefined,
    _refreshTimer: null,

    /** PURE. Flag on, or ?wallet=1 for one visit. */
    isEnabled(config, search) {
        if (config && config.DARK_FEATURES && config.DARK_FEATURES.cartWallet === true) return true;
        try { return new URLSearchParams(search || '').get('wallet') === '1'; } catch (_) { return false; }
    },

    /**
     * PURE. A wallet `state` → one of REGIONS, or '' when it is not one.
     * Same folding as AddressAutocomplete._slugifyRegion (address-autocomplete.js),
     * which the cart page does not load.
     */
    regionSlug(value) {
        if (!value) return '';
        let slug = String(value).toLowerCase()
            .normalize('NFD').replace(/[̀-ͯ]/g, '')
            .replace(/['’]/g, '').replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
            .replace(/-region$/, '');
        if (slug === 'manawatu-whanganui') slug = 'manawatu-wanganui';
        return this.REGIONS.includes(slug) ? slug : '';
    },

    /** PURE. The backend requires a 4-digit postal_code (BF-100). */
    isNzPostcode(value) {
        return /^\d{4}$/.test(String(value == null ? '' : value).trim());
    },

    /**
     * PURE. The wallet's confirm payload → the checkoutData shape that
     * PaymentPage.createStripeOrder reads. Returns { data } or { error }.
     */
    toCheckoutData(ev, shipping) {
        const ship = (ev && ev.shippingAddress) || {};
        const addr = ship.address || {};
        const bill = (ev && ev.billingDetails) || {};
        const name = String(ship.name || bill.name || '').trim().replace(/\s+/g, ' ');
        const cut = name.lastIndexOf(' ');
        const region = this.regionSlug(addr.state);
        if (String(addr.country || '').toUpperCase() !== 'NZ') return { error: 'We deliver within New Zealand only.' };
        if (!name || !addr.line1 || !addr.city || !addr.postal_code) return { error: 'That address is incomplete.' };
        if (!this.isNzPostcode(addr.postal_code)) return { error: 'That postcode is not a 4-digit New Zealand postcode.' };
        if (!bill.email) return { error: 'Your wallet did not share an email address.' };
        if (!shipping || !Number.isFinite(shipping.fee)) return { error: 'We could not price delivery to that address.' };
        return {
            data: {
                firstName: cut > 0 ? name.slice(0, cut) : name,
                lastName: cut > 0 ? name.slice(cut + 1) : '',
                email: String(bill.email).trim(),
                phone: String(bill.phone || ship.phone || '').trim(),
                address1: addr.line1,
                address2: addr.line2 || '',
                city: addr.city,
                region,   // '' when `state` matched none — payment-page omits it (BF-100)
                postcode: String(addr.postal_code).trim(),
                // deliveryType: OMITTED — never guessed (see header).
                estimatedShipping: shipping.fee,
                shippingTier: shipping.tier || '',
                shippingZone: shipping.zone || '',
                // A wallet address is not saved to the account behind the shopper's back.
                saveAddress: false,
                orderNotes: '',
                source: 'cart-wallet',
            },
        };
    },

    _box() { return document.getElementById('cart-wallet'); },

    _setState(state, why) {
        this.state = state;
        this.why = why || '';
        const box = this._box();
        if (box) {
            box.dataset.wallet = state;
            if (why) box.dataset.walletWhy = why;
            box.hidden = state !== 'ready';
        }
    },

    _say(text) {
        const el = document.getElementById('cart-wallet-status');
        if (!el) return;
        el.textContent = text || '';
        el.hidden = !text;
    },

    _load(src, test) {
        if (test()) return Promise.resolve(true);
        return new Promise((resolve) => {
            const s = document.createElement('script');
            s.src = src;
            s.async = true;
            s.onload = () => resolve(test());
            s.onerror = () => resolve(false);
            document.head.appendChild(s);
        });
    },

    _summary() { return (typeof Cart !== 'undefined' && Cart.serverSummary) || null; },

    /** Server cents for subtotal − discount + fee, or NaN when any part is missing. */
    _amountCents(fee) {
        const s = this._summary() || {};
        const ok = (n) => typeof n === 'number' && Number.isFinite(n);
        if (!ok(s.subtotal) || !ok(s.discount) || !ok(fee)) return NaN;
        return Math.round((s.subtotal - s.discount + fee) * 100);
    },

    /** The cart's own estimate, as the sheet's first shipping rate. */
    _initialRate() {
        const s = this._summary() || {};
        const fee = s.qualifies_for_free_shipping === true ? 0
            : (typeof s.shipping === 'number' && Number.isFinite(s.shipping) ? s.shipping : NaN);
        if (!Number.isFinite(fee)) return null;
        return { id: 'nz-standard', displayName: fee === 0 ? 'Free NZ delivery' : 'NZ delivery (estimate)', amount: Math.round(fee * 100) };
    },

    _items() {
        return ((typeof Cart !== 'undefined' && Cart.items) || []).map((i) => ({ product_id: i.id, quantity: i.quantity }));
    },

    async init() {
        const box = this._box();
        if (!box) return;
        if (!this.isEnabled(typeof Config !== 'undefined' ? Config : null, window.location.search)) {
            this._setState('off', 'flag');
            return;
        }
        this._setState('loading');
        if (typeof CartDeepLink !== 'undefined' && CartDeepLink._waitForCartReady) await CartDeepLink._waitForCartReady();

        const rate = this._initialRate();
        const cents = rate ? this._amountCents(rate.amount / 100) : NaN;
        if (!this._items().length || !(cents >= this.STRIPE_MIN_NZD_CENTS)) {
            this._setState('none', 'no-server-total');
            return;
        }

        const okStripe = await this._load(this.STRIPE_JS, () => typeof Stripe === 'function');
        const okPage = await this._load(this.PAYMENT_PAGE_JS, () => typeof PaymentPage !== 'undefined');
        if (!okStripe || !okPage || typeof Config === 'undefined' || !Config.STRIPE_PUBLISHABLE_KEY) {
            this._setState('error', !okStripe ? 'stripe-js' : (!okPage ? 'payment-page-js' : 'no-key'));
            return;
        }

        this.isGuest = typeof Auth === 'undefined' || !Auth.isAuthenticated();
        if (this.isGuest) this._startTurnstile();

        this.stripe = Stripe(Config.STRIPE_PUBLISHABLE_KEY);
        this.elements = this.stripe.elements({ mode: 'payment', amount: cents, currency: 'nzd' });
        this.ece = this.elements.create('expressCheckout', {
            // 'always' — see payment-page.js initExpressCheckout (ERR-268).
            paymentMethods: { applePay: 'always', googlePay: 'always', link: 'never' },
            emailRequired: true,
            phoneNumberRequired: true,
            shippingAddressRequired: true,
            allowedShippingCountries: ['NZ'],
            buttonHeight: 48,
        });

        const timer = setTimeout(() => { if (this.state === 'loading') this._setState('error', 'ready-timeout'); }, this.READY_TIMEOUT_MS);
        this._amount = cents;
        this.ece.on('ready', ({ availablePaymentMethods: apm } = {}) => {
            clearTimeout(timer);
            const any = apm && Object.values(apm).some(Boolean);
            this._deviceHasWallet = !!any;
            this._setState(any ? 'ready' : 'none', any ? '' : 'no-wallet-on-device');
        });

        this.ece.on('click', (event) => {
            if (this.isGuest && !this.turnstileToken) {
                this._say('One moment — finishing a quick security check. Tap again in a few seconds.');
                return; // not resolved ⇒ the sheet stays closed
            }
            this._say('');
            const first = this._initialRate();
            event.resolve({ shippingRates: [first] });
        });

        this.ece.on('shippingaddresschange', async (event) => {
            const a = event.address || {};
            if (String(a.country || '').toUpperCase() !== 'NZ' || !this.isNzPostcode(a.postal_code)) { event.reject(); return; }
            try {
                const s = this._summary() || {};
                const res = await API.getShippingOptions({ cart_total: s.subtotal, items: this._items(), postal_code: a.postal_code });
                const opt = res && res.ok && res.data ? (res.data.selected || (res.data.options || [])[0] || res.data) : null;
                const fee = opt && Number(opt.fee);
                const amount = this._amountCents(fee);
                if (!opt || !Number.isFinite(fee) || !(amount >= this.STRIPE_MIN_NZD_CENTS)) { event.reject(); return; }
                this.shipping = { fee, tier: opt.tier || '', zone: opt.zone || '', zoneLabel: opt.zone_label || '' };
                this.elements.update({ amount });
                event.resolve({
                    shippingRates: [{
                        id: 'nz-' + (opt.zone || 'standard'),
                        displayName: fee === 0 ? 'Free delivery' : ((opt.zone_label || 'NZ') + ' delivery'),
                        amount: Math.round(fee * 100),
                    }],
                });
            } catch (_) {
                event.reject();
            }
        });

        this.ece.on('confirm', (event) => this._confirm(event));
        this.ece.mount('#cart-wallet-element');
    },

    /**
     * Follow the cart after page load. init() decides ONCE, at DOMContentLoaded;
     * a cart that was empty or unpriced at that moment (the /cart?add= reorder
     * link fills it AFTER load — FE master checklist item 12's traffic) left the
     * wallet at none/no-server-total for the rest of the visit. Measured on www
     * on 6 Oct, the evening it went live for every shopper (item 2, ERR-309).
     * Called by Cart._paintSummaryPending() — the last step of BOTH summary
     * renderers — whenever the cart holds a settled server total.
     */
    sync() {
        if (this.state === 'off' || this.state === 'loading' || this.state === 'error') return;
        const rate = this._initialRate();
        const cents = rate ? this._amountCents(rate.amount / 100) : NaN;
        const eligible = this._items().length > 0 && cents >= this.STRIPE_MIN_NZD_CENTS;
        if (!this.ece) {
            // Never mounted: only the "no total yet" refusal is retried.
            if (eligible && this.why === 'no-server-total') this.init();
            return;
        }
        if (!eligible) {
            if (this.state === 'ready') this._setState('none', 'no-server-total');
            return;
        }
        // The sheet opens on the cart's CURRENT total, not the one at load.
        if (cents !== this._amount) {
            this.elements.update({ amount: cents });
            this._amount = cents;
        }
        if (this.state === 'none' && this.why === 'no-server-total' && this._deviceHasWallet) this._setState('ready');
    },

    async _confirm(event) {
        const fail = (msg) => {
            try { event.paymentFailed({ reason: 'fail', ...(msg ? { message: msg } : {}) }); } catch (_) { /* sheet gone */ }
            if (msg) this._say(msg);
        };
        const built = this.toCheckoutData(event, this.shipping);
        if (built.error) { fail(built.error); return; }

        const cartItems = (typeof Cart !== 'undefined' && Cart.items) ? Cart.items.slice() : [];
        const s = this._summary() || {};
        const self = this;
        const ctx = Object.assign(Object.create(PaymentPage), {
            cartItems,
            checkoutData: built.data,
            totals: { subtotal: s.subtotal, shipping: built.data.estimatedShipping, discount: s.discount, total: this._amountCents(built.data.estimatedShipping) / 100 },
            isGuestCheckout: this.isGuest,
            turnstileToken: this.turnstileToken,
            showError(msg) { self._say(msg); },
            showEmailVerificationRequired() { self._say('Please verify your email address first, then try again.'); },
            resetTurnstile() { self._resetTurnstile(); },
        });

        try {
            const { error: submitError } = await this.elements.submit();
            if (submitError) { fail(submitError.message); return; }
            const result = await ctx.createStripeOrder('stripe-cart-wallet');
            if (result.status !== 'confirm') { fail(); return; }
            sessionStorage.setItem('lastOrder', JSON.stringify(ctx.buildOrderSnapshot(result.order_number, 'stripe')));
            const { error } = await this.stripe.confirmPayment({
                elements: this.elements,
                clientSecret: result.client_secret,
                confirmParams: {
                    return_url: `${window.location.origin}/order-confirmation?order=${encodeURIComponent(result.order_number)}`,
                },
            });
            if (error) {
                const msg = ctx.getStripeErrorMessage(error);
                sessionStorage.removeItem('lastOrder');
                this._resetTurnstile();
                try { await API.cancelOrder(result.order_number); } catch (_) { /* logged server-side */ }
                fail(msg);
            }
        } catch (err) {
            this._resetTurnstile();
            fail((err && err.message) || 'Payment failed. Please try again.');
        }
    },

    async _startTurnstile() {
        const siteKey = typeof Config !== 'undefined' && Config.TURNSTILE_SITE_KEY;
        const host = document.getElementById('cart-wallet-turnstile');
        if (!siteKey || !host) return;
        const ok = await this._load(this.TURNSTILE_JS, () => typeof turnstile !== 'undefined');
        if (!ok) { this._say('The security check could not load. Please use Proceed to Checkout.'); return; }
        host.hidden = false;
        this.turnstileWidgetId = turnstile.render(host, {
            sitekey: siteKey,
            appearance: 'interaction-only',
            'refresh-expired': 'auto',
            callback: (token) => {
                this.turnstileToken = token;
                this._say('');
                clearTimeout(this._refreshTimer);
                this._refreshTimer = setTimeout(() => this._resetTurnstile(), this.TURNSTILE_REFRESH_MS);
            },
            'expired-callback': () => { this.turnstileToken = null; },
            'error-callback': () => { this.turnstileToken = null; },
        });
    },

    _resetTurnstile() {
        this.turnstileToken = null;
        if (typeof turnstile !== 'undefined' && this.turnstileWidgetId !== undefined) {
            try { turnstile.reset(this.turnstileWidgetId); } catch (_) { /* widget gone */ }
        }
    },
};

if (typeof window !== 'undefined') {
    window.CartWallet = CartWallet;
    document.addEventListener('DOMContentLoaded', () => { CartWallet.init(); });
}
if (typeof module !== 'undefined' && module.exports) module.exports = CartWallet;
