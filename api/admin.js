import pg from 'pg';
const { Client } = pg;

const CONNECTION_STRING = process.env.POSTGRES_URL;
const ADMIN_USER = process.env.ADMIN_USERNAME;
const ADMIN_PASS = process.env.ADMIN_PASSWORD;

export default async function handler(req, res) {
    // Auth Check
    const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
    const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');
    if (login !== ADMIN_USER || password !== ADMIN_PASS) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { action } = req.query;
    
    // Simple Login Check
    if (action === 'check') return res.status(200).json({ ok: true });

    const client = new Client({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false } });
    await client.connect();

    try {
        if (action === 'transactions') {
            // Fetch latest 100 transactions
            const result = await client.query('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 100');
            await client.end();
            return res.status(200).json(result.rows);
        }
        
        await client.end();
        return res.status(400).json({ error: 'Invalid Action' });
    } catch (e) {
        if(client) await client.end();
        res.status(500).json({ error: e.message });
    }
}
