/**
 * SEO-META.JS — SERP title + meta-description parity layer (May 2026)
 * ===================================================================
 *
 * Backend handoff: `seo-meta-rewrite-may2026.md` (backend commit `6e266c8`,
 * "fix(seo): psychology-driven SERP copy for higher CTR"). The backend rewrote
 * `<title>` and `<meta name="description">` for the highest-traffic SEO
 * surfaces and serves the new copy through the bot-prerender layer
 * (`/api/prerender/*`).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Google's no-cloaking rule requires the `<title>` and `<meta name=
 * "description">` to be byte-identical between (a) the bot-prerender HTML a
 * crawler fetches with its bot UA and (b) the SPA-rendered HTML produced when
 * Google's WRS executes our JS for the same URL (its anti-cloaking spot-check
 * fetches with a regular Chrome UA, which gets the SPA shell, not the
 * prerender). If they diverge, the page is penalised.
 *
 * The new copy contains backend-curated counts ("935+", "1000+",
 * "200 products") that the SPA cannot recompute, and `/api/site/trust` carries
 * no counts. So the ONLY way to guarantee byte-identical parity is to mirror
 * the backend's authoritative output rather than rebuild it client-side:
 *
 *   - Product pages already do this — product-detail-page.js renders the API
 *     `seo.title` / `seo.description` (the same buildSeoTitle/buildSeoDescription
 *     output the prerender uses). No change needed there.
 *   - Listing surfaces (home, /shop, category, brand, printer) have no
 *     light-weight API field. So `reconcile()` fetches the matching prerender
 *     endpoint, extracts the decoded `<title>` + `<meta name=description>`, and
 *     applies them. This auto-upgrades to the new copy the instant the backend
 *     deploys — no FE redeploy — and always matches whatever the bot is served
 *     right now (old copy today, new copy post-deploy).
 *
 * The spec's checklist (fetch `/api/site/trust`, `formatDispatchCutoff()`,
 * title fallback ladders, per-surface builders) is implemented here as the
 * FAIL-OPEN FALLBACK: it runs when the prerender is unreachable. In that case
 * the bot ALSO falls through to the SPA shell (middleware returns on a non-200
 * prerender), so both sides run this same fallback code and still match.
 *
 * Hard constraints carried over from the backend (compliance, pinned by the
 * backend's __tests__/google-ads-compliance.test.js and our
 * tests/seo-meta-rewrite-may2026.test.js): no superlatives, no scarcity, no
 * competitor name-drops, no price anchors in <title>, trust facts fetched
 * (never inlined — fail-open by OMITTING the clause), title <=60, desc <=155.
 *
 * Pinned by tests/seo-meta-rewrite-may2026.test.js.
 */

