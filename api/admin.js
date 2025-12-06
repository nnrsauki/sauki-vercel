import pg from 'pg';
import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';
const { Client } = pg;

const CONNECTION_STRING = process.env.POSTGRES_URL;
const ADMIN_USER = process.env.ADMIN_USERNAME;
const ADMIN_PASS = process.env.ADMIN_PASSWORD;
const AMIGO_API_KEY = process.env.AMIGO_API_KEY;
const PROXY_URL = process.env.PROXY_URL;

export default async function handler(req, res) {
    // 1. Auth Check
    const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
    const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');
    if (login !== ADMIN_USER || password !== ADMIN_PASS) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { action } = req.query;
    if (action === 'check') return res.status(200).json({ ok: true });

    const client = new Client({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false } });
    await client.connect();

    try {
        // --- GET TRANSACTIONS ---
        if (action === 'transactions') {
            const result = await client.query('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 50');
            await client.end();
            return res.status(200).json(result.rows);
        }

        // --- RETRY FAILED TRANSACTION ---
        if (req.method === 'POST' && req.body.action === 'retry') {
            const { id } = req.body;
            const txRes = await client.query('SELECT * FROM transactions WHERE id = $1', [id]);
            if(txRes.rows.length === 0) throw new Error("Transaction not found");
            const tx = txRes.rows[0];
            
            // Re-use manual logic internally
            await processOrder(client, tx.phone_number, tx.plan_id, tx.network, id); // Pass ID to update existing
            await client.end();
            return res.status(200).json({ success: true, message: "Retry Processed" });
        }

        // --- MANUAL ORDER (NEW) ---
        if (req.method === 'POST' && req.body.action === 'manual') {
            const { phone, plan_id, network } = req.body;
            // Create a fake reference for manual orders
            const ref = 'Manual-' + Date.now();
            
            // Save initial record
            const insert = await client.query(
                `INSERT INTO transactions (phone_number, network, plan_id, status, reference, created_at) 
                 VALUES ($1, $2, $3, 'pending', $4, NOW()) RETURNING id`,
                [phone, network, plan_id, ref]
            );
            const newId = insert.rows[0].id;

            // Process
            const result = await processOrder(client, phone, plan_id, network, newId);
            await client.end();
            
            if(result.success) return res.status(200).json({ success: true });
            else return res.status(400).json({ success: false, error: result.error });
        }

        await client.end();
        return res.status(400).json({ error: 'Invalid Action' });

    } catch (e) {
        if(client) await client.end();
        res.status(500).json({ error: e.message });
    }
}

// Helper Function to send to Amigo
async function processOrder(client, phone, planId, network, dbId) {
    // Get Plan
    const planRes = await client.query('SELECT * FROM plans WHERE id = $1', [planId]);
    if(planRes.rows.length === 0) throw new Error("Plan not found");
    const plan = planRes.rows[0];

    const NET_MAP = { 'mtn': 1, 'glo': 2, 'airtel': 3, '9mobile': 4 };
    const networkInt = NET_MAP[network.toLowerCase()] || 1;

    const options = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': AMIGO_API_KEY },
        body: JSON.stringify({ 
            network: networkInt, 
            mobile_number: phone, 
            plan: plan.plan_id_api, 
            Ported_number: false 
        })
    };
    if (PROXY_URL) options.agent = new HttpsProxyAgent(PROXY_URL);

    const apiRes = await fetch('https://amigo.ng/api/data/', options);
    const apiData = await apiRes.json();
    
    const isSuccess = apiData.success === true || apiData.Status === 'successful';
    
    // Update DB
    await client.query("UPDATE transactions SET status=$1, api_response=$2 WHERE id=$3", 
        [isSuccess ? 'success' : 'failed', JSON.stringify(apiData), dbId]
    );

    return { success: isSuccess, error: apiData.message || apiData.error_message };
}
