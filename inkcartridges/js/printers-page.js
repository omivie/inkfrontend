/**
 * printers-page.js
 * Controller for /printers/:slug landing pages.
 * Reads printer slug from URL path, fetches products, renders grid + meta.
 * API response shape: { printer: { model_name, full_name, slug, brand: { name, slug } }, products: [...] }
 */

const PrintersPage = {
    async init() {
        // Extract slug from URL: /printers/hp-deskjet-2710 → "hp-deskjet-2710"
        const pathParts = window.location.pathname.split('/').filter(Boolean);
        const slug = pathParts[pathParts.length - 1];

        if (!slug || slug === 'printers') {
            this.showError('Printer not specified.');
            return;
        }

        try {
            await this.load(slug);
        } catch (err) {
            this.showError('Failed to load printer products.');
        }
    },

    async load(slug) {
        const response = await API.getProductsByPrinter(slug);

        if (!response.ok) {
            this.showError('Printer not found.');
            return;
        }

        const printer = response.data?.printer || {};
        const products = response.data?.products || [];

        this.render(slug, printer, products);
    },

    render(slug, printer, products) {
        const printerName = printer.full_name || printer.model_name || slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        const brandName = (printer.brand && printer.brand.name) ? printer.brand.name : '';
        const brandSlug = (printer.brand && printer.brand.slug) ? printer.brand.slug : (brandName.toLowerCase().replace(/\s+/g, '-'));

        const canonicalUrl = `https://www.inkcartridges.co.nz/printers/${slug}`;
        const pageTitle = `${printerName} Ink Cartridges NZ | InkCartridges.co.nz`;
        const description = `Find compatible ink cartridges and toner for the ${printerName} in NZ. Fast delivery, free shipping over $100.`;

        // Meta
        document.title = pageTitle;
        document.getElementById('page-title').textContent = pageTitle;
        document.getElementById('meta-description').content = description;
        document.getElementById('og-title').content = pageTitle;
        document.getElementById('og-description').content = description;
        document.getElementById('canonical-url').href = canonicalUrl;

        // Heading + description
        document.getElementById('page-heading').textContent = `${printerName} Ink Cartridges NZ`;
        document.getElementById('page-description').textContent = description;

        // Breadcrumb
        const brandCrumb = document.getElementById('breadcrumb-brand');
        const printerCrumb = document.getElementById('breadcrumb-printer');
        if (brandName && brandSlug) {
            brandCrumb.innerHTML = `<a href="/brands/${Security.escapeAttr(brandSlug)}">${Security.escapeHtml(brandName)} Ink Cartridges</a>`;
        } else {
            brandCrumb.hidden = true;
        }
        printerCrumb.textContent = printerName;

        // CollectionPage JSON-LD
        const itemListElement = [
            { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://www.inkcartridges.co.nz" }
        ];
        if (brandName && brandSlug) {
            itemListElement.push({ "@type": "ListItem", "position": 2, "name": `${brandName} Ink Cartridges`, "item": `https://www.inkcartridges.co.nz/brands/${brandSlug}` });
            itemListElement.push({ "@type": "ListItem", "position": 3, "name": printerName, "item": canonicalUrl });
        } else {
            itemListElement.push({ "@type": "ListItem", "position": 2, "name": printerName, "item": canonicalUrl });
        }

        const schema = {
            "@context": "https://schema.org",
            "@type": "CollectionPage",
            "name": `${printerName} Ink Cartridges NZ`,
            "description": description,
            "url": canonicalUrl,
            "breadcrumb": {
                "@type": "BreadcrumbList",
                "itemListElement": itemListElement
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

document.addEventListener('DOMContentLoaded', () => PrintersPage.init());
