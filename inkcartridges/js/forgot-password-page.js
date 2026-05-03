        document.addEventListener('DOMContentLoaded', () => {
            const form = document.getElementById('forgot-password-form');
            const emailInput = document.getElementById('email');
            const emailError = document.getElementById('email-error');
            const submitBtn = form.querySelector('button[type="submit"]');
            const wrapper = document.getElementById('forgot-password-wrapper');

            function showError(message) {
                emailError.textContent = message;
                emailError.hidden = false;
            }

            function hideError() {
                emailError.hidden = true;
            }

            form.addEventListener('submit', async (e) => {
                e.preventDefault();
                hideError();
                const email = emailInput.value.trim();

                if (!email) {
                    showError('Please enter your email address.');
                    return;
                }

                submitBtn.disabled = true;
                submitBtn.textContent = 'Sending...';

                try {
                    // Wait for Auth to initialize
                    await new Promise(resolve => {
                        const check = () => {
                            if (typeof Auth !== 'undefined' && Auth.supabase) {
                                resolve();
                            } else {
                                setTimeout(check, 100);
                            }
                        };
                        check();
                    });

                    const { data, error } = await Auth.resetPassword(email);

                    if (error) {
                        const msg = (error.message || '').toLowerCase();
                        if (msg.includes('rate limit')) {
                            showError('Too many requests. Please wait a minute before trying again.');
                        } else {
                            showError(error.message || 'Failed to send reset email. Please try again.');
                        }
                        submitBtn.disabled = false;
                        submitBtn.textContent = 'Send Reset Link';
                    } else {
                        // Show success state
                        wrapper.innerHTML = `
                            <div class="auth-success-icon">
                                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
                                    <polyline points="22,6 12,13 2,6"/>
                                </svg>
                            </div>
                            <h1 class="auth-form__heading">Check Your Email</h1>
                            <p class="auth-form__subheading">We've sent a password reset link to <strong>${Security.escapeHtml(email)}</strong></p>
                            <div class="auth-success-note">
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <circle cx="12" cy="12" r="10"/>
                                    <line x1="12" y1="8" x2="12" y2="12"/>
                                    <line x1="12" y1="16" x2="12.01" y2="16"/>
                                </svg>
                                <span>Don't forget to check your spam or junk folder if you don't see the email within a few minutes.</span>
                            </div>
                            <div class="auth-success-actions">
                                <a href="/account/login" class="btn btn--primary btn--large btn--full-width">Back to Sign In</a>
                            </div>
                        `;
                    }
                } catch (err) {
                    DebugLog.error('Reset password error:', err);
                    showError('An error occurred. Please try again.');
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Send Reset Link';
                }
            });
        });
