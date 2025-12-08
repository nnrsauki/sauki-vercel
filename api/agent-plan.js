import pg from 'pg';
const { Client } = pg;
const CONNECTION_STRING = process.env.POSTGRES_URL;

export default async function handler(req, res) {
    // Only allow GET requests
    if (req.method !== 'GET') return res.status(405).json({error: 'Method Not Allowed'});

    const client = new Client({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false } });
    await client.connect();

    try {
        const { network } = req.query;
        
        // SELECT 'reseller_price' as 'price'
        let query = `
            SELECT id, network, name, reseller_price as price, plan_id_api 
            FROM plans
        `;
        
        if (network) query += ` WHERE network = '${network}'`;
        query += ' ORDER BY reseller_price ASC';
        
        const result = await client.query(query);
        await client.end();
        return res.status(200).json(result.rows);
    } catch (e) {
        if(client) await client.end();
        res.status(500).json({ error: e.message });
    }
}