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
    // 1. Authentication
    const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
    const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');
    if (login !== ADMIN_USER || password !== ADMIN_PASS) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const client = new Client({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false } });
    await client.connect();

    try {
        const { action, search } = req.query;

        // --- GET ACTIONS ---

        // A. Auth Check
        if (action === 'check') {
            await client.end();
            return res.status(200).json({ ok: true });
        }

        // B. Fetch Transactions (Your Original Logic + Search)
        if (action === 'transactions') {
            let query = 'SELECT * FROM transactions';
            let params = [];
            if(search) {
                query += ' WHERE reference ILIKE $1 OR phone_number ILIKE $1';
                params.push(`%${search}%`);
            }
            query += ' ORDER BY created_at DESC LIMIT 50';
            const result = await client.query(query, params);
            await client.end();
            return res.status(200).json(result.rows);
        }

        // C. Fetch Complaints (Your Original Logic)
        if (action === 'complaints') {
            const checkTable = await client.query("SELECT to_regclass('public.complaints')");
            if(!checkTable.rows[0].to_regclass) {
                await client.end(); return res.status(200).json([]);
            }
            const result = await client.query('SELECT * FROM complaints ORDER BY created_at DESC LIMIT 50');
            await client.end();
            return res.status(200).json(result.rows);
        }

        // D. [NEW] Fetch Agents (Resellers)
        if (action === 'agents') {
            let query = 'SELECT id, full_name, phone_number, wallet_balance, virtual_account_bank, virtual_account_number, created_at FROM agents';
            if (search) query += ` WHERE phone_number ILIKE '%${search}%' OR full_name ILIKE '%${search}%'`;
            query += ' ORDER BY wallet_balance DESC LIMIT 50';
            const result = await client.query(query);
            await client.end();
            return res.status(200).json(result.rows);
        }

        // E. [NEW] Fetch Statistics
        if (action === 'stats') {
            // Check if agents table exists first to avoid crash on fresh install
            const checkAgents = await client.query("SELECT to_regclass('public.agents')");
            let agentBal = 0;
            if(checkAgents.rows[0].to_regclass) {
                const agRes = await client.query('SELECT SUM(wallet_balance) as t FROM agents');
                agentBal = agRes.rows[0].t || 0;
            }
            
            const salesRes = await client.query("SELECT SUM(amount) as t FROM transactions WHERE status='success'");
            
            await client.end();
            return res.status(200).json({
                agent_wallet_balance: agentBal,
                total_sales: salesRes.rows[0].t || 0
            });
        }

        // --- POST ACTIONS ---
        if (req.method === 'POST') {
            const body = req.body;
            
            // 1. Delete Complaint (Your Original Logic)
            if (body.action === 'delete_complaint') {
                await client.query('DELETE FROM complaints WHERE id = $1', [body.id]);
                await client.end();
                return res.status(200).json({ success: true });
            }

            // 2. Save Broadcast Message (Your Original Logic)
            if (body.action === 'save_message') {
                await client.query(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
                await client.query(`INSERT INTO settings (key, value) VALUES ('broadcast_message', $1) ON CONFLICT (key) DO UPDATE SET value = $1`, [body.message]);
                await client.end();
                return res.status(200).json({ success: true });
            }

            // 3. Manual Order & Retry (Your Original Logic - PRESERVED EXACTLY)
            if (body.action === 'retry' || body.action === 'manual') {
                let targetPhone, targetPlanId, targetNetwork, apiPlanId, dbRef;
                
                if (body.action === 'retry') {
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

                    if (!apiPlanId) throw new Error(`Plan configuration missing. Please check '${targetPlanId}' in Manage Plans.`);

                } else {
                    targetPhone = body.phone;
                    targetPlanId = body.plan_id;
                    targetNetwork = body.network;
                    dbRef = 'MANUAL-' + Date.now();
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
                    await client.query(`INSERT INTO transactions (phone_number, network, plan_id, status, reference, api_response, created_at, channel) VALUES ($1, $2, $3, $4, $5, $6, NOW(), 'manual')`, [targetPhone, targetNetwork, targetPlanId, isSuccess ? 'success' : 'failed', dbRef, JSON.stringify(amigoResult)]);
                }

                await client.end();

                if (isSuccess) {
                    return res.status(200).json({ success: true, message: 'Sent Successfully' });
                } else {
                    const errorDetails = amigoResult.message || amigoResult.error_message || JSON.stringify(amigoResult);
                    return res.status(400).json({ success: false, error: `Provider: ${errorDetails}` });
                }
            }
        }

        await client.end();
        return res.status(400).json({ error: 'Invalid Action' });

    } catch (e) {
        if(client) await client.end();
        res.status(500).json({ error: e.message });
    }
}
