import fetch from 'node-fetch';

const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY;

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({error: 'Method Not Allowed'});

    const { tx_ref, amount, email, phone_number, name, plan_id, ported } = req.body;

    if (!FLW_SECRET_KEY) return res.status(500).json({ error: 'Server Config Error' });

    try {
        const payload = {
            tx_ref: tx_ref,
            amount: amount,
            currency: "NGN",
            email: email,
            phone_number: phone_number,
            fullname: name,
            is_bank_transfer: true,
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
            
            // LOGIC: Flutterwave sometimes returns account name in different fields depending on the bank
            // We prioritize note or account_name if available.
            // Usually, for virtual accounts, the bank name is fixed, but we want the dynamic beneficiary name.
            
            return res.status(200).json({
                success: true,
                account_number: auth.transfer_account,
                bank_name: auth.transfer_bank,
                amount: auth.transfer_amount || amount,
                // Pass the specific note/instruction which usually contains the name for FLW transfers
                account_name: auth.account_name || "Sauki Data", 
                note: auth.transfer_note
            });
        } else {
            return res.status(400).json({ success: false, message: json.message || "Could not generate account" });
        }

    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
}
