import fetch from 'node-fetch';

// ENV Variables
const ADMIN_USER = process.env.ADMIN_USERNAME;
const ADMIN_PASS = process.env.ADMIN_PASSWORD;
const FLUTTERWAVE_SECRET = process.env.FLUTTERWAVE_SECRET_KEY;

export default async function handler(req, res) {
    // --- AUTHENTICATION BLOCK (COPIED EXACTLY FROM ADMIN.JS) ---
    const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
    const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');

    // DEBUGGING LOG (Remove this after it works!)
    // Check your server console/logs to see what is printing here.
    // console.log("Login Attempt:", login, "Expected:", ADMIN_USER);

    // Strict comparison just like admin.js
    if (login !== ADMIN_USER || password !== ADMIN_PASS) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    // -----------------------------------------------------------

    // Check Flutterwave Key
    if (!FLUTTERWAVE_SECRET) {
        return res.status(500).json({ error: 'Server Config Error: FLUTTERWAVE_SECRET_KEY is missing' });
    }

    const { action } = req.query;
    const FW_BASE = 'https://api.flutterwave.com/v3';
    const HEADERS = {
        'Authorization': `Bearer ${FLUTTERWAVE_SECRET}`,
        'Content-Type': 'application/json'
    };

    try {
        if (action === 'balance') {
            const response = await fetch(`${FW_BASE}/balances`, { headers: HEADERS });
            const data = await response.json();
            return res.status(200).json(data);
        }

        if (action === 'transactions') {
            const response = await fetch(`${FW_BASE}/transactions?limit=20`, { headers: HEADERS });
            const data = await response.json();
            return res.status(200).json(data);
        }

        return res.status(400).json({ error: 'Invalid Action' });

    } catch (e) {
        console.error("Saupe API Error:", e);
        return res.status(500).json({ error: 'Connection Failed: ' + e.message });
    }
}
