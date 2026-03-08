    document.addEventListener('DOMContentLoaded', () => {
        const form = document.querySelector('.business-application-form');
        if (!form) return;

        form.addEventListener('submit', async (e) => {
            e.preventDefault();

            const btn = form.querySelector('button[type="submit"]');
            const originalText = btn.textContent;
            btn.textContent = 'Submitting...';
            btn.disabled = true;

            try {
                // Check if user is authenticated
                if (!Auth.isAuthenticated()) {
                    alert('Please sign in to submit a business account application.');
                    window.location.href = '/html/account/login.html?redirect=' + encodeURIComponent(window.location.pathname);
                    return;
                }

                // Gather form data
                const phoneCountry = document.getElementById('phone-country')?.value || '+64';
                const phoneNumber = document.getElementById('phone')?.value || '';
                const fullPhone = phoneNumber ? `${phoneCountry} ${phoneNumber}` : '';

                const applicationData = {
                    company_name: document.getElementById('business-name')?.value?.trim(),
                    nzbn: document.getElementById('nzbn')?.value?.trim() || null,
                    contact_name: `${document.getElementById('first-name')?.value?.trim() || ''} ${document.getElementById('last-name')?.value?.trim() || ''}`.trim(),
                    contact_email: document.getElementById('email')?.value?.trim(),
                    contact_phone: fullPhone || null,
                    estimated_monthly_spend: document.getElementById('estimated-spend')?.value || null,
                    industry: document.getElementById('industry')?.value || null
                };

                // Validate required fields
                if (!applicationData.company_name || !applicationData.contact_name || !applicationData.contact_email) {
                    throw new Error('Please fill in all required fields.');
                }

                // Submit to backend API
                const response = await API.submitBusinessApplication(applicationData);

                if (response.ok) {
                    // Show success message
                    alert(response.data?.message || 'Your business account application has been submitted. We will review it within 1-2 business days.');
                    window.location.href = '/html/business.html';
                } else {
                    throw new Error(response.error || 'Failed to submit application');
                }

            } catch (error) {
                DebugLog.error('Application error:', error);
                alert(error.message || 'Failed to submit application. Please try again.');
                btn.textContent = originalText;
                btn.disabled = false;
            }
        });
    });
