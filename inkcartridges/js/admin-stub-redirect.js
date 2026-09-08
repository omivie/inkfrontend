/**
 * Redirect stub admin pages to the main admin dashboard.
 *
 * The destination defaults to `/admin` and can be overridden per page with a
 * `data-target` attribute on the script tag:
 *
 *     <script defer src="/js/admin-stub-redirect.js" data-target="/admin#sync-report"></script>
 *
 * sync-report.html carried its own one-line inline <script> for this until
 * ERR-230 (Sep 2026). `script-src` has no 'unsafe-inline', so that line was
 * refused in production and the page fell through to its <meta http-equiv>
 * refresh — which still worked, and is precisely why nobody noticed. Reusing
 * this file rather than adding a second redirect helper keeps one implementation
 * behind all four stub pages.
 *
 * `document.currentScript` is null inside a deferred script, so the tag is
 * looked up by src instead.
 */

(function () {
    'use strict';
    var tag = document.currentScript
        || document.querySelector('script[src*="admin-stub-redirect.js"]');
    var target = (tag && tag.getAttribute('data-target')) || '/admin';
    window.location.replace(target);
})();
