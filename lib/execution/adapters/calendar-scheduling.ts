import { z } from "zod";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import { validateCapabilityInput } from "@/lib/domain/capabilities";
import {
  createBusinessActionAdapterResult,
  createBusinessActionStatus,
  type AuthorizedBusinessActionRequest,
  type BusinessActionAdapter,
  type BusinessActionExecutionContext,
  type BusinessActionStatus
} from "@/lib/execution/adapters/business-action";
import {
  assertAdapterRequest,
  classifyHttpFailure,
  providerRequestHeaders,
  readBoundedJson,
  requireBrokeredCredential,
  ORDINARY_INTEGRATION_RETRY_TAXONOMY,
  type BusinessActionAdapterDeclaration
} from "@/lib/execution/adapters/ordinary-integration-framework";

export const CALENDAR_SCHEDULING_ADAPTER_VERSION = "1.0.0";

const environmentSchema = z.enum(["development", "staging", "production"]);
const attendeeSchema = z.object({
  email: z.string().email().max(320),
  displayName: z.string().min(1).max(200).optional(),
  optional: z.boolean().optional()
}).strict();

export interface CalendarProviderConfiguration {
  id: string;
  companyId: string;
  environment: z.infer<typeof environmentSchema>;
  credentialProviderId: string;
  baseUrl: string;
  calendars: readonly string[];
  listPath: string;
  itemPath: string;
  readScopes?: readonly string[];
  writeScopes?: readonly string[];
  maxResponseBytes?: number;
  itemsPath?: string;
  idPath?: string;
  revisionPath?: string;
  statusPath?: string;
  titlePath?: string;
  startPath?: string;
  endPath?: string;
  timeZonePath?: string;
  attendeesPath?: string;
}

type CalendarCapability =
  | "calendar.event.read"
  | "calendar.event.create"
  | "calendar.event.update"
  | "calendar.event.cancel";

type CalendarAttendee = z.infer<typeof attendeeSchema>;

interface CanonicalCalendarEvent {
  providerEventId: string;
  calendarId: string;
  revision?: string;
  status: "confirmed" | "cancelled" | "tentative";
  title: string;
  startAt: string;
  endAt: string;
  timeZone: string;
  attendees: readonly CalendarAttendee[];
}

type ValidatedConfiguration = ReturnType<typeof validateConfiguration>;

const READ_DECLARATION: BusinessActionAdapterDeclaration = Object.freeze({
  capability: "calendar.event.read",
  provider: "calendar",
  credentialMode: "brokered-lease",
  minimumScopes: Object.freeze(["calendar.read"]),
  timeoutMs: Object.freeze({ min: 100, max: 120_000 }),
  idempotency: "required",
  retryTaxonomy: ORDINARY_INTEGRATION_RETRY_TAXONOMY,
  providerOperationId: "required",
  statusResume: "not-supported",
  maxResponseBytes: 2_000_000,
  auditEvidence: "hashed-provider-evidence",
  verificationStrategy: "provider-object-read",
  cancellation: "not-supported",
  tenantEnvironmentBinding: true,
  truthSemantics: "provider-acceptance-is-not-business-truth"
});

function writeDeclaration(capability: Exclude<CalendarCapability, "calendar.event.read">): BusinessActionAdapterDeclaration {
  return Object.freeze({
    capability,
    provider: "calendar",
    credentialMode: "brokered-lease",
    minimumScopes: Object.freeze(["calendar.write", "calendar.read"]),
    verificationScopes: Object.freeze(["calendar.read"]),
    timeoutMs: Object.freeze({ min: 100, max: 120_000 }),
    idempotency: "required",
    retryTaxonomy: ORDINARY_INTEGRATION_RETRY_TAXONOMY,
    providerOperationId: "required",
    statusResume: "supported",
    maxResponseBytes: 2_000_000,
    auditEvidence: "hashed-provider-evidence",
    verificationStrategy: "provider-object-read",
    cancellation: "not-supported",
    tenantEnvironmentBinding: true,
    truthSemantics: "provider-acceptance-is-not-business-truth"
  });
}

const DECLARATIONS = new Map<CalendarCapability, BusinessActionAdapterDeclaration>([
  ["calendar.event.read", READ_DECLARATION],
  ["calendar.event.create", writeDeclaration("calendar.event.create")],
  ["calendar.event.update", writeDeclaration("calendar.event.update")],
  ["calendar.event.cancel", writeDeclaration("calendar.event.cancel")]
]);

