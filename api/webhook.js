import pg from 'pg';
const { Client } = pg;

const CONNECTION_STRING = process.env.POSTGRES_URL; 
const FLW_SECRET_HASH = process.env.FLW_SECRET_HASH; 

export default async function handler(req, res) {
    // Verify Webhook Signature
    if (req.headers['verif-hash'] !== FLW_SECRET_HASH) {
        return res.status(401).send('Unverified');
    }
    
    const { event, data } = req.body;
    
    // We only care about successful charges
    if (event === 'charge.completed' && data.status === 'successful') {
        // You can add logic here to "fulfill" orders if the user closed the browser.
        // However, since fulfillment requires "Plan ID" which is not always in standard webhook body
        // unless passed in meta, we typically use this just for logging or updating status.
        
        const client = new Client({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false } });
        await client.connect();
        console.log(`Webhook Logged payment: ${data.id}`);
        // Optional: Update transaction status if we saved it as 'pending' earlier
        await client.end();
    }
    res.status(200).send('OK');
}
