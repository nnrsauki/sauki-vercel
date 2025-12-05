import pg from 'pg';
const { Client } = pg;

const CONNECTION_STRING = process.env.POSTGRES_URL; 
const FLW_SECRET_HASH = process.env.FLW_SECRET_HASH;

export default async function handler(req, res) {
    // 1. Verify Signature (Relaxed for Debugging)
    const signature = req.headers['verif-hash'];
    if (!FLW_SECRET_HASH) {
        console.warn("WARNING: FLW_SECRET_HASH is not set in environment variables. Skipping security check.");
    } else if (!signature || signature !== FLW_SECRET_HASH) {
        // Log the mismatch to help you debug
        console.error(`Hash Mismatch! Received: ${signature}, Expected: ${FLW_SECRET_HASH}`);
        return res.status(401).send('Unverified');
    }

    const { event, data } = req.body;
    console.log("Webhook Received:", event, data.tx_ref);

    // 2. Handle Incoming Transfer
    if (event === 'charge.completed' && data.status === 'successful') {
        const client = new Client({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false } });
        
        try {
            await client.connect();

            // A. Check for Duplicate
            const check = await client.query('SELECT id FROM transactions WHERE reference = $1', [String(data.tx_ref)]);
            if (check.rows.length > 0) {
                await client.end();
                return res.status(200).send('Duplicate');
            }

            let user = null;

            // B. Try Finding User by Virtual Account Number (Most Reliable)
            // Note: Flutterwave payload structure varies. Sometimes account info is in 'data.account' or 'data.customer'
            // We check if the transaction is strictly a transfer to a virtual account.
            
            // Strategy 1: Search by Email (Created as phone@saukidata.com)
            const email = data.customer.email;
            if (email && email.includes('@saukidata.com')) {
                const phone = email.split('@')[0];
                const res = await client.query('SELECT * FROM users WHERE phone_number = $1', [phone]);
                if (res.rows.length > 0) user = res.rows[0];
            }

            // Strategy 2: If Email failed, try searching by the "narration" if it contains the phone number
            // (Often the narration is "Transfer from Name to Sauki Data - 081...")
            if (!user && data.narration) {
                // This is a fuzzy fallback
                console.log("Searching user via narration:", data.narration);
            }

            if (user) {
                const amount = Number(data.amount);
                const newBalance = Number(user.wallet_balance) + amount;

                await client.query('BEGIN');
                await client.query('UPDATE users SET wallet_balance = $1 WHERE id = $2', [newBalance, user.id]);
                
                await client.query(
                    `INSERT INTO transactions (reference, phone_number, status, amount, new_balance, api_response, created_at) 
                     VALUES ($1, $2, 'credit', $3, $4, $5, NOW())`,
                    [data.tx_ref, user.phone_number, amount, newBalance, JSON.stringify(data)]
                );
                await client.query('COMMIT');
                
                console.log(`SUCCESS: Funded ${user.phone_number} with ₦${amount}`);
            } else {
                console.error("FAILED: Payment received but User not found. Data:", JSON.stringify(data));
            }

            await client.end();

        } catch (e) {
            console.error("Webhook Error:", e);
            if(client) {
                try { await client.query('ROLLBACK'); } catch(err) {}
                await client.end();
            }
        }
    }
    
    res.status(200).send('OK');
}
