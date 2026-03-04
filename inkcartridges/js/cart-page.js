        // Track cart page view
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(() => {
                if (typeof CartAnalytics !== 'undefined') {
                    CartAnalytics.trackCartViewed();
                }
            }, 500);
        });
