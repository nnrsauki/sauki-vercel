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

    const { transaction_id, tx_ref, mobile_number, plan_id, ported } = req.body;
    const finalRef = tx_ref || String(transaction_id);

    // Basic Validation
    if (!finalRef) return res.status(400).json({ error: 'Missing Reference' });
    if (!mobile_number) return res.status(400).json({ error: 'Missing Phone' });
    if (!plan_id) return res.status(400).json({ error: 'Missing Plan ID' });

    const client = new Client({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false } });

    try {
        await client.connect();

        // 1. AGGRESSIVE SAVE: Save immediately to ensure Admin panel visibility
        // We use ON CONFLICT DO UPDATE so duplicate calls don't crash
        try {
             await client.query(
                `INSERT INTO transactions (phone_number, network, plan_id, status, reference, created_at) 
                 VALUES ($1, 'unknown', $2, 'processing', $3, NOW())
                 ON CONFLICT (reference) DO UPDATE SET status = 'processing'`,
                [mobile_number, plan_id, finalRef]
            );
        } catch(dbErr) { console.error("DB Insert Error", dbErr); }

        // 2. Get Plan
        const planRes = await client.query('SELECT * FROM plans WHERE id = $1', [plan_id]);
        if (planRes.rows.length === 0) {
            await client.query("UPDATE transactions SET status='failed_plan' WHERE reference=$1", [finalRef]);
            await client.end();
            return res.status(400).json({ error: 'Invalid Plan ID' }); 
        }
        const plan = planRes.rows[0];
        
        // Update network in DB
        await client.query("UPDATE transactions SET network=$1 WHERE reference=$2", [plan.network, finalRef]);

        // 3. Verify Payment
        if (!FLW_SECRET_KEY) {
             await client.end(); return res.status(500).json({ error: 'Server Config Error' });
        }

        let flwData;
        const isNumericId = /^\d+$/.test(String(transaction_id));

        if (isNumericId && transaction_id) {
            const flwRes = await fetch(`https://api.flutterwave.com/v3/transactions/${transaction_id}/verify`, { 
                headers: { 'Authorization': `Bearer ${FLW_SECRET_KEY}` } 
            });
            const json = await flwRes.json();
            flwData = json.data;
        } else {
            const flwRes = await fetch(`https://api.flutterwave.com/v3/transactions?tx_ref=${finalRef}`, { 
                headers: { 'Authorization': `Bearer ${FLW_SECRET_KEY}` } 
            });
            const json = await flwRes.json();
            if (json.data && json.data.length > 0) flwData = json.data[0];
        }

        // 4. Check Status
        if (!flwData || flwData.status !== 'successful') {
            await client.query("UPDATE transactions SET status='failed_verif', api_response=$1 WHERE reference=$2", 
                ["Payment not successful", finalRef]);
            await client.end();
            return res.status(400).json({ error: 'Payment Failed or Not Found' });
        }
        
        if (flwData.amount < plan.price) {
            await client.query("UPDATE transactions SET status='failed_amount' WHERE reference=$1", [finalRef]);
            await client.end();
            return res.status(400).json({ error: 'Insufficient Payment' });
        }

        // 5. Send to Amigo
        const NET_MAP = { 'mtn': 1, 'glo': 2, 'airtel': 3, '9mobile': 4 };
        const networkInt = NET_MAP[plan.network.toLowerCase()] || 1;

        const options = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': AMIGO_API_KEY },
            body: JSON.stringify({ 
                network: networkInt, 
                mobile_number: mobile_number, 
                plan: plan.plan_id_api, 
                Ported_number: !!ported 
            })
        };
        if (PROXY_URL) options.agent = new HttpsProxyAgent(PROXY_URL);

        const amigoRes = await fetch('https://amigo.ng/api/data/', options);
        const amigoResult = await amigoRes.json();

        // 6. Final Save
        const isSuccess = amigoResult.success === true || amigoResult.Status === 'successful';
        await client.query("UPDATE transactions SET status=$1, api_response=$2 WHERE reference=$3", 
            [isSuccess ? 'success' : 'failed', JSON.stringify(amigoResult), finalRef]);
        
        await client.end();

        if (isSuccess) return res.status(200).json({ success: true, message: 'Data Sent!' });
        else return res.status(400).json({ success: false, error: 'Provider Error: ' + (amigoResult.message || amigoResult.error_message) });

    } catch (e) {
        if(client) await client.end();
        return res.status(500).json({ error: e.message });
    }
}
