import fetch from 'node-fetch';
import pg from 'pg';
const { Client } = pg;
import { HttpsProxyAgent } from 'https-proxy-agent';

// Environment Variables
const AMIGO_API_KEY = process.env.AMIGO_API_KEY;
const PROXY_URL = process.env.PROXY_URL; 
const CONNECTION_STRING = process.env.POSTGRES_URL; 
const FLW_SECRET_HASH = process.env.FLW_SECRET_HASH; 

export default async function handler(req, res) {
    // 1. Security Check
    const signature = req.headers['verif-hash'];
    if (!signature || signature !== FLW_SECRET_HASH) {
        return res.status(401).send('Unverified');
    }
    
    const { event, data } = req.body;
    
    // 2. Only Process Successful Payments
    if (event === 'charge.completed' && data.status === 'successful') {
        const client = new Client({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false } });
        
        try {
            await client.connect();

            // ==========================================================
            // PATH A: CHECK FOR PAY-AS-YOU-GO (WEBSITE TRANSACTION)
            // ==========================================================
            // We search your transactions table for this reference
            const result = await client.query('SELECT * FROM transactions WHERE reference = $1', [data.tx_ref]);
            
            if (result.rows.length > 0) {
                // --- IT IS A WEBSITE ORDER ---
                const transaction = result.rows[0];

                // Idempotency: Only process if not already success
                if (transaction.status !== 'success' && transaction.status !== 'successful') {
                    console.log(`[Webhook] Processing Website Order: ${data.tx_ref}`);

                    const { plan_id, phone_number, network } = transaction;
                    const planRes = await client.query('SELECT * FROM plans WHERE id = $1', [plan_id]);
                    
                    if (planRes.rows.length > 0) {
                        const plan = planRes.rows[0];
                        const NET_MAP = { 'mtn': 1, 'glo': 2, 'airtel': 3, '9mobile': 4 };
                        const netKey = (network || plan.network || '').toLowerCase();
                        const networkInt = NET_MAP[netKey] || 1;

                        const options = {
                            method: 'POST',
                            headers: { 
                                'Content-Type': 'application/json', 
                                'Authorization': `Token ${AMIGO_API_KEY}`,
                                'X-API-Key': AMIGO_API_KEY 
                            },
                            body: JSON.stringify({ 
                                network: networkInt, 
                                mobile_number: phone_number, 
                                plan: plan.plan_id_api, 
                                Ported_number: true 
                            })
                        };
                        
                        if (PROXY_URL) options.agent = new HttpsProxyAgent(PROXY_URL);

                        const amigoRes = await fetch('https://amigo.ng/api/data/', options);
                        const amigoResult = await amigoRes.json();
                        const isSuccess = (amigoResult.success === true || amigoResult.Status === 'successful');
                        const newStatus = isSuccess ? 'success' : 'failed';

                        await client.query(
                            `UPDATE transactions SET status = $1, api_response = $2 WHERE reference = $3`,
                            [newStatus, JSON.stringify(amigoResult), data.tx_ref]
                        );
                        console.log(`[Webhook] Website Order Updated: ${newStatus}`);
                    }
                } else {
                    console.log(`[Webhook] Skipped Website Order ${data.tx_ref} (Already Success)`);
                }
            } else {
                // ==========================================================
                // PATH B: CHECK FOR AGENT WALLET FUNDING
                // ==========================================================
                // If the reference was NOT found in 'transactions', it means it's likely a direct transfer to a Virtual Account.
                
                // We identify the Agent by matching the Virtual Account Number OR Phone Number
                // Flutterwave sends the receiving account in data.account.nuban or data.account_number
                
                const agentRes = await client.query(
                    'SELECT * FROM agents WHERE virtual_account_number = $1 OR phone_number = $2', 
                    [data.account?.nuban || data.account_number, data.customer?.phone_number]
                );

                if (agentRes.rows.length > 0) {
                    const agent = agentRes.rows[0];
                    const amount = data.amount;
                    const ref = data.tx_ref || String(data.id);

                    // Idempotency: Check if we already funded this specific transfer to avoid double crediting
                    const logCheck = await client.query('SELECT id FROM funding_logs WHERE reference = $1', [ref]);
                    
                    if (logCheck.rows.length === 0) {
                        console.log(`[Webhook] Funding Agent: ${agent.full_name} (+₦${amount})`);
                        
                        // 1. Fund Wallet
                        await client.query('UPDATE agents SET wallet_balance = wallet_balance + $1 WHERE id = $2', [amount, agent.id]);
                        
                        // 2. Log Transaction so we don't fund it again
                        await client.query('INSERT INTO funding_logs (reference, agent_phone, amount) VALUES ($1, $2, $3)', [ref, agent.phone_number, amount]);
                    } else {
                        console.log(`[Webhook] Duplicate Agent Funding skipped: ${ref}`);
                    }
                } else {
                    console.log(`[Webhook] Unknown Transaction: ${data.tx_ref} (Not website order, Not agent funding)`);
                }
            }
        } catch (e) {
            console.error("[Webhook] Critical Error:", e);
        } finally {
            await client.end();
        }
    }
    
    res.status(200).send('OK');
}
