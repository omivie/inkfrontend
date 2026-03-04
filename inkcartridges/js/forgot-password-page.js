        document.addEventListener('DOMContentLoaded', () => {
            const form = document.querySelector('.auth-form');
            const emailInput = document.getElementById('email');
            const submitBtn = form.querySelector('button[type="submit"]');

            form.addEventListener('submit', async (e) => {
                e.preventDefault();
                const email = emailInput.value.trim();

                if (!email) {
                    alert('Please enter your email address.');
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
                        alert(error.message || 'Failed to send reset email. Please try again.');
                        submitBtn.disabled = false;
                        submitBtn.textContent = 'Send Reset Link';
                    } else {
                        // Show success message
                        form.innerHTML = `
                            <div class="auth-message auth-message--success" style="text-align: center;">
                                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin: 0 auto 16px; color: #10b981;">
                                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                                    <polyline points="22 4 12 14.01 9 11.01"/>
                                </svg>
                                <h3 style="margin-bottom: 8px;">Check Your Email</h3>
                                <p>We've sent a password reset link to <strong>${email}</strong></p>
                                <p style="margin-top: 16px; font-size: 14px; color: #666;">Don't forget to check your spam folder.</p>
                            </div>
                        `;
                    }
                } catch (err) {
                    DebugLog.error('Reset password error:', err);
                    alert('An error occurred. Please try again.');
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Send Reset Link';
                }
            });
        });
