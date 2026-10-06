#!/usr/bin/env python3
"""Red-proof for tests/fe-master-checklist-6oct-2026.test.js (ERR-307): each mutation puts one
fix back the way it was; the suite must go RED for every one. Files are restored after each run."""
import subprocess, shutil, sys
T='tests/fe-master-checklist-6oct-2026.test.js'
M=[
 ('inkcartridges/js/cart.js',"if (oldQty !== clampedQty) this._losePricing(PRICING.PENDING);","if (this.serverSummary) { this.serverSummary.subtotal += item.price * (clampedQty - oldQty); }",'retail-delta patch back'),
 ('inkcartridges/js/cart.js',"return best && Number.isFinite(retail) && best.price < retail ? best.price : retail;","return retail;",'unit price = retail'),
 ('inkcartridges/js/cart.js',"if (putCart && this._mutationEpoch !== putEpoch) {","if (putCart && false) {",'no epoch guard'),
 ('inkcartridges/js/cart.js',"            return;\n        }\n        this._armPendingWatchdog();","            return;\n        }\n        return;\n        this._armPendingWatchdog();",'no pending paint'),
 ('inkcartridges/js/cart.js',"        this._armPendingWatchdog();\n        const UPDATING","        const UPDATING",'no watchdog'),
 ('inkcartridges/js/cart.js',"        if (!pv || pv.inflight || !pv.result || pv.epoch !== this._mutationEpoch) return null;","        return null;",'no prevalidation reuse'),
 ('inkcartridges/js/cart.js',"const putCart = this._putResponseCart(response);\n","const putCart = null;\n",'PUT cart ignored'),
 ('inkcartridges/js/checkout-page.js',"if (res.code !== 'VALIDATION_FAILED') return { state: 'unknown' };","return { state: 'unknown' };",'verdict ignored'),
 ('inkcartridges/js/checkout-page.js',"if (typeof Auth !== 'undefined' && Auth.isAuthenticated()) return true;\n            const field","return true;\n            const field",'gate open'),
 ('inkcartridges/js/checkout-page.js',"if (!(await this._emailPassesGate())) {","if (false) {",'gate not called'),
 ('inkcartridges/js/payment-page.js',"                    sessionStorage.setItem('checkoutData', JSON.stringify(Object.assign({}, this.checkoutData, { savedAt: Date.now() })));","",'form not kept'),
 ('inkcartridges/js/payment-page.js',"if (emailDetail) {","if (false) {",'payment branch off'),
]
ok=True
for f,a,b,label in M:
    src=open(f).read()
    if src.count(a)!=1: print('MUTATION NOT APPLICABLE',label); ok=False; continue
    open(f,'w').write(src.replace(a,b))
    r=subprocess.run(['node','--test',T],capture_output=True,text=True)
    open(f,'w').write(src)
    red='ℹ fail 0' not in r.stdout
    print(('RED  ' if red else 'GREEN!'),label); ok&=red
print("ALL RED" if ok else "SOME MUTATION SURVIVED"); sys.exit(0 if ok else 1)
