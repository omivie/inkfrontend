#!/usr/bin/env bash
#
# RED-PROOF FOR tests/uet-tag-sep2026.test.js
# ===========================================
#
# A green suite is worth exactly as much as its ability to go red. ERR-258 is
# this repo's record of six guards that could not fail sitting inside a 6088/0
# green run — every one of them invisible precisely BECAUSE it was green.
#
# So this breaks the UET install one way at a time, against a COPY of the tree,
# and asserts the suite notices. It never edits a live file: several Claude
# sessions work in this repo at once, and a peer's sweeping commit can deploy
# somebody else's half-edited file (ERR-270/272).
#
# Usage:  bash scripts/redproof-uet.sh
# Exit 0 only if EVERY mutation was caught.

set -uo pipefail
cd "$(dirname "$0")/.."

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0; fail=0

# Each case: a label, a python mutation, and the section expected to catch it.
run_case() {
  local label="$1" mutation="$2"

  rm -rf "$WORK/ink"
  mkdir -p "$WORK/ink"
  cp -R inkcartridges/js "$WORK/ink/js"
  cp -R inkcartridges/html "$WORK/ink/html"
  cp inkcartridges/vercel.json "$WORK/ink/vercel.json"
  cp inkcartridges/index.html inkcartridges/404.html "$WORK/ink/" 2>/dev/null || true

  if ! python3 -c "$mutation" "$WORK/ink"; then
    printf '  ?? %-52s MUTATION DID NOT APPLY\n' "$label"
    fail=$((fail+1)); return
  fi

  if UET_TEST_ROOT="$WORK/ink" node --test tests/uet-tag-sep2026.test.js >/dev/null 2>&1; then
    printf '  \033[31mMISSED\033[0m %-48s suite stayed GREEN\n' "$label"
    fail=$((fail+1))
  else
    printf '  \033[32mcaught\033[0m %-48s\n' "$label"
    pass=$((pass+1))
  fi
}

echo "RED-PROOF: breaking the UET install one way at a time"
echo

# --- helper used by every mutation -----------------------------------------
H='
import sys,io,os
root=sys.argv[1]
def edit(rel,old,new,count=1):
    p=os.path.join(root,rel)
    s=io.open(p,encoding="utf-8").read()
    assert s.count(old)==count, "anchor %r x%d" % (old,s.count(old))
    io.open(p,"w",encoding="utf-8").write(s.replace(old,new))
'

run_case "connect-src loses bat.bing.com (the silent half)" \
  "$H"'
edit("vercel.json"," https://*.link.com https://bat.bing.com;"," https://*.link.com;")'

run_case "script-src loses bat.bing.com" \
  "$H"'
edit("vercel.json","https://*.js.stripe.com https://bat.bing.com","https://*.js.stripe.com")'

run_case "CSP swaps a pre-existing host for the new one" \
  "$H"'
edit("vercel.json","https://apis.google.com https://*.js.stripe.com https://bat.bing.com","https://*.js.stripe.com https://bat.bing.com")'

run_case "tag id emptied (ships a tag that does nothing)" \
  "$H"'
edit("js/gtag.js","const UET_TAG_ID = \x279726977Ъ\x27".replace("Ъ","0"),"const UET_TAG_ID = \x27\x27")'

run_case "revenue divided by GST" \
  "$H"'
edit("js/gtag.js","params.revenue_value = total;","params.revenue_value = total / 1.15;")'

run_case "absent total becomes a confident \$0.00" \
  "$H"'
edit("js/gtag.js","const hasValue = hasMoney(total);","const hasValue = true; total = Number(order.total) || 0;")
edit("js/gtag.js","const total = readMoney(order.total);","let total = readMoney(order.total);")'

run_case "purchase moved ABOVE the dedupe latch" \
  "$H"'
