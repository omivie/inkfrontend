#!/usr/bin/env python3
"""Red-proof for tests/fe-master-checklist-v2-oct2026.test.js (ERR-309): each mutation puts one
fix back the way it was; the suite must go RED for every one. Files are restored after each run."""
import subprocess, sys
T='tests/fe-master-checklist-v2-oct2026.test.js'
C='inkcartridges/js/cart.js'
P='inkcartridges/js/product-detail-page.js'
M=[
 (C,"        if (!Number.isFinite(stock) || stock < 0) return this.MAX_QUANTITY;\n        return Math.max(1,","        return this.MAX_QUANTITY;\n        return Math.max(1,",'cap ignores stock'),
 (C,"                stock_quantity: (item.product.stock_quantity != null","                stock_dropped: (item.product.stock_quantity != null",'parse drops stock'),
 (C,"const clampedQty = Math.min(quantity, this.maxQuantityFor(item));","const clampedQty = Math.min(quantity, this.MAX_QUANTITY);",'debounce clamps at 100'),
 (C,"const response = await API.updateCartItem(actualId, target);","const response = await API.updateCartItem(actualId, quantity);",'raw quantity sent'),
 (C,"        if (resOrErr.code === 'STOCK_INSUFFICIENT' || (resOrErr instanceof Error && Number.isFinite(available))) {","        if (resOrErr.code === 'STOCK_INSUFFICIENT') {",'legacy thrown refusal not read'),
 (C,"        if (line) line.stock_quantity = available;\n","",'refused stock not kept'),
 (C,"                    const available = this.stockRefusal(error);\n                    if (available !== null) this._applyStockRefusal(itemId, available);\n                    if (!this._quantityQueued","                    const available = null;\n                    if (!this._quantityQueued",'thrown refusal ⇒ Network error'),
 (C,"            && (resOrErr.code === 'RATE_LIMITED' || resOrErr.status === 429);","            && false;",'429 ⇒ Network error'),
 (C,"        if (input) input.max = maxQty;","        if (input) input.max = 100;",'DOM max literal'),
 (C,"' + (item.quantity >= maxQty ? ' disabled' : '') + '","' + (item.quantity >= 100 ? ' disabled' : '') + '",'render + literal'),
 (C,"                    ? { stock_quantity: Number(product.stock_quantity) } : {})","                    ? {} : {})",'local add drops stock'),
 ('inkcartridges/js/business.js',"            const max = Number.isFinite(lineMax) && lineMax >= 1 ? lineMax : maxQuantity;","            const max = maxQuantity;",'nudge ignores line cap'),
 ('inkcartridges/js/utils.js',"        const max = o.stock == null ? ceiling() : capFor(o.stock);","        const max = ceiling();",'card stepper ignores stock'),
 ('inkcartridges/js/utils.js',"        const q = clamp(qty, limitOf(stepper));","        const q = clamp(qty);",'stepper apply ignores cap'),
 ('inkcartridges/js/cart-deep-link.js',"            stock_quantity: product.stock_quantity,\n","",'deep link drops stock'),
 (P,"if (!this._rewardPoints) { line.hidden = true; line.textContent = ''; return; }","if (!this._rewardPoints) return;",'stale points line kept'),
 (P,"reward points (${formatPrice(earn.value)})`;","reward points (${formatPrice(earn.value)}) on this order`;",'long copy back'),
 (P,"if (!info || info.source !== 'genuine' || !Array.isArray","if (!info || !Array.isArray",'box on compatible pages'),
 (P,"            if (RANK[a] && RANK[g] && RANK[a] > RANK[g]) return","            if (RANK[a]) return",'higher claimed blind'),
 (P,"<span class=\"compat-alt__name\">${Security.escapeHtml(name)}</span>","<span class=\"compat-alt__name\">${name}</span>",'name unescaped'),
 (P,"Number(a.retail_price) > 0).slice(0, 3);","Number(a.retail_price) > 0);",'no 3-row cap'),
 (P,"                if (!d || !d.id || typeof Cart === 'undefined') {","                if (false) {",'lookup miss silent'),
 (P,"                    if (result && result.ok === false) {\n                        btn.textContent = 'Add to Cart';","                    if (false) {\n                        btn.textContent = 'Add to Cart';",'refused add says Added'),
 ('inkcartridges/html/product/index.html','                                    <span class="product-info__points" id="product-points-line" data-testid="product-points" hidden></span>\n','','points span removed from price row'),
 ('inkcartridges/js/config.js','cartWallet: true,','cartWallet: false,','wallet off'),
]
ok=True
for f,a,b,label in M:
    src=open(f).read()
    if src.count(a)!=1: print('MUTATION NOT APPLICABLE',label); ok=False; continue
    open(f,'w').write(src.replace(a,b))
    try:
        r=subprocess.run(['node','--test',T],capture_output=True,text=True)
    finally:
        open(f,'w').write(src)
    red='ℹ fail 0' not in r.stdout
    print(('RED  ' if red else 'GREEN!'),label); ok&=red
print("ALL RED" if ok else "SOME MUTATION SURVIVED"); sys.exit(0 if ok else 1)
