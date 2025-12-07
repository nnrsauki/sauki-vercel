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

            // 3. Find the EXISTING pending transaction using the reference (tx_ref)
            // This assumes your website created the record with status 'pending' before the user paid.
            const result = await client.query('SELECT * FROM transactions WHERE reference = $1', [data.tx_ref]);
            
            if (result.rows.length > 0) {
                const transaction = result.rows[0];

                // 4. Check if we actually need to deliver data (Idempotency)
                // If status is NOT 'success', we assume it's pending/failed and needs delivery.
                if (transaction.status !== 'success' && transaction.status !== 'successful') {
                    
                    console.log(`[Webhook] Found Pending Order: ${data.tx_ref}. Processing...`);

                    // 5. Extract data from YOUR DATABASE (No meta needed)
                    const { plan_id, phone_number, network } = transaction;

                    // 6. Fetch Plan Details to get the api ID
                    const planRes = await client.query('SELECT * FROM plans WHERE id = $1', [plan_id]);
                    
                    if (planRes.rows.length > 0) {
                        const plan = planRes.rows[0];
                        const NET_MAP = { 'mtn': 1, 'glo': 2, 'airtel': 3, '9mobile': 4 };
                        
                        // Use network from transaction or plan details
                        const netKey = (network || plan.network || '').toLowerCase();
                        const networkInt = NET_MAP[netKey] || 1;

                        // 7. Send to Amigo
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
                                Ported_number: true // Defaulting to true as meta is removed. 
                            })
                        };
                        
                        if (PROXY_URL) options.agent = new HttpsProxyAgent(PROXY_URL);

                        console.log(`[Webhook] Calling Amigo for ${data.tx_ref}...`);
                        const amigoRes = await fetch('https://amigo.ng/api/data/', options);
                        const amigoResult = await amigoRes.json();
                        
                        const isSuccess = (amigoResult.success === true || amigoResult.Status === 'successful');
                        const newStatus = isSuccess ? 'success' : 'failed';

                        // 8. UPDATE the existing record instead of inserting a new one
                        await client.query(
                            `UPDATE transactions 
                             SET status = $1, api_response = $2
                             WHERE reference = $3`,
                            [newStatus, JSON.stringify(amigoResult), data.tx_ref]
                        );

                        console.log(`[Webhook] Success: Updated ${data.tx_ref} to ${newStatus}`);
                    } else {
                        console.error(`[Webhook] Error: Plan ID ${plan_id} not found in DB`);
                    }
                } else {
                    console.log(`[Webhook] Ignored: ${data.tx_ref} is already successful.`);
                }
            } else {
                console.log(`[Webhook] Error: Transaction ${data.tx_ref} not found in DB.`);
                // Since meta is removed, we cannot create a new order here. 
                // We assume the order was created on the frontend.
            }
        } catch (e) {
            console.error("[Webhook] Critical Error:", e);
        } finally {
            await client.end();
        }
    }
    
    res.status(200).send('OK');
}
