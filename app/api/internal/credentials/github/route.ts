import { authenticateGithubDelivery, deliverGithubCredential, githubDeliverySchema } from "@/lib/credentials/github-app.server";
import { getPostgresRuntimeFromEnv } from "@/lib/persistence/postgres/runtime.server";
import { runWithPostgresTenantScope } from "@/lib/persistence/postgres/tenant-context.server";
import { ControlPlaneError } from "@/lib/control-plane/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const headers = { "cache-control": "no-store", "pragma": "no-cache" };
  try {
    authenticateGithubDelivery(request, process.env);
    if (process.env.GETDONE_PROCESS_ROLE !== "web") throw new ControlPlaneError("FORBIDDEN", "Credential delivery is not installed in this process");
    const reader = request.body?.getReader();
    if (!reader) return Response.json({ error: "Invalid request" }, { status: 400, headers });
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 8192) { await reader.cancel(); return Response.json({ error: "Request too large" }, { status: 413, headers }); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const input = githubDeliverySchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    // Caller scope is only an RLS selector; persisted authority and registration are checked inside.
    const result = await runWithPostgresTenantScope(input, () =>
      deliverGithubCredential(getPostgresRuntimeFromEnv().database, input, process.env)
    );
    return Response.json(result, { headers });
  } catch (error) {
    const status = error instanceof ControlPlaneError
      ? error.code === "UNAUTHENTICATED" ? 401 : error.code === "UNAVAILABLE" ? 503 : 403
      : 400;
    // No upstream payloads, signing errors, secrets, or request bodies in logs/responses.
    return Response.json({ error: "Credential delivery denied or unavailable" }, { status, headers });
  }
}