function safeRelativeTemplate(value: string, label: string, requiredTokens: readonly string[]) {
  const trimmed = value.trim().replace(/^\/+/, "");
  if (
    !trimmed
    || trimmed.includes("..")
    || trimmed.includes("?")
    || trimmed.includes("#")
    || trimmed.includes("\\")
    || /^https?:/i.test(trimmed)
  ) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a safe relative path template`);
  }
  for (const token of requiredTokens) {
    if (!trimmed.includes(`{${token}}`)) {
      throw new ControlPlaneError("VALIDATION_FAILED", `${label} requires {${token}}`);
    }
  }
  return trimmed;
}

function dottedPath(value: string | undefined, fallback: string, label: string) {
  const candidate = value?.trim() || fallback;
  if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(candidate)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} is invalid`);
  }
  return candidate;
}

function validateConfiguration(configuration: CalendarProviderConfiguration) {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(configuration.id)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Calendar configuration id is invalid");
  }
  if (!/^[A-Za-z0-9._:@+-]{1,200}$/.test(configuration.credentialProviderId)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Calendar credentialProviderId is invalid");
  }
  const base = new URL(configuration.baseUrl);
  if (base.protocol !== "https:" || base.username || base.password || base.hash || base.search) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Calendar base URL must be credential-free HTTPS");
  }
  const calendars = [...new Set(configuration.calendars)];
  if (calendars.length < 1 || calendars.length > 200 || calendars.some((value) => !value || value.length > 300)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Calendar allowlist must contain 1-200 bounded calendar IDs");
  }
  const maxResponseBytes = configuration.maxResponseBytes ?? 1_000_000;
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 2_000_000) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Calendar maxResponseBytes must be 1-2000000");
  }
  return Object.freeze({
    ...configuration,
    environment: environmentSchema.parse(configuration.environment),
    baseUrl: base.toString().replace(/\/?$/, "/"),
    calendars: Object.freeze(calendars),
    listPath: safeRelativeTemplate(configuration.listPath, "Calendar listPath", ["calendarId"]),
    itemPath: safeRelativeTemplate(configuration.itemPath, "Calendar itemPath", ["calendarId", "eventId"]),
    readScopes: Object.freeze([...(configuration.readScopes ?? ["calendar.read"])]),
    writeScopes: Object.freeze([...(configuration.writeScopes ?? ["calendar.write", "calendar.read"])]),
    maxResponseBytes,
    itemsPath: dottedPath(configuration.itemsPath, "items", "Calendar itemsPath"),
    idPath: dottedPath(configuration.idPath, "id", "Calendar idPath"),
    revisionPath: dottedPath(configuration.revisionPath, "revision", "Calendar revisionPath"),
    statusPath: dottedPath(configuration.statusPath, "status", "Calendar statusPath"),
    titlePath: dottedPath(configuration.titlePath, "title", "Calendar titlePath"),
    startPath: dottedPath(configuration.startPath, "start.dateTime", "Calendar startPath"),
    endPath: dottedPath(configuration.endPath, "end.dateTime", "Calendar endPath"),
    timeZonePath: dottedPath(configuration.timeZonePath, "start.timeZone", "Calendar timeZonePath"),
    attendeesPath: dottedPath(configuration.attendeesPath, "attendees", "Calendar attendeesPath")
  });
}

function getAtPath(value: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

function normalizeOffset(value: string) {
  if (value === "Z") return "+00:00";
  return value;
}

function offsetFor(timeZone: string, instantMs: number) {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "longOffset",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    });
  } catch {
    throw new ControlPlaneError("VALIDATION_FAILED", "Calendar timezone is invalid");
  }
  const zoneName = formatter.formatToParts(new Date(instantMs))
    .find((part) => part.type === "timeZoneName")?.value;
  if (zoneName === "GMT" || zoneName === "UTC") return "+00:00";
  const match = /^GMT([+-]\d{2}:\d{2})$/.exec(zoneName ?? "");
  if (!match) {
    throw new ControlPlaneError("UNAVAILABLE", "Runtime could not resolve deterministic timezone offset");
  }
  return match[1];
}

