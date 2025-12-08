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
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
    if (req.method === 'OPTIONS') return res.status(200).end();

    if (req.method !== 'POST') return res.status(405).json({error: 'Method Not Allowed'});

    const { transaction_id, tx_ref, mobile_number, plan_id, ported, action } = req.body;
    const finalRef = tx_ref || String(transaction_id);

    const client = new Client({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false } });

    try {
        await client.connect();

        // ---------------------------------------------------------
        // 1. QUICK CHECK (Save resources)
        // ---------------------------------------------------------
        const existingTx = await client.query('SELECT status FROM transactions WHERE reference = $1', [finalRef]);
        if (existingTx.rows.length > 0) {
            const s = existingTx.rows[0].status;
            // If it is already success or currently being delivered by the webhook
            if (s === 'success' || s === 'processing_delivery') {
                await client.end();
                return res.status(200).json({ success: true, message: 'Transaction successful or in progress.' });
            }
        }

        // --- RECHECK / RETRY LOGIC ---
        // (Simplified for brevity, but should also use locking if implemented fully)
        if (action === 'recheck') {
             // For rechecks, we just trust the admin button click for now, 
             // but strictly we should lock here too.
             // ... existing recheck logic ...
        }

        // --- STANDARD PURCHASE LOGIC ---
        
        // 2. Insert/Update (Ensure record exists)
        try {
             await client.query(
                `INSERT INTO transactions (phone_number, network, plan_id, status, reference, created_at) 
                 VALUES ($1, 'unknown', $2, 'processing', $3, NOW())
                 ON CONFLICT (reference) DO NOTHING`,
                [mobile_number, plan_id, finalRef]
            );
        } catch(dbErr) { console.error("DB Insert Error", dbErr); }

        // 3. Get Plan Details
        const planRes = await client.query('SELECT * FROM plans WHERE id = $1', [plan_id]);
        if (planRes.rows.length === 0) { await client.end(); return res.status(400).json({ error: 'Invalid Plan ID' }); }
        const plan = planRes.rows[0];
        
        // 4. Verify Payment with Flutterwave
        if (!FLW_SECRET_KEY) { await client.end(); return res.status(500).json({ error: 'Server Config Error' }); }

        let flwData;
        const flwRes = await fetch(`https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${finalRef}`, { 
            headers: { 'Authorization': `Bearer ${FLW_SECRET_KEY}` } 
        });
        const json = await flwRes.json();
        if (json.data) flwData = json.data;

        // 5. Check Verification Status
        if (!flwData || flwData.status !== 'successful' || flwData.amount < plan.price) {
            await client.query("UPDATE transactions SET status='failed_verif' WHERE reference=$1 AND status != 'success'", [finalRef]);
            await client.end();
            return res.status(400).json({ error: 'Payment Failed or Insufficient' });
        }

        // ---------------------------------------------------------
        // 🛡️ THE ATOMIC LOCK (The Fix)
        // We try to switch status to 'processing_delivery'.
        // If the Webhook is already running, this query will fail to find a row to update.
        // ---------------------------------------------------------
        const lockResult = await client.query(
            `UPDATE transactions 
             SET status = 'processing_delivery' 
             WHERE reference = $1 
             AND status != 'success' 
             AND status != 'processing_delivery'
             RETURNING *`,
            [finalRef]
        );

        // If no row was updated, it means someone else (Webhook) is already doing it or done.
        if (lockResult.rowCount === 0) {
            await client.end();
            console.log(`[Purchase] Blocked duplicate for ${finalRef}.`);
            return res.status(200).json({ success: true, message: 'Processing in background...' });
        }
        // ---------------------------------------------------------


        // 6. Send to Amigo (We own the lock now)
        const NET_MAP = { 'mtn': 1, 'glo': 2, 'airtel': 3, '9mobile': 4 };
        const networkInt = NET_MAP[plan.network.toLowerCase()] || 1;

        const options = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Token ${AMIGO_API_KEY}`, 'X-API-Key': AMIGO_API_KEY },
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

        // 7. Final Save
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
