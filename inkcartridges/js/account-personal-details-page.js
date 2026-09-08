/**
 * Personal Details page controller (/account/personal-details).
 *
 * WAS AN INLINE <script> IN personal-details.html UNTIL ERR-230 (Sep 2026), AND
 * IT HAD NOT RUN IN PRODUCTION FOR MONTHS. `script-src` in vercel.json carries
 * no 'unsafe-inline' and only two sha256 hashes, neither of which matched this
 * block, so the browser refused it: the page rendered, the form sat there, and
 * nothing saved. Nothing logged, because the code that would have logged was
 * the code being refused.
 *
 * Externalised rather than hash-allowlisted on purpose. A hash has to be
 * recomputed every time a byte of the script changes, and nothing in the build
 * enforces that — the CSP was carrying a stale 'sha256-0Jmm…' that matched no
 * file in the tree at all. An external file under /js/ is covered by
 * `script-src 'self'` forever and gets ?v= cache-busting from stamp-versions.js
 * for free. tests/public-surface-sep2026.test.js now fails the build if any
 * executable inline script exists without a matching hash.
 *
 * Timing is unchanged: this loads with `defer`, and deferred scripts all run
 * before DOMContentLoaded, which is what init() waits for.
 *
 * Four raw console.warn/error calls were routed through DebugLog on the way
 * out. They had been leaking to production DevTools since the page was
 * written — tests/console-debuglog-audit.test.js only walks .js files under
 * inkcartridges/js/, so an inline <script> was a blind spot for it in exactly
 * the same way it was for the CSP. Two audits, one hiding place.
 */

'use strict';

    // Simple notification function
    function showNotification(message, type = 'info') {
        const existing = document.querySelector('.settings-notification');
        if (existing) existing.remove();

        const notification = document.createElement('div');
        notification.className = `settings-notification settings-notification--${type}`;
        // Built node-by-node rather than with innerHTML. The old version
        // interpolated `message` straight into a template literal, and the
        // dismiss button carried an inline onclick= — which `script-src` without
        // 'unsafe-inline' refuses outright, so the × did nothing even on the days
        // the surrounding script did run (ERR-230).
        const text = document.createElement('span');
        text.textContent = message;
        const dismiss = document.createElement('button');
        dismiss.type = 'button';
        dismiss.setAttribute('aria-label', 'Dismiss notification');
        dismiss.textContent = '\u00d7';
        dismiss.addEventListener('click', () => notification.remove());
        notification.append(text, dismiss);
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
        notification.querySelector('button').style.cssText = `
            background: none;
            border: none;
            color: white;
            font-size: 20px;
            cursor: pointer;
            padding: 0;
            line-height: 1;
        `;
        document.body.appendChild(notification);
        setTimeout(() => notification.remove(), 5000);
    }

    const PersonalDetailsPage = {
        async init() {
            this.setupFormSubmit();

            // Wait a moment for AccountPage to initialize auth
            await new Promise(resolve => setTimeout(resolve, 500));

            if (Auth.isAuthenticated()) {
                this.loadUserData();
            }
        },

        parsePhoneWithCountry(phone) {
            if (!phone) return { countryCode: '+64', phoneNumber: '' };
            const match = phone.match(/^(\+\d{1,3})\s*(.*)$/);
            if (match) {
                return { countryCode: match[1], phoneNumber: match[2] };
            }
            return { countryCode: '+64', phoneNumber: phone };
        },

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
            if (Auth.user) {
                const authUser = Auth.user;
                document.getElementById('email').value = authUser.email || '';
                document.getElementById('first-name').value = authUser.user_metadata?.first_name || '';
                document.getElementById('last-name').value = authUser.user_metadata?.last_name || '';
                this.setPhoneFields(authUser.user_metadata?.phone || '');
            }

            try {
                const response = await API.getProfile();
                if (response.ok && response.data) {
                    const user = response.data;
                    if (user.first_name) document.getElementById('first-name').value = user.first_name;
                    if (user.last_name) document.getElementById('last-name').value = user.last_name;
                    if (user.email) document.getElementById('email').value = user.email;
                    if (user.phone) this.setPhoneFields(user.phone);
                }
            } catch (error) {
                DebugLog.warn('Could not load profile from API:', error.message);
            }
        },

        setupFormSubmit() {
            const form = document.getElementById('personal-details-form');
            if (!form) return;

            form.addEventListener('submit', async (e) => {
                e.preventDefault();

                const submitBtn = form.querySelector('button[type="submit"]');
                const originalText = submitBtn.textContent;
                submitBtn.textContent = 'Saving...';
                submitBtn.disabled = true;

                try {
                    const firstName = document.getElementById('first-name').value.trim();
                    const lastName = document.getElementById('last-name').value.trim();

                    const phoneCountry = document.getElementById('phone-country')?.value || '+64';
                    const phoneNumber = document.getElementById('phone').value.trim();
                    const phone = phoneNumber ? `${phoneCountry} ${phoneNumber}` : '';

                    const profileData = {
                        first_name: firstName,
                        last_name: lastName,
                        phone: phone
                    };

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

                    const { error: supabaseError } = await Auth.supabase.auth.updateUser({
                        data: {
                            first_name: firstName,
                            last_name: lastName,
                            phone: phone,
                            full_name: `${firstName} ${lastName}`.trim()
                        }
                    });

                    if (backendSuccess) {
                        showNotification('Personal details saved successfully', 'success');
                    } else if (!supabaseError) {
                        showNotification('Personal details saved (sync pending)', 'success');
                    } else {
                        showNotification('Failed to save personal details', 'error');
                    }

                    const nameEl = document.getElementById('user-name');
                    if (nameEl) nameEl.textContent = `${firstName} ${lastName}`.trim();
                } catch (error) {
                    DebugLog.error('Failed to save personal details:', error);
                    showNotification('Failed to save personal details', 'error');
                } finally {
                    submitBtn.textContent = originalText;
                    submitBtn.disabled = false;
                }
            });
        }
    };

    document.addEventListener('DOMContentLoaded', () => {
        PersonalDetailsPage.init();
    });
