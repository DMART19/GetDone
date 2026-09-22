import { DurableJobWorker } from "@/lib/execution/job-worker-runtime";
import { PostgresDatabase } from "@/lib/persistence/postgres/client";
import { PostgresDurableJobStore } from "@/lib/persistence/postgres/job-store";

const [jobId, workerId, now] = process.argv.slice(2);
if (!jobId || !workerId || !now) {
  throw new Error("jobId, workerId, and now arguments are required");
}

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) throw new Error("DATABASE_URL is required");

const db = new PostgresDatabase({
  connectionString,
  maxConnections: 2,
  ssl: process.env.GETDONE_DB_SSL !== "false"
});

try {
  const store = new PostgresDurableJobStore(db);
  const worker = new DurableJobWorker(
    store,
    {
      workerId,
      leaseSeconds: 10,
      heartbeatSeconds: 3,
      batchSize: 1,
      retryBaseDelayMs: 0,
      maxAttempts: 5
    },
    () => new Date(now)
  );

  let executions = 0;
  const results = await worker.runOnce({
    execute: async (context) => {
      executions += 1;
      await context.heartbeat();
      return { kind: "succeeded" };
    }
  });

  process.stdout.write(JSON.stringify({
    jobId,
    workerId,
    executions,
    results
  }));
} finally {
  await db.close();
}
