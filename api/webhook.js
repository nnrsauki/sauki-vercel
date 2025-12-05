import pg from 'pg';
const { Client } = pg;

const CONNECTION_STRING = process.env.POSTGRES_URL; 
const FLW_SECRET_HASH = process.env.FLW_SECRET_HASH;

export default async function handler(req, res) {
    // 1. Verify Signature
    const signature = req.headers['verif-hash'];
    
    // Safety check: If you forgot to set the env var, we log a warning but don't crash
    if (!FLW_SECRET_HASH) {
        console.warn("CRITICAL: FLW_SECRET_HASH is missing in environment variables.");
    } else if (!signature || signature !== FLW_SECRET_HASH) {
        // If hash exists but doesn't match, reject.
        console.error("Webhook Signature Mismatch.");
        return res.status(401).send('Unverified');
    }

    const { event, data } = req.body;

    // 2. Handle Incoming Transfer (Funding Wallet)
    if (event === 'charge.completed' && data.status === 'successful') {
        const client = new Client({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false } });
        
        try {
            await client.connect();

            // A. Check for Duplicate Transaction
            const check = await client.query('SELECT id FROM transactions WHERE reference = $1', [String(data.tx_ref)]);
            if (check.rows.length > 0) {
                await client.end();
                return res.status(200).send('Duplicate');
            }

            // B. Find User
            // Logic: Try to match by email (phone@saukidata.com)
            let user = null;
            const email = data.customer.email;
            
            if (email && email.includes('@')) {
                // Extract phone from "08123456789@saukidata.com"
                const possiblePhone = email.split('@')[0];
                const userRes = await client.query('SELECT * FROM users WHERE phone_number = $1', [possiblePhone]);
                if (userRes.rows.length > 0) user = userRes.rows[0];
            }

            if (user) {
                const amount = Number(data.amount);
                const newBalance = Number(user.wallet_balance) + amount;

                await client.query('BEGIN'); // Start Safe Transaction

                // 1. Update Wallet
                await client.query('UPDATE users SET wallet_balance = $1 WHERE id = $2', [newBalance, user.id]);

                // 2. Record Transaction (Now using the verified columns)
                // Note: We use 0 for plan_id since this is funding
                await client.query(
                    `INSERT INTO transactions (reference, phone_number, status, amount, new_balance, api_response, created_at) 
                     VALUES ($1, $2, 'credit', $3, $4, $5, NOW())`,
                    [data.tx_ref, user.phone_number, amount, newBalance, JSON.stringify(data)]
                );

                await client.query('COMMIT'); // Save Changes
                console.log(`WEBHOOK SUCCESS: Funded ${user.phone_number} with ₦${amount}`);
            } else {
                console.error("WEBHOOK FAILED: User not found for email:", email);
            }

            await client.end();

        } catch (e) {
            console.error("WEBHOOK ERROR:", e);
            if(client) {
                try { await client.query('ROLLBACK'); } catch(err) {}
                await client.end();
            }
        }
    }
    
    // Always return 200 to Flutterwave
    res.status(200).send('OK');
}
