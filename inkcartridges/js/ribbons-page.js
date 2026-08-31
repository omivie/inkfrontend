// ============================================
// RIBBONS PAGE - Brand grid → products drilldown
// ============================================

const RibbonsPage = {
    // Current state
    state: {
        brand: null,        // printer_brand value (lowercase, used for URL param and API filter)
        brandLabel: null,   // device_brand display label (e.g., "Olivetti", "Smith Corona")
        model: null,        // printer_model (specific model, used for direct URL navigation)
        ribbonBrand: null,  // manufacturer brand (API param: 'brand')
        color: null,
        sort: 'name',
        page: 1
    },

    // Navigation version to prevent race conditions
    navigationVersion: 0,

    // Products per page
    pageLimit: 48,

    // DOM Elements
    elements: {
        breadcrumbList: document.getElementById('breadcrumb-list'),
        title: document.getElementById('drilldown-title'),
        levelBrands: document.getElementById('level-brands'),
        levelProducts: document.getElementById('level-products'),
        pagination: document.getElementById('ribbon-pagination'),
        loading: document.getElementById('drilldown-loading'),
        empty: document.getElementById('drilldown-empty'),
        emptyMessage: document.getElementById('empty-message'),
        // ERR-193 — a separate pane for a request that FAILED, so an outage can
        // never be rendered in the words reserved for an empty catalogue. Same
        // three ids and the same CSS as /shop (shop-page.js), deliberately.
        error: document.getElementById('drilldown-error'),
        errorMessage: document.getElementById('error-message'),
        errorRetryBtn: document.getElementById('drilldown-retry-btn'),
        skeletonBrands: document.getElementById('skeleton-brands'),
        skeletonProducts: document.getElementById('skeleton-products')
    },

    // =========================================
    // INITIALIZATION
    // =========================================
    async init() {
        this.parseURLState();
        this.initFilterControls();
        this.syncFilterUI();

        if (this.state.brand || this.state.model) {
            // URL already has a brand or model — skip brand grid, show products directly
            this.showLevel('products');
            this.navigationVersion++;
            // Resolve proper brand label in parallel with loading products
            this.resolveBrandLabelFromAPI();
            await this.loadProducts(this.navigationVersion);
        } else {
            // No filter selected — show brand grid
            await this.loadBrands();
        }

        // Browser back/forward
        window.addEventListener('popstate', (e) => {
            if (e.state) {
                this.state = e.state;
            } else {
                this.parseURLState();
            }
            this.syncFilterUI();
            this.navigationVersion++;

            if (this.state.brand) {
                this.showLevel('products');
                this.loadProducts(this.navigationVersion);
            } else {
                this.showLevel('brands');
                this.updateBreadcrumb();
                this.updateTitle();
            }
        });

        // BFCACHE / NAVIGATION-AWAY GUARDS (bfcache-restore-may2026.md)
        // 1. `pagehide` neutralizes any in-flight catch handler so a
        //    fetch that rejects mid-navigation can't paint a sticky
        //    "Failed to load…" DOM into the bfcache snapshot.
        // 2. `pageshow` with persisted=true means the browser restored
        //    from bfcache; DOMContentLoaded did NOT fire, so any stale
        //    error/empty DOM is still visible. Re-run the loader.
        window.addEventListener('pagehide', () => {
            this._unloading = true;
            this.navigationVersion++;
        });
        window.addEventListener('pageshow', (e) => {
            this._unloading = false;
            if (!e.persisted) return;
            if (this.elements.empty) this.elements.empty.hidden = true;
            if (this.elements.error) this.elements.error.hidden = true;
            this.parseURLState();
            this.syncFilterUI();
            this.navigationVersion++;
            if (this.state.brand || this.state.model) {
                this.showLevel('products');
                this.loadProducts(this.navigationVersion);
            } else {
                this.showLevel('brands');
                this.loadBrands();
            }
        });
    },

    // =========================================
    // LEVEL MANAGEMENT
    // =========================================
    showLevel(which) {
        const levelBrands = this.elements.levelBrands;
        const levelProducts = this.elements.levelProducts;
        if (which === 'brands') {
            if (levelBrands) levelBrands.hidden = false;
            if (levelProducts) levelProducts.hidden = true;
            this.elements.empty.hidden = true;
            if (this.elements.error) this.elements.error.hidden = true;
        } else {
            if (levelBrands) levelBrands.hidden = true;
            if (levelProducts) levelProducts.hidden = false;
        }
    },

    // =========================================
    // BRAND GRID
    // =========================================
    async loadBrands() {
        const grid = document.getElementById('ribbons-brands-grid');
        if (!grid) return;

        // Show brand skeleton loading
        this.showLoadingState('brands', true);

        try {
            // Try new ribbon_brands table first, fall back to legacy API
            let brands = [];
            const res = await API.getRibbonBrandsList();

            // ERR-193 — the brand GRID had the same defect as the brand pages: a
            // failed read fell through to `brands.length === 0` and rendered "No
            // ribbon brands found." The legacy API below is a genuine fallback for
            // an EMPTY ribbon_brands table, not a substitute for a failed read, so
            // only a real failure short-circuits here.
            if (res && res.ok === false) {
                this.showLoadingState('brands', false);
                this.reportLoadFailure('ribbon_brands', res);
                this.showError(
                    "We couldn't load the ribbon brands. The server may be warming up — please try again.",
                    () => this.loadBrands()
                );
                return;
            }

            const ribbonBrands = res?.data?.brands || [];

            if (ribbonBrands.length > 0) {
                // New system — ribbon_brands table with images and sort order
                brands = ribbonBrands.map(b => ({
                    id: b.id,
                    value: b.slug || b.name.toLowerCase(),
                    label: b.name,
                    image_url: b.image_url || null,
                    ribbon_brand_id: b.id,
                }));
            } else {
                // Fallback to legacy device-brands API
                const legacyRes = await API.getRibbonBrands();
                const rawBrands = legacyRes?.data?.brands || [];
                const EXCLUDED_BRANDS = new Set(['universal']);
                brands = rawBrands
                    .filter(name => !EXCLUDED_BRANDS.has(name.toLowerCase()))
                    .map(name => ({ value: name.toLowerCase(), label: name }));
            }

            this.showLoadingState('brands', false);

            if (brands.length === 0) {
                this.showEmpty('No ribbon brands found.');
                return;
            }

            grid.innerHTML = '';
            brands.forEach((b, i) => {
                const box = document.createElement('a');
                box.className = 'drilldown-box drilldown-box--ribbon';
                box.href = `/ribbons?printer_brand=${encodeURIComponent(b.value)}`;
                box.style.animationDelay = `${i * 30}ms`;
                // Show image if available, otherwise just the label
                if (b.image_url) {
                    box.innerHTML = `
                        <img class="drilldown-box__image" src="${Security.escapeAttr(b.image_url)}" alt="${Security.escapeAttr(b.label)}" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display=''">
                        <span class="drilldown-box__label" style="display:none">${Security.escapeHtml(b.label)}</span>
                        <span class="drilldown-box__label drilldown-box__label--below">${Security.escapeHtml(b.label)}</span>
                    `;
                } else {
                    box.innerHTML = `<span class="drilldown-box__label">${Security.escapeHtml(b.label)}</span>`;
                }
                box.addEventListener('click', (e) => {
                    e.preventDefault();
                    this.navigateToBrand(b.value, b.label);
                });
                grid.appendChild(box);
            });

            this.showLevel('brands');
            this.updateBreadcrumb();
            this.updateTitle();
        } catch (e) {
            this.showLoadingState('brands', false);
            this.reportLoadFailure('ribbon_brands', { code: 'THROWN', status: null });
            this.showError(
                "We couldn't load the ribbon brands. The server may be warming up — please try again.",
                () => this.loadBrands()
            );
        }
    },

    resolveBrandLabel() {
        // If we have a brand from URL but no label, title-case it as a fallback
        // (proper label is resolved async via resolveBrandLabelFromAPI)
        if (this.state.brand && !this.state.brandLabel) {
            this.state.brandLabel = this.state.brand
                .split(/[\s-]+/)
                .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
                .join(' ');
        }
    },

    async resolveBrandLabelFromAPI() {
        // Fetch the proper label from device brands for correct casing (e.g., "IBM", "OKI")
        if (!this.state.brand) return;
        try {
            // Try new ribbon_brands table first
            const res = await API.getRibbonBrandsList();
            const ribbonBrands = res?.data?.brands || [];
            let brands;
            if (ribbonBrands.length > 0) {
                brands = ribbonBrands.map(b => ({ value: b.slug || b.name.toLowerCase(), label: b.name }));
            } else {
                const legacyRes = await API.getRibbonBrands();
                const rawBrands = legacyRes?.data?.brands || [];
                brands = rawBrands.map(name => ({ value: name.toLowerCase(), label: name }));
            }
            const match = brands.find(b => b.value === this.state.brand);
            if (match && match.label !== this.state.brandLabel) {
                this.state.brandLabel = match.label;
                this.updateTitle();
                this.updateBreadcrumb();
            }
        } catch (e) {
            // fallback title-case is already set, ignore
        }
    },


    navigateToBrand(brand, label) {
        this.state.brand = brand;
        this.state.brandLabel = label || brand;
        this.state.ribbonBrand = null;
        this.state.page = 1;
        this.updateURL();

        this.showLevel('products');
        this.navigationVersion++;
        this.loadProducts(this.navigationVersion);
        this.updateBreadcrumb();
        this.updateTitle();
    },

    goBackToBrands() {
        this.state.brand = null;
        this.state.brandLabel = null;
        this.state.ribbonBrand = null;
        this.state.page = 1;
        this.updateURL();
        window.scrollTo(0, 0);
        this.showLevel('brands');
        this.updateBreadcrumb();
        this.updateTitle();
    },

    // =========================================
    // FILTER CONTROLS
    // =========================================
    initFilterControls() {
        // Filter bar removed — no controls to initialise
    },

    syncFilterUI() {
        // Filter bar removed — nothing to sync
    },

    parseURLState() {
        const params = new URLSearchParams(window.location.search);
        this.state.brand = params.get('printer_brand');
        this.state.brandLabel = null; // resolved later from API or title-cased
        this.state.model = params.get('printer_model');
        this.state.ribbonBrand = params.get('brand');
        this.state.color = params.get('color');
        this.state.sort = params.get('sort') || 'name';
        this.state.page = parseInt(params.get('page')) || 1;
    },

    updateURL() {
        const params = new URLSearchParams();
        if (this.state.brand) params.set('printer_brand', this.state.brand);
        if (this.state.model) params.set('printer_model', this.state.model);
        if (this.state.ribbonBrand) params.set('brand', this.state.ribbonBrand);
        if (this.state.color) params.set('color', this.state.color);
        if (this.state.sort && this.state.sort !== 'name') params.set('sort', this.state.sort);
        if (this.state.page > 1) params.set('page', this.state.page);

        const newURL = params.toString()
            ? `${window.location.pathname}?${params.toString()}`
            : window.location.pathname;

        history.pushState({ ...this.state }, '', newURL);
    },

    // =========================================
    // NAVIGATION
    // =========================================
    navigateToPage(page) {
        this.navigationVersion++;
        const thisNavVersion = this.navigationVersion;
        this.state.page = page;
        this.updateURL();
        window.scrollTo(0, 0);
        this.loadProducts(thisNavVersion);
    },

    showLoadingState(type, show) {
        this.elements.loading.hidden = !show;
        if (type === 'brands') {
            if (this.elements.skeletonBrands) this.elements.skeletonBrands.hidden = !show;
            if (this.elements.skeletonProducts) this.elements.skeletonProducts.hidden = true;
        } else {
            if (this.elements.skeletonProducts) this.elements.skeletonProducts.hidden = !show;
            if (this.elements.skeletonBrands) this.elements.skeletonBrands.hidden = true;
        }
    },

    showLoading(show) {
        this.showLoadingState('products', show);
    },

    showEmpty(message) {
        // bfcache-restore-may2026.md — skip DOM mutation while unloading
        // so an in-flight fetch that rejects during navigation does not
        // paint a sticky "Failed to load…" state into the bfcache snapshot.
        if (this._unloading) return;
        if (this.elements.emptyMessage) {
            this.elements.emptyMessage.textContent = message;
        }
        this.elements.empty.hidden = false;
        if (this.elements.error) this.elements.error.hidden = true;
    },

    /**
     * Drop any previously rendered cards and pagination.
     *
     * Every early return below (failed, empty, filtered-to-nothing) leaves the
     * grid untouched otherwise, because only `renderProducts` clears it. On a
     * first paint there is nothing to leave, which is why this went unnoticed —
     * but paging, a popstate, or a retry all reach those returns with a full grid
     * already on screen, and an error pane floating above the previous brand's
     * ribbons reads as though those ribbons are the answer.
     */
    clearProductGrids() {
        const container = this.elements.levelProducts;
        if (container) {
            container.querySelectorAll('.ribbon-section-heading, .ribbon-products-grid')
                .forEach(el => el.remove());
        }
        if (this.elements.pagination) this.elements.pagination.innerHTML = '';
    },

    /**
     * The pane for a request that FAILED — never the one above.
     *
     * ERR-193. `showEmpty` and this function used to be the same function, and on
     * 2026-08-29 a column grant changed, `get_ribbons_by_brand` began answering
     * 401, and every one of the 63 ribbon brand pages told visitors "No ribbons
     * found for Brother yet. Check back soon!" for 44 hours. That sentence is
     * correct for the ten brands we genuinely have no ribbons for, and a lie for
     * an outage; the two cases had the same words, no retry, and no signal.
     *
     * Ported from shop-page.js, whose /shop equivalent has had this since May
     * 2026 — including the three details that matter: the bfcache `_unloading`
     * guard (so a fetch rejecting mid-navigation cannot paint a sticky error into
     * the snapshot), replacing the button by cloning rather than stacking
     * listeners, and bumping `navigationVersion` on retry so a zombie in-flight
     * response from the failed attempt cannot paint over the new one.
     *
     * @param {string} message   what the shopper reads
     * @param {Function} onRetry called with the fresh navigationVersion
     */
    showError(message, onRetry) {
        if (this._unloading) return;
        if (!this.elements.error) {
            // Degrade to the empty pane rather than showing nothing at all, but
            // with wording that still says "failed" — a legacy DOM without the
            // pane must not silently inherit the bug this function exists to fix.
            this.showEmpty(message || 'Failed to load ribbons. Please try again.');
            return;
        }
        if (this.elements.errorMessage && message) {
            this.elements.errorMessage.textContent = message;
        }
        this.elements.empty.hidden = true;
        this.elements.error.hidden = false;

        const btn = this.elements.errorRetryBtn;
        if (btn && typeof onRetry === 'function') {
            const fresh = btn.cloneNode(true);
            btn.parentNode.replaceChild(fresh, btn);
            this.elements.errorRetryBtn = fresh;
            fresh.addEventListener('click', async () => {
                if (this._unloading) return;
                fresh.disabled = true;
                try {
                    this.elements.error.hidden = true;
                    this.showLoading(true);
                    this.navigationVersion++;
                    await onRetry(this.navigationVersion);
                } finally {
                    fresh.disabled = false;
                }
            });
        }
    },

    /**
     * Report a catalogue read that failed, through the channel that actually
     * carries it.
     *
     * WHY THIS FUNCTION EXISTS AT ALL. `DebugLog` is a no-op anywhere but
     * localhost — every one of its methods is gated on `_isDev` (utils.js). So
     * the `DebugLog.error` this page already had emitted precisely nothing in
     * production, and that is a large part of why a 44-hour outage across all 63
     * brand pages produced no alert, no error-rate change and nothing in any log.
     * A signal that only fires on the developer's laptop is not a signal, and the
     * hand-off's suggested fix — "a DebugLog.error rather than a warn" — would
     * have changed nothing at all.
     *
     * ONE CHANNEL, NOT TWO, AND THE MISSING ONE IS NAMED. The house dual-send
     * (rewards-nudge.js) is GA plus our own first-party tracker. GA takes an
     * arbitrary event name and is used here. The first-party tracker CANNOT carry
     * this yet — measured against production 2026-09-01:
     *
     *   POST /api/analytics/traffic-event {"event_type":"catalogue_load_failed"}
     *     → 400 VALIDATION_FAILED: "event_type" must be one of [pageview, click]
     *
     * That is an honest rejection rather than a silent drop, which is to its
     * credit, but it means a `TrafficTracker.send` here would 400 on every single
     * failure and record nothing. Shipping a call that cannot succeed is how a
     * page comes to believe it is instrumented when it is not — the same shape as
     * the DebugLog line above it. So it is not shipped, the gap is written down,
     * and `npm run probe:ribbon-brands` watches the enum in both directions so
     * the day the backend widens it is the day we find out. The ask is BF-053 in
     * ribbon-brand-pages-FE-response-aug2026.md.
     *
     * Sending this as `click` instead was considered and rejected: it would file
     * an interaction the visitor never performed and corrupt the click metrics
     * this endpoint exists to collect. A gap is recoverable; a fabricated row
     * that looks right is not.
     */
    reportLoadFailure(surface, res) {
        const props = {
            surface,
            code: (res && res.code) || 'UNKNOWN',
            status: (res && res.status) || null,
            brand: this.state.brand || null,
        };
        try { if (typeof DebugLog !== 'undefined') DebugLog.error('[Ribbons] load failed:', props); } catch (_) {}
        try { if (typeof gtag === 'function') gtag('event', 'catalogue_load_failed', props); } catch (_) {}
    },

    // =========================================
    // PRODUCTS
    // =========================================
    normalizeRibbon(ribbon) {
        if (!ribbon.image_url && ribbon.image_path) {
            const p = ribbon.image_path;
            ribbon.image_url = typeof storageUrl === 'function' ? storageUrl(p) : p;
        } else if (ribbon.image_url && !ribbon.image_url.startsWith('http') && typeof storageUrl === 'function') {
            ribbon.image_url = storageUrl(ribbon.image_url);
        }
        // Respect real stock signals so out-of-stock / contact-only ribbons are
        // not falsely shown as buyable (MC audit, Jul 2026). Only default to
        // in-stock when the API gives us NOTHING to go on, so we don't regress
        // every ribbon to "Contact us" if the feed omits stock fields entirely.
        if (ribbon.stock_status == null && ribbon.in_stock == null && ribbon.stock_quantity == null) {
            ribbon.in_stock = true;
        }
        if (ribbon.retail_price == null && ribbon.sale_price != null) {
            ribbon.retail_price = ribbon.sale_price;
        }
        if (typeof ribbon.brand === 'string') {
            ribbon._brandName = ribbon.brand;
        } else if (ribbon.brand?.name) {
            ribbon._brandName = ribbon.brand.name;
        } else {
            ribbon._brandName = '';
        }
        return ribbon;
    },

    // =========================================
    // BRAND-BRANCH FILTERING (FE-3)
    // =========================================
    //
    // `get_ribbons_by_brand` takes a slug and NOTHING else: no sort, no page, no
    // colour, no manufacturer. The `params` object below was built on every load
    // and then thrown away on the brand branch, so `?sort=`, `?color=`, `?brand=`
    // and `?page=` were silently dropped from every `?printer_brand=` URL — the
    // link looked filtered, rows came back, and none of the filtering happened.
    //
    // Doing it in the browser is EXACT here rather than an approximation, and that
    // is the only reason it is allowed: the RPC returns the brand's COMPLETE,
    // unpaginated set, and the largest brand is Epson at 25 rows against a page
    // size of 48 (measured across all 63 brands, 2026-08-31). Filtering one page
    // of a paginated set client-side would be the ERR-190 trap; filtering a whole
    // set is just filtering.

    /** Sale price if there is one, else retail, else null — never a confident 0. */
    rowPrice(r) {
        const raw = (r && r.sale_price != null) ? r.sale_price : (r && r.retail_price);
        if (raw == null || raw === '') return null;
        const n = Number(raw);
        return Number.isFinite(n) ? n : null;
    },

    /**
     * Sort a complete row set using the API's own `sort=` vocabulary, so one URL
     * means the same thing on both branches. Measured working on /api/ribbons:
     * `name`, `price_asc`, `price_desc`.
     */
    sortRows(rows, sort) {
        const byName = (a, b) => String(a.name || '')
            .localeCompare(String(b.name || ''), 'en-NZ', { sensitivity: 'base' });
        if (sort !== 'price_asc' && sort !== 'price_desc') return rows.slice().sort(byName);
        const dir = sort === 'price_asc' ? 1 : -1;
        return rows.slice().sort((a, b) => {
            const pa = this.rowPrice(a);
            const pb = this.rowPrice(b);
            // A ribbon with no readable price is UNKNOWN, not free and not dearest,
            // so it sorts to the end whichever way the list points — rather than
            // heading the cheapest list at $0 (the ERR-068 shape).
            if (pa === null && pb === null) return byName(a, b);
            if (pa === null) return 1;
            if (pb === null) return -1;
            return (pa - pb) * dir || byName(a, b);
        });
    },

    /** Colour + manufacturer-brand filtering over a complete set. */
    filterRows(rows) {
        let out = rows;
        if (this.state.color) {
            const want = String(this.state.color).trim().toLowerCase();
            out = out.filter(r => String(r.color || '').trim().toLowerCase() === want);
        }
        if (this.state.ribbonBrand) {
            const want = String(this.state.ribbonBrand).trim().toLowerCase();
            out = out.filter(r => String(r._brandName || '').trim().toLowerCase() === want);
        }
        return out;
    },

    /**
     * Copy the two fields the RPC cannot supply onto rows it did.
     *
     * ONLY these two cross over. Price and stock are NOT copied, even though the
     * two payloads were measured to agree on all 82 shared SKUs (2026-08-31): the
     * RPC row is this page's source of truth for what a ribbon costs, and a second
     * opinion quietly overwriting it is how one surface starts quoting a different
     * price from another. If they ever disagree we want to find out loudly, from
     * the probe, not to have papered over it here.
     *
     * @returns {number} rows that gained a ladder
     */
    applyLadders(rows, bySku) {
        if (!bySku || typeof bySku.get !== 'function') return 0;
        let applied = 0;
        for (const r of rows) {
            const sku = (r && typeof r.sku === 'string') ? r.sku.trim() : '';
            if (!sku) continue;
            const info = bySku.get(sku);
            if (!info) continue;
            // Absence stays absence (business.js ingest contract): a row we have
            // no ladder for gets no key at all, so it falls through to the authed
            // route rather than reporting a confident "no discount available".
            if (Array.isArray(info.quantity_breaks)) {
                r.quantity_breaks = info.quantity_breaks;
                applied++;
            }
            if (info.brand && !r._brandName) r._brandName = info.brand;
        }
        return applied;
    },

    /**
     * FE-2 — attach the volume ladder to an already-painted brand page.
     *
     * The RPC carries no `quantity_breaks[]`, so `Business.ingest()` received
     * nothing here and a guest — who by design fires no `/api/business/*` request
     * — saw no volume pricing on any brand page, while the same ribbon showed its
     * ladder on `/ribbons` and on its own PDP. One cached `GET /api/ribbons`
     * covers all 82 SKUs that appear across the 63 brand pages (measured 82/82).
     *
     * Deliberately runs AFTER the paint and never blocks it: the cards are correct
     * without the ladder, just less generous, so there is no reason to make anyone
     * wait for it. The overlay is added by patching the cards in place — this must
     * never re-render the grid under the visitor (ERR-179).
     */
    async hydrateLadders(rows, container, navVersion) {
        if (!rows.length || typeof API.getRibbonLadders !== 'function') return;
        const res = await API.getRibbonLadders();
        // The page may have moved on, or be unloading, while that was in flight.
        if (this.navigationVersion !== navVersion || this._unloading) return;
        if (!res || !res.ok) {
            // Not shown to the shopper: a missing bulk-price overlay is an absent
            // upsell, not a wrong page. But it IS reported, because "the ladder
            // quietly stopped appearing" is exactly the class of silence this
            // whole entry exists to end.
            this.reportLoadFailure('ribbon_ladders', res);
            return;
        }
        if (!this.applyLadders(rows, res.bySku)) return;

        // Patch, don't repaint. The brand name only ever ARRIVES here, so the
        // favourites button shipped data-product-brand="" on every brand page.
        container.querySelectorAll('.product-card[data-sku]').forEach(card => {
            const info = res.bySku.get(card.dataset.sku);
            if (!info || !info.brand) return;
            const fav = card.querySelector('.favourite-btn[data-product-brand]');
            if (fav && !fav.getAttribute('data-product-brand')) {
                fav.setAttribute('data-product-brand', info.brand);
            }
        });

        if (typeof Business !== 'undefined') {
            Business.ingest(rows);
            Business.decorateCards(container).catch(e =>
                DebugLog.warn('[Ribbons] bulk pricing overlay failed:', e && e.message));
        }
    },

    // =========================================
    // LOAD
    // =========================================
    async loadProducts(navVersion) {
        this.showLoading(true);
        this.elements.levelProducts.hidden = false;
        this.elements.empty.hidden = true;
        if (this.elements.error) this.elements.error.hidden = true;

        // Update title/breadcrumb immediately so they reflect the brand even if the API fails
        this.resolveBrandLabel();
        this.updateBreadcrumb();
        this.updateTitle();

        const label = this.state.brandLabel || this.state.brand || this.state.ribbonBrand || 'these';

        try {
            const params = {
                page: this.state.page,
                limit: this.pageLimit,
                sort: this.state.sort
            };
            if (this.state.brand) params.printer_brand = this.state.brand;
            if (this.state.model) params.printer_model = this.state.model;
            if (this.state.ribbonBrand) params.brand = this.state.ribbonBrand;
            if (this.state.color) params.color = this.state.color;

            // A printer MODEL can only be filtered by the API — the RPC has no
            // device data at all — so a URL naming one takes the branch that can
            // actually answer it, instead of silently widening to the whole brand.
            const useBrandRpc = !!this.state.brand && !this.state.model;

            const res = useBrandRpc
                ? await API.getRibbonsByBrand(this.state.brand)
                : await API.getRibbons(params);

            if (this.navigationVersion !== navVersion) return;
            this.showLoading(false);

            // ERR-193 — FAILED, which is not the same thing as EMPTY. This branch
            // used to render "No ribbons found for Brother yet. Check back soon!",
            // the same sentence as an honestly empty brand, with no retry and no
            // signal, and it did so on all 63 brand pages for 44 hours.
            if (!res || res.ok !== true || !res.data) {
                this.clearProductGrids();
                this.reportLoadFailure(useBrandRpc ? 'ribbons_by_brand' : 'ribbons_api', res);
                this.showError(
                    `We couldn't load ${label} ribbons. The server may be warming up — please try again.`,
                    (v) => this.loadProducts(v)
                );
                return;
            }

            let ribbons = res.data.products || res.data.ribbons || res.data || [];
            let pagination = res.meta || res.data.pagination || null;

            if (!Array.isArray(ribbons)) ribbons = [];
            ribbons = ribbons.map(r => this.normalizeRibbon(r));

            // The brand genuinely stocks nothing. This copy is CORRECT for the ten
            // brands that have no ribbons mapped, and it stays exactly as it was.
            if (ribbons.length === 0) {
                this.clearProductGrids();
                // The H1 gets its properly-cased label ("HP", "OKI", "IBM") from a
                // second request that races this one; the title-cased slug is only
                // a stand-in. Wait for the real one before writing the sentence, or
                // the pane says "Hp" directly under a heading that says "HP".
                // getRibbonBrandsList is memoised and init() already fired it, so
                // this is the same promise, not another round trip.
                await this.resolveBrandLabelFromAPI();
                if (this.navigationVersion !== navVersion) return;
                const activeBrand = this.state.brandLabel || this.state.brand || this.state.ribbonBrand;
                const msg = activeBrand
                    ? `No ribbons found for ${activeBrand} yet. Check back soon!`
                    : 'No ribbons found.';
                this.showEmpty(msg);
                return;
            }

            let visible = ribbons;
            let hydrated = false;

            if (useBrandRpc) {
                // A manufacturer filter needs the brand NAME, which the RPC has
                // only as a UUID. Fetch it FIRST in that one case: rendering the
                // unfiltered set would be a page that looks filtered and isn't,
                // which is the exact failure this codebase keeps re-learning
                // (ERR-151/173/190). If we cannot filter, we say so.
                if (this.state.ribbonBrand) {
                    const ladders = typeof API.getRibbonLadders === 'function'
                        ? await API.getRibbonLadders()
                        : { ok: false, code: 'UNSUPPORTED' };
                    if (this.navigationVersion !== navVersion) return;
                    if (!ladders.ok) {
                        this.clearProductGrids();
                        this.reportLoadFailure('ribbon_ladders', ladders);
                        this.showError(
                            "We couldn't apply that brand filter just now. Please try again.",
                            (v) => this.loadProducts(v)
                        );
                        return;
                    }
                    this.applyLadders(ribbons, ladders.bySku);
                    hydrated = true;
                }

                const matched = this.sortRows(this.filterRows(ribbons), this.state.sort);

                // Filtered down to nothing — an honest empty, but a DIFFERENT one
                // from "this brand has no ribbons", so it gets different words.
                if (matched.length === 0) {
                    this.clearProductGrids();
                    this.showEmpty(`No ${label} ribbons match those filters.`);
                    return;
                }

                const limit = this.pageLimit;
                const totalPages = Math.max(1, Math.ceil(matched.length / limit));
                const current = Math.min(Math.max(1, this.state.page), totalPages);
                visible = matched.slice((current - 1) * limit, current * limit);
                // A real pagination record for a real page. This used to be null on
                // every brand page, so renderPagination described the wrong set.
                pagination = {
                    page: current,
                    limit,
                    total: matched.length,
                    total_pages: totalPages,
                    has_prev: current > 1,
                    has_next: current < totalPages,
                };
            }

            this.renderProducts(visible);
            this.renderPagination(pagination, visible.length);
            this.elements.levelProducts.hidden = false;

            // FE-2, after the paint and never blocking it.
            if (useBrandRpc && !hydrated) {
                this.hydrateLadders(visible, this.elements.levelProducts, navVersion);
            }

        } catch (error) {
            if (this.navigationVersion !== navVersion) return;
            this.clearProductGrids();
            this.reportLoadFailure('ribbons_thrown', { code: 'THROWN', status: null });
            this.showLoading(false);
            this.showError(
                `We couldn't load ${label} ribbons. The server may be warming up — please try again.`,
                (v) => this.loadProducts(v)
            );
        }
    },

    renderProducts(ribbons) {
        const container = this.elements.levelProducts;
        const pagination = this.elements.pagination;

        // Remove any previously inserted section headings + grids
        container.querySelectorAll('.ribbon-section-heading, .ribbon-products-grid').forEach(el => el.remove());

        const sectionOrder = [
            { key: 'typewriter_ribbon', label: 'Typewriter Ribbons' },
            { key: 'printer_ribbon',    label: 'Printer Ribbons' },
            { key: 'correction_tape',   label: 'Correction Tape' },
        ];
        const KNOWN = new Set(sectionOrder.map(s => s.key));

        // Group by product_type — but only where the payload actually stated one.
        //
        // TWO BUGS LIVED IN THE OLD `ribbon.product_type || 'printer_ribbon'`.
        // First, `/api/ribbons` sends no `product_type` on ANY row (measured, 109
        // of 109), so every typewriter ribbon and correction tape reached by a
        // `?color=` or `?printer_model=` URL was filed under the heading "Printer
        // Ribbons" — a wrong answer stated confidently, which is worse than no
        // heading at all. Second, a row carrying a type outside the three below
        // was put in a group that nothing rendered, so it vanished from the page
        // silently. Anything unlabelled or unrecognised now lands in a trailing
        // grid with NO heading: shown, and not mislabelled.
        const groups = {};
        const unlabelled = [];
        ribbons.forEach(ribbon => {
            const type = ribbon.product_type;
            if (type && KNOWN.has(type)) {
                if (!groups[type]) groups[type] = [];
                groups[type].push(ribbon);
            } else {
                unlabelled.push(ribbon);
            }
        });

        const addGrid = (items) => {
            const grid = document.createElement('div');
            grid.className = 'ribbon-products-grid';
            items.forEach(ribbon => grid.appendChild(this.createRibbonCard(ribbon)));
            container.insertBefore(grid, pagination);
        };

        sectionOrder.forEach(section => {
            const items = groups[section.key];
            if (!items || items.length === 0) return;

            const heading = document.createElement('h2');
            heading.className = 'ribbon-section-heading';
            heading.textContent = section.label;
            container.insertBefore(heading, pagination);
            addGrid(items);
        });

        if (unlabelled.length) addGrid(unlabelled);

        // Bulk-price overlay — additive, and free of any network request: the
        // ladder rides on the ribbons payload this grid was rendered from.
        if (typeof Business !== 'undefined') {
            Business.ingest(ribbons);
            Business.decorateCards(container).catch(e =>
                DebugLog.warn('[Ribbons] bulk pricing overlay failed:', e && e.message));
        }

        // Image fallback listeners
        container.querySelectorAll('img[data-fallback]').forEach(img => {
            img.addEventListener('error', function() {
                if (this.dataset.fallback === 'placeholder') {
                    this.removeAttribute('data-fallback');
                    if (this.closest('.product-card')?.dataset.source === 'compatible') {
                        const placeholder = document.createElement('div');
                        placeholder.className = 'product-card__compatible-placeholder';
                        placeholder.innerHTML = '<span>COMPATIBLE</span>';
                        this.replaceWith(placeholder);
                    } else {
                        this.src = '/assets/images/placeholder-product.svg';
                    }
                }
            }, { once: true });
        });
    },

    createRibbonCard(ribbon) {
        const card = document.createElement('article');
        card.className = 'product-card';
        // Business bulk-price overlay finds cards by SKU (Business.decorateCards).
        if (ribbon.sku) card.dataset.sku = ribbon.sku;
        if (ribbon.source) card.dataset.source = ribbon.source;
        if (ribbon.device_models) {
            card.dataset.deviceModels = JSON.stringify(
                Array.isArray(ribbon.device_models)
                    ? ribbon.device_models.map(m => typeof m === 'string' ? m : (m.value || m.label || ''))
                    : []
            );
        }

        const price = ribbon.sale_price || ribbon.retail_price || 0;
        // Drive the buy/contact button off the SAME status the stock pill shows
        // (getStockStatus), instead of a hardcoded true, so an out-of-stock or
        // contact-only ribbon shows "Contact us" like every other surface.
        const inStock = getStockStatus(ribbon).class === 'in-stock';
        const brandName = ribbon._brandName || '';
        const color = ribbon.color || '';
        const displayName = ribbon.name || '';
        const sku = ribbon.sku || '';
        const imageUrl = ribbon.image_url || '';
        const ribbonId = ribbon.id;

        let imageContent;
        if (imageUrl) {
            imageContent = `<img src="${Security.escapeAttr(imageUrl)}" alt="${Security.escapeAttr(displayName)}" loading="lazy" data-fallback="placeholder">`;
        } else {
            imageContent = `<div class="product-card__color-block" style="background-color: #1a1a1a;"></div>`;
        }

        const isFav = typeof Favourites !== 'undefined' && Favourites.isFavourite && Favourites.isFavourite(ribbonId);
        const productUrl = sku ? `/ribbon/${Security.escapeAttr(sku)}` : '#';

        // source-chip-removal-may2026.md — ribbon cards no longer carry a
        // per-card COMPATIBLE/GENUINE chip. The /ribbons page is a single-
        // source list (compatible-only) and the product name already
        // declares the source on every card.

        card.innerHTML = `
            <a href="${productUrl}" class="product-card__link">
                <div class="product-card__image-wrapper">
                    ${imageContent}
                </div>
                <div class="product-card__content">
                    <h3 class="product-card__title">${Security.escapeHtml(displayName)}</h3>
                    ${(ribbon.average_rating && ribbon.review_count > 0 && typeof Products !== 'undefined' && Products._miniStars)
                        ? `<div class="product-card__rating">${Products._miniStars(Math.round(parseFloat(ribbon.average_rating)))} <span class="product-card__review-count">(${parseInt(ribbon.review_count, 10)})</span></div>`
                        : ''}
                    <div class="product-card__footer">
                        <div class="product-card__footer-row">
                            ${color ? `<span class="product-card__color">${Security.escapeHtml(color)}</span>` : '<span></span>'}
                            <span class="product-card__stock product-card__stock--${getStockStatus(ribbon).class}">${Security.escapeHtml(getStockStatus(ribbon).text)}</span>
                        </div>
                        <div class="product-card__footer-row">
                            <div class="product-card__pricing">
                                <span class="product-card__price">${formatPrice(price)}</span>
                            </div>
                            ${inStock
                                ? `<button type="button" class="btn btn--primary btn--sm product-card__cart-btn"
                                        data-product-id="${ribbonId}"
                                        aria-label="Add ${Security.escapeAttr(displayName)} to cart">
                                    Add to Cart
                                  </button>`
                                : `<button type="button" class="btn btn--primary btn--sm product-card__cart-btn product-card__contact-btn"
                                        data-action="contact"
                                        aria-label="Contact us about ${Security.escapeAttr(displayName)}">
                                    Contact us
                                  </button>`}
                        </div>
                    </div>
                </div>
            </a>
            <button type="button" class="favourite-btn product-card__fav-btn ${isFav ? 'favourite-btn--active' : ''}"
                    data-product-id="${ribbonId}"
                    data-product-sku="${Security.escapeAttr(sku)}"
                    data-product-name="${Security.escapeAttr(displayName)}"
                    data-product-price="${price}"
                    data-product-image="${Security.escapeAttr(imageUrl)}"
                    data-product-brand="${Security.escapeAttr(brandName)}"
                    data-product-color="${Security.escapeAttr(color)}"
                    aria-pressed="${isFav}"
                    title="${isFav ? 'Remove from favourites' : 'Add to favourites'}">
                <svg class="favourite-btn__icon favourite-btn__icon--outline" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
                </svg>
                <svg class="favourite-btn__icon favourite-btn__icon--filled" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2">
                    <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
                </svg>
            </button>
        `;

        const cartBtn = card.querySelector('.product-card__cart-btn');
        if (cartBtn && cartBtn.dataset.action === 'contact') {
            cartBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                window.location.href = '/contact';
            });
        } else if (cartBtn) {
            cartBtn.addEventListener('click', async (e) => {
                e.preventDefault();
                await this.addToCart(ribbon, cartBtn);
            });
        }

        return card;
    },

    // =========================================
    // ADD TO CART
    // =========================================
    async addToCart(ribbon, button) {
        const originalText = button.textContent;
        button.textContent = 'Adding...';
        button.disabled = true;

        try {
            await Cart.addItem({
                id: ribbon.id,
                name: ribbon.name,
                price: ribbon.sale_price || ribbon.retail_price || 0,
                sku: ribbon.sku || '',
                image: ribbon.image_url || '',
                brand: ribbon._brandName || '',
                color: ribbon.color || '',
                quantity: 1,
                product_source: ribbon.source || null
            });

            button.textContent = 'Added!';
            button.classList.add('btn--success');

            setTimeout(() => {
                button.textContent = originalText;
                button.classList.remove('btn--success');
                button.disabled = false;
            }, 1500);
        } catch (error) {
            DebugLog.error('Add to cart error:', error);
            button.textContent = 'Error';
            button.classList.add('btn--error');

            setTimeout(() => {
                button.textContent = originalText;
                button.classList.remove('btn--error');
                button.disabled = false;
            }, 2000);
        }
    },

    // =========================================
    // PAGINATION
    // =========================================
    renderPagination(pagination, ribbonCount) {
        const container = this.elements.pagination;
        if (!container) return;

        const totalItems = pagination ? (pagination.total || pagination.total_items || 0) : ribbonCount || 0;
        const current = pagination ? pagination.page : 1;
        const limit = this.pageLimit;
        const start = (current - 1) * limit + 1;
        const end = Math.min(current * limit, totalItems);
        const countHtml = totalItems > 0
            ? `<span class="pagination__count">Showing ${start}–${end} of ${totalItems} items</span>`
            : '';

        if (!pagination || pagination.total_pages <= 1) {
            container.innerHTML = totalItems > 0
                ? `<div class="pagination__bar">${countHtml}</div>`
                : '';
            return;
        }

        const total = pagination.total_pages;
        let items = '';

        items += `<li><button class="pagination__link ${!pagination.has_prev ? 'pagination__link--disabled' : ''}" data-page="${current - 1}" ${!pagination.has_prev ? 'disabled' : ''}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"></polyline></svg>
            Prev
        </button></li>`;

        for (let p = 1; p <= total; p++) {
            if (total > 7 && p > 2 && p < total - 1 && Math.abs(p - current) > 1) {
                if (p === 3 && current > 4) items += `<li class="pagination__item--ellipsis">...</li>`;
                else if (p === total - 2 && current < total - 3) items += `<li class="pagination__item--ellipsis">...</li>`;
                continue;
            }
            items += `<li><button class="pagination__link ${p === current ? 'pagination__link--active' : ''}" data-page="${p}">${p}</button></li>`;
        }

        items += `<li><button class="pagination__link ${!pagination.has_next ? 'pagination__link--disabled' : ''}" data-page="${current + 1}" ${!pagination.has_next ? 'disabled' : ''}>
            Next
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 6 15 12 9 18"></polyline></svg>
        </button></li>`;

        container.innerHTML = `<div class="pagination__center">${countHtml}<ul class="pagination__list">${items}</ul></div>`;

        container.querySelectorAll('.pagination__link[data-page]').forEach(btn => {
            btn.addEventListener('click', () => {
                const page = parseInt(btn.dataset.page);
                if (!isNaN(page) && page >= 1) {
                    this.navigateToPage(page);
                }
            });
        });
    },

    // =========================================
    // UI UPDATES
    // =========================================
    updateBreadcrumb() {
        const list = this.elements.breadcrumbList;
        list.innerHTML = '';

        const activeBrand = this.state.brandLabel || this.state.brand || this.state.ribbonBrand;
        const model = this.state.model;

        if (activeBrand && model) {
            // Show: Ribbons > Brand > Model
            list.appendChild(this.createBreadcrumbItem('Ribbons', false, () => this.goBackToBrands()));
            list.appendChild(this.createBreadcrumbItem(activeBrand, false, () => this.goBackToBrand()));
            list.appendChild(this.createBreadcrumbItem(model, true));
        } else if (activeBrand) {
            // Show: Ribbons > Brand
            list.appendChild(this.createBreadcrumbItem('Ribbons', false, () => this.goBackToBrands()));
            list.appendChild(this.createBreadcrumbItem(activeBrand, true));
        } else if (model) {
            // Show: Ribbons > Model (direct URL navigation without brand)
            list.appendChild(this.createBreadcrumbItem('Ribbons', false, () => this.goBackToBrands()));
            list.appendChild(this.createBreadcrumbItem(model, true));
        } else {
            list.appendChild(this.createBreadcrumbItem('Ribbons', true));
        }

        this.updateSchemaLD();
    },

    goBackToBrand() {
        // Keep brand, clear model — go back to brand-level products
        this.state.model = null;
        this.state.page = 1;
        this.updateURL();
        window.scrollTo(0, 0);
        this.showLevel('products');
        this.navigationVersion++;
        this.loadProducts(this.navigationVersion);
        this.updateBreadcrumb();
        this.updateTitle();
    },

    updateSchemaLD() {
        const el = document.getElementById('ribbons-schema');
        if (!el) return;
        const base = 'https://www.inkcartridges.co.nz';
        const ribbonsUrl = base + '/ribbons';
        const items = [
            { "@type": "ListItem", "position": 1, "name": "Home", "item": base + '/' },
            { "@type": "ListItem", "position": 2, "name": "Ribbons", "item": ribbonsUrl }
        ];
        let pageUrl = ribbonsUrl;
        let pageName = 'Typewriter & Printer Ribbons';
        const activeBrandLabel = this.state.brandLabel || this.state.brand || this.state.ribbonBrand;
        const model = this.state.model;
        if (activeBrandLabel) {
            const paramName = this.state.brand ? 'printer_brand' : 'brand';
            const paramValue = this.state.brand || this.state.ribbonBrand;
            const brandUrl = ribbonsUrl + `?${paramName}=` + encodeURIComponent(paramValue);
            items.push({ "@type": "ListItem", "position": 3, "name": activeBrandLabel, "item": brandUrl });
            if (model) {
                pageUrl = brandUrl + '&printer_model=' + encodeURIComponent(model);
                pageName = activeBrandLabel + ' ' + model + ' Ribbons';
                items.push({ "@type": "ListItem", "position": 4, "name": model, "item": pageUrl });
            } else {
                pageUrl = brandUrl;
                pageName = activeBrandLabel + ' Ribbons';
            }
        } else if (model) {
            pageUrl = ribbonsUrl + '?printer_model=' + encodeURIComponent(model);
            pageName = 'Ribbons for ' + model;
            items.push({ "@type": "ListItem", "position": 3, "name": model, "item": pageUrl });
        }
        el.textContent = JSON.stringify({
            "@context": "https://schema.org",
            "@type": "CollectionPage",
            "name": pageName,
            "url": pageUrl,
            "breadcrumb": { "@type": "BreadcrumbList", "itemListElement": items }
        });
    },

    createBreadcrumbItem(text, isCurrent, onClick) {
        const li = document.createElement('li');
        li.className = `drilldown-breadcrumb__item${isCurrent ? ' drilldown-breadcrumb__item--current' : ''}`;

        if (isCurrent || !onClick) {
            li.innerHTML = `<span>${Security.escapeHtml(text)}</span>`;
        } else {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'drilldown-breadcrumb__link';
            btn.textContent = text;
            btn.addEventListener('click', onClick);
            li.appendChild(btn);

            const sep = document.createElement('span');
            sep.className = 'drilldown-breadcrumb__sep';
            sep.setAttribute('aria-hidden', 'true');
            sep.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>`;
            li.appendChild(sep);
        }

        return li;
    },

    updateTitle() {
        const title = this.elements.title;
        const activeBrand = this.state.brandLabel || this.state.brand || this.state.ribbonBrand;
        const model = this.state.model;
        if (activeBrand && model) {
            title.textContent = `${activeBrand} ${model} Ribbons`;
        } else if (model) {
            title.textContent = `Ribbons for ${model}`;
        } else if (activeBrand) {
            title.textContent = `${activeBrand} Typewriter & Printer Ribbons`;
        } else {
            title.textContent = 'Typewriter & Printer Ribbons';
        }
        title.hidden = false;

        // Update document title to match
        const docPrefix = activeBrand ? `${activeBrand} ` : '';
        document.title = `${docPrefix}Typewriter & Printer Ribbons | InkCartridges.co.nz`;

        // SERP title + meta-description parity (seo-meta-rewrite-may2026).
        // /ribbons is served the `category/ribbons` prerender by middleware
        // regardless of any client-side brand/model filter (the filter never
        // appears in the crawlable URL). So mirror the backend copy only for
        // the canonical, unfiltered /ribbons state — when a brand/model filter
        // is active we keep the brand-specific document.title above for the
        // human's benefit and skip the (generic) prerender mirror.
        if (typeof SeoMeta !== 'undefined' && !activeBrand && !model) {
            SeoMeta.render({ surface: 'category-ribbons' });
        }
    }
};

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    RibbonsPage.init();
});
