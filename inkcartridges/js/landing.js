/**
 * LANDING.JS
 * ==========
 * Landing page specific behaviors:
 * - Sticky header on scroll
 * - FAQ accordion animation
 * - Newsletter form handling
 */

'use strict';

(function() {

    // ============================================
    // STICKY HEADER
    // ============================================

    const header = document.querySelector('.site-header');
    const hero = document.querySelector('.hero');

    if (header && hero) {
        const observer = new IntersectionObserver(
            ([entry]) => {
                header.classList.toggle('site-header--sticky', !entry.isIntersecting);
            },
            { threshold: 0, rootMargin: '-1px 0px 0px 0px' }
        );
        observer.observe(hero);
    }

    // ============================================
    // FAQ ACCORDION ANIMATION
    // ============================================

    const faqItems = document.querySelectorAll('.faq-section details');

    faqItems.forEach(details => {
        const summary = details.querySelector('summary');
        const content = details.querySelector('.faq-answer');
        if (!summary || !content) return;

        summary.addEventListener('click', (e) => {
            e.preventDefault();

            if (details.open) {
                // Closing
                content.style.maxHeight = content.scrollHeight + 'px';
                requestAnimationFrame(() => {
                    content.style.maxHeight = '0';
                    content.style.opacity = '0';
                });
                content.addEventListener('transitionend', function handler() {
                    details.open = false;
                    content.removeEventListener('transitionend', handler);
                }, { once: true });
            } else {
                // Opening
                details.open = true;
                const height = content.scrollHeight;
                content.style.maxHeight = '0';
                content.style.opacity = '0';
                requestAnimationFrame(() => {
                    content.style.maxHeight = height + 'px';
                    content.style.opacity = '1';
                });
            }
        });
    });

    // ============================================
    // NEWSLETTER FORM
    // ============================================

    const newsletterForm = document.querySelector('.newsletter__form');

    if (newsletterForm) {
        newsletterForm.addEventListener('submit', async (e) => {
            e.preventDefault();

            const emailInput = newsletterForm.querySelector('input[type="email"]');
            const submitBtn = newsletterForm.querySelector('button[type="submit"]');
            const email = emailInput.value.trim();

            if (!email) return;

            const originalText = submitBtn.textContent;
            submitBtn.textContent = 'Subscribing...';
            submitBtn.disabled = true;

            try {
                if (typeof API !== 'undefined' && API.subscribe) {
                    await API.subscribe({ email: email, source: 'landing' });
                }

                if (typeof showToast === 'function') {
                    showToast('Thanks for subscribing! Check your inbox.', 'success');
                }
                emailInput.value = '';
            } catch {
                if (typeof showToast === 'function') {
                    showToast('Could not subscribe. Please try again.', 'error');
                }
            }

            submitBtn.textContent = originalText;
            submitBtn.disabled = false;
        });
    }

})();
