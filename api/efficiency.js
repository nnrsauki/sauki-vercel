import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';

const AMIGO_API_KEY = process.env.AMIGO_API_KEY;
const PROXY_URL = process.env.PROXY_URL;

export default async function handler(req, res) {
    // Enable CORS so frontend can call it easily
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
    );

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    try {
        const options = {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Token ${AMIGO_API_KEY}`,
                'X-API-Key': AMIGO_API_KEY
            }
        };

        if (PROXY_URL) options.agent = new HttpsProxyAgent(PROXY_URL);

        // Try the standard API path
        const response = await fetch('https://amigo.ng/api/plans/efficiency', options);
        
        if (response.ok) {
            const data = await response.json();
            return res.status(200).json(data);
        } else {
            // Log the failure for your records
            console.error(`Efficiency API Failed: ${response.status}`);
            throw new Error("Upstream failed");
        }

    } catch (e) {
        console.error("Efficiency Error (Using Fallback):", e.message);

        // FALLBACK DATA (From your documentation)
        // This ensures the user ALWAYS sees the table, even if Amigo API is down/changed.
        const fallbackData = {
            "ok": true,
            "MTN": [
                { "plan_id": 5000, "data_capacity": 0.5, "validity": 30, "price": 0, "efficiency_percent": 100.0, "efficiency_label": "Excellent" },
                { "plan_id": 1001, "data_capacity": 1.0, "validity": 30, "price": 0, "efficiency_percent": 100.0, "efficiency_label": "Excellent" },
                { "plan_id": 6666, "data_capacity": 2.0, "validity": 30, "price": 0, "efficiency_percent": 100.0, "efficiency_label": "Excellent" },
                { "plan_id": 3333, "data_capacity": 3.0, "validity": 30, "price": 0, "efficiency_percent": 95.0, "efficiency_label": "Very Good" },
                { "plan_id": 9999, "data_capacity": 5.0, "validity": 30, "price": 0, "efficiency_percent": 100.0, "efficiency_label": "Excellent" }
            ],
            "Glo": [
                { "plan_id": 206, "data_capacity": 1.0, "validity": 30, "price": 0, "efficiency_percent": 100.0, "efficiency_label": "Excellent" },
                { "plan_id": 195, "data_capacity": 2.0, "validity": 30, "price": 0, "efficiency_percent": 100.0, "efficiency_label": "Excellent" },
                { "plan_id": 196, "data_capacity": 3.0, "validity": 30, "price": 0, "efficiency_percent": 98.0, "efficiency_label": "Excellent" }
            ],
            "Airtel": [
                 { "plan_id": 0, "data_capacity": 1.0, "validity": 30, "price": 0, "efficiency_percent": 92.0, "efficiency_label": "Good" }
            ]
        };
        
        return res.status(200).json(fallbackData);
    }
}
