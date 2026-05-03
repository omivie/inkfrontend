/**
 * AUTH-REDIRECT.JS
 * ================
 * Auth callback handler for the root index.html
 * Routes auth callbacks (password reset, signup, magiclink) to appropriate pages.
 */
(function() {
    var hashParams = new URLSearchParams(window.location.hash.substring(1));

    if (hashParams.get('access_token') || hashParams.get('type')) {
        var type = hashParams.get('type');

        if (type === 'recovery') {
            window.location.href = '/account/reset-password' + window.location.hash;
        } else {
            window.location.href = '/account/login' + window.location.hash;
        }
    } else {
        window.location.href = '/';
    }
})();
