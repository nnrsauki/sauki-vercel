import pg from 'pg';
import fetch from 'node-fetch';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';

const { Client } = pg;
const CONNECTION_STRING = process.env.POSTGRES_URL;
const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY;
const ADMIN_AUTH = 'Basic ' + Buffer.from("AbdallahSauki:Abdallah@2025").toString('base64');

export default async function handler(req, res) {
    const client = new Client({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false } });
    await client.connect();

    try {
        // --- ADMIN GET ---
        if (req.method === 'GET' && req.headers.authorization === ADMIN_AUTH) {
            const usersRes = await client.query('SELECT id, phone_number, wallet_balance, virtual_account_number, virtual_bank_name, created_at FROM users ORDER BY created_at DESC LIMIT 100');
            await client.end();
            return res.status(200).json(usersRes.rows);
        }

        // --- USER GET (Balance & History) ---
        if (req.method === 'GET') {
            const { phone, type } = req.query;
            
            if (type === 'history') {
                const hist = await client.query('SELECT * FROM transactions WHERE phone_number = $1 ORDER BY created_at DESC LIMIT 20', [phone]);
                await client.end();
                return res.status(200).json(hist.rows);
            }

            const result = await client.query('SELECT phone_number, virtual_account_number, virtual_bank_name, wallet_balance FROM users WHERE phone_number = $1', [phone]);
            await client.end();
            return res.status(200).json({ exists: result.rows.length > 0, user: result.rows[0] });
        }

        // --- POST (Register/Login/Fund) ---
        if (req.method === 'POST') {
            if (req.body.action === 'fund') { // Admin Manual Fund
                 if (req.headers.authorization !== ADMIN_AUTH) { await client.end(); return res.status(401).json({ error: "Unauthorized" }); }
                const { phone, amount } = req.body;
                await client.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE phone_number = $2', [amount, phone]);
                await client.query(`INSERT INTO transactions (reference, phone_number, status, amount, new_balance, api_response, created_at) VALUES ($1, $2, 'credit', $3, 0, $4, NOW())`, ['MANUAL-' + Date.now(), phone, amount, '{"type":"admin_manual_fund"}']);
                await client.end();
                return res.status(200).json({ success: true });
            }

            const { action, phone, pin, bvn } = req.body;

            if (action === 'register') {
                if(!bvn) { await client.end(); return res.status(400).json({ error: "BVN/NIN is required" }); }
                
                // Create Flutterwave Account
                const flwRes = await fetch('https://api.flutterwave.com/v3/virtual-account-numbers', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${FLW_SECRET_KEY}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ email: `${phone}@saukidata.com`, is_permanent: true, bvn: bvn, tx_ref: `SAUKI-${uuidv4()}`, phonenumber: phone, firstname: "Sauki", lastname: `User ${phone}`, narration: "Sauki Wallet" })
                });
                const flwData = await flwRes.json();
                
                if (flwData.status !== 'success') {
                    await client.end();
                    return res.status(400).json({ error: 'Verification Failed. Ensure BVN is valid.', details: flwData.message });
                }

                const pinHash = await bcrypt.hash(pin, 10);
                await client.query(
                    `INSERT INTO users (phone_number, pin_hash, virtual_account_number, virtual_bank_name, virtual_account_name, wallet_balance) VALUES ($1, $2, $3, $4, $5, 0.00)`,
                    [phone, pinHash, flwData.data.account_number, flwData.data.bank_name, "SAUKI DATA - " + phone]
                );
                await client.end();
                return res.status(200).json({ success: true });
            }

            if (action === 'login') {
                const userRes = await client.query('SELECT * FROM users WHERE phone_number = $1', [phone]);
                if (userRes.rows.length === 0) { await client.end(); return res.status(404).json({ error: "User not found" }); }
                
                const validPin = await bcrypt.compare(pin, userRes.rows[0].pin_hash);
                await client.end();
                if (!validPin) return res.status(401).json({ error: "Invalid PIN" });

                const u = userRes.rows[0];
                return res.status(200).json({ success: true, data: { phone: u.phone_number, balance: u.wallet_balance, account_number: u.virtual_account_number, bank_name: u.virtual_bank_name } });
            }
        }
    } catch (e) { if(client) await client.end(); return res.status(500).json({ error: e.message }); }
                                                                                                                                                                                             }
