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

    const client = new Client({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false } });
    await client.connect();

    try {
        const { action } = req.query;

        // --- LOGIN CHECK ---
        if (action === 'check') {
            await client.end();
            return res.status(200).json({ ok: true });
        }

        // --- FETCH TRANSACTIONS ---
        if (action === 'transactions') {
            const result = await client.query('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 50');
            await client.end();
            return res.status(200).json(result.rows);
        }

        // --- POST ACTIONS ---
        if (req.method === 'POST') {
            const body = req.body;
            
            // A. SAVE BROADCAST MESSAGE
            if (body.action === 'save_message') {
                // Ensure table exists
                await client.query(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
                
                // Upsert message
                await client.query(
                    `INSERT INTO settings (key, value) VALUES ('broadcast_message', $1)
                     ON CONFLICT (key) DO UPDATE SET value = $1`,
                    [body.message]
                );
                
                await client.end();
                return res.status(200).json({ success: true });
            }

            // B. RETRY OR MANUAL ORDER
            if (body.action === 'retry' || body.action === 'manual') {
                let targetPhone, targetPlanId, targetNetwork, apiPlanId, dbRef;
                
                if (body.action === 'retry') {
                    // Fetch existing transaction details + Plan API ID
                    const txRes = await client.query(
                        `SELECT t.phone_number, t.plan_id, t.reference, t.network, p.plan_id_api 
                         FROM transactions t 
                         LEFT JOIN plans p ON t.plan_id = p.id 
                         WHERE t.id = $1`, 
                        [body.id]
                    );
                    
                    if (txRes.rows.length === 0) throw new Error("Transaction not found");
                    const tx = txRes.rows[0];

                    targetPhone = tx.phone_number;
                    targetPlanId = tx.plan_id;
                    targetNetwork = tx.network;
                    apiPlanId = tx.plan_id_api;
                    dbRef = tx.reference;

                    if (!apiPlanId) throw new Error("Plan configuration missing for this transaction");

                } else {
                    // Manual Order
                    targetPhone = body.phone;
                    targetPlanId = body.plan_id;
                    targetNetwork = body.network;
                    dbRef = 'MANUAL-' + Date.now();

                    // Look up Plan API ID
                    const planRes = await client.query('SELECT plan_id_api FROM plans WHERE id = $1', [body.plan_id]);
                    if (planRes.rows.length === 0) throw new Error("Invalid Plan ID");
                    apiPlanId = planRes.rows[0].plan_id_api;
                }

                // Prepare Amigo Request
                const NET_MAP = { 'mtn': 1, 'glo': 2, 'airtel': 3, '9mobile': 4 };
                const networkInt = NET_MAP[targetNetwork.toLowerCase()] || 1;

                const options = {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json', 
                        'Authorization': `Token ${AMIGO_API_KEY}`, 
                        'X-API-Key': AMIGO_API_KEY 
                    },
                    body: JSON.stringify({ 
                        network: networkInt, 
                        mobile_number: targetPhone, 
                        plan: apiPlanId, 
                        Ported_number: false 
                    })
                };

                if (PROXY_URL) options.agent = new HttpsProxyAgent(PROXY_URL);

                // Call Amigo
                const amigoRes = await fetch('https://amigo.ng/api/data/', options);
                const amigoResult = await amigoRes.json();
                
                // Check Success
                const isSuccess = (amigoResult.success === true || amigoResult.Status === 'successful');

                // Update/Insert Database Record
                if (body.action === 'retry') {
                    await client.query(
                        `UPDATE transactions SET status = $1, api_response = $2, created_at = NOW() WHERE id = $3`,
                        [isSuccess ? 'success' : 'failed', JSON.stringify(amigoResult), body.id]
                    );
                } else {
                    await client.query(
                        `INSERT INTO transactions (phone_number, network, plan_id, status, reference, api_response, created_at) 
                         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
                        [targetPhone, targetNetwork, targetPlanId, isSuccess ? 'success' : 'failed', dbRef, JSON.stringify(amigoResult)]
                    );
                }

                await client.end();

                if (isSuccess) {
                    return res.status(200).json({ success: true, message: 'Sent Successfully' });
                } else {
                    return res.status(400).json({ 
                        success: false, 
                        error: amigoResult.message || amigoResult.error_message || 'Provider Failed' 
                    });
                }
            }
        }

        await client.end();
        return res.status(400).json({ error: 'Invalid Action' });

    } catch (e) {
        console.error("Admin Error:", e);
        if(client) await client.end();
        res.status(500).json({ error: e.message });
    }
}
