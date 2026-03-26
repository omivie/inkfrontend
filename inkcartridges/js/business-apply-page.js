(function() {
    const BusinessApplyPage = {
        async init() {
            // Wait for auth
            if (typeof Auth !== 'undefined' && Auth.readyPromise) {
                await Auth.readyPromise;
            }

            const isAuth = typeof Auth !== 'undefined' && Auth.isAuthenticated();
            const form = document.getElementById('business-form');
            const loginPrompt = document.getElementById('business-login-prompt');
            const statusSection = document.getElementById('business-status-section');

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

        async handleSubmit(e) {
            e.preventDefault();
            const form = e.target;
            const btn = document.getElementById('biz-submit-btn');
            const msgEl = document.getElementById('business-form-message');

            // Gather values
            const company_name = form.querySelector('#biz-company').value.trim();
            const nzbn = form.querySelector('#biz-nzbn').value.trim();
            const contact_name = form.querySelector('#biz-contact-name').value.trim();
            const contact_email = form.querySelector('#biz-email').value.trim();
            const contact_phone = form.querySelector('#biz-phone').value.trim();
            const estimated_monthly_spend = form.querySelector('#biz-spend').value;
            const industry = form.querySelector('#biz-industry').value;

            // Client-side validation
            if (!company_name || !contact_name || !contact_email || !contact_phone || !estimated_monthly_spend || !industry) {
                this.showMessage(msgEl, 'Please fill in all required fields.', 'error');
                return;
            }

            if (nzbn && !/^\d{13}$/.test(nzbn)) {
                this.showMessage(msgEl, 'NZBN must be exactly 13 digits.', 'error');
                return;
            }

            btn.disabled = true;
            btn.textContent = 'Submitting...';

            const payload = { company_name, contact_name, contact_email, contact_phone, estimated_monthly_spend, industry };
            if (nzbn) payload.nzbn = nzbn;

            try {
                const res = await API.applyBusiness(payload);
                if (res.ok) {
                    this.showMessage(msgEl, 'Application submitted successfully! We\'ll review it and get back to you shortly.', 'success');
                    form.querySelectorAll('input, select').forEach(f => f.disabled = true);
                    btn.textContent = 'Submitted';
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
