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
const capabilityNames = [
  "calendar.event.read",
  "calendar.event.create",
  "calendar.event.update",
  "calendar.event.cancel"
] as const;
type CalendarCapability = typeof capabilityNames[number];

export interface CalendarProviderConfiguration {
  id: string;
  companyId: string;
  environment: z.infer<typeof environmentSchema>;
  credentialProviderId: string;
  baseUrl: string;
  calendarPath: string;
  eventPath: string;
  conflictCheckPath?: string;
  readScopes?: readonly string[];
  writeScopes?: readonly string[];
  maxResponseBytes?: number;
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
  providerOperationId: "not-required",
  statusResume: "not-supported",
  maxResponseBytes: 1_000_000,
  auditEvidence: "hashed-provider-evidence",
  verificationStrategy: "provider-object-read",
  cancellation: "not-supported",
  tenantEnvironmentBinding: true,
  truthSemantics: "provider-acceptance-is-not-business-truth"
});

function writeDeclaration(capability: Exclude<CalendarCapability, "calendar.event.read">):
BusinessActionAdapterDeclaration {
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
    maxResponseBytes: 1_000_000,
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

function safeTemplate(value: string, required: readonly string[], label: string) {
  const trimmed = value.trim().replace(/^\/+/, "");
  if (
    !trimmed
    || trimmed.includes("..")
    || trimmed.includes("?")
    || trimmed.includes("#")
    || trimmed.includes("\\")
    || /^https?:/i.test(trimmed)
  ) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a safe relative provider path`);
  }
  for (const token of required) {
    if (!trimmed.includes(`{${token}}`)) {
      throw new ControlPlaneError("VALIDATION_FAILED", `${label} requires {${token}}`);
    }
  }
  return trimmed;
}

function validateConfiguration(configuration: CalendarProviderConfiguration) {
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(configuration.id)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Calendar configuration id is invalid");
  }
  if (!/^[A-Za-z0-9._:@+-]{1,200}$/.test(configuration.credentialProviderId)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Calendar credentialProviderId is invalid");
  }
  const baseUrl = new URL(configuration.baseUrl);
  if (
    baseUrl.protocol !== "https:"
    || baseUrl.username
    || baseUrl.password
    || baseUrl.hash
    || baseUrl.search
  ) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Calendar base URL must be credential-free HTTPS");
  }
  const maxResponseBytes = configuration.maxResponseBytes ?? 750_000;
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 1_000_000) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Calendar maxResponseBytes must be 1-1000000");
  }
  return Object.freeze({
    ...configuration,
    environment: environmentSchema.parse(configuration.environment),
    baseUrl: baseUrl.toString().replace(/\/?$/, "/"),
    calendarPath: safeTemplate(configuration.calendarPath, ["calendarId"], "Calendar calendarPath"),
    eventPath: safeTemplate(configuration.eventPath, ["calendarId", "eventId"], "Calendar eventPath"),
    conflictCheckPath: configuration.conflictCheckPath
      ? safeTemplate(configuration.conflictCheckPath, ["calendarId"], "Calendar conflictCheckPath")
      : undefined,
    readScopes: Object.freeze([...(configuration.readScopes ?? ["calendar.read"])]),
    writeScopes: Object.freeze([...(configuration.writeScopes ?? ["calendar.write", "calendar.read"])]),
    maxResponseBytes
  });
}

function isIanaTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function normalizeInstant(value: string, label: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a valid offset timestamp`);
  }
  return new Date(parsed).toISOString();
}

function replacePath(
  template: string,
  values: Readonly<Record<string, string>>
) {
  let relative = template;
  for (const [name, value] of Object.entries(values)) {
    relative = relative.replaceAll(`{${name}}`, encodeURIComponent(value));
  }
  if (/\{[A-Za-z0-9_-]+\}/.test(relative)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Calendar provider path has unresolved placeholders");
  }
  return relative;
}

function providerUrl(
  configuration: ValidatedConfiguration,
  template: string,
  values: Readonly<Record<string, string>>
) {
  return new URL(replacePath(template, values), configuration.baseUrl);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown, path: readonly string[]) {
  let current: unknown = value;
  for (const key of path) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }
  return typeof current === "string" ? current : undefined;
}

function normalizeAttendees(value: unknown) {
  if (!isObject(value) || !Array.isArray(value.attendees)) return [] as string[];
  const attendees = value.attendees.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (isObject(item) && typeof item.email === "string") return [item.email];
    return [];
  });
  return [...new Set(attendees.map((item) => item.trim().toLowerCase()).filter(Boolean))].sort();
}

