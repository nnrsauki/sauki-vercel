import fetch from 'node-fetch';

export default async function handler(req, res) {
    const ADMIN_USER = process.env.ADMIN_USERNAME;
    const ADMIN_PASS = process.env.ADMIN_PASSWORD;
    const FLUTTERWAVE_SECRET = process.env.FLUTTERWAVE_SECRET_KEY;

    // 1. DIAGNOSTIC CHECK
    // If you see "MISSING" in the response, Vercel hasn't given this file access to your Env Vars yet.
    if (!ADMIN_USER || !ADMIN_PASS) {
        return res.status(200).json({ 
            error: "Environment Variables are MISSING in this file.",
            debug: {
                user_loaded: !!ADMIN_USER,
                pass_loaded: !!ADMIN_PASS,
                key_loaded: !!FLUTTERWAVE_SECRET,
                note: "If these are false, redeploy your project."
            }
        });
    }

    // 2. CREDENTIAL COMPARISON DEBUG
    // This allows us to see what you sent vs what the server has (masked for security)
    const authHeader = req.headers.authorization || '';
    const match = authHeader.match(/Basic (.+)/);
    
    if (match) {
        const [login, password] = Buffer.from(match[1], 'base64').toString().split(':');
        
        // IF THESE DON'T MATCH, the error is a typo or whitespace
        if (login !== ADMIN_USER || password !== ADMIN_PASS) {
            return res.status(401).json({ 
                error: "Credentials Mismatch", 
                debug: {
                    sent_user: login,
                    expected_user: ADMIN_USER,
                    pass_match: password === ADMIN_PASS ? "YES" : "NO (Check for spaces)"
                }
            });
        }
    } else {
        return res.status(401).json({ error: "No Auth Header Received" });
    }

    // 3. FLUTTERWAVE LOGIC
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
        return res.status(500).json({ error: e.message });
    }
}
