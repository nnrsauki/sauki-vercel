import pg from 'pg';
const { Client } = pg;
const CONNECTION_STRING = process.env.POSTGRES_URL;

export default async function handler(req, res) {
    const client = new Client({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false } });
    await client.connect();

    try {
        const { network } = req.query;
        
        // Logic: If reseller_price is > 0, use it. Otherwise use normal price.
        let query = `
            SELECT id, network, name, 
            CASE 
                WHEN reseller_price > 0 THEN reseller_price 
                ELSE price 
            END as price, 
            plan_id_api 
            FROM plans
        `;
        
        if (network) query += ` WHERE network = '${network}'`;
        query += ' ORDER BY price ASC';
        
        const result = await client.query(query);
        await client.end();
        return res.status(200).json(result.rows);
    } catch (e) {
        if(client) await client.end();
        res.status(500).json({ error: e.message });
    }
}
