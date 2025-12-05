import fetch from 'node-fetch';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import { HttpsProxyAgent } from 'https-proxy-agent';

const { Client } = pg;
const AMIGO_API_KEY = process.env.AMIGO_API_KEY;
const PROXY_URL = process.env.PROXY_URL; 
const CONNECTION_STRING = process.env.POSTGRES_URL; 

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({error: 'Method Not Allowed'});

    const { phone, pin, plan_id, beneficiary, ported } = req.body;

    if (!phone || !pin || !plan_id || !beneficiary) return res.status(400).json({ error: 'Missing details' });

    const client = new Client({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false } });

    try {
        await client.connect();

        // 1. Authenticate User & Check Balance (Atomic Transaction Start)
        await client.query('BEGIN');

        const userRes = await client.query('SELECT * FROM users WHERE phone_number = $1 FOR UPDATE', [phone]); // Lock user row
        if (userRes.rows.length === 0) {
            await client.query('ROLLBACK'); await client.end();
            return res.status(400).json({ error: 'User not found' });
        }

        const user = userRes.rows[0];

        // Verify PIN
        const validPin = await bcrypt.compare(pin, user.pin_hash);
        if (!validPin) {
            await client.query('ROLLBACK'); await client.end();
            return res.status(401).json({ error: 'Incorrect PIN' });
        }

        // Get Plan Price
        const planRes = await client.query('SELECT * FROM plans WHERE id = $1', [plan_id]);
        if (planRes.rows.length === 0) { 
            await client.query('ROLLBACK'); await client.end();
            return res.status(400).json({ error: 'Invalid Plan' }); 
        }
        const plan = planRes.rows[0];

        // Check Funds
        if (Number(user.wallet_balance) < Number(plan.price)) {
            await client.query('ROLLBACK'); await client.end();
            return res.status(400).json({ error: 'Insufficient Balance. Please transfer money to your dedicated account number.' });
        }

        // 2. Deduct Balance
        const newBalance = Number(user.wallet_balance) - Number(plan.price);
        await client.query('UPDATE users SET wallet_balance = $1 WHERE id = $2', [newBalance, user.id]);

        // 3. Send Data via Amigo
        const NET_MAP = { 'mtn': 1, 'glo': 2, 'airtel': 3, '9mobile': 4 };
        const networkInt = NET_MAP[plan.network.toLowerCase()] || 1;

        const options = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-API-Key': AMIGO_API_KEY },
            body: JSON.stringify({ network: networkInt, mobile_number: beneficiary, plan: plan.plan_id_api, Ported_number: !!ported })
        };
        if (PROXY_URL) options.agent = new HttpsProxyAgent(PROXY_URL);

        const amigoRes = await fetch('https://amigo.ng/api/data/', options);
        const amigoResult = await amigoRes.json();

        // 4. Handle Result
        if (amigoResult.success) {
            // Success: Commit Transaction
            await client.query(
                `INSERT INTO transactions (phone_number, network, plan_id, status, reference, amount, new_balance, api_response, created_at) 
                 VALUES ($1, $2, $3, 'success', $4, $5, $6, $7, NOW())`,
                [phone, plan.network, plan.id, 'REF-' + Date.now(), plan.price, newBalance, JSON.stringify(amigoResult)]
            );
            await client.query('COMMIT');
            await client.end();
            return res.status(200).json({ success: true, message: 'Data Sent!', new_balance: newBalance });
        } else {
            // Failure: Refund User (Rollback the deduction)
            await client.query('ROLLBACK');
            await client.end();
            return res.status(400).json({ success: false, error: 'Provider Failed: ' + amigoResult.message });
        }

    } catch (e) {
        if(client) {
            try { await client.query('ROLLBACK'); } catch(err) {}
            await client.end();
        }
        return res.status(500).json({ error: e.message });
    }
}
