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
    const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
    const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');
    if (login !== ADMIN_USER || password !== ADMIN_PASS) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const client = new Client({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false } });
    await client.connect();

    try {
        const { action, search } = req.query; // Added search

        if (action === 'check') {
            await client.end();
            return res.status(200).json({ ok: true });
        }

        if (action === 'transactions') {
            let query = 'SELECT * FROM transactions';
            let params = [];
            
            // Search Logic
            if(search) {
                query += ' WHERE reference ILIKE $1 OR phone_number ILIKE $1';
                params.push(`%${search}%`);
            }
            
            query += ' ORDER BY created_at DESC LIMIT 50';
            
            const result = await client.query(query, params);
            await client.end();
            return res.status(200).json(result.rows);
        }

        // ... (Keep existing complaints logic) ...
        if (action === 'complaints') {
            const checkTable = await client.query("SELECT to_regclass('public.complaints')");
            if(!checkTable.rows[0].to_regclass) {
                await client.end(); return res.status(200).json([]);
            }
            const result = await client.query('SELECT * FROM complaints ORDER BY created_at DESC LIMIT 50');
            await client.end();
            return res.status(200).json(result.rows);
        }

        // ... (Keep existing POST logic for retry, manual, complaints, message) ...
        if (req.method === 'POST') {
            const body = req.body;
            
            if (body.action === 'delete_complaint') {
                await client.query('DELETE FROM complaints WHERE id = $1', [body.id]);
                await client.end();
                return res.status(200).json({ success: true });
            }

            if (body.action === 'save_message') {
                await client.query(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
                await client.query(`INSERT INTO settings (key, value) VALUES ('broadcast_message', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [body.message]);
                await client.end();
                return res.status(200).json({ success: true });
            }

            if (body.action === 'retry' || body.action === 'manual') {
                // ... (Keep existing retry/manual logic exactly as provided before) ...
                let targetPhone, targetPlanId, targetNetwork, apiPlanId, dbRef;
                if (body.action === 'retry') {
                    const txRes = await client.query(`SELECT t.phone_number, t.plan_id, t.reference, t.network, p.plan_id_api FROM transactions t LEFT JOIN plans p ON t.plan_id = p.id WHERE t.id = $1`, [body.id]);
                    if (txRes.rows.length === 0) throw new Error("Transaction not found");
                    const tx = txRes.rows[0];
                    targetPhone = tx.phone_number; targetPlanId = tx.plan_id; targetNetwork = tx.network; apiPlanId = tx.plan_id_api; dbRef = tx.reference;
                    if (!apiPlanId) throw new Error("Plan configuration missing");
                } else {
                    targetPhone = body.phone; targetPlanId = body.plan_id; targetNetwork = body.network; dbRef = 'MANUAL-' + Date.now();
                    const planRes = await client.query('SELECT plan_id_api FROM plans WHERE id = $1', [body.plan_id]);
                    if (planRes.rows.length === 0) throw new Error("Invalid Plan ID");
                    apiPlanId = planRes.rows[0].plan_id_api;
                }

                const NET_MAP = { 'mtn': 1, 'glo': 2, 'airtel': 3, '9mobile': 4 };
                const networkInt = NET_MAP[targetNetwork.toLowerCase()] || 1;
                const options = {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Token ${AMIGO_API_KEY}`, 'X-API-Key': AMIGO_API_KEY },
                    body: JSON.stringify({ network: networkInt, mobile_number: targetPhone, plan: apiPlanId, Ported_number: false })
                };
                if (PROXY_URL) options.agent = new HttpsProxyAgent(PROXY_URL);

                const amigoRes = await fetch('https://amigo.ng/api/data/', options);
                const amigoResult = await amigoRes.json();
                const isSuccess = (amigoResult.success === true || amigoResult.Status === 'successful');

                if (body.action === 'retry') {
                    await client.query(`UPDATE transactions SET status = $1, api_response = $2, created_at = NOW() WHERE id = $3`, [isSuccess ? 'success' : 'failed', JSON.stringify(amigoResult), body.id]);
                } else {
                    await client.query(`INSERT INTO transactions (phone_number, network, plan_id, status, reference, api_response, created_at) VALUES ($1, $2, $3, $4, $5, $6, NOW())`, [targetPhone, targetNetwork, targetPlanId, isSuccess ? 'success' : 'failed', dbRef, JSON.stringify(amigoResult)]);
                }

                await client.end();
                return isSuccess ? res.status(200).json({ success: true }) : res.status(400).json({ success: false, error: amigoResult.message || 'Failed' });
            }
        }

        await client.end();
        return res.status(400).json({ error: 'Invalid Action' });

    } catch (e) {
        if(client) await client.end();
        res.status(500).json({ error: e.message });
    }
}
