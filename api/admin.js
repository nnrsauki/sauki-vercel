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
        // --- FETCH TRANSACTIONS ---
        if (action === 'transactions') {
            const result = await client.query('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 50');
            await client.end();
            return res.status(200).json(result.rows);
        }

        // --- RETRY FAILED TRANSACTION ---
        if (req.method === 'POST' && req.body.action === 'retry') {
            const { id } = req.body;
            
            // 1. Get Transaction Details
            const txRes = await client.query('SELECT * FROM transactions WHERE id = $1', [id]);
            if(txRes.rows.length === 0) throw new Error("Transaction not found");
            const tx = txRes.rows[0];

            // 2. Get Plan Details (to get the API ID)
            const planRes = await client.query('SELECT * FROM plans WHERE id = $1', [tx.plan_id]);
            if(planRes.rows.length === 0) throw new Error("Plan not found");
            const plan = planRes.rows[0];

            // 3. Prepare Amigo Call
            const NET_MAP = { 'mtn': 1, 'glo': 2, 'airtel': 3, '9mobile': 4 };
            const networkInt = NET_MAP[tx.network.toLowerCase()] || 1;

            const options = {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-API-Key': AMIGO_API_KEY },
                body: JSON.stringify({ 
                    network: networkInt, 
                    mobile_number: tx.phone_number, 
                    plan: plan.plan_id_api, 
                    Ported_number: false // Default to false for retries
                })
            };

            if (PROXY_URL) options.agent = new HttpsProxyAgent(PROXY_URL);

            // 4. Call API
            const apiRes = await fetch('https://amigo.ng/api/data/', options);
            const apiData = await apiRes.json();
            
            // 5. Update Status if Successful
            const isSuccess = apiData.success === true || apiData.Status === 'successful';
            
            if (isSuccess) {
                await client.query("UPDATE transactions SET status='success', api_response=$1 WHERE id=$2", [JSON.stringify(apiData), id]);
                await client.end();
                return res.status(200).json({ success: true, message: "Retry Successful! Data Sent." });
            } else {
                await client.query("UPDATE transactions SET api_response=$1 WHERE id=$2", [JSON.stringify(apiData), id]);
                await client.end();
                return res.status(400).json({ success: false, error: apiData.message || apiData.error_message });
            }
        }
        
        await client.end();
        return res.status(400).json({ error: 'Invalid Action' });

    } catch (e) {
        if(client) await client.end();
        res.status(500).json({ error: e.message });
    }
}
