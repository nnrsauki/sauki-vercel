import pg from 'pg';
const { Client } = pg;

const CONNECTION_STRING = process.env.POSTGRES_URL;
const ADMIN_USER = process.env.ADMIN_USERNAME;
const ADMIN_PASS = process.env.ADMIN_PASSWORD;

const checkAuth = (req) => {
    const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
    const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');
    return (login === ADMIN_USER && password === ADMIN_PASS);
};

export default async function handler(req, res) {
    const client = new Client({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false } });
    await client.connect();

    try {
        // GET (Public)
        if (req.method === 'GET') {
            const { network } = req.query;
            let query = 'SELECT * FROM plans';
            if (network) query += ` WHERE network = '${network}'`;
            query += ' ORDER BY price ASC';
            const result = await client.query(query);
            await client.end();
            return res.status(200).json(result.rows);
        }

        // POST (Admin)
        if (req.method === 'POST') {
            if (!checkAuth(req)) {
                await client.end();
                return res.status(401).json({ error: 'Unauthorized' });
            }

            const { action, id, network, name, price, reseller_price, plan_id_api } = req.body;

            if (action === 'create') {
                // Ensure values are numbers
                const finalPrice = parseFloat(price);
                const finalResPrice = reseller_price ? parseFloat(reseller_price) : finalPrice;

                await client.query(
                    `INSERT INTO plans (id, network, name, price, reseller_price, plan_id_api) 
                     VALUES ($1, $2, $3, $4, $5, $6)
                     ON CONFLICT (id) DO UPDATE SET 
                     network = EXCLUDED.network, 
                     name = EXCLUDED.name, 
                     price = EXCLUDED.price, 
                     reseller_price = EXCLUDED.reseller_price, 
                     plan_id_api = EXCLUDED.plan_id_api`,
                    [id, network, name, finalPrice, finalResPrice, plan_id_api]
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
