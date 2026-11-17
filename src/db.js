const fs = require("node:fs");
const path = require("node:path");
const { Pool } = require("pg");

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function initializeDatabase() {
  const schema = fs.readFileSync(path.join(__dirname, "../db/schema.sql"), "utf8");
  await pool.query(schema);
}

module.exports = { initializeDatabase, pool };
