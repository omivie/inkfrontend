        document.getElementById('current-year').textContent = new Date().getFullYear();

        document.addEventListener('DOMContentLoaded', async () => {
            const form = document.getElementById('reset-password-form');
            const newPassword = document.getElementById('new-password');
            const confirmPassword = document.getElementById('confirm-password');
            const passwordError = document.getElementById('password-error');
            const submitBtn = form.querySelector('button[type="submit"]');

            // Initialize Supabase
            const supabaseClient = supabase.createClient(
                Config.SUPABASE_URL,
                Config.SUPABASE_ANON_KEY
            );

            // Password toggle functionality
            document.querySelectorAll('.password-toggle').forEach(toggle => {
                toggle.addEventListener('click', () => {
                    const wrapper = toggle.closest('.password-input-wrapper');
                    const input = wrapper.querySelector('input');
                    const showIcon = toggle.querySelector('.password-toggle__show');
                    const hideIcon = toggle.querySelector('.password-toggle__hide');

                    if (input.type === 'password') {
                        input.type = 'text';
                        showIcon.style.display = 'none';
                        hideIcon.style.display = 'block';
                    } else {
                        input.type = 'password';
                        showIcon.style.display = 'block';
                        hideIcon.style.display = 'none';
                    }
                });
            });

            // Handle form submission
            form.addEventListener('submit', async (e) => {
                e.preventDefault();
                passwordError.hidden = true;

                const password = newPassword.value;
                const confirm = confirmPassword.value;

                if (password.length < 8) {
                    passwordError.textContent = 'Password must be at least 8 characters.';
                    passwordError.hidden = false;
                    return;
                }

                if (password !== confirm) {
                    passwordError.textContent = 'Passwords do not match.';
                    passwordError.hidden = false;
                    return;
                }

                submitBtn.disabled = true;
                submitBtn.textContent = 'Updating...';

                try {
                    const { data, error } = await supabaseClient.auth.updateUser({
                        password: password
                    });

                    if (error) {
                        passwordError.textContent = error.message || 'Failed to update password.';
                        passwordError.hidden = false;
                        submitBtn.disabled = false;
                        submitBtn.textContent = 'Update Password';
                    } else {
                        // Show success state
                        const wrapper = form.closest('.auth-form-wrapper');
                        wrapper.innerHTML = `
                            <div class="auth-success-icon auth-success-icon--check">
                                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                                    <polyline points="22 4 12 14.01 9 11.01"/>
                                </svg>
                            </div>
                            <h1 class="auth-form__heading">Password Updated!</h1>
                            <p class="auth-form__subheading">Your password has been successfully changed.</p>
                            <div class="auth-success-actions">
                                <a href="/html/account/login.html" class="btn btn--primary btn--large btn--full-width">Sign In</a>
                            </div>
                        `;
                    }
                } catch (err) {
                    DebugLog.error('Password update error:', err);
                    passwordError.textContent = 'An error occurred. Please try again.';
                    passwordError.hidden = false;
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Update Password';
                }
            });
        });
