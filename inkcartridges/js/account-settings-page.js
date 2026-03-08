    // Simple notification function
    function showNotification(message, type = 'info') {
        // Remove any existing notification
        const existing = document.querySelector('.settings-notification');
        if (existing) existing.remove();

        const notification = document.createElement('div');
        notification.className = `settings-notification settings-notification--${type}`;
        notification.innerHTML = `
            <span>${message}</span>
            <button type="button" data-action="dismiss">&times;</button>
        `;
        notification.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            padding: 12px 20px;
            border-radius: 8px;
            background: ${type === 'success' ? '#10b981' : type === 'error' ? '#ef4444' : '#3b82f6'};
            color: white;
            display: flex;
            align-items: center;
            gap: 12px;
            z-index: 9999;
            box-shadow: 0 4px 12px rgba(0,0,0,0.15);
            animation: slideIn 0.3s ease;
        `;
        const dismissBtn = notification.querySelector('button');
        dismissBtn.style.cssText = `
            background: none;
            border: none;
            color: white;
            font-size: 20px;
            cursor: pointer;
            padding: 0;
            line-height: 1;
        `;

        // Bind dismiss handler
        dismissBtn.addEventListener('click', () => {
            notification.remove();
        });

        document.body.appendChild(notification);

        // Auto remove after 5 seconds
        setTimeout(() => notification.remove(), 5000);
    }

    const SettingsPage = {
        async init() {
            // Always setup form handlers first
            this.setupFormSubmit();

            // Wait a moment for AccountPage to initialize auth
            await new Promise(resolve => setTimeout(resolve, 500));

            // Load user data if authenticated
            if (Auth.isAuthenticated()) {
                this.loadUserData();
            }
        },

        // Helper to parse phone with country code
        parsePhoneWithCountry(phone) {
            if (!phone) return { countryCode: '+64', phoneNumber: '' };
            const match = phone.match(/^(\+\d{1,3})\s*(.*)$/);
            if (match) {
                return { countryCode: match[1], phoneNumber: match[2] };
            }
            return { countryCode: '+64', phoneNumber: phone };
        },

        // Helper to set phone fields
        setPhoneFields(phone) {
            const { countryCode, phoneNumber } = this.parsePhoneWithCountry(phone);
            const phoneCountrySelect = document.getElementById('phone-country');
            const phoneInput = document.getElementById('phone');

            if (phoneCountrySelect) {
                const option = phoneCountrySelect.querySelector(`option[value="${countryCode}"]`);
                if (option) phoneCountrySelect.value = countryCode;
            }
            if (phoneInput) phoneInput.value = phoneNumber;
        },

        async loadUserData() {
            // Always start with Auth.user data (guaranteed to exist if authenticated)
            if (Auth.user) {
                const authUser = Auth.user;
                document.getElementById('email').value = authUser.email || '';
                document.getElementById('first-name').value = authUser.user_metadata?.first_name || '';
                document.getElementById('last-name').value = authUser.user_metadata?.last_name || '';
                this.setPhoneFields(authUser.user_metadata?.phone || '');
            }

            // Try to get more complete data from API (non-blocking)
            try {
                const response = await API.getProfile();
                if (response.ok && response.data) {
                    const user = response.data;
                    // Update fields with API data
                    if (user.first_name) document.getElementById('first-name').value = user.first_name;
                    if (user.last_name) document.getElementById('last-name').value = user.last_name;
                    if (user.email) document.getElementById('email').value = user.email;
                    if (user.phone) this.setPhoneFields(user.phone);

                    // Load email preferences if available
                    if (user.email_preferences) {
                        const prefs = user.email_preferences;
                        const checkboxes = document.querySelectorAll('.form-section:last-of-type input[type="checkbox"]');
                        if (checkboxes[0]) checkboxes[0].checked = prefs.order_updates !== false;
                        if (checkboxes[1]) checkboxes[1].checked = prefs.promotions !== false;
                        if (checkboxes[2]) checkboxes[2].checked = prefs.recommendations === true;
                    }
                }
            } catch (error) {
                DebugLog.log('Could not load profile from API:', error.message);
                // Form still works with Auth.user data
            }
        },

        setupFormSubmit() {
            const form = document.querySelector('.account-form');
            if (!form) return;

            form.addEventListener('submit', async (e) => {
                e.preventDefault();

                const submitBtn = form.querySelector('button[type="submit"]');
                const originalText = submitBtn.textContent;
                submitBtn.textContent = 'Saving...';
                submitBtn.disabled = true;

                try {
                    // Get form values
                    const firstName = document.getElementById('first-name').value.trim();
                    const lastName = document.getElementById('last-name').value.trim();

                    // Combine country code + phone number
                    const phoneCountry = document.getElementById('phone-country')?.value || '+64';
                    const phoneNumber = document.getElementById('phone').value.trim();
                    const phone = phoneNumber ? `${phoneCountry} ${phoneNumber}` : '';

                    // Get email preferences
                    const checkboxes = document.querySelectorAll('.form-section:last-of-type input[type="checkbox"]');
                    const emailPreferences = {
                        order_updates: checkboxes[0]?.checked ?? true,
                        promotions: checkboxes[1]?.checked ?? true,
                        recommendations: checkboxes[2]?.checked ?? false
                    };

                    // Prepare profile data
                    const profileData = {
                        first_name: firstName,
                        last_name: lastName,
                        phone: phone,
                        email_preferences: emailPreferences
                    };

                    // Try to save to backend API first
                    let backendSuccess = false;
                    try {
                        const response = await API.updateProfile(profileData);
                        if (response.ok) {
                            backendSuccess = true;
                        } else {
                            DebugLog.warn('Backend API failed:', response.error);
                        }
                    } catch (apiError) {
                        DebugLog.warn('Backend API error:', apiError.message);
                    }

                    // Also save to Supabase user metadata (backup/sync)
                    const { error: supabaseError } = await Auth.supabase.auth.updateUser({
                        data: {
                            first_name: firstName,
                            last_name: lastName,
                            phone: phone,
                            full_name: `${firstName} ${lastName}`.trim(),
                            email_preferences: emailPreferences
                        }
                    });

                    if (backendSuccess) {
                        showNotification('Settings saved successfully', 'success');
                    } else if (!supabaseError) {
                        showNotification('Settings saved (sync pending)', 'success');
                    } else {
                        showNotification('Failed to save settings', 'error');
                    }

                    // Update sidebar name display
                    const nameEl = document.getElementById('user-name');
                    if (nameEl) nameEl.textContent = `${firstName} ${lastName}`.trim();
                } catch (error) {
                    DebugLog.error('Failed to save settings:', error);
                    showNotification('Failed to save settings', 'error');
                } finally {
                    submitBtn.textContent = originalText;
                    submitBtn.disabled = false;
                }
            });
        },

        setupPasswordChange() {
            const currentPassword = document.getElementById('current-password');
            const newPassword = document.getElementById('new-password');
            const confirmPassword = document.getElementById('confirm-password');

            // Add password change validation on form submit
            const form = document.querySelector('.account-form');
            if (!form) return;

            const originalSubmit = form.onsubmit;

            form.addEventListener('submit', async (e) => {
                // Only handle password change if fields are filled
                if (newPassword.value || currentPassword.value) {
                    if (!currentPassword.value) {
                        showNotification('Please enter your current password', 'error');
                        e.preventDefault();
                        return;
                    }
                    if (newPassword.value !== confirmPassword.value) {
                        showNotification('New passwords do not match', 'error');
                        e.preventDefault();
                        return;
                    }
                    if (newPassword.value.length < 8) {
                        showNotification('New password must be at least 8 characters', 'error');
                        e.preventDefault();
                        return;
                    }

                    try {
                        const result = await Auth.updatePassword(newPassword.value);
                        if (result.ok) {
                            showNotification('Password updated successfully', 'success');
                            currentPassword.value = '';
                            newPassword.value = '';
                            confirmPassword.value = '';
                        } else {
                            showNotification(result.error || 'Failed to update password', 'error');
                        }
                    } catch (error) {
                        showNotification('Failed to update password', 'error');
                    }
                }
            });
        }
    };

    document.addEventListener('DOMContentLoaded', () => {
        SettingsPage.init();
    });
