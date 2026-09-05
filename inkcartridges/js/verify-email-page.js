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
                    if (response.ok) {
                        resendStatus.textContent = 'Verification email sent! Please check your inbox.';
                        resendStatus.style.display = '';
                        resendBtn.textContent = 'Email Sent';
                        setTimeout(() => {
                            resendBtn.disabled = false;
                            resendBtn.textContent = 'Resend Verification Email';
                        }, 30000);
                    } else {
                        resendStatus.textContent = API.extractErrorMessage(response, 'Failed to send email. Please try again.');
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

                // Reuse auth.js's client rather than building a second one
                // (ERR-209). verify-email.html loads auth.js, and a bare
                // createClient() here shares the SAME default storageKey while
                // defaulting to localStorage — so in session mode the two clients
                // wrote the token to different stores: a leak plus a split brain.
                // auth.js already has detectSessionInUrl:true, so it processes
                // the hash; we only need to listen. auth.js's DOMContentLoaded
                // handler is registered first (document order, both deferred) and
                // assigns .supabase synchronously, so it is ready by now.
                const supabaseClient = (typeof Auth !== 'undefined' && Auth.supabase) || null;
                if (!supabaseClient) {
                    // LOUD, not silent: without a client we cannot observe the
                    // verification at all, so say so rather than leaving the user
                    // on a spinner that never resolves.
                    DebugLog.error('[verify-email] Auth.supabase unavailable; cannot confirm verification');
                    if (heading) heading.textContent = 'Verification status unknown';
                    if (text) text.textContent = 'We could not confirm your email address just now. Please try the link again, or sign in to check.';
                    return;
                }

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
