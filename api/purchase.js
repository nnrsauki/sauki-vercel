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

        // 1. Get Plan Info from Database
        const planRes = await client.query('SELECT * FROM plans WHERE id = $1', [plan_id]);
        if (planRes.rows.length === 0) {
            await client.end();
            return res.status(400).json({ error: 'Invalid Plan ID' }); 
        }
        const plan = planRes.rows[0];

        // 2. Check if Transaction already processed (Idempotency)
        const check = await client.query('SELECT id, status FROM transactions WHERE reference = $1', [String(transaction_id)]);
        if (check.rows.length > 0) {
            await client.end();
            // If already success, return success again
            if (check.rows[0].status === 'success') {
                return res.status(200).json({ success: true, message: 'Already Delivered' });
            }
            return res.status(400).json({ error: 'Duplicate Transaction' }); 
        }

        // 3. Verify Payment with Flutterwave
        // Note: We skip this step if you are running test mode and just want to simulate, 
        // but for production, this is critical.
        const flwRes = await fetch(`https://api.flutterwave.com/v3/transactions/${transaction_id}/verify`, { 
            headers: { 'Authorization': `Bearer ${FLW_SECRET_KEY}` } 
        });
        const flwData = await flwRes.json();

        if (flwData.status !== 'success' || flwData.data.status !== 'successful') {
            await client.end();
            return res.status(400).json({ error: 'Payment Verification Failed' });
        }
        
        // Ensure paid amount is enough
        if (flwData.data.amount < plan.price) {
            await client.end();
            return res.status(400).json({ error: 'Insufficient Amount Paid' });
        }

        // 4. Send Data via Amigo API
        const NET_MAP = { 'mtn': 1, 'glo': 2, 'airtel': 3, '9mobile': 4 };
        const networkInt = NET_MAP[plan.network.toLowerCase()] || 1;

        const apiPayload = { 
            network: networkInt, 
            mobile_number, 
            plan: plan.plan_id_api, 
            Ported_number: !!ported 
        };

        const options = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Token ${AMIGO_API_KEY}` }, // Amigo often uses Token auth, check docs if Key or Token
            body: JSON.stringify(apiPayload)
        };

        // If Amigo requires specific header key 'X-API-Key', switch above line. 
        // Assuming standard Bearer or Token based on common providers, but Amigo specifically usually:
        // headers: {'Content-Type': 'application/json', 'Authorization': 'Token YOUR_KEY'} OR query param.
        // Adjusting based on your previous file which used header X-API-Key:
        options.headers['X-API-Key'] = AMIGO_API_KEY; 
        delete options.headers['Authorization']; // Remove if using X-API-Key

        if (PROXY_URL) {
            options.agent = new HttpsProxyAgent(PROXY_URL);
        }

        const amigoRes = await fetch('https://amigo.ng/api/data/', options);
        const amigoResult = await amigoRes.json();

        // 5. Save Transaction Record
        const status = amigoResult.success || (amigoResult.Status === 'successful') ? 'success' : 'failed'; // Adjust based on Amigo actual response key
        
        // Use the format: Sauki-Phone-Time as user requested, though we used it as Ref.
        // We store the FLW Ref passed from frontend.
        
        await client.query(
            `INSERT INTO transactions (phone_number, network, plan_id, status, reference, api_response, created_at) 
             VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
            [mobile_number, plan.network, plan.id, status, String(transaction_id), JSON.stringify(amigoResult)]
        );
        
        await client.end();

        if (status === 'success') {
            return res.status(200).json({ success: true, message: 'Data Sent!' });
        } else {
            // This error message will trigger the "Network Down" UI on frontend
            return res.status(400).json({ success: false, error: 'Provider Error: ' + (amigoResult.message || amigoResult.error_message) });
        }

    } catch (e) {
        if(client) await client.end();
        return res.status(500).json({ error: e.message });
    }
}