const SeoMeta = {
    // ── constants ────────────────────────────────────────────────────────────
    BASE: 'https://www.inkcartridges.co.nz',
    TITLE_MAX: 60,
    DESC_MAX: 155,
    DESC_TRUNCATE_AT: 152,            // truncate at last space <= 152, then "..."
    BRANDS_LINE: 'Canon, HP, Epson, Brother.',

    TRUST_ENDPOINT: '/api/site/trust',
    TRUST_CACHE_KEY: 'ic_seo_trust_v1',
    TRUST_TTL_MS: 60 * 60 * 1000,     // 1h (spec)

    PRERENDER_CACHE_PREFIX: 'ic_seo_pr_v1:',
    PRERENDER_TTL_MS: 60 * 60 * 1000, // 1h listings (products use API seo, not this)

    _seq: 0,            // bumped on every render() — guards against stale async applies
    _trustPromise: null,

    // ── pure helpers (no DOM / no network — unit-tested directly) ─────────────

    /**
     * "14:00" -> "2pm", "09:30" -> "9:30am", "00:00" -> "12am", "12:00" -> "12pm".
     * Mirrors the backend's formatDispatchCutoff() in src/utils/trustSignals.js.
     * Returns null for anything unparseable so callers OMIT the clause.
     */
    formatDispatchCutoff(nzt) {
        if (typeof nzt !== 'string') return null;
        const m = /^(\d{1,2}):(\d{2})$/.exec(nzt.trim());
        if (!m) return null;
        const h = parseInt(m[1], 10);
        const min = parseInt(m[2], 10);
        if (!(h >= 0 && h <= 23) || !(min >= 0 && min <= 59)) return null;
        const ampm = h < 12 ? 'am' : 'pm';
        const h12 = (h % 12) || 12;
        return min === 0 ? `${h12}${ampm}` : `${h12}:${String(min).padStart(2, '0')}${ampm}`;
    },

    /**
     * Title fallback ladder: candidates ordered longest -> shortest. Return the
     * first that fits TITLE_MAX; if none fit, return the last (shortest) anyway.
     */
    titleLadder(candidates) {
        const list = (candidates || []).filter(c => typeof c === 'string' && c.length > 0);
        for (const c of list) if (c.length <= this.TITLE_MAX) return c;
        return list.length ? list[list.length - 1] : '';
    },

    /**
     * Clamp a description to DESC_MAX. If longer, cut at the last space within
     * DESC_TRUNCATE_AT chars and append "..." (matches the backend).
     */
    truncateDescription(desc) {
        if (typeof desc !== 'string') return '';
        if (desc.length <= this.DESC_MAX) return desc;
        const slice = desc.slice(0, this.DESC_TRUNCATE_AT);
        const lastSpace = slice.lastIndexOf(' ');
        const head = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
        return head.replace(/[\s.,;:]+$/, '') + '...';
    },

    /** Join description clauses, dropping null/empty (fail-open clause omission). */
    _joinClauses(clauses) {
        return clauses.filter(c => typeof c === 'string' && c.length > 0).join(' ');
    },

    /** "brother-mfc-j5945dw" -> "Brother Mfc J5945dw" (display fallback only). */
    _titleCaseSlug(slug) {
        if (typeof slug !== 'string' || !slug) return '';
        return slug.split(/[-_\s]+/).filter(Boolean)
            .map(w => w.charAt(0).toUpperCase() + w.slice(1))
            .join(' ');
    },

    /**
     * Decode the small set of HTML entities that show up in <title>/<meta>
     * (prerender titles use &amp; etc). Portable (no DOMParser) so the extractor
     * is identical in the browser and under `node --test`.
     */
    decodeEntities(str) {
        if (typeof str !== 'string') return '';
        return str
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#0*39;/g, "'")
            .replace(/&#x0*27;/gi, "'")
            .replace(/&apos;/g, "'")
            .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
            .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
            .replace(/&nbsp;/g, ' ');
    },

    /**
     * Pull the decoded <title> + <meta name="description"> out of a prerender
     * HTML document. Returns { title, description } (either may be null).
     */
    extractHead(html) {
        if (typeof html !== 'string' || !html) return { title: null, description: null };
        const titleM = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
        // meta name="description" — attribute order independent
        let desc = null;
        const metaRe = /<meta\b[^>]*>/gi;
        let mtag;
        while ((mtag = metaRe.exec(html)) !== null) {
            const tag = mtag[0];
            if (/\bname\s*=\s*["']description["']/i.test(tag)) {
                const cM = /\bcontent\s*=\s*"([^"]*)"/i.exec(tag) || /\bcontent\s*=\s*'([^']*)'/i.exec(tag);
                if (cM) { desc = this.decodeEntities(cM[1]).trim(); break; }
            }
        }
        return {
            title: titleM ? this.decodeEntities(titleM[1]).trim() : null,
            description: desc,
        };
    },

    // ── surface + prerender-path mapping (mirrors middleware.js exactly) ──────

    /**
     * Map a location to the prerender endpoint a bot would be served. MUST match
     * inkcartridges/middleware.js (the routing real crawlers hit) — including the
     * printer brand/slug shape and the fact that the brand prerender is
     * category-agnostic (middleware does NOT forward ?category). Returns null for
     * any surface that has no prerender (search / code / deep filters /
     * category-only /shop) so reconcile() is a no-op and the page's own copy
     * stands.
     */
    prerenderPathForLocation(loc) {
        const path = (loc && loc.pathname) || '/';
        const params = new URLSearchParams((loc && loc.search) || '');
        if (path === '/' || path === '' || path === '/index.html') return '/api/prerender/home';
        if (path === '/ribbons' || path === '/ribbons/') return '/api/prerender/category/ribbons';
        if (path === '/ink-cartridges' || path === '/ink-cartridges/') return '/api/prerender/category/ink';
        if (path === '/toner-cartridges' || path === '/toner-cartridges/') return '/api/prerender/category/toner';
        if (path === '/shop' || path === '/shop/') {
            const brand = params.get('brand');
            const printer = params.get('printer_slug') || params.get('printer');
            // Mirror middleware EXACTLY: it routes /shop to a prerender ONLY when
            // a brand is present (printer, the narrower intent, wins when both
            // are). Bare /shop, category-only, search, code-filtered and
            // bare-printer URLs are all left to the SPA shell (ai-search
            // readiness §4) — there is no prerender to reconcile against, so the
            // crawler's SPA-shell render and the human's render run the same
            // code and already match. `code`/`category` do NOT change the
            // routing: a brand hit always yields the brand prerender.
            if (brand && printer) {
                return `/api/prerender/printer/${encodeURIComponent(brand)}/${encodeURIComponent(printer)}`;
            }
            if (brand) return `/api/prerender/brand/${encodeURIComponent(brand)}`;
            return null;
        }
        return null;
    },

    /** Which fallback builder to use for a location (null = leave copy alone). */
    surfaceForLocation(loc) {
        const path = (loc && loc.pathname) || '/';
        const params = new URLSearchParams((loc && loc.search) || '');
        if (path === '/' || path === '' || path === '/index.html') return 'home';
        if (path === '/ribbons' || path === '/ribbons/') return 'category-ribbons';
        if (path === '/ink-cartridges' || path === '/ink-cartridges/') return 'category-ink';
        if (path === '/toner-cartridges' || path === '/toner-cartridges/') return 'category-toner';
        if (path === '/shop' || path === '/shop/') {
            const brand = params.get('brand');
            const printer = params.get('printer_slug') || params.get('printer');
            if (brand && printer) return 'printer';
            if (brand) return 'brand';
            // Truly-bare /shop gets the new shop-landing builder copy (there is
            // no bot prerender for it, so this is what both the SPA-shell crawl
            // and the human see). Any other param shape (category-only, search,
            // code) keeps the page's own, more specific copy.
            if (Array.from(params.keys()).length === 0) return 'shop-landing';
            return null;
        }
        return null;
    },

    // ── trust facts (fail-open) ───────────────────────────────────────────────

    _emptyTrust() {
        return { foundedYear: null, guaranteeDays: null, cutoff: null };
    },

    _normalizeTrust(data) {
        if (!data || typeof data !== 'object') return this._emptyTrust();
        const org = data.organization || {};
        const guarantee = data.guarantee || {};
        const shipping = data.shipping_promise || {};
        const founded = org.founded_year;
        const days = guarantee.days;
        return {
            foundedYear: Number.isFinite(founded) ? founded : null,
            guaranteeDays: Number.isFinite(days) ? days : null,
            cutoff: this.formatDispatchCutoff(shipping.dispatch_cutoff_nzt),
        };
    },

    _readTrustCache() {
        try {
            const raw = sessionStorage.getItem(this.TRUST_CACHE_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || (Date.now() - parsed.ts) > this.TRUST_TTL_MS) return null;
            return parsed.trust;
        } catch { return null; }
    },

    _writeTrustCache(trust) {
        try {
            sessionStorage.setItem(this.TRUST_CACHE_KEY, JSON.stringify({ ts: Date.now(), trust }));
        } catch { /* private mode / quota — ignore */ }
    },

    _apiUrl(path) {
        const base = (typeof Config !== 'undefined' && Config.API_URL != null) ? Config.API_URL : '';
        return `${base}${path}`;
    },

    /**
     * Fetch trust facts once per session (1h cache), fail-open to all-null so
     * builders OMIT the founded/guarantee/cutoff clauses (constraint #5: never
     * hard-code trust facts).
     */
    async getTrust() {
        const cached = this._readTrustCache();
        if (cached) return cached;
        if (this._trustPromise) return this._trustPromise;
        this._trustPromise = (async () => {
            if (typeof fetch !== 'function') return this._emptyTrust();
            try {
                const res = await fetch(this._apiUrl(this.TRUST_ENDPOINT), {
                    headers: { 'Accept': 'application/json' },
                });
                if (!res.ok) return this._emptyTrust();
                const json = await res.json();
                const data = (json && typeof json === 'object' && 'data' in json) ? json.data : json;
                const trust = this._normalizeTrust(data);
                this._writeTrustCache(trust);
                return trust;
            } catch {
                return this._emptyTrust();
            } finally {
                this._trustPromise = null;
            }
        })();
        return this._trustPromise;
    },

    _freeThreshold() {
        if (typeof Config !== 'undefined' && typeof Config.getSetting === 'function') {
            const v = Config.getSetting('FREE_SHIPPING_THRESHOLD', 100);
            if (Number.isFinite(v)) return v;
        }
        return 100;
    },

    // ── fallback copy builders (used only when the prerender is unreachable) ──
    // Counts are deliberately omitted (they diverge from the backend's curated
    // numbers and reconcile() fills the exact version). Trust clauses drop out
    // when their value is null. All output is compliance-clean.

    _trustClauses(trust) {
        return {
            founded: trust.foundedYear ? `NZ-owned since ${trust.foundedYear}.` : null,
            dispatch: trust.cutoff ? `${trust.cutoff} Auckland same-day dispatch.` : null,
            guarantee: trust.guaranteeDays ? `${trust.guaranteeDays}-day guarantee.` : null,
        };
    },

    _buildHome(ctx) {
        const t = this._trustClauses(ctx.trust);
        const title = this.titleLadder([
            'Ink Cartridges NZ — Same-Day Dispatch | InkCartridges.co.nz',
            'Ink Cartridges NZ — Same-Day Dispatch',
            'Ink Cartridges NZ',
        ]);
        const description = this.truncateDescription(this._joinClauses([
            t.founded,
            `Ink cartridges & toner — ${this.BRANDS_LINE}`,
            t.dispatch,
            t.guarantee,
            `Free shipping over $${ctx.free}.`,
        ]));
        return { title, description };
    },

    _buildShop(ctx) {
        const t = this._trustClauses(ctx.trust);
        const title = this.titleLadder([
            'Ink & Toner NZ — Same-Day Dispatch | InkCartridges.co.nz',
            'Ink & Toner NZ — Same-Day Dispatch',
            'Ink & Toner NZ',
        ]);
        const description = this.truncateDescription(this._joinClauses([
            `Ink cartridges, toner & supplies. ${this.BRANDS_LINE}`,
            t.founded,
            t.dispatch,
            `Free shipping over $${ctx.free}.`,
        ]));
        return { title, description };
    },

    _buildCategory(ctx, label, noun) {
        const t = this._trustClauses(ctx.trust);
        const Noun = noun.charAt(0).toUpperCase() + noun.slice(1);
        const title = this.titleLadder([
            `${label} — Same-Day Dispatch | InkCartridges.co.nz`,
            `${label} — Same-Day Dispatch`,
            label,
        ]);
        const description = this.truncateDescription(this._joinClauses([
            `${Noun} in stock — genuine & compatible.`,
            this.BRANDS_LINE,
            t.dispatch,
            t.guarantee,
        ]));
        return { title, description };
    },

    _buildBrand(ctx) {
        const t = this._trustClauses(ctx.trust);
        const brand = ctx.brandDisplay || this._titleCaseSlug(ctx.brandSlug);
        if (!brand) return null;
        // Brand prerender is category-agnostic (middleware drops ?category), so
        // the fallback omits the category too — matching what the bot receives.
        const title = this.titleLadder([
            `${brand} NZ — Same-Day Dispatch | InkCartridges.co.nz`,
            `${brand} NZ — Same-Day Dispatch`,
            `${brand} NZ`,
        ]);
        const description = this.truncateDescription(this._joinClauses([
            `${brand} ink cartridges & toner — genuine & compatible.`,
            t.founded,
            t.dispatch,
            t.guarantee,
        ]));
        return { title, description };
    },

    _buildPrinter(ctx) {
        const t = this._trustClauses(ctx.trust);
        const printer = ctx.printerDisplay || this._titleCaseSlug(ctx.printerSlug);
        if (!printer) return null;
        const title = this.titleLadder([
            `${printer} Cartridges — Same-Day Dispatch | InkCartridges.co.nz`,
            `${printer} Cartridges — Same-Day Dispatch`,
            `${printer} Cartridges`,
        ]);
        const description = this.truncateDescription(this._joinClauses([
            `Cartridges for ${printer} — genuine & compatible.`,
            t.dispatch,
            t.guarantee,
            `Free shipping over $${ctx.free}.`,
        ]));
        return { title, description };
    },

    buildForSurface(surface, ctx) {
        switch (surface) {
            case 'home':             return this._buildHome(ctx);
            case 'shop-landing':     return this._buildShop(ctx);
            case 'category-ink':     return this._buildCategory(ctx, 'Ink Cartridges NZ', 'ink cartridges');
            case 'category-toner':   return this._buildCategory(ctx, 'Toner Cartridges NZ', 'toner cartridges');
            case 'category-ribbons': return this._buildCategory(ctx, 'Printer Ribbons NZ', 'printer ribbons');
            case 'brand':            return this._buildBrand(ctx);
            case 'printer':          return this._buildPrinter(ctx);
            default:                 return null;
        }
    },

    // ── DOM application ───────────────────────────────────────────────────────

    _setMetaContent(selector, val) {
        if (typeof document === 'undefined' || !val) return;
        const el = document.querySelector(selector);
        if (el) el.setAttribute('content', val);
    },

    _setTitle(title) {
        if (typeof document === 'undefined' || !title) return;
        document.title = title;
        this._setMetaContent('meta[property="og:title"]', title);
        this._setMetaContent('meta[name="twitter:title"]', title);
    },

    _setDescription(description) {
        if (!description) return;
        this._setMetaContent('meta[name="description"]', description);
        this._setMetaContent('meta[property="og:description"]', description);
        this._setMetaContent('meta[name="twitter:description"]', description);
    },

    // ── prerender reconciliation (the byte-identical guarantee) ───────────────

    _readPrerenderCache(path) {
        try {
            const raw = sessionStorage.getItem(this.PRERENDER_CACHE_PREFIX + path);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || (Date.now() - parsed.ts) > this.PRERENDER_TTL_MS) return null;
            return parsed.head;
        } catch { return null; }
    },

    _writePrerenderCache(path, head) {
        try {
            sessionStorage.setItem(this.PRERENDER_CACHE_PREFIX + path,
                JSON.stringify({ ts: Date.now(), head }));
        } catch { /* ignore */ }
    },

    /**
     * Fetch the prerender head for `prerenderPath`, extract the decoded title +
     * description, and overwrite the SPA head — the byte-identical mirror of what
     * a bot is served. Cached (head only, not the full HTML). Fail-open: a
     * missing path, non-200, or thrown error leaves the page's own copy intact.
     * `seq` guards against applying a stale result after the user navigated.
     */
    async reconcile(prerenderPath, seq) {
        if (!prerenderPath) return false;
        let head = this._readPrerenderCache(prerenderPath);
        if (!head) {
            if (typeof fetch !== 'function') return false;
            try {
                const res = await fetch(this._apiUrl(prerenderPath), { headers: { 'Accept': 'text/html' } });
                if (!res.ok) return false;
                const html = await res.text();
                head = this.extractHead(html);
                if (!head || (!head.title && !head.description)) return false;
                this._writePrerenderCache(prerenderPath, head);
            } catch {
                return false;
            }
        }
        if (seq !== undefined && seq !== this._seq) return false; // navigated away
        if (head.title) this._setTitle(head.title);
        if (head.description) this._setDescription(head.description);
        return true;
    },

    // ── public entry point ────────────────────────────────────────────────────

    /**
     * Render SEO head for the current (or given) surface.
     *  opts.surface       — override; otherwise derived from location.
     *  opts.prerenderPath — override; otherwise derived from location.
     *  opts.hints         — { brand, printer } display names for the fallback.
     *  opts.location      — override (tests); otherwise window.location.
     *
     * Flow: (1) bump seq, (2) build + apply the fail-open fallback from trust +
     * templates, (3) reconcile from the prerender to the byte-exact backend copy.
     */
    async render(opts = {}) {
        const seq = ++this._seq;
        const loc = opts.location || (typeof window !== 'undefined' ? window.location : { pathname: '/', search: '' });
        const surface = opts.surface || this.surfaceForLocation(loc);
        const prerenderPath = ('prerenderPath' in opts) ? opts.prerenderPath : this.prerenderPathForLocation(loc);

        let trust;
        try { trust = await this.getTrust(); } catch { trust = this._emptyTrust(); }
        if (seq !== this._seq) return; // navigated mid-flight

        const params = new URLSearchParams((loc && loc.search) || '');
        const hints = opts.hints || {};
        const ctx = {
            trust,
            free: this._freeThreshold(),
            brandDisplay: hints.brand || null,
            printerDisplay: hints.printer || null,
            brandSlug: params.get('brand') || null,
            printerSlug: params.get('printer_slug') || params.get('printer') || null,
        };

        const built = this.buildForSurface(surface, ctx);
        if (built) {
            if (built.title) this._setTitle(built.title);
            if (built.description) this._setDescription(built.description);
        }

        // Authoritative parity overwrite (the bot's exact strings).
        await this.reconcile(prerenderPath, seq);
    },
};

// Browser global (mirrors the project's module pattern — Config/API/Auth/...).
if (typeof window !== 'undefined') {
    window.SeoMeta = SeoMeta;

    // The homepage has no dedicated *-page.js controller, so self-init here.
    // Listing pages (shop-page.js, ribbons-page.js) call SeoMeta.render()
    // explicitly after they resolve their state, so we must NOT auto-run there.
    document.addEventListener('DOMContentLoaded', () => {
        const p = location.pathname;
        if (p === '/' || p === '' || p === '/index.html') {
            SeoMeta.render({ surface: 'home' });
        }
    });
}

// Node test harness (vm.runInContext exposes the bare global; node --test).
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SeoMeta;
}
