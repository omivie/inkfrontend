        document.addEventListener('DOMContentLoaded', async () => {
            const form = document.getElementById('reset-password-form');
            const newPassword = document.getElementById('new-password');
            const confirmPassword = document.getElementById('confirm-password');
            const passwordError = document.getElementById('password-error');
            const submitBtn = form.querySelector('button[type="submit"]');
            const wrapper = form.closest('.auth-form-wrapper');

            // Initialize Supabase
            const supabaseClient = supabase.createClient(
                Config.SUPABASE_URL,
                Config.SUPABASE_ANON_KEY
            );

            // Extract recovery tokens from URL hash BEFORE clearing it
            const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
            const accessToken = hashParams.get('access_token');
            const refreshToken = hashParams.get('refresh_token');
            const type = hashParams.get('type');
            const hashError = hashParams.get('error_description') || hashParams.get('error');

            // Clear hash from URL so tokens don't persist in history
            if (window.location.hash) {
                window.history.replaceState({}, '', window.location.pathname);
            }

            function showInvalidLink(message) {
                wrapper.innerHTML = `
                    <h1 class="auth-form__heading">Reset Link Invalid</h1>
                    <p class="auth-form__subheading">${Security.escapeHtml(message)}</p>
                    <div class="auth-success-actions">
                        <a href="/account/forgot-password" class="btn btn--primary btn--large btn--full-width">Request a New Link</a>
                    </div>
                `;
            }

            if (hashError) {
                showInvalidLink('This password reset link is invalid or has expired. Please request a new one.');
                return;
            }

            if (!accessToken || !refreshToken || type !== 'recovery') {
                showInvalidLink('This page can only be opened from a password reset email link.');
                return;
            }

            // Establish recovery session
            let recoveryAccessToken = accessToken;
            try {
                const { data, error } = await supabaseClient.auth.setSession({
                    access_token: accessToken,
                    refresh_token: refreshToken
                });
                if (error) {
                    DebugLog.error('setSession error:', error);
                    showInvalidLink('This password reset link is invalid or has expired. Please request a new one.');
                    return;
                }
                if (data?.session?.access_token) {
                    recoveryAccessToken = data.session.access_token;
                }
            } catch (err) {
                DebugLog.error('setSession threw:', err);
                showInvalidLink('We couldn’t verify this reset link. Please request a new one.');
                return;
            }

            // Password toggle functionality
            document.querySelectorAll('.password-toggle').forEach(toggle => {
                toggle.addEventListener('click', () => {
                    const wrap = toggle.closest('.password-input-wrapper');
                    const input = wrap.querySelector('input');
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

                if (password.length > 128) {
                    passwordError.textContent = 'Password must be 128 characters or fewer.';
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
                    // Use the latest access token from the recovery session in case it was rotated
                    let bearerToken = recoveryAccessToken;
                    try {
                        const { data: { session } } = await supabaseClient.auth.getSession();
                        if (session?.access_token) bearerToken = session.access_token;
                    } catch (_) { /* fall back to recoveryAccessToken */ }

                    const res = await fetch(`${Config.API_URL}/api/auth/update-password`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${bearerToken}`
                        },
                        body: JSON.stringify({ password })
                    });

                    let body = null;
                    try { body = await res.json(); } catch (_) { /* ignore */ }

                    if (!res.ok) {
                        const msg = body?.error?.message || body?.message
                            || (res.status === 401
                                ? 'Your reset link has expired. Please request a new one.'
                                : 'Failed to update password.');
                        passwordError.textContent = msg;
                        passwordError.hidden = false;
                        submitBtn.disabled = false;
                        submitBtn.textContent = 'Update Password';
                        return;
                    }

                    // Sign out the recovery session, then route to login
                    try { await supabaseClient.auth.signOut(); } catch (_) { /* ignore */ }

                    wrapper.innerHTML = `
                        <div class="auth-success-icon auth-success-icon--check">
                            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                                <polyline points="22 4 12 14.01 9 11.01"/>
                            </svg>
                        </div>
                        <h1 class="auth-form__heading">Password Updated!</h1>
                        <p class="auth-form__subheading">Your password has been successfully changed. Redirecting to sign in...</p>
                        <div class="auth-success-actions">
                            <a href="/account/login" class="btn btn--primary btn--large btn--full-width">Sign In</a>
                        </div>
                    `;

                    setTimeout(() => {
                        window.location.href = '/account/login';
                    }, 1500);
                } catch (err) {
                    DebugLog.error('Password update error:', err);
                    passwordError.textContent = 'An error occurred. Please try again.';
                    passwordError.hidden = false;
                    submitBtn.disabled = false;
                    submitBtn.textContent = 'Update Password';
                }
            });
        });
