#!/usr/bin/env bash
#
# RED-PROOF FOR tests/mobile-atc-dead-zone-sep2026.test.js
# ========================================================
#
# A green suite is worth exactly as much as its ability to go red. ERR-258 is
# this repo's record of six guards that could not fail sitting inside a 6088/0
# green run — invisible precisely BECAUSE they were green. ERR-280 is a sharper
# version of the same lesson: the 6532-test suite stayed green through a defect
# that left a first-time guest on a phone with no tappable Add to Cart, because
# every control involved was individually in a defensible state.
#
# So this breaks the fix one way at a time, against a COPY of the tree, and
# asserts the suite notices. It never edits a live file: several Claude sessions
# work in this repo at once, and a peer's sweeping commit can deploy somebody
# else's half-edited file (ERR-270/272).
#
# Usage:  bash scripts/redproof-mobile-atc.sh
# Exit 0 only if EVERY mutation was caught.

set -uo pipefail
cd "$(dirname "$0")/.."

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

pass=0; fail=0

run_case() {
  local label="$1" mutation="$2"

  rm -rf "$WORK/ink"
  mkdir -p "$WORK/ink"
  cp -R inkcartridges/js "$WORK/ink/js"
  cp -R inkcartridges/css "$WORK/ink/css"
  cp -R inkcartridges/html "$WORK/ink/html"

  if ! python3 -c "$mutation" "$WORK/ink"; then
    printf '  \033[33m??\033[0m     %-58s MUTATION DID NOT APPLY\n' "$label"
    fail=$((fail+1)); return
  fi

  if ATC_TEST_ROOT="$WORK/ink" node --test tests/mobile-atc-dead-zone-sep2026.test.js >/dev/null 2>&1; then
    printf '  \033[31mMISSED\033[0m %-58s suite stayed GREEN\n' "$label"
    fail=$((fail+1))
  else
    printf '  \033[32mcaught\033[0m %-58s\n' "$label"
    pass=$((pass+1))
  fi
}

echo "RED-PROOF: breaking the mobile Add-to-Cart fix one way at a time (ERR-280)"
echo

# --- helper used by every mutation -----------------------------------------
H='
import sys,io,os
root=sys.argv[1]
Q=chr(39)          # every mutation below lives inside a single-quoted shell
def q(s): return s.replace(chr(34),Q)   # string, so anchors are written with
                                        # double quotes and swapped to single
def edit(rel,old,new,count=1):
    p=os.path.join(root,rel)
    s=io.open(p,encoding="utf-8").read()
    assert s.count(old)==count, "anchor %r x%d" % (old,s.count(old))
    io.open(p,"w",encoding="utf-8").write(s.replace(old,new))
'

echo "  the handover predicate — js/product-detail-page.js"

run_case "observes the container again, not the button" \
  "$H"'
edit("js/product-detail-page.js",
  q("actionsContainer.querySelector(\".product-info__add-to-cart\")"),
  "actionsContainer")'

run_case "the consent banner inset is dropped" \
  "$H"'
edit("js/product-detail-page.js",
  "rootMargin: `-${observedTop}px 0px -${observedBottom}px 0px`",
  "rootMargin: `-${observedTop}px 0px 0px 0px`")'

run_case "the sticky header inset is dropped" \
  "$H"'
edit("js/product-detail-page.js",
  "rootMargin: `-${observedTop}px 0px -${observedBottom}px 0px`",
  "rootMargin: `0px 0px -${observedBottom}px 0px`")'

run_case "the banner height becomes a constant 148" \
  "$H"'
edit("js/product-detail-page.js",
  "const bottom = cta ? occludedBottomPx() : 0;",
  "const bottom = cta ? 148 : 0;")'

run_case "the header height becomes a constant 56 (--header-h)" \
  "$H"'
edit("js/product-detail-page.js",
  "const top = cta ? occludedTopPx() : 0;",
  "const top = cta ? 56 : 0;")'

run_case "handover reverts to isIntersecting" \
  "$H"'
edit("js/product-detail-page.js",
  "setVisible(entry.intersectionRatio < 1);",
  "setVisible(!entry.isIntersecting);")'

run_case "threshold loses 1, so ratio 1 never fires" \
  "$H"'
edit("js/product-detail-page.js","threshold: [0, 1],","threshold: [0],")'

run_case "aria-hidden stops tracking the visible state" \
  "$H"'
edit("js/product-detail-page.js",
  q("stickyBar.setAttribute(\"aria-hidden\", visible ? \"false\" : \"true\");"),
  q("stickyBar.setAttribute(\"aria-hidden\", \"true\");"))'

run_case "the outerHTML swap is no longer watched" \
  "$H"'
edit("js/product-detail-page.js",
  "new MutationObserver(sync).observe(actionsContainer, { childList: true, subtree: true });",
  "void 0;")'

run_case "the swap is watched for attributes, not children" \
  "$H"'
edit("js/product-detail-page.js",
  "new MutationObserver(sync).observe(actionsContainer, { childList: true, subtree: true });",
  "new MutationObserver(sync).observe(actionsContainer, { attributes: true });")'

run_case "the banner opening/closing is no longer watched" \
  "$H"'
