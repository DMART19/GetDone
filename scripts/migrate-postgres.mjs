import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) throw new Error("DATABASE_URL is required");

const root = process.cwd();
const migrationDir = path.join(root, "migrations");
const files = fs.readdirSync(migrationDir)
  .filter((name) => name.endsWith(".sql"))
  .sort();

const pool = new pg.Pool({
  connectionString,
  max: 1,
  application_name: "getdone-migrator",
  ssl: process.env.GETDONE_DB_SSL === "false"
    ? false
    : { rejectUnauthorized: true }
});

const client = await pool.connect();
try {
  await client.query("SELECT pg_advisory_lock(hashtext('getdone-schema-migrations'))");
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationDir, file), "utf8");
    await client.query(sql);
    console.log(`Applied migration: ${file}`);
  }
} finally {
  try {
    await client.query("SELECT pg_advisory_unlock(hashtext('getdone-schema-migrations'))");
  } finally {
    client.release();
    await pool.end();
  }
}
