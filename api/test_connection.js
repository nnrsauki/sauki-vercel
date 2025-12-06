import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';

export default async function handler(req, res) {
    const AMIGO_API_KEY = process.env.AMIGO_API_KEY;
    const PROXY_URL = process.env.PROXY_URL;

    let logs = [];
    logs.push("1. Starting Connection Test...");

    if (!AMIGO_API_KEY) {
        return res.status(500).json({ error: "AMIGO_API_KEY is missing in Environment Variables" });
    }
    logs.push("2. API Key Found (Hidden for security)");

    // Define options
    const options = {
        method: 'POST', // We use POST because GET might be blocked on that endpoint
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Token ${AMIGO_API_KEY}`,
            'X-API-Key': AMIGO_API_KEY // Sending both to be safe
        },
        // Send nonsense data just to provoke a response
        body: JSON.stringify({ network: 1, mobile_number: "08000000000", plan: "TEST", Ported_number: true })
    };

    // Check Proxy
    if (PROXY_URL) {
        logs.push(`3. Proxy Configured: YES (${PROXY_URL.substring(0, 15)}...)`);
        try {
            options.agent = new HttpsProxyAgent(PROXY_URL);
        } catch (e) {
            logs.push(`ERROR: Proxy Agent Failed - ${e.message}`);
        }
    } else {
        logs.push("3. Proxy Configured: NO (Direct Connection)");
    }

    try {
        logs.push("4. Attempting to fetch https://amigo.ng/api/data/ ...");
        const startTime = Date.now();
        
        const response = await fetch('https://amigo.ng/api/data/', options);
        
        const duration = Date.now() - startTime;
        logs.push(`5. Response received in ${duration}ms`);
        logs.push(`6. HTTP Status: ${response.status} ${response.statusText}`);

        const text = await response.text();
        logs.push(`7. Raw Body: ${text.substring(0, 200)}...`); // Show first 200 chars

        return res.status(200).json({
            success: true,
            logs: logs,
            http_status: response.status,
            api_response: text
        });

    } catch (error) {
        logs.push(`CRITICAL FAILURE: ${error.message}`);
        logs.push(`Error Code: ${error.code}`);
        logs.push(`Error Type: ${error.type}`);

        return res.status(500).json({
            success: false,
            message: "Connection Failed completely",
            logs: logs,
            error_details: error.message
        });
    }
}
