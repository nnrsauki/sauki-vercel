import pg from 'pg';
const { Client } = pg;

const CONNECTION_STRING = process.env.POSTGRES_URL;
const ADMIN_AUTH = 'Basic ' + Buffer.from("AbdallahSauki:Abdallah@2025").toString('base64');

export default async function handler(req, res) {
    const client = new Client({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false } });
    await client.connect();

    try {
        if (req.method === 'GET') {
            const { network } = req.query;
            let query = 'SELECT * FROM plans';
            if (network) query += ` WHERE network = '${network}'`;
            query += ' ORDER BY price ASC';
            const result = await client.query(query);
            await client.end();
            return res.status(200).json(result.rows);
        }

        if (req.method === 'POST') {
            if (req.headers.authorization !== ADMIN_AUTH) {
                await client.end();
                return res.status(401).json({ error: 'Unauthorized' });
            }
            const { action, id, network, name, price, plan_id_api } = req.body;
            if (action === 'create') {
                await client.query(
                    `INSERT INTO plans (id, network, name, price, plan_id_api) VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (id) DO UPDATE SET network=$2, name=$3, price=$4, plan_id_api=$5`,
                    [id, network, name, price, plan_id_api]
                );
            } else if (action === 'delete') {
                await client.query('DELETE FROM plans WHERE id = $1', [id]);
            }
            await client.end();
            return res.status(200).json({ success: true });
        }
    } catch (e) {
        if(client) await client.end();
        res.status(500).json({ error: e.message });
    }
}
