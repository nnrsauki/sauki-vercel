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
        // 🛡️ CRITICAL SECURITY CHECK (Prevents Double Deduction)
        // ---------------------------------------------------------
        const existingTx = await client.query('SELECT status FROM transactions WHERE reference = $1', [finalRef]);
        
        if (existingTx.rows.length > 0) {
            const currentStatus = existingTx.rows[0].status;
            // If Webhook already marked it as success, STOP HERE.
            if (currentStatus === 'success') {
                await client.end();
                console.log(`[Purchase] Duplicate blocked for ${finalRef}. Already successful.`);
                return res.status(200).json({ success: true, message: 'Transaction already completed successfully.' });
            }
        }
        // ---------------------------------------------------------

        // --- RECHECK LOGIC ---
        if (action === 'recheck') {
            if (!finalRef) throw new Error("Missing Reference");

            // Verify Payment
            const flwRes = await fetch(`https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${finalRef}`, { 
                headers: { 'Authorization': `Bearer ${FLW_SECRET_KEY}` } 
            });
            const flwData = await flwRes.json();

            if (flwData.status === 'success' && flwData.data.status === 'successful') {
                // Fetch details from DB if missing
                let targetPlanId = plan_id;
                let targetPhone = mobile_number;
                
                if (!targetPlanId || !targetPhone) {
                    const dbTx = await client.query('SELECT plan_id, phone_number FROM transactions WHERE reference = $1', [finalRef]);
                    if (dbTx.rows.length > 0) {
                        targetPlanId = dbTx.rows[0].plan_id;
                        targetPhone = dbTx.rows[0].phone_number;
                    }
                }

                if (!targetPlanId) return res.status(400).json({ error: "Cannot find plan details." });

                // Deliver
                const planRes = await client.query('SELECT * FROM plans WHERE id = $1', [targetPlanId]);
                if (planRes.rows.length === 0) throw new Error("Invalid Plan ID");
                const plan = planRes.rows[0];

                const NET_MAP = { 'mtn': 1, 'glo': 2, 'airtel': 3, '9mobile': 4 };
                const networkInt = NET_MAP[plan.network.toLowerCase()] || 1;

                const options = {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Token ${AMIGO_API_KEY}`, 'X-API-Key': AMIGO_API_KEY },
                    body: JSON.stringify({ 
                        network: networkInt, 
                        mobile_number: targetPhone, 
                        plan: plan.plan_id_api, 
                        Ported_number: false 
                    })
                };
                if (PROXY_URL) options.agent = new HttpsProxyAgent(PROXY_URL);

                const amigoRes = await fetch('https://amigo.ng/api/data/', options);
                const amigoResult = await amigoRes.json();
                const isSuccess = (amigoResult.success === true || amigoResult.Status === 'successful');

                // Update DB
                await client.query(
                    `INSERT INTO transactions (phone_number, network, plan_id, status, reference, api_response, created_at) 
                     VALUES ($1, $2, $3, $4, $5, $6, NOW())
                     ON CONFLICT (reference) DO UPDATE SET status = $4, api_response = $6`,
                    [targetPhone, plan.network, targetPlanId, isSuccess ? 'success' : 'failed', finalRef, JSON.stringify(amigoResult)]
                );

                if (isSuccess) return res.status(200).json({ success: true, message: 'Recheck Successful: Data Sent!' });
                else return res.status(400).json({ success: false, error: 'Payment confirmed, but data delivery failed.' });

            } else {
                return res.status(400).json({ success: false, error: 'Payment not found.' });
            }
        }

        // --- STANDARD PURCHASE LOGIC ---
        
        // 1. Safe Insert/Update (Only update if NOT success)
        try {
             // We modify the query to NOT overwrite 'success' status if it exists
             await client.query(
                `INSERT INTO transactions (phone_number, network, plan_id, status, reference, created_at) 
                 VALUES ($1, 'unknown', $2, 'processing', $3, NOW())
                 ON CONFLICT (reference) DO UPDATE SET 
                    status = CASE WHEN transactions.status = 'success' THEN 'success' ELSE 'processing' END,
                    phone_number = EXCLUDED.phone_number,
                    plan_id = EXCLUDED.plan_id`,
                [mobile_number, plan_id, finalRef]
            );
        } catch(dbErr) { console.error("DB Insert Error", dbErr); }

        // 2. Get Plan
        const planRes = await client.query('SELECT * FROM plans WHERE id = $1', [plan_id]);
        if (planRes.rows.length === 0) {
            return res.status(400).json({ error: 'Invalid Plan ID' }); 
        }
        const plan = planRes.rows[0];
        
        // 3. Verify Payment
        if (!FLW_SECRET_KEY) { await client.end(); return res.status(500).json({ error: 'Server Config Error' }); }

        let flwData;
        const flwRes = await fetch(`https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${finalRef}`, { 
            headers: { 'Authorization': `Bearer ${FLW_SECRET_KEY}` } 
        });
        const json = await flwRes.json();
        if (json.data) flwData = json.data;

        // 4. Check Status
        if (!flwData || flwData.status !== 'successful' || flwData.amount < plan.price) {
            await client.query("UPDATE transactions SET status='failed_verif' WHERE reference=$1 AND status != 'success'", [finalRef]);
            await client.end();
            return res.status(400).json({ error: 'Payment Failed or Insufficient' });
        }

        // 5. Send to Amigo
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

        // 6. Final Save
        const isSuccess = amigoResult.success === true || amigoResult.Status === 'successful';
        
        // Only update if we actually got a result (don't overwrite if race condition updated it meanwhile)
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
