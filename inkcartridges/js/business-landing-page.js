/**
 * B2B Landing Page — Auth-aware CTA and status banner
 */
document.addEventListener('DOMContentLoaded', () => {
    initFaq();
    initCtaButtons();
});

function initFaq() {
    document.querySelectorAll('.b2b-faq-item__q').forEach((btn) => {
        btn.addEventListener('click', () => {
            const item = btn.closest('.b2b-faq-item');
            const isOpen = item.classList.contains('open');
            // Close all
            document.querySelectorAll('.b2b-faq-item.open').forEach((el) => {
                el.classList.remove('open');
                el.querySelector('.b2b-faq-item__q').setAttribute('aria-expanded', 'false');
            });
            // Open clicked if it was closed
            if (!isOpen) {
                item.classList.add('open');
                btn.setAttribute('aria-expanded', 'true');
            }
        });
    });
}

async function initCtaButtons() {
    const heroCta = document.getElementById('hero-cta-btn');
    const bottomCta = document.getElementById('bottom-cta-btn');
    const statusBanner = document.getElementById('status-banner');
    const statusBannerText = document.getElementById('status-banner-text');

    // Wait for Auth to finish initialising before checking login state
    if (window.Auth?.readyPromise) {
        await window.Auth.readyPromise;
    }

    let status = null;
    try {
        if (window.API && window.Auth?.user) {
            const res = await window.API.getBusinessStatus();
            if (res?.ok) status = res.data?.status ?? null;
        }
    } catch {
        // Not logged in or backend unavailable — keep defaults
    }

    let ctaText = 'Apply Now';
    let ctaHref = '/html/business/apply.html';

    if (!window.Auth?.user) {
        ctaText = 'Apply Now';
        ctaHref = '/html/account/login.html?tab=register&redirect=/html/business/apply.html';
    } else if (status === 'approved') {
        ctaText = 'Go to Business Dashboard';
        ctaHref = '/html/account/business.html';
    } else if (status === 'pending') {
        ctaText = 'Check Application Status';
        ctaHref = '/html/business/apply.html';
    } else if (status === 'declined' || status === 'rejected') {
        ctaText = 'Reapply Now';
        ctaHref = '/html/business/apply.html';
    }

    function setCta(el) {
        if (!el) return;
        const textNode = [...el.childNodes].find((n) => n.nodeType === 3 && n.textContent.trim());
        if (textNode) textNode.textContent = ' ' + ctaText;
        el.href = ctaHref;
    }
    setCta(heroCta);
    setCta(bottomCta);

    // Status banner
    if (statusBanner && statusBannerText) {
        if (status === 'pending') {
            statusBannerText.textContent = 'Your application is currently under review. We\'ll email you within 1–2 business days.';
            statusBanner.classList.add('visible');
        } else if (status === 'declined' || status === 'rejected') {
            statusBannerText.textContent = 'Your previous application was not approved. You can reapply below.';
            statusBanner.classList.add('visible');
        }
    }
}
