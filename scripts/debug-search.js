const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  await p.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(500);
  await p.click('.search-form--nav .search-form__input');
  await p.waitForTimeout(800);

  // Find all visible elements near the top that contain "RECENT" or "SEARCHES"
  const info = await p.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('body *')) {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const text = (el.innerText || '').slice(0, 40).replace(/\n/g, ' ');
      if (/recent|compatible|popular|brother|canon/i.test(text) && r.top < 400) {
        out.push({
          tag: el.tagName.toLowerCase(),
          id: el.id,
          cls: (el.className||'').toString().slice(0,80),
          top: Math.round(r.top), left: Math.round(r.left),
          w: Math.round(r.width), h: Math.round(r.height),
          pos: s.position,
          zi: s.zIndex,
          text
        });
      }
    }
    // Search input/form info
    const input = document.querySelector('.search-form--nav .search-form__input');
    const form = document.querySelector('.search-form--nav');
    const wrap = document.querySelector('.search-wrapper');
    const nav = document.querySelector('.primary-nav');
    const info = {};
    for (const [name, el] of [['input', input], ['form', form], ['wrap', wrap], ['nav', nav]]) {
      if (!el) { info[name] = null; continue; }
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      info[name] = { top: r.top, left: r.left, w: r.width, h: r.height, pos: s.position, zi: s.zIndex, cls: el.className };
    }
    return { dropdowns: out, info };
  });
  console.log(JSON.stringify(info, null, 2));
  await p.screenshot({ path: 'audit-output/debug-search.png' });
  await b.close();
})();
