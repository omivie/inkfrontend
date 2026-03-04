        // Update year
        document.getElementById('current-year').textContent = new Date().getFullYear();

        // Handle Supabase email verification callback if tokens are in URL
        document.addEventListener('DOMContentLoaded', async () => {
            const hashParams = new URLSearchParams(window.location.hash.substring(1));
            const resendBtn = document.getElementById('resend-btn');
            const resendStatus = document.getElementById('resend-status');

            // Show resend button for authenticated users who haven't verified yet
            if (typeof Auth !== 'undefined') {
                await Auth.initialized;
                if (Auth.isAuthenticated()) {
                    resendBtn.style.display = '';
                }
            }

            // Resend verification email handler
            resendBtn.addEventListener('click', async () => {
                resendBtn.disabled = true;
                resendBtn.textContent = 'Sending...';
                resendStatus.style.display = 'none';

                try {
                    const response = await API.resendVerificationEmail();
                    if (response.success) {
                        resendStatus.textContent = 'Verification email sent! Please check your inbox.';
                        resendStatus.style.display = '';
                        resendBtn.textContent = 'Email Sent';
                        setTimeout(() => {
                            resendBtn.disabled = false;
                            resendBtn.textContent = 'Resend Verification Email';
                        }, 30000);
                    } else {
                        resendStatus.textContent = response.error || 'Failed to send email. Please try again.';
                        resendStatus.style.display = '';
                        resendBtn.disabled = false;
                        resendBtn.textContent = 'Resend Verification Email';
                    }
                } catch (error) {
                    resendStatus.textContent = error.message || 'Failed to send email. Please try again.';
                    resendStatus.style.display = '';
                    resendBtn.disabled = false;
                    resendBtn.textContent = 'Resend Verification Email';
                }
            });

            // Check if this is a verification callback (has tokens in URL)
            if (hashParams.get('access_token') || hashParams.get('type') === 'signup') {
                const heading = document.querySelector('.verify-email-heading');
                const text = document.querySelector('.verify-email-text');
                const icon = document.querySelector('.verify-email-icon');

                if (heading) heading.textContent = 'Verifying...';
                if (text) text.textContent = 'Please wait while we verify your email address.';
                if (resendBtn) resendBtn.style.display = 'none';

                // Initialize Supabase and let it process the tokens
                const supabaseClient = supabase.createClient(
                    Config.SUPABASE_URL,
                    Config.SUPABASE_ANON_KEY
                );

                // Listen for auth state change
                supabaseClient.auth.onAuthStateChange((event, session) => {
                    if (event === 'SIGNED_IN') {
                        if (heading) heading.textContent = 'Email Verified!';
                        if (text) text.textContent = 'Your email has been verified successfully. You can now sign in to your account.';
                        if (icon) icon.innerHTML = `
                            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                                <polyline points="22 4 12 14.01 9 11.01"/>
                            </svg>
                        `;

                        // Clean up URL
                        window.history.replaceState({}, '', window.location.pathname);
                    }
                });
            }
        });
