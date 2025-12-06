import pg from 'pg';
const { Client } = pg;

const CONNECTION_STRING = process.env.POSTGRES_URL;

export default async function handler(req, res) {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');

    if (req.method === 'OPTIONS') return res.status(200).end();

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    const { name, phone, message } = req.body;

    if (!phone || !message) {
        return res.status(400).json({ error: 'Phone and Message are required' });
    }

    const client = new Client({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false } });

    try {
        await client.connect();

        // 1. Ensure Table Exists
        await client.query(`
            CREATE TABLE IF NOT EXISTS complaints (
                id SERIAL PRIMARY KEY,
                name TEXT,
                phone TEXT,
                message TEXT,
                status TEXT DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT NOW()
            )
        `);

        // 2. Insert Complaint
        await client.query(
            `INSERT INTO complaints (name, phone, message) VALUES ($1, $2, $3)`,
            [name || 'Anonymous', phone, message]
        );

        return res.status(200).json({ success: true, message: 'Complaint Received' });

    } catch (e) {
        console.error("Complaint Error:", e);
        return res.status(500).json({ error: e.message });
    } finally {
        await client.end();
    }
}
