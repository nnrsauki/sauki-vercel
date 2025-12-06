import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';

const AMIGO_API_KEY = process.env.AMIGO_API_KEY;
const PROXY_URL = process.env.PROXY_URL;

export default async function handler(req, res) {
    // Basic CORS support
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');

    if (!AMIGO_API_KEY) {
        return res.status(500).json({ error: 'Server Config Error: Missing API Key' });
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

        // Fetching from the endpoint you specified
        const response = await fetch('https://amigo.ng/api/plans/efficiency', options);
        
        if (!response.ok) {
            throw new Error(`Provider Error: ${response.status}`);
        }

        const data = await response.json();
        return res.status(200).json(data);

    } catch (e) {
        console.error("Efficiency API Error:", e);
        return res.status(500).json({ error: "Could not fetch network status." });
    }
}
