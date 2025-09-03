// 🚀 BACKEND API ENDPOINTS - NYGA DARTS PREMIUM PAYMENTS
// Node.js/Express backend dla obsługi płatności

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
// PayPal SDK (było używane w kodzie jako PayPal.core... ale brakowało require)
const PayPal = require('@paypal/checkout-server-sdk');

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const axios = require('axios');
const crypto = require('crypto');

const app = express();

// 🔒 Middleware bezpieczeństwa
app.use(helmet());
app.use(cors({
    origin: process.env.FRONTEND_URL,
    credentials: true
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minut
    max: 100 // max 100 requests per 15 min
});
app.use(limiter);

// Używamy JSON parsera dla normalnych endpointów
app.use(express.json({ limit: '10mb' }));
// NIE dodajemy globalnie express.raw, bo wtedy zwykłe endpointy nie dostaną sparsowanego JSON.
// Dla Stripe webhook użyjemy express.raw tylko w tej jednej trasie.

// 💳 STRIPE ENDPOINTS
// Tworzenie sesji płatności Stripe
app.post('/api/payments/stripe/create-session', async (req, res) => {
    try {
        const { plan, userEmail } = req.body;
        
        const priceIds = {
            monthly: 'price_monthly_9_99_eur',
            quarterly: 'price_quarterly_24_99_eur', 
            yearly: 'price_yearly_89_99_eur'
        };

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price: priceIds[plan],
                quantity: 1,
            }],
            mode: 'subscription',
            customer_email: userEmail,
            success_url: `${process.env.FRONTEND_URL}/premium/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.FRONTEND_URL}/premium/cancel`,
            metadata: {
                plan: plan,
                userEmail: userEmail
            }
        });

        res.json({ sessionId: session.id, url: session.url });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Webhook Stripe
app.post('/api/webhooks/stripe', express.raw({type: 'application/json'}), (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        // Aktywuj premium dla użytkownika
        activatePremiumForUser(session.metadata.userEmail, session.metadata.plan);
    }

    res.json({received: true});
});

// 🎯 PAYPAL ENDPOINTS
const paypalEnvironment = process.env.NODE_ENV === 'production' 
    ? new PayPal.core.LiveEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET)
    : new PayPal.core.SandboxEnvironment(process.env.PAYPAL_CLIENT_ID, process.env.PAYPAL_CLIENT_SECRET);

const paypalClient = new PayPal.core.PayPalHttpClient(paypalEnvironment);

