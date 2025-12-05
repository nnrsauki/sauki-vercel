import pg from 'pg';
const { Client } = pg;

const CONNECTION_STRING = process.env.POSTGRES_URL;

export default async function handler(req, res) {
    const client = new Client({ connectionString: CONNECTION_STRING, ssl: { rejectUnauthorized: false } });
    
    try {
        await client.connect();
        
        // 1. Create Tables (Standard)
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

        // --- CRITICAL FIX: Add Missing Columns if they don't exist ---
        // This fixes the "column does not exist" error by manually adding them
        
        await client.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS amount DECIMAL(10, 2);`);
        await client.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS new_balance DECIMAL(10, 2);`);
        await client.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS api_response TEXT;`);
        await client.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reference VARCHAR(100);`);
        
        // Fix Users table just in case
        await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS virtual_account_number VARCHAR(20);`);
        await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS virtual_bank_name VARCHAR(100);`);

        await client.end();
        return res.status(200).json({ message: "Database Repaired & Updated Successfully! You can now make transactions." });
    } catch (e) {
        if(client) await client.end();
        return res.status(500).json({ error: e.message });
    }
}
