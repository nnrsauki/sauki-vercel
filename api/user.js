import pg from 'pg';
import fetch from 'node-fetch';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';

const { Client } = pg;

const CONNECTION_STRING = process.env.POSTGRES_URL;
const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY;

export default async function handler(req, res) {
    const client = new Client({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false } });
    await client.connect();

    try {
        // --- LOGIN / CHECK USER ---
        if (req.method === 'GET') {
            const { phone } = req.query;
            const result = await client.query('SELECT phone_number, virtual_account_number FROM users WHERE phone_number = $1', [phone]);
            
            await client.end();
            
            if (result.rows.length > 0) {
                return res.status(200).json({ exists: true, user: result.rows[0] });
            } else {
                return res.status(200).json({ exists: false });
            }
        }

        // --- REGISTER / CREATE ACCOUNT ---
        if (req.method === 'POST') {
            const { action, phone, pin, bvn } = req.body;

            // 1. Create New User & Virtual Account
            if (action === 'register') {
                if(!bvn) {
                    await client.end();
                    return res.status(400).json({ error: "BVN/NIN is required" });
                }

                // A. Create Virtual Account on Flutterwave
                const flwPayload = {
                    email: `${phone}@saukidata.com`,
                    is_permanent: true,
                    bvn: bvn, // UPDATED: Using the BVN provided by the user
                    tx_ref: `SAUKI-${uuidv4()}`,
                    phonenumber: phone,
                    firstname: "Sauki",
                    lastname: `User ${phone}`,
                    narration: "Sauki Data Wallet Funding"
                };

                const flwRes = await fetch('https://api.flutterwave.com/v3/virtual-account-numbers', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${FLW_SECRET_KEY}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(flwPayload)
                });

                const flwData = await flwRes.json();

                if (flwData.status !== 'success') {
                    await client.end();
                    console.error("Flutterwave Error:", flwData); // Log error for debugging
                    return res.status(400).json({ 
                        error: 'Could not generate Account. Ensure BVN is valid.', 
                        details: flwData.message 
                    });
                }

                const account = flwData.data;
                const pinHash = await bcrypt.hash(pin, 10);

                // B. Save to Database
                await client.query(
                    `INSERT INTO users (phone_number, pin_hash, virtual_account_number, virtual_bank_name, virtual_account_name, wallet_balance)
                     VALUES ($1, $2, $3, $4, $5, 0.00) RETURNING *`,
                    [phone, pinHash, account.account_number, account.bank_name, "SAUKI DATA - " + phone]
                );

                await client.end();
                return res.status(200).json({ success: true });
            }

            // 2. Login (Verify PIN & Get Data)
            if (action === 'login') {
                const userRes = await client.query('SELECT * FROM users WHERE phone_number = $1', [phone]);
                
                if (userRes.rows.length === 0) {
                    await client.end();
                    return res.status(404).json({ error: "User not found" });
                }

                const user = userRes.rows[0];
                const validPin = await bcrypt.compare(pin, user.pin_hash);

                await client.end();

                if (!validPin) {
                    return res.status(401).json({ error: "Invalid PIN" });
                }

                // Return user details (excluding hash)
                return res.status(200).json({
                    success: true,
                    data: {
                        phone: user.phone_number,
                        balance: user.wallet_balance,
                        account_number: user.virtual_account_number,
                        bank_name: user.virtual_bank_name,
                        account_name: user.virtual_account_name
                    }
                });
            }
        }
    } catch (e) {
        if(client) await client.end();
        return res.status(500).json({ error: e.message });
    }
}
