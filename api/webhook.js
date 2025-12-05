import pg from 'pg';
const { Client } = pg;

const CONNECTION_STRING = process.env.POSTGRES_URL; 
const FLW_SECRET_HASH = process.env.FLW_SECRET_HASH;

export default async function handler(req, res) {
    // 1. Verify Signature (Security)
    const signature = req.headers['verif-hash'];
    
    if (!FLW_SECRET_HASH) {
        console.warn("WARNING: FLW_SECRET_HASH is not set in env variables. Webhook is insecure.");
    } else if (!signature || signature !== FLW_SECRET_HASH) {
        console.error("Webhook Signature Mismatch. potential attack.");
        return res.status(401).send('Unverified');
    }

    const { event, data } = req.body;

    // 2. Handle Incoming Transfer (Funding Wallet)
    if (event === 'charge.completed' && data.status === 'successful') {
        const client = new Client({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false } });
        
        try {
            await client.connect();
            console.log(`Webhook received for Ref: ${data.tx_ref}, Amount: ${data.amount}`);

            // A. Check for Duplicate Transaction
            const check = await client.query('SELECT id FROM transactions WHERE reference = $1', [String(data.tx_ref)]);
            if (check.rows.length > 0) {
                console.log("Duplicate transaction ignored.");
                await client.end();
                return res.status(200).send('Duplicate');
            }

            // B. Find User
            // Method 1: Check by Virtual Account Number (Most Reliable)
            // Flutterwave sends 'account_number' in customer object or data object depending on payload version
            const flwAccountNum = data.customer?.account_number || data.account_number;
            
            let userRes = await client.query('SELECT * FROM users WHERE virtual_account_number = $1', [flwAccountNum]);
            
            // Method 2: Fallback to Email Matching (phone@saukidata.com)
            if (userRes.rows.length === 0 && data.customer?.email) {
                console.log("Searching by email:", data.customer.email);
                const email = data.customer.email;
                if (email.includes('@')) {
                    const possiblePhone = email.split('@')[0]; // Extract '081...'
                    userRes = await client.query('SELECT * FROM users WHERE phone_number = $1', [possiblePhone]);
                }
            }

            if (userRes.rows.length > 0) {
                const user = userRes.rows[0];
                const amount = Number(data.amount);
                // Ensure we don't add null values
                const currentBal = Number(user.wallet_balance || 0);
                const newBalance = currentBal + amount;

                await client.query('BEGIN'); // Start Safe Transaction

                // 1. Update Wallet
                await client.query('UPDATE users SET wallet_balance = $1 WHERE id = $2', [newBalance, user.id]);

                // 2. Record Transaction
                await client.query(
                    `INSERT INTO transactions (reference, phone_number, status, amount, new_balance, api_response, created_at) 
                     VALUES ($1, $2, 'credit', $3, $4, $5, NOW())`,
                    [data.tx_ref, user.phone_number, amount, newBalance, JSON.stringify(data)]
                );

                await client.query('COMMIT'); 
                console.log(`SUCCESS: Funded ${user.phone_number} with ₦${amount}. New Bal: ₦${newBalance}`);
            } else {
                console.error("FAILED: User not found for payload:", JSON.stringify(data));
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
    
    // Always return 200 to Flutterwave to stop them from retrying
    res.status(200).send('OK');
}
