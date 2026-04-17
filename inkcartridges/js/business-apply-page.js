(function() {
    const BusinessApplyPage = {
        _currentStep: 1,
        _totalSteps: 5,
        _isReapply: false,

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

            try {
                const res = await API.getBusinessStatus();
                if (res.ok && res.data) {
                    const status = res.data.status;
                    if (status === 'pending' || status === 'approved') {
                        this.showStatus(res.data);
                        return;
                    }
                    if (status === 'rejected') {
                        // Show status card with reapply option; don't block the form
                        this.showStatus(res.data);
                        this._isReapply = true;
                        // Fall through to show the form below the status card
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

            this.goToStep(1);
            this.setupToggles();
        },

        setupToggles() {
            const sameAsBilling = document.getElementById('biz-same-as-billing');
            const net30Checkbox = document.getElementById('biz-net30');
            const backBtn = document.getElementById('wizard-back-btn');
            const nextBtn = document.getElementById('wizard-next-btn');

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

            if (backBtn) {
                backBtn.addEventListener('click', () => {
                    if (this._currentStep > 1) this.goToStep(this._currentStep - 1);
                });
            }

            if (nextBtn) {
                nextBtn.addEventListener('click', () => {
                    if (this.validateStep(this._currentStep)) {
                        this.goToStep(this._currentStep + 1);
                    }
                });
            }
        },

        goToStep(n) {
            const totalSteps = this._totalSteps;
            n = Math.max(1, Math.min(n, totalSteps));
            this._currentStep = n;

            // Update step panels
            document.querySelectorAll('.wizard-step[data-step]').forEach(panel => {
                const stepNum = parseInt(panel.dataset.step, 10);
                panel.classList.toggle('active', stepNum === n);
            });

            // Update progress indicators
            document.querySelectorAll('[data-step-indicator]').forEach(ind => {
                const stepNum = parseInt(ind.dataset.stepIndicator, 10);
                ind.classList.remove('active', 'completed');
                if (stepNum === n) ind.classList.add('active');
                else if (stepNum < n) ind.classList.add('completed');
            });

            // Checkmark SVG for completed steps
            document.querySelectorAll('[data-step-indicator]').forEach(ind => {
                const dot = ind.querySelector('.wizard-step-indicator__dot');
                const stepNum = parseInt(ind.dataset.stepIndicator, 10);
                if (stepNum < n) {
                    dot.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`;
                } else {
                    dot.textContent = stepNum;
                }
            });

            // Update connector lines
            document.querySelectorAll('[data-line]').forEach(line => {
                const lineNum = parseInt(line.dataset.line, 10);
                line.classList.toggle('done', lineNum < n);
            });

            // Update nav buttons
            const backBtn = document.getElementById('wizard-back-btn');
            const nextBtn = document.getElementById('wizard-next-btn');
            const submitBtn = document.getElementById('biz-submit-btn');
            const stepCount = document.getElementById('wizard-step-count');

            if (backBtn) backBtn.disabled = (n === 1);
            if (nextBtn) nextBtn.style.display = (n < totalSteps) ? '' : 'none';
            if (submitBtn) submitBtn.style.display = (n === totalSteps) ? '' : 'none';
            if (stepCount) stepCount.textContent = `Step ${n} of ${totalSteps}`;

            // Render review on step 5
            if (n === 5) this.renderReview();

            // Scroll wizard card into view smoothly
            const card = document.querySelector('.wizard-card');
            if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        },

        validateStep(n) {
            const errEl = document.getElementById(`step-${n}-error`);
            const showErr = (msg) => {
                if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
                return false;
            };
            if (errEl) errEl.hidden = true;

            if (n === 1) {
                const company = (document.getElementById('biz-company')?.value || '').trim();
                const nzbn = (document.getElementById('biz-nzbn')?.value || '').trim();
                const industry = document.getElementById('biz-industry')?.value || '';
                const bizType = document.getElementById('biz-type')?.value || '';

                if (!company) return showErr('Company name is required.');
                if (nzbn && !/^\d{13}$/.test(nzbn)) return showErr('NZBN must be exactly 13 digits.');
                if (!industry) return showErr('Please select your industry.');
                if (!bizType) return showErr('Please select your business type.');
                return true;
            }

            if (n === 2) {
                const name = (document.getElementById('biz-contact-name')?.value || '').trim();
                const email = (document.getElementById('biz-email')?.value || '').trim();
                const phone = (document.getElementById('biz-phone')?.value || '').trim();
                const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

                if (!name) return showErr('Contact name is required.');
                if (!email) return showErr('Email address is required.');
                if (!emailOk) return showErr('Please enter a valid email address.');
                if (!phone) return showErr('Phone number is required.');
                return true;
            }

            if (n === 3) {
                const addr1 = (document.getElementById('biz-billing-address1')?.value || '').trim();
                const city = (document.getElementById('biz-billing-city')?.value || '').trim();
                const region = document.getElementById('biz-billing-region')?.value || '';
                const postcode = (document.getElementById('biz-billing-postcode')?.value || '').trim();

                if (!addr1) return showErr('Billing street address is required.');
                if (!city) return showErr('Billing city is required.');
                if (!region) return showErr('Please select your billing region.');
                if (!/^\d{4}$/.test(postcode)) return showErr('Billing postcode must be 4 digits.');

                const sameAsBilling = document.getElementById('biz-same-as-billing')?.checked;
                if (!sameAsBilling) {
                    const sa1 = (document.getElementById('biz-shipping-address1')?.value || '').trim();
                    const sc = (document.getElementById('biz-shipping-city')?.value || '').trim();
                    const sr = document.getElementById('biz-shipping-region')?.value || '';
                    const sp = (document.getElementById('biz-shipping-postcode')?.value || '').trim();

                    if (!sa1) return showErr('Shipping street address is required.');
                    if (!sc) return showErr('Shipping city is required.');
                    if (!sr) return showErr('Please select your shipping region.');
                    if (!/^\d{4}$/.test(sp)) return showErr('Shipping postcode must be 4 digits.');
                }
                return true;
            }

            if (n === 4) {
                const net30 = document.getElementById('biz-net30')?.checked || false;
                if (net30) {
                    const spend = document.getElementById('biz-spend')?.value || '';
                    if (!spend) return showErr('Please select your estimated monthly spend for Net 30 terms.');
                }
                return true;
            }

            return true;
        },

        renderReview() {
            const get = (id) => (document.getElementById(id)?.value || '').trim();
            const checked = (id) => document.getElementById(id)?.checked || false;
            const optText = (id) => {
                const el = document.getElementById(id);
                return el?.options[el.selectedIndex]?.text || '';
            };
            const esc = (s) => typeof Security !== 'undefined' ? Security.escapeHtml(String(s)) : String(s).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));

            const company = get('biz-company');
            const nzbn = get('biz-nzbn');
            const industry = optText('biz-industry');
            const bizType = optText('biz-type');

            const contactName = get('biz-contact-name');
            const email = get('biz-email');
            const phone = get('biz-phone');
            const apEmail = get('biz-ap-email');

            const bAddr1 = get('biz-billing-address1');
            const bAddr2 = get('biz-billing-address2');
            const bCity = get('biz-billing-city');
            const bRegion = optText('biz-billing-region');
            const bPostcode = get('biz-billing-postcode');

            const sameAsBilling = checked('biz-same-as-billing');
            const net30 = checked('biz-net30');
            const spendText = optText('biz-spend');

            const row = (label, value) => value
                ? `<div class="review-row"><span class="review-row__label">${esc(label)}</span><span class="review-row__value">${esc(value)}</span></div>`
                : '';

            let html = '';

            html += `<div class="review-section">
                <div class="review-section__title">Company</div>
                ${row('Company Name', company)}
                ${nzbn ? row('NZBN', nzbn) : ''}
                ${row('Industry', industry)}
                ${row('Business Type', bizType)}
            </div>`;

            html += `<div class="review-section">
                <div class="review-section__title">Contact</div>
                ${row('Name', contactName)}
                ${row('Email', email)}
                ${row('Phone', phone)}
                ${apEmail ? row('AP Email', apEmail) : ''}
            </div>`;

            const billingLine2 = bAddr2 ? esc(bAddr2) : '';
            html += `<div class="review-section">
                <div class="review-section__title">Billing Address</div>
                <div class="review-row"><span class="review-row__label">Address</span><span class="review-row__value">${esc(bAddr1)}${billingLine2 ? '<br>' + billingLine2 : ''}</span></div>
                ${row('City / Region', [bCity, bRegion].filter(Boolean).join(', '))}
                ${row('Postcode', bPostcode)}
                <div class="review-row"><span class="review-row__label">Shipping</span><span class="review-row__value">${sameAsBilling ? 'Same as billing' : 'Separate address below'}</span></div>
            </div>`;

            if (!sameAsBilling) {
                const sAddr1 = get('biz-shipping-address1');
                const sAddr2 = get('biz-shipping-address2');
                const sCity = get('biz-shipping-city');
                const sRegion = optText('biz-shipping-region');
                const sPostcode = get('biz-shipping-postcode');
                html += `<div class="review-section">
                    <div class="review-section__title">Shipping Address</div>
                    <div class="review-row"><span class="review-row__label">Address</span><span class="review-row__value">${esc(sAddr1)}${sAddr2 ? '<br>' + esc(sAddr2) : ''}</span></div>
                    ${row('City / Region', [sCity, sRegion].filter(Boolean).join(', '))}
                    ${row('Postcode', sPostcode)}
                </div>`;
            }

            if (net30) {
                html += `<div class="review-section">
                    <div class="review-section__title">Net 30 Terms</div>
                    ${row('Applying for Net 30', 'Yes')}
                    ${row('Estimated Monthly Spend', spendText)}
                </div>`;
            }

            const reviewContent = document.getElementById('review-content');
            if (reviewContent) reviewContent.innerHTML = html;
        },

        toggleShippingFields(show) {
            const fields = document.getElementById('biz-shipping-fields');
            if (!fields) return;
            fields.hidden = !show;
            fields.querySelectorAll('[id^="biz-shipping-"]').forEach(el => {
                if (el.tagName === 'INPUT' || el.tagName === 'SELECT') {
                    if (el.id === 'biz-shipping-address2') return;
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
            const btn = document.getElementById('biz-submit-btn');
            const msgEl = document.getElementById('business-form-message');

            const company_name = (document.getElementById('biz-company')?.value || '').trim();
            const nzbn = (document.getElementById('biz-nzbn')?.value || '').trim();
            const contact_name = (document.getElementById('biz-contact-name')?.value || '').trim();
            const contact_email = (document.getElementById('biz-email')?.value || '').trim();
            const contact_phone = (document.getElementById('biz-phone')?.value || '').trim();
            const industry = document.getElementById('biz-industry')?.value || '';
            const business_type = document.getElementById('biz-type')?.value || '';
            const ap_email = (document.getElementById('biz-ap-email')?.value || '').trim();

            const billing_address = this.gatherAddressFields('billing');
            const sameAsBilling = document.getElementById('biz-same-as-billing')?.checked;
            const shipping_address = sameAsBilling ? { ...billing_address } : this.gatherAddressFields('shipping');

            const apply_net30 = document.getElementById('biz-net30')?.checked || false;
            const estimated_monthly_spend = document.getElementById('biz-spend')?.value || '';
            const creditRefFile = document.getElementById('biz-credit-ref')?.files?.[0] || null;

            if (!company_name || !contact_name || !contact_email || !contact_phone || !industry || !business_type) {
                this.showMessage(msgEl, 'Please fill in all required fields.', 'error');
                return;
            }

            if (creditRefFile && creditRefFile.size > 5 * 1024 * 1024) {
                this.showMessage(msgEl, 'Credit reference file must be under 5 MB.', 'error');
                return;
            }

            btn.disabled = true;
            btn.textContent = 'Submitting...';

            try {
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

                const res = await (this._isReapply ? API.reapplyBusiness(payload) : API.applyBusiness(payload));
                if (res.ok) {
                    this.showThankYou();
                } else {
                    const errMsg = (typeof res.error === 'string' ? res.error : res.error?.message) || 'Could not submit application. Please try again.';
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

            const esc = typeof Security !== 'undefined' ? Security.escapeHtml.bind(Security) : (s) => String(s).replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));

            content.innerHTML = `
                <span class="business-status__badge ${badge.cls}">${esc(badge.label)}</span>
                ${companyName ? `<p><strong>Company:</strong> ${esc(companyName)}</p>` : ''}
                ${submittedDate ? `<p><strong>Submitted:</strong> ${submittedDate}</p>` : ''}
                ${status === 'pending' ? '<p>Your application is being reviewed. We\'ll be in touch shortly.</p>' : ''}
                ${status === 'approved' ? '<p>Your business account is active. <a href="/html/account/business.html">Go to your Business Dashboard</a>.</p>' : ''}
                ${status === 'rejected' ? '<p>Unfortunately your application was not approved. Please <a href="/html/contact.html">contact us</a> if you have questions, or complete the form below to reapply.</p>' : ''}
            `;

            section.hidden = false;
        },

        showThankYou() {
            const form = document.getElementById('business-form');
            const thankYou = document.getElementById('business-thank-you');
            if (form) form.hidden = true;
            if (thankYou) thankYou.hidden = false;
            window.scrollTo({ top: 0, behavior: 'smooth' });
        },

        showMessage(el, text, type) {
            if (!el) return;
            el.textContent = text;
            el.className = type === 'success'
                ? 'business-form__message--success'
                : 'business-form__message--error';
            el.hidden = false;
        }
    };

    document.addEventListener('DOMContentLoaded', () => BusinessApplyPage.init());
})();
