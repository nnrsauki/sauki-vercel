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

        // Login Check
        if (action === 'check') {
            await client.end();
            return res.status(200).json({ ok: true });
        }

        // Transactions Fetch
        if (action === 'transactions') {
            const result = await client.query('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 50');
            await client.end();
            return res.status(200).json(result.rows);
        }

        // Retry & Manual Orders Logic
        if (req.method === 'POST') {
            const { action: postAction, id, phone, network, plan_id } = req.body;

            if (postAction === 'retry' || postAction === 'manual') {
                let targetPhone, targetPlanId, targetNetwork, apiPlanId, dbRef;
                
                // --- PREPARE DATA ---
                if (postAction === 'retry') {
                    // Fetch Transaction + Plan Details joined
                    // We join to ensure we have the latest API ID from the plans table
                    const txRes = await client.query(
                        `SELECT t.phone_number, t.plan_id, t.reference, t.network, p.plan_id_api 
                         FROM transactions t 
                         LEFT JOIN plans p ON t.plan_id = p.id 
                         WHERE t.id = $1`, 
                        [id]
                    );
                    
                    if (txRes.rows.length === 0) throw new Error("Transaction not found");
                    const tx = txRes.rows[0];

                    targetPhone = tx.phone_number;
                    targetPlanId = tx.plan_id;
                    targetNetwork = tx.network;
                    apiPlanId = tx.plan_id_api; // This comes from the plans table join
                    dbRef = tx.reference;

                    if (!apiPlanId) throw new Error("Plan configuration missing or deleted");

                } else {
                    // Manual Mode
                    targetPhone = phone;
                    targetPlanId = plan_id;
                    targetNetwork = network;
                    dbRef = 'MANUAL-' + Date.now();

                    // Fetch Plan API ID
                    const planRes = await client.query('SELECT plan_id_api FROM plans WHERE id = $1', [plan_id]);
                    if (planRes.rows.length === 0) throw new Error("Invalid Plan ID");
                    apiPlanId = planRes.rows[0].plan_id_api;
                }

                // --- EXECUTE API CALL ---
                const NET_MAP = { 'mtn': 1, 'glo': 2, 'airtel': 3, '9mobile': 4 };
                const networkInt = NET_MAP[targetNetwork.toLowerCase()] || 1;

                const options = {
                    method: 'POST',
                    headers: { 
                        'Content-Type': 'application/json', 
                        'Authorization': `Token ${AMIGO_API_KEY}`, // Supporting multiple auth styles
                        'X-API-Key': AMIGO_API_KEY 
                    },
                    body: JSON.stringify({
                        network: networkInt,
                        mobile_number: targetPhone,
                        plan: apiPlanId,
                        Ported_number: false // Default to false for admin actions usually
                    })
                };

                if (PROXY_URL) options.agent = new HttpsProxyAgent(PROXY_URL);

                console.log(`Sending Data: ${targetPhone} | Plan: ${apiPlanId}`);
                
                const amigoRes = await fetch('https://amigo.ng/api/data/', options);
                const amigoResult = await amigoRes.json();
                
                // Amigo returns { success: true } or { Status: 'successful' } depending on endpoint version
                const isSuccess = (amigoResult.success === true || amigoResult.Status === 'successful');

                // --- UPDATE DB ---
                if (postAction === 'retry') {
                    await client.query(
                        `UPDATE transactions 
                         SET status = $1, api_response = $2, created_at = NOW() 
                         WHERE id = $3`,
                        [isSuccess ? 'success' : 'failed', JSON.stringify(amigoResult), id]
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
                    return res.status(200).json({ success: true, message: 'Data Delivered Successfully' });
                } else {
                    return res.status(400).json({ 
                        success: false, 
                        error: amigoResult.message || amigoResult.error_message || 'Provider declined transaction' 
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
