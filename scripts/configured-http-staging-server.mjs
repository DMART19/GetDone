import http from "node:http";
import { createHash, randomUUID } from "node:crypto";

const port = Number(process.env.GETDONE_HTTP_STAGING_PORT ?? "8787");
let activeToken = process.env.GETDONE_HTTP_STAGING_INITIAL_TOKEN?.trim();
const controlToken = process.env.GETDONE_HTTP_STAGING_CONTROL_TOKEN?.trim();

if (!activeToken || !controlToken) {
  throw new Error("GETDONE_HTTP_STAGING_INITIAL_TOKEN and GETDONE_HTTP_STAGING_CONTROL_TOKEN are required");
}

const byIdempotency = new Map();
const byExternalId = new Map();
const attempts = new Map();

function json(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    ...headers
  });
  response.end(body);
}

function bearer(request) {
  return request.headers.authorization?.replace(/^Bearer\s+/i, "").trim() ?? "";
}

function authorized(request) {
  return bearer(request) === activeToken;
}

function controlAuthorized(request) {
  return bearer(request) === controlToken;
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function externalId(requestId, scenario) {
  return "stage-" + createHash("sha256")
    .update(scenario + ":" + requestId)
    .digest("hex")
    .slice(0, 24);
}

function externalFromProviderId(value) {
  const decoded = decodeURIComponent(value);
  const parts = decoded.split(":");
  return parts.at(-1) ?? decoded;
}

function recordFor(requestBody, scenario, idempotencyKey) {
  const requestId = String(requestBody.requestId ?? randomUUID());
  const existing = byIdempotency.get(idempotencyKey);
  if (existing) return existing;
  const record = {
    externalId: externalId(requestId, scenario),
    requestId,
    jobId: String(requestBody.jobId ?? ""),
    companyId: String(requestBody.companyId ?? ""),
    scenario,
    state: "active",
    idempotencyKeyHash: createHash("sha256").update(idempotencyKey).digest("hex"),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    actionCalls: 0,
    cancellationReason: null
  };
  byIdempotency.set(idempotencyKey, record);
  byExternalId.set(record.externalId, record);
  return record;
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (request.method === "GET" && url.pathname === "/health") {
      return json(response, 200, { ok: true, provider: "getdone-configured-http-staging" });
    }

    if (request.method === "POST" && url.pathname === "/control/rotate") {
      if (!controlAuthorized(request)) return json(response, 403, { ok: false, error: "forbidden" });
      const body = await readJson(request);
      if (typeof body.token !== "string" || body.token.length < 16) {
        return json(response, 400, { ok: false, error: "invalid_token" });
      }
      activeToken = body.token;
      return json(response, 200, { ok: true });
    }

    if (request.method === "GET" && url.pathname.startsWith("/inspect/request/")) {
      if (!controlAuthorized(request)) return json(response, 403, { ok: false, error: "forbidden" });
      const requestId = decodeURIComponent(url.pathname.slice("/inspect/request/".length));
      const record = [...byExternalId.values()].find((item) => item.requestId === requestId);
      return record ? json(response, 200, { ok: true, record }) : json(response, 404, { ok: false });
    }

    if (request.method === "GET" && url.pathname.startsWith("/inspect/")) {
      if (!controlAuthorized(request)) return json(response, 403, { ok: false, error: "forbidden" });
      const id = externalFromProviderId(url.pathname.slice("/inspect/".length));
      const record = byExternalId.get(id);
      return record ? json(response, 200, { ok: true, record }) : json(response, 404, { ok: false });
    }

    if (!authorized(request)) {
      return json(response, 401, { ok: false, error: "invalid_credential" });
    }

    if (request.method === "POST" && url.pathname.startsWith("/action/")) {
      const scenario = url.pathname.slice("/action/".length);
      const body = await readJson(request);
      const idempotencyKey = String(request.headers["idempotency-key"] ?? "");
      if (!idempotencyKey) return json(response, 400, { ok: false, error: "missing_idempotency_key" });

      if (scenario === "client-4xx") {
        return json(response, 422, { ok: false, error: "controlled_client_failure" });
      }

      const attemptKey = scenario + ":" + idempotencyKey;
      const attempt = (attempts.get(attemptKey) ?? 0) + 1;
      attempts.set(attemptKey, attempt);

      if (scenario === "server-5xx" && attempt === 1) {
        return json(response, 503, { ok: false, error: "controlled_server_failure" });
      }

      const record = recordFor(body, scenario, idempotencyKey);
      record.actionCalls += 1;
      record.updatedAt = new Date().toISOString();

      if (scenario === "slow") {
        if (record.actionCalls === 1) {
          record.state = "pending";
          setTimeout(() => {
            record.state = "active";
            record.updatedAt = new Date().toISOString();
          }, 1_200).unref?.();
          await new Promise((resolve) => setTimeout(resolve, 1_500));
        }
      }

      if (scenario === "oversized") {
        const huge = "x".repeat(16_384);
        response.writeHead(200, {
          "content-type": "text/plain",
          "x-provider-operation-id": record.externalId
        });
        response.end(huge);
        return;
      }

      if (scenario === "malicious-operation-id") {
        return json(response, 200, { ok: true }, {
          "x-provider-operation-id": "../../escape?target=https://attacker.invalid"
        });
      }

      const status = ["consequential", "cancel", "slow"].includes(scenario) ? 202 : 200;
      return json(response, status, {
        ok: true,
        requestId: record.requestId,
        state: record.state
      }, {
        "x-provider-operation-id": record.externalId
      });
    }

    if ((request.method === "GET" || request.method === "POST") && url.pathname.startsWith("/verify/")) {
      const id = externalFromProviderId(url.pathname.slice("/verify/".length));
      const record = byExternalId.get(id);
      if (!record) return json(response, 404, { ok: false, error: "not_found" });
      if (record.state === "pending") return json(response, 409, { ok: false, state: "pending" });
      if (record.state === "cancelled") return json(response, 410, { ok: false, state: "cancelled" });
      return json(response, 200, { ok: true, state: record.state, requestId: record.requestId });
    }

    if ((request.method === "GET" || request.method === "POST") && url.pathname.startsWith("/cancel/")) {
      const id = externalFromProviderId(url.pathname.slice("/cancel/".length));
      const record = byExternalId.get(id);
      if (!record) return json(response, 404, { ok: false, error: "not_found" });
      const body = request.method === "POST" ? await readJson(request) : {};
      record.state = "cancelled";
      record.cancellationReason = typeof body.reason === "string" ? body.reason : null;
      record.updatedAt = new Date().toISOString();
      return json(response, 200, { ok: true, state: "cancelled" });
    }

    return json(response, 404, { ok: false, error: "route_not_found" });
  } catch (error) {
    return json(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : "internal_error"
    });
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write("configured-http-staging-listening:" + port + "\n");
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
