import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';

const AMIGO_API_KEY = process.env.AMIGO_API_KEY;
const PROXY_URL = process.env.PROXY_URL;

export default async function handler(req, res) {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');

    if (req.method === 'OPTIONS') return res.status(200).end();

    if (!AMIGO_API_KEY) {
        return res.status(500).json({ error: 'Server Config Error: Missing API Key' });
    }

    try {
        const options = {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Token ${AMIGO_API_KEY}`,
                'X-API-Key': AMIGO_API_KEY,
                'User-Agent': 'SaukiData/1.0' // Sometimes required
            }
        };

        if (PROXY_URL) options.agent = new HttpsProxyAgent(PROXY_URL);

        // CRITICAL FIX: Added trailing slash '/' at the end.
        // Amigo API often fails without it (404 or 301 Redirect errors).
        const url = 'https://amigo.ng/api/plans/efficiency/'; 
        
        console.log(`Fetching Efficiency: ${url}`);
        const response = await fetch(url, options);
        
        if (!response.ok) {
            const errText = await response.text();
            console.error(`Amigo Efficiency Error (${response.status}): ${errText}`);
            return res.status(response.status).json({ 
                error: `Provider Error ${response.status}`, 
                details: errText 
            });
        }

        const data = await response.json();
        return res.status(200).json(data);

    } catch (e) {
        console.error("Efficiency API Exception:", e);
        return res.status(500).json({ error: "Connection Failed", details: e.message });
    }
}
