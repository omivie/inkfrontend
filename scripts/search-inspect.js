const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 430, height: 932 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  await p.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(500);
  const info = await p.evaluate(() => {
    const f = document.querySelector('.search-form--nav');
    const b = f.querySelector('.search-form__button');
    const c = document.querySelector('.primary-nav .container');
    const t = document.querySelector('.nav-toggle');
    const rf = f.getBoundingClientRect(), rb = b.getBoundingClientRect(), rc = c.getBoundingClientRect(), rt = t.getBoundingClientRect();
    return { vp: innerWidth, form: rf, btn: rb, container: rc, toggle: rt };
  });
  console.log(JSON.stringify(info, null, 2));
  await b.close();
})();
