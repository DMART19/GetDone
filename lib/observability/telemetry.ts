import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

export type TelemetryAttributeValue = string | number | boolean | null;
export type TelemetryAttributes = Readonly<Record<string, TelemetryAttributeValue>>;

export interface StructuredLogRecord {
  timestamp: string;
  severity: "DEBUG" | "INFO" | "WARN" | "ERROR";
  event: string;
  message?: string;
  traceId?: string;
  spanId?: string;
  attributes: TelemetryAttributes;
}

export interface MetricRecord {
  name: string;
  kind: "counter" | "histogram" | "gauge";
  value: number;
  unit?: string;
  timestamp: string;
  attributes: TelemetryAttributes;
}

export interface SpanRecord {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  status: "ok" | "error";
  attributes: TelemetryAttributes;
  errorType?: string;
}

export interface TelemetrySink {
  log(record: StructuredLogRecord): void | Promise<void>;
  metric(record: MetricRecord): void | Promise<void>;
  span(record: SpanRecord): void | Promise<void>;
}

interface TelemetryContext {
  traceId: string;
  spanId: string;
}

const context = new AsyncLocalStorage<TelemetryContext>();

function hex(bytes: number) {
  return randomBytes(bytes).toString("hex");
}

function clean(attributes: Record<string, unknown>): TelemetryAttributes {
  return Object.freeze(Object.fromEntries(
    Object.entries(attributes)
      .filter(([, value]) => (
        value === null
        || typeof value === "string"
        || typeof value === "number"
        || typeof value === "boolean"
      ))
      .map(([key, value]) => [key, value as TelemetryAttributeValue])
  ));
}

function errorType(error: unknown) {
  return error instanceof Error ? error.name : typeof error;
}

export class NoopTelemetrySink implements TelemetrySink {
  log() {}
  metric() {}
  span() {}
}

export class JsonConsoleTelemetrySink implements TelemetrySink {
  log(record: StructuredLogRecord) {
    process.stdout.write(JSON.stringify({
      type: "log",
      ...record
    }) + "\n");
  }

  metric(record: MetricRecord) {
    process.stdout.write(JSON.stringify({
      type: "metric",
      ...record
    }) + "\n");
  }

  span(record: SpanRecord) {
    process.stdout.write(JSON.stringify({
      type: "span",
      ...record
    }) + "\n");
  }
}

export class InMemoryTelemetrySink implements TelemetrySink {
  readonly logs: StructuredLogRecord[] = [];
  readonly metrics: MetricRecord[] = [];
  readonly spans: SpanRecord[] = [];

  log(record: StructuredLogRecord) { this.logs.push(record); }
  metric(record: MetricRecord) { this.metrics.push(record); }
  span(record: SpanRecord) { this.spans.push(record); }
}

export class Telemetry {
  constructor(
    private readonly sink: TelemetrySink = new JsonConsoleTelemetrySink(),
    private readonly now: () => Date = () => new Date()
  ) {}

  private async emit(operation: () => void | Promise<void>) {
    try { await operation(); } catch {}
  }

  currentContext() {
    return context.getStore();
  }

  async withSpan<T>(
    name: string,
    attributes: Record<string, unknown>,
    operation: () => Promise<T>
  ): Promise<T> {
    const parent = context.getStore();
    const traceId = parent?.traceId ?? hex(16);
    const spanId = hex(8);
    const started = this.now();
    const baseAttributes = clean(attributes);

    return context.run({ traceId, spanId }, async () => {
      try {
        const result = await operation();
        const ended = this.now();
        await this.emit(() => this.sink.span({
          traceId,
          spanId,
          parentSpanId: parent?.spanId,
          name,
          startedAt: started.toISOString(),
          endedAt: ended.toISOString(),
          durationMs: Math.max(0, ended.getTime() - started.getTime()),
          status: "ok",
          attributes: baseAttributes
        }));
        return result;
      } catch (error) {
        const ended = this.now();
        await this.emit(() => this.sink.span({
          traceId,
          spanId,
          parentSpanId: parent?.spanId,
          name,
          startedAt: started.toISOString(),
          endedAt: ended.toISOString(),
          durationMs: Math.max(0, ended.getTime() - started.getTime()),
          status: "error",
          errorType: errorType(error),
          attributes: baseAttributes
        }));
        throw error;
      }
    });
  }

  async log(
    severity: StructuredLogRecord["severity"],
    event: string,
    attributes: Record<string, unknown> = {},
    message?: string
  ) {
    const active = context.getStore();
    await this.emit(() => this.sink.log({
      timestamp: this.now().toISOString(),
      severity,
      event,
      message,
      traceId: active?.traceId,
      spanId: active?.spanId,
      attributes: clean(attributes)
    }));
  }

  async counter(name: string, value = 1, attributes: Record<string, unknown> = {}) {
    await this.metric(name, "counter", value, attributes);
  }

  async histogram(
    name: string,
    value: number,
    unit: string,
    attributes: Record<string, unknown> = {}
  ) {
    await this.metric(name, "histogram", value, attributes, unit);
  }

  async gauge(
    name: string,
    value: number,
    unit: string,
    attributes: Record<string, unknown> = {}
  ) {
    await this.metric(name, "gauge", value, attributes, unit);
  }

