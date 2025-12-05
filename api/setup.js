import pg from 'pg';
const { Client } = pg;

const CONNECTION_STRING = process.env.POSTGRES_URL;

export default async function handler(req, res) {
    const client = new Client({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false } });
    
    try {
        await client.connect();
        
        // 1. Create Tables (If they don't exist)
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

        await client.query(`
            CREATE TABLE IF NOT EXISTS plans (
                id VARCHAR(50) PRIMARY KEY,
                network VARCHAR(20),
                name VARCHAR(100),
                price DECIMAL(10, 2),
                plan_id_api VARCHAR(50)
            );
        `);

        // 2. CRITICAL FIXES: Add Missing Columns
        // If your database is old, these lines ensure it gets the new fields required for the History and Funding logic
        
        // Transaction Table Updates
        await client.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS amount DECIMAL(10, 2);`);
        await client.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS new_balance DECIMAL(10, 2);`);
        await client.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS api_response TEXT;`);
        await client.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reference VARCHAR(100);`);
        
        // User Table Updates
        await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS virtual_account_number VARCHAR(20);`);
        await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS virtual_bank_name VARCHAR(100);`);
        await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS virtual_account_name VARCHAR(100);`);

        // 3. Create Index for faster Webhook lookups
        // This makes finding the user by their dedicated account number instant
        await client.query(`CREATE INDEX IF NOT EXISTS idx_users_virtual_acc ON users(virtual_account_number);`);

        await client.end();
        return res.status(200).json({ message: "Database Repaired, Indexed & Updated Successfully!" });
    } catch (e) {
        if(client) await client.end();
        return res.status(500).json({ error: e.message });
    }
}