function normalizeProviderEvent(raw: unknown, calendarId: string, observedAt: string) {
  if (!isObject(raw)) {
    throw new ControlPlaneError("UNAVAILABLE", "Calendar provider event is malformed");
  }
  const eventId = typeof raw.id === "string" ? raw.id : undefined;
  const providerVersion = typeof raw.etag === "string"
    ? raw.etag
    : typeof raw.version === "string"
      ? raw.version
      : typeof raw.updated === "string"
        ? raw.updated
        : undefined;
  const statusRaw = typeof raw.status === "string" ? raw.status : "confirmed";
  const status = statusRaw === "cancelled"
    ? "cancelled"
    : statusRaw === "tentative"
      ? "tentative"
      : "confirmed";
  const startRaw = readString(raw, ["start", "dateTime"]) ?? (
    typeof raw.startAt === "string" ? raw.startAt : undefined
  );
  const endRaw = readString(raw, ["end", "dateTime"]) ?? (
    typeof raw.endAt === "string" ? raw.endAt : undefined
  );
  const timeZone = readString(raw, ["start", "timeZone"])
    ?? readString(raw, ["end", "timeZone"])
    ?? (typeof raw.timeZone === "string" ? raw.timeZone : undefined);
  if (!eventId || !providerVersion || !startRaw || !endRaw || !timeZone || !isIanaTimeZone(timeZone)) {
    throw new ControlPlaneError("UNAVAILABLE", "Calendar provider event is missing deterministic identity/timezone fields");
  }
  const startAt = normalizeInstant(startRaw, "Calendar provider start");
  const endAt = normalizeInstant(endRaw, "Calendar provider end");
  if (Date.parse(startAt) >= Date.parse(endAt)) {
    throw new ControlPlaneError("UNAVAILABLE", "Calendar provider event has an invalid time range");
  }
  return Object.freeze({
    calendarId,
    eventId,
    title: typeof raw.summary === "string"
      ? raw.summary
      : typeof raw.title === "string"
        ? raw.title
        : "",
    description: typeof raw.description === "string" ? raw.description : undefined,
    location: typeof raw.location === "string" ? raw.location : undefined,
    startAt,
    endAt,
    timeZone,
    attendees: normalizeAttendees(raw),
    status,
    providerVersion,
    observedAt
  });
}

function deterministicEventId(request: AuthorizedBusinessActionRequest) {
  return "gd-" + sha256Hex({
    idempotencyKey: request.idempotencyKey,
    jobId: request.jobId,
    requestId: request.id
  }).slice(0, 40);
}

function eventExpectation(input: {
  calendarId: string;
  eventId: string;
  title: string;
  description?: string;
  location?: string;
  startAt: string;
  endAt: string;
  timeZone: string;
  attendees: readonly string[];
  status?: "confirmed" | "cancelled";
}) {
  return {
    calendarId: input.calendarId,
    eventId: input.eventId,
    title: input.title,
    description: input.description,
    location: input.location,
    startAt: normalizeInstant(input.startAt, "Calendar event start"),
    endAt: normalizeInstant(input.endAt, "Calendar event end"),
    timeZone: input.timeZone,
    attendees: [...new Set(input.attendees.map((item) => item.trim().toLowerCase()))].sort(),
    status: input.status ?? "confirmed"
  };
}

function providerPayload(input: {
  eventId?: string;
  title: string;
  description?: string;
  location?: string;
  startAt: string;
  endAt: string;
  timeZone: string;
  attendees: readonly string[];
}) {
  if (!isIanaTimeZone(input.timeZone)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Calendar timeZone must be a valid IANA time zone");
  }
  return {
    ...(input.eventId ? { id: input.eventId } : {}),
    summary: input.title,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.location !== undefined ? { location: input.location } : {}),
    start: {
      dateTime: normalizeInstant(input.startAt, "Calendar event start"),
      timeZone: input.timeZone
    },
    end: {
      dateTime: normalizeInstant(input.endAt, "Calendar event end"),
      timeZone: input.timeZone
    },
    attendees: [...new Set(input.attendees.map((email) => email.trim().toLowerCase()))]
      .sort()
      .map((email) => ({ email }))
  };
}

function encode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}
function decode(value: string) {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    throw new ControlPlaneError("VALIDATION_FAILED", "Calendar provider operation lineage is malformed");
  }
}

