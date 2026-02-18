/**
 * Cart Analytics Routes
 * Add these routes to your Express backend
 *
 * Required: supabase client configured with service role key
 */

const express = require('express');
const router = express.Router();

// Assuming you have supabase client set up like this:
// const { createClient } = require('@supabase/supabase-js');
// const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

/**
 * POST /api/analytics/cart-event
 * Receive and store cart analytics events from frontend
 */
router.post('/cart-event', async (req, res) => {
    try {
        const event = req.body;

        // Validate required fields
        if (!event.session_id || !event.event_type) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: session_id and event_type'
            });
        }

        // Add server-side metadata
        const eventData = {
            session_id: event.session_id,
            user_id: event.user_id || null,
            event_type: event.event_type,
            timestamp: event.timestamp || new Date().toISOString(),
            page_url: event.page_url || null,
            product_id: event.product_id || null,
            product_sku: event.product_sku || null,
            product_name: event.product_name || null,
            product_price: event.product_price || null,
            quantity: event.quantity || null,
            cart_value: event.cart_value || null,
            item_count: event.item_count || null,
            checkout_started: event.checkout_started || false,
            payment_started: event.payment_started || false,
            order_number: event.order_number || null,
            order_total: event.order_total || null,
            user_agent: req.headers['user-agent'] || null,
            ip_address: req.ip || req.connection?.remoteAddress || null
        };

        // Insert into database
        const { data, error } = await req.supabase
            .from('cart_events')
            .insert(eventData)
            .select()
            .single();

        if (error) {
            console.error('Failed to insert cart event:', error);
            return res.status(500).json({
                success: false,
                error: 'Failed to store event'
            });
        }

        res.json({
            success: true,
            data: { id: data.id }
        });

    } catch (error) {
        console.error('Cart event error:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

/**
 * GET /api/analytics/cart-summary
 * Get aggregated cart analytics summary
 * Query params: period (7d, 30d, 90d), start_date, end_date
 */
router.get('/cart-summary', async (req, res) => {
    try {
        // Require admin authentication
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({
                success: false,
                error: 'Admin access required'
            });
        }

        const { period, start_date, end_date } = req.query;

        // Calculate date range
        let startDate, endDate;
        endDate = end_date ? new Date(end_date) : new Date();

        if (start_date) {
            startDate = new Date(start_date);
        } else {
            // Default periods
            const periodDays = {
                '7d': 7,
                '30d': 30,
                '90d': 90,
                '1y': 365
            };
            const days = periodDays[period] || 30;
            startDate = new Date(endDate);
            startDate.setDate(startDate.getDate() - days);
        }

        // Get analytics using the database function
        const { data, error } = await req.supabase
            .rpc('get_cart_analytics', {
                start_date: startDate.toISOString(),
                end_date: endDate.toISOString()
            });

        if (error) {
            console.error('Failed to get cart analytics:', error);

            // Fallback: query directly
            const { data: events, error: queryError } = await req.supabase
                .from('cart_events')
                .select('event_type, cart_value, order_total, session_id')
                .gte('created_at', startDate.toISOString())
                .lte('created_at', endDate.toISOString());

            if (queryError) {
                return res.status(500).json({
                    success: false,
                    error: 'Failed to fetch analytics'
                });
            }

            // Aggregate manually
            const summary = {
                add_to_cart: 0,
                cart_viewed: 0,
                checkout_started: 0,
                payment_started: 0,
                order_completed: 0,
                potential_abandonment: 0,
                sessions: new Set()
            };

            events.forEach(e => {
                summary.sessions.add(e.session_id);
                if (summary[e.event_type] !== undefined) {
                    summary[e.event_type]++;
                }
            });

            return res.json({
                success: true,
                data: {
                    ...summary,
                    sessions: summary.sessions.size
                }
            });
        }

        res.json({
            success: true,
            data: data
        });

    } catch (error) {
        console.error('Cart summary error:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

/**
 * GET /api/analytics/abandoned-carts
 * Get list of abandoned cart sessions
 * Query params: page, limit, min_value
 */
router.get('/abandoned-carts', async (req, res) => {
    try {
        // Require admin authentication
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({
                success: false,
                error: 'Admin access required'
            });
        }

        const page = parseInt(req.query.page) || 1;
        const limit = Math.min(parseInt(req.query.limit) || 20, 100);
        const minValue = parseFloat(req.query.min_value) || 0;
        const offset = (page - 1) * limit;

        // Query abandoned carts view
        let query = req.supabase
            .from('abandoned_carts')
            .select('*', { count: 'exact' })
            .gte('cart_value', minValue)
            .order('last_activity', { ascending: false })
            .range(offset, offset + limit - 1);

        const { data, error, count } = await query;

        if (error) {
            console.error('Failed to get abandoned carts:', error);
            return res.status(500).json({
                success: false,
                error: 'Failed to fetch abandoned carts'
            });
        }

        // Enrich with user email if available
        const enrichedData = await Promise.all(
            data.map(async (cart) => {
                if (cart.user_id) {
                    const { data: userData } = await req.supabase
                        .from('profiles')
                        .select('email, first_name, last_name')
                        .eq('id', cart.user_id)
                        .single();

                    if (userData) {
                        return {
                            ...cart,
                            user_email: userData.email,
                            user_name: `${userData.first_name || ''} ${userData.last_name || ''}`.trim()
                        };
                    }
                }
                return cart;
            })
        );

        res.json({
            success: true,
            data: {
                carts: enrichedData,
                pagination: {
                    page,
                    limit,
                    total: count,
                    pages: Math.ceil(count / limit)
                }
            }
        });

    } catch (error) {
        console.error('Abandoned carts error:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

/**
 * GET /api/analytics/cart-funnel
 * Get conversion funnel data
 */
router.get('/cart-funnel', async (req, res) => {
    try {
        // Require admin authentication
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({
                success: false,
                error: 'Admin access required'
            });
        }

        const days = parseInt(req.query.days) || 30;
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);

        const { data, error } = await req.supabase
            .from('cart_events')
            .select('event_type, session_id')
            .gte('created_at', startDate.toISOString());

        if (error) {
            return res.status(500).json({
                success: false,
                error: 'Failed to fetch funnel data'
            });
        }

        // Count unique sessions per event type
        const funnel = {
            cart_viewed: new Set(),
            add_to_cart: new Set(),
            checkout_started: new Set(),
            payment_started: new Set(),
            order_completed: new Set()
        };

        data.forEach(event => {
            if (funnel[event.event_type]) {
                funnel[event.event_type].add(event.session_id);
            }
        });

        // Convert to counts and calculate rates
        const cartViewed = funnel.cart_viewed.size;
        const addToCart = funnel.add_to_cart.size;
        const checkoutStarted = funnel.checkout_started.size;
        const paymentStarted = funnel.payment_started.size;
        const orderCompleted = funnel.order_completed.size;

        const baseCount = Math.max(cartViewed, addToCart, 1);

        res.json({
            success: true,
            data: {
                funnel: [
                    {
                        stage: 'Cart Viewed',
                        count: cartViewed,
                        rate: 100
                    },
                    {
                        stage: 'Added to Cart',
                        count: addToCart,
                        rate: ((addToCart / baseCount) * 100).toFixed(1)
                    },
                    {
                        stage: 'Checkout Started',
                        count: checkoutStarted,
                        rate: ((checkoutStarted / baseCount) * 100).toFixed(1)
                    },
                    {
                        stage: 'Payment Started',
                        count: paymentStarted,
                        rate: ((paymentStarted / baseCount) * 100).toFixed(1)
                    },
                    {
                        stage: 'Order Completed',
                        count: orderCompleted,
                        rate: ((orderCompleted / baseCount) * 100).toFixed(1)
                    }
                ],
                abandonmentRate: addToCart > 0
                    ? (((addToCart - orderCompleted) / addToCart) * 100).toFixed(1)
                    : 0,
                period: { days, start: startDate.toISOString(), end: new Date().toISOString() }
            }
        });

    } catch (error) {
        console.error('Cart funnel error:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

/**
 * DELETE /api/analytics/cart-events
 * Clean up old analytics data (admin only)
 */
router.delete('/cart-events', async (req, res) => {
    try {
        // Require admin authentication
        if (!req.user || req.user.role !== 'admin') {
            return res.status(403).json({
                success: false,
                error: 'Admin access required'
            });
        }

        const daysToKeep = parseInt(req.query.days_to_keep) || 90;
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);

        const { data, error } = await req.supabase
            .from('cart_events')
            .delete()
            .lt('created_at', cutoffDate.toISOString())
            .select('id');

        if (error) {
            return res.status(500).json({
                success: false,
                error: 'Failed to clean up events'
            });
        }

        res.json({
            success: true,
            data: {
                deleted: data.length,
                cutoff_date: cutoffDate.toISOString()
            }
        });

    } catch (error) {
        console.error('Cleanup error:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

module.exports = router;
