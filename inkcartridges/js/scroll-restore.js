/**
 * Scroll-restoration guard — runs before first layout.
 *
 * WAS AN INLINE <script> IN index.html UNTIL ERR-230 (Sep 2026), AND IT HAD NOT
 * RUN IN PRODUCTION FOR MONTHS. `script-src` in vercel.json carries no
 * 'unsafe-inline' and two sha256 hashes, neither of which matched this block, so
 * the browser refused it on every homepage load. The symptom was small enough to
 * live with unnoticed — a reload landing at the previous scroll position instead
 * of the top — which is exactly why it survived: a refused inline script logs to
 * the console and nowhere else.
 *
 * Externalised rather than hash-allowlisted. A hash has to be recomputed on every
 * byte change and nothing in the build enforces it; the CSP was already carrying
 * a stale 'sha256-0Jmm…' matching no file in the tree. `script-src 'self'` covers
 * /js/ permanently.
 *
 * NO `defer`, NO `async`, and it stays in <head>. Deferred scripts run after the
 * document is parsed, which is after layout — by then history.scrollRestoration
 * has already been applied by the browser and the page has jumped. This must be
 * parser-blocking, in document order, exactly where the inline block was.
 * Pinned by tests/public-surface-sep2026.test.js.
 */

'use strict';

// Disable browser scroll restoration before layout runs, so reloads
// always land at the top instead of the user's previous scroll position.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
if (location.hash === '#ink-finder-heading') {
    history.replaceState(null, '', location.pathname + location.search);
}
