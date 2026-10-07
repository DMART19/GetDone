const { randomBytes } = require("node:crypto");
const { OtlpJsonHttpTelemetrySink, readOtlpHeaders } = require("../dist-worker/lib/observability/telemetry.js");

async function main() {
  if (process.env.GETDONE_OBSERVABILITY_ENABLED !== "true" || !process.env.GETDONE_OTEL_EXPORTER_OTLP_ENDPOINT) {
    throw new Error("Real observability configuration is required");
  }
  const sink = new OtlpJsonHttpTelemetrySink(process.env.GETDONE_OTEL_EXPORTER_OTLP_ENDPOINT, readOtlpHeaders(process.env));
  const traceId = randomBytes(16).toString("hex");
  const spanId = randomBytes(8).toString("hex");
  const timestamp = new Date().toISOString();
  const attributes = { "getdone.commissioning.trace_id": traceId };
  await sink.log({ timestamp, severity: "INFO", event: "commissioning.canary", traceId, spanId, attributes });
  await sink.metric({ name: "getdone.commissioning.canary", kind: "counter", value: 1, timestamp, attributes });
  await sink.span({ traceId, spanId, name: "commissioning.canary", startedAt: timestamp, endedAt: new Date().toISOString(), durationMs: Date.now() - Date.parse(timestamp), status: "ok", attributes });
  console.log(JSON.stringify({ ok: true, transport: "OTLP HTTP/JSON", signalsAccepted: ["logs", "metrics", "traces"], traceId, timestamp, backendVisibility: "Requires independent lookup of this trace ID in the collector backend" }));
}
main().catch(() => {
  console.error(JSON.stringify({ ok: false, error: "OTLP canary failed; check endpoint, authentication, protocol and collector availability" }));
  process.exitCode = 1;
});
