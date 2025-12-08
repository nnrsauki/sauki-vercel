import fetch from 'node-fetch';

// ENV Variables
const ADMIN_USER = process.env.ADMIN_USERNAME;
const ADMIN_PASS = process.env.ADMIN_PASSWORD;
const FLUTTERWAVE_SECRET = process.env.FLUTTERWAVE_SECRET_KEY;

export default async function handler(req, res) {
    // --- 1. AUTHENTICATION (Standard) ---
    const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
    const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');

    if (login !== ADMIN_USER || password !== ADMIN_PASS) {
        return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    if (!FLUTTERWAVE_SECRET) {
        return res.status(500).json({ success: false, error: 'Server Config Error: Missing Secret Key' });
    }

    // --- 2. FLUTTERWAVE PROXY ---
    const { action } = req.query;
    const FW_BASE = 'https://api.flutterwave.com/v3';
    const HEADERS = {
        'Authorization': `Bearer ${FLUTTERWAVE_SECRET}`,
        'Content-Type': 'application/json'
    };

    try {
        let fwResponse, fwData;

        if (action === 'balance') {
            fwResponse = await fetch(`${FW_BASE}/balances`, { headers: HEADERS });
            fwData = await fwResponse.json();
            
            // Normalize response for frontend
            if (fwData.status === 'success') {
                return res.status(200).json({ success: true, data: fwData.data });
            } else {
                return res.status(400).json({ success: false, error: fwData.message || 'Failed to fetch balance' });
            }
        }

        if (action === 'transactions') {
            fwResponse = await fetch(`${FW_BASE}/transactions?limit=20`, { headers: HEADERS });
            fwData = await fwResponse.json();

            // Normalize response for frontend
            if (fwData.status === 'success') {
                return res.status(200).json({ success: true, data: fwData.data });
            } else {
                return res.status(400).json({ success: false, error: fwData.message || 'Failed to fetch transactions' });
            }
        }

        return res.status(400).json({ success: false, error: 'Invalid Action' });

    } catch (e) {
        console.error("Saupe API Error:", e);
        return res.status(500).json({ success: false, error: 'Connection Failed: ' + e.message });
    }
}