app.post('/api/payments/paypal/create-order', async (req, res) => {
    try {
        const { plan, userEmail } = req.body;
        
        const amounts = {
            monthly: '9.99',
            quarterly: '24.99',
            yearly: '89.99'
        };

        const request = new PayPal.orders.OrdersCreateRequest();
        request.prefer("return=representation");
        request.requestBody({
            intent: 'CAPTURE',
            purchase_units: [{
                amount: {
                    currency_code: 'EUR',
                    value: amounts[plan]
                },
                description: `Nyga Darts Premium - ${plan}`
            }],
            application_context: {
                return_url: `${process.env.FRONTEND_URL}/premium/paypal/success`,
                cancel_url: `${process.env.FRONTEND_URL}/premium/paypal/cancel`
            }
        });

        const order = await paypalClient.execute(request);
        res.json({ orderID: order.result.id });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 🎮 PAYSAFECARD ENDPOINTS  
app.post('/api/payments/paysafecard/create', async (req, res) => {
    try {
        const { plan, userEmail } = req.body;
        
        const amounts = {
            monthly: 999, // Kwoty w groszach
            quarterly: 2499,
            yearly: 8999
        };

        const response = await axios.post('https://api.paysafecard.com/v1/payments', {
            type: "PAYSAFECARD",
            amount: amounts[plan],
            currency: "EUR",
            redirect: {
                success_url: `${process.env.FRONTEND_URL}/premium/paysafecard/success`,
                failure_url: `${process.env.FRONTEND_URL}/premium/paysafecard/failure`
            },
            notification_url: `${process.env.BACKEND_URL}/api/webhooks/paysafecard`,
            customer: {
                id: userEmail
            }
        }, {
            headers: {
                'Authorization': `Basic ${Buffer.from(process.env.PAYSAFECARD_API_KEY + ':').toString('base64')}`,
                'Content-Type': 'application/json'
            }
        });

        res.json({ 
            paymentId: response.data.id,
            redirectUrl: response.data.redirect.auth_url 
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 📱 BLIK ENDPOINTS (PayU)
app.post('/api/payments/blik/create', async (req, res) => {
    try {
        const { plan, userEmail, blikCode } = req.body;
        
        const amounts = {
            monthly: 999, // Kwoty w groszach
            quarterly: 2499,
            yearly: 8999
        };

        // Najpierw pobierz token autoryzacyjny PayU
        const authResponse = await axios.post('https://secure.payu.com/pl/standard/user/oauth/authorize', {
            grant_type: 'client_credentials',
            client_id: process.env.PAYU_CLIENT_ID,
            client_secret: process.env.PAYU_CLIENT_SECRET
        });

        const accessToken = authResponse.data.access_token;

        // Utwórz płatność BLIK
        const paymentResponse = await axios.post('https://secure.payu.com/api/v2_1/orders', {
            notifyUrl: `${process.env.BACKEND_URL}/api/webhooks/payu`,
            customerIp: req.ip,
            merchantPosId: process.env.PAYU_POS_ID,
            description: `Nyga Darts Premium - ${plan}`,
            currencyCode: 'PLN', // BLIK działa w PLN
            totalAmount: amounts[plan],
            buyer: {
                email: userEmail
            },
            payMethods: {
                payMethod: {
                    type: "BLIK",
                    authorizationCode: blikCode
                }
            },
            products: [{
                name: `Premium ${plan}`,
                unitPrice: amounts[plan],
                quantity: 1
            }]
        }, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            }
        });

        res.json({ 
            orderId: paymentResponse.data.orderId,
            redirectUri: paymentResponse.data.redirectUri 
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 🔄 WEBHOOK HANDLERS
app.post('/api/webhooks/paysafecard', (req, res) => {
    const { eventType, data } = req.body;
    
    if (eventType === 'PAYMENT_COMPLETED') {
        // Aktywuj premium
        activatePremiumForUser(data.customer.id, 'unknown'); // Plan z metadanych
    }
    
    res.status(200).send('OK');
});

app.post('/api/webhooks/payu', (req, res) => {
    const { order } = req.body;
    
    if (order.status === 'COMPLETED') {
        // Aktywuj premium na podstawie orderId
        activatePremiumFromOrder(order.orderId);
    }
    
    res.status(200).send('OK');
});

// 🎯 HELPER FUNCTIONS
async function activatePremiumForUser(userEmail, plan) {
    // Tu implementujesz logikę aktywacji premium w bazie danych
    console.log(`Aktywowanie premium ${plan} dla ${userEmail}`);
    
    // Przykład z MongoDB
    // await User.findOneAndUpdate(
    //     { email: userEmail },
    //     { 
    //         isPremium: true,
    //         premiumPlan: plan,
    //         premiumExpiry: calculateExpiry(plan)
    //     }
    // );
}

function calculateExpiry(plan) {
    const now = new Date();
    switch(plan) {
        case 'monthly':
            return new Date(now.setMonth(now.getMonth() + 1));
        case 'quarterly':
            return new Date(now.setMonth(now.getMonth() + 3));
        case 'yearly':
            return new Date(now.setFullYear(now.getFullYear() + 1));
        default:
            return new Date(now.setMonth(now.getMonth() + 1));
    }
}

// 📊 STATUS ENDPOINTS
app.get('/api/premium/status/:email', async (req, res) => {
    try {
        const { email } = req.params;
        // Sprawdź status premium w bazie danych
        // const user = await User.findOne({ email });
        
        res.json({
            isPremium: false, // user?.isPremium || false,
            plan: null, // user?.premiumPlan,
            expiry: null // user?.premiumExpiry
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Payment API running on port ${PORT}`);
});

module.exports = app;
