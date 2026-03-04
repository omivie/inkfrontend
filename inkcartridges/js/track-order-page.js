        // Track order form handler
        document.getElementById('track-order-form')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const orderNumber = document.getElementById('order-number').value.trim();

            if (!orderNumber) return;

            // Redirect to order detail page
            window.location.href = `/html/account/order-detail.html?order=${encodeURIComponent(orderNumber)}`;
        });
