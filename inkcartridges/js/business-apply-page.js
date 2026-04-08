(function() {
    const BusinessApplyPage = {
        async init() {
            if (typeof Auth !== 'undefined' && Auth.readyPromise) {
                await Auth.readyPromise;
            }

            const isAuth = typeof Auth !== 'undefined' && Auth.isAuthenticated();
            const form = document.getElementById('business-form');
            const loginPrompt = document.getElementById('business-login-prompt');

            if (!isAuth) {
                if (loginPrompt) loginPrompt.hidden = false;
                return;
            }

            // Check existing application status
            try {
                const res = await API.getBusinessStatus();
                if (res.ok && res.data) {
                    const status = res.data.status;
                    if (status === 'pending' || status === 'approved' || status === 'rejected') {
                        this.showStatus(res.data);
                        return;
                    }
                }
            } catch (e) {
                // No existing application — show form
            }

            // Pre-fill from profile
            if (Auth.user) {
                const profile = Auth.user.user_metadata || {};
                const nameEl = document.getElementById('biz-contact-name');
                const emailEl = document.getElementById('biz-email');
                if (nameEl && !nameEl.value) {
                    const name = [profile.first_name, profile.last_name].filter(Boolean).join(' ');
                    if (name) nameEl.value = name;
                }
                if (emailEl && !emailEl.value && Auth.user.email) {
                    emailEl.value = Auth.user.email;
                }
            }

            if (form) {
                form.hidden = false;
                form.addEventListener('submit', (e) => this.handleSubmit(e));
            }

            // Setup toggles
            this.setupToggles();
        },

        setupToggles() {
            const sameAsBilling = document.getElementById('biz-same-as-billing');
            const net30Checkbox = document.getElementById('biz-net30');

            if (sameAsBilling) {
                sameAsBilling.addEventListener('change', () => {
                    this.toggleShippingFields(!sameAsBilling.checked);
                });
            }

            if (net30Checkbox) {
                net30Checkbox.addEventListener('change', () => {
                    this.toggleNet30Section(net30Checkbox.checked);
                });
            }
        },

        toggleShippingFields(show) {
            const fields = document.getElementById('biz-shipping-fields');
            if (!fields) return;
            fields.hidden = !show;
            // Toggle required on shipping fields
            fields.querySelectorAll('[id^="biz-shipping-"]').forEach(el => {
                if (el.tagName === 'INPUT' || el.tagName === 'SELECT') {
                    if (el.id === 'biz-shipping-address2') return; // always optional
                    el.required = show;
                }
            });
        },

        toggleNet30Section(show) {
            const fields = document.getElementById('biz-net30-fields');
            if (!fields) return;
            fields.hidden = !show;
            const spendEl = document.getElementById('biz-spend');
            if (spendEl) spendEl.required = show;
        },

        showStatus(data) {
            const section = document.getElementById('business-status-section');
            const content = document.getElementById('business-status-content');
            if (!section || !content) return;

            const status = data.status || data.application?.status || 'unknown';
            const app = data.application || {};
            const companyName = app.company_name || '';

            const badges = {
                pending: { cls: 'business-status__badge--pending', label: 'Pending Review' },
                approved: { cls: 'business-status__badge--approved', label: 'Approved' },
                rejected: { cls: 'business-status__badge--rejected', label: 'Not Approved' }
            };
            const badge = badges[status] || { cls: '', label: status };

            const submittedDate = app.submitted_at
                ? new Date(app.submitted_at).toLocaleDateString('en-NZ', { year: 'numeric', month: 'long', day: 'numeric' })
                : '';

            content.innerHTML = `
                <span class="business-status__badge ${badge.cls}">${Security.escapeHtml(badge.label)}</span>
                ${companyName ? `<p><strong>Company:</strong> ${Security.escapeHtml(companyName)}</p>` : ''}
                ${submittedDate ? `<p><strong>Submitted:</strong> ${submittedDate}</p>` : ''}
                ${status === 'pending' ? '<p>Your application is being reviewed. We\'ll be in touch shortly.</p>' : ''}
                ${status === 'approved' ? '<p>Your business account is active. Enjoy your business pricing!</p>' : ''}
                ${status === 'rejected' ? '<p>Unfortunately your application was not approved. Please <a href="/html/contact.html">contact us</a> for more information.</p>' : ''}
            `;

            section.hidden = false;
        },

        gatherAddressFields(prefix) {
            return {
                address1: (document.getElementById(`biz-${prefix}-address1`)?.value || '').trim(),
                address2: (document.getElementById(`biz-${prefix}-address2`)?.value || '').trim(),
                city: (document.getElementById(`biz-${prefix}-city`)?.value || '').trim(),
                region: (document.getElementById(`biz-${prefix}-region`)?.value || '').trim(),
                postcode: (document.getElementById(`biz-${prefix}-postcode`)?.value || '').trim()
            };
        },

        async handleSubmit(e) {
            e.preventDefault();
            const form = e.target;
            const btn = document.getElementById('biz-submit-btn');
            const msgEl = document.getElementById('business-form-message');

            // Gather values
            const company_name = (document.getElementById('biz-company')?.value || '').trim();
            const nzbn = (document.getElementById('biz-nzbn')?.value || '').trim();
            const contact_name = (document.getElementById('biz-contact-name')?.value || '').trim();
            const contact_email = (document.getElementById('biz-email')?.value || '').trim();
            const contact_phone = (document.getElementById('biz-phone')?.value || '').trim();
            const industry = document.getElementById('biz-industry')?.value || '';
            const business_type = document.getElementById('biz-type')?.value || '';
            const ap_email = (document.getElementById('biz-ap-email')?.value || '').trim();

            // Addresses
            const billing_address = this.gatherAddressFields('billing');
            const sameAsBilling = document.getElementById('biz-same-as-billing')?.checked;
            const shipping_address = sameAsBilling ? { ...billing_address } : this.gatherAddressFields('shipping');

            // Net 30
            const apply_net30 = document.getElementById('biz-net30')?.checked || false;
            const estimated_monthly_spend = document.getElementById('biz-spend')?.value || '';
            const creditRefFile = document.getElementById('biz-credit-ref')?.files?.[0] || null;

            // Validation
            if (!company_name || !contact_name || !contact_email || !contact_phone || !industry || !business_type) {
                this.showMessage(msgEl, 'Please fill in all required fields.', 'error');
                return;
            }

            if (nzbn && !/^\d{13}$/.test(nzbn)) {
                this.showMessage(msgEl, 'NZBN must be exactly 13 digits.', 'error');
                return;
            }

            if (!billing_address.address1 || !billing_address.city || !billing_address.region || !billing_address.postcode) {
                this.showMessage(msgEl, 'Please fill in all billing address fields.', 'error');
                return;
            }

            if (!/^\d{4}$/.test(billing_address.postcode)) {
                this.showMessage(msgEl, 'Billing postcode must be 4 digits.', 'error');
                return;
            }

            if (!sameAsBilling) {
                if (!shipping_address.address1 || !shipping_address.city || !shipping_address.region || !shipping_address.postcode) {
                    this.showMessage(msgEl, 'Please fill in all shipping address fields.', 'error');
                    return;
                }
                if (!/^\d{4}$/.test(shipping_address.postcode)) {
                    this.showMessage(msgEl, 'Shipping postcode must be 4 digits.', 'error');
                    return;
                }
            }

            if (apply_net30 && !estimated_monthly_spend) {
                this.showMessage(msgEl, 'Please select your estimated monthly spend for Net 30 terms.', 'error');
                return;
            }

            if (creditRefFile && creditRefFile.size > 5 * 1024 * 1024) {
                this.showMessage(msgEl, 'Credit reference file must be under 5 MB.', 'error');
                return;
            }

            btn.disabled = true;
            btn.textContent = 'Submitting...';

            try {
                // Upload credit reference file first if provided
                let credit_reference_url = null;
                if (apply_net30 && creditRefFile) {
                    try {
                        const uploadRes = await API.uploadCreditReference(creditRefFile);
                        credit_reference_url = uploadRes.url || uploadRes.data?.url || null;
                    } catch (uploadErr) {
                        this.showMessage(msgEl, 'Failed to upload credit reference: ' + (uploadErr.message || 'Unknown error'), 'error');
                        btn.textContent = 'Submit Application';
                        btn.disabled = false;
                        return;
                    }
                }

                const payload = {
                    company_name,
                    contact_name,
                    contact_email,
                    contact_phone,
                    industry,
                    business_type,
                    billing_address,
                    shipping_address,
                    apply_net30
                };
                if (nzbn) payload.nzbn = nzbn;
                if (ap_email) payload.ap_email = ap_email;
                if (apply_net30) {
                    payload.estimated_monthly_spend = estimated_monthly_spend;
                    if (credit_reference_url) payload.credit_reference_url = credit_reference_url;
                }

                const res = await API.applyBusiness(payload);
                if (res.ok) {
                    this.showThankYou();
                } else {
                    const errMsg = res.error?.message || 'Could not submit application. Please try again.';
                    this.showMessage(msgEl, errMsg, 'error');
                    btn.textContent = 'Submit Application';
                    btn.disabled = false;
                }
            } catch (err) {
                this.showMessage(msgEl, err.message || 'Something went wrong. Please try again.', 'error');
                btn.textContent = 'Submit Application';
                btn.disabled = false;
            }
        },

        showThankYou() {
            const form = document.getElementById('business-form');
            const thankYou = document.getElementById('business-thank-you');
            if (form) form.hidden = true;
            if (thankYou) thankYou.hidden = false;
        },

        showMessage(el, text, type) {
            if (!el) return;
            el.textContent = text;
            el.className = type === 'success'
                ? 'business-form__message business-form__message--success'
                : 'business-form__message business-form__message--error';
            el.hidden = false;
        }
    };

    document.addEventListener('DOMContentLoaded', () => BusinessApplyPage.init());
})();
