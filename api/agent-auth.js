import pg from 'pg';
import fetch from 'node-fetch';
import crypto from 'crypto';

const { Client } = pg;
const CONNECTION_STRING = process.env.POSTGRES_URL;
const FLW_SECRET_KEY = process.env.FLW_SECRET_KEY;

export default async function handler(req, res) {
    const client = new Client({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false } });
    const hashPin = (pin) => crypto.createHash('sha256').update(pin).digest('hex');

    try {
        await client.connect();

        if (req.method === 'POST') {
            const { action, name, phone, bvn, pin } = req.body;

            // --- SIGNUP ---
            if (action === 'signup') {
                // 1. Check duplicate
                const check = await client.query('SELECT id FROM agents WHERE phone_number = $1', [phone]);
                if (check.rows.length > 0) return res.status(400).json({ error: 'Phone number already registered' });

                // 2. Create Static Virtual Account (Flutterwave)
                // Using 'is_permanent: true' creates a static account
                const flwPayload = {
                    email: "saukidatalinks@gmail.com",
                    is_permanent: true,
                    bvn: bvn,
                    tx_ref: `SAUKI-AGENT-${phone}-${Date.now()}`,
                    phonenumber: phone,
                    firstname: name.split(' ')[0],
                    lastname: name.split(' ')[1] || 'Agent',
                    narration: `Sauki Agent ${name.split(' ')[0]}`
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
                
                if(flwData.status !== 'success') {
                    console.error("FLW Error:", flwData);
                    return res.status(400).json({ error: flwData.message || 'BVN Validation Failed. Check BVN & Name.' });
                }

                const acc = flwData.data;

                // 3. Save to DB
                await client.query(
                    `INSERT INTO agents (phone_number, full_name, pin_hash, wallet_balance, virtual_account_bank, virtual_account_number, virtual_account_name, bvn_hash)
                     VALUES ($1, $2, $3, 0.00, $4, $5, $6, 'STORED')`,
                    [phone, name, hashPin(pin), acc.bank_name, acc.account_number, acc.note]
                );

                return res.status(200).json({ success: true });
            }

            // --- LOGIN ---
            if (action === 'login') {
                const result = await client.query('SELECT * FROM agents WHERE phone_number = $1', [phone]);
                
                if (result.rows.length === 0) return res.status(404).json({ error: 'Agent not found' });
                
                const agent = result.rows[0];
                if (agent.pin_hash !== hashPin(pin)) return res.status(401).json({ error: 'Incorrect PIN' });

                return res.status(200).json({ success: true, agent });
            }
        }
    } catch (e) {
        console.error("Auth Error:", e);
        return res.status(500).json({ error: "Server Error. Please verify Environment Variables." });
    } finally {
        await client.end();
    }
            }
