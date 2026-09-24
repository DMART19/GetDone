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
        await this.sink.span({
          traceId,
          spanId,
          parentSpanId: parent?.spanId,
          name,
          startedAt: started.toISOString(),
          endedAt: ended.toISOString(),
          durationMs: Math.max(0, ended.getTime() - started.getTime()),
          status: "ok",
          attributes: baseAttributes
        });
        return result;
      } catch (error) {
        const ended = this.now();
        await this.sink.span({
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
        });
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
    await this.sink.log({
      timestamp: this.now().toISOString(),
      severity,
      event,
      message,
      traceId: active?.traceId,
      spanId: active?.spanId,
      attributes: clean(attributes)
    });
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
    await this.sink.metric({
      name,
      kind,
      value,
      unit,
      timestamp: this.now().toISOString(),
      attributes: clean(attributes)
    });
  }
}

let defaultTelemetry: Telemetry | undefined;

export function getTelemetry() {
  defaultTelemetry ??= new Telemetry();
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
