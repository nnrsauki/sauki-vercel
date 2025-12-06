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
    // 1. Security: Verify the Hash
    const signature = req.headers['verif-hash'];
    if (!signature || signature !== FLW_SECRET_HASH) {
        return res.status(401).send('Unverified');
    }
    
    const { event, data } = req.body;
    
    // 2. Only Process "Successful" Charges
    if (event === 'charge.completed' && data.status === 'successful') {
        const client = new Client({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false } });
        
        try {
            await client.connect();

            // 3. Idempotency: Check if transaction was already processed
            // This prevents double-delivery if the user clicked "I have paid" AND the webhook fires
            const check = await client.query('SELECT id FROM transactions WHERE reference = $1', [data.tx_ref]);
            
            if (check.rows.length === 0) {
                console.log(`Webhook Processing: ${data.tx_ref}`);

                // 4. ROBUST DATA EXTRACTION
                // Since you checked "Add meta to webhook", the data is in data.meta
                const meta = data.meta || {};
                
                const planId = meta.plan_id; 
                // Handle "true" string or true boolean
                const ported = meta.ported === true || meta.ported === "true"; 
                // Phone is either in meta (consumer_id) or customer object
                const phone = meta.consumer_id || data.customer?.phone_number;

                if (planId && phone) {
                    // 5. Fetch Plan Details from DB
                    const planRes = await client.query('SELECT * FROM plans WHERE id = $1', [planId]);
                    
                    if (planRes.rows.length > 0) {
                        const plan = planRes.rows[0];
                        const NET_MAP = { 'mtn': 1, 'glo': 2, 'airtel': 3, '9mobile': 4 };
                        const networkInt = NET_MAP[plan.network.toLowerCase()] || 1;

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
                                mobile_number: phone, 
                                plan: plan.plan_id_api, 
                                Ported_number: ported 
                            })
                        };
                        
                        if (PROXY_URL) options.agent = new HttpsProxyAgent(PROXY_URL);

                        const amigoRes = await fetch('https://amigo.ng/api/data/', options);
                        const amigoResult = await amigoRes.json();
                        
                        const isSuccess = (amigoResult.success === true || amigoResult.Status === 'successful');
                        const status = isSuccess ? 'success' : 'failed';

                        // 7. Save Transaction to DB
                        await client.query(
                            `INSERT INTO transactions (phone_number, network, plan_id, status, reference, api_response, created_at) 
                             VALUES ($1, $2, $3, $4, $5, $6, NOW())
                             ON CONFLICT (reference) DO NOTHING`, // Extra safety against race conditions
                            [phone, plan.network, planId, status, data.tx_ref, JSON.stringify(amigoResult)]
                        );
                        console.log(`Webhook Success: Delivered ${planId} to ${phone}`);
                    } else {
                        console.error(`Webhook Error: Plan ID ${planId} not found in DB`);
                    }
                } else {
                    console.error("Webhook Error: Missing Plan ID or Phone in Meta data");
                }
            } else {
                console.log("Webhook: Transaction already handled/exists.");
            }
        } catch (e) {
            console.error("Webhook Critical Error:", e);
        } finally {
            await client.end();
        }
    }
    
    // Always return 200 OK to Flutterwave so they don't keep retrying unnecessarily
    res.status(200).send('OK');
}
