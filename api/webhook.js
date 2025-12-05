import pg from 'pg';
import fetch from 'node-fetch';
const { Client } = pg;

const CONNECTION_STRING = process.env.POSTGRES_URL; 
const FLW_SECRET_HASH = process.env.FLW_SECRET_HASH;
const TERMII_API_KEY = process.env.TERMII_API_KEY;
const ADMIN_PHONE = "2348164135836"; 

export default async function handler(req, res) {
    // 1. Verify Signature
    const signature = req.headers['verif-hash'];
    if (!signature || signature !== FLW_SECRET_HASH) {
        return res.status(401).send('Unverified');
    }

    const { event, data } = req.body;

    // 2. Handle Incoming Transfer (Funding Wallet)
    if (event === 'charge.completed' && data.status === 'successful') {
        const client = new Client({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false } });
        
        try {
            await client.connect();

            // A. Check if this is a DUPLICATE transaction
            const check = await client.query('SELECT id FROM transactions WHERE reference = $1', [String(data.tx_ref)]);
            if (check.rows.length > 0) {
                await client.end();
                return res.status(200).send('Duplicate');
            }

            // B. Find User by Virtual Account Number
            // Flutterwave usually sends the account number credited in 'data.account_number' or we match by customer email
            // Note: For Virtual Accounts, the recipient info is in the transaction details.
            
            // We search for the user who owns this Virtual Account Number
            // NOTE: data.customer.phone_number might be the SENDER's phone, not our user's.
            // We rely on the receiver account number provided in the payload (often in data.account_id or similar, but 
            // the most reliable way for Virtual Accounts is usually the Reference or matching the "customer.email" if we set it to phone@saukidata.com).
            
            // Let's use the email we set during creation: "080123...@saukidata.com"
            const email = data.customer.email;
            const phoneFromEmail = email.split('@')[0];

            const userCheck = await client.query('SELECT * FROM users WHERE phone_number = $1', [phoneFromEmail]);

            if (userCheck.rows.length > 0) {
                const user = userCheck.rows[0];
                const amount = data.amount;

                // C. Update User Wallet
                await client.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [amount, user.id]);

                // D. Record Transaction
                await client.query(
                    `INSERT INTO transactions (reference, phone_number, status, amount, new_balance, api_response, created_at) 
                     VALUES ($1, $2, 'credit', $3, $4, $5, NOW())`,
                    [data.tx_ref, user.phone_number, amount, Number(user.wallet_balance) + Number(amount), JSON.stringify(data)]
                );
                
                console.log(`Wallet Funded: ${user.phone_number} +${amount}`);
            } else {
                console.log("Payment received but user not found for email:", email);
            }

            await client.end();

            // E. Optional Admin Alert
            if (TERMII_API_KEY) {
                // ... Existing SMS code ...
            }

        } catch (e) {
            console.error("Webhook Error:", e);
            if(client) await client.end();
        }
    }
    
    res.status(200).send('OK');
}
