    // ============================================
    // RELATED-PRODUCT SKU RESOLUTION
    // ============================================
    // Curated related_product_skus are hand-entered. For typewriter ribbons —
    // which use bare numeric SKUs like "307.11" with no prefix — the related
    // picker tends to save a compatible product by its BARE code ("141LOT")
    // while the real product carries the compatible/genuine prefix ("C141LOT").
    // An exact `.in('sku', [...])` then resolves nothing and the "Products
    // related to …" section renders as a bare heading (ERR-084: SKU 307.11's
    // ["141LOT","143LOT"] never resolved to the real C141LOT/C143LOT tapes).
    //
    // The convention is a single known letter over a bare code: "C" = compatible,
    // "G" = genuine. Return the EXACT sku first, then the two prefixed
    // candidates, so exact always wins and matching stays strict SKU equality
    // over a tiny candidate set — never a fuzzy substring / ILIKE (which could
    // pull an unrelated product). A spurious candidate that matches nothing is
    // harmless; one that matches a real C-/G- sibling is genuinely related.
    // Pure — exposed on window._pdpRelatedHelpers for tests.
    function relatedSkuCandidates(sku) {
        const raw = String(sku == null ? '' : sku).trim();
        if (!raw) return [];
        const up = raw.toUpperCase();
        return [up, 'C' + up, 'G' + up];
    }
    if (typeof window !== 'undefined') {
        window._pdpRelatedHelpers = { relatedSkuCandidates };
    }

    // ============================================
    // DYNAMIC PRODUCT PAGE
    // ============================================
    const ProductPage = {
        product: null,

        // Delegate to shared ProductColors utility
        getColorStyle(colorName) {
            return ProductColors.getStyle(colorName);
        },

        detectColorFromName(name) {
            return ProductColors.detectFromName(name);
        },

        // Smallest page-yield we treat as trustworthy. Real cartridge yields
        // run from the low hundreds into the thousands; single/double-digit
        // values (e.g. a stray "3") are almost always a data-entry error, so
        // we suppress them rather than print a misleading spec. No data is
        // faked — an unreliable value is simply not shown.
        MIN_PLAUSIBLE_YIELD: 50,

        // Returns a clean integer page-yield only when the value is a plausible
        // cartridge yield; otherwise null (caller then renders nothing).
        plausibleYield(value) {
            if (value == null) return null;
            const n = parseInt(String(value).replace(/[,\s]/g, '').replace(/pages?/gi, ''), 10);
            if (!Number.isFinite(n) || n < this.MIN_PLAUSIBLE_YIELD) return null;
            return n;
        },

        async init() {
            const params = new URLSearchParams(window.location.search);
            let sku = params.get('sku');
            this._productType = params.get('type') || null; // 'ribbon' or null

            // Handle clean URL: /ribbon/:sku
            const ribbonPath = window.location.pathname.match(/^\/ribbon\/(.+)$/);
            if (ribbonPath) {
                sku = decodeURIComponent(ribbonPath[1]);
                this._productType = 'ribbon';
            }

            // Handle SEO URL: /products/:slug/:sku
            if (!sku) {
                const productPath = window.location.pathname.match(/^\/products\/[^/]+\/(.+)$/);
                if (productPath) sku = decodeURIComponent(productPath[1]);
            }

            // Short SKU URL: /p/:sku — in production this is rewritten to the
            // backend's 301 handler, but on localhost (and as a resilience
            // fallback if the backend is unreachable) we resolve client-side.
            // After the product loads the canonical-path normaliser below
            // rewrites the URL bar to the polished /products/:slug/:sku form.
            if (!sku) {
                const shortPath = window.location.pathname.match(/^\/p\/(.+)$/);
                if (shortPath) {
                    sku = decodeURIComponent(shortPath[1]);
                }
            }

            // Legacy slug-only URL: /product/:slug or ?slug=
            if (!sku) {
                let slug = params.get('slug');
                if (!slug) {
                    const legacy = window.location.pathname.match(/^\/product\/([^/]+)\/?$/);
                    if (legacy) slug = decodeURIComponent(legacy[1]);
                }
                if (slug) {
                    sku = await this.resolveSkuFromSlug(slug);
                    if (!sku) {
                        const q = slug.replace(/-/g, ' ').trim();
                        window.location.replace('/shop?q=' + encodeURIComponent(q));
                        return;
                    }
                    // Canonicalise URL in history so reloads/sharing work.
                    const cleanSku = encodeURIComponent(sku);
                    const cleanSlug = encodeURIComponent(slug);
                    window.history.replaceState({}, '', `/products/${cleanSlug}/${cleanSku}`);
                }
            }

            if (!sku) {
                this.showError('No product specified');
                return;
            }

            // Wait for auth so the Bearer token is available for admin-gated products
            if (typeof Auth !== 'undefined' && Auth.readyPromise) {
                await Auth.readyPromise;
            }

            try {
                let response;
                if (this._productType === 'ribbon') {
                    response = await API.getRibbon(sku);
                    if (response.ok && response.data) {
                        const r = response.data;
                        // Normalize ribbon fields to match product page expectations
                        if (r.retail_price == null && r.sale_price != null) r.retail_price = r.sale_price;
                        if (r.image_url == null && r.image_path) r.image_url = typeof storageUrl === 'function' ? storageUrl(r.image_path) : r.image_path;
                        if (r.active == null) r.active = r.is_active !== false;
                    }
                } else {
                    response = await API.getProduct(sku);
                }

                if (!response.ok || !response.data) {
                    // API.getProduct returns a richer error message when the
                    // singular detail endpoint threw (5xx/network/timeout) and
                    // the search-smart fallback also couldn't recover; surface
                    // it so users see "temporarily unavailable" + a Try Again
                    // button rather than a misleading "not found" for what is
                    // actually a server hiccup.
                    //
                    // response.error may be a string (legacy path) or the
                    // backend's typed `{ code, message }` object. Funnel through
                    // API.extractErrorMessage so the renderer never paints
                    // "[object Object]" — see errors.md "[object Object] on
                    // product 404" for the regression this guards against.
                    this.showError(API.extractErrorMessage(response, 'Product not found'));
                    return;
                }

                this.product = response.data;

                // Enrich products from Supabase (description, compatibility, related products).
                // Also pull `id` so we can honour the manual product_codes override below.
                try {
                    const enrichUrl = `${Config.SUPABASE_URL}/rest/v1/products?sku=eq.${encodeURIComponent(sku)}&select=id,description_html,compatible_devices_html,related_product_skus&limit=1`;
                    const enrichResp = await fetch(enrichUrl, {
                        headers: {
                            'apikey': Config.SUPABASE_ANON_KEY,
                            'Accept': 'application/json',
                        },
                    });
                    if (enrichResp.ok) {
                        const rows = await enrichResp.json();
                        const extra = rows[0];
                        if (extra) {
                            if (this.product.id == null) this.product.id = extra.id;
                            if (this.product.description_html == null) this.product.description_html = extra.description_html;
                            if (this.product.compatible_devices_html == null) this.product.compatible_devices_html = extra.compatible_devices_html;
                            if (this.product.related_product_skus == null) this.product.related_product_skus = extra.related_product_skus;
                        }
                    }
                } catch (_) { /* non-critical enrichment */ }

                // Honour the manual product_codes override on the PDP. The /shop merge
                // (api.js _applyManualCodes) only runs on getShopData, so a singly-loaded
                // product never sees its assigned codes; apply them here so a code set in
                // the admin drives the PDP (breadcrumb code, Related Products) exactly as
                // it does /shop — "codes set here fully replace the auto-detected ones".
                try {
                    const manualCodes = await API.getManualProductCodes(this.product.id);
                    if (manualCodes.length) {
                        this.product.series_codes = manualCodes;
                    } else if (this.product.category === 'ribbon') {
                        // Ribbons are owner-manual (ERR-086): with no explicit
                        // override they carry NO codes — never a backend-derived
                        // fallback. Mirrors _applyManualCodes' ribbon rule.
                        this.product.series_codes = [];
                    }
                } catch (_) { /* non-critical — fall back to the backend series_codes */ }

                // Gate test products — active test products are visible to all; inactive only to super admins
                if (this._isTestProduct(this.product) && !this.product.active && typeof isCachedSuperAdmin === 'function' && !isCachedSuperAdmin()) {
                    this.showError('Product not found');
                    return;
                }

                // Normalize URL bar to the polished canonical slug whenever the
                // current path differs — covers /p/:sku entries, /products/<loser>/<sku>
                // entries, and legacy /product/:slug entries. Bots that render JS
                // observe the canonical URL; bots that don't still consume the
                // <link rel="canonical"> tag rendered below. The hard 301 for
                // loser slugs is enforced by the backend's prerender route on
                // /p/:sku and /html/products/:slug/:sku — this is the
                // client-side companion that handles direct SPA entries.
                const canonicalPath = (() => {
                    if (this.product.canonical_url) {
                        try { return new URL(this.product.canonical_url).pathname; }
                        catch (_) { return null; }
                    }
                    if (this.product.slug && this.product.sku) {
                        return `/products/${encodeURIComponent(this.product.slug)}/${encodeURIComponent(this.product.sku)}`;
                    }
                    return null;
                })();
                if (canonicalPath && canonicalPath !== window.location.pathname) {
                    window.history.replaceState({}, '', canonicalPath + window.location.search + window.location.hash);
                }

                this.renderProduct();
                this.loadReviews();
            } catch (error) {
                DebugLog.error('Error loading product:', error);
                this.showError('Failed to load product');
            }
        },

        getProductInfo() {
            const p = this.product;
            const name = p.name || '';
            const category = this.normalizeProductType(p.product_type) || this.normalizeCategory(p.category) || this.detectCategory(name);
            const isRibbonProduct = category === 'ribbon';
            // Trust `p.source`. The legacy `name.includes('compatible')`
            // fallback was for a pre-source-field data shape that no longer
            // exists, and it would now overmatch on the May 2026 compatible
            // name format ("Compatible <Type> Cartridge Replacement for ...")
            // rather than disambiguating anything new.
            const isCompatible = !isRibbonProduct && p.source === 'compatible';
            // De-double redundant compact code tokens in genuine names (display only;
            // stored `name` stays raw for slug/identity). See ProductName in utils.js.
            const displayName = (typeof ProductName !== 'undefined') ? ProductName.clean(p) : name;
            const brandName = p.brand?.name || (typeof p.brand === 'string' ? p.brand : null) || this.extractBrand(name) || 'Unknown';
            const pageYield = p.page_yield || p.yield || null;

            return {
                ...p,
                isCompatible,
                displayName,
                brandName,
                category,
                pageYield,
                color: p.color || null,
                image_url: typeof storageUrl === 'function' ? storageUrl(p.image_url) : (p.image_url || ''),
                image_url_raw: p.image_url || ''
            };
        },

        extractBrand(name) {
            const brands = ['Brother', 'Canon', 'Epson', 'HP', 'Samsung'];
            for (const brand of brands) {
                if (name.toLowerCase().includes(brand.toLowerCase())) {
                    return brand;
                }
            }
            return null;
        },

        normalizeProductType(pt) {
            if (!pt) return null;
            switch (pt.toLowerCase()) {
                case 'ink_cartridge':
                case 'ink_bottle':      return 'ink';
                case 'toner_cartridge': return 'toner';
                case 'drum_unit':
                case 'waste_toner':
                case 'belt_unit':
                case 'fuser_kit':
                case 'maintenance_kit': return 'drum';
                case 'ribbon':
                case 'printer_ribbon':
                case 'typewriter_ribbon':
                case 'correction_tape': return 'ribbon';
                case 'label_tape':      return 'label_tape';
                case 'photo_paper':     return 'paper';
                default:                return null;
            }
        },

        normalizeCategory(raw) {
            if (!raw) return null;
            // Accept both shapes: canonical /api/products/<sku> returns
            // category as a string code ("CON-RIBBON"), but the search-smart
            // fallback path may pass through { name, slug } if api.js's
            // flattening misses an edge case. Coerce defensively so the
            // renderer can't crash with "toLowerCase is not a function".
            const str = typeof raw === 'string' ? raw
                : (raw && typeof raw === 'object') ? (raw.slug || raw.name || '')
                : String(raw);
            const lower = str.toLowerCase();
            if (lower.includes('ink')) return 'ink';
            if (lower.includes('toner')) return 'toner';
            if (lower.includes('drum')) return 'drum';
            if (lower.includes('ribbon')) return 'ribbon';
            return null;
        },

        detectCategory(name) {
            // Check product_type field first (authoritative DB field)
            const p = this.product;
            const ptCategory = p ? this.normalizeProductType(p.product_type) : null;
            if (ptCategory) return ptCategory;
            if (this._productType === 'ribbon') return 'ribbon';
            const lower = name.toLowerCase();
            if (lower.includes('ribbon')) return 'ribbon';
            if (lower.includes('toner')) return 'toner';
            if (lower.includes('drum')) return 'drum';
            if (lower.includes('ink') || lower.includes('cartridge')) return 'ink';
            return 'default';
        },

        /**
         * Resolve the primary product code (e.g. "LC37") for "related products".
         *
         * Preferred source: `info.series_codes` — the backend's `extractSeriesCodes`
         * output, shipped on /api/shop and /api/products/:sku since the May
         * 2026 catalog overhaul. Trust it; the same regex set lives backend-side.
         *
         * Fallbacks (legacy responses + the new compatible name format that puts
         * the type words BEFORE the brand): manufacturer_part_number, then a
         * brand-specific regex over the name with the leading marketing prefix
         * (`Compatible Ink Cartridge Replacement for <Brand>` or `<Brand>
         * Genuine`) stripped so the regex anchors on the model number, not
         * the boilerplate.
         */
        extractProductCode(info) {
            // Backend-supplied — trust it.
            if (Array.isArray(info.series_codes) && info.series_codes.length) {
                const first = String(info.series_codes[0] || '').trim();
                if (first) return first.replace(/-/g, '').toUpperCase();
            }

            const brand = (info.brandName || '').toLowerCase();
            const patterns = {
                brother: /\b(LC[-]?\d{2,5}(?:XL)?|TN[-]?\d{3,4}|DR[-]?\d{3,4})\b/i,
                canon: /\b((?:PG|CL|PGI|CLI)[-]?\d{2,4}(?:XL)?)\b/i,
                epson: /\b(T\d{2,4}(?:XL)?|C13T\d+)\b/i,
                hp: /\b(\d{2,3}(?:XL)?[AX]?|CF\d{3}[AX]?|CE\d{3}[AX]?|W\d{4}[AX]?)\b/i,
                samsung: /\b((?:MLT[-]?D|CLT[-]?[CKMY])\d{3}[SL]?)\b/i,
                oki: /\b(C\d{3,4}|B\d{3,4})\b/i,
                'fuji-xerox': /\b(CT\d{6}|CWAA\d{4})\b/i,
                kyocera: /\b(TK[-]?\d{3,4}|DK[-]?\d{3,4})\b/i,
                lexmark: /\b(\d{2}[A-Z]\d{3,6}[A-Z]?)\b/i
            };

            const pattern = patterns[brand] || patterns[brand.replace(/[\s-]/g, '')] ||
                /\b[A-Z]{1,3}[-]?\d{2,4}(?:XL)?\b/i;

            // Strip the marketing prefix so the brand regex anchors on the
            // model code. The May 2026 compatible name format is
            // `Compatible <Type> Cartridge Replacement for <Brand> <Codes> <Color>`,
            // so we strip "Compatible <words> for <Brand>" as well as the
            // legacy "<Brand>" leading variant.
            const nameWithoutPrefix = (info.name || '')
                .replace(/^Compatible\s+[A-Za-z\s]+?\s+for\s+/i, '')
                .replace(/^Compatible\s+/i, '')
                .replace(new RegExp('^' + info.brandName + '\\s+(?:Genuine\\s+)?', 'i'), '');
            const sources = [info.manufacturer_part_number, nameWithoutPrefix, info.name];

            for (const source of sources) {
                if (!source) continue;
                const match = source.match(pattern);
                if (match) {
                    // Normalize: remove dashes, uppercase
                    return match[1] ? match[1].replace(/-/g, '').toUpperCase() : match[0].replace(/-/g, '').toUpperCase();
                }
            }
            return null;
        },

        renderProduct() {
            const info = this.getProductInfo();
            const price = parseFloat(info.retail_price || 0);
            const seo = info.seo || {};
            const og = seo.og || {};

            // Canonical URL — backend now owns this on every product (info.canonical_url).
            // Falls back to seo.canonical, then a constructed slug URL for legacy responses.
            const slug = info.slug || info.sku.toLowerCase();
            const canonicalUrl = info.canonical_url || seo.canonical || `https://www.inkcartridges.co.nz/products/${slug}/${info.sku}`;

            // Page title and meta description — prefer API seo fields, fall back to computed
            // Only assert "Genuine" when the trusted `source` field explicitly
            // says so — never from `!isCompatible`, which is also true for
            // ribbons and unknown-source items (a false "Genuine …" claim in
            // the indexed <title>). MC audit, Jul 2026.
            const genuinePrefix = info.source === 'genuine' ? 'Genuine ' : '';
            const computedTitle = `${genuinePrefix}${info.displayName} NZ | InkCartridges.co.nz`;
            document.title = seo.title || computedTitle;

            const metaDescription = seo.description || this.generateMetaDescription(info);
            document.getElementById('meta-description').content = metaDescription;

            // Keywords — set when provided
            const keywordsEl = document.getElementById('meta-keywords');
            if (keywordsEl) keywordsEl.content = seo.keywords || '';

            // Open Graph tags — prefer seo.og.* fields
            document.getElementById('og-title').content = og.title || `${info.displayName} | InkCartridges.co.nz`;
            document.getElementById('og-description').content = og.description || metaDescription;
            document.getElementById('og-url').content = canonicalUrl;
            document.getElementById('og-image').content = og.image || info.image_url || '/assets/images/logo.png';
            document.getElementById('og-type').content = og.type || 'product';
            document.getElementById('og-price').content = price.toFixed(2);

            // Twitter tags mirror OG
            document.getElementById('twitter-title').content = og.title || `${info.displayName} | InkCartridges.co.nz`;
            document.getElementById('twitter-description').content = og.description || metaDescription;
            if (og.image || info.image_url) {
                document.getElementById('twitter-image').content = og.image || info.image_url;
            }

            // Canonical URL
            document.getElementById('canonical-url').href = canonicalUrl;

            // hreflang alternates track the canonical (single locale, self-referential).
            const hrefEn = document.getElementById('hreflang-en');
            const hrefDefault = document.getElementById('hreflang-default');
            if (hrefEn) hrefEn.href = canonicalUrl;
            if (hrefDefault) hrefDefault.href = canonicalUrl;

            // Structured data (Product / BreadcrumbList / FAQPage) is deliberately
            // NOT emitted client-side. See marketing-audit-may-2026.md §4 and the
            // comment block in html/product/index.html: the backend prerender
            // layer (/api/prerender/product/:sku) is the single source of product
            // JSON-LD for every Google crawler. A second client-side copy created
            // two Product nodes with different @ids on the same URL — a Google
            // Merchant Center "Unacceptable Business Practices" trigger.
            //
            // `seo.jsonLd.faq_schema` is still read — but only to populate the
            // *visible* FAQ accordion (renderFaqAccordion below). That is on-page
            // UI, not JSON-LD markup, so it carries no duplication risk.
            if (seo.jsonLd && typeof seo.jsonLd === 'object' && seo.jsonLd.faq_schema) {
                this._faqSchema = seo.jsonLd.faq_schema;
            }

            // Breadcrumb
            const isRibbon = info.category === 'ribbon';
            const ribbonSubtypeLabel = info.product_type === 'typewriter_ribbon' ? 'Typewriter Ribbons' :
                                       info.product_type === 'correction_tape'   ? 'Correction Tape' :
                                       info.product_type === 'printer_ribbon'    ? 'Printer Ribbons' : 'Ribbons';
            const categoryName = isRibbon ? ribbonSubtypeLabel :
                                 info.category === 'toner' ? 'Toner Cartridges' :
                                 info.category === 'drum' ? 'Drums' : 'Ink Cartridges';
            const brandSlug = info.brandName.toLowerCase().replace(/\s+/g, '-');
            // Emit the backend's canonical category slug in breadcrumb links
            // (IA reorg Jul 2026): the product payload's `category` can be the
            // singular 'drum', which the /shop redirect layer would strip.
            const canonCategory = (typeof canonicalizeCategory === 'function' && canonicalizeCategory(info.category)) || info.category;
            if (isRibbon) {
                document.getElementById('breadcrumb-category').innerHTML = `<a href="/ribbons">${Security.escapeHtml(categoryName)}</a>`;
                document.getElementById('breadcrumb-brand').innerHTML = `<a href="/ribbons?printer_brand=${Security.escapeAttr(info.brandName.toLowerCase())}">${Security.escapeHtml(info.brandName)}</a>`;
            } else {
                document.getElementById('breadcrumb-category').innerHTML = `<a href="/shop?brand=${Security.escapeAttr(brandSlug)}&category=${Security.escapeAttr(canonCategory)}">${Security.escapeHtml(categoryName)}</a>`;
                document.getElementById('breadcrumb-brand').innerHTML = `<a href="/shop?brand=${Security.escapeAttr(brandSlug)}">${Security.escapeHtml(info.brandName)}</a>`;
            }

            // Add product code breadcrumb (e.g., LC37) — skip for ribbons
            if (!isRibbon) {
                const productCode = this.extractProductCode(info);
                const breadcrumbCode = document.getElementById('breadcrumb-code');
                if (productCode && breadcrumbCode) {
                    breadcrumbCode.innerHTML = `<a href="/shop?brand=${Security.escapeAttr(brandSlug)}&category=${Security.escapeAttr(canonCategory)}&code=${Security.escapeAttr(productCode)}">${Security.escapeHtml(productCode)}</a>`;
                    breadcrumbCode.hidden = false;
                }
            }

            document.getElementById('breadcrumb-product').textContent = info.displayName;

            // BreadcrumbList JSON-LD is intentionally not emitted here — the
            // backend prerender layer owns it (marketing-audit-may-2026.md §4).
            // The visible breadcrumb nav above is the only client-side breadcrumb.

            // Product badge — a visible Genuine/Compatible status pill, keyed
            // off the trusted `source` field (issue #8). We never assert a
            // status we don't know: universal / unknown-source items (some
            // ribbons) keep the badge hidden rather than guess.
            const badge = document.getElementById('product-badge');
            if (info.source === 'genuine') {
                badge.textContent = 'GENUINE';
                badge.className = 'product-info__badge product-info__badge--genuine';
                badge.hidden = false;
            } else if (info.source === 'compatible') {
                badge.textContent = 'COMPATIBLE';
                badge.className = 'product-info__badge product-info__badge--compatible';
                badge.hidden = false;
            } else {
                badge.hidden = true;
            }
            // Factual explainer link beside the badge (MC audit, Jul 2026) so a
            // shopper can learn what genuine vs compatible means. Only shown when
            // we actually have a source to explain.
            if ((info.source === 'genuine' || info.source === 'compatible')
                && badge.parentNode && !badge.parentNode.querySelector('.product-info__badge-help')) {
                badge.insertAdjacentHTML('afterend',
                    ' <a href="/genuine-vs-compatible" class="product-info__badge-help">What’s the difference?</a>');
            }
            if (info.isCompatible) {
                document.querySelector('.product-detail__layout').classList.add('product-detail__layout--compatible');
            }

            // Title and SKU
            document.getElementById('product-title').textContent = info.displayName;
            document.getElementById('product-sku').textContent = `SKU: ${info.sku}${info.manufacturer_part_number ? ' | Model: ' + info.manufacturer_part_number : ''}`;

            // Quick-spec list (Colour · Page yield) — issue #8. Only real,
            // reliable API values; suspicious yields are suppressed.
            this.renderSpecs(info);

            // Price - use formatPrice() for consistent locale-aware currency display.
            // Also set the schema.org `content` attribute so the Offer microdata
            // (wrapping <dl class="buy-box">) carries the numeric value — Google
            // Merchant Center reads itemprop="price" content, not the visible
            // formatted string. product-page-buybox-may2026.md §"prerender HTML".
            const priceEl = document.getElementById('product-price');
            priceEl.textContent = formatPrice(price);
            if (Number.isFinite(price) && price > 0) {
                priceEl.setAttribute('content', price.toFixed(2));
            }

            // Four-row buy-box (Price · Availability · Delivery · Returns).
            // Price + Availability rows are filled by the existing renderers
            // above/below; Delivery + Returns come from the May 2026 additive
            // payload objects (data.delivery_estimate, data.trust_signals.returns).
            // Production may still be on a pre-May-2026 deploy that doesn't ship
            // these fields, so we fall back to the locked copy from the spec
            // rather than rendering a blank row.
            this.renderBuyBoxDeliveryAndReturns(info);

            // Compatible-product compliance disclaimer (Google Ads re-appeal,
            // Jul 2026). For source === 'compatible' only, render the vetted
            // trademark / third-party / CGA panel directly under the buy box so
            // the SPA mirrors the copy the backend already serves to bots
            // (parity = no cloaking). Genuine / unknown-source render nothing.
            this.renderComplianceDisclaimer(info);

            // Value-pack upsell from the backend's pack_suggestion field
            // (IA reorg Jul 2026). Fail-soft: stays hidden unless the payload
            // carries a complete, sane suggestion.
            this.renderPackSuggestion(info);

            // Compare price & savings — prefer backend-derived original_price/discount_percent;
            // fall back to local compare_price math for legacy responses.
            const originalPrice = info.original_price != null
                ? parseFloat(info.original_price)
                : parseFloat(info.compare_price || 0);
            if (originalPrice && originalPrice > price) {
                const savingsAmount = info.discount_amount != null
                    ? parseFloat(info.discount_amount)
                    : (originalPrice - price);
                const savingsPct = info.discount_percent != null
                    ? info.discount_percent
                    : Math.round((savingsAmount / originalPrice) * 100);
                // Value packs / multipacks render dollars only — the pack
                // already broadcasts its "savings vs singles" via the Value
                // Pack ribbon, so the percent reads as redundant copy.
                const _packType = (info.pack_type || '').toString().toLowerCase();
                const _isPack = _packType === 'value_pack' || _packType === 'multipack';
                priceEl.insertAdjacentHTML('afterend',
                    `<span class="product-detail__compare-price">Was ${formatPrice(originalPrice)}</span>
                     <span class="product-detail__savings">Save ${formatPrice(savingsAmount)}${_isPack ? '' : ` (${savingsPct}%)`}</span>`);
            }

            // Cost-per-page value anchor — marketing-audit-may-2026.md §1.1.
            // The strongest persuasion lever for B2B / office buyers: it
            // reframes a $X cartridge as a fraction of a cent per printed
            // page. The backend emits `cost_per_page_display` (a pre-formatted
            // string — "3.0¢ per page" or "$0.123 per page") ONLY when the
            // maths is meaningful: a single cartridge with a real page yield.
            // It is deliberately absent on value packs and ml-rated bottles.
            // When absent we render nothing — never compute it client-side
            // (page yield / pack semantics live with the backend). Painted in
            // the price accent colour and placed directly under the price,
            // never buried in the spec table.
            if (info.cost_per_page_display) {
                const pricingEl = document.querySelector('.product-info__pricing');
                if (pricingEl) {
                    pricingEl.insertAdjacentHTML('beforeend',
                        `<span class="product-cost-per-page" data-testid="cost-per-page">${Security.escapeHtml(String(info.cost_per_page_display))}</span>`);
                }
            }

            // GST trust signal lives in the static "Incl. GST" badge rendered
            // beside the price (html/product/index.html). The dollar breakdown
            // was redundant alongside the badge, so it is intentionally not
            // injected here — pinned by tests/inc-gst-amount-removed.test.js.

            // Shipping callout — superseded by the Delivery row of the four-row
            // buy-box (product-page-buybox-may2026.md). The free-shipping promise
            // now lives in data.trust_signals.shipping_promise.promise; we still
            // route the lookup through qualifiesForFreeShipping so any future
            // surface that re-enables a free-shipping pill stays in lockstep
            // with the cart-progress threshold (and so the regression guard in
            // tests/free-shipping-pill.test.js keeps tracking the PDP). The
            // computed flag is also dropped onto the element as a data attribute
            // so a future feature can light it up without a JS edit.
            const shippingNoteEl = document.getElementById('product-shipping-note');
            if (shippingNoteEl) {
                shippingNoteEl.hidden = true;
                shippingNoteEl.innerHTML = '';
                shippingNoteEl.dataset.qualifiesFreeShipping = qualifiesForFreeShipping(info) ? 'true' : 'false';
            }

            // Stock status — dynamic based on API fields
            const stockStatus = getStockStatus(info);
            const stockEl = document.getElementById('product-stock');
            const stockIcons = {
                'in-stock': '<polyline points="20 6 9 17 4 12"/>',
                'out-of-stock': '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
                'contact-us': '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>'
            };
            stockEl.innerHTML = `<span class="stock-status stock-status--${stockStatus.class}">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${stockIcons[stockStatus.class] || stockIcons['in-stock']}</svg>
                ${Security.escapeHtml(stockStatus.text)}
            </span>`;

            // Stock-urgency cue — marketing-audit-may-2026.md §1.2. The backend
            // emits `stock_urgency` ONLY for genuine products: compatibles are
            // pinned at stock_quantity = 100 by business rule, so an urgency
            // label there would be a lie. 'low' (1–4 units left) earns the
            // labelled pill ("Only N left") AND flips the buy box to an
            // attention-red treatment; 'medium' (5–14) shows the calmer "Low
            // stock" label with NO box restyle — urgency without alarm.
            // 'high' / 'out' / an absent field render nothing. We re-gate on
            // `source === 'genuine'` defensively even though the backend
            // already does, so a future endpoint that leaks the field onto a
            // compatible row still can't paint a false scarcity claim.
            const stockUrgency = info.stock_urgency;
            if (info.source === 'genuine'
                && (stockUrgency === 'low' || stockUrgency === 'medium')
                && info.stock_urgency_label) {
                stockEl.insertAdjacentHTML('beforeend',
                    `<span class="stock-urgency stock-urgency--${stockUrgency}" data-testid="stock-urgency">${Security.escapeHtml(String(info.stock_urgency_label))}</span>`);
                if (stockUrgency === 'low') {
                    const buyBox = document.querySelector('.product-info__actions');
                    if (buyBox) buyBox.classList.add('product-info__actions--urgent');
                }
            }

            // Out-of-stock CTA per contact-button-may2026.md — both
            // 'out-of-stock' and 'contact-us' classes collapse into one
            // primary "Contact us" anchor → /contact. The waitlist UI
            // is removed; the waitlist API stays mounted (so cached
            // bundles don't 404) but no surface calls it. The PDP main
            // CTA is unique on the page (not nested in another <a>) so
            // we use a real <a> here per spec.
            const contactCtaLabel = `Contact us about ${Security.escapeAttr(info.displayName || info.name || 'this product')}`;
            const contactCtaPdp = `<a href="/contact"
                        class="btn btn--primary btn--lg product-info__add-to-cart"
                        aria-label="${contactCtaLabel}"
                        style="text-decoration:none;display:inline-flex;align-items:center;justify-content:center;gap:8px;">
                        Contact us
                    </a>`;
            if (stockStatus.class === 'out-of-stock' || stockStatus.class === 'contact-us') {
                const addBtn = document.getElementById('add-to-cart-btn');
                if (addBtn) addBtn.outerHTML = contactCtaPdp;
                const qtyInput = document.getElementById('product-quantity');
                if (qtyInput) qtyInput.disabled = true;
            }

            // Sync sticky mobile Add-to-Cart bar with stock status
            const stickyBtn = document.getElementById('sticky-atc-btn');
            const stickyBar = document.getElementById('sticky-atc');
            if (stickyBtn && stickyBar) {
                if (stockStatus.class === 'out-of-stock' || stockStatus.class === 'contact-us') {
                    stickyBtn.outerHTML = `<a href="/contact"
                        class="btn btn--primary sticky-atc__btn"
                        aria-label="${contactCtaLabel}"
                        style="text-decoration:none;display:inline-flex;align-items:center;justify-content:center;gap:8px;">
                        Contact us
                    </a>`;
                }
            }

            // Product image with color fallback
            const productImageEl = document.getElementById('product-image');
            const colorStyle = ProductColors.getProductStyle(info);
            // Build srcset for responsive product detail images (400/600/800w)
            const detailSrcset = typeof imageSrcset === 'function' && info.image_url_raw ? imageSrcset(info.image_url_raw, [400, 600, 800]) : '';
            const detailSrcsetHtml = detailSrcset ? ` srcset="${Security.escapeAttr(detailSrcset)}" sizes="(max-width: 480px) 400px, (max-width: 768px) 600px, 800px"` : '';
            // High-res source for the hover-magnify zoom state. Prefer the
            // un-optimized raw URL (crisp when scaled up); fall back to the
            // optimized URL. Swapped in lazily on first hover — see
            // initProductImageZoom() below.
            const zoomSrcHtml = ` data-zoom-src="${Security.escapeAttr(Security.sanitizeUrl(info.image_url_raw || info.image_url))}"`;
            // Stale-swatch fallback — if the product image is the legacy
            // per-SKU "color-swatch-vN.png" we hand-uploaded once, drop it
            // and render the canonical color block instead so admin color
            // edits propagate without needing a fresh upload. See
            // ProductColors.isPlaceholderSwatchImage in utils.js for the
            // detection rule. Pinned by tests/stale-color-swatch.test.js.
            const _swatchStale = ProductColors.isPlaceholderSwatchImage(info.image_url) && colorStyle && info.isCompatible;
            if (info.image_url && !_swatchStale) {
                if (colorStyle) {
                    // Image with color fallback on error
                    productImageEl.innerHTML = `
                        <img src="${Security.escapeAttr(Security.sanitizeUrl(info.image_url))}" alt="${Security.escapeAttr(info.displayName)}"${detailSrcsetHtml}${zoomSrcHtml} style="max-width: 100%; height: auto;"
                             data-fallback="color-block">
                        <div class="product-gallery__color-block" style="${colorStyle}; display: none;"></div>`;
                } else {
                    // Image with placeholder fallback
                    productImageEl.innerHTML = `<img src="${Security.escapeAttr(Security.sanitizeUrl(info.image_url))}" alt="${Security.escapeAttr(info.displayName)}"${detailSrcsetHtml}${zoomSrcHtml} style="max-width: 100%; height: auto;"
                        data-fallback="placeholder">`;
                }

                // Bind image fallback handlers
                productImageEl.querySelectorAll('img[data-fallback]').forEach(img => {
                    img.addEventListener('error', function() {
                        if (this.dataset.fallback === 'color-block') {
                            this.style.display = 'none';
                            const sibling = this.nextElementSibling;
                            if (sibling) sibling.style.display = 'flex';
                        } else if (this.dataset.fallback === 'placeholder') {
                            this.removeAttribute('data-fallback');
                            this.src = '/assets/images/placeholder-product.svg';
                        }
                        // A failed image must not stay hover-zoomable — the
                        // fallback tile/placeholder is not a photo to magnify.
                        productImageEl.classList.remove('product-gallery__main--zoomable');
                        this.style.transform = '';
                    }, { once: true });
                });

                // Hover-to-magnify: cursor-follow inner zoom on the main photo.
                initProductImageZoom(productImageEl);
            } else {
                // No image (or stale swatch image stripped above). Genuine-no-
                // color-tile invariant: only compatible products may show a
                // color tile when image_url is missing. Genuine packs
                // (KCMY/CMY) ship with image_url=NULL while the composite-
                // image generator runs separately — they MUST fall through to
                // the placeholder, never a striped gradient tile.
                if (info.isCompatible && colorStyle) {
                    // colorStyle is safe — sourced from hardcoded ProductColors.map
                    productImageEl.classList.add('product-gallery__main--color-only');
                    productImageEl.closest('.product-detail__layout').classList.add('product-detail__layout--color-only');
                    productImageEl.innerHTML = `<div class="product-gallery__color-block" style="${colorStyle}"></div>`;
                } else if (info.isCompatible) {
                    // Compatible with no known color — default to black
                    productImageEl.classList.add('product-gallery__main--color-only');
                    productImageEl.closest('.product-detail__layout').classList.add('product-detail__layout--color-only');
                    productImageEl.innerHTML = `<div class="product-gallery__color-block" style="background-color: #1a1a1a;"></div>`;
                } else {
                    productImageEl.innerHTML = `<img src="/assets/images/placeholder-product.svg" alt="${Security.escapeAttr(info.displayName)}" style="max-width: 100%; height: auto;">`;
                }
            }

            // OEM-verified trust badge — marketing-audit-may-2026.md §1.3.
            // The backend sets `is_oem_verified` when a genuine product's photo
            // cleared the 4-layer Claude Vision check (blocklist → filename
            // match → edge density → vision, verdict VERIFIED_BOX /
            // VERIFIED_PRODUCT). Surfaced as a small badge under the gallery,
            // it counters the Trade Me / AliExpress fake-cartridge anxiety
            // that suppresses genuine-toner conversion. The verifier never
            // runs on compatibles, so the field is absent there — we render
            // the badge only on a strict `=== true`, never on a falsy/missing
            // value, so "unverified" never reads as "fake".
            if (info.is_oem_verified === true) {
                const galleryEl = document.querySelector('.product-gallery');
                if (galleryEl) {
                    galleryEl.insertAdjacentHTML('beforeend',
                        `<div class="oem-verified" data-testid="oem-verified" title="This product image was verified as a genuine manufacturer product by automated image analysis.">
                            <svg class="oem-verified__icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>
                            <span>Verified genuine product image</span>
                        </div>`);
                }
            }

            // Compatible devices: printers/typewriters
            this.renderCompatiblePrinters(info);

            // Frequently bought together
            this.renderBoughtTogether(info);

            // Compatible products for ALL categories
            this.renderRelatedProducts(info);

            // Ribbon description — render below related products
            this.renderRibbonDescription(info);

            // FAQ accordion from API JSON-LD
            this.renderFaqAccordion();

            // Set up event listeners
            this.setupEventListeners(info);

        },

        /**
         * Four-row buy-box — Delivery and Returns.
         *
         * Spec: readfirst/product-page-buybox-may2026.md (locked copy, in the
         * exact order Price · Availability · Delivery · Returns).
         *
         * Data: `data.delivery_estimate` and `data.trust_signals.returns` —
         * additive payload objects shipped with the May 2026 SEO meta cleanup.
         * Both come from the single source the cart/checkout/account already
         * read, so the numbers cannot drift between surfaces.
         *
         * Fallbacks: production may still be running a pre-May-2026 build that
         * omits these objects. Rather than render a blank row (which would mark
         * the page as cloaking — the prerender ships the full copy regardless),
         * we fall back to the locked spec copy. The fallback strings are the
         * exact same strings the backend ships, so the SPA and prerender match
         * even on the legacy payload.
         */
        // Quick-spec list: Colour and (reliable) Page yield. Rendered outside
        // the pinned buy-box so it can't disturb SERP/prerender parity. Stays
        // hidden unless at least one trustworthy spec exists.
        renderSpecs(info) {
            const el = document.getElementById('product-specs');
            if (!el) return;
            const rows = [];
            if (info.color) {
                rows.push(`<li class="product-info__spec"><span class="product-info__spec-label">Colour</span><span class="product-info__spec-value">${Security.escapeHtml(String(info.color))}</span></li>`);
            }
            const yieldN = this.plausibleYield(info.pageYield);
            if (yieldN) {
                rows.push(`<li class="product-info__spec"><span class="product-info__spec-label">Page yield</span><span class="product-info__spec-value">${yieldN.toLocaleString()} pages (approx.)</span></li>`);
            }
            if (rows.length) {
                el.innerHTML = rows.join('');
                el.hidden = false;
            } else {
                el.innerHTML = '';
                el.hidden = true;
            }
        },

        renderBuyBoxDeliveryAndReturns(info) {
            const SPEC_DELIVERY_LABEL = '1–4 business days NZ-wide';
            const SPEC_DELIVERY_CUTOFF = '2pm';
            const SPEC_RETURNS_DAYS = 30;
            const SPEC_RETURNS_URL = '/returns';

            // Delivery row — `${label} · Order before ${cutoff} NZT for same-day dispatch`.
            const delivery = (info && info.delivery_estimate) || {};
            const dLabel = typeof delivery.label === 'string' && delivery.label.trim()
                ? delivery.label.trim()
                : SPEC_DELIVERY_LABEL;
            const dCutoff = typeof delivery.dispatch_cutoff_human === 'string' && delivery.dispatch_cutoff_human.trim()
                ? delivery.dispatch_cutoff_human.trim()
                : SPEC_DELIVERY_CUTOFF;
            const deliveryEl = document.getElementById('product-delivery');
            if (deliveryEl) {
                deliveryEl.innerHTML =
                    `<span class="buy-box__delivery-label">${Security.escapeHtml(dLabel)}</span>`
                    + ` <span class="buy-box__sep" aria-hidden="true">·</span> `
                    + `<span class="buy-box__delivery-cutoff">Order before ${Security.escapeHtml(dCutoff)} NZT for same-day dispatch</span>`;
            }

            // Returns row — `${days}-day returns · Policy ›` linking to ${url_path}.
            const returns = (info && info.trust_signals && info.trust_signals.returns) || {};
            const rDaysNum = Number(returns.days);
            const rDays = Number.isFinite(rDaysNum) && rDaysNum > 0 ? rDaysNum : SPEC_RETURNS_DAYS;
            const rUrlRaw = typeof returns.url_path === 'string' && returns.url_path.trim()
                ? returns.url_path.trim()
                : SPEC_RETURNS_URL;
            // Sanitise the URL — only same-origin relative paths or
            // https://www.inkcartridges.co.nz absolute URLs are allowed through.
            const rUrl = this._safeReturnsUrl(rUrlRaw, SPEC_RETURNS_URL);
            const returnsEl = document.getElementById('product-returns');
            if (returnsEl) {
                returnsEl.innerHTML =
                    `<span class="buy-box__returns-days">${rDays}-day returns</span>`
                    + ` <span class="buy-box__sep" aria-hidden="true">·</span> `
                    + `<a class="buy-box__returns-link" href="${Security.escapeAttr(rUrl)}">Policy <span aria-hidden="true">›</span></a>`;
            }
        },

        /**
         * Compatible-product compliance disclaimer (Google Ads re-appeal,
         * Jul 2026). Renders the vetted trademark / third-party / Consumer
         * Guarantees Act panel between the buy box and the description for
         * COMPATIBLE products only. Keyed off the trusted `source` field, NOT
         * `isCompatible` (which is force-false for ribbons, so a compatible
         * ribbon must still get the disclaimer). The copy is vetted legal
         * phrasing — keep the trademark / third-party / supplier attribution
         * exactly as written, and never assert anything about the OEM's own
         * warranty. (Condensed 2026-07-15, owner request: the panel is now the
         * leanest compliant form — third-party / not-made-or-endorsed-by-OEM /
         * named legal entity. The "30-day satisfaction guarantee. …Consumer
         * Guarantees Act 1993 are unaffected." sentence was REMOVED here; CGA
         * disclosure still ships site-wide in js/footer.js. This intentionally
         * supersedes the ERR-078 parity restoration — the human panel is now
         * SHORTER than the backend prerender, so the prerender/meta re-sync is
         * owed backend-side, tracked as §5b in readfirst/backend-open-items-jul2026.md.
         * That is the SAFE cloaking direction — bots see more disclaimer than
         * humans, not less. The retired "12-month replacement warranty" claim
         * must NOT return.) Genuine / unknown-source products render nothing.
         */
        renderComplianceDisclaimer(info) {
            if (!info || info.source !== 'compatible') return;
            const pricingEl = document.querySelector('.product-info__pricing');
            if (!pricingEl || document.getElementById('compat-disclaimer')) return;

            // Human product-type label, lowercased — mirrors the map used by
            // generateMetaDescription(); falls back to a generic noun.
            const typeLabels = {
                'ink': 'ink cartridge',
                'toner': 'toner cartridge',
                'drum': 'drum unit',
                'ribbon': 'printer ribbon'
            };
            const type = typeLabels[info.category] || 'cartridge';
            const oem = Security.escapeHtml(info.brandName || 'the printer manufacturer');

            const html = `
                <div class="compat-disclaimer" id="compat-disclaimer">
                    Compatible (third-party) ${type} for ${oem} printers — not made or endorsed by ${oem}. Sold by Office Consumables Ltd.
                </div>`;
            pricingEl.insertAdjacentHTML('afterend', html);
        },

        /**
         * Value-pack upsell (IA reorg Jul 2026). The backend's product payload
         * carries `pack_suggestion` — the multipack of the SKU being viewed —
         * with sku/slug/name/retail_price/image_url/individual_total/
         * savings_amount(/savings_percent). Fail-soft: the #pack-upsell
         * container ships hidden and stays hidden unless the suggestion is
         * complete and sane. Savings render as DOLLARS ONLY — packs never show
         * a percent (value-pack convention, May 2026).
         */
        renderPackSuggestion(info) {
            const el = document.getElementById('pack-upsell');
            if (!el) return;
            const ps = info && info.pack_suggestion;
            const price = ps ? parseFloat(ps.retail_price) : NaN;
            const savings = ps ? parseFloat(ps.savings_amount) : NaN;
            if (!ps || typeof ps !== 'object' || !ps.sku || !ps.slug
                || !Number.isFinite(price) || price <= 0
                || !Number.isFinite(savings) || savings <= 0) {
                el.hidden = true;
                return;
            }
            const href = `/products/${encodeURIComponent(ps.slug)}/${encodeURIComponent(ps.sku)}`;
            const individualTotal = parseFloat(ps.individual_total);
            const compareHtml = (Number.isFinite(individualTotal) && individualTotal > price)
                ? ` <s class="pack-upsell__compare">${Security.escapeHtml(formatPrice(individualTotal))}</s>`
                : '';
            const imgSrc = ps.image_url
                ? Security.sanitizeUrl(typeof storageUrl === 'function' ? storageUrl(ps.image_url) : ps.image_url)
                : null;
            const imgHtml = imgSrc && imgSrc !== '#'
                ? `<img class="pack-upsell__thumb" src="${Security.escapeAttr(imgSrc)}" alt="" loading="lazy">`
                : '';
            el.innerHTML =
                `<div class="pack-upsell__eyebrow">Buying more than one?</div>`
                + `<a href="${Security.escapeAttr(href)}" class="pack-upsell__body" data-track="cta_click" data-track-cta="pack_upsell" data-track-location="product_page">`
                +     imgHtml
                +     `<span class="pack-upsell__copy">`
                +         `<span class="pack-upsell__name">${Security.escapeHtml(ps.name || ps.sku)}</span>`
                +         `<span class="pack-upsell__price">${Security.escapeHtml(formatPrice(price))}${compareHtml}</span>`
                +         `<span class="pack-upsell__savings">Save ${Security.escapeHtml(formatPrice(savings))} vs buying singles</span>`
                +     `</span>`
                +     `<span class="pack-upsell__arrow" aria-hidden="true">›</span>`
                + `</a>`;
            el.hidden = false;
        },

        /**
         * Returns-policy URL is operator-controlled (env-driven backend field),
         * but we treat it as untrusted on the client. Allow only same-origin
         * relative paths or the canonical https://www.inkcartridges.co.nz host.
         * Anything else (javascript:, data:, foreign hosts) collapses to the
         * spec default so a misconfigured env var cannot punch a hole in the
         * PDP. Mirrors the discipline of Security.sanitizeUrl used on images.
         */
        _safeReturnsUrl(raw, fallback) {
            try {
                if (raw.startsWith('/')) return raw;
                const u = new URL(raw);
                if (u.protocol !== 'https:' && u.protocol !== 'http:') return fallback;
                if (u.host === 'www.inkcartridges.co.nz' || u.host === 'inkcartridges.co.nz') {
                    return u.pathname + u.search + u.hash;
                }
                return fallback;
            } catch (_) {
                return fallback;
            }
        },

        renderCompatPreview(printers) {
            const wrap = document.getElementById('compat-preview');
            const list = document.getElementById('compat-preview-list');
            const more = document.getElementById('compat-preview-more');
            if (!wrap || !printers || !printers.length) return;
            const shown = printers.slice(0, 3);
            list.textContent = shown.map(p => p.name || p).join(', ');
            if (printers.length > 3) {
                more.textContent = `+${printers.length - 3} more`;
                more.hidden = false;
                more.addEventListener('click', (e) => {
                    e.preventDefault();
                    const tabBtn = document.getElementById('tab-btn-compatibility');
                    if (tabBtn) {
                        tabBtn.click();
                        tabBtn.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }
                });
            }
            wrap.hidden = false;
        },

        renderRibbonDescription(info) {
            if (!info.description_html) return;
            const productLabel = Security.escapeHtml(info.displayName || info.name || 'This Product');
            const html = `
                <div class="ribbon-description ribbon-description--inline" id="ribbon-description">
                    <div class="ribbon-description__content">${info.description_html}</div>
                </div>`;
            const skuEl = document.getElementById('product-sku');
            if (skuEl) {
                skuEl.insertAdjacentHTML('afterend', html);
            }
        },

        /**
         * Build a printer-hub deep link — marketing-audit-may-2026.md §2.
         *
         * The canonical printer hub is `/shop?brand=<brand_slug>&printer_slug=
         * <slug>`. Both halves now arrive on the API (`compatible_printers[]`
         * entries carry `slug` + `brand_slug`; `compatible_printers_grouped`
         * carries `brand_slug` + per-model `slug`), so the storefront no
         * longer has to guess them from the display name.
         *
         * When a usable slug pair is missing (legacy row), we degrade to a
         * `/shop?q=<name>` search so the link still resolves to something
         * sensible rather than 404-ing.
         */
        _printerHubHref(entry) {
            if (!entry) return '/shop';
            const brandSlug = entry.brand_slug
                || (entry.brand ? String(entry.brand).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : '');
            const name = entry.full_name || entry.name
                || (entry.brand && entry.model_name ? `${entry.brand} ${entry.model_name}` : entry.model_name)
                || '';
            if (brandSlug && entry.slug) {
                return `/shop?brand=${encodeURIComponent(brandSlug)}&printer_slug=${encodeURIComponent(entry.slug)}`;
            }
            return `/shop?q=${encodeURIComponent(name || brandSlug)}`;
        },

        /**
         * Fast path — render the backend's `compatible_printers_grouped`
         * (marketing-audit-may-2026.md §1.4). Collapses a 40-line printer
         * dump into one "Fits <Brand> — model, model, model + N more" row
         * per brand, brand-sorted descending by `total`, each of the first
         * three models deep-linked to its printer hub.
         *
         * @returns {boolean} true when it rendered (caller then skips the
         *   flat-list and Supabase fallbacks).
         */
        _renderGroupedPrinterCompat(info) {
            // Ribbons keep their own `/ribbons?printer_model=` routing — the
            // grouped contract is an ink/toner printer-hub feature.
            if (info.category === 'ribbon') return false;
            const groups = Array.isArray(info.compatible_printers_grouped)
                ? info.compatible_printers_grouped.filter(g => g && g.brand)
                : [];
            if (!groups.length) return false;

            const rows = groups.map(group => {
                const models = Array.isArray(group.top_models) ? group.top_models.filter(m => m && m.full_name) : [];
                const linked = models.map(m => {
                    const href = this._printerHubHref({ slug: m.slug, brand_slug: group.brand_slug, brand: group.brand, full_name: m.full_name });
                    const label = (typeof ProductName !== 'undefined' && ProductName.compatModel)
                        ? (ProductName.compatModel(m.full_name, group.brand) || m.full_name)
                        : m.full_name;
                    return `<a href="${Security.escapeAttr(href)}" class="printer-link">${Security.escapeHtml(label)}</a>`;
                }).join(', ');
                const total = Number(group.total) || models.length;
                const remaining = total - models.length;
                // "+ N more" is plain text by design (audit §1.4 renders it as
                // such): the three linked models already give crawlable hub
                // links; an unanchored count avoids implying a dead link.
                const more = remaining > 0
                    ? ` <span class="compat-group__more">+${remaining} more</span>`
                    : '';
                return `<li class="compat-group">
                    <span class="compat-group__brand">Fits ${Security.escapeHtml(group.brand)}</span>
                    <span class="compat-group__models">${linked || Security.escapeHtml(group.brand + ' printers')}</span>${more}
                </li>`;
            }).join('');

            const html = `
                <div class="product-printers-wrap">
                    <div class="container">
                        <div class="product-printers-banner product-printers-banner--grouped" data-testid="compat-grouped">
                            <strong class="product-printers-banner__label">For use in your printer</strong>
                            <ul class="compat-groups">${rows}</ul>
                        </div>
                    </div>
                </div>`;
            const insertTarget = document.querySelector('.related-products');
            if (insertTarget) {
                insertTarget.insertAdjacentHTML('beforebegin', html);
                return true;
            }
            return false;
        },

        /**
         * Fast path — render the flat `compatible_printers[]` array now that
         * each entry carries `slug` + `brand_slug` (marketing-audit-may-2026.md
         * §2). Skips the Supabase round-trip and the name-derived slug guess.
         *
         * @returns {boolean} true when it rendered.
         */
        _renderFlatPrinterCompat(info) {
            if (info.category === 'ribbon') return false;
            const printers = Array.isArray(info.compatible_printers)
                ? info.compatible_printers.filter(p => p && (p.full_name || p.model_name || p.name))
                : [];
            // Only take this path when at least one entry carries the new
            // slug data — otherwise the Supabase fallback (which also fans
            // out to sibling SKUs) gives a better result.
            if (!printers.length || !printers.some(p => p.slug)) return false;

            const links = printers.map(p => {
                let label = p.full_name || p.name
                    || (p.brand && p.model_name ? `${p.brand} ${p.model_name}` : p.model_name) || '';
                if (typeof ProductName !== 'undefined' && ProductName.compatModel) {
                    label = ProductName.compatModel(label, p.brand) || label;
                }
                const href = this._printerHubHref(p);
                return `<a href="${Security.escapeAttr(href)}" class="printer-link">${Security.escapeHtml(label)}</a>`;
            }).join(', ');

            const html = `
                <div class="product-printers-wrap">
                    <div class="container">
                        <div class="product-printers-banner" data-testid="compat-flat">
                            <strong>For Use In:</strong>
                            <span>${links}</span>
                        </div>
                    </div>
                </div>`;
            const insertTarget = document.querySelector('.related-products');
            if (insertTarget) {
                insertTarget.insertAdjacentHTML('beforebegin', html);
                return true;
            }
            return false;
        },

        async renderCompatiblePrinters(info) {
            // If product has admin-provided compatible devices HTML, render into left column
            if (info.compatible_devices_html) {
                const productLabel = Security.escapeHtml(info.displayName || info.name || 'This Product');
                const html = `
                    <div class="product-compat-devices">
                        <h2 class="product-compat-devices__title">FOR USE IN:</h2>
                        <div class="product-compat-devices__content">${info.compatible_devices_html}</div>
                    </div>`;
                const leftCol = document.getElementById('ribbon-col-left');
                if (leftCol) {
                    leftCol.insertAdjacentHTML('beforeend', html);
                    document.getElementById('ribbon-detail-columns').hidden = false;
                }
                return;
            }

            // Ribbons are OWNER-MANUAL (ribbon-manual directive, ERR-086): the
            // "FOR USE IN" block is only ever the admin-written
            // compatible_devices_html above. With no such copy we show NOTHING —
            // never auto-derive a compatible-printer list from the backend
            // product_compatibility join (that fallback runs below for
            // non-ribbons only). Search still indexes ribbon compatibility
            // server-side; this only governs what the PAGE displays.
            if (info.category === 'ribbon') return;

            // Fast path 1 — backend grouped compatibility (audit §1.4).
            if (this._renderGroupedPrinterCompat(info)) return;
            // Fast path 2 — flat compatible_printers[] with slug/brand_slug (§2).
            if (this._renderFlatPrinterCompat(info)) return;

            // Fallback — legacy responses carrying neither field: resolve the
            // printer list from Supabase, fanning out to sibling SKUs.
            try {
                // Try current product SKU first
                let printers = await this._fetchPrinters(info.sku);

                // If empty, find a sibling product that has printer data via Supabase
                if (printers.length === 0) {
                    const sb = (typeof Auth !== 'undefined' && Auth.supabase) ? Auth.supabase : null;
                    if (sb) {
                        // Extract product code for sibling search (e.g. "LC38" from "LC38M")
                        let code = this.extractProductCode(info);
                        // If extractProductCode fails, try a looser extraction from SKU
                        // e.g. G-BRO-LC38M-INK-MG → extract "LC38" by matching letter+digit patterns
                        if (!code) {
                            const skuMatch = info.sku.match(/([A-Z]{2,3}\d{2,4})/i);
                            if (skuMatch) code = skuMatch[1].replace(/-/g, '').toUpperCase();
                        }
                        if (code) {
                            const { data: siblings } = await sb.from('products')
                                .select('sku')
                                .ilike('name', `%${code}%`)
                                .neq('sku', info.sku)
                                .limit(15);
                            if (siblings) {
                                for (const sib of siblings) {
                                    printers = await this._fetchPrinters(sib.sku);
                                    if (printers.length > 0) break;
                                }
                            }
                        }
                    }
                }

                if (printers.length === 0) return;

                const isRibbon = info.category === 'ribbon';
                const printerLinks = printers.map(p => {
                    const slug = (p.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
                    const href = isRibbon
                        ? `/ribbons?printer_model=${encodeURIComponent(p.name)}`
                        : `/shop?q=${encodeURIComponent(slug)}`;
                    return `<a href="${href}" class="printer-link">${Security.escapeHtml(p.name)}</a>`;
                }).join(', ');

                const html = `
                    <div class="product-printers-wrap">
                        <div class="container">
                            <div class="product-printers-banner">
                                <strong>For Use In:</strong>
                                <span>${printerLinks}</span>
                            </div>
                        </div>
                    </div>
                `;

                const insertTarget = document.querySelector('.related-products');
                if (insertTarget) {
                    insertTarget.insertAdjacentHTML('beforebegin', html);
                }
            } catch (error) {
                // Silently fail — compatible printers are optional
            }
        },

        /**
         * Fetch compatible printer names for a given SKU via Supabase
         */
        async _fetchPrinters(sku) {
            try {
                const sb = (typeof Auth !== 'undefined' && Auth.supabase) ? Auth.supabase : null;
                if (!sb) return [];

                const { data: product } = await sb
                    .from('products')
                    .select('id')
                    .eq('sku', sku)
                    .single();
                if (!product) return [];

                const { data: compat } = await sb
                    .from('product_compatibility')
                    .select('printer_models(model_name, full_name, brands(name))')
                    .eq('product_id', product.id);
                if (!compat || compat.length === 0) return [];

                return compat.map(c => {
                    const pm = c.printer_models;
                    if (!pm) return null;
                    const brand = pm.brands?.name || '';
                    const name = pm.full_name || (brand && pm.model_name ? `${brand} ${pm.model_name}` : pm.model_name) || '';
                    return { name, brand };
                }).filter(p => p && p.name).sort((a, b) => a.name.localeCompare(b.name));
            } catch (e) {
                return [];
            }
        },

        async renderCompatibilityTab(info) {
            try {
                const printers = await this._fetchPrinters(info.sku);
                if (printers.length === 0) return;

                const list = document.getElementById('compatible-printers-list');
                const tabBtn = document.getElementById('tab-btn-compatibility');
                if (!list || !tabBtn) return;

                list.innerHTML = printers.map(p => {
                    const slug = (p.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
                    const label = (typeof ProductName !== 'undefined' && ProductName.compatModel)
                        ? (ProductName.compatModel(p.name, p.brand) || p.name) : p.name;
                    return `<li><a href="/shop?q=${encodeURIComponent(slug)}">${Security.escapeHtml(label)}</a></li>`;
                }).join('');

                tabBtn.hidden = false;
                this.renderCompatPreview(printers);
            } catch (e) {
                // Compatibility tab is optional
            }
        },

        async renderCompatibleDevices(info) {
            try {
                // Ribbon API returns compatible_printers: [{id, model_name, full_name, brand}]
                let devices = info.compatible_printers || info.compatible_devices;
                if (!devices || !devices.length) {
                    const res = await API.getRibbon(info.sku);
                    if (res.ok && res.data) {
                        devices = res.data.compatible_printers || res.data.compatible_devices;
                    }
                }
                if (!devices || !devices.length) return;

                const deviceLinks = devices.map(d => {
                    const modelKey = d.model_name || d.model || d.device_model || '';
                    const deviceBrand = d.brand || d.device_brand || '';
                    let raw = d.full_name || (deviceBrand && modelKey ? `${deviceBrand} ${modelKey}` : (deviceBrand || modelKey));
                    if (typeof ProductName !== 'undefined' && ProductName.compatModel) {
                        raw = ProductName.compatModel(raw, deviceBrand) || raw;
                    }
                    if (!raw || !modelKey) return null;
                    const label = Security.escapeHtml(raw);
                    return `<a href="/ribbons?printer_model=${encodeURIComponent(modelKey)}" class="printer-link">${label}</a>`;
                }).filter(Boolean);

                if (!deviceLinks.length) return;

                const html = `
                    <div class="product-printers-wrap">
                        <div class="container">
                            <div class="product-printers-banner">
                                <strong>For Use In:</strong>
                                <span>${deviceLinks.join(', ')}</span>
                            </div>
                        </div>
                    </div>
                `;

                // For ribbons: place before the closing main tag
                const mainEl = document.querySelector('main');
                if (mainEl) mainEl.insertAdjacentHTML('beforeend', html);
            } catch (e) {
                // Compatible devices are optional
            }
        },

        // _sortByColor was removed in the May 2026 catalog overhaul. Every
        // product-list endpoint now applies sortByCatalogOrder server-side
        // (see api-changes-may2026.md §1) — the client cannot replicate the
        // (accessoryTier, yieldTier, seriesBase, colorOrder, packRank, name)
        // hierarchy without shipping the same regex set as the backend, so
        // any client resort here is by definition wrong. Render in API order.

        async renderRelatedProducts(info) {
            try {
                const section = document.getElementById('related-products');
                if (!section) return;

                let related = [];
                const seenSkus = new Set([info.sku]);

                const addProducts = (products) => {
                    for (const p of products) {
                        if (seenSkus.has(p.sku)) {
                            // Merge image_url into existing entry if the new source has one
                            if (p.image_url) {
                                const existing = related.find(r => r.sku === p.sku);
                                if (existing && !existing.image_url) {
                                    existing.image_url = p.image_url;
                                }
                            }
                        } else {
                            seenSkus.add(p.sku);
                            related.push(p);
                        }
                    }
                };

                // For ribbons: related products are OWNER-CURATED ONLY — exactly the
                // `related_product_skus` hand-picked in the admin drawer's For Use In
                // tab, in the saved order. Ribbons are deliberately NOT auto-filled by
                // the backend (no shared-code family fetch): the ERR-082 code-family
                // union was retired 2026-07-16 per owner decision so a ribbon shows
                // only what the owner picked (ERR-085). The curated list still resolves
                // prefix-tolerantly (ERR-084) so a legacy bare-code entry still lands.
                if (info.category === 'ribbon') {
                    const manualSkus = info.related_product_skus;
                    if (Array.isArray(manualSkus) && manualSkus.length > 0) {
                        const sb = (typeof Auth !== 'undefined' && Auth.supabase) ? Auth.supabase : null;
                        if (sb) {
                            // Resolve prefix-tolerantly (ERR-084): a curated entry
                            // saved as a bare code ("141LOT") still finds the real
                            // C-/G-prefixed product ("C141LOT"). One query over the
                            // exact + prefixed candidate union; per entry the exact
                            // sku wins, else the first prefixed candidate that hits.
                            const candidates = [];
                            const seenCand = new Set();
                            for (const s of manualSkus) {
                                for (const c of relatedSkuCandidates(s)) {
                                    if (!seenCand.has(c)) { seenCand.add(c); candidates.push(c); }
                                }
                            }
                            const { data: manualProducts } = await sb.from('products')
                                .select('*')
                                .in('sku', candidates)
                                .eq('is_active', true);
                            if (manualProducts?.length) {
                                const byUpper = {};
                                manualProducts.forEach(p => { byUpper[String(p.sku).toUpperCase()] = p; });
                                const ordered = [];
                                const usedSku = new Set();
                                for (const s of manualSkus) {
                                    for (const c of relatedSkuCandidates(s)) {
                                        const hit = byUpper[c];
                                        if (hit && !usedSku.has(hit.sku)) { usedSku.add(hit.sku); ordered.push(hit); break; }
                                    }
                                }
                                addProducts(ordered);
                            }
                        }
                    }
                } else {
                    // Non-ribbon: mirror the brand+code shop page exactly.
                    // Use backend's own series list as the source of truth for the code,
                    // matching by substring against the product's name/MPN/SKU.
                    const brandSlug = info.brand?.slug || (info.brandName || '').toLowerCase();
                    const apiCategoryMap = { ink: 'ink', toner: 'toner', drum: 'drums', label_tape: 'label', ribbon: 'ribbons' };
                    const apiCategory = apiCategoryMap[info.category] || null;
                    if (brandSlug && apiCategory) {
                        // Prefer the backend-authoritative code (trusts info.series_codes,
                        // otherwise brand-regex with word boundaries). Only fall back to
                        // matching the brand's series list when that returns nothing — and
                        // then use a WHOLE-TOKEN test, never a bare substring, so a short
                        // series code (e.g. "45") can't match inside a model number
                        // (e.g. "C9452A") and divert Related Products to the wrong family.
                        let code = this.extractProductCode(info);
                        if (!code) {
                            const seriesRes = await API.getShopData({ brand: brandSlug, category: apiCategory });
                            const seriesList = seriesRes?.data?.series || [];
                            const haystack = [(info.name || ''), (info.manufacturer_part_number || ''), (info.sku || '')]
                                .join(' ').toUpperCase();
                            code = seriesList
                                .map(s => s.code)
                                .filter(Boolean)
                                .filter(c => {
                                    const esc = c.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                                    return new RegExp('(?:^|[^A-Z0-9])' + esc + '(?:[^A-Z0-9]|$)').test(haystack);
                                })
                                .sort((a, b) => b.length - a.length)[0];
                        }
                        if (code) {
                            const res = await API.getShopData({ brand: brandSlug, category: apiCategory, code, limit: 200 });
                            if (res.ok && res.data?.products) {
                                addProducts(res.data.products.filter(p => p.sku !== info.sku));
                            }
                        }
                    }
                }

                // For non-ribbons, hide if no related products found
                if (related.length === 0 && info.category !== 'ribbon') return;

                // Fill in missing image_url by fetching individual products
                const missingImages = related.filter(p => !p.image_url);
                if (missingImages.length > 0) {
                    const lookups = missingImages.map(p =>
                        API.getProduct(p.sku).then(resp => {
                            if (resp.ok && resp.data?.image_url) {
                                p.image_url = resp.data.image_url;
                            }
                        }).catch(() => {})
                    );
                    await Promise.all(lookups);
                }

                // Trust `product.source` — the canonical backend field. The May
                // 2026 catalog overhaul changed the compatible-name format to
                // `Compatible <Type> Cartridge Replacement for <Brand> <Codes>
                // <Color>`, which means a name-based fallback (`startsWith
                // ('compatible')`) would still pass for compatibles but is
                // explicitly deprecated by the backend team — they want one
                // source of truth, the `source` field. If a row arrives without
                // it, fall through to the current product's source as a tie-
                // breaker rather than parsing the name.
                // Never invent a source. A related row with no `source` inherits
                // the CURRENT product's source as a documented same-context tie-
                // breaker, but we do NOT fall back to a hardcoded 'genuine' — that
                // would badge unknown items GENUINE (a false claim). MC audit.
                const inferSource = (p) => p.source || info.source;
                // When the current product's own source is unknown, the whole
                // genuine/compatible split is guesswork — suppress the source
                // badges on related products rather than assert one.
                const sourceKnown = info.source === 'genuine' || info.source === 'compatible';

                const isCompatible = info.source === 'compatible';
                // Apply the (familyKey → yieldTier → colorTier) override per
                // source group so PDP related products render in the same
                // K→C→M→Y per-code rows the shop grid uses.
                // Spec: readfirst/code-yield-grouping-may2026.md
                const sortByCodeThenColor = (arr) => (typeof ProductSort !== 'undefined' && ProductSort.byCodeThenColor)
                    ? ProductSort.byCodeThenColor(arr)
                    : arr;
                const compatibles = sortByCodeThenColor(related.filter(p => inferSource(p) === 'compatible'));
                const genuines    = sortByCodeThenColor(related.filter(p => inferSource(p) !== 'compatible'));

                const firstGroup  = isCompatible ? compatibles : genuines;
                const secondGroup = isCompatible ? genuines    : compatibles;
                const firstLabel  = isCompatible ? 'compatible' : 'genuine';
                const secondLabel = isCompatible ? 'genuine'    : 'compatible';

                const inferProductType = (p) => {
                    const pt = (p.product_type || '').toLowerCase();
                    if (pt.includes('ribbon') || pt === 'correction_tape') return 'ribbon';
                    if (pt === 'toner_cartridge') return 'toner';
                    if (pt === 'ink_cartridge' || pt === 'ink_bottle') return 'ink';
                    const n = (p.name || '').toLowerCase();
                    if (n.includes('ribbon') || n.includes('correction tape')) return 'ribbon';
                    return n.includes('toner') ? 'toner' : 'ink';
                };

                const buildSection = (products, type) => {
                    if (!products.length) return '';
                    const badge = !sourceKnown ? ''
                        : type === 'compatible'
                            ? '<span class="badge badge-compatible">COMPATIBLE</span>'
                            : '<span class="badge badge-genuine">GENUINE</span>';
                    const brandName = Security.escapeHtml((info.brandName || '').trim());

                    const ribbons = products.filter(p => inferProductType(p) === 'ribbon');
                    const inks    = products.filter(p => inferProductType(p) === 'ink');
                    const toners  = products.filter(p => inferProductType(p) === 'toner');

                    const buildTypeGrid = (items, productType) => {
                        if (!items.length) return '';
                        const label = productType === 'ribbon' ? 'Ribbons' :
                                     productType === 'toner' ? 'Toner Cartridges' : 'Ink Cartridges';
                        const heading = `${brandName} ${label}`.trim();

                        // Splice row-breaks between (familyKey, yieldTier)
                        // groups so each yield-code starts on its own row.
                        // Spec: readfirst/code-yield-grouping-may2026.md
                        const breaks = (typeof ProductSort !== 'undefined' && ProductSort.rowBreakIndices)
                            ? new Set(ProductSort.rowBreakIndices(items))
                            : new Set();
                        const ROW_BREAK = '<div class="products-row__break" aria-hidden="true"></div>';
                        const cardsHtml = items.map((p, i) => {
                            const card = Products.renderCard(p);
                            return breaks.has(i) ? ROW_BREAK + card : card;
                        }).join('');
                        const grids = `<div class="related-products__grid product-grid">${cardsHtml}</div>`;

                        return `
                            <div class="related-products__type-group">
                                <h3 class="related-products__group-heading">${[badge, heading].filter(Boolean).join(' ')}</h3>
                                ${grids}
                            </div>
                        `;
                    };

                    return `
                        <div class="related-products__group">
                            ${buildTypeGrid(ribbons, 'ribbon')}
                            ${buildTypeGrid(inks, 'ink')}
                            ${buildTypeGrid(toners, 'toner')}
                        </div>
                    `;
                };

                const productLabel = Security.escapeHtml(info.displayName || info.name || info.sku);
                const container = section.querySelector('.container');

                if (info.category === 'ribbon') {
                    // Ribbons: render into right column of two-column layout.
                    // `related` for ribbons is either the manually-curated
                    // related_product_skus (preserved in user-supplied order)
                    // or /api/shop output (server-sorted). Either way, render
                    // in source order — no client resort.
                    const brandName = Security.escapeHtml((info.brandName || '').trim());
                    const heading = `${brandName} Ribbons`.trim();
                    const sorted = related;
                    const rightCol = document.getElementById('ribbon-col-right');

                    let relatedHtml = '';
                    if (sorted.length === 0) {
                        relatedHtml = `<div class="related-products"><h2 class="ribbon-section__title">Products related to ${Security.escapeHtml(info.sku)}</h2></div>`;
                    } else {
                        const grids = `<div class="related-products__grid product-grid">${sorted.map(p => Products.renderCard(p)).join('')}</div>`;
                        relatedHtml = `
                            <div class="related-products">
                                <h2 class="ribbon-section__title">Products related to ${Security.escapeHtml(info.sku)}</h2>
                                <div class="related-products__group">
                                    <div class="related-products__type-group">
                                        <h3 class="related-products__group-heading">${heading}</h3>
                                        ${grids}
                                    </div>
                                </div>
                            </div>
                        `;
                    }

                    if (rightCol) {
                        rightCol.insertAdjacentHTML('beforeend', relatedHtml);
                        document.getElementById('ribbon-detail-columns').hidden = false;
                        // Bind events on the right column's grids
                        rightCol.querySelectorAll('.related-products__grid').forEach(grid => {
                            Products.bindImageFallbacks(grid);
                            Products.bindAddToCartEvents(grid);
                        });
                        return; // Skip the default section rendering
                    }
                } else {
                    container.innerHTML = `
                        <p class="related-products__title">Related Products</p>
                        ${buildSection(firstGroup, firstLabel)}
                        ${buildSection(secondGroup, secondLabel)}
                    `;
                }

                container.querySelectorAll('.related-products__grid').forEach(grid => {
                    Products.bindImageFallbacks(grid);
                    Products.bindAddToCartEvents(grid);
                });

                section.hidden = false;
            } catch (e) {
                // Related products are optional
            }
        },

        _extractProductCode(modelNumber) {
            if (!modelNumber) return null;
            // Strip trailing color codes (BK, CL, BL, MG, YL, C, M, Y, B) then extract alphanumeric code
            const stripped = modelNumber.replace(/(BK|CL|BL|MG|YL|[CMYB])$/i, '');
            const match = /^([A-Z0-9]+-?[A-Z0-9]*?\d+)/i.exec(stripped);
            return match ? match[1] : null;
        },

        setupEventListeners(info) {
            // Quantity controls
            const qtyInput = document.getElementById('qty-input');
            const maxQty = 99;
            qtyInput.max = maxQty;
            const qtyIncreaseBtn = document.getElementById('qty-increase');
            document.getElementById('qty-decrease').addEventListener('click', () => {
                if (qtyInput.value > 1) qtyInput.value = parseInt(qtyInput.value) - 1;
                qtyIncreaseBtn.disabled = false;
            });
            qtyIncreaseBtn.addEventListener('click', () => {
                const next = parseInt(qtyInput.value) + 1;
                if (next <= maxQty) {
                    qtyInput.value = next;
                    if (next >= maxQty) qtyIncreaseBtn.disabled = true;
                }
            });
            qtyInput.addEventListener('change', () => {
                let val = parseInt(qtyInput.value);
                if (isNaN(val) || val < 1) val = 1;
                if (val > maxQty) val = maxQty;
                qtyInput.value = val;
                qtyIncreaseBtn.disabled = val >= maxQty;
            });

            // Add to cart using Cart.addItem (server-first for authenticated users)
            let atcTotalQty = 0;
            const atcConfirmation = document.getElementById('atc-confirmation');
            const atcConfirmationText = document.getElementById('atc-confirmation-text');

            const addToCartBtn = document.getElementById('add-to-cart-btn');
            if (addToCartBtn) addToCartBtn.addEventListener('click', async () => {
                const btn = document.getElementById('add-to-cart-btn');
                const qty = parseInt(qtyInput.value) || 1;

                btn.disabled = true;
                btn.textContent = 'Adding...';

                try {
                    await Cart.addItem({
                        id: info.id,
                        name: info.name,
                        price: info.retail_price || 0,
                        sku: info.sku || '',
                        image: info.image_url || '',
                        brand: info.brandName || '',
                        quantity: qty,
                        product_source: info.source || null
                    });
                    btn.textContent = 'Added!';
                    setTimeout(() => {
                        btn.textContent = 'Add to Cart';
                        btn.disabled = false;
                    }, 1500);

                    // Update and show confirmation strip
                    atcTotalQty += qty;
                    if (atcConfirmationText) {
                        atcConfirmationText.textContent = atcTotalQty === 1
                            ? '1 item added to cart'
                            : `${atcTotalQty} items in cart`;
                    }
                    if (atcConfirmation) {
                        atcConfirmation.classList.add('atc-confirmation--visible');
                    }
                } catch (error) {
                    btn.textContent = 'Error';
                    setTimeout(() => {
                        btn.textContent = 'Add to Cart';
                        btn.disabled = false;
                    }, 1500);
                }
            });

            // Favourite button setup
            const favBtn = document.getElementById('favourite-btn');
            if (favBtn && typeof Favourites !== 'undefined') {
                // Set data attributes
                favBtn.dataset.productId = info.id;
                favBtn.dataset.productSku = info.sku || '';
                favBtn.dataset.productName = info.displayName || info.name;
                favBtn.dataset.productPrice = info.retail_price || 0;
                favBtn.dataset.productImage = info.image_url || '';
                favBtn.dataset.productBrand = info.brandName || '';
                favBtn.dataset.productColor = info.color || '';

                // Set initial state
                const isFav = Favourites.isFavourite(info.id);
                Favourites.updateButtonState(favBtn, isFav);
            }

        },

        // Generate SEO-friendly meta description
        generateMetaDescription(info) {
            const parts = [];

            // Product type — key the genuine/compatible word off the trusted
            // `source` field, NOT `isCompatible` (which is force-false for
            // ribbons, so a compatible ribbon would otherwise be described as
            // "Genuine …" — a false claim in indexed metadata). Universal /
            // unknown-source items get no genuine/compatible qualifier at all.
            if (info.source === 'genuine') {
                parts.push(`Genuine ${info.brandName}`);
            } else if (info.source === 'compatible') {
                parts.push(`Compatible ${info.brandName}`);
            } else {
                parts.push(info.brandName);
            }

            // Category
            const categoryNames = {
                'toner': 'toner cartridge',
                'ink': 'ink cartridge',
                'drum': 'drum unit',
                'ribbon': 'printer ribbon'
            };
            parts.push(categoryNames[info.category] || 'printing supply');

            // Color if available
            if (info.color) {
                parts.push(`- ${info.color}`);
            }

            // Page yield — only when it passes the plausibility guard, so the
            // meta description can't advertise an implausible "3 page yield".
            const metaYield = this.plausibleYield(info.pageYield);
            if (metaYield) {
                parts.push(`- ${metaYield.toLocaleString()} page yield`);
            }

            // Price
            const price = parseFloat(info.retail_price || 0);
            parts.push(`- $${price.toFixed(2)} NZD`);

            // Call to action — factual benefits only (Google Ads compliance,
            // May 2026): no "guarantee"/"hurry"/"risk-free" superlatives.
            parts.push('- Free NZ shipping over $100. Tracked NZ-wide delivery. 30-day returns under the Consumer Guarantees Act 1993.');

            return parts.join(' ');
        },

        // NOTE: `_googleProductType` and `updateProductSchema` were removed in
        // the May 2026 marketing audit (marketing-audit-may-2026.md §4). They
        // built and injected a client-side Product JSON-LD blob; the backend
        // prerender layer is now the single source of product structured data,
        // so a client-side copy only risked duplicate Product nodes. Recover
        // from git history if ever needed — but do not re-introduce
        // client-side Product / BreadcrumbList / FAQPage JSON-LD emission.


        // ── Reviews ──────────────────────────────────────────

        _renderStars(rating, size = 16) {
            const full = Math.round(rating);
            return Array.from({ length: 5 }, (_, i) =>
                `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${i < full ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`
            ).join('');
        },

        async loadReviews() {
            const info = this.product;
            if (!info || !info.id) return;

            const section = document.getElementById('product-reviews');
            if (!section) return;

            try {
                // Fetch reviews and summary in parallel
                const [reviewsResp, summaryResp] = await Promise.all([
                    API.getProductReviews(info.id),
                    API.getProductReviewSummary(info.id)
                ]);

                const reviews = (reviewsResp.ok && reviewsResp.data?.reviews) ? reviewsResp.data.reviews : [];
                const summary = (summaryResp.ok && summaryResp.data) ? summaryResp.data : null;

                // Render summary with distribution bars
                const summaryEl = document.getElementById('reviews-summary');
                if (summary && summary.count > 0) {
                    const dist = summary.distribution || {};
                    const maxCount = Math.max(dist['5'] || 0, dist['4'] || 0, dist['3'] || 0, dist['2'] || 0, dist['1'] || 0, 1);
                    const distBars = [5, 4, 3, 2, 1].map(star => {
                        const count = dist[String(star)] || 0;
                        const pct = Math.round((count / maxCount) * 100);
                        return `<div class="reviews-dist__row">
                            <span class="reviews-dist__label">${star}★</span>
                            <div class="reviews-dist__bar"><div class="reviews-dist__fill" style="width:${pct}%"></div></div>
                            <span class="reviews-dist__count">${count}</span>
                        </div>`;
                    }).join('');

                    summaryEl.innerHTML = `
                        <div class="reviews-summary__overview">
                            <div class="reviews-summary__stars">${this._renderStars(summary.average, 20)}</div>
                            <span class="reviews-summary__avg">${Number(summary.average).toFixed(1)}</span>
                            <span class="reviews-summary__count">based on ${summary.count} review${summary.count !== 1 ? 's' : ''}</span>
                        </div>
                        <div class="reviews-dist">${distBars}</div>
                    `;
                }

                // Render review list
                const listEl = document.getElementById('reviews-list');
                if (reviews.length > 0) {
                    listEl.innerHTML = reviews.map(r => {
                        const date = r.created_at ? new Date(r.created_at).toLocaleDateString('en-NZ', { year: 'numeric', month: 'short', day: 'numeric' }) : '';
                        const author = r.user_name || r.author_name || 'Customer';
                        return `
                            <div class="product-review-card">
                                <div class="product-review-card__stars">${this._renderStars(r.rating)}</div>
                                <h4 class="product-review-card__title">${Security.escapeHtml(r.title || '')}</h4>
                                <p class="product-review-card__body">${Security.escapeHtml(r.body || '')}</p>
                                <div class="product-review-card__meta">
                                    <span class="product-review-card__author">${Security.escapeHtml(author)}</span>
                                    ${date ? `<span class="product-review-card__date">${Security.escapeHtml(date)}</span>` : ''}
                                </div>
                            </div>
                        `;
                    }).join('');
                } else {
                    listEl.innerHTML = '<p class="product-reviews__empty">No reviews yet. Be the first to share your experience!</p>';
                }

                // Show section if there are reviews OR user is logged in (can write one)
                const isLoggedIn = typeof Auth !== 'undefined' && Auth.user;
                if (reviews.length > 0 || isLoggedIn) {
                    section.hidden = false;
                }

                // Show review form for logged-in users
                this.setupReviewForm(info);

                // Handle ?review=true query param
                const params = new URLSearchParams(window.location.search);
                if (params.get('review') === 'true') {
                    section.hidden = false;
                    // Small delay to ensure DOM is settled after render
                    requestAnimationFrame(() => {
                        const formWrap = document.getElementById('review-form-wrap');
                        if (formWrap && !formWrap.hidden) {
                            formWrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        } else {
                            section.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        }
                    });
                }
            } catch (e) {
                // Reviews are non-critical
            }
        },

        setupReviewForm(info) {
            const formWrap = document.getElementById('review-form-wrap');
            const form = document.getElementById('review-form');
            if (!formWrap || !form) return;

            const isLoggedIn = typeof Auth !== 'undefined' && Auth.user;
            if (!isLoggedIn) return;

            formWrap.hidden = false;
            let selectedRating = 0;

            // Star selection
            const starBtns = form.querySelectorAll('#review-stars button[data-rating]');
            const updateStarDisplay = (rating) => {
                starBtns.forEach(btn => {
                    const val = parseInt(btn.dataset.rating);
                    const svg = btn.querySelector('svg');
                    svg.setAttribute('fill', val <= rating ? 'currentColor' : 'none');
                });
            };

            starBtns.forEach(btn => {
                btn.addEventListener('click', () => {
                    selectedRating = parseInt(btn.dataset.rating);
                    updateStarDisplay(selectedRating);
                });
                btn.addEventListener('mouseenter', () => {
                    updateStarDisplay(parseInt(btn.dataset.rating));
                });
            });

            const starsWrap = document.getElementById('review-stars');
            starsWrap.addEventListener('mouseleave', () => {
                updateStarDisplay(selectedRating);
            });

            // Form submission
            form.addEventListener('submit', async (e) => {
                e.preventDefault();
                const statusEl = document.getElementById('review-form-status');
                const submitBtn = document.getElementById('review-submit-btn');

                if (selectedRating === 0) {
                    statusEl.textContent = 'Please select a rating.';
                    statusEl.className = 'review-form__status review-form__status--error';
                    return;
                }

                const title = form.querySelector('#review-title').value.trim();
                const body = form.querySelector('#review-body').value.trim();

                submitBtn.disabled = true;
                submitBtn.textContent = 'Submitting...';
                statusEl.textContent = '';

                try {
                    const resp = await API.createReview({
                        product_id: info.id,
                        rating: selectedRating,
                        title,
                        body
                    });

                    if (resp.ok) {
                        statusEl.textContent = 'Thank you! Your review has been submitted and will appear after approval.';
                        statusEl.className = 'review-form__status review-form__status--success';
                        form.reset();
                        selectedRating = 0;
                        updateStarDisplay(0);
                        submitBtn.textContent = 'Submitted';
                    } else {
                        const msg = resp.error?.message || resp.data?.message || 'Could not submit review. You may need to have purchased this product.';
                        statusEl.textContent = msg;
                        statusEl.className = 'review-form__status review-form__status--error';
                        submitBtn.disabled = false;
                        submitBtn.textContent = 'Submit Review';
                    }
                } catch (err) {
                    statusEl.textContent = 'Something went wrong. Please try again.';
                    statusEl.className = 'review-form__status review-form__status--error';
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Submit Review';
                }
            });
        },

        // ── FAQ Accordion ─────────────────────────────────────
        renderFaqAccordion() {
            const faqSection = document.getElementById('product-faq');
            if (!faqSection) return;
            const schema = this._faqSchema;
            if (!schema || !schema.mainEntity || !schema.mainEntity.length) return;

            const items = schema.mainEntity.map(q => `
                <details class="faq-accordion__item">
                    <summary class="faq-accordion__question">${Security.escapeHtml(q.name)}</summary>
                    <div class="faq-accordion__answer">${Security.escapeHtml(q.acceptedAnswer?.text || '')}</div>
                </details>
            `).join('');

            faqSection.innerHTML = `
                <div class="container">
                    <h2 class="faq-accordion__title">Frequently Asked Questions</h2>
                    <div class="faq-accordion">${items}</div>
                </div>
            `;
            faqSection.hidden = false;
        },

        // ── Bought Together ──────────────────────────────────
        async renderBoughtTogether(info) {
            if (!info || !info.sku) return;
            try {
                const resp = await API.getBoughtTogether(info.sku);
                if (!resp.ok || !resp.data || !resp.data.length) return;

                const section = document.getElementById('bought-together');
                if (!section) return;

                const grid = section.querySelector('.bought-together__grid');
                if (grid) {
                    grid.innerHTML = Products.renderCards(resp.data.slice(0, 4));
                    Products.attachCardListeners(grid);
                }
                section.hidden = false;
            } catch {
                // Non-critical
            }
        },

        async resolveSkuFromSlug(slug) {
            if (!slug) return null;
            const base = (typeof Config !== 'undefined' && Config.API_URL) ? Config.API_URL : '';

            // Primary: /api/products/by-slug/<slug>. Returns 302 → /api/products/<sku>,
            // which fetch follows by default. For healthy SKUs that's a single
            // round-trip. For the Epson Genuine 200 family the chained
            // /api/products/<sku> 500s, breaking the read of res.ok — that's
            // what the search-smart fallback below catches.
            try {
                const res = await fetch(`${base}/api/products/by-slug/${encodeURIComponent(slug)}`);
                if (res.ok) {
                    const json = await res.json();
                    if (json && json.ok && json.data && json.data.sku) return json.data.sku;
                }
            } catch (_) { /* fall through to search-smart */ }

            // Fallback: search-smart with the slug-as-query, then exact-match
            // on `slug` to avoid surfacing a near-neighbor. Same fallback shape
            // as API.getProduct uses when the singular endpoint 500s — keeps
            // the slug-only URL path working when /api/products/<sku> is broken.
            try {
                const q = String(slug).replace(/-/g, ' ').trim();
                const res2 = await fetch(`${base}/api/search/smart?q=${encodeURIComponent(q)}&limit=20`);
                if (res2.ok) {
                    const json = await res2.json();
                    const products = (json && json.ok && json.data && Array.isArray(json.data.products))
                        ? json.data.products : [];
                    const match = products.find(p => p && p.slug === slug);
                    if (match && match.sku) return match.sku;
                }
            } catch (_) { /* return null below */ }
            return null;
        },

        _isTestProduct(product) {
            const sku = (product.sku || '').toUpperCase();
            return sku.startsWith('TEST-') || product.admin_only === true;
        },


        showError(message) {
            // bfcache-restore-may2026.md: skip DOM mutation while the
            // page is unloading. Otherwise an in-flight /api/products
            // fetch that rejects mid-navigation would paint a sticky
            // "Product not found" state that bfcache then snapshots,
            // showing a phantom-broken product page when the user
            // presses Back. The pageshow/persisted handler refetches.
            if (this._unloading) return;
            // Defense-in-depth: even if a caller forgets to unwrap the
            // backend's `{ code, message }` error envelope, never paint
            // "[object Object]" — coerce via API.extractErrorMessage.
            const safeMessage = (typeof API !== 'undefined' && API.extractErrorMessage)
                ? API.extractErrorMessage(message, 'Product not found')
                : (typeof message === 'string' ? message : 'Product not found');
            // Update title
            document.getElementById('product-title').textContent = safeMessage;
            document.getElementById('product-sku').textContent = '';
            document.getElementById('product-price').textContent = '';

            // Hide unnecessary sections
            document.querySelector('.product-info__gst').hidden = true;
            document.getElementById('product-stock').hidden = true;
            document.querySelector('.product-info__actions').hidden = true;
            // Hide the Delivery + Returns rows of the buy-box on error — their
            // labels would otherwise float beside an empty price.
            const deliveryRow = document.getElementById('product-delivery');
            if (deliveryRow) deliveryRow.hidden = true;
            const returnsRow = document.getElementById('product-returns');
            if (returnsRow) returnsRow.hidden = true;
            // Show error state in image area with retry button
            const imageEl = document.getElementById('product-image');
            imageEl.innerHTML = `
                <div class="product-error">
                    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <circle cx="12" cy="12" r="10"/>
                        <line x1="12" y1="8" x2="12" y2="12"/>
                        <line x1="12" y1="16" x2="12.01" y2="16"/>
                    </svg>
                    <p>${Security.escapeHtml(safeMessage)}</p>
                    <button class="btn btn--secondary" data-action="reload">Try Again</button>
                    <a href="/shop" class="btn btn--outline">Browse All Products</a>
                </div>
            `;

            // Bind retry button handler
            imageEl.querySelector('[data-action="reload"]')?.addEventListener('click', () => {
                location.reload();
            });

            // Update breadcrumb
            document.getElementById('breadcrumb-product').textContent = 'Error';
        }
    };

    // ============================================
    // HOVER-TO-MAGNIFY (cursor-follow inner zoom)
    // ============================================
    // Scales the main product photo inside its existing box and pans the
    // enlarged image toward the cursor. The gallery box already sets
    // `overflow: hidden` (css/pages.css), so the zoomed image is clipped to
    // the frame — no layout change needed. Desktop hover only.
    const ZOOM_SCALE = 2.2;
    function initProductImageZoom(container) {
        if (!container) return;
        // No true hover on touch/coarse pointers — skip entirely.
        if (typeof window.matchMedia === 'function' &&
            !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

        const img = container.querySelector('img[data-fallback]');
        if (!img) return; // only real photos are zoomable, never fallbacks

        container.classList.add('product-gallery__main--zoomable');

        const swapToHighRes = () => {
            if (img.dataset.zoomed || !img.dataset.zoomSrc) return;
            img.dataset.zoomed = '1';
            const hi = new Image();
            hi.onload = () => {
                // Only swap once the crisp source is decoded, so there is no
                // flash of a broken/blank image mid-hover.
                img.removeAttribute('srcset');
                img.src = img.dataset.zoomSrc;
            };
            hi.src = img.dataset.zoomSrc;
        };

        container.addEventListener('mouseenter', swapToHighRes);
        container.addEventListener('mousemove', (e) => {
            // Bail if the image errored out to a fallback after init.
            if (!container.classList.contains('product-gallery__main--zoomable')) return;
            const rect = container.getBoundingClientRect();
            if (!rect.width || !rect.height) return;
            const x = ((e.clientX - rect.left) / rect.width) * 100;
            const y = ((e.clientY - rect.top) / rect.height) * 100;
            img.style.transformOrigin = `${x}% ${y}%`;
            img.style.transform = `scale(${ZOOM_SCALE})`;
        });
        container.addEventListener('mouseleave', () => {
            img.style.transform = '';
            img.style.transformOrigin = '';
        });
    }

    // Initialize when DOM is ready
    document.addEventListener('DOMContentLoaded', () => ProductPage.init());

    // BFCACHE / NAVIGATION-AWAY GUARDS (bfcache-restore-may2026.md)
    // Suppress error painting while unloading and re-init when the
    // browser restores us from the back/forward cache (DOMContentLoaded
    // does NOT fire on bfcache restore, so a half-loaded or errored
    // snapshot would otherwise stick on the next Back press).
    window.addEventListener('pagehide', () => { ProductPage._unloading = true; });
    window.addEventListener('pageshow', (e) => {
        ProductPage._unloading = false;
        if (!e.persisted) return;
        ProductPage.init();
    });

    // Sticky mobile Add-to-Cart bar
    document.addEventListener('DOMContentLoaded', () => {
        const actionsContainer = document.querySelector('.product-info__actions');
        const stickyBar = document.getElementById('sticky-atc');
        const stickyBtn = document.getElementById('sticky-atc-btn');
        const stickyPrice = document.getElementById('sticky-atc-price');
        if (!actionsContainer || !stickyBar) return;

        // Show/hide based on actions container visibility (not the button itself,
        // which may be replaced via outerHTML for contact-us products)
        const observer = new IntersectionObserver(([entry]) => {
            if (entry.isIntersecting) {
                stickyBar.classList.remove('is-visible');
                stickyBar.setAttribute('aria-hidden', 'true');
            } else {
                stickyBar.classList.add('is-visible');
                stickyBar.setAttribute('aria-hidden', 'false');
            }
        }, { threshold: 0 });
        observer.observe(actionsContainer);

        // Mirror price from product info
        const priceEl = document.getElementById('product-price');
        if (priceEl && stickyPrice) {
            new MutationObserver(() => {
                stickyPrice.textContent = priceEl.textContent;
            }).observe(priceEl, { childList: true, characterData: true, subtree: true });
            stickyPrice.textContent = priceEl.textContent;
        }

        // Trigger same click as main Add to Cart (re-query to avoid stale reference)
        if (stickyBtn) {
            stickyBtn.addEventListener('click', () => {
                const currentBtn = document.getElementById('add-to-cart-btn');
                if (currentBtn) currentBtn.click();
            });
        }
    });
