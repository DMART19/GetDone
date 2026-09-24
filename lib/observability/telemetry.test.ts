import { describe, expect, it } from "vitest";
import {
  InMemoryTelemetrySink,
  OtlpJsonHttpTelemetrySink,
  Telemetry
} from "@/lib/observability/telemetry";

describe("production observability foundation", () => {
  it("correlates structured logs and nested spans with one trace", async () => {
    const sink = new InMemoryTelemetrySink();
    let tick = 0;
    const telemetry = new Telemetry(
      sink,
      () => new Date(1_700_000_000_000 + tick++ * 10)
    );

    await telemetry.withSpan("job.execute", { "job.id": "job-1" }, async () => {
      await telemetry.log("INFO", "job.started", { "job.id": "job-1" });
      await telemetry.withSpan("provider.call", { "peer.service": "slack" }, async () => {
        await telemetry.histogram("getdone.provider.call.duration", 12, "ms", {
          "peer.service": "slack"
        });
      });
    });

    expect(sink.logs).toHaveLength(1);
    expect(sink.spans).toHaveLength(2);
    expect(sink.metrics).toHaveLength(1);
    expect(sink.logs[0]?.traceId).toBeTruthy();
    expect(new Set(sink.spans.map((span) => span.traceId))).toEqual(
      new Set([sink.logs[0]!.traceId])
    );
    const parent = sink.spans.find((span) => span.name === "job.execute")!;
    const child = sink.spans.find((span) => span.name === "provider.call")!;
    expect(child.parentSpanId).toBe(parent.spanId);
  });

  it("keeps exporter failures off the production execution path", async () => {
    const telemetry = new Telemetry({
      log: () => { throw new Error("collector down"); },
      metric: () => { throw new Error("collector down"); },
      span: () => { throw new Error("collector down"); }
    });

    await expect(telemetry.withSpan("job.execute", {}, async () => {
      await telemetry.log("INFO", "job.started");
      await telemetry.counter("getdone.job.execution.total");
      return "ok";
    })).resolves.toBe("ok");
  });

  it("emits OTLP-compatible JSON envelopes for logs metrics and traces", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    const sink = new OtlpJsonHttpTelemetrySink(
      "https://otel.example.test",
      { authorization: "fixture" },
      async (url, init) => {
        requests.push({
          url: String(url),
          body: JSON.parse(String(init?.body))
        });
        return new Response("", { status: 200 });
      }
    );
    const telemetry = new Telemetry(sink, () => new Date("2026-09-24T12:00:00.000Z"));

    await telemetry.withSpan("job.execute", { "job.id": "job-1" }, async () => {
      await telemetry.log("INFO", "job.started", { "job.id": "job-1" });
      await telemetry.counter("getdone.job.execution.total", 1, { outcome: "success" });
    });

    expect(requests.map((request) => request.url).sort()).toEqual([
      "https://otel.example.test/v1/logs",
      "https://otel.example.test/v1/metrics",
      "https://otel.example.test/v1/traces"
    ]);
    expect(requests.find((request) => request.url.endsWith("/v1/logs"))?.body)
      .toHaveProperty("resourceLogs");
    expect(requests.find((request) => request.url.endsWith("/v1/metrics"))?.body)
      .toHaveProperty("resourceMetrics");
    expect(requests.find((request) => request.url.endsWith("/v1/traces"))?.body)
      .toHaveProperty("resourceSpans");
  });
});
