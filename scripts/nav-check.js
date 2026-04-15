const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  for (const vp of [{name:'se', w:375, h:667}, {name:'14pm', w:430, h:932}]) {
    const ctx = await b.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const p = await ctx.newPage();
    await p.goto('http://localhost:3000/', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(500);
    await p.screenshot({ path: `audit-output/nav-${vp.name}.png`, fullPage: false, clip: { x:0, y:0, width:vp.w, height:180 } });
    await ctx.close();
  }
  await b.close();
})();
