import pg from 'pg';
const { Client } = pg;

const CONNECTION_STRING = process.env.POSTGRES_URL; 
const FLW_SECRET_HASH = process.env.FLW_SECRET_HASH;

export default async function handler(req, res) {
    // 1. Verify Signature (Security)
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

            // A. Check for DUPLICATE transaction to prevent double funding
            const check = await client.query('SELECT id FROM transactions WHERE reference = $1', [String(data.tx_ref)]);
            if (check.rows.length > 0) {
                await client.end();
                return res.status(200).send('Duplicate');
            }

            // B. Find User
            // We look for the user based on the email attached to the virtual account (phone@saukidata.com)
            const email = data.customer.email; 
            const phoneFromEmail = email.split('@')[0];

            // Alternatively, check if the transfer is to a static virtual account we generated
            const userCheck = await client.query('SELECT * FROM users WHERE phone_number = $1', [phoneFromEmail]);

            if (userCheck.rows.length > 0) {
                const user = userCheck.rows[0];
                const amount = Number(data.amount);

                // C. INSTANT DATABASE UPDATE
                await client.query('BEGIN'); // Start transaction for safety
                
                // 1. Add money to wallet
                await client.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2', [amount, user.id]);

                // 2. Log the transaction history
                await client.query(
                    `INSERT INTO transactions (reference, phone_number, status, amount, new_balance, api_response, created_at) 
                     VALUES ($1, $2, 'credit', $3, $4, $5, NOW())`,
                    [data.tx_ref, user.phone_number, amount, Number(user.wallet_balance) + amount, JSON.stringify(data)]
                );

                await client.query('COMMIT'); // Save changes
                
                console.log(`SUCCESS: Funded ${user.phone_number} with ₦${amount}`);
            } else {
                console.log("WARNING: Payment received but User not found for email:", email);
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
    
    // Always return 200 OK to Flutterwave so they stop sending the webhook
    res.status(200).send('OK');
}
