import pg from 'pg';
const { Client } = pg;

const CONNECTION_STRING = process.env.POSTGRES_URL; 
const FLW_SECRET_HASH = process.env.FLW_SECRET_HASH; 

export default async function handler(req, res) {
    if (req.headers['verif-hash'] !== FLW_SECRET_HASH) return res.status(401).send('Unverified');
    
    const { event, data } = req.body;
    
    if (event === 'charge.completed' && data.status === 'successful') {
        const client = new Client({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false } });
        await client.connect();
        console.log(`Logged payment: ${data.id}`);
        await client.end();
    }
    res.status(200).send('OK');
}
