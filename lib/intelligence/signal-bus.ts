import { z } from "zod";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import {
  signalDedupeKey,
  signalStreamCursorKey,
  type InboundSignalEvent,
  type NormalizedSignal,
  type TrustedSignalScope
} from "@/lib/intelligence/signals";

const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/);
const attributesSchema = z.record(
  z.union([z.string(), z.number().finite(), z.boolean(), z.null()])
).refine((value) => Object.keys(value).length <= 100, {
  message: "attributes cannot contain more than 100 keys"
});

const inboundSignalEventSchema = z.object({
  eventId: id,
  streamKey: id,
  type: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/),
  occurredAt: z.string().datetime({ offset: true }),
  sequence: z.number().int().nonnegative().optional(),
  externalResourceRef: z.string().min(1).max(500).optional(),
  metric: z.string().min(1).max(200).optional(),
  value: z.number().finite().optional(),
  unit: z.string().min(1).max(80).optional(),
  severity: z.enum(["info", "low", "medium", "high", "critical"]).optional(),
  expected: z.boolean().optional(),
  sustainedForSeconds: z.number().int().nonnegative().max(31_536_000).optional(),
  attributes: attributesSchema.optional()
}).strict();

export interface SignalSourceBinding {
  id: string;
  sourceName: string;
  portfolioId: string;
  companyId: string;
  enabled: boolean;
}

export interface SignalScopeResolver {
  resolve(input: {
    sourceBindingId: string;
    externalResourceRef?: string;
  }): Promise<{
    binding: SignalSourceBinding;
    scope: TrustedSignalScope;
  } | null>;
}

export interface SignalDedupeStore {
  /**
   * Durable implementations must atomically claim a key.
   * Returns true only for the first logical event.
   */
  claim(key: string, observedAt: string): Promise<boolean>;
}

export interface SignalStreamCursor {
  sequence?: number;
  occurredAt: string;
}

export interface SignalCursorStore {
  get(key: string): Promise<SignalStreamCursor | null>;
  advance(key: string, cursor: SignalStreamCursor): Promise<void>;
}

export interface NormalizedSignalStore {
  append(signal: NormalizedSignal): Promise<void>;
}

export interface SignalBusDependencies {
  scopeResolver: SignalScopeResolver;
  dedupe: SignalDedupeStore;
  cursors: SignalCursorStore;
  signals: NormalizedSignalStore;
  now?: () => Date;
  idFactory?: () => string;
}

export type SignalIngestionResult =
  | { status: "accepted"; signal: NormalizedSignal }
  | { status: "accepted-out-of-order"; signal: NormalizedSignal }
  | { status: "duplicate"; dedupeKey: string };

export function parseInboundSignalEvent(payload: unknown): InboundSignalEvent {
  const parsed = inboundSignalEventSchema.safeParse(payload);
  if (!parsed.success) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Signal ingestion payload failed validation", {
      details: {
        issueCount: parsed.error.issues.length,
        issuePaths: parsed.error.issues.map((issue) => issue.path.join(".")).join(",")
      }
    });
  }
  return parsed.data;
}

function isOutOfOrder(event: InboundSignalEvent, cursor: SignalStreamCursor | null) {
  if (!cursor) return false;
  if (event.sequence !== undefined && cursor.sequence !== undefined) {
    return event.sequence <= cursor.sequence;
  }
  return Date.parse(event.occurredAt) < Date.parse(cursor.occurredAt);
}

function shouldAdvanceCursor(event: InboundSignalEvent, cursor: SignalStreamCursor | null) {
  if (!cursor) return true;
  if (event.sequence !== undefined && cursor.sequence !== undefined) {
    return event.sequence > cursor.sequence;
  }
  return Date.parse(event.occurredAt) >= Date.parse(cursor.occurredAt);
}

export class SignalBusService {
  constructor(private readonly dependencies: SignalBusDependencies) {}

  async ingest(sourceBindingId: string, payload: unknown): Promise<SignalIngestionResult> {
    if (!sourceBindingId) {
      throw new ControlPlaneError("UNAUTHENTICATED", "Authenticated signal-source binding is required");
    }

    const event = parseInboundSignalEvent(payload);
    const resolved = await this.dependencies.scopeResolver.resolve({
      sourceBindingId,
      externalResourceRef: event.externalResourceRef
    });

    if (!resolved || !resolved.binding.enabled) {
      throw new ControlPlaneError("FORBIDDEN", "Signal source is not authorized");
    }

    const scope = resolved.scope;
    if (
      scope.portfolioId !== resolved.binding.portfolioId
      || scope.companyId !== resolved.binding.companyId
    ) {
      throw new ControlPlaneError("FORBIDDEN", "Resolved signal scope does not match the trusted source binding");
    }

    const dedupeKey = signalDedupeKey(sourceBindingId, event.eventId, scope);
    const claimed = await this.dependencies.dedupe.claim(dedupeKey, event.occurredAt);
    if (!claimed) return { status: "duplicate", dedupeKey };

    const cursorKey = signalStreamCursorKey(sourceBindingId, event.streamKey, scope);
    const cursor = await this.dependencies.cursors.get(cursorKey);
    const outOfOrder = isOutOfOrder(event, cursor);
    const receivedAt = (this.dependencies.now ?? (() => new Date()))().toISOString();

    const signal: NormalizedSignal = {
      id: (this.dependencies.idFactory ?? (() => crypto.randomUUID()))(),
      dedupeKey,
      sourceBindingId,
      eventId: event.eventId,
      streamKey: event.streamKey,
      sequence: event.sequence,
      type: event.type,
      occurredAt: event.occurredAt,
      receivedAt,
      scope,
      metric: event.metric,
      value: event.value,
      unit: event.unit,
      severity: event.severity,
      expected: event.expected,
      sustainedForSeconds: event.sustainedForSeconds,
      attributes: Object.freeze({ ...(event.attributes ?? {}) }),
      provenance: `${resolved.binding.sourceName}:${sourceBindingId}:${event.eventId}`,
      outOfOrder
    };

    await this.dependencies.signals.append(signal);

    if (shouldAdvanceCursor(event, cursor)) {
      await this.dependencies.cursors.advance(cursorKey, {
        sequence: event.sequence ?? cursor?.sequence,
        occurredAt: event.occurredAt
      });
    }

    return {
      status: outOfOrder ? "accepted-out-of-order" : "accepted",
      signal
    };
  }
}
