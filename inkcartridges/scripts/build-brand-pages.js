#!/usr/bin/env node
/**
 * BUILD-BRAND-PAGES.JS
 * ====================
 * Vanilla-JS equivalent of Next.js ISR for brand landing pages.
 *
 * At build time:
 *   1. GET /api/landing-pages/index  → list of brands w/ category counts
 *   2. For each brand, GET /api/brand-hubs/:slug
 *   3. Render a fully-baked static HTML page to brand/<slug>/index.html
 *
 * Vercel serves these as static HTML straight from the CDN. To refresh
 * after the daily backend import, the backend cron pings a Vercel deploy
 * hook (see scripts/README-deploy-hook.md) which re-runs this script.
 *
 * Failure policy:
 *   - Index endpoint failure  → fail the build (catastrophic; deploy aborts)
 *   - Per-brand-hub failure   → skip that brand and continue (warn loudly)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'brand');
const API_BASE = process.env.API_URL || 'https://ink-backend-zaeq.onrender.com';
const SUPABASE_PUBLIC = 'https://lmdlgldjgcanknsjrcxh.supabase.co/storage/v1/object/public/public-assets';
const SITE_BASE = 'https://www.inkcartridges.co.nz';
const FEATURED_LIMIT = 12;

// ---------- helpers ----------

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeAttr(s) {
    return escapeHtml(s);
}

function formatPrice(n) {
    const v = Number(n);
    if (!isFinite(v)) return '';
    return new Intl.NumberFormat('en-NZ', {
        style: 'currency',
        currency: 'NZD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(v);
}

function storageUrl(rel) {
    if (!rel) return '/assets/images/placeholder-product.svg';
    if (/^https?:\/\//i.test(rel)) return rel;
    return `${SUPABASE_PUBLIC}/${rel.replace(/^\/+/, '')}`;
}

function productHref(p) {
    if (p.url) {
        try {
            return new URL(p.url).pathname;
        } catch {
            // fall through
        }
    }
    if (p.slug && p.sku) return `/products/${p.slug}/${p.sku}`;
    if (p.sku) return `/html/product?sku=${encodeURIComponent(p.sku)}`;
    return '#';
}

async function fetchJson(url) {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${url}`);
    const body = await res.json();
    if (body && body.ok === false) throw new Error(`API ok=false from ${url}: ${body.error || ''}`);
    return body;
}

// ---------- rendering ----------

function renderCategoryTiles(brandSlug, categories) {
    if (!Array.isArray(categories) || categories.length === 0) return '';
    return categories
        .filter((c) => c && c.type && c.label && c.count)
        .map((c) => {
            const shopCategory = String(c.type).split('_')[0]; // toner_cartridge → toner, ink_cartridge → ink
            const href = `/html/shop?brand=${encodeURIComponent(brandSlug)}&category=${encodeURIComponent(shopCategory)}`;
            return `
                <a href="${escapeAttr(href)}" class="brand-hub__category">
                    <span class="brand-hub__category-label">${escapeHtml(c.label)}</span>
                    <span class="brand-hub__category-count">${c.count} product${c.count === 1 ? '' : 's'}</span>
                </a>`;
        })
        .join('');
}

function renderFeaturedProducts(products) {
    if (!Array.isArray(products) || products.length === 0) return '';
    return products
        .slice(0, FEATURED_LIMIT)
        .map((p) => {
            const href = productHref(p);
            const img = storageUrl(p.image_url);
            const alt = p.alt_tag || p.name || '';
            const price = p.retail_price != null ? formatPrice(p.retail_price) : '';
            const sourceTag = p.source === 'genuine'
                ? '<span class="product-card__tag product-card__tag--genuine">Genuine</span>'
                : p.source === 'compatible'
                    ? '<span class="product-card__tag product-card__tag--compatible">Compatible</span>'
                    : '';
            return `
                <a href="${escapeAttr(href)}" class="product-card">
                    <div class="product-card__image-wrapper">
                        <img src="${escapeAttr(img)}" alt="${escapeAttr(alt)}" loading="lazy" data-fallback="placeholder">
                        ${sourceTag}
                    </div>
                    <div class="product-card__info">
                        <h3 class="product-card__name">${escapeHtml(p.name || '')}</h3>
                        ${price ? `<span class="product-card__price">${escapeHtml(price)}</span>` : ''}
                    </div>
                </a>`;
        })
        .join('');
}

function renderJsonLd(hub) {
    const { brand, stats, featured } = hub;
    const itemList = (featured || []).slice(0, FEATURED_LIMIT).map((p, i) => ({
        '@type': 'ListItem',
        position: i + 1,
        url: p.url || `${SITE_BASE}${productHref(p)}`,
        name: p.name,
    }));

    const blocks = [
        {
            '@context': 'https://schema.org',
            '@type': 'BreadcrumbList',
            itemListElement: [
                { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE_BASE}/` },
                { '@type': 'ListItem', position: 2, name: 'Brands', item: `${SITE_BASE}/html/brands/` },
                { '@type': 'ListItem', position: 3, name: brand.name, item: `${SITE_BASE}/brand/${brand.slug}` },
            ],
        },
        {
            '@context': 'https://schema.org',
            '@type': 'Brand',
            name: brand.name,
            url: `${SITE_BASE}/brand/${brand.slug}`,
            ...(brand.logo_path ? { logo: storageUrl(brand.logo_path) } : {}),
        },
        ...(itemList.length
            ? [{
                '@context': 'https://schema.org',
                '@type': 'ItemList',
                name: `${brand.name} featured products`,
                numberOfItems: stats?.totalProducts || itemList.length,
                itemListElement: itemList,
            }]
            : []),
    ];

    return blocks
        .map((b) => `<script type="application/ld+json">${JSON.stringify(b)}</script>`)
        .join('\n    ');
}

function renderBrandPage(hub) {
    const { brand, stats, categories, featured } = hub;
    const brandName = brand.name;
    const brandSlug = brand.slug;
    const logoSrc = brand.logo_path ? storageUrl(brand.logo_path) : null;
    const totalProducts = stats?.totalProducts || 0;
    const genuineCount = stats?.genuineCount || 0;
    const compatibleCount = stats?.compatibleCount || 0;

    const title = `${brandName} Ink Cartridges & Toner | InkCartridges.co.nz`;
    const description = `Shop ${totalProducts} ${brandName} ink cartridges, toner, drums and accessories. Genuine and compatible options with fast NZ delivery.`;
    const canonical = `${SITE_BASE}/brand/${brandSlug}`;

    return `<!DOCTYPE html>
<html lang="en-NZ">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
    <meta name="description" content="${escapeAttr(description)}">
    <meta name="robots" content="index, follow">

    <link rel="canonical" href="${escapeAttr(canonical)}">
    <meta property="og:type" content="website">
    <meta property="og:site_name" content="InkCartridges.co.nz">
    <meta property="og:title" content="${escapeAttr(title)}">
    <meta property="og:description" content="${escapeAttr(description)}">
    <meta property="og:url" content="${escapeAttr(canonical)}">
    <meta property="og:image" content="${escapeAttr(logoSrc || `${SITE_BASE}/assets/images/logo.png`)}">

    <link rel="icon" type="image/png" href="/favicon.png">
    <link rel="apple-touch-icon" href="/apple-touch-icon.png">
    <title>${escapeHtml(title)}</title>

    ${renderJsonLd(hub)}

    <script async src="https://www.googletagmanager.com/gtag/js?id=G-SDQELG0FGD"></script>
    <script src="/js/gtag.js"></script>

    <link rel="preconnect" href="https://ink-backend-zaeq.onrender.com">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link rel="stylesheet" href="/css/base.css">
    <link rel="stylesheet" href="/css/layout.css">
    <link rel="stylesheet" href="/css/components.css">
    <link rel="stylesheet" href="/css/modern-effects.css">
    <link rel="stylesheet" href="/css/pages.css">
    <link rel="stylesheet" href="/css/search.css">
    <link rel="stylesheet" href="/css/brand-hub.css">
</head>
<body>
    <a href="#main-content" class="skip-link">Skip to main content</a>

    <header class="site-header">
        <div class="header-main">
            <div class="container">
                <div class="header-contact">
                    <a href="tel:0274740115" class="header-contact__item">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                        027 474 0115
                    </a>
                    <a href="mailto:inkandtoner@windowslive.com" class="header-contact__item">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
                        inkandtoner@windowslive.com
                    </a>
                </div>

                <div class="logo-block">
                    <a href="/" class="logo" aria-label="InkCartridges.co.nz Home">
                        <span class="logo__text">Ink<span>Cartridges</span>.co.nz</span>
                    </a>
                    <a href="/" class="logo__tagline">Get the full picture on image quality</a>
                </div>

                <div class="header-actions">
                    <a href="/html/account/index.html" class="header-actions__item">
                        <span class="header-actions__icon">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                        </span>
                        <span>Account</span>
                    </a>
                    <a href="/html/account/favourites.html" class="header-actions__item">
                        <span class="header-actions__icon">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
                        </span>
                        <span>Favourites</span>
                    </a>
                    <a href="/html/cart.html" class="header-actions__item">
                        <span class="header-actions__icon">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>
                            <span class="cart-badge" id="cart-count">0</span>
                        </span>
                        <span>Cart</span>
                    </a>
                </div>
            </div>
        </div>

        <nav class="primary-nav" aria-label="Main navigation">
            <div class="container">
                <button class="nav-toggle" aria-expanded="false" aria-controls="nav-menu">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
                    <span class="visually-hidden">Menu</span>
                </button>

                <ul id="nav-menu" class="nav-menu">
                    <li class="nav-menu__item"><a href="/" class="nav-menu__link">Home</a></li>
                    <li class="nav-menu__item"><a href="/html/shop.html" class="nav-menu__link">Shop</a></li>
                    <li class="nav-menu__item"><a href="/?scroll=ink-finder" class="nav-menu__link">Printer Models</a></li>
                    <li class="nav-menu__item nav-menu__item--mega">
                        <button class="nav-menu__link nav-mega-toggle" type="button"
                                aria-haspopup="true" aria-expanded="false" aria-controls="brands-mega">
                            Cartridge Brands
                            <svg class="nav-menu__arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
                        </button>
                    </li>
                    <li class="nav-menu__item nav-menu__item--mega"><button class="nav-menu__link nav-ribbons-toggle" type="button" aria-haspopup="true" aria-expanded="false" aria-controls="ribbons-mega">Typewriter and Printer Ribbons <svg class="nav-menu__arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg></button></li>
                </ul>

                <form class="search-form search-form--nav" action="/html/shop.html" method="GET" role="search">
                    <label for="search-input" class="visually-hidden">Search for products</label>
                    <input type="search" id="search-input" name="q" class="search-form__input" placeholder="Search..." autocomplete="off" maxlength="200">
                    <button type="submit" class="search-form__button" aria-label="Search">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
                    </button>
                </form>
            </div>
        </nav>

        <div class="brands-mega" id="brands-mega" hidden role="region" aria-label="Browse brands">
            <div class="container">
                <div class="brands-mega__cards"></div>
                <a href="/html/shop.html" class="brands-mega__view-all">View All Brands</a>
            </div>
        </div>

        <div class="ribbons-mega" id="ribbons-mega" hidden role="region" aria-label="Browse ribbon brands">
            <div class="container">
                <div class="ribbons-mega__grid"></div>
                <a href="/html/ribbons.html" class="ribbons-mega__view-all">View All Ribbons</a>
            </div>
        </div>
    </header>

    <main id="main-content" class="site-main">
        <nav class="breadcrumb" aria-label="Breadcrumb">
            <div class="container">
                <ol class="breadcrumb__list">
                    <li class="breadcrumb__item"><a href="/">Home</a></li>
                    <li class="breadcrumb__item"><a href="/html/brands/">Brands</a></li>
                    <li class="breadcrumb__item breadcrumb__item--current" aria-current="page">${escapeHtml(brandName)}</li>
                </ol>
            </div>
        </nav>

        <section class="brand-hub-hero">
            <div class="container">
                <div class="brand-hub-hero__inner">
                    ${logoSrc ? `<img class="brand-hub-hero__logo" src="${escapeAttr(logoSrc)}" alt="${escapeAttr(brandName)} logo" width="160" height="80" loading="eager">` : ''}
                    <h1 class="brand-hub-hero__title">${escapeHtml(brandName)} Ink, Toner &amp; Accessories</h1>
                    <p class="brand-hub-hero__tagline">Shop our full range of ${escapeHtml(brandName)} consumables. Genuine OEM and quality compatible options, with fast NZ delivery.</p>
                    <div class="brand-hub-hero__stats">
                        <div class="brand-hub-stat">
                            <div class="brand-hub-stat__value">${totalProducts}</div>
                            <div class="brand-hub-stat__label">Total products</div>
                        </div>
                        <div class="brand-hub-stat">
                            <div class="brand-hub-stat__value">${genuineCount}</div>
                            <div class="brand-hub-stat__label">Genuine</div>
                        </div>
                        <div class="brand-hub-stat">
                            <div class="brand-hub-stat__value">${compatibleCount}</div>
                            <div class="brand-hub-stat__label">Compatible</div>
                        </div>
                    </div>
                    <a href="/html/shop?brand=${encodeURIComponent(brandSlug)}" class="brand-hub-hero__cta">Shop all ${escapeHtml(brandName)} products</a>
                </div>
            </div>
        </section>

        ${categories && categories.length ? `
        <section class="brand-hub-categories">
            <div class="container">
                <h2 class="brand-hub__section-title">Browse by category</h2>
                <div class="brand-hub__categories-grid">
                    ${renderCategoryTiles(brandSlug, categories)}
                </div>
            </div>
        </section>` : ''}

        ${featured && featured.length ? `
        <section class="brand-hub-products">
            <div class="container">
                <h2 class="brand-hub__section-title">Featured ${escapeHtml(brandName)} products</h2>
                <div class="product-grid">
                    ${renderFeaturedProducts(featured)}
                </div>
                <div class="brand-hub__view-all">
                    <a href="/html/shop?brand=${encodeURIComponent(brandSlug)}" class="brand-hub__view-all-link">View all ${totalProducts} ${escapeHtml(brandName)} products &rarr;</a>
                </div>
            </div>
        </section>` : ''}
    </main>

    <footer class="site-footer"><noscript><p>InkCartridges.co.nz &mdash; Phone: <a href="tel:0274740115">027 474 0115</a> &mdash; Email: inkandtoner@windowslive.com &mdash; 37A Archibald Road, Kelston, Auckland 0602, NZ</p></noscript></footer>

    <script defer src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.98.0" integrity="sha384-Sm2s7OXxsAMTyJ4iIyRBgVpeGUvMPk2lRQnnZhE78Wej7oggIoolKt+SCt0XJbUB" crossorigin="anonymous"></script>
    <script defer src="/js/config.js"></script>
    <script defer src="/js/security.js"></script>
    <script defer src="/js/api.js"></script>
    <script defer src="/js/utils.js"></script>
    <script defer src="/js/auth.js"></script>
    <script defer src="/js/cart.js"></script>
    <script defer src="/js/products.js"></script>
    <script defer src="/js/search-normalize.js"></script>
    <script defer src="/js/search.js"></script>
    <script defer src="/js/main.js"></script>
    <script defer src="/js/footer.js"></script>
    <script defer src="/js/mega-nav.js"></script>
    <script defer src="/js/modern-effects.js"></script>
    <script defer src="/js/site-guard.js"></script>
</body>
</html>
`;
}

// ---------- main ----------

async function main() {
    const startedAt = Date.now();
    console.log(`[build-brand-pages] API_BASE=${API_BASE}`);

    let indexBody;
    try {
        indexBody = await fetchJson(`${API_BASE}/api/landing-pages/index`);
    } catch (err) {
        console.error(`[build-brand-pages] FATAL: failed to fetch index — ${err.message}`);
        process.exit(1);
    }

    const brands = (indexBody.data || []).map((row) => row.brand).filter((b) => b && b.slug);
    if (brands.length === 0) {
        console.error('[build-brand-pages] FATAL: index returned 0 brands');
        process.exit(1);
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });

    let written = 0;
    let skipped = 0;

    for (const brand of brands) {
        try {
            const hubBody = await fetchJson(`${API_BASE}/api/brand-hubs/${encodeURIComponent(brand.slug)}`);
            const hub = hubBody.data;
            if (!hub || !hub.brand) throw new Error('hub.data.brand missing');

            const html = renderBrandPage(hub);
            const dir = path.join(OUT_DIR, brand.slug);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'index.html'), html);
            written++;
        } catch (err) {
            console.warn(`[build-brand-pages] SKIP ${brand.slug}: ${err.message}`);
            skipped++;
        }
    }

    const ms = Date.now() - startedAt;
    console.log(`[build-brand-pages] Wrote ${written} brand page(s), skipped ${skipped}, in ${ms}ms.`);
}

main().catch((err) => {
    console.error('[build-brand-pages] UNCAUGHT:', err);
    process.exit(1);
});