  private async metric(
    name: string,
    kind: MetricRecord["kind"],
    value: number,
    attributes: Record<string, unknown>,
    unit?: string
  ) {
    await this.emit(() => this.sink.metric({
      name,
      kind,
      value,
      unit,
      timestamp: this.now().toISOString(),
      attributes: clean(attributes)
    }));
  }
}

export class CompositeTelemetrySink implements TelemetrySink {
  constructor(private readonly sinks: readonly TelemetrySink[]) {}
  async log(record: StructuredLogRecord) {
    await Promise.all(this.sinks.map((sink) => sink.log(record)));
  }
  async metric(record: MetricRecord) {
    await Promise.all(this.sinks.map((sink) => sink.metric(record)));
  }
  async span(record: SpanRecord) {
    await Promise.all(this.sinks.map((sink) => sink.span(record)));
  }
}

export class OtlpJsonHttpTelemetrySink implements TelemetrySink {
  private readonly endpoint: string;
  constructor(
    endpoint: string,
    private readonly headers: Readonly<Record<string, string>> = {},
    private readonly fetchImpl: typeof fetch = fetch
  ) {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1","localhost","::1"].includes(url.hostname))) {
      throw new Error("OTLP endpoint must use HTTPS outside loopback development");
    }
    this.endpoint = url.toString().replace(/\/$/, "");
  }

  private async send(path: string, body: unknown) {
    const response = await this.fetchImpl(this.endpoint + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.headers },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      throw new Error(`OTLP export failed with HTTP ${response.status}`);
    }
  }

  log(record: StructuredLogRecord) {
    return this.send("/v1/logs", {
      resourceLogs: [{
        scopeLogs: [{
          logRecords: [{
            timeUnixNano: String(Date.parse(record.timestamp) * 1_000_000),
            severityText: record.severity,
            body: { stringValue: record.message ?? record.event },
            traceId: record.traceId,
            spanId: record.spanId,
            attributes: Object.entries({ event: record.event, ...record.attributes })
              .map(([key, value]) => ({ key, value: { stringValue: String(value) } }))
          }]
        }]
      }]
    });
  }

  metric(record: MetricRecord) {
    const point = {
      timeUnixNano: String(Date.parse(record.timestamp) * 1_000_000),
      asDouble: record.value,
      attributes: Object.entries(record.attributes)
        .map(([key, value]) => ({ key, value: { stringValue: String(value) } }))
    };
    const data = record.kind === "histogram"
      ? { histogram: { dataPoints: [{ ...point, count: "1", sum: record.value }] } }
      : record.kind === "counter"
        ? {
            sum: {
              aggregationTemporality: 2,
              isMonotonic: true,
              dataPoints: [point]
            }
          }
        : { gauge: { dataPoints: [point] } };
    return this.send("/v1/metrics", {
      resourceMetrics: [{
        scopeMetrics: [{
          metrics: [{ name: record.name, unit: record.unit ?? "1", ...data }]
        }]
      }]
    });
  }

  span(record: SpanRecord) {
    return this.send("/v1/traces", {
      resourceSpans: [{
        scopeSpans: [{
          spans: [{
            traceId: record.traceId,
            spanId: record.spanId,
            parentSpanId: record.parentSpanId,
            name: record.name,
            startTimeUnixNano: String(Date.parse(record.startedAt) * 1_000_000),
            endTimeUnixNano: String(Date.parse(record.endedAt) * 1_000_000),
            status: { code: record.status === "ok" ? 1 : 2 },
            attributes: Object.entries(record.attributes)
              .map(([key, value]) => ({ key, value: { stringValue: String(value) } }))
          }]
        }]
      }]
    });
  }
}

export function telemetryFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fetchImpl: typeof fetch = fetch
) {
  if (env.GETDONE_OBSERVABILITY_ENABLED !== "true") {
    return new Telemetry(new NoopTelemetrySink());
  }
  const sinks: TelemetrySink[] = [new JsonConsoleTelemetrySink()];
  const endpoint = env.GETDONE_OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (endpoint) {
    const headers = Object.fromEntries(
      (env.GETDONE_OTEL_EXPORTER_OTLP_HEADERS ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
          const index = entry.indexOf("=");
          return index > 0 ? [entry.slice(0, index), entry.slice(index + 1)] : [entry, ""];
        })
    );
    sinks.push(new OtlpJsonHttpTelemetrySink(endpoint, headers, fetchImpl));
  }
  return new Telemetry(new CompositeTelemetrySink(sinks));
}

let defaultTelemetry: Telemetry | undefined;

export function getTelemetry() {
  defaultTelemetry ??= telemetryFromEnv();
  return defaultTelemetry;
}

export function setTelemetryForTests(value: Telemetry | undefined) {
  defaultTelemetry = value;
}

export const OTEL_SEMANTIC = Object.freeze({
  jobId: "job.id",
  jobState: "job.state",
  jobAttempt: "job.attempt",
  workerId: "worker.id",
  provider: "peer.service",
  operation: "rpc.method",
  retryClass: "getdone.retry.class",
  capability: "getdone.capability",
  companyId: "getdone.company.id",
  environment: "deployment.environment.name",
  authorizationOutcome: "getdone.authorization.outcome",
  credentialVersion: "getdone.credential.version"
});
