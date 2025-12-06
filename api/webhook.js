import fetch from 'node-fetch';
import pg from 'pg';
const { Client } = pg;
import { HttpsProxyAgent } from 'https-proxy-agent';

// Reuse env vars
const AMIGO_API_KEY = process.env.AMIGO_API_KEY;
const PROXY_URL = process.env.PROXY_URL; 
const CONNECTION_STRING = process.env.POSTGRES_URL; 
const FLW_SECRET_HASH = process.env.FLW_SECRET_HASH; 

export default async function handler(req, res) {
    // 1. Security Check
    if (req.headers['verif-hash'] !== FLW_SECRET_HASH) {
        return res.status(401).send('Unverified');
    }
    
    const { event, data } = req.body;
    
    // 2. Only Process Successful Payments
    if (event === 'charge.completed' && data.status === 'successful') {
        const client = new Client({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false } });
        
        try {
            await client.connect();

            // 3. Check if transaction already fulfilled (by Frontend)
            // Note: 'tx_ref' from FLW is in data.tx_ref
            const check = await client.query('SELECT id FROM transactions WHERE reference = $1', [data.tx_ref]);
            
            if (check.rows.length === 0) {
                // TRANSACTION MISSING IN DB -> Fulfill it now!
                console.log(`Webhook fulfilling missed order: ${data.tx_ref}`);

                // Extract Details from Meta (sent from Frontend)
                // Flutterwave puts meta in data.meta or data.customer.meta depending on version
                // We handle standard data.meta here
                const planId = data.meta?.plan_id; 
                const ported = data.meta?.ported === true || data.meta?.ported === "true";
                const phone = data.customer?.phone_number;

                if (planId && phone) {
                    // Fetch Plan API ID
                    const planRes = await client.query('SELECT * FROM plans WHERE id = $1', [planId]);
                    
                    if (planRes.rows.length > 0) {
                        const plan = planRes.rows[0];
                        const NET_MAP = { 'mtn': 1, 'glo': 2, 'airtel': 3, '9mobile': 4 };
                        const networkInt = NET_MAP[plan.network.toLowerCase()] || 1;

                        // Call Amigo (Same logic as purchase.js)
                        const options = {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'X-API-Key': AMIGO_API_KEY },
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
                        
                        const status = (amigoResult.success === true || amigoResult.Status === 'successful') ? 'success' : 'failed';

                        // Save to DB
                        await client.query(
                            `INSERT INTO transactions (phone_number, network, plan_id, status, reference, api_response, created_at) 
                             VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
                            [phone, plan.network, planId, status, data.tx_ref, JSON.stringify(amigoResult)]
                        );
                        console.log("Webhook Fulfillment Complete");
                    }
                }
            } else {
                console.log("Webhook: Transaction already handled by Frontend.");
            }
        } catch (e) {
            console.error("Webhook Error:", e);
        } finally {
            await client.end();
        }
    }
    
    // Always return 200 to FLW
    res.status(200).send('OK');
}
