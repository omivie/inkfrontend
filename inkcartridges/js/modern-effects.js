/**
 * MODERN EFFECTS JS
 * Scroll animations, ripple effects, and smooth interactions
 */

const ModernEffects = {
    // Initialize all effects
    init() {
        this.initScrollAnimations();
        this.initImageLoading();
        this.initRippleEffect();
        this.initCartBounce();
        this.initStaggeredLists();
        this.initParallax();
    },

    // =========================================
    // SCROLL ANIMATIONS
    // Animate elements when they enter viewport
    // =========================================
    initScrollAnimations() {
        // Elements to animate on scroll
        const animateSelectors = [
            'section',
            '.product-card',
            '.confirmation-card',
            '.checkout-section',
            '.hero-content',
            '.feature-card',
            '.brand-card',
            '.category-card',
            '.stat-card',
            '.faq-item'
        ];

        const observerOptions = {
            root: null,
            rootMargin: '0px 0px -50px 0px',
            threshold: 0.1
        };

        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('in-view', 'visible');
                    // Unobserve after animation (performance)
                    observer.unobserve(entry.target);
                }
            });
        }, observerOptions);

        // Observe all matching elements
        animateSelectors.forEach(selector => {
            document.querySelectorAll(selector).forEach(el => {
                // Skip hero section - keep it static
                if (el.classList.contains('hero') || el.closest('.hero')) {
                    el.style.opacity = '1';
                    el.style.transform = 'none';
                    return;
                }
                // Add class to enable animation (CSS handles the initial state)
                el.classList.add('will-animate');
                observer.observe(el);
            });
        });

        // Mark sections that are already in view immediately
        requestAnimationFrame(() => {
            document.querySelectorAll('section.will-animate').forEach(section => {
                const rect = section.getBoundingClientRect();
                if (rect.top < window.innerHeight && rect.bottom > 0) {
                    section.classList.add('in-view', 'visible');
                }
            });
        });
    },

    // =========================================
    // IMAGE LOADING
    // Smooth fade-in when images load
    // =========================================
    initImageLoading() {
        document.querySelectorAll('img').forEach(img => {
            // Skip already loaded images
            if (img.complete) {
                img.classList.add('loaded');
                return;
            }

            img.addEventListener('load', () => {
                img.classList.add('loaded');
            }, { once: true });
        });

        // Also handle dynamically loaded images
        const imgObserver = new MutationObserver(mutations => {
            mutations.forEach(mutation => {
                mutation.addedNodes.forEach(node => {
                    if (node.nodeName === 'IMG') {
                        this.setupImageLoad(node);
                    } else if (node.querySelectorAll) {
                        node.querySelectorAll('img').forEach(img => {
                            this.setupImageLoad(img);
                        });
                    }
                });
            });
        });

        imgObserver.observe(document.body, {
            childList: true,
            subtree: true
        });
    },

    setupImageLoad(img) {
        if (img.complete) {
            img.classList.add('loaded');
            return;
        }

        img.addEventListener('load', () => {
            img.classList.add('loaded');
        }, { once: true });
    },

    // =========================================
    // RIPPLE EFFECT
    // Material design ripple on buttons
    // =========================================
    initRippleEffect() {
        document.addEventListener('click', (e) => {
            const btn = e.target.closest('.btn, button[type="submit"], .product-card__add-btn');
            if (!btn) return;

            // Create ripple element
            const ripple = document.createElement('span');
            ripple.classList.add('ripple-effect');

            // Get click position relative to button
            const rect = btn.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            // Size the ripple
            const size = Math.max(rect.width, rect.height) * 2;
            ripple.style.width = ripple.style.height = `${size}px`;
            ripple.style.left = `${x - size / 2}px`;
            ripple.style.top = `${y - size / 2}px`;

            // Add to button
            btn.style.position = 'relative';
            btn.style.overflow = 'hidden';
            btn.appendChild(ripple);

            // Remove after animation
            setTimeout(() => ripple.remove(), 600);
        });
    },

    // =========================================
    // CART BADGE BOUNCE
    // Animate cart count when it changes
    // =========================================
    initCartBounce() {
        // Watch for cart count changes
        const cartCountEl = document.querySelector('.cart-count, #cart-count, [data-cart-count]');
        if (!cartCountEl) return;

        let lastCount = cartCountEl.textContent;

        const observer = new MutationObserver(() => {
            const newCount = cartCountEl.textContent;
            if (newCount !== lastCount) {
                lastCount = newCount;
                cartCountEl.classList.add('bounce');
                setTimeout(() => cartCountEl.classList.remove('bounce'), 500);
            }
        });

        observer.observe(cartCountEl, { childList: true, characterData: true, subtree: true });
    },

    // =========================================
    // STAGGERED LIST ANIMATIONS
    // Animate list items with delay
    // =========================================
    initStaggeredLists() {
        const staggerSelectors = [
            '.products-grid',
            '#products-grid',
            '.order-items',
            '#order-items',
            '.cart-items'
        ];

        staggerSelectors.forEach(selector => {
            const container = document.querySelector(selector);
            if (!container) return;

            // Add stagger class
            container.classList.add('stagger-children');

            // Watch for new children being added
            const observer = new MutationObserver((mutations) => {
                mutations.forEach(mutation => {
                    let delay = 0;
                    mutation.addedNodes.forEach(node => {
                        if (node.nodeType === 1) {
                            node.style.opacity = '0';
                            node.style.animation = `staggerFadeIn 0.5s ease-out ${delay}s forwards`;
                            delay += 0.05;
                        }
                    });
                });
            });

            observer.observe(container, { childList: true });
        });
    },

    // =========================================
    // SUBTLE PARALLAX
    // Disabled for hero - keeping it static
    // =========================================
    initParallax() {
        // Parallax disabled - hero section stays static
        return;
    },

    // =========================================
    // UTILITY: Add animation to element
    // =========================================
    animate(element, animationClass, duration = 500) {
        return new Promise(resolve => {
            element.classList.add(animationClass);
            setTimeout(() => {
                element.classList.remove(animationClass);
                resolve();
            }, duration);
        });
    },

    // =========================================
    // UTILITY: Bounce animation
    // =========================================
    bounce(element) {
        element.style.animation = 'none';
        element.offsetHeight; // Trigger reflow
        element.style.animation = 'badgeBounce 0.5s ease-out';
    },

    // =========================================
    // UTILITY: Shake animation
    // =========================================
    shake(element) {
        element.style.animation = 'none';
        element.offsetHeight;
        element.style.animation = 'shake 0.5s ease-out';
    }
};

// Add shake keyframes dynamically
const shakeStyle = document.createElement('style');
shakeStyle.textContent = `
    @keyframes shake {
        0%, 100% { transform: translateX(0); }
        20% { transform: translateX(-5px); }
        40% { transform: translateX(5px); }
        60% { transform: translateX(-5px); }
        80% { transform: translateX(5px); }
    }
`;
document.head.appendChild(shakeStyle);

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => ModernEffects.init());
} else {
    ModernEffects.init();
}

// Make available globally
window.ModernEffects = ModernEffects;
