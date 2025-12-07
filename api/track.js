import pg from 'pg';
const { Client } = pg;

const CONNECTION_STRING = process.env.POSTGRES_URL;

export default async function handler(req, res) {
    // Public API, allow CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    if(req.method !== 'GET') return res.status(405).json({error:'Method Not Allowed'});
    
    const { q } = req.query; // Query parameter
    if(!q) return res.status(400).json({error:'Missing query'});

    const client = new Client({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false } });
    await client.connect();

    try {
        // Search by Reference OR Phone Number
        // LIMIT 3 to show history
        const result = await client.query(
            `SELECT reference, phone_number, plan_id, network, status, created_at 
             FROM transactions 
             WHERE reference = $1 OR phone_number = $1 
             ORDER BY created_at DESC LIMIT 3`, 
            [q]
        );

        await client.end();

        if (result.rows.length > 0) {
            // Return 'transactions' array
            return res.status(200).json({ found: true, transactions: result.rows });
        } else {
            return res.status(200).json({ found: false });
        }

    } catch (e) {
        if(client) await client.end();
        return res.status(500).json({ error: e.message });
    }
}
