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

    const { transaction_id, tx_ref, mobile_number, plan_id, network, ported, action } = req.body;
    const finalRef = tx_ref || String(transaction_id);

    const client = new Client({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false } });

    try {
        await client.connect();

        // --- RECHECK LOGIC (Updated for Safety) ---
        if (action === 'recheck') {
            if (!finalRef) throw new Error("Missing Reference");

            // 1. Verify Payment with Flutterwave
            const flwRes = await fetch(`https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${finalRef}`, { 
                headers: { 'Authorization': `Bearer ${FLW_SECRET_KEY}` } 
            });
            const flwData = await flwRes.json();

            if (flwData.status === 'success' && flwData.data.status === 'successful') {
                const paidAmount = flwData.data.amount;

                // 2. Fetch Plan Details to Verify Amount
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

                // 3. Double Check: Does Paid Amount Match Plan Price?
                const planRes = await client.query('SELECT * FROM plans WHERE id = $1', [targetPlanId]);
                if (planRes.rows.length === 0) throw new Error("Invalid Plan ID");
                const plan = planRes.rows[0];

                if (paidAmount < plan.price) {
                    return res.status(400).json({ 
                        success: false, 
                        error: `Underpayment detected. Paid: ₦${paidAmount}, Needed: ₦${plan.price}. Contact Support.` 
                    });
                }

                // 4. Check if already successful
                const dbCheck = await client.query('SELECT status FROM transactions WHERE reference = $1', [finalRef]);
                if (dbCheck.rows.length > 0 && dbCheck.rows[0].status === 'success') {
                    return res.status(200).json({ success: true, message: "Transaction already successful." });
                }

                // 5. DELIVER DATA
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
                else return res.status(400).json({ success: false, error: 'Payment confirmed, but data delivery failed. Contact Admin.' });

            } else {
                return res.status(400).json({ success: false, error: 'Payment not found or failed at bank.' });
            }
        }

        // --- STANDARD PURCHASE LOGIC (Existing) ---
        // (Keeping your original logic for standard "I have paid" verification)
        
        try {
             await client.query(
                `INSERT INTO transactions (phone_number, network, plan_id, status, reference, created_at) 
                 VALUES ($1, 'unknown', $2, 'processing', $3, NOW())
                 ON CONFLICT (reference) DO UPDATE SET status = 'processing'`,
                [mobile_number, plan_id, finalRef]
            );
        } catch(dbErr) { console.error("DB Insert Error", dbErr); }

        const planRes = await client.query('SELECT * FROM plans WHERE id = $1', [plan_id]);
        if (planRes.rows.length === 0) {
            await client.query("UPDATE transactions SET status='failed_plan' WHERE reference=$1", [finalRef]);
            await client.end();
            return res.status(400).json({ error: 'Invalid Plan ID' }); 
        }
        const plan = planRes.rows[0];
        await client.query("UPDATE transactions SET network=$1 WHERE reference=$2", [plan.network, finalRef]);

        if (!FLW_SECRET_KEY) { await client.end(); return res.status(500).json({ error: 'Server Config Error' }); }

        let flwData;
        const flwRes = await fetch(`https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=${finalRef}`, { 
            headers: { 'Authorization': `Bearer ${FLW_SECRET_KEY}` } 
        });
        const json = await flwRes.json();
        if (json.data) flwData = json.data;

        if (!flwData || flwData.status !== 'successful' || flwData.amount < plan.price) {
            await client.query("UPDATE transactions SET status='failed_verif' WHERE reference=$1", [finalRef]);
            await client.end();
            return res.status(400).json({ error: 'Payment Failed or Insufficient' });
        }

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
