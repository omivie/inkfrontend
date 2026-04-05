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

        formatPageYield(value) {
            if (value == null) return null;
            return String(value).replace(/\s*pages\b/gi, '').trim();
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
                    this.showError('Product not found');
                    return;
                }

                this.product = response.data;

                // Enrich ribbon products from Supabase (description, compatibility, related products)
                const isRibbon = this._productType === 'ribbon' || this.normalizeProductType(this.product.product_type) === 'ribbon';
                if (isRibbon) {
                    try {
                        const enrichUrl = `${Config.SUPABASE_URL}/rest/v1/products?sku=eq.${encodeURIComponent(sku)}&select=description_html,compatible_devices_html,related_product_skus&limit=1`;
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
                                if (this.product.description_html == null) this.product.description_html = extra.description_html;
                                if (this.product.compatible_devices_html == null) this.product.compatible_devices_html = extra.compatible_devices_html;
                                if (this.product.related_product_skus == null) this.product.related_product_skus = extra.related_product_skus;
                            }
                        }
                    } catch (_) { /* non-critical enrichment */ }
                }

                // Gate test products — active test products are visible to all; inactive only to super admins
                if (this._isTestProduct(this.product) && !this.product.active && typeof isCachedSuperAdmin === 'function' && !isCachedSuperAdmin()) {
                    this.showError('Product not found');
                    return;
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
            const nameLower = name.toLowerCase();
            const isCompatible = !isRibbonProduct && (p.source === 'compatible' || nameLower.includes('compatible'));
            const displayName = (!isRibbonProduct && nameLower.startsWith('compatible ')) ? name.substring(11).trim() : name;
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
                image_url: typeof storageUrl === 'function' ? storageUrl(p.image_url) : (p.image_url || '')
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
            const lower = raw.toLowerCase();
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
         * Extract the primary product code (e.g., "LC37") from product name/MPN
         */
        extractProductCode(info) {
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

            // Try manufacturer_part_number first, then product name (without brand prefix)
            const nameWithoutPrefix = (info.name || '').replace(/^(Compatible\s+)?/i, '').replace(new RegExp('^' + info.brandName + '\\s+', 'i'), '');
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

            // Build canonical slug URL (fallback when seo.canonical not provided)
            const slug = info.slug || info.sku.toLowerCase();
            const canonicalUrl = seo.canonical || `https://www.inkcartridges.co.nz/products/${slug}/${info.sku}`;

            // Page title and meta description — prefer API seo fields, fall back to computed
            const prefix = (info.category === 'ribbon') ? '' : (info.isCompatible ? 'Compatible ' : 'Genuine ');
            const computedTitle = `${prefix}${info.displayName} NZ | InkCartridges.co.nz`;
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

            // Schema.org Product structured data — prefer API-provided JSON-LD
            if (seo.jsonLd && typeof seo.jsonLd === 'object' && seo.jsonLd.product_schema) {
                // API returns separate schema objects — embed each as its own script tag
                const schemaEl = document.getElementById('product-schema');
                if (schemaEl) {
                    schemaEl.textContent = JSON.stringify(seo.jsonLd.product_schema);
                }
                // Embed additional schemas (faq, organization, local_business, website)
                const extraSchemas = ['faq_schema', 'organization_schema', 'local_business_schema', 'website_schema'];
                extraSchemas.forEach(key => {
                    if (seo.jsonLd[key]) {
                        const script = document.createElement('script');
                        script.type = 'application/ld+json';
                        script.textContent = JSON.stringify(seo.jsonLd[key]);
                        document.head.appendChild(script);
                    }
                });
                // Store FAQ data for visible accordion rendering
                if (seo.jsonLd.faq_schema) {
                    this._faqSchema = seo.jsonLd.faq_schema;
                }
            } else if (seo.jsonLd) {
                // Legacy format — single JSON-LD blob
                const schemaEl = document.getElementById('product-schema');
                if (schemaEl) {
                    schemaEl.textContent = typeof seo.jsonLd === 'string' ? seo.jsonLd : JSON.stringify(seo.jsonLd);
                }
            } else {
                this.updateProductSchema(info, price);
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
            if (isRibbon) {
                document.getElementById('breadcrumb-category').innerHTML = `<a href="/html/ribbons.html">${Security.escapeHtml(categoryName)}</a>`;
                document.getElementById('breadcrumb-brand').innerHTML = `<a href="/html/ribbons?printer_brand=${Security.escapeAttr(info.brandName.toLowerCase())}">${Security.escapeHtml(info.brandName)}</a>`;
            } else {
                document.getElementById('breadcrumb-category').innerHTML = `<a href="/html/shop?brand=${Security.escapeAttr(brandSlug)}&category=${Security.escapeAttr(info.category)}">${Security.escapeHtml(categoryName)}</a>`;
                document.getElementById('breadcrumb-brand').innerHTML = `<a href="/html/shop?brand=${Security.escapeAttr(brandSlug)}">${Security.escapeHtml(info.brandName)}</a>`;
            }

            // Add product code breadcrumb (e.g., LC37) — skip for ribbons
            if (!isRibbon) {
                const productCode = this.extractProductCode(info);
                const breadcrumbCode = document.getElementById('breadcrumb-code');
                if (productCode && breadcrumbCode) {
                    breadcrumbCode.innerHTML = `<a href="/html/shop?brand=${Security.escapeAttr(brandSlug)}&category=${Security.escapeAttr(info.category)}&code=${Security.escapeAttr(productCode)}">${Security.escapeHtml(productCode)}</a>`;
                    breadcrumbCode.hidden = false;
                }
            }

            document.getElementById('breadcrumb-product').textContent = info.displayName;

            // BreadcrumbList JSON-LD — prefer seo.breadcrumbJsonLd if provided
            const breadcrumbSchemaEl = document.getElementById('breadcrumb-schema');
            if (breadcrumbSchemaEl) {
                if (seo.breadcrumbJsonLd) {
                    breadcrumbSchemaEl.textContent = typeof seo.breadcrumbJsonLd === 'string'
                        ? seo.breadcrumbJsonLd
                        : JSON.stringify(seo.breadcrumbJsonLd);
                } else {
                    const breadcrumbSchema = {
                        "@context": "https://schema.org",
                        "@type": "BreadcrumbList",
                        "itemListElement": [
                            { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://www.inkcartridges.co.nz" },
                            { "@type": "ListItem", "position": 2, "name": `${info.brandName} Ink Cartridges`, "item": `https://www.inkcartridges.co.nz/brands/${brandSlug}` },
                            { "@type": "ListItem", "position": 3, "name": info.displayName }
                        ]
                    };
                    breadcrumbSchemaEl.textContent = JSON.stringify(breadcrumbSchema);
                }
            }

            // Product badge — hidden; genuine/compatible is already in the title
            const badge = document.getElementById('product-badge');
            badge.hidden = true;
            if (info.isCompatible) {
                document.querySelector('.product-detail__layout').classList.add('product-detail__layout--compatible');
            }

            // Title and SKU
            const h1Prefix = info.isCompatible ? 'Compatible ' : '';
            document.getElementById('product-title').textContent = `${h1Prefix}${info.displayName}`;
            document.getElementById('product-sku').textContent = `SKU: ${info.sku}${info.manufacturer_part_number ? ' | Model: ' + info.manufacturer_part_number : ''}`;

            // Price - use formatPrice() for consistent locale-aware currency display
            const priceEl = document.getElementById('product-price');
            priceEl.textContent = formatPrice(price);

            // Compare price & savings
            const comparePrice = parseFloat(info.compare_price || 0);
            if (comparePrice && comparePrice > price) {
                const savingsAmount = comparePrice - price;
                const savingsPct = Math.round((savingsAmount / comparePrice) * 100);
                priceEl.insertAdjacentHTML('afterend',
                    `<span class="product-detail__compare-price">Was ${formatPrice(comparePrice)}</span>
                     <span class="product-detail__savings">Save ${formatPrice(savingsAmount)} (${savingsPct}%)</span>`);
            }

            // Stock status — dynamic based on API fields
            const stockStatus = getStockStatus(info);
            const stockEl = document.getElementById('product-stock');
            const stockIcons = {
                'in-stock': '<polyline points="20 6 9 17 4 12"/>',
                'out-of-stock': '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>'
            };
            stockEl.innerHTML = `<span class="stock-status stock-status--${stockStatus.class}">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">${stockIcons[stockStatus.class] || stockIcons['in-stock']}</svg>
                ${Security.escapeHtml(stockStatus.text)}
            </span>`;

            // Disable Add to Cart if out of stock
            if (stockStatus.class === 'out-of-stock') {
                const addBtn = document.getElementById('add-to-cart-btn');
                if (addBtn) { addBtn.disabled = true; addBtn.textContent = 'Out of Stock'; }
                const qtyInput = document.getElementById('product-quantity');
                if (qtyInput) qtyInput.disabled = true;
            }

            // Product image with color fallback
            const productImageEl = document.getElementById('product-image');
            const colorStyle = ProductColors.getProductStyle(info);
            if (info.image_url) {
                if (colorStyle) {
                    // Image with color fallback on error
                    productImageEl.innerHTML = `
                        <img src="${Security.escapeAttr(Security.sanitizeUrl(info.image_url))}" alt="${Security.escapeAttr(info.displayName)}" style="max-width: 100%; height: auto;"
                             data-fallback="color-block">
                        <div class="product-gallery__color-block" style="${colorStyle}; display: none;"></div>`;
                } else {
                    // Image with placeholder fallback
                    productImageEl.innerHTML = `<img src="${Security.escapeAttr(Security.sanitizeUrl(info.image_url))}" alt="${Security.escapeAttr(info.displayName)}" style="max-width: 100%; height: auto;"
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
                    }, { once: true });
                });
            } else {
                // No image - show color block or placeholder
                if (colorStyle) {
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
            if (info.category !== 'ribbon' || !info.description_html) return;
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

        async renderCompatiblePrinters(info) {
            // If ribbon product has admin-provided compatible devices HTML, render into left column
            if (info.compatible_devices_html && info.category === 'ribbon') {
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
                        ? `/html/ribbons?printer_model=${encodeURIComponent(p.name)}`
                        : `/printers/${encodeURIComponent(slug)}`;
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
                    return `<li><a href="/printers/${encodeURIComponent(slug)}">${Security.escapeHtml(p.name)}</a></li>`;
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
                    const label = d.full_name
                        ? Security.escapeHtml(d.full_name)
                        : (() => {
                            const brand = Security.escapeHtml(d.brand || d.device_brand || '');
                            const model = Security.escapeHtml(modelKey);
                            return brand && model ? `${brand} ${model}` : (brand || model);
                        })();
                    if (!label || !modelKey) return null;
                    return `<a href="/html/ribbons?printer_model=${encodeURIComponent(modelKey)}" class="printer-link">${label}</a>`;
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

        _sortByColor(products) {
            const packOrder = { single: 0, value_pack: 1, multipack: 2 };
            const colorOrder = { black: 0, 'photo black': 1, cyan: 2, 'light cyan': 3, magenta: 4, 'light magenta': 5, yellow: 6, cmy: 7, kcmy: 8, cmyk: 9 };
            const sizeOrder = (name) => {
                const n = (name || '').toLowerCase();
                if (n.includes('xxl') || n.includes('super high')) return 2;
                if (n.includes('xl') || n.includes('high yield') || /\bhy\b/.test(n)) return 1;
                return 0;
            };
            return [...products].sort((a, b) => {
                const pa = packOrder[a.pack_type] ?? 0;
                const pb = packOrder[b.pack_type] ?? 0;
                if (pa !== pb) return pa - pb;
                const sa = sizeOrder(a.name);
                const sb = sizeOrder(b.name);
                if (sa !== sb) return sa - sb;
                const ca = colorOrder[(a.color || '').toLowerCase()] ?? 99;
                const cb = colorOrder[(b.color || '').toLowerCase()] ?? 99;
                return ca - cb;
            });
        },

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

                // For ribbons: only show manually curated related products
                if (info.category === 'ribbon') {
                    const manualSkus = info.related_product_skus;
                    if (Array.isArray(manualSkus) && manualSkus.length > 0) {
                        const sb = (typeof Auth !== 'undefined' && Auth.supabase) ? Auth.supabase : null;
                        if (sb) {
                            const { data: manualProducts } = await sb.from('products')
                                .select('*')
                                .in('sku', manualSkus)
                                .eq('is_active', true);
                            if (manualProducts?.length) {
                                const bysku = {};
                                manualProducts.forEach(p => { bysku[p.sku] = p; });
                                const ordered = manualSkus.map(s => bysku[s]).filter(Boolean);
                                addProducts(ordered);
                            }
                        }
                    }
                } else {
                    // Non-ribbon: use automatic discovery
                    // Primary: use related products endpoint
                    const relatedResponse = await API.getRelatedProducts(info.sku);
                    if (relatedResponse.ok && relatedResponse.data?.related?.length > 0) {
                        addProducts(relatedResponse.data.related);
                    }

                    // Supplement: also search by compatible printer to catch products the related endpoint missed
                    const printers = await this._fetchPrinters(info.sku);
                    if (printers.length > 0) {
                        const firstPrinter = printers[0].name;
                        const response = await API.searchByPrinter(firstPrinter, { limit: 50 });
                        if (response.ok && response.data?.products) {
                            addProducts(response.data.products);
                        }
                    }

                    // Fallback: search by product code if still empty
                    if (related.length === 0) {
                        const productCode = this._extractProductCode(info.manufacturer_part_number);
                        if (productCode) {
                            const brandName = info.brandName || '';
                            const params = { search: productCode, limit: 50 };
                            if (brandName) params.brand = brandName;
                            const response = await API.getProducts(params);
                            if (response.ok && response.data?.products) {
                                addProducts(response.data.products);
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

                // Infer source from available fields
                const inferSource = (p) => {
                    if (p.source) return p.source;
                    const name = (p.name || '').toLowerCase();
                    const slug = (p.slug || '').toLowerCase();
                    const sku = (p.sku || '').toLowerCase();
                    if (name.startsWith('compatible') || slug.startsWith('compatible-') || sku.startsWith('comp-')) return 'compatible';
                    if (name.startsWith('genuine') || slug.startsWith('genuine-') || sku.startsWith('g-') || sku.startsWith('gen-')) return 'genuine';
                    // Default: assume same source as the current product
                    return info.source || 'genuine';
                };

                const isCompatible = info.source === 'compatible';
                const compatibles = this._sortByColor(related.filter(p => inferSource(p) === 'compatible'));
                const genuines    = this._sortByColor(related.filter(p => inferSource(p) !== 'compatible'));

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
                    const badge = type === 'compatible'
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

                        // Group items by size/pack variant for separate rows
                        const sizeOf = (p) => {
                            const n = (p.name || '').toLowerCase();
                            if (n.includes('xxl') || n.includes('super high')) return 2;
                            if (n.includes('xl') || n.includes('high yield') || /\bhy\b/.test(n)) return 1;
                            return 0;
                        };
                        const groupKey = (p) => {
                            const pt = p.pack_type || 'single';
                            if (pt === 'value_pack') return 'value_pack';
                            if (pt === 'multipack') return 'multipack';
                            return 'single_' + sizeOf(p);
                        };
                        const groups = {};
                        items.forEach(p => {
                            const k = groupKey(p);
                            (groups[k] = groups[k] || []).push(p);
                        });
                        const groupOrder = ['single_0', 'single_1', 'single_2', 'value_pack', 'multipack'];
                        const grids = groupOrder
                            .filter(k => groups[k]?.length)
                            .map(k => `<div class="related-products__grid product-grid">${groups[k].map(p => Products.renderCard(p)).join('')}</div>`)
                            .join('');

                        return `
                            <div class="related-products__type-group">
                                <h3 class="related-products__group-heading">${badge} ${heading}</h3>
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
                    // Ribbons: render into right column of two-column layout
                    const brandName = Security.escapeHtml((info.brandName || '').trim());
                    const heading = `${brandName} Ribbons`.trim();
                    const sorted = this._sortByColor(related);
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

            document.getElementById('add-to-cart-btn').addEventListener('click', async () => {
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
                        quantity: qty
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

            // Product type
            if (info.isCompatible) {
                parts.push(`Compatible ${info.brandName}`);
            } else {
                parts.push(`Genuine ${info.brandName}`);
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

            // Page yield if available
            if (info.pageYield) {
                parts.push(`- ${info.pageYield.toLocaleString()} page yield`);
            }

            // Price
            const price = parseFloat(info.retail_price || 0);
            parts.push(`- $${price.toFixed(2)} NZD`);

            // Call to action
            parts.push('- Free NZ shipping over $100. Fast delivery. Quality guaranteed.');

            return parts.join(' ');
        },

        // Google product type taxonomy mapping
        _googleProductType(productType) {
            const map = {
                'ink_cartridge': 'Office Supplies > Ink & Toner > Ink Cartridges',
                'ink_bottle': 'Office Supplies > Ink & Toner > Ink Cartridges',
                'toner_cartridge': 'Office Supplies > Ink & Toner > Toner Cartridges',
                'drum_unit': 'Office Supplies > Ink & Toner > Drums & Imaging Units',
                'printer_ribbon': 'Office Supplies > Ink & Toner > Printer Ribbons',
                'typewriter_ribbon': 'Office Supplies > Ink & Toner > Printer Ribbons',
                'correction_tape': 'Office Supplies > Ink & Toner > Printer Ribbons',
                'label_tape': 'Office Supplies > Labels & Tapes > Label Tapes',
                'fax_film': 'Office Supplies > Ink & Toner > Fax Supplies',
                'fax_film_refill': 'Office Supplies > Ink & Toner > Fax Supplies',
                'photo_paper': 'Office Supplies > Paper > Photo Paper',
            };
            return map[productType] || 'Office Supplies > Ink & Toner > Ink Cartridges';
        },

        // Update Schema.org Product structured data
        updateProductSchema(info, price) {
            const slug = info.slug || info.sku.toLowerCase();
            const canonicalUrl = `https://www.inkcartridges.co.nz/products/${slug}/${info.sku}`;
            const freeShipping = price >= 100;
            const schema = {
                "@context": "https://schema.org",
                "@type": "Product",
                "name": info.displayName,
                "description": this.generateMetaDescription(info),
                "sku": info.sku,
                "mpn": info.manufacturer_part_number || info.sku,
                "brand": {
                    "@type": "Brand",
                    "name": info.brandName
                },
                "category": this._googleProductType(info.product_type),
                "offers": {
                    "@type": "Offer",
                    "url": canonicalUrl,
                    "priceCurrency": "NZD",
                    "price": price.toFixed(2),
                    "itemCondition": "https://schema.org/NewCondition",
                    "availability": "https://schema.org/InStock",
                    "seller": {
                        "@type": "Organization",
                        "name": "InkCartridges.co.nz"
                    },
                    "shippingDetails": {
                        "@type": "OfferShippingDetails",
                        "shippingDestination": {
                            "@type": "DefinedRegion",
                            "addressCountry": "NZ"
                        },
                        "shippingRate": {
                            "@type": "MonetaryAmount",
                            "value": freeShipping ? "0" : "7",
                            "currency": "NZD"
                        },
                        "deliveryTime": {
                            "@type": "ShippingDeliveryTime",
                            "transitTime": {
                                "@type": "QuantitativeValue",
                                "minValue": 1,
                                "maxValue": 4,
                                "unitCode": "DAY"
                            }
                        }
                    },
                    "hasMerchantReturnPolicy": {
                        "@type": "MerchantReturnPolicy",
                        "applicableCountry": "NZ",
                        "returnPolicyCategory": "https://schema.org/MerchantReturnFiniteReturnWindow",
                        "merchantReturnDays": 30,
                        "returnMethod": "https://schema.org/ReturnByMail"
                    }
                }
            };

            // Add GTIN-13 (barcode) if available
            if (info.barcode) {
                schema.gtin13 = info.barcode;
            }

            // Add image if available
            if (info.image_url) {
                schema.image = info.image_url;
            }

            // Add color if available
            if (info.color) {
                schema.color = info.color;
            }

            // Add compatible printers (isCompatibleWith)
            if (info.compatible_printers && info.compatible_printers.length > 0) {
                schema.isCompatibleWith = info.compatible_printers.map(p => ({
                    "@type": "Product",
                    "name": p.full_name || p.name || p.model_name
                }));
            }

            // Add page yield as additional property
            const yield_ = info.pageYield || info.page_yield;
            if (yield_) {
                schema.additionalProperty = [{
                    "@type": "PropertyValue",
                    "name": "Page Yield",
                    "value": String(yield_)
                }];
            }

            // Add aggregateRating if product has reviews
            if (info.review_count > 0) {
                schema.aggregateRating = {
                    "@type": "AggregateRating",
                    "ratingValue": String(info.average_rating),
                    "reviewCount": String(info.review_count),
                    "bestRating": "5",
                    "worstRating": "1"
                };
            }

            // Update the script tag
            const schemaEl = document.getElementById('product-schema');
            if (schemaEl) {
                schemaEl.textContent = JSON.stringify(schema, null, 2);
            }
        },


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

        _isTestProduct(product) {
            const sku = (product.sku || '').toUpperCase();
            return sku.startsWith('TEST-') || product.admin_only === true;
        },


        showError(message) {
            // Update title
            document.getElementById('product-title').textContent = message;
            document.getElementById('product-sku').textContent = '';
            document.getElementById('product-price').textContent = '';

            // Hide unnecessary sections
            document.querySelector('.product-info__gst').hidden = true;
            document.getElementById('product-stock').hidden = true;
            document.querySelector('.product-info__actions').hidden = true;
            // Show error state in image area with retry button
            const imageEl = document.getElementById('product-image');
            imageEl.innerHTML = `
                <div class="product-error">
                    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <circle cx="12" cy="12" r="10"/>
                        <line x1="12" y1="8" x2="12" y2="12"/>
                        <line x1="12" y1="16" x2="12.01" y2="16"/>
                    </svg>
                    <p>${Security.escapeHtml(message)}</p>
                    <button class="btn btn--secondary" data-action="reload">Try Again</button>
                    <a href="/html/shop.html" class="btn btn--outline">Browse All Products</a>
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

    // Initialize when DOM is ready
    document.addEventListener('DOMContentLoaded', () => ProductPage.init());

    // Sticky mobile Add-to-Cart bar
    document.addEventListener('DOMContentLoaded', () => {
        const mainBtn = document.getElementById('add-to-cart-btn');
        const stickyBar = document.getElementById('sticky-atc');
        const stickyBtn = document.getElementById('sticky-atc-btn');
        const stickyPrice = document.getElementById('sticky-atc-price');
        if (!mainBtn || !stickyBar) return;

        // Show/hide based on main button visibility
        const observer = new IntersectionObserver(([entry]) => {
            if (entry.isIntersecting) {
                stickyBar.classList.remove('is-visible');
                stickyBar.setAttribute('aria-hidden', 'true');
            } else {
                stickyBar.classList.add('is-visible');
                stickyBar.setAttribute('aria-hidden', 'false');
            }
        }, { threshold: 0 });
        observer.observe(mainBtn);

        // Mirror price from product info
        const priceEl = document.getElementById('product-price');
        if (priceEl && stickyPrice) {
            new MutationObserver(() => {
                stickyPrice.textContent = priceEl.textContent;
            }).observe(priceEl, { childList: true, characterData: true, subtree: true });
            stickyPrice.textContent = priceEl.textContent;
        }

        // Trigger same click as main Add to Cart
        if (stickyBtn) {
            stickyBtn.addEventListener('click', () => mainBtn.click());
        }
    });
