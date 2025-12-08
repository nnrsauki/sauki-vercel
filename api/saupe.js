import fetch from 'node-fetch';

// ENV Variables
const ADMIN_USER = process.env.ADMIN_USERNAME;
const ADMIN_PASS = process.env.ADMIN_PASSWORD;
const FLUTTERWAVE_SECRET = process.env.FLUTTERWAVE_SECRET_KEY;

export default async function handler(req, res) {
    // 0. Safety Check: Ensure Env Vars are actually loaded
    if (!ADMIN_USER || !ADMIN_PASS) {
        console.error("CRITICAL: Admin credentials missing from Environment Variables");
        return res.status(500).json({ error: 'Server Config Error: Credentials undefined' });
    }

    // 1. Security Layer: Validate Admin Credentials
    const authHeader = req.headers.authorization || '';
    const match = authHeader.match(/Basic (.+)/);
    
    if (!match) return res.status(401).json({ error: 'Unauthorized Access: No Header' });

    // Decode and separate
    const decoded = Buffer.from(match[1], 'base64').toString();
    const [login, password] = decoded.split(':');
    
    // NORMALIZE STRINGS (The Fix)
    // We .trim() to remove invisible spaces that often cause this error
    const clientUser = (login || '').trim();
    const clientPass = (password || '').trim();
    const serverUser = (ADMIN_USER || '').trim();
    const serverPass = (ADMIN_PASS || '').trim();

    // Debugging (Check your server logs if this fails)
    // console.log(`Auth Attempt: Received '${clientUser}' vs Expected '${serverUser}'`);

    if (clientUser !== serverUser || clientPass !== serverPass) {
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
            const response = await fetch(`${FW_BASE}/balances`, { headers: HEADERS });
            const data = await response.json();
            return res.status(200).json(data);
        }

        if (action === 'transactions') {
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
