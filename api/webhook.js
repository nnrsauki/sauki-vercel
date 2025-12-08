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
    // 1. Security
    const signature = req.headers['verif-hash'];
    if (!signature || signature !== FLW_SECRET_HASH) {
        return res.status(401).send('Unverified');
    }
    
    const { event, data } = req.body;
    console.log("Webhook Received:", event, data.tx_ref);

    if (event === 'charge.completed' && data.status === 'successful') {
        const client = new Client({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false } });
        
        try {
            await client.connect();

            // 1. CHECK WEBSITE ORDER
            const result = await client.query('SELECT * FROM transactions WHERE reference = $1', [data.tx_ref]);
            
            if (result.rows.length > 0) {
                // EXISTING WEBSITE LOGIC (Amigo Delivery)
                const transaction = result.rows[0];
                if (transaction.status !== 'success' && transaction.status !== 'successful') {
                    const { plan_id, phone_number, network } = transaction;
                    const planRes = await client.query('SELECT * FROM plans WHERE id = $1', [plan_id]);
                    
                    if (planRes.rows.length > 0) {
                        const plan = planRes.rows[0];
                        const NET_MAP = { 'mtn': 1, 'glo': 2, 'airtel': 3, '9mobile': 4 };
                        const netKey = (network || plan.network || '').toLowerCase();
                        
                        const options = {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Authorization': `Token ${AMIGO_API_KEY}`, 'X-API-Key': AMIGO_API_KEY },
                            body: JSON.stringify({ 
                                network: NET_MAP[netKey] || 1, 
                                mobile_number: phone_number, 
                                plan: plan.plan_id_api, 
                                Ported_number: true 
                            })
                        };
                        
                        if (PROXY_URL) options.agent = new HttpsProxyAgent(PROXY_URL);
                        const amigoRes = await fetch('https://amigo.ng/api/data/', options);
                        const amigoResult = await amigoRes.json();
                        const isSuccess = (amigoResult.success === true || amigoResult.Status === 'successful');

                        await client.query(
                            `UPDATE transactions SET status = $1, api_response = $2 WHERE reference = $3`,
                            [isSuccess ? 'success' : 'failed', JSON.stringify(amigoResult), data.tx_ref]
                        );
                    }
                }
            } else {
                // 2. CHECK AGENT FUNDING
                // Flutterwave sends the account number in data.account.nuban OR data.account_number
                const incomingAccount = data.account?.nuban || data.account_number;
                const incomingPhone = data.customer?.phone_number;

                console.log(`Checking Agent for Account: ${incomingAccount} or Phone: ${incomingPhone}`);

                const agentRes = await client.query(
                    'SELECT * FROM agents WHERE virtual_account_number = $1 OR phone_number = $2', 
                    [incomingAccount, incomingPhone]
                );

                if (agentRes.rows.length > 0) {
                    const agent = agentRes.rows[0];
                    const amount = data.amount;
                    const ref = data.tx_ref || String(data.id);

                    // Idempotency
                    const logCheck = await client.query('SELECT id FROM funding_logs WHERE reference = $1', [ref]);
                    
                    if (logCheck.rows.length === 0) {
                        await client.query('UPDATE agents SET wallet_balance = wallet_balance + $1 WHERE id = $2', [amount, agent.id]);
                        await client.query('INSERT INTO funding_logs (reference, agent_phone, amount) VALUES ($1, $2, $3)', [ref, agent.phone_number, amount]);
                        console.log(`FUNDED: ${agent.full_name} +${amount}`);
                    } else {
                        console.log("Duplicate Funding Ignored");
                    }
                } else {
                    console.log("No Agent found for this payment.");
                }
            }
        } catch (e) {
            console.error("Webhook Logic Error:", e);
        } finally {
            await client.end();
        }
    }
    
    res.status(200).send('OK');
}
