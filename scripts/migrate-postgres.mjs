import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { postgresTlsConnection } from "../lib/persistence/postgres/tls.ts";

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) throw new Error("DATABASE_URL is required");

const root = process.cwd();
const migrationDir = path.join(root, "migrations");
const allFiles = fs.readdirSync(migrationDir)
  .filter((name) => name.endsWith(".sql"))
  .sort();

const target = process.env.GETDONE_MIGRATION_TARGET?.trim();
let files = allFiles;
if (target) {
  const targetIndex = allFiles.findIndex((name) => name.startsWith(`${target}_`));
  if (targetIndex < 0) {
    throw new Error(`GETDONE_MIGRATION_TARGET does not match a migration: ${target}`);
  }
  files = allFiles.slice(0, targetIndex + 1);
}

const pool = new pg.Pool({
  ...postgresTlsConnection(connectionString, process.env),
  max: 1,
  application_name: "getdone-migrator"
});

const client = await pool.connect();
try {
  await client.query("SELECT pg_advisory_lock(hashtext('getdone-schema-migrations'))");
  for (const file of files) {
    const sql = fs.readFileSync(path.join(migrationDir, file), "utf8");
    await client.query(sql);
    console.log(`Applied migration: ${file}`);
  }
  if (target) console.log(`Migration target reached: ${target}`);
} finally {
  try {
    await client.query("SELECT pg_advisory_unlock(hashtext('getdone-schema-migrations'))");
  } finally {
    client.release();
    await pool.end();
  }
}
