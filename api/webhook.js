import pg from 'pg';
import fetch from 'node-fetch';
const { Client } = pg;

const CONNECTION_STRING = process.env.POSTGRES_URL; 
const FLW_SECRET_HASH = process.env.FLW_SECRET_HASH;
const TERMII_API_KEY = process.env.TERMII_API_KEY;

// Your Admin Phone Number (International format without +)
const ADMIN_PHONE = "2348164135836"; 

export default async function handler(req, res) {
    // 1. Verify Signature
    const signature = req.headers['verif-hash'];
    if (!signature || signature !== FLW_SECRET_HASH) {
        return res.status(401).send('Unverified');
    }

    const { event, data } = req.body;

    // 2. Handle Successful Payment
    if (event === 'charge.completed' && data.status === 'successful') {
        try {
            // A. Log to Database
            const client = new Client({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false } });
            await client.connect();
            
            // Check for duplicates
            const check = await client.query('SELECT id FROM transactions WHERE reference = $1', [String(data.tx_ref)]);
            
            if (check.rows.length === 0) {
                console.log(`New Webhook Payment: ${data.amount}`);
            }
            await client.end();

            // B. SEND SMS TO ADMIN (With Name & Phone Number)
            if (TERMII_API_KEY) {
                const customerName = data.customer.name || "Unknown";
                const customerPhone = data.customer.phone_number || "No Phone";
                
                // The Custom Message
                const message = `Credit Alert! N${data.amount} from ${customerName} (${customerPhone}). Ref: ${data.tx_ref}`;
                
                await fetch('https://api.ng.termii.com/api/sms/send', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        "to": ADMIN_PHONE,
                        "from": "N-Alert", // Change this if you have a registered Sender ID
                        "sms": message,
                        "type": "plain",
                        "channel": "dnd",
                        "api_key": TERMII_API_KEY
                    })
                });
                console.log("Admin SMS Sent");
            }

        } catch (e) {
            console.error("Webhook Error:", e);
        }
    }
    
    // Always return 200 to Flutterwave
    res.status(200).send('OK');
}
