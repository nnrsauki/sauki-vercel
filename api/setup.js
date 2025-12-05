import pg from 'pg';
const { Client } = pg;

const CONNECTION_STRING = process.env.POSTGRES_URL;

export default async function handler(req, res) {
    const client = new Client({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false } });
    
    try {
        await client.connect();
        
        // 1. Create Users Table
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                phone_number VARCHAR(20) UNIQUE NOT NULL,
                pin_hash VARCHAR(255) NOT NULL,
                wallet_balance DECIMAL(10, 2) DEFAULT 0.00,
                virtual_account_number VARCHAR(20),
                virtual_bank_name VARCHAR(100),
                virtual_account_name VARCHAR(100),
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);

        // 2. Update Transactions Table (Add user_id link just in case, and ensure columns exist)
        await client.query(`
            CREATE TABLE IF NOT EXISTS transactions (
                id SERIAL PRIMARY KEY,
                reference VARCHAR(100) UNIQUE,
                phone_number VARCHAR(20),
                network VARCHAR(20),
                plan_id VARCHAR(50),
                status VARCHAR(20),
                amount DECIMAL(10, 2),
                new_balance DECIMAL(10, 2),
                api_response TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);

        await client.end();
        return res.status(200).json({ message: "Database Tables Created/Updated Successfully" });
    } catch (e) {
        if(client) await client.end();
        return res.status(500).json({ error: e.message });
    }
}
