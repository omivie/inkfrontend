// Mobile layout audit. Visits key pages on two iPhone viewports,
// opens interactive elements, and flags overflow + saves screenshots.
const { chromium, devices } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE || 'http://localhost:3000';
const OUT = path.resolve(__dirname, '../audit-output');
fs.mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: 'iphone-se', width: 375, height: 667, dpr: 2 },
  { name: 'iphone-14-pm', width: 430, height: 932, dpr: 3 },
];

const PAGES = [
  { name: 'home', url: '/', flow: 'inkfinder' },
  { name: 'shop', url: '/html/shop.html' },
  { name: 'cart', url: '/html/cart.html' },
  { name: 'checkout', url: '/html/checkout.html' },
  { name: 'contact', url: '/html/contact.html' },
  { name: 'ribbons', url: '/html/ribbons.html' },
  { name: '404', url: '/html/404.html' },
  { name: 'brands', url: '/html/brands/index.html' },
  { name: 'terms', url: '/html/terms.html' },
  { name: 'privacy', url: '/html/privacy.html' },
  { name: 'returns', url: '/html/returns.html' },
  { name: 'payment', url: '/html/payment.html' },
  { name: 'account-login', url: '/html/account/login.html' },
  { name: 'account-forgot', url: '/html/account/forgot-password.html' },
  { name: 'account-track', url: '/html/account/track-order.html' },
  { name: 'product', url: '/html/product/index.html?slug=brother-lc3319xl-black' },
];

// Interactions to try on each page; silently skip if selector missing.
const INTERACTIONS = [
  { name: 'nav-toggle', selector: '.nav-toggle' },
  { name: 'mega-menu', selector: '.nav-mega-toggle' },
  { name: 'ink-finder-brand', selector: '.ink-finder__brand-card' },
  { name: 'ink-finder-series', selector: '#ink-finder-series-trigger' },
  { name: 'ink-finder-model', selector: '#ink-finder-model-trigger' },
  { name: 'search-focus', selector: '.search-form--nav .search-form__input', action: 'focus' },
  { name: 'cart-icon', selector: '.header-cart, .cart-icon, [data-testid="cart-icon"]' },
  { name: 'account-icon', selector: '.header-account, [data-testid="account-icon"]' },
];

async function findOverflow(page, vw) {
  // Any element whose bounding box extends beyond the viewport width.
  return await page.evaluate((vw) => {
    const hits = [];
    const all = document.querySelectorAll('body *');
    for (const el of all) {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.right > vw + 1 || r.left < -1) {
        hits.push({
          tag: el.tagName.toLowerCase(),
          id: el.id || null,
          cls: (el.className && typeof el.className === 'string') ? el.className.slice(0, 80) : null,
          left: Math.round(r.left),
          right: Math.round(r.right),
          width: Math.round(r.width),
        });
      }
    }
    // Dedupe nearly-identical by class
    const seen = new Set();
    return hits.filter(h => {
      const k = `${h.tag}.${h.cls}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, 25);
  }, vw);
}

async function audit() {
  const browser = await chromium.launch();
  const report = [];

  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: vp.dpr,
      isMobile: true,
      hasTouch: true,
      userAgent: devices['iPhone 13'].userAgent,
    });
    const page = await ctx.newPage();

    for (const p of PAGES) {
      const entry = { viewport: vp.name, page: p.name, url: p.url, overflow: [], interactions: {} };
      try {
        await page.goto(BASE + p.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
      } catch (e) {
        entry.error = e.message;
        report.push(entry);
        continue;
      }
      await page.waitForTimeout(500);

      // Baseline screenshot + overflow
      await page.screenshot({ path: `${OUT}/${vp.name}_${p.name}_baseline.png`, fullPage: false });
      entry.overflow = await findOverflow(page, vp.width);

      // Page-specific multi-step flows
      if (p.flow === 'inkfinder') {
        try {
          // Scroll ink finder into view
          await page.click('a[href="#ink-finder-heading"]', { timeout: 2000 });
          await page.waitForTimeout(600);
          await page.screenshot({ path: `${OUT}/${vp.name}_${p.name}_finder-opened.png` });
          entry.interactions['finder-opened'] = { overflow: await findOverflow(page, vp.width) };

          // Pick a brand
          await page.click('.ink-finder__brand-btn[data-brand="canon"]', { timeout: 2000 });
          await page.waitForTimeout(800);
          await page.screenshot({ path: `${OUT}/${vp.name}_${p.name}_finder-brand.png` });
          entry.interactions['finder-brand'] = { overflow: await findOverflow(page, vp.width) };

          // Open series dropdown
          await page.click('#ink-finder-series-trigger', { timeout: 2000 });
          await page.waitForTimeout(500);
          await page.screenshot({ path: `${OUT}/${vp.name}_${p.name}_finder-series-open.png` });
          entry.interactions['finder-series-open'] = { overflow: await findOverflow(page, vp.width) };

          // Pick first series option
          await page.click('#ink-finder-series-dropdown .custom-select__option', { timeout: 2000 });
          await page.waitForTimeout(600);

          // Open model dropdown
          await page.click('#ink-finder-model-trigger', { timeout: 2000 });
          await page.waitForTimeout(500);
          await page.screenshot({ path: `${OUT}/${vp.name}_${p.name}_finder-model-open.png` });
          entry.interactions['finder-model-open'] = { overflow: await findOverflow(page, vp.width) };

          // Dismiss
          await page.mouse.click(2, 2);
          await page.waitForTimeout(200);
        } catch (e) {
          entry.interactions['flow-error'] = { error: e.message.slice(0, 160) };
        }
      }

      // Try interactions
      for (const act of INTERACTIONS) {
        try {
          const el = await page.$(act.selector);
          if (!el) continue;
          if (act.action === 'focus') await el.focus();
          else await el.click({ timeout: 1500 });
          await page.waitForTimeout(400);
          await page.screenshot({ path: `${OUT}/${vp.name}_${p.name}_${act.name}.png`, fullPage: false });
          const overflow = await findOverflow(page, vp.width);
          entry.interactions[act.name] = { overflow };
          // Dismiss by clicking top-left
          await page.mouse.click(2, 2);
          await page.waitForTimeout(200);
        } catch (e) {
          entry.interactions[act.name] = { error: e.message.slice(0, 120) };
        }
      }
      report.push(entry);
    }
    await ctx.close();
  }
  await browser.close();

  fs.writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2));

  // Console summary
  for (const r of report) {
    const baseCount = r.overflow?.length || 0;
    const interCounts = Object.entries(r.interactions || {})
      .map(([k, v]) => `${k}:${v.overflow?.length ?? (v.error ? 'ERR' : 0)}`)
      .join(' ');
    console.log(`[${r.viewport}] ${r.page}: base=${baseCount} ${interCounts}${r.error ? ' ERR:' + r.error : ''}`);
  }
  console.log(`\nReport: ${OUT}/report.json`);
}

audit().catch(e => { console.error(e); process.exit(1); });
