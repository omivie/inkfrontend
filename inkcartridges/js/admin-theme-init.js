/**
 * Admin theme initializer — must run synchronously in <head> to prevent FOUC
 */
(function(){
    var t = localStorage.getItem('admin-theme') || 'dark';
    document.documentElement.setAttribute('data-theme', t);
})();