function createOperationId(input: {
  configurationId: string;
  capability: Exclude<CalendarCapability, "calendar.event.read">;
  calendarId: string;
  eventId: string;
  expectationHash: string;
}) {
  const payload = encode(JSON.stringify({
    c: input.calendarId,
    e: input.eventId,
    h: input.expectationHash
  }));
  const value = `cal:${input.configurationId}:${input.capability}:${payload}`;
  if (value.length > 500) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Calendar provider operation lineage exceeds limit");
  }
  return value;
}

function parseOperationId(
  configurations: ReadonlyMap<string, ValidatedConfiguration>,
  value: string
) {
  const match = /^cal:([A-Za-z0-9._-]+):(calendar\.event\.(?:create|update|cancel)):([A-Za-z0-9_-]+)$/.exec(value);
  if (!match) throw new ControlPlaneError("NOT_FOUND", "Calendar provider operation is malformed");
  const configuration = configurations.get(match[1]);
  if (!configuration) {
    throw new ControlPlaneError("NOT_FOUND", "Calendar provider configuration is unavailable");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decode(match[3]));
  } catch {
    throw new ControlPlaneError("VALIDATION_FAILED", "Calendar provider operation payload is malformed");
  }
  if (
    !isObject(parsed)
    || typeof parsed.c !== "string"
    || typeof parsed.e !== "string"
    || typeof parsed.h !== "string"
    || !/^[a-f0-9]{64}$/.test(parsed.h)
  ) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Calendar provider operation payload is invalid");
  }
  return {
    configuration,
    capability: match[2] as Exclude<CalendarCapability, "calendar.event.read">,
    calendarId: parsed.c,
    eventId: parsed.e,
    expectationHash: parsed.h
  };
}

async function boundedRequest(
  fetchImpl: typeof fetch,
  url: URL,
  init: RequestInit,
  maxResponseBytes: number
) {
  const response = await fetchImpl(url, init);
  const body = response.status === 204
    ? {}
    : await readBoundedJson(response, maxResponseBytes).catch((error) => {
        if (response.ok) throw error;
        return {};
      });
  return { response, body };
}

function calendarHeaders(
  request: AuthorizedBusinessActionRequest,
  credential: string,
  options: { contentType?: boolean; expectedVersion?: string } = {}
) {
  return {
    ...providerRequestHeaders({
      request,
      credential,
      contentType: options.contentType ? "application/json; charset=utf-8" : undefined
    }),
    accept: "application/json",
    ...(options.expectedVersion ? { "if-match": options.expectedVersion } : {})
  };
}

function verifiedEventHash(event: ReturnType<typeof normalizeProviderEvent>) {
  return sha256Hex({
    calendarId: event.calendarId,
    eventId: event.eventId,
    title: event.title,
    description: event.description,
    location: event.location,
    startAt: event.startAt,
    endAt: event.endAt,
    timeZone: event.timeZone,
    attendees: event.attendees,
    status: event.status
  });
}

