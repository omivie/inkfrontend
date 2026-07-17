/**
 * FIT-AUDIT — responsive text-fit / overflow sweep (text-fit audit Jul 2026)
 * ==========================================================================
 * Crawls every public storefront page at six viewport widths and flags
 * content that doesn't fit its box:
 *   h-clip        content wider than an overflow-hidden/clip box (cut text)
 *   h-spill       content wider than an overflow-visible box (spills out)
 *   v-clip        content taller than an overflow-hidden box (no line-clamp)
 *   past-viewport leaf element extending beyond the right viewport edge
 *   page-h-overflow  document wider than the viewport
 *
 * Usage:  npx serve inkcartridges -l 3000   (in another terminal)
 *         npm run audit:fit                  (or: node inkcartridges/scripts/fit-audit.js)
 * Exit code 1 if any real finding survives the skip-list, 0 when clean.
 *
 * Known BY-DESIGN patterns are skipped (see SKIP below):
 *   - .visually-hidden / .skip-link / .sr-only (screen-reader clip pattern)
 *   - .contact-form__hp (1×1px anti-spam honeypot)
 *   - .checkout-progress__step (connector ::after overhangs the li by design)
 *   - .policy-table / .legal-table cells (scroll inside their -wrap by design)
 */
const { chromium } = require('playwright');

const BASE = process.env.FIT_AUDIT_BASE || 'http://localhost:3000';
const PAGES = ['/', '/html/shop.html', '/html/ribbons.html', '/html/about.html', '/html/contact.html',
  '/html/faq.html', '/html/genuine-vs-compatible.html', '/html/privacy.html', '/html/quote.html',
  '/html/returns.html', '/html/shipping.html', '/html/terms.html', '/html/track-order.html',
  '/html/cart.html', '/html/404.html', '/html/account/login.html', '/html/account/forgot-password.html'];
const WIDTHS = [320, 390, 480, 700, 900, 1280];

// matches against the element signature — keep in sync with the BY-DESIGN
// list in the header comment. Table cells (th/td) match by tag, the rest by
// class substring.
const SKIP = ['visually-hidden', 'skip-link', 'sr-only', 'contact-form__hp',
  'checkout-progress__step', 'policy-table', 'legal-table'];
const skip = (sig) => /^t[hd](\.|#|$)/.test(sig) || SKIP.some((s) => sig.includes(s));

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const issues = [];
  for (const p of PAGES) {
    try {
      await page.goto(BASE + p, { waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch (e) { issues.push({ page: p, type: 'nav-fail', el: String(e).slice(0, 80) }); continue; }
    await page.waitForTimeout(1500); // page controllers render content
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w, height: 900 });
      await page.waitForTimeout(450); // fluid clamps transition on resize
      const found = await page.evaluate(() => {
        const out = [];
        const sig = (el) => {
          let s = el.tagName.toLowerCase();
          if (el.id) s += '#' + el.id;
          if (el.className && typeof el.className === 'string') s += '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.');
          return s;
        };
        const dOvf = document.documentElement.scrollWidth - document.documentElement.clientWidth;
        if (dOvf > 1) out.push({ type: 'page-h-overflow', px: dOvf, el: 'html' });
        const seen = new Set();
        // content inside a horizontal scroll container scrolls by design
        const inScroller = (el) => {
          let anc = el.parentElement;
          while (anc && anc !== document.body) {
            const ao = getComputedStyle(anc).overflowX;
            if (ao === 'auto' || ao === 'scroll') return true;
            anc = anc.parentElement;
          }
          return false;
        };
        for (const el of document.querySelectorAll('body *')) {
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          const hOver = el.scrollWidth - el.clientWidth;
          if (hOver > 3 && el.clientWidth > 0 && !inScroller(el)) {
            const ox = cs.overflowX;
            if (ox !== 'auto' && ox !== 'scroll') {
              const s = sig(el);
              if (!seen.has(s + '|h')) {
                seen.add(s + '|h');
                out.push({ type: ox === 'visible' ? 'h-spill' : 'h-clip', px: hOver, el: s, text: (el.textContent || '').trim().slice(0, 40) });
              }
            }
          }
          const vOver = el.scrollHeight - el.clientHeight;
          if (vOver > 6 && (cs.overflowY === 'hidden' || cs.overflowY === 'clip') && cs.webkitLineClamp === 'none' && el.clientHeight > 0) {
            const s = sig(el);
            if (!seen.has(s + '|v')) {
              seen.add(s + '|v');
              out.push({ type: 'v-clip', px: vOver, el: s, text: (el.textContent || '').trim().slice(0, 40) });
            }
          }
          if (r.right > innerWidth + 2 && r.left < innerWidth && el.children.length === 0 && !inScroller(el)) {
            const s = sig(el);
            if (!seen.has(s + '|vp')) {
              seen.add(s + '|vp');
              out.push({ type: 'past-viewport', px: Math.round(r.right - innerWidth), el: s, text: (el.textContent || '').trim().slice(0, 40) });
            }
          }
        }
        return out.slice(0, 30);
      });
      for (const f of found) issues.push({ page: p, w, ...f });
    }
  }
  await browser.close();

  const real = issues.filter((i) => !skip(i.el));
  // aggregate identical findings across widths
  const agg = {};
  for (const i of real) {
    const k = `${i.page}|${i.el}|${i.type}`;
    if (!agg[k]) agg[k] = { page: i.page, el: i.el, type: i.type, text: i.text, widths: [] };
    agg[k].widths.push(`${i.w}:${i.px}px`);
  }
  const rows = Object.values(agg);
  if (rows.length === 0) {
    console.log(`fit-audit: CLEAN — ${PAGES.length} pages × ${WIDTHS.length} widths, 0 real findings (${issues.length - real.length} by-design skips).`);
    process.exit(0);
  }
  console.log(`fit-audit: ${rows.length} finding(s):`);
  for (const r of rows) console.log(` ${r.page} | ${r.type} | ${r.el} | ${r.widths.join(', ')} | ${JSON.stringify(r.text || '')}`);
  process.exit(1);
})();
