import pg from 'pg';
const { Client } = pg;

const CONNECTION_STRING = process.env.POSTGRES_URL; 
const FLW_SECRET_HASH = process.env.FLW_SECRET_HASH;

export default async function handler(req, res) {
    const signature = req.headers['verif-hash'];
    if (!FLW_SECRET_HASH || signature !== FLW_SECRET_HASH) {
        return res.status(401).send('Unverified');
    }

    const { event, data } = req.body;

    // Handle Transfer (Funding)
    if (event === 'charge.completed' && data.status === 'successful') {
        const client = new Client({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false } });
        
        try {
            await client.connect();
            console.log(`Webhook: Ref ${data.tx_ref}, Amt ${data.amount}`);

            // 1. Check for Duplicate
            const check = await client.query('SELECT id FROM transactions WHERE reference = $1', [String(data.tx_ref)]);
            if (check.rows.length > 0) {
                await client.end();
                return res.status(200).send('Duplicate');
            }

            // 2. Find User by Virtual Account Number (Best Method)
            const flwAccountNum = data.customer?.account_number || data.account_number;
            let userRes = await client.query('SELECT * FROM users WHERE virtual_account_number = $1', [flwAccountNum]);
            
            // Fallback: Find by Email
            if (userRes.rows.length === 0 && data.customer?.email) {
                const possiblePhone = data.customer.email.split('@')[0];
                userRes = await client.query('SELECT * FROM users WHERE phone_number = $1', [possiblePhone]);
            }

            if (userRes.rows.length > 0) {
                const user = userRes.rows[0];
                const amount = Number(data.amount);
                const newBalance = Number(user.wallet_balance || 0) + amount;

                await client.query('BEGIN');
                await client.query('UPDATE users SET wallet_balance = $1 WHERE id = $2', [newBalance, user.id]);
                await client.query(
                    `INSERT INTO transactions (reference, phone_number, status, amount, new_balance, api_response, created_at) 
                     VALUES ($1, $2, 'credit', $3, $4, $5, NOW())`,
                    [data.tx_ref, user.phone_number, amount, newBalance, JSON.stringify(data)]
                );
                await client.query('COMMIT');
                console.log(`Funded ${user.phone_number}: +${amount}`);
            }

            await client.end();

        } catch (e) {
            console.error("Webhook Error", e);
            if(client) { try{await client.query('ROLLBACK');}catch(e){} await client.end(); }
        }
    }
    
    res.status(200).send('OK');
}