function expectationHash(expectation: ReturnType<typeof eventExpectation>) {
  return sha256Hex(expectation);
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

  private baseInput(request: AuthorizedBusinessActionRequest) {
    if (!capabilityNames.includes(request.capability as CalendarCapability)) {
      throw new ControlPlaneError("FORBIDDEN", "Calendar adapter received unsupported capability");
    }
    const input = request.input as { connectionId?: unknown; companyId?: unknown };
    if (typeof input.connectionId !== "string") {
      throw new ControlPlaneError("VALIDATION_FAILED", "Calendar connectionId is required");
    }
    const configuration = this.configurations.get(input.connectionId);
    if (
      !configuration
      || configuration.companyId !== request.scope.companyId
      || configuration.environment !== request.scope.environment
    ) {
      throw new ControlPlaneError("POLICY_BLOCKED", "Calendar connection is outside authoritative tenant/environment scope");
    }
    if (input.companyId !== request.scope.companyId) {
      throw new ControlPlaneError("FORBIDDEN", "Calendar company does not match authoritative Job scope");
    }
    return configuration;
  }

  credentialRequirement(request: AuthorizedBusinessActionRequest) {
    const configuration = this.baseInput(request);
    return {
      providerId: configuration.credentialProviderId,
      requiredScopes: request.capability === "calendar.event.read"
        ? configuration.readScopes
        : configuration.writeScopes
    };
  }

  private declaration(request: AuthorizedBusinessActionRequest) {
    const declaration = DECLARATIONS.get(request.capability as CalendarCapability);
    if (!declaration) throw new ControlPlaneError("FORBIDDEN", "Calendar capability is unavailable");
    return declaration;
  }

  private credential(
    request: AuthorizedBusinessActionRequest,
    configuration: ValidatedConfiguration,
    context: BusinessActionExecutionContext | undefined
  ) {
    return requireBrokeredCredential(
      context,
      {
        providerId: configuration.credentialProviderId,
        requiredScopes: request.capability === "calendar.event.read"
          ? configuration.readScopes
          : configuration.writeScopes
      },
      request.capability
    );
  }

  private async conflictCheck(
    request: AuthorizedBusinessActionRequest,
    configuration: ValidatedConfiguration,
    credential: string,
    input: {
      calendarId: string;
      startAt: string;
      endAt: string;
      timeZone: string;
      conflictPolicy: "reject" | "allow";
      eventId?: string;
    }
  ) {
    if (input.conflictPolicy === "allow" || !configuration.conflictCheckPath) {
      return false;
    }
    const result = await boundedRequest(
      this.fetchImpl,
      providerUrl(configuration, configuration.conflictCheckPath, {
        calendarId: input.calendarId
      }),
      {
        method: "POST",
        headers: calendarHeaders(request, credential, { contentType: true }),
        body: JSON.stringify({
          calendarId: input.calendarId,
          timeMin: normalizeInstant(input.startAt, "Calendar event start"),
          timeMax: normalizeInstant(input.endAt, "Calendar event end"),
          timeZone: input.timeZone,
          excludeEventId: input.eventId
        }),
        signal: AbortSignal.timeout(request.timeoutMs)
      },
      configuration.maxResponseBytes
    );
    if (!result.response.ok) {
      throw new ControlPlaneError(
        "UNAVAILABLE",
        `Calendar conflict check failed with HTTP ${result.response.status}`
      );
    }
    if (!isObject(result.body) || typeof result.body.conflict !== "boolean") {
      throw new ControlPlaneError("UNAVAILABLE", "Calendar conflict response is malformed");
    }
    if (result.body.conflict) {
      throw new ControlPlaneError("CONFLICT", "Calendar provider reported an overlapping event");
    }
    return true;
  }

  async execute(
    request: AuthorizedBusinessActionRequest,
    context?: BusinessActionExecutionContext
  ) {
    const configuration = this.baseInput(request);
    const declaration = this.declaration(request);
    assertAdapterRequest(request, declaration, configuration);
    const credential = this.credential(request, configuration, context);
    const observedAt = this.now().toISOString();

    if (request.capability === "calendar.event.read") {
      const input = validateCapabilityInput<{
        companyId: string;
        connectionId: string;
        calendarId: string;
        eventId: string;
      }>("calendar.event.read", request.input);
      let result;
      try {
        result = await boundedRequest(
          this.fetchImpl,
          providerUrl(configuration, configuration.eventPath, {
            calendarId: input.calendarId,
            eventId: input.eventId
          }),
          {
            method: "GET",
            headers: calendarHeaders(request, credential),
            signal: AbortSignal.timeout(request.timeoutMs)
          },
          configuration.maxResponseBytes
        );
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
          observedAt
        });
      }
      if (!result.response.ok) {
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
      const event = normalizeProviderEvent(result.body, input.calendarId, observedAt);
      return createBusinessActionAdapterResult({
        source: "business-action-adapter",
        requestId: request.id,
        adapterId: this.id,
        adapterVersion: this.version,
        status: "completed",
        output: event,
        retryable: false,
        retryClass: "none",
        observedAt
      });
    }

    if (request.capability === "calendar.event.create") {
      const input = validateCapabilityInput<{
        companyId: string;
        connectionId: string;
        calendarId: string;
        title: string;
        description?: string;
        location?: string;
        startAt: string;
        endAt: string;
        timeZone: string;
        attendees: string[];
        conflictPolicy: "reject" | "allow";
      }>("calendar.event.create", request.input);
      if (!isIanaTimeZone(input.timeZone)) {
        throw new ControlPlaneError("VALIDATION_FAILED", "Calendar timeZone must be a valid IANA time zone");
      }
      const eventId = deterministicEventId(request);
      const conflictChecked = await this.conflictCheck(
        request,
        configuration,
        credential,
        { ...input, eventId }
      );
      const expected = eventExpectation({ ...input, eventId });
      const expectedHash = expectationHash(expected);
      const result = await boundedRequest(
        this.fetchImpl,
        providerUrl(configuration, configuration.calendarPath, {
          calendarId: input.calendarId
        }),
        {
          method: "POST",
          headers: calendarHeaders(request, credential, { contentType: true }),
          body: JSON.stringify(providerPayload({ ...input, eventId })),
          signal: AbortSignal.timeout(request.timeoutMs)
        },
        configuration.maxResponseBytes
      );
      if (result.response.status === 409) {
        const existing = await boundedRequest(
          this.fetchImpl,
          providerUrl(configuration, configuration.eventPath, {
            calendarId: input.calendarId,
            eventId
          }),
          {
            method: "GET",
            headers: calendarHeaders(request, credential),
            signal: AbortSignal.timeout(request.timeoutMs)
          },
          configuration.maxResponseBytes
        );
        if (!existing.response.ok) {
          return createBusinessActionAdapterResult({
            source: "business-action-adapter",
            requestId: request.id,
            adapterId: this.id,
            adapterVersion: this.version,
            status: "rejected",
            output: { conflict: true, eventId },
            retryable: false,
            retryClass: "provider-4xx",
            observedAt
          });
        }
        const normalized = normalizeProviderEvent(existing.body, input.calendarId, observedAt);
        if (verifiedEventHash(normalized) !== expectedHash) {
          return createBusinessActionAdapterResult({
            source: "business-action-adapter",
            requestId: request.id,
            adapterId: this.id,
            adapterVersion: this.version,
            status: "rejected",
            output: { conflict: true, eventId },
            retryable: false,
            retryClass: "provider-4xx",
            observedAt
          });
        }
      } else if (!result.response.ok) {
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

      let providerVersion: string | undefined;
      if (result.response.ok && Object.keys(result.body as object).length > 0) {
        providerVersion = normalizeProviderEvent(result.body, input.calendarId, observedAt).providerVersion;
      }
      const op = createOperationId({
        configurationId: configuration.id,
        capability: "calendar.event.create",
        calendarId: input.calendarId,
        eventId,
        expectationHash: expectedHash
      });
      return createBusinessActionAdapterResult({
        source: "business-action-adapter",
        requestId: request.id,
        adapterId: this.id,
        adapterVersion: this.version,
        status: "accepted",
        providerOperationId: op,
        output: {
          calendarId: input.calendarId,
          eventId,
          providerAccepted: true,
          providerVersion,
          conflictChecked,
          acceptedAt: observedAt
        },
        retryable: false,
        retryClass: "none",
        observedAt
      });
    }

    if (request.capability === "calendar.event.update") {
      const input = validateCapabilityInput<{
        companyId: string;
        connectionId: string;
        calendarId: string;
        eventId: string;
        expectedVersion: string;
        title: string;
        description?: string;
        location?: string;
        startAt: string;
        endAt: string;
        timeZone: string;
        attendees: string[];
        conflictPolicy: "reject" | "allow";
      }>("calendar.event.update", request.input);
      if (!isIanaTimeZone(input.timeZone)) {
        throw new ControlPlaneError("VALIDATION_FAILED", "Calendar timeZone must be a valid IANA time zone");
      }
      const conflictChecked = await this.conflictCheck(
        request,
        configuration,
        credential,
        input
      );
      const expected = eventExpectation(input);
      const expectedHash = expectationHash(expected);
      const result = await boundedRequest(
        this.fetchImpl,
        providerUrl(configuration, configuration.eventPath, {
          calendarId: input.calendarId,
          eventId: input.eventId
        }),
        {
          method: "PATCH",
          headers: calendarHeaders(request, credential, {
            contentType: true,
            expectedVersion: input.expectedVersion
          }),
          body: JSON.stringify(providerPayload(input)),
          signal: AbortSignal.timeout(request.timeoutMs)
        },
        configuration.maxResponseBytes
      );
      if (result.response.status === 409 || result.response.status === 412) {
        return createBusinessActionAdapterResult({
          source: "business-action-adapter",
          requestId: request.id,
          adapterId: this.id,
          adapterVersion: this.version,
          status: "rejected",
          output: {
            conflict: true,
            eventId: input.eventId,
            expectedVersion: input.expectedVersion
          },
          retryable: false,
          retryClass: "provider-4xx",
          observedAt
        });
      }
      if (!result.response.ok) {
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
      const providerVersion = Object.keys(result.body as object).length > 0
        ? normalizeProviderEvent(result.body, input.calendarId, observedAt).providerVersion
        : undefined;
      return createBusinessActionAdapterResult({
        source: "business-action-adapter",
        requestId: request.id,
        adapterId: this.id,
        adapterVersion: this.version,
        status: "accepted",
        providerOperationId: createOperationId({
          configurationId: configuration.id,
          capability: "calendar.event.update",
          calendarId: input.calendarId,
          eventId: input.eventId,
          expectationHash: expectedHash
        }),
        output: {
          calendarId: input.calendarId,
          eventId: input.eventId,
          providerAccepted: true,
          providerVersion,
          conflictChecked,
          acceptedAt: observedAt
        },
        retryable: false,
        retryClass: "none",
        observedAt
      });
    }

    const input = validateCapabilityInput<{
      companyId: string;
      connectionId: string;
      calendarId: string;
      eventId: string;
      expectedVersion: string;
      reason?: string;
    }>("calendar.event.cancel", request.input);
    const result = await boundedRequest(
      this.fetchImpl,
      providerUrl(configuration, configuration.eventPath, {
        calendarId: input.calendarId,
        eventId: input.eventId
      }),
      {
        method: "DELETE",
        headers: calendarHeaders(request, credential, {
          contentType: Boolean(input.reason),
          expectedVersion: input.expectedVersion
        }),
        ...(input.reason ? { body: JSON.stringify({ reason: input.reason }) } : {}),
        signal: AbortSignal.timeout(request.timeoutMs)
      },
      configuration.maxResponseBytes
    );
    if (result.response.status === 409 || result.response.status === 412) {
      return createBusinessActionAdapterResult({
        source: "business-action-adapter",
        requestId: request.id,
        adapterId: this.id,
        adapterVersion: this.version,
        status: "rejected",
        output: {
          conflict: true,
          eventId: input.eventId,
          expectedVersion: input.expectedVersion
        },
        retryable: false,
        retryClass: "provider-4xx",
        observedAt
      });
    }
    if (!result.response.ok) {
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
    return createBusinessActionAdapterResult({
      source: "business-action-adapter",
      requestId: request.id,
      adapterId: this.id,
      adapterVersion: this.version,
      status: "accepted",
      providerOperationId: createOperationId({
        configurationId: configuration.id,
        capability: "calendar.event.cancel",
        calendarId: input.calendarId,
        eventId: input.eventId,
        expectationHash: sha256Hex({
          calendarId: input.calendarId,
          eventId: input.eventId,
          status: "cancelled"
        })
      }),
      output: {
        calendarId: input.calendarId,
        eventId: input.eventId,
        providerAccepted: true,
        conflictChecked: false,
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
    const operation = parseOperationId(this.configurations, input.providerOperationId);
    const credential = requireBrokeredCredential(
      context,
      {
        providerId: operation.configuration.credentialProviderId,
        requiredScopes: operation.configuration.readScopes
      },
      operation.capability
    );
    const observedAt = this.now().toISOString();
    let result;
    try {
      result = await boundedRequest(
        this.fetchImpl,
        providerUrl(operation.configuration, operation.configuration.eventPath, {
          calendarId: operation.calendarId,
          eventId: operation.eventId
        }),
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
        observedAt
      });
    }

    let state: BusinessActionStatus["state"] = "running";
    if (operation.capability === "calendar.event.cancel") {
      if (result.response.status === 404) {
        state = "completed";
      } else if (!result.response.ok) {
        state = result.response.status >= 500 || result.response.status === 429
          ? "running"
          : "failed";
      } else {
        const event = normalizeProviderEvent(result.body, operation.calendarId, observedAt);
        state = event.status === "cancelled" ? "completed" : "running";
      }
    } else if (!result.response.ok) {
      state = result.response.status === 404
        || result.response.status === 408
        || result.response.status === 425
        || result.response.status === 429
        || result.response.status >= 500
        ? "running"
        : "failed";
    } else {
      const event = normalizeProviderEvent(result.body, operation.calendarId, observedAt);
      state = verifiedEventHash(event) === operation.expectationHash
        ? "completed"
        : "running";
    }

    return createBusinessActionStatus({
      source: "business-action-adapter",
      requestId: input.requestId,
      providerOperationId: input.providerOperationId,
      adapterId: this.id,
      adapterVersion: this.version,
      state,
      observedAt
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
    calendarPath: z.string().min(1),
    eventPath: z.string().min(1),
    conflictCheckPath: z.string().min(1).optional(),
    readScopes: z.array(z.string().min(1)).optional(),
    writeScopes: z.array(z.string().min(1)).optional(),
    maxResponseBytes: z.number().int().positive().optional()
  }).strict()).min(1).parse(parsed) as readonly CalendarProviderConfiguration[];
}
