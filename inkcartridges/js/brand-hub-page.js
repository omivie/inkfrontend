/**
 * brand-hub-page.js
 * Controller for /brands/:slug/hub — Brand Price Comparison Hub page.
 * Fetches brand hub data and price comparison from the backend API,
 * renders hero, stats, comparison table, featured products, and buying guide.
 */

const BrandHubPage = {
    slug: '',
    brandName: '',

    async init() {
        // URL: /brands/hp/hub → ['brands', 'hp', 'hub']
        const pathParts = window.location.pathname.split('/').filter(Boolean);
        const slug = pathParts.length >= 2 ? pathParts[1] : '';

        if (!slug) {
            this.showError('Brand not specified.');
            return;
        }

        this.slug = slug;

        try {
            await this.load(slug);
        } catch (err) {
            this.showError('Failed to load brand hub.');
        }
    },

    async load(slug) {
        const encodedSlug = encodeURIComponent(slug);

        // Fire both API calls in parallel — price comparison is optional
        const [hubRes, priceRes] = await Promise.all([
            API.get(`/api/brand-hubs/${encodedSlug}`),
            API.get(`/api/brand-hubs/${encodedSlug}/price-comparison`).catch(() => ({ ok: false }))
        ]);

        if (!hubRes.ok || !hubRes.data) {
            this.showError('Brand hub not found.');
            return;
        }

        const hubData = hubRes.data;
        const priceData = priceRes.ok ? priceRes.data : null;

        this.brandName = hubData.brand_name || hubData.name || slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

        this.render(hubData, priceData);
    },

    render(hubData, priceData) {
        // Hide loading
        document.getElementById('hub-loading').hidden = true;

        // Update meta & breadcrumbs
        this.updateMeta(hubData);

        // Inject JSON-LD from API
        if (hubData.seo && hubData.seo.jsonLd) {
            this.injectJsonLd(hubData.seo.jsonLd);
        }

        // Render sections (each guards against missing data)
        this.renderHero(hubData);
        this.renderStats(hubData.stats);
        this.renderPriceComparison(priceData);
        this.renderFeaturedProducts(hubData.featured_products);
        this.renderBuyingGuide(hubData.buying_guide);
    },

    updateMeta(data) {
        const slug = this.slug;
        const brandName = this.brandName;
        const canonicalUrl = `https://www.inkcartridges.co.nz/brands/${slug}/hub`;

        const title = (data.seo && data.seo.title) || `${brandName} Price Comparison Hub | InkCartridges.co.nz`;
        const description = (data.seo && data.seo.description) || `Compare ${brandName} ink cartridge prices across NZ. Find the best deals on genuine and compatible cartridges.`;

        document.title = title;
        const titleEl = document.getElementById('page-title');
        if (titleEl) titleEl.textContent = title;

        const metaDesc = document.getElementById('meta-description');
        if (metaDesc) metaDesc.content = description;

        const ogTitle = document.getElementById('og-title');
        if (ogTitle) ogTitle.content = title;

        const ogDesc = document.getElementById('og-description');
        if (ogDesc) ogDesc.content = description;

        const canonical = document.getElementById('canonical-url');
        if (canonical) canonical.href = canonicalUrl;

        // Breadcrumb
        const brandLink = document.getElementById('breadcrumb-brand-link');
        if (brandLink) {
            brandLink.href = `/brands/${slug}`;
            brandLink.textContent = `${brandName} Ink Cartridges`;
        }
    },

    renderHero(data) {
        const hero = document.getElementById('hub-hero');
        if (!hero) return;

        const heading = document.getElementById('hub-heading');
        if (heading) heading.textContent = this.brandName + ' Price Comparison';

        const tagline = document.getElementById('hub-tagline');
        if (tagline && data.tagline) {
            tagline.textContent = data.tagline;
        } else if (tagline) {
            tagline.textContent = `Compare ${this.brandName} ink cartridge prices and save.`;
        }

        hero.hidden = false;
    },

    renderStats(stats) {
        if (!stats || typeof stats !== 'object') return;

        const container = document.getElementById('hub-stats');
        if (!container) return;

        const statItems = [];

        if (stats.product_count != null) {
            statItems.push({ value: stats.product_count, label: 'Products' });
        }
        if (stats.avg_savings_percent != null) {
            statItems.push({ value: Math.round(stats.avg_savings_percent) + '%', label: 'Avg. Savings' });
        }
        if (stats.lowest_price_count != null) {
            statItems.push({ value: stats.lowest_price_count, label: 'Lowest Prices' });
        }
        if (stats.competitor_count != null) {
            statItems.push({ value: stats.competitor_count, label: 'Competitors Compared' });
        }

        if (statItems.length === 0) return;

        container.innerHTML = statItems.map(s => `
            <div class="brand-hub-stat">
                <div class="brand-hub-stat__value">${Security.escapeHtml(String(s.value))}</div>
                <div class="brand-hub-stat__label">${Security.escapeHtml(s.label)}</div>
            </div>
        `).join('');
    },

    renderPriceComparison(priceData) {
        if (!priceData) return;

        const section = document.getElementById('hub-comparison');
        const wrapper = document.getElementById('comparison-table-wrapper');
        if (!section || !wrapper) return;

        const competitors = priceData.competitors || priceData.breakdown || [];
        if (!Array.isArray(competitors) || competitors.length === 0) return;

        const subtitle = document.getElementById('comparison-subtitle');
        if (subtitle && priceData.summary) {
            subtitle.textContent = priceData.summary;
        }

        let html = `
            <table class="brand-hub-comparison__table">
                <thead>
                    <tr>
                        <th>Retailer</th>
                        <th>Avg. Price</th>
                        <th>Our Price</th>
                        <th>You Save</th>
                    </tr>
                </thead>
                <tbody>
        `;

        competitors.forEach(c => {
            const name = Security.escapeHtml(c.name || c.competitor_name || 'Unknown');
            const theirPrice = c.avg_price != null ? formatPrice(c.avg_price) : 'N/A';
            const ourPrice = c.our_price != null ? formatPrice(c.our_price) : 'N/A';
            const savingsPercent = c.savings_percent != null ? Math.round(c.savings_percent) + '%' : '';

            html += `
                <tr>
                    <td>${name}</td>
                    <td>${theirPrice}</td>
                    <td class="brand-hub-comparison__our-price">${ourPrice}</td>
                    <td class="brand-hub-comparison__savings">${savingsPercent ? Security.escapeHtml(savingsPercent) : '&mdash;'}</td>
                </tr>
            `;
        });

        html += '</tbody></table>';
        wrapper.innerHTML = html;
        section.hidden = false;
    },

    renderFeaturedProducts(products) {
        if (!Array.isArray(products) || products.length === 0) return;

        const section = document.getElementById('hub-products');
        const grid = document.getElementById('hub-products-grid');
        if (!section || !grid) return;

        grid.innerHTML = products.map(p => Products.renderCard(p)).join('');
        Products.bindImageFallbacks(grid);
        Products.bindAddToCartEvents(grid);
        section.hidden = false;
    },

    renderBuyingGuide(guide) {
        if (!guide) return;

        const section = document.getElementById('hub-guide');
        const content = document.getElementById('hub-guide-content');
        const heading = document.getElementById('hub-guide-heading');
        if (!section || !content) return;

        // Guide can be a string (HTML) or an object with title + sections
        if (typeof guide === 'string' && guide.trim()) {
            content.textContent = guide;
            section.hidden = false;
        } else if (typeof guide === 'object') {
            if (guide.title && heading) {
                heading.textContent = Security.escapeHtml(guide.title);
            }

            let html = '';
            const sections = guide.sections || guide.content || [];

            if (Array.isArray(sections)) {
                sections.forEach(s => {
                    if (s.heading) {
                        html += `<h3>${Security.escapeHtml(s.heading)}</h3>`;
                    }
                    if (s.text) {
                        html += `<p>${Security.escapeHtml(s.text)}</p>`;
                    }
                });
            } else if (typeof sections === 'string') {
                html = `<p>${Security.escapeHtml(sections)}</p>`;
            }

            if (html) {
                content.innerHTML = html;
                section.hidden = false;
            }
        }
    },

    injectJsonLd(schemas) {
        const schemaEl = document.getElementById('page-schema');
        if (!schemaEl || !schemas) return;

        // schemas can be an array or a single object
        const data = Array.isArray(schemas) ? schemas : [schemas];
        schemaEl.textContent = JSON.stringify(data);
    },

    showError(message) {
        document.getElementById('hub-loading').hidden = true;
        const errEl = document.getElementById('hub-error');
        if (errEl) {
            const p = errEl.querySelector('p');
            if (p && message) p.textContent = message;
            errEl.hidden = false;
        }
    }
};

document.addEventListener('DOMContentLoaded', () => BrandHubPage.init());
