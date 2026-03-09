        // Wait for Auth, then reveal page
        document.addEventListener('DOMContentLoaded', async () => {
            if (typeof Auth !== 'undefined' && !Auth.initialized) {
                const maxWait = 3000;
                let waited = 0;
                while (!Auth.initialized && waited < maxWait) {
                    await new Promise(r => setTimeout(r, 50));
                    waited += 50;
                }
            }

            if (typeof Auth === 'undefined' || !Auth.isAuthenticated()) {
                window.location.href = '/html/account/login.html?redirect=' + encodeURIComponent(window.location.pathname);
                return;
            }

            const accountEl = document.querySelector('.account-page');
            if (accountEl) accountEl.classList.add('auth-ready');
        });

        // Track order form handler
        document.getElementById('track-order-form')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const orderNumber = document.getElementById('order-number').value.trim();

            if (!orderNumber) return;

            // Redirect to order detail page
            window.location.href = `/html/account/order-detail.html?order=${encodeURIComponent(orderNumber)}`;
        });
