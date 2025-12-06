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
        // Limit 1 to show the latest for that phone number or exact ref
        const result = await client.query(
            `SELECT reference, phone_number, plan_id, network, status, created_at 
             FROM transactions 
             WHERE reference = $1 OR phone_number = $1 
             ORDER BY created_at DESC LIMIT 1`, 
            [q]
        );

        await client.end();

        if (result.rows.length > 0) {
            return res.status(200).json({ found: true, transaction: result.rows[0] });
        } else {
            return res.status(200).json({ found: false });
        }

    } catch (e) {
        if(client) await client.end();
        return res.status(500).json({ error: e.message });
    }
}
