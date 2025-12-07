import fetch from 'node-fetch';
import pg from 'pg';
const { Client } = pg;

const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY;
const CONNECTION_STRING = process.env.POSTGRES_URL;

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({error: 'Method Not Allowed'});

    const { tx_ref, amount, email, phone_number, name, plan_id, ported } = req.body;

    if (!FLW_SECRET_KEY) return res.status(500).json({ error: 'Server Config Error' });

    const client = new Client({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false } });

    try {
        await client.connect();

        // 1. NEW STEP: Save 'Pending' Transaction to DB immediately
        // This ensures the Webhook can find the plan_id later.
        try {
            await client.query(
                `INSERT INTO transactions (phone_number, network, plan_id, status, reference, created_at) 
                 VALUES ($1, 'unknown', $2, 'pending', $3, NOW())
                 ON CONFLICT (reference) DO UPDATE SET status = 'pending', phone_number = $1, plan_id = $2`,
                [phone_number, plan_id, tx_ref]
            );
            console.log(`[Transfer] Saved pending order: ${tx_ref}`);
        } catch(dbErr) {
            console.error("DB Save Error in Initiate Transfer:", dbErr);
            // We continue even if DB fails, though it's risky for the webhook logic
        }

        // 2. Proceed to call Flutterwave
        const payload = {
            tx_ref: tx_ref,
            amount: amount,
            currency: "NGN",
            email: email,
            phone_number: phone_number,
            fullname: name,
            is_bank_transfer: true,
            // We still send meta to FLW just in case, but your Webhook won't use it.
            meta: { plan_id, ported, consumer_id: phone_number }
        };

        const flwRes = await fetch('https://api.flutterwave.com/v3/charges?type=bank_transfer', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${FLW_SECRET_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        const json = await flwRes.json();

        if (json.status === 'success') {
            const auth = json.meta.authorization;
            
            return res.status(200).json({
                success: true,
                account_number: auth.transfer_account,
                bank_name: auth.transfer_bank,
                amount: auth.transfer_amount || amount,
                account_name: auth.account_name || "Sauki Data", 
                note: auth.transfer_note
            });
        } else {
            return res.status(400).json({ success: false, message: json.message || "Could not generate account" });
        }

    } catch (e) {
        console.error("Transfer Error:", e);
        return res.status(500).json({ error: e.message });
    } finally {
        await client.end();
    }
}
