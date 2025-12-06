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

    // "transaction_id" here might be a Number (ID) OR a String (Ref) depending on where it comes from
    const { transaction_id, mobile_number, plan_id, ported } = req.body;

    if (!transaction_id || !mobile_number || !plan_id) {
        return res.status(400).json({ error: 'Missing details' });
    }

    if (!FLW_SECRET_KEY) return res.status(500).json({ error: 'Server Error: Key Missing' });

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

        // 2. IMMEDIATE SAVE (Pending)
        // We use the input transaction_id as the reference initially
        await client.query(
            `INSERT INTO transactions (phone_number, network, plan_id, status, reference, created_at) 
             VALUES ($1, $2, $3, 'pending_verif', $4, NOW())
             ON CONFLICT (reference) DO NOTHING`,
            [mobile_number, plan.network, plan.id, String(transaction_id)]
        );

        // 3. SMART VERIFICATION (The Fix)
        let flwData;
        
        // Check if input is likely a Numeric ID or a String Ref
        const isNumericId = /^\d+$/.test(String(transaction_id));

        if (isNumericId) {
            // Standard Verify by ID
            const flwRes = await fetch(`https://api.flutterwave.com/v3/transactions/${transaction_id}/verify`, { 
                headers: { 'Authorization': `Bearer ${FLW_SECRET_KEY}` } 
            });
            const json = await flwRes.json();
            flwData = json.data; // Standard verify returns data in .data
        } else {
            // Verify by Reference (for Resume/Recovery flow)
            // We search for the transaction by ref
            const flwRes = await fetch(`https://api.flutterwave.com/v3/transactions?tx_ref=${transaction_id}`, { 
                headers: { 'Authorization': `Bearer ${FLW_SECRET_KEY}` } 
            });
            const json = await flwRes.json();
            
            // The search returns an array of transactions. We take the first one.
            if (json.data && json.data.length > 0) {
                flwData = json.data[0];
            } else {
                flwData = null; // Not found
            }
        }

        // 4. CHECK PAYMENT STATUS
        if (!flwData || flwData.status !== 'successful') {
            console.error("Verification Failed. Data:", JSON.stringify(flwData));
            await client.query("UPDATE transactions SET status='failed_verif', api_response=$1 WHERE reference=$2", 
                ["Flutterwave: Payment not found or failed", String(transaction_id)]);
            await client.end();
            return res.status(400).json({ error: 'Payment Verification Failed: ' + (flwData?.status || 'Not Found') });
        }
        
        // Check Amount
        if (flwData.amount < plan.price) {
            await client.query("UPDATE transactions SET status='failed_amount', api_response='Insufficient Payment' WHERE reference=$1", 
                [String(transaction_id)]);
            await client.end();
            return res.status(400).json({ error: 'Insufficient Amount: Paid ' + flwData.amount });
        }

        // 5. Send Data via Amigo
        const NET_MAP = { 'mtn': 1, 'glo': 2, 'airtel': 3, '9mobile': 4 };
        const networkInt = NET_MAP[plan.network.toLowerCase()] || 1;

        const options = {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json', 
                'X-API-Key': AMIGO_API_KEY 
            },
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

        // 6. Save Final Status
        const isSuccess = amigoResult.success === true || amigoResult.Status === 'successful';
        const status = isSuccess ? 'success' : 'failed';
        
        await client.query(
            "UPDATE transactions SET status=$1, api_response=$2 WHERE reference=$3",
            [status, JSON.stringify(amigoResult), String(transaction_id)]
        );
        
        await client.end();

        if (isSuccess) {
            return res.status(200).json({ success: true, message: 'Data Sent!' });
        } else {
            const errorMsg = amigoResult.message || amigoResult.error_message || "Provider Error";
            return res.status(400).json({ success: false, error: 'Provider: ' + errorMsg });
        }

    } catch (e) {
        if(client) await client.end();
        console.error("System Error:", e);
        return res.status(500).json({ error: e.message });
    }
    }