function canonicalInstant(value: string, timeZone: string, label: string) {
  const offset = /(Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1];
  const instant = Date.parse(value);
  if (!offset || !Number.isFinite(instant)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be offset-qualified RFC3339`);
  }
  const expected = offsetFor(timeZone, instant);
  if (normalizeOffset(offset) !== expected) {
    throw new ControlPlaneError(
      "VALIDATION_FAILED",
      `${label} offset does not match ${timeZone} at that instant`
    );
  }
  return new Date(instant).toISOString();
}

function canonicalWindow(input: {
  startAt: string;
  endAt: string;
  timeZone: string;
  maxDurationMs?: number;
}) {
  const startAt = canonicalInstant(input.startAt, input.timeZone, "Calendar start");
  const endAt = canonicalInstant(input.endAt, input.timeZone, "Calendar end");
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  if (end <= start) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Calendar end must be after start");
  }
  if (input.maxDurationMs && end - start > input.maxDurationMs) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Calendar time range exceeds configured bound");
  }
  return { startAt, endAt };
}

function encodeTemplate(template: string, values: Record<string, string>) {
  let output = template;
  for (const [key, value] of Object.entries(values)) {
    output = output.replaceAll(`{${key}}`, encodeURIComponent(value));
  }
  return output;
}

function listUrl(
  configuration: ValidatedConfiguration,
  calendarId: string,
  input: { startAt: string; endAt: string; timeZone: string; maxResults: number }
) {
  const relative = encodeTemplate(configuration.listPath, { calendarId });
  const url = new URL(relative, configuration.baseUrl);
  url.searchParams.set("timeMin", input.startAt);
  url.searchParams.set("timeMax", input.endAt);
  url.searchParams.set("timeZone", input.timeZone);
  url.searchParams.set("maxResults", String(input.maxResults));
  return url;
}

function itemUrl(configuration: ValidatedConfiguration, calendarId: string, eventId: string) {
  return new URL(
    encodeTemplate(configuration.itemPath, { calendarId, eventId }),
    configuration.baseUrl
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeAttendees(value: unknown): readonly CalendarAttendee[] {
  if (value === undefined || value === null) return Object.freeze([]);
  const parsed = z.array(attendeeSchema).max(250).safeParse(value);
  if (!parsed.success) {
    throw new ControlPlaneError("UNAVAILABLE", "Calendar provider attendees are malformed");
  }
  return Object.freeze(
    parsed.data
      .map((item) => ({
        email: item.email.toLowerCase(),
        displayName: item.displayName,
        optional: item.optional
      }))
      .sort((a, b) => a.email.localeCompare(b.email))
  );
}

function providerEvent(
  raw: unknown,
  configuration: ValidatedConfiguration,
  calendarId: string
): CanonicalCalendarEvent {
  if (!isObject(raw)) {
    throw new ControlPlaneError("UNAVAILABLE", "Calendar provider event is malformed");
  }
  const id = getAtPath(raw, configuration.idPath);
  const status = getAtPath(raw, configuration.statusPath);
  const title = getAtPath(raw, configuration.titlePath);
  const startRaw = getAtPath(raw, configuration.startPath);
  const endRaw = getAtPath(raw, configuration.endPath);
  const timeZone = getAtPath(raw, configuration.timeZonePath);
  const revision = getAtPath(raw, configuration.revisionPath);

  if (
    typeof id !== "string"
    || !id
    || !["confirmed", "cancelled", "tentative"].includes(String(status))
    || typeof title !== "string"
    || typeof startRaw !== "string"
    || typeof endRaw !== "string"
    || typeof timeZone !== "string"
  ) {
    throw new ControlPlaneError("UNAVAILABLE", "Calendar provider event is missing required fields");
  }
  const window = canonicalWindow({
    startAt: startRaw,
    endAt: endRaw,
    timeZone,
    maxDurationMs: 366 * 24 * 60 * 60_000
  });
  return Object.freeze({
    providerEventId: id,
    calendarId,
    revision: typeof revision === "string" && revision ? revision : undefined,
    status: status as CanonicalCalendarEvent["status"],
    title,
    startAt: window.startAt,
    endAt: window.endAt,
    timeZone,
    attendees: normalizeAttendees(getAtPath(raw, configuration.attendeesPath))
  });
}

function eventExpectation(input: {
  providerEventId: string;
  calendarId: string;
  title: string;
  startAt: string;
  endAt: string;
  timeZone: string;
  attendees?: readonly CalendarAttendee[];
  cancelled?: boolean;
}) {
  return {
    providerEventId: input.providerEventId,
    calendarId: input.calendarId,
    title: input.title,
    startAt: input.startAt,
    endAt: input.endAt,
    timeZone: input.timeZone,
    attendees: [...(input.attendees ?? [])]
      .map((item) => ({
        email: item.email.toLowerCase(),
        displayName: item.displayName,
        optional: item.optional
      }))
      .sort((a, b) => a.email.localeCompare(b.email)),
    cancelled: input.cancelled === true
  };
}

function overlaps(
  event: CanonicalCalendarEvent,
  input: { startAt: string; endAt: string },
  excludeEventId?: string
) {
  if (event.providerEventId === excludeEventId || event.status === "cancelled") return false;
  return Date.parse(event.startAt) < Date.parse(input.endAt)
    && Date.parse(event.endAt) > Date.parse(input.startAt);
}

function opId(input: {
  configurationId: string;
  operation: "create" | "update" | "cancel";
  calendarId: string;
  providerEventId: string;
  expectedHash: string;
}) {
  const payload = Buffer.from(JSON.stringify({
    calendarId: input.calendarId,
    eventId: input.providerEventId,
    expectedHash: input.expectedHash
  }), "utf8").toString("base64url");
  const value = `calendar:${input.configurationId}:${input.operation}:${payload}`;
  if (value.length > 600) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Calendar verification lineage exceeds provider-operation limit");
  }
  return value;
}

function parseOpId(configurations: ReadonlyMap<string, ValidatedConfiguration>, value: string) {
  const match = /^calendar:([A-Za-z0-9._:-]+):(create|update|cancel):([A-Za-z0-9_-]+)$/.exec(value);
  if (!match) throw new ControlPlaneError("NOT_FOUND", "Calendar provider operation is malformed");
  const configuration = configurations.get(match[1]);
  if (!configuration) {
    throw new ControlPlaneError("NOT_FOUND", "Calendar provider configuration is unavailable");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(match[3], "base64url").toString("utf8"));
  } catch {
    throw new ControlPlaneError("VALIDATION_FAILED", "Calendar provider operation payload is malformed");
  }
  if (
    !isObject(payload)
    || typeof payload.calendarId !== "string"
    || typeof payload.eventId !== "string"
    || typeof payload.expectedHash !== "string"
    || !/^[a-f0-9]{64}$/.test(payload.expectedHash)
  ) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Calendar provider operation payload is invalid");
  }
  return {
    configuration,
    operation: match[2] as "create" | "update" | "cancel",
    calendarId: payload.calendarId,
    providerEventId: payload.eventId,
    expectedHash: payload.expectedHash
  };
}

async function boundedRequest(
  fetchImpl: typeof fetch,
  url: URL,
  init: RequestInit,
  maxResponseBytes: number
) {
  const response = await fetchImpl(url, init);
  const body = await readBoundedJson(response, maxResponseBytes).catch((error) => {
    if (response.ok) throw error;
    return {};
  });
  return { response, body };
}

export class CalendarSchedulingAdapter implements BusinessActionAdapter {
  readonly id = "calendar-scheduling";
  readonly version = CALENDAR_SCHEDULING_ADAPTER_VERSION;
  readonly declarations = Object.freeze(Object.fromEntries(DECLARATIONS));

  private readonly configurations: ReadonlyMap<string, ValidatedConfiguration>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;

  constructor(
    configurations: readonly CalendarProviderConfiguration[],
    options: { fetchImpl?: typeof fetch; now?: () => Date } = {}
  ) {
    const entries = configurations.map((item) => {
      const validated = validateConfiguration(item);
      return [validated.id, validated] as const;
    });
    if (entries.length === 0 || new Set(entries.map(([id]) => id)).size !== entries.length) {
      throw new ControlPlaneError("VALIDATION_FAILED", "Calendar configurations must be non-empty and unique");
    }
    this.configurations = new Map(entries);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  private configurationFor(
    request: AuthorizedBusinessActionRequest,
    connectionId: string,
    calendarId: string
  ) {
    const configuration = this.configurations.get(connectionId);
    if (
      !configuration
      || configuration.companyId !== request.scope.companyId
      || configuration.environment !== request.scope.environment
    ) {
      throw new ControlPlaneError("POLICY_BLOCKED", "Calendar connection is outside authoritative tenant/environment scope");
    }
    if (!configuration.calendars.includes(calendarId)) {
      throw new ControlPlaneError("POLICY_BLOCKED", "Calendar ID is outside the configured allowlist");
    }
    return configuration;
  }

  credentialRequirement(request: AuthorizedBusinessActionRequest) {
    const capability = request.capability as CalendarCapability;
    if (!DECLARATIONS.has(capability)) {
      throw new ControlPlaneError("FORBIDDEN", "Calendar adapter received unsupported capability");
    }
    const input = request.input as { connectionId?: unknown; calendarId?: unknown };
    if (typeof input.connectionId !== "string" || typeof input.calendarId !== "string") {
      throw new ControlPlaneError("VALIDATION_FAILED", "Calendar input is missing connectionId/calendarId");
    }
    const configuration = this.configurationFor(request, input.connectionId, input.calendarId);
    return {
      providerId: configuration.credentialProviderId,
      requiredScopes: capability === "calendar.event.read"
        ? configuration.readScopes
        : [...new Set([...configuration.writeScopes, ...configuration.readScopes])]
    };
  }

  private credential(
    request: AuthorizedBusinessActionRequest,
    configuration: ValidatedConfiguration,
    context: BusinessActionExecutionContext | undefined
  ) {
    const requirement = this.credentialRequirement(request);
    return requireBrokeredCredential(context, requirement, request.capability);
  }

  private async listCanonical(
    request: AuthorizedBusinessActionRequest,
    configuration: ValidatedConfiguration,
    credential: string,
    input: { calendarId: string; startAt: string; endAt: string; timeZone: string; maxResults: number }
  ) {
    const result = await boundedRequest(
      this.fetchImpl,
      listUrl(configuration, input.calendarId, input),
      {
        method: "GET",
        headers: {
          ...providerRequestHeaders({ request, credential }),
          accept: "application/json"
        },
        signal: AbortSignal.timeout(request.timeoutMs)
      },
      configuration.maxResponseBytes
    );
    if (!result.response.ok) return { response: result.response, events: [] as CanonicalCalendarEvent[] };
    const items = getAtPath(result.body, configuration.itemsPath);
    if (!Array.isArray(items) || items.length > input.maxResults || items.length > 250) {
      throw new ControlPlaneError("UNAVAILABLE", "Calendar provider returned an invalid bounded event list");
    }
    return {
      response: result.response,
      events: items.map((item) => providerEvent(item, configuration, input.calendarId))
    };
  }

  async execute(
    request: AuthorizedBusinessActionRequest,
    context?: BusinessActionExecutionContext
  ) {
    const capability = request.capability as CalendarCapability;
    const declaration = DECLARATIONS.get(capability);
    if (!declaration) throw new ControlPlaneError("FORBIDDEN", "Calendar capability is unavailable");

    if (capability === "calendar.event.read") {
      const input = validateCapabilityInput<{
        companyId: string;
        connectionId: string;
        calendarId: string;
        timeMin: string;
        timeMax: string;
        timeZone: string;
        maxResults: number;
      }>("calendar.event.read", request.input);
      const configuration = this.configurationFor(request, input.connectionId, input.calendarId);
      assertAdapterRequest(request, declaration, configuration);
      if (input.companyId !== request.scope.companyId) {
        throw new ControlPlaneError("FORBIDDEN", "Calendar company does not match authoritative Job scope");
      }
      const credential = this.credential(request, configuration, context);
      const window = canonicalWindow({
        startAt: input.timeMin,
        endAt: input.timeMax,
        timeZone: input.timeZone,
        maxDurationMs: 366 * 24 * 60 * 60_000
      });
      let listed;
      try {
        listed = await this.listCanonical(request, configuration, credential, {
          calendarId: input.calendarId,
          startAt: window.startAt,
          endAt: window.endAt,
          timeZone: input.timeZone,
          maxResults: input.maxResults
        });
      } catch (error) {
        if (error instanceof ControlPlaneError) throw error;
        return createBusinessActionAdapterResult({
          source: "business-action-adapter",
          requestId: request.id,
          adapterId: this.id,
          adapterVersion: this.version,
          status: "failed",
          retryable: true,
          retryClass: "transport",
          observedAt: this.now().toISOString()
        });
      }
      const observedAt = this.now().toISOString();
      if (!listed.response.ok) {
        const failure = classifyHttpFailure(listed.response.status);
        return createBusinessActionAdapterResult({
          source: "business-action-adapter",
          requestId: request.id,
          adapterId: this.id,
          adapterVersion: this.version,
          status: failure.resultStatus,
          retryable: failure.retryable,
          retryClass: failure.retryClass,
          observedAt
        });
      }
      const events = listed.events.map((event) => ({ ...event, observedAt }));
      const outputBase = {
        calendarId: input.calendarId,
        timeMin: window.startAt,
        timeMax: window.endAt,
        timeZone: input.timeZone,
        events,
        observedAt
      };
      return createBusinessActionAdapterResult({
        source: "business-action-adapter",
        requestId: request.id,
        adapterId: this.id,
        adapterVersion: this.version,
        status: "completed",
        output: { ...outputBase, resultHash: sha256Hex(outputBase) },
        retryable: false,
        retryClass: "none",
        observedAt
      });
    }

    const input = request.input as {
      companyId: string;
      connectionId: string;
      calendarId: string;
      providerEventId?: string;
      expectedRevision?: string;
      conflictPolicy?: "reject" | "allow";
      title?: string;
      description?: string | null;
      location?: string | null;
      startAt?: string;
      endAt?: string;
      timeZone?: string;
      attendees?: CalendarAttendee[];
      busy?: boolean;
    };
    const configuration = this.configurationFor(request, input.connectionId, input.calendarId);
    assertAdapterRequest(request, declaration, configuration);
    if (input.companyId !== request.scope.companyId) {
      throw new ControlPlaneError("FORBIDDEN", "Calendar company does not match authoritative Job scope");
    }
    const credential = this.credential(request, configuration, context);
    const observedAt = this.now().toISOString();

    let method: "POST" | "PATCH" | "DELETE";
    let url: URL;
    let body: Record<string, unknown> | undefined;
    let expectation: ReturnType<typeof eventExpectation>;
    let providerEventId = input.providerEventId;
    let operation: "create" | "update" | "cancel";

    if (capability === "calendar.event.create") {
      const create = validateCapabilityInput<{
        companyId: string;
        connectionId: string;
        calendarId: string;
        title: string;
        description?: string;
        location?: string;
        startAt: string;
        endAt: string;
        timeZone: string;
        attendees?: CalendarAttendee[];
        busy: boolean;
        conflictPolicy: "reject" | "allow";
      }>("calendar.event.create", request.input);
      const window = canonicalWindow({
        startAt: create.startAt,
        endAt: create.endAt,
        timeZone: create.timeZone,
        maxDurationMs: 31 * 24 * 60 * 60_000
      });
      if (create.conflictPolicy === "reject") {
        const conflict = await this.listCanonical(request, configuration, credential, {
          calendarId: create.calendarId,
          startAt: window.startAt,
          endAt: window.endAt,
          timeZone: create.timeZone,
          maxResults: 250
        });
        if (!conflict.response.ok) {
          const failure = classifyHttpFailure(conflict.response.status);
          return createBusinessActionAdapterResult({
            source: "business-action-adapter",
            requestId: request.id,
            adapterId: this.id,
            adapterVersion: this.version,
            status: failure.resultStatus,
            retryable: failure.retryable,
            retryClass: failure.retryClass,
            observedAt
          });
        }
        if (conflict.events.some((event) => overlaps(event, window))) {
          return createBusinessActionAdapterResult({
            source: "business-action-adapter",
            requestId: request.id,
            adapterId: this.id,
            adapterVersion: this.version,
            status: "rejected",
            output: { conflict: true, calendarId: create.calendarId },
            retryable: false,
            retryClass: "provider-4xx",
            observedAt
          });
        }
      }
      method = "POST";
      url = new URL(
        encodeTemplate(configuration.listPath, { calendarId: create.calendarId }),
        configuration.baseUrl
      );
      body = {
        title: create.title,
        description: create.description,
        location: create.location,
        start: { dateTime: window.startAt, timeZone: create.timeZone },
        end: { dateTime: window.endAt, timeZone: create.timeZone },
        attendees: create.attendees ?? [],
        busy: create.busy,
        clientRequestId: request.idempotencyKey
      };
      operation = "create";
      expectation = eventExpectation({
        providerEventId: "",
        calendarId: create.calendarId,
        title: create.title,
        startAt: window.startAt,
        endAt: window.endAt,
        timeZone: create.timeZone,
        attendees: create.attendees
      });
    } else if (capability === "calendar.event.update") {
      const update = validateCapabilityInput<{
        companyId: string;
        connectionId: string;
        calendarId: string;
        providerEventId: string;
        expectedRevision?: string;
        title?: string;
        description?: string | null;
        location?: string | null;
        startAt?: string;
        endAt?: string;
        timeZone?: string;
        attendees?: CalendarAttendee[];
        busy?: boolean;
        conflictPolicy: "reject" | "allow";
      }>("calendar.event.update", request.input);

      const currentResult = await boundedRequest(
        this.fetchImpl,
        itemUrl(configuration, update.calendarId, update.providerEventId),
        {
          method: "GET",
          headers: {
            ...providerRequestHeaders({ request, credential }),
            accept: "application/json"
          },
          signal: AbortSignal.timeout(request.timeoutMs)
        },
        configuration.maxResponseBytes
      );
      if (!currentResult.response.ok) {
        const failure = classifyHttpFailure(currentResult.response.status);
        return createBusinessActionAdapterResult({
          source: "business-action-adapter",
          requestId: request.id,
          adapterId: this.id,
          adapterVersion: this.version,
          status: failure.resultStatus,
          retryable: failure.retryable,
          retryClass: failure.retryClass,
          observedAt
        });
      }
      const current = providerEvent(currentResult.body, configuration, update.calendarId);
      if (update.expectedRevision && current.revision !== update.expectedRevision) {
        return createBusinessActionAdapterResult({
          source: "business-action-adapter",
          requestId: request.id,
          adapterId: this.id,
          adapterVersion: this.version,
          status: "rejected",
          output: { conflict: true, reason: "revision-mismatch" },
          retryable: false,
          retryClass: "provider-4xx",
          observedAt
        });
      }
      let startAt = current.startAt;
      let endAt = current.endAt;
      let timeZone = current.timeZone;
      if (update.startAt && update.endAt && update.timeZone) {
        const window = canonicalWindow({
          startAt: update.startAt,
          endAt: update.endAt,
          timeZone: update.timeZone,
          maxDurationMs: 31 * 24 * 60 * 60_000
        });
        startAt = window.startAt;
        endAt = window.endAt;
        timeZone = update.timeZone;
        if (update.conflictPolicy === "reject") {
          const conflict = await this.listCanonical(request, configuration, credential, {
            calendarId: update.calendarId,
            startAt,
            endAt,
            timeZone,
            maxResults: 250
          });
          if (!conflict.response.ok) {
            const failure = classifyHttpFailure(conflict.response.status);
            return createBusinessActionAdapterResult({
              source: "business-action-adapter",
              requestId: request.id,
              adapterId: this.id,
              adapterVersion: this.version,
              status: failure.resultStatus,
              retryable: failure.retryable,
              retryClass: failure.retryClass,
              observedAt
            });
          }
          if (conflict.events.some((event) => overlaps(event, { startAt, endAt }, update.providerEventId))) {
            return createBusinessActionAdapterResult({
              source: "business-action-adapter",
              requestId: request.id,
              adapterId: this.id,
              adapterVersion: this.version,
              status: "rejected",
              output: { conflict: true, reason: "schedule-overlap" },
              retryable: false,
              retryClass: "provider-4xx",
              observedAt
            });
          }
        }
      }
      method = "PATCH";
      url = itemUrl(configuration, update.calendarId, update.providerEventId);
      body = {
        ...(update.title !== undefined ? { title: update.title } : {}),
        ...(update.description !== undefined ? { description: update.description } : {}),
        ...(update.location !== undefined ? { location: update.location } : {}),
        ...(update.startAt ? {
          start: { dateTime: startAt, timeZone },
          end: { dateTime: endAt, timeZone }
        } : {}),
        ...(update.attendees !== undefined ? { attendees: update.attendees } : {}),
        ...(update.busy !== undefined ? { busy: update.busy } : {}),
        clientRequestId: request.idempotencyKey
      };
      providerEventId = update.providerEventId;
      operation = "update";
      expectation = eventExpectation({
        providerEventId,
        calendarId: update.calendarId,
        title: update.title ?? current.title,
        startAt,
        endAt,
        timeZone,
        attendees: update.attendees ?? current.attendees
      });
    } else {
      const cancel = validateCapabilityInput<{
        companyId: string;
        connectionId: string;
        calendarId: string;
        providerEventId: string;
        expectedRevision?: string;
      }>("calendar.event.cancel", request.input);
      if (cancel.expectedRevision) {
        const currentResult = await boundedRequest(
          this.fetchImpl,
          itemUrl(configuration, cancel.calendarId, cancel.providerEventId),
          {
            method: "GET",
            headers: {
              ...providerRequestHeaders({ request, credential }),
              accept: "application/json"
            },
            signal: AbortSignal.timeout(request.timeoutMs)
          },
          configuration.maxResponseBytes
        );
        if (!currentResult.response.ok) {
          const failure = classifyHttpFailure(currentResult.response.status);
          return createBusinessActionAdapterResult({
            source: "business-action-adapter",
            requestId: request.id,
            adapterId: this.id,
            adapterVersion: this.version,
            status: failure.resultStatus,
            retryable: failure.retryable,
            retryClass: failure.retryClass,
            observedAt
          });
        }
        const current = providerEvent(currentResult.body, configuration, cancel.calendarId);
        if (current.revision !== cancel.expectedRevision) {
          return createBusinessActionAdapterResult({
            source: "business-action-adapter",
            requestId: request.id,
            adapterId: this.id,
            adapterVersion: this.version,
            status: "rejected",
            output: { conflict: true, reason: "revision-mismatch" },
            retryable: false,
            retryClass: "provider-4xx",
            observedAt
          });
        }
      }
      method = "DELETE";
      url = itemUrl(configuration, cancel.calendarId, cancel.providerEventId);
      body = undefined;
      providerEventId = cancel.providerEventId;
      operation = "cancel";
      expectation = eventExpectation({
        providerEventId,
        calendarId: cancel.calendarId,
        title: "",
        startAt: "1970-01-01T00:00:00.000Z",
        endAt: "1970-01-01T00:00:00.001Z",
        timeZone: "UTC",
        cancelled: true
      });
    }

    let result: Awaited<ReturnType<typeof boundedRequest>>;
    try {
      result = await boundedRequest(
        this.fetchImpl,
        url,
        {
          method,
          headers: {
            ...providerRequestHeaders({ request, credential, contentType: body ? "application/json; charset=utf-8" : undefined }),
            accept: "application/json",
            ...(input.expectedRevision ? { "if-match": input.expectedRevision } : {})
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(request.timeoutMs)
        },
        configuration.maxResponseBytes
      );
    } catch {
      return createBusinessActionAdapterResult({
        source: "business-action-adapter",
        requestId: request.id,
        adapterId: this.id,
        adapterVersion: this.version,
        status: "failed",
        retryable: true,
        retryClass: "transport",
        observedAt
      });
    }

    if (!result.response.ok) {
      if (result.response.status === 409 || result.response.status === 412) {
        return createBusinessActionAdapterResult({
          source: "business-action-adapter",
          requestId: request.id,
          adapterId: this.id,
          adapterVersion: this.version,
          status: "rejected",
          output: { conflict: true, status: result.response.status },
          retryable: false,
          retryClass: "provider-4xx",
          observedAt
        });
      }
      const failure = classifyHttpFailure(result.response.status);
      return createBusinessActionAdapterResult({
        source: "business-action-adapter",
        requestId: request.id,
        adapterId: this.id,
        adapterVersion: this.version,
        status: failure.resultStatus,
        retryable: failure.retryable,
        retryClass: failure.retryClass,
        observedAt
      });
    }

    if (operation === "create") {
      const created = providerEvent(result.body, configuration, input.calendarId);
      providerEventId = created.providerEventId;
      expectation = { ...expectation, providerEventId };
    }
    if (!providerEventId) {
      throw new ControlPlaneError("UNAVAILABLE", "Calendar provider mutation is missing event identity");
    }
    const providerRevision = isObject(result.body)
      ? getAtPath(result.body, configuration.revisionPath)
      : undefined;
    const expectedHash = sha256Hex(expectation);
    const providerOperationId = opId({
      configurationId: configuration.id,
      operation,
      calendarId: input.calendarId,
      providerEventId,
      expectedHash
    });
    return createBusinessActionAdapterResult({
      source: "business-action-adapter",
      requestId: request.id,
      adapterId: this.id,
      adapterVersion: this.version,
      status: "accepted",
      providerOperationId,
      output: {
        calendarId: input.calendarId,
        providerEventId,
        operation,
        providerAccepted: true,
        providerRevision: typeof providerRevision === "string" ? providerRevision : undefined,
        acceptedAt: observedAt
      },
      retryable: false,
      retryClass: "none",
      observedAt
    });
  }

  async status(
    input: { requestId: string; providerOperationId: string },
    context?: BusinessActionExecutionContext
  ): Promise<BusinessActionStatus> {
    const operation = parseOpId(this.configurations, input.providerOperationId);
    const credential = requireBrokeredCredential(
      context,
      {
        providerId: operation.configuration.credentialProviderId,
        requiredScopes: operation.configuration.readScopes
      },
      `calendar.event.${operation.operation}`
    );
    let result: Awaited<ReturnType<typeof boundedRequest>>;
    try {
      result = await boundedRequest(
        this.fetchImpl,
        itemUrl(operation.configuration, operation.calendarId, operation.providerEventId),
        {
          method: "GET",
          headers: {
            authorization: `Bearer ${credential}`,
            accept: "application/json"
          },
          signal: AbortSignal.timeout(30_000)
        },
        operation.configuration.maxResponseBytes
      );
    } catch {
      return createBusinessActionStatus({
        source: "business-action-adapter",
        requestId: input.requestId,
        providerOperationId: input.providerOperationId,
        adapterId: this.id,
        adapterVersion: this.version,
        state: "running",
        observedAt: this.now().toISOString()
      });
    }

    let state: BusinessActionStatus["state"] = "running";
    if (operation.operation === "cancel" && result.response.status === 404) {
      state = "completed";
    } else if (!result.response.ok) {
      state = [408, 425, 429].includes(result.response.status) || result.response.status >= 500
        ? "running"
        : "failed";
    } else {
      const current = providerEvent(result.body, operation.configuration, operation.calendarId);
      if (operation.operation === "cancel") {
        state = current.status === "cancelled" ? "completed" : "running";
      } else {
        const expected = {
          providerEventId: current.providerEventId,
          calendarId: current.calendarId,
          title: current.title,
          startAt: current.startAt,
          endAt: current.endAt,
          timeZone: current.timeZone,
          attendees: current.attendees,
          cancelled: false
        };
        state = sha256Hex(expected) === operation.expectedHash ? "completed" : "running";
      }
    }
    return createBusinessActionStatus({
      source: "business-action-adapter",
      requestId: input.requestId,
      providerOperationId: input.providerOperationId,
      adapterId: this.id,
      adapterVersion: this.version,
      state,
      observedAt: this.now().toISOString()
    });
  }
}

export function readCalendarProviderConfigurationsFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  const raw = env.GETDONE_CALENDAR_ACTIONS_JSON?.trim();
  if (!raw) {
    throw new ControlPlaneError("UNAVAILABLE", "GETDONE_CALENDAR_ACTIONS_JSON is required");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ControlPlaneError("VALIDATION_FAILED", "GETDONE_CALENDAR_ACTIONS_JSON must be valid JSON");
  }
  return z.array(z.object({
    id: z.string().min(1),
    companyId: z.string().min(1),
    environment: environmentSchema,
    credentialProviderId: z.string().min(1),
    baseUrl: z.string().url(),
    calendars: z.array(z.string().min(1).max(300)).min(1),
    listPath: z.string().min(1),
    itemPath: z.string().min(1),
    readScopes: z.array(z.string().min(1)).optional(),
    writeScopes: z.array(z.string().min(1)).optional(),
    maxResponseBytes: z.number().int().positive().optional(),
    itemsPath: z.string().optional(),
    idPath: z.string().optional(),
    revisionPath: z.string().optional(),
    statusPath: z.string().optional(),
    titlePath: z.string().optional(),
    startPath: z.string().optional(),
    endPath: z.string().optional(),
    timeZonePath: z.string().optional(),
    attendeesPath: z.string().optional()
  }).strict()).min(1).parse(parsed) as readonly CalendarProviderConfiguration[];
}
