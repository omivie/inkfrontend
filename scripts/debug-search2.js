const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  await p.goto('http://localhost:3000/html/shop.html', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(500);
  await p.click('.search-form--nav .search-form__input');
  await p.type('.search-form--nav .search-form__input', 'brother', { delay: 40 });
  await p.waitForTimeout(1500);
  await p.screenshot({ path: 'audit-output/debug-search-results.png', fullPage: false });
  const info = await p.evaluate(() => {
    const d = document.querySelector('.smart-ac-dropdown');
    if (!d) return null;
    const r = d.getBoundingClientRect();
    const s = getComputedStyle(d);
    return { top: r.top, left: r.left, right: r.right, w: r.width, pos: s.position };
  });
  console.log(info);
  await b.close();
})();
