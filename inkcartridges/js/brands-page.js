/**
 * brands-page.js
 * Controller for /brands/:slug landing pages.
 * Reads brand slug from URL path, fetches products, renders grid + meta.
 */

const BrandsPage = {
    async init() {
        // Extract slug from URL: /brands/hp → "hp"
        const pathParts = window.location.pathname.split('/').filter(Boolean);
        const slug = pathParts[pathParts.length - 1];

        if (!slug || slug === 'brands') {
            this.showError('Brand not specified.');
            return;
        }

        try {
            await this.load(slug);
        } catch (err) {
            this.showError('Failed to load brand products.');
        }
    },

    async load(slug) {
        // Fetch brand info and products in parallel
        const [brandsRes, productsRes] = await Promise.all([
            API.getBrands(),
            API.getProducts({ brand: slug, limit: 48 })
        ]);

        // Resolve brand display name from brands list
        let brandName = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        if (brandsRes.ok && brandsRes.data) {
            const brands = Array.isArray(brandsRes.data) ? brandsRes.data : (brandsRes.data.brands || []);
            const match = brands.find(b => (b.slug || '').toLowerCase() === slug.toLowerCase());
            if (match) brandName = match.name || brandName;
        }

        const products = productsRes.ok ? (productsRes.data?.products || []) : [];

        this.render(slug, brandName, products);
    },

    render(slug, brandName, products) {
        const canonicalUrl = `https://www.inkcartridges.co.nz/brands/${slug}`;
        const pageTitle = `${brandName} Ink Cartridges NZ | InkCartridges.co.nz`;
        const description = `Shop genuine and compatible ${brandName} ink cartridges and toner in NZ. Fast delivery, free shipping over $100.`;

        // Meta
        document.title = pageTitle;
        document.getElementById('page-title').textContent = pageTitle;
        document.getElementById('meta-description').content = description;
        document.getElementById('og-title').content = pageTitle;
        document.getElementById('og-description').content = description;
        document.getElementById('canonical-url').href = canonicalUrl;

        // Heading + description
        document.getElementById('page-heading').textContent = `${brandName} Ink Cartridges NZ`;
        document.getElementById('page-description').textContent = description;

        // Breadcrumb
        document.getElementById('breadcrumb-brand').textContent = `${brandName} Ink Cartridges`;

        // CollectionPage JSON-LD
        const schema = {
            "@context": "https://schema.org",
            "@type": "CollectionPage",
            "name": `${brandName} Ink Cartridges NZ`,
            "description": description,
            "url": canonicalUrl,
            "breadcrumb": {
                "@type": "BreadcrumbList",
                "itemListElement": [
                    { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://www.inkcartridges.co.nz" },
                    { "@type": "ListItem", "position": 2, "name": `${brandName} Ink Cartridges`, "item": canonicalUrl }
                ]
            }
        };
        document.getElementById('page-schema').textContent = JSON.stringify(schema);

        // Products grid
        const loading = document.getElementById('products-loading');
        const grid = document.getElementById('products-grid');
        const noProducts = document.getElementById('no-products');

        loading.hidden = true;

        if (products.length === 0) {
            noProducts.hidden = false;
            return;
        }

        grid.innerHTML = products.map(p => Products.renderCard(p)).join('');
        Products.bindImageFallbacks(grid);
        Products.bindAddToCartEvents(grid);
        grid.hidden = false;
    },

    showError(message) {
        document.getElementById('products-loading').hidden = true;
        const errEl = document.getElementById('products-error');
        errEl.querySelector('p').textContent = message;
        errEl.hidden = false;
    }
};

document.addEventListener('DOMContentLoaded', () => BrandsPage.init());
