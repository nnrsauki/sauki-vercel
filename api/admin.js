import pg from 'pg';
import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';
const { Client } = pg;

// Environment Variables
const CONNECTION_STRING = process.env.POSTGRES_URL;
const ADMIN_USER = process.env.ADMIN_USERNAME;
const ADMIN_PASS = process.env.ADMIN_PASSWORD;
const AMIGO_API_KEY = process.env.AMIGO_API_KEY;
const PROXY_URL = process.env.PROXY_URL;

// Helper: Standardized JSON Response
const sendJson = (res, status, data) => res.status(status).json(data);
const sendError = (res, status, message) => res.status(status).json({ success: false, error: message });

export default async function handler(req, res) {
    // 1. Authentication
    const authHeader = req.headers.authorization || '';
    const match = authHeader.match(/Basic (.+)/);
    
    if (!match) return sendError(res, 401, 'Unauthorized');

    const [login, password] = Buffer.from(match[1], 'base64').toString().split(':');
    if (login !== ADMIN_USER || password !== ADMIN_PASS) {
        return sendError(res, 401, 'Unauthorized');
    }

    // 2. Database Connection
    const client = new Client({ 
        connectionString: CONNECTION_STRING, 
        ssl: { rejectUnauthorized: false } // Required for most cloud DBs
    });

    try {
        await client.connect();

        const { action, search } = req.query;

        // --- GET REQUESTS ---
        if (req.method === 'GET') {
            if (action === 'check') {
                await client.end();
                return sendJson(res, 200, { ok: true });
            }

            if (action === 'transactions') {
                let query = 'SELECT * FROM transactions';
                let params = [];
                if(search) {
                    query += ' WHERE reference ILIKE $1 OR phone_number ILIKE $1';
                    params.push(`%${search}%`);
                }
                query += ' ORDER BY created_at DESC LIMIT 100'; // Increased limit for desktop views
                
                const result = await client.query(query, params);
                await client.end();
                return sendJson(res, 200, result.rows);
            }

            if (action === 'complaints') {
                // Check if table exists to prevent errors on fresh install
                const checkTable = await client.query("SELECT to_regclass('public.complaints')");
                if(!checkTable.rows[0].to_regclass) {
                    await client.end(); 
                    return sendJson(res, 200, []);
                }
                const result = await client.query('SELECT * FROM complaints ORDER BY created_at DESC LIMIT 50');
                await client.end();
                return sendJson(res, 200, result.rows);
            }
        }

        // --- POST REQUESTS ---
        if (req.method === 'POST') {
            const body = req.body;
            
            // Delete Complaint
            if (body.action === 'delete_complaint') {
                await client.query('DELETE FROM complaints WHERE id = $1', [body.id]);
                await client.end();
                return sendJson(res, 200, { success: true });
            }

            // Save Broadcast Message
            if (body.action === 'save_message') {
                await client.query(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);
                await client.query(
                    `INSERT INTO settings (key, value) VALUES ('broadcast_message', $1) 
                     ON CONFLICT (key) DO UPDATE SET value = $1`, 
                    [body.message]
                );
                await client.end();
                return sendJson(res, 200, { success: true });
            }

            // Transaction Logic (Retry or Manual)
            if (body.action === 'retry' || body.action === 'manual') {
                let targetPhone, targetPlanId, targetNetwork, apiPlanId, dbRef;
                
                // DATA PREPARATION
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

                    if (!apiPlanId) throw new Error(`Plan configuration missing. Please check ID '${targetPlanId}' in Manage Plans.`);

                } else {
                    // Manual Order
                    targetPhone = body.phone;
                    targetPlanId = body.plan_id;
                    targetNetwork = body.network;
                    dbRef = 'MANUAL-' + Date.now();
                    
                    const planRes = await client.query('SELECT plan_id_api FROM plans WHERE id = $1', [body.plan_id]);
                    if (planRes.rows.length === 0) throw new Error("Invalid Plan ID selected.");
                    apiPlanId = planRes.rows[0].plan_id_api;
                }

                // API PREPARATION
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

                // API EXECUTION
                let isSuccess = false;
                let amigoResult = {};
                
                try {
                    const amigoRes = await fetch('https://amigo.ng/api/data/', options);
                    amigoResult = await amigoRes.json();
                    isSuccess = (amigoResult.success === true || amigoResult.Status === 'successful');
                } catch (apiError) {
                    amigoResult = { error: "Network/API Connection Failed", details: apiError.message };
                    isSuccess = false;
                }

                // DB UPDATE
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
                    return sendJson(res, 200, { success: true, message: 'Data sent successfully' });
                } else {
                    const errorMsg = amigoResult.message || amigoResult.error_message || "Unknown Provider Error";
                    return sendError(res, 400, `Provider: ${errorMsg}`);
                }
            }
        }

        await client.end();
        return sendError(res, 400, 'Invalid Action specified');

    } catch (e) {
        if(client) await client.end();
        console.error("Admin API Error:", e);
        return sendError(res, 500, e.message);
    }
}
