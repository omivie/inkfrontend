        // Logout confirmation modal
        document.addEventListener('DOMContentLoaded', () => {
            const logoutLink = document.querySelector('.logout-link');
            const logoutModal = document.getElementById('logout-modal');
            const logoutCancel = document.getElementById('logout-cancel');
            const logoutConfirm = document.getElementById('logout-confirm');
            const modalBackdrop = logoutModal?.querySelector('.modal__backdrop');

            if (logoutLink && logoutModal) {
                logoutLink.addEventListener('click', (e) => {
                    e.preventDefault();
                    logoutModal.hidden = false;
                    document.body.style.overflow = 'hidden';
                });

                logoutCancel.addEventListener('click', () => {
                    logoutModal.hidden = true;
                    document.body.style.overflow = '';
                });

                modalBackdrop.addEventListener('click', () => {
                    logoutModal.hidden = true;
                    document.body.style.overflow = '';
                });

                logoutConfirm.addEventListener('click', async () => {
                    logoutConfirm.disabled = true;
                    logoutConfirm.textContent = 'Signing out...';

                    const urlParams = new URLSearchParams(window.location.search);
                    if (urlParams.get('dev') === 'true') {
                        window.location.href = '/html/index.html';
                        return;
                    }

                    if (typeof Auth !== 'undefined') {
                        await Auth.signOut();
                    }
                    window.location.href = '/html/index.html';
                });

                document.addEventListener('keydown', (e) => {
                    if (e.key === 'Escape' && !logoutModal.hidden) {
                        logoutModal.hidden = true;
                        document.body.style.overflow = '';
                    }
                });
            }
        });

        // Load user savings data
        document.addEventListener('DOMContentLoaded', async () => {
            await new Promise(resolve => setTimeout(resolve, 600));

            if (!Auth.isAuthenticated()) return;

            try {
                const response = await API.getUserSavings();
                if (response.ok && response.data) {
                    const savings = response.data;
                    const section = document.getElementById('savings-section');

                    if (savings.total_savings > 0) {
                        section.hidden = false;

                        const formatNZD = (amount) => '$' + (amount || 0).toFixed(2);

                        document.getElementById('total-savings').textContent = formatNZD(savings.total_savings);

                        const byType = savings.savings_by_type || [];
                        const setSavings = byType.find(s => s.type === 'set_discount')?.total || 0;
                        const bundleSavings = byType.find(s => s.type === 'bundle')?.total || 0;
                        const couponSavings = byType.find(s => s.type === 'coupon')?.total || 0;

                        document.getElementById('set-savings').textContent = formatNZD(setSavings);
                        document.getElementById('bundle-savings').textContent = formatNZD(bundleSavings);
                        document.getElementById('coupon-savings').textContent = formatNZD(couponSavings);
                    }
                }
            } catch (error) {
                DebugLog.log('Savings not available:', error.message);
            }
        });
