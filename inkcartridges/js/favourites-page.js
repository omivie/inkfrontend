    // Initialize favourites page
    document.addEventListener('DOMContentLoaded', async () => {
        // Wait for Auth to initialize
        if (typeof Auth !== 'undefined' && !Auth.initialized) {
            const maxWait = 3000;
            let waited = 0;
            while (!Auth.initialized && waited < maxWait) {
                await new Promise(r => setTimeout(r, 50));
                waited += 50;
            }
        }

        // Redirect to login if not authenticated
        if (typeof Auth === 'undefined' || !Auth.isAuthenticated()) {
            window.location.href = '/account/login?redirect=' + encodeURIComponent(window.location.pathname);
            return;
        }

        // Reveal account page content (hidden by CSS until auth confirmed)
        const accountEl = document.querySelector('.account-page');
        if (accountEl) accountEl.classList.add('auth-ready');

        if (typeof Favourites !== 'undefined') {
            Favourites.renderFavouritesPage();
        }
    });
