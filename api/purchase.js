import fetch from 'node-fetch';
import pg from 'pg';
const { Client } = pg;
import { HttpsProxyAgent } from 'https-proxy-agent';

// Environment Variables
const AMIGO_API_KEY = process.env.AMIGO_API_KEY;
const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY;
const PROXY_URL = process.env.PROXY_URL; 
const CONNECTION_STRING = process.env.POSTGRES_URL; 

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({error: 'Method Not Allowed'});

    const { transaction_id, mobile_number, plan_id, ported } = req.body;

    if (!transaction_id || !mobile_number || !plan_id) {
        return res.status(400).json({ error: 'Missing details' });
    }

    const client = new Client({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false } });

    try {
        await client.connect();

        // 1. Get Plan Info
        const planRes = await client.query('SELECT * FROM plans WHERE id = $1', [plan_id]);
        if (planRes.rows.length === 0) {
            await client.end();
            return res.status(400).json({ error: 'Invalid Plan ID' }); 
        }
        const plan = planRes.rows[0];

        // 2. Idempotency Check (Prevent Double Charging)
        const check = await client.query('SELECT id, status FROM transactions WHERE reference = $1', [String(transaction_id)]);
        if (check.rows.length > 0) {
            await client.end();
            return res.status(200).json({ success: true, message: 'Transaction already processed' });
        }

        // 3. Verify Flutterwave Payment
        const flwRes = await fetch(`https://api.flutterwave.com/v3/transactions/${transaction_id}/verify`, { 
            headers: { 'Authorization': `Bearer ${FLW_SECRET_KEY}` } 
        });
        const flwData = await flwRes.json();

        if (flwData.status !== 'success' || flwData.data.status !== 'successful') {
            await client.end();
            return res.status(400).json({ error: 'Payment Verification Failed' });
        }
        
        if (flwData.data.amount < plan.price) {
            await client.end();
            return res.status(400).json({ error: 'Insufficient Amount Paid' });
        }

        // 4. Send Data via Amigo (STRICT LEGACY FORMAT)
        const NET_MAP = { 'mtn': 1, 'glo': 2, 'airtel': 3, '9mobile': 4 };
        const networkInt = NET_MAP[plan.network.toLowerCase()] || 1;

        // Exactly as your old file
        const options = {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json', 
                'X-API-Key': AMIGO_API_KEY  // DIRECT HEADER, NO SWITCHING
            },
            body: JSON.stringify({ 
                network: networkInt, 
                mobile_number: mobile_number, 
                plan: plan.plan_id_api, 
                Ported_number: !!ported 
            })
        };

        // Attach Proxy if exists
        if (PROXY_URL) {
            options.agent = new HttpsProxyAgent(PROXY_URL);
        }

        const amigoRes = await fetch('https://amigo.ng/api/data/', options);
        const amigoResult = await amigoRes.json();

        // 5. Save Record
        const isSuccess = amigoResult.success === true || amigoResult.Status === 'successful';
        const status = isSuccess ? 'success' : 'failed';
        
        await client.query(
            `INSERT INTO transactions (phone_number, network, plan_id, status, reference, api_response, created_at) 
             VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [mobile_number, plan.network, plan.id, status, String(transaction_id), JSON.stringify(amigoResult)]
        );
        
        await client.end();

        if (isSuccess) {
            return res.status(200).json({ success: true, message: 'Data Sent!' });
        } else {
            // Pass provider error to frontend
            const errorMsg = amigoResult.message || amigoResult.error_message || "Provider Error";
            return res.status(400).json({ success: false, error: 'Provider: ' + errorMsg });
        }

    } catch (e) {
        if(client) await client.end();
        console.error("Purchase Error:", e);
        return res.status(500).json({ error: e.message });
    }
}
