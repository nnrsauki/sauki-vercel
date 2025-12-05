import fetch from 'node-fetch';
import pg from 'pg';
const { Client } = pg;
import { HttpsProxyAgent } from 'https-proxy-agent';

const AMIGO_API_KEY = process.env.AMIGO_API_KEY;
const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY;
const PROXY_URL = process.env.PROXY_URL; 
const CONNECTION_STRING = process.env.POSTGRES_URL; 

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({error: 'Method Not Allowed'});

    // ADDED: 'name' is now extracted from the request
    const { transaction_id, mobile_number, plan_id, ported, name } = req.body;

    if (!transaction_id || !mobile_number || !plan_id) return res.status(400).json({ error: 'Missing details' });

    const client = new Client({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false } });
    
    try {
        await client.connect();

        // 1. Get Plan & Price
        const planRes = await client.query('SELECT * FROM plans WHERE id = $1', [plan_id]);
        if (planRes.rows.length === 0) { await client.end(); return res.status(400).json({ error: 'Invalid Plan ID' }); }
        const plan = planRes.rows[0];

        // 2. Verify Payment (Flutterwave)
        const flwRes = await fetch(`https://api.flutterwave.com/v3/transactions/${transaction_id}/verify`, { headers: { 'Authorization': `Bearer ${FLW_SECRET_KEY}` } });
        const flwData = await flwRes.json();

        if (flwData.status !== 'success' || flwData.data.status !== 'successful') {
            await client.end();
            return res.status(400).json({ error: 'Payment Verification Failed' });
        }
        
        if (flwData.data.amount < plan.price) {
            await client.end();
            return res.status(400).json({ error: 'Insufficient Amount Paid' });
        }

        // 3. Idempotency Check
        const check = await client.query('SELECT id FROM transactions WHERE reference = $1', [String(transaction_id)]);
        if (check.rows.length > 0) { await client.end(); return res.status(400).json({ error: 'Duplicate Transaction' }); }

        // 4. Send Data via Amigo
        const NET_MAP = { 'mtn': 1, 'glo': 2, 'airtel': 3, '9mobile': 4 };
        const networkInt = NET_MAP[plan.network.toLowerCase()] || 1;

        const options = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': AMIGO_API_KEY },
            body: JSON.stringify({ network: networkInt, mobile_number, plan: plan.plan_id_api, Ported_number: !!ported })
        };

        if (PROXY_URL) options.agent = new HttpsProxyAgent(PROXY_URL);

        const amigoRes = await fetch('https://amigo.ng/api/data/', options);
        const amigoResult = await amigoRes.json();

        // 5. Save Transaction (Now includes customer_name)
        const status = amigoResult.success ? 'success' : 'failed';
        const customerName = name || 'Guest'; // Safety fallback

        await client.query(
            `INSERT INTO transactions (phone_number, network, plan_id, status, reference, api_response, created_at, customer_name) 
             VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7)`,
            [mobile_number, plan.network, plan.id, status, String(transaction_id), JSON.stringify(amigoResult), customerName]
        );
        await client.end();

        if (amigoResult.success) return res.status(200).json({ success: true, message: 'Data Sent!' });
        else return res.status(400).json({ success: false, error: 'Provider Error: ' + amigoResult.message });

    } catch (e) {
        if(client) await client.end();
        return res.status(500).json({ error: e.message });
    }
}
