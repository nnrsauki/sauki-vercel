const { Client } = require('pg');
const CONNECTION_STRING = process.env.POSTGRES_URL; 
const FLW_SECRET_HASH = process.env.FLW_SECRET_HASH; 

export default async function handler(req, res) {
    const signature = req.headers['verif-hash'];
    if (!signature || signature !== FLW_SECRET_HASH) {
        return res.status(401).send('Unverified');
    }

    const { event, data } = req.body;

    if (event === 'charge.completed' && data.status === 'successful') {
        try {
            const client = new Client({
                connectionString: CONNECTION_STRING,
                ssl: { rejectUnauthorized: false }
            });
            await client.connect();
            console.log(`Webhook logged payment: ${data.id}`);
            await client.end();
        } catch (e) {
            console.error(e);
        }
    }
    res.status(200).send('OK');
}
