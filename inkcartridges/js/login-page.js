        document.addEventListener('DOMContentLoaded', function() {
            // Tab switching
            const tabs = document.querySelectorAll('.auth-tabs__tab');
            const panels = document.querySelectorAll('.auth-panel');
            const switchBtns = document.querySelectorAll('.auth-switch-btn');

            function switchTab(targetId) {
                // Update tabs
                tabs.forEach(tab => {
                    const isActive = tab.getAttribute('aria-controls') === targetId;
                    tab.classList.toggle('auth-tabs__tab--active', isActive);
                    tab.setAttribute('aria-selected', isActive);
                });

                // Update panels
                panels.forEach(panel => {
                    const isActive = panel.id === targetId;
                    panel.classList.toggle('auth-panel--active', isActive);
                    panel.hidden = !isActive;
                });
            }

            // Tab click handlers
            tabs.forEach(tab => {
                tab.addEventListener('click', () => {
                    switchTab(tab.getAttribute('aria-controls'));
                });
            });

            // Switch button handlers (e.g., "Create one" link)
            switchBtns.forEach(btn => {
                btn.addEventListener('click', () => {
                    switchTab(btn.dataset.target);
                });
            });

            // Handle Supabase email verification callback (from email link)
            // Supabase may include tokens in URL hash or query params
            const hashParams = new URLSearchParams(window.location.hash.substring(1));
            const urlParams = new URLSearchParams(window.location.search);

            // Check for Supabase auth callback in hash (access_token, type=recovery, etc.)
            if (hashParams.get('access_token') || hashParams.get('type')) {
                // Supabase will handle this automatically via onAuthStateChange
                // Just show a loading state briefly
                DebugLog.log('Processing email verification...');
            }

            // Check if user just verified their email (our custom redirect)
            if (urlParams.get('verified') === 'true') {
                // Show success message
                const loginPanel = document.getElementById('login-panel');
                if (loginPanel) {
                    const successMsg = document.createElement('div');
                    successMsg.className = 'auth-message auth-message--success';
                    successMsg.innerHTML = `
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                            <polyline points="22 4 12 14.01 9 11.01"/>
                        </svg>
                        <span>Email verified successfully! You can now sign in.</span>
                    `;
                    const formWrapper = loginPanel.querySelector('.auth-form-wrapper');
                    if (formWrapper) {
                        formWrapper.insertBefore(successMsg, formWrapper.querySelector('.auth-form'));
                    }
                }
                // Clean up URL
                window.history.replaceState({}, '', window.location.pathname);
            }

            // Listen for auth state changes (handles verification callback)
            if (typeof Auth !== 'undefined' && Auth.supabase) {
                Auth.supabase.auth.onAuthStateChange((event, session) => {
                    // Auth state change detected
                    if (event === 'SIGNED_IN' && session) {
                        // User just signed in (possibly via email verification)
                        const params = new URLSearchParams(window.location.search);
                        const redirect = Security.safeRedirect(params.get('redirect'));
                        window.location.href = redirect;
                    }
                });
            }

            // Login form submission
            const loginForm = document.getElementById('login-form');
            if (loginForm) {
                loginForm.addEventListener('submit', async (e) => {
                    e.preventDefault();
                    const email = document.getElementById('login-email').value;
                    const password = document.getElementById('login-password').value;
                    const submitBtn = loginForm.querySelector('button[type="submit"]');

                    submitBtn.disabled = true;
                    submitBtn.textContent = 'Signing in...';

                    const { data, error } = await Auth.signIn(email, password);

                    if (error) {

                        // Show user-friendly error messages
                        let errorMessage = error.message || 'Login failed. Please try again.';
                        let showResend = false;

                        if (error.message?.includes('Email not confirmed')) {
                            errorMessage = 'Please verify your email address before signing in. Check your inbox for the verification link.';
                            showResend = true;
                        } else if (error.message?.includes('Invalid login credentials')) {
                            // Supabase returns this for BOTH wrong password AND unverified email.
                            // Try a signUp to detect unverified: Supabase returns a fake user
                            // with empty identities if the email is already registered.
                            try {
                                const { data: signUpData } = await Auth.supabase.auth.signUp({
                                    email,
                                    password,
                                    options: { emailRedirectTo: `${window.location.origin}/html/account/verify-email` }
                                });
                                if (signUpData?.user && signUpData.user.identities?.length === 0) {
                                    // Email exists — could be unverified (Supabase masks the real reason)
                                    errorMessage = 'Invalid email or password. If you recently created an account, check your inbox for a verification email.';
                                    showResend = true;
                                }
                            } catch (_) { /* ignore probe error */ }

                            if (!showResend) {
                                errorMessage = 'Invalid email or password. Please check your credentials and try again.';
                            }
                        }

                        // Show error inline instead of alert
                        let loginError = document.getElementById('login-error');
                        if (!loginError) {
                            loginError = document.createElement('div');
                            loginError.id = 'login-error';
                            loginError.className = 'form-error';
                            loginError.style.marginBottom = '16px';
                            loginForm.insertBefore(loginError, loginForm.firstChild);
                        }
                        loginError.innerHTML = Security.escapeHtml(errorMessage);

                        // Offer to resend verification email
                        if (showResend) {
                            const resendLink = document.createElement('button');
                            resendLink.type = 'button';
                            resendLink.textContent = 'Resend verification email';
                            resendLink.style.cssText = 'background:none;border:none;color:#2563eb;cursor:pointer;text-decoration:underline;padding:0;margin-top:8px;display:block;font-size:0.9rem;';
                            resendLink.addEventListener('click', async () => {
                                resendLink.textContent = 'Sending...';
                                resendLink.disabled = true;
                                try {
                                    // Use Supabase resend directly — user is not authenticated on login page,
                                    // so the backend API (which requires auth) would return 401.
                                    const { error: resendError } = await Auth.supabase.auth.resend({
                                        type: 'signup',
                                        email: email,
                                        options: {
                                            emailRedirectTo: `${window.location.origin}/html/account/login.html?verified=true`
                                        }
                                    });
                                    resendLink.textContent = resendError ? 'Failed to send. Try again later.' : 'Verification email sent! Check your inbox.';
                                } catch (_) {
                                    resendLink.textContent = 'Failed to send. Try again later.';
                                }
                                resendLink.disabled = false;
                            });
                            loginError.appendChild(resendLink);
                        }
                        loginError.hidden = false;

                        submitBtn.disabled = false;
                        submitBtn.textContent = 'Sign In';
                    } else {
                        // Merge guest cart into user cart immediately after login
                        // This transfers items from the guest cart cookie to the user's cart
                        try {
                            DebugLog.log('🛒 Merging guest cart...');
                            const mergeResult = await API.mergeCart();
                            if (mergeResult.ok && mergeResult.data) {
                                DebugLog.log('🛒 Cart merge result:', mergeResult.data);
                                if (mergeResult.data.merged_count > 0 || mergeResult.data.added_count > 0) {
                                    DebugLog.log(`🛒 Merged ${mergeResult.data.added_count} new items, ${mergeResult.data.merged_count} quantities updated`);
                                }
                            }
                        } catch (mergeError) {
                            // Non-critical - cart will sync on next page
                            DebugLog.log('Cart merge:', mergeError.message);
                        }

                        // Sync profile to backend after successful login
                        if (data.user) {
                            try {
                                const userMeta = data.user.user_metadata || {};
                                await API.updateProfile({
                                    first_name: userMeta.first_name || null,
                                    last_name: userMeta.last_name || null,
                                    full_name: userMeta.full_name || data.user.email?.split('@')[0] || null,
                                    phone: userMeta.phone || null,
                                    marketing_consent: userMeta.marketing_consent || false
                                });
                            } catch (profileError) {
                                // Non-critical - continue to redirect
                                DebugLog.log('Profile sync:', profileError.message);
                            }
                        }

                        // Check email verification before redirecting
                        const isOAuth = data.user?.app_metadata?.provider && data.user.app_metadata.provider !== 'email';
                        if (!isOAuth && !data.user?.email_confirmed_at) {
                            window.location.href = '/html/account/verify-email.html';
                            return;
                        }

                        // Redirect to account or original page
                        const params = new URLSearchParams(window.location.search);
                        const redirect = Security.safeRedirect(params.get('redirect'));
                        window.location.href = redirect;
                    }
                });
            }

            // Register form submission
            const registerForm = document.getElementById('register-form');
            if (registerForm) {
                registerForm.addEventListener('submit', async (e) => {
                    e.preventDefault();
                    const firstName = document.getElementById('register-first-name').value.trim();
                    const lastName = document.getElementById('register-last-name').value.trim();
                    const email = document.getElementById('register-email').value.trim();
                    const phone = document.getElementById('register-phone').value.trim();
                    const password = document.getElementById('register-password').value;
                    const confirmPassword = document.getElementById('register-confirm-password').value;
                    const marketingConsent = document.getElementById('marketing-consent').checked;
                    const termsConsent = document.getElementById('terms-consent').checked;
                    const submitBtn = registerForm.querySelector('button[type="submit"]');

                    // Get error elements
                    const firstNameError = document.getElementById('first-name-error');
                    const lastNameError = document.getElementById('last-name-error');
                    const emailError = document.getElementById('email-error');
                    const passwordError = document.getElementById('password-error');
                    const termsError = document.getElementById('terms-error');

                    // Clear previous errors
                    if (firstNameError) firstNameError.hidden = true;
                    if (lastNameError) lastNameError.hidden = true;
                    if (emailError) emailError.hidden = true;
                    if (passwordError) passwordError.hidden = true;
                    if (termsError) termsError.hidden = true;

                    // Validate required fields in order
                    if (!firstName) {
                        if (firstNameError) firstNameError.hidden = false;
                        document.getElementById('register-first-name').focus();
                        return;
                    }

                    if (!lastName) {
                        if (lastNameError) lastNameError.hidden = false;
                        document.getElementById('register-last-name').focus();
                        return;
                    }

                    if (!email) {
                        if (emailError) {
                            emailError.textContent = 'Please enter your email address.';
                            emailError.hidden = false;
                        }
                        document.getElementById('register-email').focus();
                        return;
                    }

                    // Basic email format validation
                    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                    if (!emailRegex.test(email)) {
                        if (emailError) {
                            emailError.textContent = 'Please enter a valid email address.';
                            emailError.hidden = false;
                        }
                        document.getElementById('register-email').focus();
                        return;
                    }

                    if (!password) {
                        if (passwordError) passwordError.hidden = false;
                        document.getElementById('register-password').focus();
                        return;
                    }

                    if (password.length < 8) {
                        if (passwordError) {
                            passwordError.textContent = 'Password must be at least 8 characters.';
                            passwordError.hidden = false;
                        }
                        document.getElementById('register-password').focus();
                        return;
                    }

                    if (!confirmPassword) {
                        if (passwordError) {
                            passwordError.textContent = 'Please confirm your password.';
                            passwordError.hidden = false;
                        }
                        document.getElementById('register-confirm-password').focus();
                        return;
                    }

                    if (password !== confirmPassword) {
                        if (passwordError) {
                            passwordError.textContent = 'Passwords do not match.';
                            passwordError.hidden = false;
                        }
                        document.getElementById('register-confirm-password').focus();
                        return;
                    }

                    if (!termsConsent) {
                        if (termsError) termsError.hidden = false;
                        return;
                    }

                    submitBtn.disabled = true;
                    submitBtn.innerHTML = '<span class="spinner" style="width:16px;height:16px;border-width:2px;display:inline-block;vertical-align:middle;margin-right:8px"></span>Creating account...';

                    // Validate email before sending confirmation (blocks disposable addresses)
                    try {
                        const emailCheck = await API.validateEmail(email);
                        if (!emailCheck.ok) {
                            const msg = emailCheck.error?.message || emailCheck.error || 'This email address is not allowed.';
                            if (emailError) {
                                emailError.textContent = msg;
                                emailError.hidden = false;
                            }
                            submitBtn.disabled = false;
                            submitBtn.textContent = 'Create Account';
                            return;
                        }
                    } catch (valErr) {
                        // If validation endpoint is unavailable, allow signup to proceed
                        DebugLog.warn('Email validation unavailable:', valErr.message);
                    }

                    DebugLog.log('📧 Starting signup for:', email);
                    DebugLog.log('🔗 Redirect URL:', `${window.location.origin}/html/account/login.html?verified=true`);

                    try {
                    // Sign up with Supabase
                    const { data, error } = await Auth.supabase.auth.signUp({
                        email,
                        password,
                        options: {
                            emailRedirectTo: `${window.location.origin}/html/account/login.html?verified=true`,
                            data: {
                                full_name: `${firstName} ${lastName}`.trim(),
                                first_name: firstName,
                                last_name: lastName,
                                phone: phone || null,
                                marketing_consent: marketingConsent
                            }
                        }
                    });

                    DebugLog.log('📬 Supabase signup response:', { data, error });

                    if (error) {
                        DebugLog.error('❌ Signup error:', error);
                        let errorMessage = error.message || 'Registration failed. Please try again.';
                        if (error.message?.toLowerCase().includes('already registered') || error.message?.toLowerCase().includes('already been registered')) {
                            errorMessage = 'An account with this email already exists. Please sign in instead.';
                        }
                        if (emailError) {
                            emailError.textContent = errorMessage;
                            emailError.hidden = false;
                        }
                    } else if (data.user && data.user.identities?.length === 0) {
                        // Supabase returns a fake success with empty identities when email is taken
                        if (emailError) {
                            emailError.textContent = 'An account with this email already exists. Please sign in instead.';
                            emailError.hidden = false;
                        }
                    } else {
                        DebugLog.log('✅ Signup successful!');

                        // Try to create profile in backend (may require email verification first)
                        if (data.user && data.session) {
                            try {
                                await API.updateProfile({
                                    first_name: firstName,
                                    last_name: lastName,
                                    full_name: `${firstName} ${lastName}`.trim(),
                                    phone: phone || null,
                                    marketing_consent: marketingConsent
                                });
                            } catch (profileError) {
                                // Profile will be created after email verification
                                DebugLog.log('Profile will be synced after email verification');
                            }
                        }

                        // Redirect to verify email page
                        window.location.href = '/html/account/verify-email.html';
                        return; // Skip re-enable since we're navigating away
                    }
                    } finally {
                        submitBtn.disabled = false;
                        submitBtn.textContent = 'Create Account';
                    }
                });
            }

            // Google sign in
            document.querySelectorAll('.btn--google').forEach(btn => {
                btn.addEventListener('click', async () => {
                    await Auth.signInWithGoogle();
                });
            });

            // Clear field errors when user types
            const fieldErrorPairs = [
                { input: 'register-first-name', error: 'first-name-error' },
                { input: 'register-last-name', error: 'last-name-error' },
                { input: 'register-email', error: 'email-error' }
            ];

            fieldErrorPairs.forEach(({ input, error }) => {
                const inputEl = document.getElementById(input);
                const errorEl = document.getElementById(error);
                if (inputEl && errorEl) {
                    inputEl.addEventListener('input', () => {
                        errorEl.hidden = true;
                    });
                }
            });

            // Clear terms error when checkbox is checked
            const termsCheckbox = document.getElementById('terms-consent');
            const termsErrorEl = document.getElementById('terms-error');
            if (termsCheckbox && termsErrorEl) {
                termsCheckbox.addEventListener('change', () => {
                    if (termsCheckbox.checked) {
                        termsErrorEl.hidden = true;
                    }
                });
            }

            // Clear password error when user types
            const passwordInput = document.getElementById('register-password');
            const confirmPasswordInput = document.getElementById('register-confirm-password');
            const passwordErrorEl = document.getElementById('password-error');
            if (passwordErrorEl) {
                if (passwordInput) {
                    passwordInput.addEventListener('input', () => {
                        passwordErrorEl.hidden = true;
                    });
                }
                if (confirmPasswordInput) {
                    confirmPasswordInput.addEventListener('input', () => {
                        passwordErrorEl.hidden = true;
                    });
                }
            }

            // Password toggle
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

            // If already logged in, redirect to account
            setTimeout(() => {
                if (Auth.isAuthenticated()) {
                    const params = new URLSearchParams(window.location.search);
                    const redirect = Security.safeRedirect(params.get('redirect'));
                    window.location.href = redirect;
                }
            }, 500);
        });
