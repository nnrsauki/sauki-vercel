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

            // 3. Find the EXISTING pending transaction
            const result = await client.query('SELECT * FROM transactions WHERE reference = $1', [data.tx_ref]);
            
            if (result.rows.length > 0) {
                
                // ---------------------------------------------------------
                // 🛡️ ATOMIC LOCK
                // We attempt to update status to 'processing_delivery'.
                // If the user's browser (purchase.js) is already doing this, this query will fail to update anything.
                // ---------------------------------------------------------
                const lockResult = await client.query(
                    `UPDATE transactions 
                     SET status = 'processing_delivery' 
                     WHERE reference = $1 
                     AND status != 'success' 
                     AND status != 'processing_delivery'
                     RETURNING *`,
                    [data.tx_ref]
                );

                // Only proceed if WE successfully locked the row (rowCount > 0)
                if (lockResult.rowCount > 0) {
                    
                    console.log(`[Webhook] Acquired lock for ${data.tx_ref}. Sending data...`);

                    // 4. Extract data (Use the locked row data)
                    const { plan_id, phone_number, network } = lockResult.rows[0];

                    // 5. Fetch Plan Details
                    const planRes = await client.query('SELECT * FROM plans WHERE id = $1', [plan_id]);
                    
                    if (planRes.rows.length > 0) {
                        const plan = planRes.rows[0];
                        const NET_MAP = { 'mtn': 1, 'glo': 2, 'airtel': 3, '9mobile': 4 };
                        const netKey = (network || plan.network || '').toLowerCase();
                        const networkInt = NET_MAP[netKey] || 1;

                        // 6. Send to Amigo
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

                        // 7. Final Status Update
                        await client.query(
                            `UPDATE transactions SET status = $1, api_response = $2 WHERE reference = $3`,
                            [newStatus, JSON.stringify(amigoResult), data.tx_ref]
                        );

                        console.log(`[Webhook] Completed ${data.tx_ref}: ${newStatus}`);
                    } else {
                        console.error(`[Webhook] Error: Plan not found.`);
                        // Release lock so it can be fixed manually
                        await client.query("UPDATE transactions SET status='failed_plan' WHERE reference=$1", [data.tx_ref]);
                    }
                } else {
                    console.log(`[Webhook] Skipped: ${data.tx_ref} is already being processed or completed.`);
                }
            }
        } catch (e) {
            console.error("[Webhook] Error:", e);
        } finally {
            await client.end();
        }
    }
    
    // Always return 200 OK quickly to Flutterwave
    res.status(200).send('OK');
                                }
