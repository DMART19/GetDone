import { assertPostgresReadyAtStartup } from "@/lib/persistence/postgres/runtime.server";

export async function registerNodeInstrumentation() {
  await assertPostgresReadyAtStartup();

  if (process.env.GETDONE_PROCESS_ROLE === "job-worker") {
    const { installPersistentJobWorkerFromEnv } = await import(
      "@/lib/execution/persistent-job-worker.server"
    );
    const service = installPersistentJobWorkerFromEnv();
    void service.start().catch((error) => {
      console.error("GetDone persistent Job worker failed to start", error);
      process.exitCode = 1;
    });

    const shutdown = () => {
      void service.stop();
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  }
}
