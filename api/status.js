import pg from 'pg';
const { Client } = pg;

const CONNECTION_STRING = process.env.POSTGRES_URL;

export default async function handler(req, res) {
    const client = new Client({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false } });
    
    try {
        await client.connect();
        // Ensure table exists (Lazy initialization)
        await client.query(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`);

        if (req.method === 'GET') {
            const result = await client.query("SELECT value FROM settings WHERE key = 'broadcast_message'");
            const message = result.rows.length > 0 ? result.rows[0].value : "";
            return res.status(200).json({ message });
        }
        
        return res.status(405).json({ error: 'Method Not Allowed' });

    } catch (e) {
        console.error("Status API Error:", e);
        return res.status(500).json({ error: e.message });
    } finally {
        await client.end();
    }
}
