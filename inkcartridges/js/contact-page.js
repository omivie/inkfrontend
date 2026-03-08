    function initContactForm() {
        const form = document.getElementById('contact-form');
        if (!form) return;

        form.addEventListener('submit', async (e) => {
            e.preventDefault();

            // Basic validation
            const name = form.querySelector('#contact-name')?.value.trim();
            const email = form.querySelector('#contact-email')?.value.trim();
            const subjectEl = form.querySelector('#contact-subject');
            const subject = subjectEl?.value || '';
            const message = form.querySelector('#contact-message')?.value.trim();
            const phoneCountry = form.querySelector('#contact-phone-country')?.value || '+64';
            const phoneNumber = form.querySelector('#contact-phone')?.value.trim() || '';
            const phone = phoneNumber ? `${phoneCountry}${phoneNumber}` : '';
            const orderNumber = form.querySelector('#contact-order')?.value.trim() || '';

            if (!name || !email || !subject || subject === 'Please select...' || !message) {
                if (typeof showToast === 'function') {
                    showToast('Please fill in all required fields.', 'error');
                } else {
                    alert('Please fill in all required fields.');
                }
                return;
            }

            const btn = form.querySelector('button[type="submit"]');
            const originalHTML = btn.innerHTML;
            btn.innerHTML = 'Sending...';
            btn.disabled = true;

            const payload = { name, email, subject, message };
            if (phone) payload.phone = phone;
            if (orderNumber) payload.order_number = orderNumber;

            try {
                const result = await API.submitContactForm(payload);
                if (result && result.ok === false) {
                    showToast(result.error || 'Could not send message. Please try again.', 'error');
                } else {
                    showToast('Message sent! We\'ll get back to you shortly.', 'success');
                    form.reset();
                }
            } catch (error) {
                console.error('Contact form error:', error);
                const msg = error.message || 'Could not send message. Please try again.';
                if (typeof showToast === 'function') {
                    showToast(msg, 'error');
                } else {
                    alert(msg);
                }
            }

            btn.innerHTML = originalHTML;
            btn.disabled = false;
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initContactForm);
    } else {
        initContactForm();
    }
