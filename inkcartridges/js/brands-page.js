/**
 * brands-page.js
 * Controller for /brands/:slug landing pages.
 * Reads brand slug from URL path, fetches products, renders grid + meta + FAQs.
 */

const BrandsPage = {
    /** Brand-specific SEO content keyed by slug */
    brandContent: {
        hp: {
            title: 'HP Ink Cartridges NZ',
            description: 'Find genuine and compatible HP ink cartridges and toner at InkCartridges.co.nz. HP is one of the world\'s most trusted printer brands, known for reliable performance across home and office environments. Whether you use an HP DeskJet, OfficeJet, LaserJet, or ENVY printer, we stock the full range of replacement cartridges to keep you printing. Our compatible HP cartridges deliver the same page yield and print quality as originals at a fraction of the cost, while our genuine HP cartridges guarantee OEM reliability. All orders ship fast across New Zealand, with free delivery on orders over $100. We are a 100% NZ-owned business offering local support seven days a week. Browse our HP range below and find the right cartridge for your printer today.',
            metaDescription: 'Shop genuine and compatible HP ink cartridges and toner in NZ. Fast NZ-wide delivery, free shipping over $100. HP DeskJet, OfficeJet, LaserJet cartridges in stock.',
            faqs: [
                { question: 'Are compatible HP ink cartridges as good as genuine?', answer: 'Yes. Our compatible HP cartridges are manufactured to match OEM specifications for page yield, print quality, and colour accuracy. They are tested to work reliably with HP printers and come with a quality guarantee. Many customers find them an excellent value alternative to genuine HP cartridges.' },
                { question: 'How do I find the right HP cartridge for my printer?', answer: 'Use the search bar at the top of the page and type your HP printer model (e.g. "HP OfficeJet 3830") or cartridge number (e.g. "HP 63"). The results will show all compatible cartridges for your printer. You can also browse the full HP range on this page.' },
                { question: 'Do you offer free shipping on HP cartridges in New Zealand?', answer: 'Yes, we offer free NZ-wide shipping on all orders over $100. Orders under $100 ship at a flat rate. Most orders are dispatched the same business day and arrive within 1-3 working days depending on your location.' },
                { question: 'Will compatible HP cartridges void my printer warranty?', answer: 'No. Under New Zealand consumer law and international guidelines, using compatible or third-party cartridges does not void your printer warranty. HP cannot refuse warranty service solely because you used a non-genuine cartridge.' }
            ]
        },
        canon: {
            title: 'Canon Ink Cartridges NZ',
            description: 'Shop genuine and compatible Canon ink cartridges and toner at InkCartridges.co.nz. Canon printers are popular across New Zealand for photo printing, home office use, and small business workflows. We carry cartridges for the full Canon PIXMA, MAXIFY, and imageCLASS ranges, including high-yield XL options that give you more prints per cartridge. Our compatible Canon cartridges are precision-engineered to deliver vivid colours and sharp text, matching the performance of genuine Canon originals. If you prefer OEM quality, we also stock genuine Canon cartridges at competitive NZ prices. Every order ships fast within New Zealand, with free delivery when you spend over $100. Our NZ-based support team is available seven days a week to help you find the right cartridge. Browse Canon products below.',
            metaDescription: 'Buy genuine and compatible Canon ink cartridges and toner online in NZ. Free shipping over $100. Canon PIXMA, MAXIFY, imageCLASS cartridges available.',
            faqs: [
                { question: 'What Canon cartridges do you stock?', answer: 'We stock a comprehensive range of Canon ink cartridges and toner for PIXMA, MAXIFY, and imageCLASS printers. This includes standard and high-yield XL cartridges, individual colour cartridges, and multi-pack options. Search by your printer model or cartridge number to find the right fit.' },
                { question: 'Are compatible Canon cartridges reliable?', answer: 'Absolutely. Our compatible Canon cartridges are manufactured with strict quality controls to ensure consistent ink flow, accurate colour reproduction, and reliable chip recognition. They are designed to work seamlessly with your Canon printer without errors or warnings.' },
                { question: 'How fast is delivery for Canon cartridges in NZ?', answer: 'Most orders are dispatched the same business day. Delivery typically takes 1-3 working days across New Zealand. We offer free shipping on orders over $100, and a flat-rate option for smaller orders.' },
                { question: 'Can I use compatible cartridges in my Canon PIXMA printer?', answer: 'Yes. Compatible cartridges are designed to work with Canon PIXMA printers just like genuine ones. They use matching chip technology so your printer recognises them correctly. Using compatible cartridges will not void your printer warranty under NZ consumer law.' }
            ]
        },
        epson: {
            title: 'Epson Ink Cartridges NZ',
            description: 'Buy genuine and compatible Epson ink cartridges and toner at InkCartridges.co.nz. Epson is renowned for its precision printing technology, from the popular Expression and WorkForce series to EcoTank and laser models. We stock Epson cartridges in standard and high-capacity variants, including the popular 220, 252, 502, and 604 series. Our compatible Epson cartridges use high-quality inks formulated to produce sharp text and accurate photo colours, while our genuine Epson cartridges ensure OEM-grade results. All cartridges are tested for compatibility and shipped fast across New Zealand, with free delivery on orders over $100. We are proudly NZ-owned and operated, with local customer support available seven days a week. Find the right Epson cartridge for your printer below.',
            metaDescription: 'Order genuine and compatible Epson ink cartridges and toner in NZ. Free NZ shipping over $100. Epson Expression, WorkForce, EcoTank cartridges in stock.',
            faqs: [
                { question: 'Do compatible Epson cartridges work with firmware updates?', answer: 'We continuously update our compatible Epson cartridges to ensure chip compatibility with the latest Epson firmware. If you experience any issues after a firmware update, contact our support team and we will help resolve it or provide a replacement.' },
                { question: 'What Epson cartridge series do you carry?', answer: 'We stock all major Epson cartridge series including 220, 252, 254, 277, 502, 503, 604, and more. We carry both standard and high-yield (XL) versions. Use the search bar to find cartridges by series number or your Epson printer model.' },
                { question: 'Is it cheaper to buy compatible Epson cartridges?', answer: 'Yes. Compatible Epson cartridges typically cost 50-70% less than genuine Epson cartridges while delivering comparable page yields and print quality. Multi-packs offer even greater savings for high-volume printing.' },
                { question: 'Do you ship Epson cartridges throughout New Zealand?', answer: 'Yes, we deliver to all NZ addresses including rural areas. Orders over $100 qualify for free shipping. Standard delivery takes 1-3 working days, with most orders dispatched the same business day.' }
            ]
        },
        brother: {
            title: 'Brother Ink Cartridges NZ',
            description: 'Shop genuine and compatible Brother ink cartridges and toner at InkCartridges.co.nz. Brother printers are a staple in New Zealand offices and homes, valued for their reliability and low running costs. We stock the full range of Brother cartridges and toner for MFC, DCP, and HL series printers, including high-yield LC and TN cartridges that maximise your prints per cartridge. Our compatible Brother cartridges are engineered to deliver crisp text and consistent output, matching the quality of genuine Brother supplies. We also carry genuine Brother cartridges and drum units for customers who prefer OEM products. All orders ship quickly across New Zealand with free delivery over $100. Our local support team is here to help seven days a week. Browse Brother products below.',
            metaDescription: 'Shop genuine and compatible Brother ink cartridges and toner in NZ. Free shipping over $100. Brother MFC, DCP, HL series cartridges and toner in stock.',
            faqs: [
                { question: 'What is the difference between Brother ink cartridges and toner?', answer: 'Brother ink cartridges are used in inkjet printers (like the MFC-J series and DCP-J series), while Brother toner cartridges are used in laser printers (like the HL and MFC-L series). Toner cartridges use powder instead of liquid ink and typically offer higher page yields, making them ideal for high-volume text printing.' },
                { question: 'Do you stock Brother drum units?', answer: 'Yes, we carry both genuine and compatible Brother drum units (DR series). Drum units are separate from toner cartridges in Brother laser printers and typically need replacing less frequently. Search by your printer model to find the correct drum unit.' },
                { question: 'Are compatible Brother toner cartridges reliable?', answer: 'Yes. Our compatible Brother toner cartridges are manufactured to strict standards, delivering consistent print density and sharp text output. They are designed to work seamlessly with Brother laser printers and include properly programmed chips for accurate page count tracking.' },
                { question: 'How do I know when to replace my Brother cartridge?', answer: 'Your Brother printer will display a low ink or toner warning when the cartridge is running low. You can also check ink or toner levels through your printer settings or the Brother iPrint&Scan app. We recommend ordering a replacement as soon as the low warning appears to avoid any printing interruptions.' }
            ]
        }
    },

    /** All products fetched for this brand (unfiltered) */
    allProducts: [],
    /** Current category filter */
    activeCategory: 'all',

    async init() {
        // Extract slug from URL: /brands/hp -> "hp"
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
            API.getProducts({ brand: slug, limit: 100 })
        ]);

        // Resolve brand display name from brands list
        let brandName = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
        if (brandsRes.ok && brandsRes.data) {
            const brands = Array.isArray(brandsRes.data) ? brandsRes.data : (brandsRes.data.brands || []);
            const match = brands.find(b => (b.slug || '').toLowerCase() === slug.toLowerCase());
            if (match) brandName = match.name || brandName;
        }

        const products = productsRes.ok ? (productsRes.data?.products || []) : [];
        this.allProducts = products;

        this.render(slug, brandName, products);
        this.initCategoryTabs(slug, brandName);
    },

    /**
     * Classify a product into a category based on its name/fields.
     */
    classifyProduct(product) {
        const name = (product.name || '').toLowerCase();
        const category = (product.category || '').toLowerCase();

        if (category === 'drum' || /\bdrum\b/.test(name)) return 'drum';
        if (category === 'toner' || /\btoner\b/.test(name)) return 'toner';
        if (category === 'ink' || /\bink\b/.test(name) || /\bcartridge\b/.test(name)) return 'ink';
        // Default: show under "all" only
        return 'other';
    },

    /**
     * Filter products by category and re-render the grid.
     */
    filterProducts(category) {
        this.activeCategory = category;
        const grid = document.getElementById('products-grid');
        const noProducts = document.getElementById('no-products');

        let filtered = this.allProducts;
        if (category !== 'all') {
            filtered = this.allProducts.filter(p => this.classifyProduct(p) === category);
        }

        if (filtered.length === 0) {
            grid.hidden = true;
            noProducts.hidden = false;
        } else {
            noProducts.hidden = true;
            grid.innerHTML = filtered.map((p, i) => Products.renderCard(p, i)).join('');
            Products.bindImageFallbacks(grid);
            Products.bindAddToCartEvents(grid);
            grid.hidden = false;
        }
    },

    /**
     * Initialise category tab click handlers.
     */
    initCategoryTabs() {
        const tabsContainer = document.getElementById('category-tabs');
        if (!tabsContainer || this.allProducts.length === 0) return;

        tabsContainer.hidden = false;

        const buttons = tabsContainer.querySelectorAll('.tabs__button');
        buttons.forEach(btn => {
            btn.addEventListener('click', () => {
                // Update active state
                buttons.forEach(b => {
                    b.classList.remove('tabs__button--active');
                    b.setAttribute('aria-selected', 'false');
                });
                btn.classList.add('tabs__button--active');
                btn.setAttribute('aria-selected', 'true');

                this.filterProducts(btn.dataset.category);
            });
        });
    },

    render(slug, brandName, products) {
        const canonicalUrl = `https://www.inkcartridges.co.nz/brands/${slug}`;
        const content = this.brandContent[slug.toLowerCase()] || null;

        const pageTitle = content
            ? `${content.title} | InkCartridges.co.nz`
            : `${brandName} Ink Cartridges NZ | InkCartridges.co.nz`;
        const metaDesc = content
            ? content.metaDescription
            : `Shop genuine and compatible ${brandName} ink cartridges and toner in NZ. Fast delivery, free shipping over $100.`;
        const heading = content ? content.title : `${brandName} Ink Cartridges NZ`;

        // Meta tags
        document.title = pageTitle;
        document.getElementById('page-title').textContent = pageTitle;
        document.getElementById('meta-description').content = metaDesc;
        document.getElementById('og-title').content = pageTitle;
        document.getElementById('og-description').content = metaDesc;
        document.getElementById('canonical-url').href = canonicalUrl;

        // Heading
        document.getElementById('page-heading').textContent = heading;

        // Brand intro
        if (content) {
            const introEl = document.getElementById('brand-intro');
            const introText = document.getElementById('brand-intro-text');
            introText.textContent = content.description;
            introEl.hidden = false;
        }

        // Breadcrumb
        document.getElementById('breadcrumb-brand').textContent = `${brandName} Ink Cartridges`;

        // Build JSON-LD schemas
        this.renderSchemas(slug, brandName, canonicalUrl, metaDesc, products, content);

        // Products grid
        const loading = document.getElementById('products-loading');
        const grid = document.getElementById('products-grid');
        const noProducts = document.getElementById('no-products');

        loading.hidden = true;

        if (products.length === 0) {
            noProducts.hidden = false;
            return;
        }

        grid.innerHTML = products.map((p, i) => Products.renderCard(p, i)).join('');
        Products.bindImageFallbacks(grid);
        Products.bindAddToCartEvents(grid);
        grid.hidden = false;

        // FAQ section
        if (content && content.faqs && content.faqs.length > 0) {
            this.renderFAQs(content.faqs, brandName);
        }
    },

    /**
     * Render FAQ accordion from brand content.
     */
    renderFAQs(faqs, brandName) {
        const section = document.getElementById('brand-faq-section');
        const list = document.getElementById('faq-list');
        const heading = document.getElementById('faq-heading');

        if (!section || !list) return;

        heading.textContent = `${Security.escapeHtml(brandName)} Ink Cartridges - Frequently Asked Questions`;

        list.innerHTML = faqs.map(faq => `
            <details class="faq-item">
                <summary class="faq-question">${Security.escapeHtml(faq.question)}</summary>
                <div class="faq-answer">
                    <p>${Security.escapeHtml(faq.answer)}</p>
                </div>
            </details>
        `).join('');

        section.hidden = false;
    },

    /**
     * Build and inject all JSON-LD schemas: CollectionPage, BreadcrumbList, ItemList, FAQPage.
     */
    renderSchemas(slug, brandName, canonicalUrl, description, products, content) {
        const schemas = [];

        // 1. CollectionPage with embedded BreadcrumbList
        schemas.push({
            '@context': 'https://schema.org',
            '@type': 'CollectionPage',
            'name': `${brandName} Ink Cartridges NZ`,
            'description': description,
            'url': canonicalUrl,
            'breadcrumb': {
                '@type': 'BreadcrumbList',
                'itemListElement': [
                    { '@type': 'ListItem', 'position': 1, 'name': 'Home', 'item': 'https://www.inkcartridges.co.nz' },
                    { '@type': 'ListItem', 'position': 2, 'name': `${brandName} Ink Cartridges`, 'item': canonicalUrl }
                ]
            }
        });

        // 2. ItemList with first 10 products
        if (products.length > 0) {
            const itemListElements = products.slice(0, 10).map((p, i) => {
                const productUrl = p.slug
                    ? `https://www.inkcartridges.co.nz/products/${p.slug}/${p.sku}`
                    : `https://www.inkcartridges.co.nz/html/product/?sku=${p.sku}`;
                return {
                    '@type': 'ListItem',
                    'position': i + 1,
                    'name': p.name,
                    'url': productUrl
                };
            });

            schemas.push({
                '@context': 'https://schema.org',
                '@type': 'ItemList',
                'name': `${brandName} Ink Cartridges`,
                'numberOfItems': products.length,
                'itemListElement': itemListElements
            });
        }

        // 3. FAQPage
        if (content && content.faqs && content.faqs.length > 0) {
            schemas.push({
                '@context': 'https://schema.org',
                '@type': 'FAQPage',
                'mainEntity': content.faqs.map(faq => ({
                    '@type': 'Question',
                    'name': faq.question,
                    'acceptedAnswer': {
                        '@type': 'Answer',
                        'text': faq.answer
                    }
                }))
            });
        }

        // Replace existing schema element with combined schemas
        const schemaEl = document.getElementById('page-schema');
        if (schemaEl) {
            schemaEl.textContent = JSON.stringify(schemas);
        }
    },

    showError(message) {
        document.getElementById('products-loading').hidden = true;
        const errEl = document.getElementById('products-error');
        errEl.querySelector('p').textContent = message;
        errEl.hidden = false;
    }
};

document.addEventListener('DOMContentLoaded', () => BrandsPage.init());