edit("js/product-detail-page.js",
  q("""new MutationObserver(sync).observe(document.body, {
            attributes: true,
            attributeFilter: [\"class\", \"style\"],
        });"""),
  "void 0;")'

run_case "the header collapse is no longer watched" \
  "$H"'
edit("js/product-detail-page.js",
  q("""new MutationObserver(sync).observe(siteHeader, {
                attributes: true,
                attributeFilter: [\"class\", \"style\"],
            });"""),
  "void 0;")'

run_case "a hidden buy box no longer hides the bar" \
  "$H"'
edit("js/product-detail-page.js",
  "if (!cta) { ctaObserver = null; setVisible(false); return; }",
  "if (!cta) { ctaObserver = null; return; }")'

run_case "sync() rebuilds on every mutation (churn guard removed)" \
  "$H"'
edit("js/product-detail-page.js",
  "if (cta === observedCta && top === observedTop && bottom === observedBottom) return;",
  "if (false) return;")'

echo
echo "  the CSS that backs it up"

run_case "ERR-238 lift removed from .sticky-atc" \
  "$H"'
edit("css/components.css",
  """body.has-consent-banner .cart-sticky-bar,
body.has-consent-banner .sticky-atc,
body.has-consent-banner .filter-sort-bar {""",
  """body.has-consent-banner .cart-sticky-bar,
body.has-consent-banner .filter-sort-bar {""")'

run_case "ERR-238 lift becomes a constant" \
  "$H"'
edit("css/components.css",
  "    bottom: var(--consent-banner-height, 0px);\n}",
  "    bottom: 148px;\n}")'

run_case "the hidden bar eats taps again" \
  "$H"'
edit("css/pages.css",
  ".sticky-atc:not(.is-visible) {\n    pointer-events: none;\n}",
  ".sticky-atc:not(.is-visible) {\n    opacity: 1;\n}")'

run_case "the sticky bar is raised over the consent notice" \
  "$H"'
edit("css/pages.css",
  ".sticky-atc {\n    display: none;\n    position: fixed;\n    bottom: 0;\n    left: 0;\n    right: 0;\n    z-index: var(--z-sticky, 100);",
  ".sticky-atc {\n    display: none;\n    position: fixed;\n    bottom: 0;\n    left: 0;\n    right: 0;\n    z-index: 700;")'

echo
echo "  the rewards nudge in flow — js/rewards-nudge.js"

run_case "the card goes back to being a fixed overlay" \
  "$H"'
edit("css/components.css",
  ".rewards-nudge--card {\n    /*",".rewards-nudge--card {\n    position: fixed;\n    /*")'

run_case "z-index: auto removed, so --z-popover comes back" \
  "$H"'
edit("css/components.css","    z-index: auto;\n    width: auto;","    width: auto;")'

run_case "top: auto removed, so --rn-top offsets the card" \
  "$H"'
edit("css/components.css","    top: auto;\n    left: auto;","    left: auto;")'

run_case "the straddling block is no longer descended into first" \
  "$H"'
edit("js/rewards-nudge.js",
  """        if (straddling && depth < 4 && isBlockLevel(straddling)) {
            var inner = searchForFold(straddling, depth + 1);
            if (inner) return inner;
        }
        return firstBelow ? { parent: container, before: firstBelow } : null;""",
  """        if (firstBelow) return { parent: container, before: firstBelow };
        if (straddling && depth < 4 && isBlockLevel(straddling)) {
            var inner = searchForFold(straddling, depth + 1);
            if (inner) return inner;
        }
        return null;""")'

run_case "a grid row is split open to insert into" \
  "$H"'
edit("js/rewards-nudge.js",
  "if (straddling && depth < 4 && isBlockLevel(straddling)) {",
  "if (straddling && depth < 4) {")'

run_case "a short page gets an insertion point it should not have" \
  "$H"'
edit("js/rewards-nudge.js",
  "        return firstBelow ? { parent: container, before: firstBelow } : null;",
  "        return { parent: container, before: firstBelow || container.children[0] };")'

run_case "click-outside deletes the in-flow card again" \
  "$H"'
edit("js/rewards-nudge.js",
  q("        if (state.placedInFlow) return;\n        softClose(\"outside\");"),
  q("        softClose(\"outside\");"))'

run_case "placeInFlow loses its once-guard and walks down the page" \
  "$H"'
edit("js/rewards-nudge.js",
  "        if (state.placedInFlow && el.parentNode && el.parentNode !== document.body) return;",
  "        void 0;")'

run_case "position() pins the card with --rn-top again" \
  "$H"'
edit("js/rewards-nudge.js",
  "            placeInFlow(el);",
  q("            el.style.setProperty(\"--rn-top\", \"72px\");") + "\n            placeInFlow(el);")'

run_case "the desktop popover loses its caret arithmetic" \
  "$H"'
edit("js/rewards-nudge.js","--rn-caret-x","--rn-caret-gone",1)'

echo
echo "────────────────────────────────────────────────────────"
if [ "$fail" -eq 0 ]; then
  printf '\033[32m%d/%d mutations caught.\033[0m Every assertion in the suite can go red.\n' "$pass" "$pass"
  exit 0
fi
printf '\033[31m%d caught, %d MISSED\033[0m — a missed mutation is an assertion that cannot fail.\n' "$pass" "$fail"
exit 1
