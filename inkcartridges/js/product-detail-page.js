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

        // Product type templates for descriptions
        templates: {
            toner: {
                description: (p) => `
                    <div class="product-details-section">
                        <p class="product-details-meta">
                            <strong>Model:</strong> ${Security.escapeHtml(p.manufacturer_part_number || p.sku)}
                            <span style="margin-left: 1.5rem;"><strong>SKU:</strong> ${Security.escapeHtml(p.sku)}</span>
                        </p>
                        <p class="product-details-intro">
                            ${p.isCompatible
                                ? `Premium quality compatible toner for your ${Security.escapeHtml(p.brandName)} printer. Our compatible toner cartridges deliver professional-quality documents with impressive reliability and page yields at a fraction of the cost of genuine cartridges.`
                                : `Count on professional-quality documents with dependable performance. Original ${Security.escapeHtml(p.brandName)} toner cartridges provide impressive reliability for dependable performance and page yields, and durable results.`
                            }
                        </p>
                    </div>

                    <h3 class="product-details-heading">Features & Benefits</h3>
                    <ul class="product-features-list">
                        ${p.pageYield ? `<li><strong>Page Yield:</strong> ${p.pageYield.toLocaleString()} pages</li>` : ''}
                        <li>Page yield based on 5% coverage of an A4 page</li>
                        ${p.color ? `<li><strong>Colour:</strong> ${Security.escapeHtml(p.color)} toner</li>` : ''}
                        <li>${p.isCompatible ? 'Compatible with' : 'Designed for'} ${Security.escapeHtml(p.brandName)} laser printers</li>
                        <li>Easy installation - simply remove and replace</li>
                        <li>${p.isCompatible ? 'ISO 9001 certified manufacturing' : '12 months manufacturer warranty'}</li>
                        ${p.isCompatible ? '<li>Tested to meet or exceed OEM specifications</li>' : '<li>Genuine OEM product for optimal reliability</li>'}
                    </ul>

                    <h3 class="product-details-heading">What's Included</h3>
                    <ul class="product-features-list">
                        <li>1 x ${Security.escapeHtml(p.displayName)}</li>
                        <li>Installation guide</li>
                    </ul>
                `,
                features: (p) => [
                    p.pageYield ? `Page yield: ~${p.pageYield.toLocaleString()} pages (5% coverage)` : 'High-quality output',
                    `${p.isCompatible ? 'Compatible' : 'Genuine OEM'} ${Security.escapeHtml(p.brandName)} toner`,
                    'Sharp, professional text and graphics',
                    'Easy snap-in installation',
                    p.color ? `Colour: ${Security.escapeHtml(p.color)}` : null,
                    p.isCompatible ? 'ISO 9001 certified quality' : '12 month warranty'
                ].filter(Boolean),
                faqs: (p) => [
                    {
                        q: 'How do I install this toner cartridge?',
                        a: `<p>Installing your ${Security.escapeHtml(p.brandName)} toner is straightforward:</p>
                            <ol>
                                <li>Turn off and unplug your printer</li>
                                <li>Open the front or top cover to access the toner compartment</li>
                                <li>Remove the old toner cartridge</li>
                                <li>Unpack the new toner and gently shake it side-to-side to distribute the toner evenly</li>
                                <li>Remove any protective covers or sealing tape</li>
                                <li>Insert the new cartridge until it clicks into place</li>
                                <li>Close the cover and turn on your printer</li>
                            </ol>`
                    },
                    {
                        q: 'How should I store unused toner cartridges?',
                        a: `<p>Store unopened toner cartridges in their original packaging in a cool, dry place away from direct sunlight. Avoid extreme temperatures and humidity. Properly stored toner cartridges typically have a shelf life of 2-3 years.</p>`
                    },
                    {
                        q: p.isCompatible ? 'Are compatible toners safe for my printer?' : 'Why is genuine toner more expensive?',
                        a: p.isCompatible
                            ? `<p>Yes, our compatible toner cartridges are designed and tested to work safely with your printer. Under New Zealand consumer law, using compatible consumables does not void your printer warranty. Our cartridges meet strict quality standards and come with our satisfaction guarantee.</p>`
                            : `<p>Genuine ${Security.escapeHtml(p.brandName)} toner cartridges are manufactured to exact specifications using premium materials and undergo rigorous quality testing. They're optimised for your specific printer model to deliver the best possible print quality and reliability while protecting your printer's longevity.</p>`
                    }
                ]
            },
            ink: {
                description: (p) => `
                    <div class="product-details-section">
                        <p class="product-details-meta">
                            <strong>Model:</strong> ${Security.escapeHtml(p.manufacturer_part_number || p.sku)}
                            <span style="margin-left: 1.5rem;"><strong>SKU:</strong> ${Security.escapeHtml(p.sku)}</span>
                        </p>
                        <p class="product-details-intro">
                            ${p.isCompatible
                                ? `Premium quality compatible ink for your ${Security.escapeHtml(p.brandName)} printer. Our compatible ink cartridges deliver vibrant colours and crisp text with reliable performance at a fraction of the cost of genuine cartridges.`
                                : `Count on professional-quality vibrant colour documents. Original ${Security.escapeHtml(p.brandName)} ink cartridges provide impressive reliability for dependable performance and page yields, and durable results. Print with individual inks and high-yield cartridge options.`
                            }
                        </p>
                    </div>

                    <h3 class="product-details-heading">Features & Benefits</h3>
                    <ul class="product-features-list">
                        ${p.pageYield ? `<li><strong>Page Yield:</strong> ${p.pageYield.toLocaleString()} pages</li>` : ''}
                        <li>Page yield based on 5% coverage of an A4 page</li>
                        ${p.color ? `<li><strong>Colour:</strong> ${Security.escapeHtml(p.color)} ink cartridge</li>` : ''}
                        <li>${p.isCompatible ? 'Compatible with' : 'Designed for'} ${Security.escapeHtml(p.brandName)} inkjet printers</li>
                        <li>Vibrant colours and sharp black text</li>
                        <li>Easy snap-in installation</li>
                        ${p.isCompatible ? '<li>Premium ink formulation tested for quality</li>' : '<li>12 months manufacturer warranty</li>'}
                        ${!p.isCompatible ? '<li>Smudge-resistant and water-resistant prints</li>' : '<li>Excellent value alternative to genuine</li>'}
                    </ul>

                    <h3 class="product-details-heading">What's Included</h3>
                    <ul class="product-features-list">
                        <li>1 x ${Security.escapeHtml(p.displayName)}</li>
                        <li>Installation guide</li>
                    </ul>
                `,
                features: (p) => [
                    p.pageYield ? `Page yield: ~${p.pageYield.toLocaleString()} pages (5% coverage)` : 'Reliable print quality',
                    `${p.isCompatible ? 'Compatible' : 'Genuine OEM'} ${Security.escapeHtml(p.brandName)} ink`,
                    'Vibrant colours and sharp text',
                    'Easy snap-in installation',
                    p.color ? `Colour: ${Security.escapeHtml(p.color)}` : null,
                    p.isCompatible ? 'Premium ink quality' : '12 month warranty'
                ].filter(Boolean),
                faqs: (p) => [
                    {
                        q: 'How do I install this ink cartridge?',
                        a: `<p>Installing your ink cartridge is simple:</p>
                            <ol>
                                <li>Turn on your printer and open the ink cartridge access door</li>
                                <li>Wait for the carriage to move to the centre</li>
                                <li>Press down on the old cartridge and remove it</li>
                                <li>Remove the new cartridge from packaging and pull off any protective tape</li>
                                <li>Insert the new cartridge into the correct slot until it clicks</li>
                                <li>Close the access door and print an alignment page if prompted</li>
                            </ol>`
                    },
                    {
                        q: 'How long do ink cartridges last?',
                        a: `<p>Unopened ink cartridges typically have a shelf life of 1-2 years when stored properly. Once installed, we recommend using the cartridge within 6 months for best results. Print regularly (at least once a week) to prevent the print heads from drying out.</p>`
                    },
                    {
                        q: p.isCompatible ? 'Will compatible ink void my warranty?' : 'Can I use compatible cartridges in my printer?',
                        a: p.isCompatible
                            ? `<p>Under New Zealand consumer law, using compatible (third-party) cartridges does not automatically void your printer warranty. However, if a compatible cartridge directly causes damage, that specific damage may not be covered. Our compatible cartridges are designed to work safely with your printer.</p>`
                            : `<p>While you can use compatible cartridges, genuine ${Security.escapeHtml(p.brandName)} ink is designed specifically for your printer model. Genuine supplies ensure optimal print quality, reliability, and are backed by ${Security.escapeHtml(p.brandName)}'s quality guarantee.</p>`
                    }
                ]
            },
            drum: {
                description: (p) => `
                    <div class="product-details-section">
                        <p class="product-details-meta">
                            <strong>Model:</strong> ${Security.escapeHtml(p.manufacturer_part_number || p.sku)}
                            <span style="margin-left: 1.5rem;"><strong>SKU:</strong> ${Security.escapeHtml(p.sku)}</span>
                        </p>
                        <p class="product-details-intro">
                            ${p.isCompatible
                                ? `Quality compatible drum unit for your ${Security.escapeHtml(p.brandName)} laser printer. The drum unit is an essential component responsible for transferring toner to paper, ensuring consistent high-quality prints.`
                                : `Original ${Security.escapeHtml(p.brandName)} drum unit for optimal print quality and reliability. The imaging drum is engineered to work perfectly with your printer for consistent, professional results.`
                            }
                        </p>
                    </div>

                    <h3 class="product-details-heading">Features & Benefits</h3>
                    <ul class="product-features-list">
                        ${p.pageYield ? `<li><strong>Drum Yield:</strong> ${p.pageYield.toLocaleString()} pages</li>` : '<li>Long-lasting drum life</li>'}
                        <li>Drum yield based on 1 page per job</li>
                        <li>${p.isCompatible ? 'Compatible with' : 'Designed for'} ${Security.escapeHtml(p.brandName)} laser printers</li>
                        <li>Consistent, high-quality print output</li>
                        <li>Easy installation process</li>
                        <li>Separate from toner cartridge - longer lifespan</li>
                        ${p.isCompatible ? '<li>Tested to OEM specifications</li>' : '<li>12 months manufacturer warranty</li>'}
                    </ul>

                    <h3 class="product-details-heading">When to Replace</h3>
                    <p>Replace your drum unit when you notice persistent print quality issues such as vertical lines, spots, or grey backgrounds that don't improve after replacing the toner cartridge.</p>

                    <h3 class="product-details-heading">What's Included</h3>
                    <ul class="product-features-list">
                        <li>1 x ${Security.escapeHtml(p.displayName)}</li>
                        <li>Installation instructions</li>
                    </ul>
                `,
                features: (p) => [
                    p.pageYield ? `Drum yield: ~${p.pageYield.toLocaleString()} pages` : 'Long-lasting performance',
                    `${p.isCompatible ? 'Compatible' : 'Genuine OEM'} ${Security.escapeHtml(p.brandName)} drum`,
                    'Consistent print quality',
                    'Easy installation',
                    p.isCompatible ? 'Tested to OEM specs' : '12 month warranty'
                ],
                faqs: (p) => [
                    {
                        q: 'What is a drum unit and when should I replace it?',
                        a: `<p>The drum unit (also called an imaging drum) is a cylinder that transfers toner onto paper. It typically lasts 3-4 times longer than a toner cartridge. Replace the drum when you notice persistent print quality issues like vertical lines, spots, or grey backgrounds that don't improve after replacing the toner.</p>`
                    },
                    {
                        q: 'Is the drum unit the same as the toner?',
                        a: `<p>No, they're different components. The toner cartridge contains the powder that creates the printed image, while the drum unit is the component that transfers the toner to paper. Some printers have them combined in one unit, but many ${Security.escapeHtml(p.brandName)} printers use separate drum and toner units for cost efficiency.</p>`
                    }
                ]
            },
            ribbon: {
                description: (p) => `
                    <div class="product-details-section">
                        <p class="product-details-meta">
                            <strong>Model:</strong> ${Security.escapeHtml(p.manufacturer_part_number || p.sku)}
                            <span style="margin-left: 1.5rem;"><strong>SKU:</strong> ${Security.escapeHtml(p.sku)}</span>
                        </p>
                        <p class="product-details-intro">
                            Quality ${Security.escapeHtml(p.brandName)} printer ribbon for reliable, consistent output. Our ribbons are manufactured to high standards to ensure clean, crisp printing every time.
                        </p>
                    </div>

                    <h3 class="product-details-heading">Features & Benefits</h3>
                    <ul class="product-features-list">
                        ${p.color ? `<li><strong>Colour:</strong> ${Security.escapeHtml(p.color)}</li>` : ''}
                        <li>Compatible with ${Security.escapeHtml(p.brandName)} printers and typewriters</li>
                        <li>Consistent, high-quality print output</li>
                        <li>Easy installation - simply remove and replace</li>
                        <li>Long-lasting ribbon life</li>
                    </ul>

                    <h3 class="product-details-heading">What's Included</h3>
                    <ul class="product-features-list">
                        <li>1 x ${Security.escapeHtml(p.displayName)}</li>
                    </ul>
                `,
                features: (p) => [
                    `${Security.escapeHtml(p.brandName)} printer ribbon`,
                    'Consistent print quality',
                    'Easy installation',
                    p.color ? `Colour: ${Security.escapeHtml(p.color)}` : null,
                    'Long-lasting ribbon life'
                ].filter(Boolean),
                faqs: (p) => [
                    {
                        q: 'How do I install this ribbon?',
                        a: `<p>Installing your ribbon is straightforward:</p>
                            <ol>
                                <li>Turn off your printer or typewriter</li>
                                <li>Open the ribbon access cover</li>
                                <li>Remove the old ribbon cartridge</li>
                                <li>Insert the new ribbon, ensuring it is properly threaded</li>
                                <li>Close the cover and test with a few prints</li>
                            </ol>`
                    },
                    {
                        q: 'How should I store unused ribbons?',
                        a: `<p>Store unopened ribbons in their original sealed packaging in a cool, dry place away from direct sunlight and heat. Properly stored ribbons typically last 2-3 years. Avoid humidity as it can affect the ink quality.</p>`
                    },
                    {
                        q: 'How do I know when to replace my ribbon?',
                        a: `<p>Replace your ribbon when print output becomes noticeably lighter or uneven. If you see faded characters, missing dots, or inconsistent print density across the page, it's time for a new ribbon.</p>`
                    }
                ]
            },
            default: {
                description: (p) => `
                    <div class="product-details-section">
                        <p class="product-details-meta">
                            <strong>Model:</strong> ${Security.escapeHtml(p.manufacturer_part_number || p.sku)}
                            <span style="margin-left: 1.5rem;"><strong>SKU:</strong> ${Security.escapeHtml(p.sku)}</span>
                        </p>
                        <p class="product-details-intro">
                            Quality ${Security.escapeHtml(p.brandName)} printing supplies for your printer. ${p.isCompatible ? 'This compatible product offers excellent value while maintaining high quality standards.' : 'Genuine OEM product for optimal performance and reliability.'}
                        </p>
                    </div>

                    <h3 class="product-details-heading">Features & Benefits</h3>
                    <ul class="product-features-list">
                        ${p.pageYield ? `<li><strong>Page Yield:</strong> ${p.pageYield.toLocaleString()} pages</li>` : ''}
                        <li>${p.isCompatible ? 'Compatible' : 'Genuine'} ${Security.escapeHtml(p.brandName)} product</li>
                        <li>High quality printing results</li>
                        <li>Easy installation</li>
                        ${p.isCompatible ? '<li>Cost-effective alternative</li>' : '<li>Manufacturer warranty included</li>'}
                    </ul>

                    <h3 class="product-details-heading">What's Included</h3>
                    <ul class="product-features-list">
                        <li>1 x ${Security.escapeHtml(p.displayName)}</li>
                    </ul>
                `,
                features: (p) => [
                    `${p.isCompatible ? 'Compatible' : 'Genuine'} ${Security.escapeHtml(p.brandName)} product`,
                    'Quality assured',
                    'Easy installation',
                    p.pageYield ? `Page yield: ~${p.pageYield.toLocaleString()} pages` : null
                ].filter(Boolean),
                faqs: (p) => [
                    {
                        q: 'How do I know this product is compatible with my printer?',
                        a: `<p>Check your printer's documentation or the label inside the cartridge access door for the model number. This product is designed to work with specific ${Security.escapeHtml(p.brandName)} printer models. If you're unsure, contact our customer support for assistance.</p>`
                    }
                ]
            }
        },

        async init() {
            const params = new URLSearchParams(window.location.search);
            const sku = params.get('sku');
            this._productType = params.get('type') || null; // 'ribbon' or null

            if (!sku) {
                this.showError('No product specified');
                return;
            }

            try {
                // Always use getProduct — it handles ribbons too (type=ribbon products)
                const response = await API.getProduct(sku);
                if (!response.ok || !response.data) {
                    this.showError('Product not found');
                    return;
                }

                this.product = response.data;
                this.renderProduct();
            } catch (error) {
                DebugLog.error('Error loading product:', error);
                this.showError('Failed to load product');
            }
        },

        getProductInfo() {
            const p = this.product;
            const name = p.name || '';
            const isCompatible = name.toLowerCase().startsWith('compatible ');
            const displayName = isCompatible ? name.substring(11).trim() : name;
            const brandName = p.brand?.name || (typeof p.brand === 'string' ? p.brand : null) || this.extractBrand(name) || 'Unknown';
            const category = this.normalizeCategory(p.category) || this.detectCategory(name);
            const pageYield = p.page_yield || p.yield || null;

            return {
                ...p,
                isCompatible,
                displayName,
                brandName,
                category,
                pageYield,
                color: p.color || null
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
            // Check URL type param or product_type field first
            if (this._productType === 'ribbon') return 'ribbon';
            const p = this.product;
            if (p && (p.product_type === 'ribbon' || (p.category || '').toLowerCase().includes('ribbon'))) return 'ribbon';
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
            const currentUrl = window.location.href;

            // Page title and meta description
            const metaDescription = this.generateMetaDescription(info);
            document.title = `${info.displayName} | Buy Online NZ | InkCartridges.co.nz`;
            document.getElementById('meta-description').content = metaDescription;

            // Open Graph tags
            document.getElementById('og-title').content = `${info.displayName} | InkCartridges.co.nz`;
            document.getElementById('og-description').content = metaDescription;
            document.getElementById('og-url').content = currentUrl;
            document.getElementById('og-price').content = price.toFixed(2);
            if (info.image_url) {
                document.getElementById('og-image').content = info.image_url;
            }

            // Twitter tags
            document.getElementById('twitter-title').content = `${info.displayName} | InkCartridges.co.nz`;
            document.getElementById('twitter-description').content = metaDescription;
            if (info.image_url) {
                document.getElementById('twitter-image').content = info.image_url;
            }

            // Canonical URL
            document.getElementById('canonical-url').href = currentUrl;

            // Schema.org Product structured data
            this.updateProductSchema(info, price);

            // Breadcrumb
            const isRibbon = info.category === 'ribbon';
            const categoryName = isRibbon ? 'Ribbons' :
                                 info.category === 'toner' ? 'Toner Cartridges' :
                                 info.category === 'drum' ? 'Drums' : 'Ink Cartridges';
            const brandSlug = info.brandName.toLowerCase().replace(/\s+/g, '-');
            if (isRibbon) {
                document.getElementById('breadcrumb-category').innerHTML = `<a href="/html/ribbons.html">${Security.escapeHtml(categoryName)}</a>`;
                document.getElementById('breadcrumb-brand').innerHTML = `<a href="/html/ribbons?brand=${Security.escapeAttr(info.brandName)}">${Security.escapeHtml(info.brandName)}</a>`;
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

            // Product badge
            const badge = document.getElementById('product-badge');
            if (info.isCompatible) {
                badge.textContent = 'COMPATIBLE';
                badge.hidden = false;
            } else {
                badge.textContent = 'GENUINE';
                badge.hidden = false;
            }

            // Title and SKU
            document.getElementById('product-title').textContent = info.displayName;
            document.getElementById('product-sku').textContent = `SKU: ${info.sku}${info.manufacturer_part_number ? ' | Model: ' + info.manufacturer_part_number : ''}`;

            // Price - use formatPrice() for consistent locale-aware currency display
            document.getElementById('product-price').textContent = formatPrice(price);

            // Stock status
            const stockEl = document.getElementById('product-stock');
            if (info.in_stock) {
                stockEl.innerHTML = `<span class="stock-status stock-status--in-stock">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
                    In Stock
                </span>`;
            } else {
                stockEl.innerHTML = `<span class="stock-status stock-status--out-of-stock">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/></svg>
                    Out of Stock
                </span>`;
                document.getElementById('add-to-cart-btn').disabled = true;
            }

            // Product image with color fallback
            const productImageEl = document.getElementById('product-image');
            if (info.image_url) {
                const color = info.color || this.detectColorFromName(info.displayName);
                const colorStyle = color ? this.getColorStyle(color) : null;

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
                const color = info.color || this.detectColorFromName(info.displayName);
                const colorStyle = color ? this.getColorStyle(color) : null;

                if (colorStyle) {
                    // colorStyle is safe — sourced from hardcoded ProductColors.map
                    productImageEl.classList.add('product-gallery__main--color-only');
                    productImageEl.closest('.product-detail__layout').classList.add('product-detail__layout--color-only');
                    productImageEl.innerHTML = `<div class="product-gallery__color-block" style="${colorStyle}"></div>`;
                } else {
                    productImageEl.innerHTML = `<img src="/assets/images/placeholder-product.svg" alt="${Security.escapeAttr(info.displayName)}" style="max-width: 100%; height: auto;">`;
                }
            }

            // Get template based on category
            const template = this.templates[info.category] || this.templates.default;

            // Features
            const features = template.features(info);
            document.getElementById('product-features').innerHTML = features.map(f => `
                <li>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
                    ${Security.escapeHtml(f)}
                </li>
            `).join('');

            // Description
            document.getElementById('product-description').innerHTML = template.description(info);

            // Specifications
            document.getElementById('product-specs').innerHTML = `
                <tbody>
                    <tr><th scope="row">Brand</th><td>${Security.escapeHtml(info.brandName)}</td></tr>
                    <tr><th scope="row">SKU</th><td>${Security.escapeHtml(info.sku)}</td></tr>
                    ${info.manufacturer_part_number ? `<tr><th scope="row">Model Number</th><td>${Security.escapeHtml(info.manufacturer_part_number)}</td></tr>` : ''}
                    ${info.color ? `<tr><th scope="row">Colour</th><td>${Security.escapeHtml(info.color)}</td></tr>` : ''}
                    ${info.pageYield ? `<tr><th scope="row">Page Yield</th><td>Approx. ${info.pageYield.toLocaleString()} pages</td></tr>` : ''}
                    <tr><th scope="row">Product Type</th><td>${info.isCompatible ? 'Compatible' : 'Genuine OEM'}</td></tr>
                    <tr><th scope="row">Category</th><td>${Security.escapeHtml(categoryName)}</td></tr>
                </tbody>
            `;

            // FAQs
            const faqs = template.faqs(info);
            // faq.q is plain text — escape it. faq.a is trusted HTML from templates
            // (dynamic values inside faq.a are already escaped at the template level above).
            document.getElementById('product-faqs').innerHTML = faqs.map(faq => `
                <details class="faq-item">
                    <summary class="faq-item__question">${Security.escapeHtml(faq.q)}</summary>
                    <div class="faq-item__answer">${faq.a}</div>
                </details>
            `).join('') || '<p>No FAQs available for this product.</p>';

            // Compatible Printers (skip for ribbons)
            if (info.category !== 'ribbon') {
                this.renderCompatiblePrinters(info);
            }

            // Set up event listeners
            this.setupEventListeners(info);
        },

        async renderCompatiblePrinters(info) {
            const descriptionEl = document.getElementById('product-description');
            if (!descriptionEl) return;

            try {
                // Try current product SKU first
                let printers = await this._fetchPrinters(info.sku);

                // If empty, find a sibling product that has printer data
                // (compatible products often lack it, but genuine ones have it)
                if (printers.length === 0) {
                    const code = this.extractProductCode(info);
                    if (code) {
                        const searchResponse = await API.getProducts({
                            brand: (info.brand?.slug || info.brandName || '').toLowerCase().replace(/\s+/g, '-'),
                            search: code,
                            limit: 10
                        });
                        if (searchResponse.ok && searchResponse.data?.products) {
                            for (const product of searchResponse.data.products) {
                                if (product.sku && product.sku !== info.sku) {
                                    printers = await this._fetchPrinters(product.sku);
                                    if (printers.length > 0) break;
                                }
                            }
                        }
                    }
                }

                if (printers.length === 0) return;

                const printerLinks = printers.map(p => {
                    const params = new URLSearchParams({ printer_model: p.name });
                    if (p.brand) params.set('printer_brand', p.brand);
                    return `<a href="/html/shop?${params}" class="printer-link">${Security.escapeHtml(p.name)}</a>`;
                }).join(', ');

                const html = `
                    <div class="product-printers-banner" style="margin-top: var(--spacing-xl);">
                        <strong>For Use In:</strong>
                        <span>${printerLinks}</span>
                    </div>
                `;

                descriptionEl.insertAdjacentHTML('beforeend', html);
            } catch (error) {
                // Silently fail — compatible printers are optional
            }
        },

        /**
         * Fetch printer names for a given SKU from the compatible-printers endpoint
         */
        async _fetchPrinters(sku) {
            try {
                const response = await API.getCompatiblePrinters(sku);
                if (!response.ok || !response.data) return [];

                const printers = response.data.printers || response.data.compatible_printers || response.data;
                if (!Array.isArray(printers) || printers.length === 0) return [];

                return printers.map(p => {
                    if (typeof p === 'string') return { name: p, brand: '' };
                    const name = p.full_name || p.model_name || p.name || '';
                    const brand = p.brand_name || p.brand || '';
                    return { name, brand };
                }).filter(p => p.name).sort((a, b) => a.name.localeCompare(b.name));
            } catch (e) {
                return [];
            }
        },

        setupEventListeners(info) {
            // Quantity controls — cap at stock_quantity if available
            const qtyInput = document.getElementById('qty-input');
            const maxQty = (info.stock_quantity > 0) ? info.stock_quantity : 99;
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
                } catch (error) {
                    btn.textContent = 'Error';
                    setTimeout(() => {
                        btn.textContent = 'Add to Cart';
                        btn.disabled = !info.in_stock;
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

            // Tab switching
            document.querySelectorAll('.tabs__button').forEach(btn => {
                btn.addEventListener('click', () => {
                    document.querySelectorAll('.tabs__button').forEach(b => {
                        b.classList.remove('tabs__button--active');
                        b.setAttribute('aria-selected', 'false');
                    });
                    document.querySelectorAll('.tabs__panel').forEach(p => {
                        p.classList.remove('tabs__panel--active');
                        p.hidden = true;
                    });

                    btn.classList.add('tabs__button--active');
                    btn.setAttribute('aria-selected', 'true');
                    const panel = document.getElementById(btn.getAttribute('aria-controls'));
                    panel.classList.add('tabs__panel--active');
                    panel.hidden = false;
                });
            });
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

        // Update Schema.org Product structured data
        updateProductSchema(info, price) {
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
                "category": info.category === 'ribbon' ? 'Printer Ribbons' :
                           info.category === 'toner' ? 'Toner Cartridges' :
                           info.category === 'drum' ? 'Drum Units' : 'Ink Cartridges',
                "offers": {
                    "@type": "Offer",
                    "url": window.location.href,
                    "priceCurrency": "NZD",
                    "price": price.toFixed(2),
                    "availability": info.in_stock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
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
                        "deliveryTime": {
                            "@type": "ShippingDeliveryTime",
                            "handlingTime": {
                                "@type": "QuantitativeValue",
                                "minValue": 0,
                                "maxValue": 1,
                                "unitCode": "DAY"
                            },
                            "transitTime": {
                                "@type": "QuantitativeValue",
                                "minValue": 1,
                                "maxValue": 5,
                                "unitCode": "DAY"
                            }
                        }
                    }
                }
            };

            // Add image if available
            if (info.image_url) {
                schema.image = info.image_url;
            }

            // Add color if available
            if (info.color) {
                schema.color = info.color;
            }

            // Update the script tag
            const schemaEl = document.getElementById('product-schema');
            if (schemaEl) {
                schemaEl.textContent = JSON.stringify(schema, null, 2);
            }
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
            document.querySelector('.product-info__trust').hidden = true;
            document.querySelector('.product-info__features').hidden = true;
            document.querySelector('.product-tabs').hidden = true;

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