import re,io,os
p=os.path.join(root,"js/order-confirmation-page.js")
s=io.open(p,encoding="utf-8").read()
m=re.search(r"\n            if \(typeof UetTag !== .undefined.\) \{\n                UetTag\.purchase\(\{\n.*?\n                \}\);\n            \}\n", s, re.S)
assert m, "could not find the UET call"
blk=m.group(0)
s=s.replace(blk,"")
s=s.replace("            this._conversionFired = true;", blk+"            this._conversionFired = true;",1)
io.open(p,"w",encoding="utf-8").write(s)'

run_case "purchase call removed from the confirmation page" \
  "$H"'
import re,io,os
p=os.path.join(root,"js/order-confirmation-page.js")
s=io.open(p,encoding="utf-8").read()
s2=re.sub(r"\n            if \(typeof UetTag !== .undefined.\) \{\n                UetTag\.purchase\(\{\n.*?\n                \}\);\n            \}\n","\n",s,flags=re.S)
assert s2!=s
io.open(p,"w",encoding="utf-8").write(s2)'

run_case "a UET consent default is declared (ERR-227 shape)" \
  "$H"'
edit("js/gtag.js","    UetTag.init();".strip(),"window.uetq = window.uetq || []; window.uetq.push(\x27consent\x27,\x27default\x27,{ad_storage:\x27denied\x27}); UetTag.init();")'

run_case "UetTag moved BELOW Ga4Ecommerce (into their window)" \
  "$H"'
import io,os
p=os.path.join(root,"js/gtag.js")
s=io.open(p,encoding="utf-8").read()
i=s.index("const UetTag = {"); j=s.index("UetTag.init();")+len("UetTag.init();")
blk=s[i:j]; s=s[:i]+s[j:]
io.open(p,"w",encoding="utf-8").write(s+"\n"+blk+"\n")'

run_case "auto SPA tracking switched on (duplicate pageviews)" \
  "$H"'
edit("js/gtag.js","{ ti: UET_TAG_ID, q: window.uetq }","{ ti: UET_TAG_ID, q: window.uetq, enableAutoSpaTracking: true }")'

run_case "loader made protocol-relative" \
  "$H"'
edit("js/gtag.js","s.src = \x27https://bat.bing.com/bat.js\x27;","s.src = \x27//bat.bing.com/bat.js\x27;")'

# ═══════════════════════════════════════════════════════════════════════════
# THE FUNNEL MIRRORS — one mutation per claim the mirrors make
# ═══════════════════════════════════════════════════════════════════════════

run_case "a mirror re-derives instead of copying (GST)" \
  "$H"'
edit("js/gtag.js","params.revenue_value = value;","params.revenue_value = value / 1.15;")'

run_case "an absent twin value becomes a confident \$0.00" \
  "$H"'
edit("js/gtag.js","const value = source.revenue === true ? readMoney(ga4.value) : NaN;","let value = source.revenue === true ? readMoney(ga4.value) : NaN;")
edit("js/gtag.js","const hasValue = hasMoney(value);","const hasValue = source.revenue === true; value = Number(ga4.value) || 0;")'

run_case "a mirror fires even when the twin refused (two owners)" \
  "$H"'
edit("js/gtag.js","if (!ga4 || ga4.sent !== true) return { sent: false, reason: \x27not-mirrored\x27 };","if (!ga4) return { sent: false, reason: \x27not-mirrored\x27 };")'

run_case "a fifth UET action is smuggled in" \
  "$H"'
edit("js/gtag.js","};\n\nUetTag.init();","    signup() { window.uetq.push(\x27event\x27, \x27signup\x27, {}); },\n};\n\nUetTag.init();")'

run_case "lead() accepts any action the caller names" \
  "$H"'
edit("js/gtag.js","            if (this.LEAD_ACTIONS.indexOf(name) === -1) {\n                return { sent: false, reason: \x27unknown-action\x27 };\n            }\n","")'

run_case "a lead is given revenue" \
  "$H"'
edit("js/gtag.js","const payload = { event_category: \x27lead\x27 };","const payload = { event_category: \x27lead\x27, revenue_value: (params && params.revenue_value) };")'

run_case "view_item starts reporting the price tag as revenue" \
  "$H"'
