import http from "node:http";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const port = Number(process.env.GETDONE_WEBHOOK_STAGING_PORT ?? "8791");
const signingSecret = process.env.GETDONE_WEBHOOK_STAGING_SIGNING_SECRET?.trim();
const controlToken = process.env.GETDONE_WEBHOOK_STAGING_CONTROL_TOKEN?.trim();

if (!signingSecret || !controlToken) {
  throw new Error("GETDONE_WEBHOOK_STAGING_SIGNING_SECRET and GETDONE_WEBHOOK_STAGING_CONTROL_TOKEN are required");
}

const byIdempotency = new Map();
const byOperationId = new Map();
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

function controlAuthorized(request) {
  return bearer(request) === controlToken;
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function signatureValid(request, rawBody) {
  const timestamp = String(request.headers["x-getdone-signature-timestamp"] ?? "");
  const supplied = String(request.headers["x-getdone-signature"] ?? "");
  if (!timestamp || !supplied.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", signingSecret)
    .update(timestamp + "." + rawBody)
    .digest("hex");
  const actual = supplied.slice("sha256=".length);
  if (!/^[a-f0-9]{64}$/i.test(actual)) return false;
  const left = Buffer.from(expected, "hex");
  const right = Buffer.from(actual, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function operationId(requestId, scenario) {
  return "webhook-stage-" + createHash("sha256")
    .update(scenario + ":" + requestId)
    .digest("hex")
    .slice(0, 24);
}

function externalFromProviderId(value) {
  const decoded = decodeURIComponent(value);
  return decoded.split(":").at(-1) ?? decoded;
}

function capture(body, scenario, idempotencyKey, rawBody, validSignature) {
  const requestId = String(body.requestId ?? "");
  let record = byIdempotency.get(idempotencyKey);
  if (!record) {
    record = {
      operationId: operationId(requestId, scenario),
      requestId,
      jobId: String(body.jobId ?? ""),
      companyId: String(body.companyId ?? ""),
      scenario,
      state: "accepted",
      idempotencyKeyHash: createHash("sha256").update(idempotencyKey).digest("hex"),
      bodyHash: createHash("sha256").update(rawBody).digest("hex"),
      signatureValid: validSignature,
      deliveryAttempts: 0,
      sideEffectCount: 1,
      cancellationReason: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    byIdempotency.set(idempotencyKey, record);
    byOperationId.set(record.operationId, record);
  }
  record.deliveryAttempts += 1;
  record.updatedAt = new Date().toISOString();
  return record;
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");

    if (request.method === "GET" && url.pathname === "/health") {
      return json(response, 200, { ok: true, receiver: "getdone-webhook-staging" });
    }

    if (request.method === "GET" && url.pathname.startsWith("/inspect/request/")) {
      if (!controlAuthorized(request)) return json(response, 403, { ok: false, error: "forbidden" });
      const requestId = decodeURIComponent(url.pathname.slice("/inspect/request/".length));
      const record = [...byOperationId.values()].find((item) => item.requestId === requestId);
      return record ? json(response, 200, { ok: true, record }) : json(response, 404, { ok: false });
    }

    if (request.method === "POST" && url.pathname.startsWith("/deliver/")) {
      const scenario = url.pathname.slice("/deliver/".length);
      const rawBody = await readBody(request);
      const valid = signatureValid(request, rawBody);
      if (!valid) return json(response, 401, { ok: false, error: "invalid_signature" });

      let body;
      try {
        body = JSON.parse(rawBody);
      } catch {
        return json(response, 400, { ok: false, error: "invalid_json" });
      }
      const idempotencyKey = String(request.headers["idempotency-key"] ?? "");
      if (!idempotencyKey) return json(response, 400, { ok: false, error: "missing_idempotency_key" });

      const attemptKey = scenario + ":" + idempotencyKey;
      const attempt = (attempts.get(attemptKey) ?? 0) + 1;
      attempts.set(attemptKey, attempt);

      if (scenario === "retry-exhaustion") {
        return json(response, 503, { ok: false, error: "controlled_retry_exhaustion", attempt });
      }

      const record = capture(body, scenario, idempotencyKey, rawBody, valid);

      if (scenario === "duplicate-recovery" && attempt === 1) {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
      }

      if (scenario === "tampered-response") {
        return json(response, 202, { accepted: true }, {
          "x-provider-operation-id": "../../tampered?redirect=https://attacker.invalid"
        });
      }

      return json(response, 202, {
        ok: true,
        accepted: true,
        duplicate: record.deliveryAttempts > 1
      }, {
        "x-provider-operation-id": record.operationId
      });
    }

    if (request.method === "GET" && url.pathname.startsWith("/verify/")) {
      if (bearer(request) !== signingSecret) return json(response, 401, { ok: false, error: "unauthorized" });
      const id = externalFromProviderId(url.pathname.slice("/verify/".length));
      const record = byOperationId.get(id);
      if (!record) return json(response, 404, { ok: false, error: "not_found" });
      if (record.state === "cancelled") return json(response, 410, { ok: false, state: "cancelled" });
      return json(response, 200, {
        ok: true,
        state: record.state,
        requestId: record.requestId,
        signatureValid: record.signatureValid,
        bodyHash: record.bodyHash
      });
    }

    if (request.method === "POST" && url.pathname.startsWith("/cancel/")) {
      if (bearer(request) !== signingSecret) return json(response, 401, { ok: false, error: "unauthorized" });
      const id = externalFromProviderId(url.pathname.slice("/cancel/".length));
      const record = byOperationId.get(id);
      if (!record) return json(response, 404, { ok: false, error: "not_found" });
      const raw = await readBody(request);
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch {}
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
  process.stdout.write("webhook-staging-listening:" + port + "\n");
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
