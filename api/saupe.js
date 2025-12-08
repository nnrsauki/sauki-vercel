import fetch from 'node-fetch';

// ENV Variables
const ADMIN_USER = process.env.ADMIN_USERNAME;
const ADMIN_PASS = process.env.ADMIN_PASSWORD;
const FLUTTERWAVE_SECRET = process.env.FLUTTERWAVE_SECRET_KEY;

export default async function handler(req, res) {
    // 1. Security Layer: Validate Admin Credentials
    const authHeader = req.headers.authorization || '';
    const match = authHeader.match(/Basic (.+)/);
    
    if (!match) return res.status(401).json({ error: 'Unauthorized Access' });

    const [login, password] = Buffer.from(match[1], 'base64').toString().split(':');
    
    if (login !== ADMIN_USER || password !== ADMIN_PASS) {
        return res.status(401).json({ error: 'Invalid Credentials' });
    }

    if (!FLUTTERWAVE_SECRET) {
        return res.status(500).json({ error: 'Server Config Error: Missing Secret Key' });
    }

    // 2. Action Routing
    const { action } = req.query;
    const FW_BASE = 'https://api.flutterwave.com/v3';
    const HEADERS = {
        'Authorization': `Bearer ${FLUTTERWAVE_SECRET}`,
        'Content-Type': 'application/json'
    };

    try {
        if (action === 'balance') {
            // Fetch Balance
            const response = await fetch(`${FW_BASE}/balances`, { headers: HEADERS });
            const data = await response.json();
            return res.status(200).json(data);
        }

        if (action === 'transactions') {
            // Fetch Transactions (Last 20)
            const response = await fetch(`${FW_BASE}/transactions?limit=20`, { headers: HEADERS });
            const data = await response.json();
            return res.status(200).json(data);
        }

        return res.status(400).json({ error: 'Unknown Action' });

    } catch (e) {
        console.error("Saupe API Error:", e);
        return res.status(500).json({ error: 'Upstream Connection Failed' });
    }
}