edit("js/gtag.js","        return this._mirror(\x27view_item\x27, ga4, {\n            event_category: \x27ecommerce\x27,\n            event_label: product && product.sku,\n        });","        return this._mirror(\x27view_item\x27, ga4, {\n            event_category: \x27ecommerce\x27,\n            event_label: product && product.sku,\n            revenue: true,\n        });")'

run_case "the currency stops being NZD" \
  "$H"'
edit("js/gtag.js","    CURRENCY: \x27NZD\x27,\n\n    /* THE ONLY ACTIONS lead","    CURRENCY: \x27usd\x27,\n\n    /* THE ONLY ACTIONS lead")'

run_case "the PDP mirror is no longer handed the twin result" \
  "$H"'
edit("js/product-detail-page.js","UetTag.viewItem(this.product, ga4);","UetTag.viewItem(this.product, { sent: true });")'

run_case "the add_to_cart mirror is hoisted above the serverConfirmed gate" \
  "$H"'
import re,io,os
p=os.path.join(root,"js/cart.js")
s=io.open(p,encoding="utf-8").read()
m=re.search(r"\n            if \(typeof UetTag !== .undefined.\) \{\n                UetTag\.addToCart\([^\n]*\n            \}\n", s)
assert m, "could not find the add_to_cart mirror"
blk=m.group(0)
s=s.replace(blk,"\n")
s=s.replace("        if (serverConfirmed && typeof Ga4Ecommerce !== \x27undefined\x27) {", blk.replace("\n            ","\n        ")+"        if (serverConfirmed && typeof Ga4Ecommerce !== \x27undefined\x27) {",1)
io.open(p,"w",encoding="utf-8").write(s)'

run_case "the quote lead moves from markStarted() into track()" \
  "$H"'
import re,io,os
p=os.path.join(root,"js/quote-page.js")
s=io.open(p,encoding="utf-8").read()
m=re.search(r"\n        if \(typeof UetTag !== .undefined.\) \{\n            UetTag\.lead\(.quote_started.\);\n        \}\n", s)
assert m, "could not find the quote lead"
s=s.replace(m.group(0),"\n")
s=s.replace("        try { if (typeof gtag === \x27function\x27) gtag(\x27event\x27, eventName, params || {}); } catch (_) { /* ignore */ }",
            "        try { if (typeof gtag === \x27function\x27) gtag(\x27event\x27, eventName, params || {}); } catch (_) { /* ignore */ }\n        if (typeof UetTag !== \x27undefined\x27) { UetTag.lead(\x27quote_started\x27); }",1)
io.open(p,"w",encoding="utf-8").write(s)'

run_case "the contact lead also fires on the catch branch" \
  "$H"'
edit("js/contact-page.js","        }).catch(function (err) {","        }).catch(function (err) {\n            if (typeof UetTag !== \x27undefined\x27) { UetTag.lead(\x27contact_form_submit\x27); }")'

run_case "a trailing // comment smuggles gtag( into the UET module" \
  "$H"'
edit("js/gtag.js","    CURRENCY: \x27NZD\x27,\n\n    /* THE ONLY ACTIONS lead","    CURRENCY: \x27NZD\x27, // unlike gtag( above\n\n    /* THE ONLY ACTIONS lead")'

run_case "a page keeps its controller but loses gtag.js" \
  "$H"'
import re,io,os
p=os.path.join(root,"html/contact.html")
s=io.open(p,encoding="utf-8").read()
s2=re.sub(r"\n[^\n]*src=\"/js/gtag\.js[^\n]*\n","\n",s,count=1)
assert s2!=s, "gtag.js script tag not found in contact.html"
io.open(p,"w",encoding="utf-8").write(s2)'

echo
echo "  caught $pass / $((pass+fail))"
if [ "$fail" -ne 0 ]; then
  echo "  $fail mutation(s) went unnoticed — those assertions cannot fail and are decoration."
  exit 1
fi
echo "  every mutation was caught: the suite can go red."
