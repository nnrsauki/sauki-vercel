import fetch from 'node-fetch';

// Environment Variables (These are likely already set in your project)
const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY;

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({error: 'Method Not Allowed'});

    const { tx_ref, amount, email, phone_number, name, plan_id, ported } = req.body;

    if (!tx_ref || !amount || !email) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!FLW_SECRET_KEY) {
        return res.status(500).json({ error: 'Server Config Error: Missing Secret Key' });
    }

    try {
        // We pass the plan_id and ported status in the 'meta' object.
        // This ensures that if the user pays but closes the browser, the webhook
        // (webhook.js) can read this meta data and fulfill the order automatically.
        const payload = {
            tx_ref: tx_ref,
            amount: amount,
            currency: "NGN",
            email: email,
            phone_number: phone_number,
            fullname: name,
            is_bank_transfer: true, // Hint to FLW to prioritize transfer
            meta: {
                plan_id: plan_id,
                ported: ported,
                consumer_id: phone_number
            }
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
            // Flutterwave returns the bank details in meta.authorization
            const auth = json.meta.authorization;
            return res.status(200).json({
                success: true,
                account_number: auth.transfer_account,
                bank_name: auth.transfer_bank,
                amount: auth.transfer_amount || amount,
                note: auth.transfer_note
            });
        } else {
            console.error("FLW Init Error:", json);
            return res.status(400).json({ 
                success: false, 
                message: json.message || "Could not generate account" 
            });
        }

    } catch (e) {
        console.error("Initiate Transfer Error:", e);
        return res.status(500).json({ error: e.message });
    }
}
