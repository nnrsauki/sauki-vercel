const fetch = require('node-fetch');
const { Client } = require('pg');
const HttpsProxyAgent = require('https-proxy-agent');

// KEYS (Vercel provides POSTGRES_URL automatically)
const AMIGO_API_KEY = process.env.AMIGO_API_KEY;
const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY;
const QUOTAGUARD_URL = process.env.QUOTAGUARD_URL; 
const CONNECTION_STRING = process.env.POSTGRES_URL; 

const PLAN_MAP = {
    'mtn-1gb': 1001, 'mtn-2gb': 6666, 'mtn-5gb': 9999, 'mtn-10gb': 1110,
    'glo-1gb': 206, 'glo-5gb': 222
};
const PRICE_MAP = {
    'mtn-1gb': 500, 'mtn-2gb': 1000, 'mtn-5gb': 2000, 'mtn-10gb': 4000,
    'glo-1gb': 500, 'glo-5gb': 2500
};
const NETWORK_MAP = { 'mtn': 1, 'glo': 2 };

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({error: 'Method Not Allowed'});

    const { transaction_id, mobile_number, network, plan_id, ported } = req.body;

    if (!transaction_id || !mobile_number) return res.status(400).json({ error: 'Missing details' });

    try {
        // 1. Verify Payment with Flutterwave
        const flwRes = await fetch(`https://api.flutterwave.com/v3/transactions/${transaction_id}/verify`, {
            headers: { 'Authorization': `Bearer ${FLW_SECRET_KEY}` }
        });
        const flwData = await flwRes.json();

        if (flwData.status !== 'success' || flwData.data.status !== 'successful') {
            return res.status(400).json({ error: 'Payment Verification Failed' });
        }
        
        if (flwData.data.amount < PRICE_MAP[plan_id]) {
            return res.status(400).json({ error: 'Insufficient Amount Paid' });
        }

        // 2. Connect DB (Vercel Neon)
        const client = new Client({
            connectionString: CONNECTION_STRING,
            ssl: { rejectUnauthorized: false }
        });
        await client.connect();

        // 3. Idempotency Check
        const check = await client.query('SELECT id FROM transactions WHERE reference = $1', [String(transaction_id)]);
        if (check.rows.length > 0) {
            await client.end();
            return res.status(400).json({ error: 'Transaction already processed' });
        }

        // 4. Send Data via Amigo (with Proxy)
        const payload = {
            network: NETWORK_MAP[network],
            mobile_number: mobile_number,
            plan: PLAN_MAP[plan_id],
            Ported_number: !!ported
        };

        const options = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': AMIGO_API_KEY },
            body: JSON.stringify(payload)
        };

        if (QUOTAGUARD_URL) {
            options.agent = new HttpsProxyAgent(QUOTAGUARD_URL);
        }

        const amigoRes = await fetch('https://amigo.ng/api/data/', options);
        const amigoResult = await amigoRes.json();

        // 5. Save Record
        const status = amigoResult.success ? 'success' : 'failed';
        await client.query(
            `INSERT INTO transactions (phone_number, network, plan_id, status, reference, api_response, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [mobile_number, network, plan_id, status, String(transaction_id), JSON.stringify(amigoResult)]
        );
        await client.end();

        if (amigoResult.success) {
            return res.status(200).json({ success: true, message: 'Data Delivered Successfully!' });
        } else {
            return res.status(400).json({ success: false, error: 'Amigo Error: ' + amigoResult.message });
        }

    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: error.message });
    }
}


          
