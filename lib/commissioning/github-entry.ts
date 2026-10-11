import { PostgresDatabase, readPostgresConfigFromEnv } from "@/lib/persistence/postgres/client";
import { commissionGithub } from "@/lib/commissioning/github";
async function main() {
  const db = new PostgresDatabase(readPostgresConfigFromEnv());
  try { console.log(JSON.stringify(await commissionGithub(db, process.env, process.argv.includes("--apply")), null, 2)); }
  finally { await db.close(); }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : "GitHub commissioning failed"); process.exitCode = 1; });
