import { describe, expect, it } from "vitest";
import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import type {
  AuthorizedBusinessActionRequest,
  BusinessActionExecutionContext
} from "@/lib/execution/adapters/business-action";
import {
  CalendarSchedulingAdapter,
  readCalendarProviderConfigurationsFromEnv
} from "@/lib/execution/adapters/calendar-scheduling";

const scope = {
  userId: "owner",
  portfolioId: "portfolio-a",
  companyId: "company-a",
  environment: "production" as const
};

const configuration = {
  id: "calendar-primary",
  companyId: "company-a",
  environment: "production" as const,
  credentialProviderId: "calendar-provider",
  baseUrl: "https://calendar.example.test/v1/",
  calendars: ["primary", "ops"],
  listPath: "calendars/{calendarId}/events",
  itemPath: "calendars/{calendarId}/events/{eventId}",
  readScopes: ["calendar.events.read"],
  writeScopes: ["calendar.events.write"],
  itemsPath: "items",
  idPath: "id",
  revisionPath: "etag",
  statusPath: "status",
  titlePath: "title",
  startPath: "start.dateTime",
  endPath: "end.dateTime",
  timeZonePath: "start.timeZone",
  attendeesPath: "attendees"
};

function action(capability: string, input: unknown): AuthorizedBusinessActionRequest {
  return {
    id: `action-${capability}`,
    jobId: `job-${capability}`,
    scope,
    capability,
    input,
    inputHash: sha256Hex(input),
    authorizationConsumptionHash: `consumption-${capability}`,
    credentialLeaseId: `lease-${capability}`,
    idempotencyKey: `idem-${capability}`,
    timeoutMs: 5_000,
    attempt: 1
  };
}

function context(capability: string, scopes?: readonly string[]): BusinessActionExecutionContext {
  return {
    credential: {
      leaseId: `lease-${capability}`,
      leaseHash: sha256Hex({ capability }),
      providerId: "calendar-provider",
      capability,
      grantedScopes: [...(scopes ?? ["calendar.events.write", "calendar.events.read"])],
      material: "short-lived-calendar-token",
      issuedAt: "2026-09-25T20:00:00Z",
      expiresAt: "2099-01-01T00:00:00Z"
    }
  };
}

function providerEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "event-1",
    etag: "rev-1",
    status: "confirmed",
    title: "Deployment review",
    start: {
      dateTime: "2026-11-03T18:00:00-08:00",
      timeZone: "America/Los_Angeles"
    },
    end: {
      dateTime: "2026-11-03T19:00:00-08:00",
      timeZone: "America/Los_Angeles"
    },
    attendees: [{ email: "owner@example.com" }],
    ...overrides
  };
}

describe("calendar scheduling adapter", () => {
  it("normalizes bounded calendar reads and validates timezone offsets", async () => {
    const adapter = new CalendarSchedulingAdapter([configuration], {
      now: () => new Date("2026-11-03T20:00:00Z"),
      fetchImpl: async (url) => {
        expect(String(url)).toContain("timeZone=America%2FLos_Angeles");
        return new Response(JSON.stringify({ items: [providerEvent()] }), { status: 200 });
      }
    });

    const request = action("calendar.event.read", {
      companyId: "company-a",
      connectionId: "calendar-primary",
      calendarId: "primary",
      timeMin: "2026-11-03T17:00:00-08:00",
      timeMax: "2026-11-03T20:00:00-08:00",
      timeZone: "America/Los_Angeles",
      maxResults: 100
    });

    await expect(adapter.execute(
      request,
      context("calendar.event.read", ["calendar.events.read"])
    )).resolves.toMatchObject({
      status: "completed",
      output: {
        calendarId: "primary",
        timeZone: "America/Los_Angeles",
        events: [{
          providerEventId: "event-1",
          startAt: "2026-11-04T02:00:00.000Z",
          endAt: "2026-11-04T03:00:00.000Z"
        }]
      },
      jobStateMutationApplied: false
    });

    await expect(adapter.execute(
      action("calendar.event.read", {
        companyId: "company-a",
        connectionId: "calendar-primary",
        calendarId: "primary",
        timeMin: "2026-11-03T17:00:00-07:00",
        timeMax: "2026-11-03T20:00:00-08:00",
        timeZone: "America/Los_Angeles",
        maxResults: 100
      }),
      context("calendar.event.read", ["calendar.events.read"])
    )).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });

  it("rejects create conflicts before mutation and sends deterministic idempotency metadata", async () => {
    const calls: { method: string; url: string; body?: unknown; headers?: HeadersInit }[] = [];
    const adapter = new CalendarSchedulingAdapter([configuration], {
      now: () => new Date("2026-11-03T20:00:00Z"),
      fetchImpl: async (url, init) => {
        calls.push({
          method: init?.method ?? "GET",
          url: String(url),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
          headers: init?.headers
        });
        return new Response(JSON.stringify({ items: [providerEvent()] }), { status: 200 });
      }
    });

    const result = await adapter.execute(
      action("calendar.event.create", {
        companyId: "company-a",
        connectionId: "calendar-primary",
        calendarId: "primary",
        title: "Conflicting meeting",
        startAt: "2026-11-03T18:30:00-08:00",
        endAt: "2026-11-03T19:30:00-08:00",
        timeZone: "America/Los_Angeles",
        attendees: [],
        busy: true,
        conflictPolicy: "reject"
      }),
      context("calendar.event.create")
    );
    expect(result).toMatchObject({
      status: "rejected",
      output: { conflict: true }
    });
    expect(calls).toHaveLength(1);

    const createAdapter = new CalendarSchedulingAdapter([configuration], {
      now: () => new Date("2026-11-03T20:00:00Z"),
      fetchImpl: async (url, init) => {
        if ((init?.method ?? "GET") === "GET") {
          return new Response(JSON.stringify({ items: [] }), { status: 200 });
        }
        const headers = init?.headers as Record<string, string>;
        expect(headers["idempotency-key"]).toBe("idem-calendar.event.create");
        return new Response(JSON.stringify(providerEvent({
          id: "event-created",
          title: "New meeting",
          start: { dateTime: "2026-11-03T20:00:00-08:00", timeZone: "America/Los_Angeles" },
          end: { dateTime: "2026-11-03T21:00:00-08:00", timeZone: "America/Los_Angeles" },
          attendees: []
        })), { status: 201 });
      }
    });

    await expect(createAdapter.execute(
      action("calendar.event.create", {
        companyId: "company-a",
        connectionId: "calendar-primary",
        calendarId: "primary",
        title: "New meeting",
        startAt: "2026-11-03T20:00:00-08:00",
        endAt: "2026-11-03T21:00:00-08:00",
        timeZone: "America/Los_Angeles",
        attendees: [],
        busy: true,
        conflictPolicy: "reject"
      }),
      context("calendar.event.create")
    )).resolves.toMatchObject({
      status: "accepted",
      output: {
        providerEventId: "event-created",
        operation: "create",
        providerAccepted: true
      },
      jobStateMutationApplied: false
    });
  });

  it("verifies create/update through provider reads and detects revision conflicts", async () => {
    let title = "New meeting";
    let revision = "rev-1";
    const adapter = new CalendarSchedulingAdapter([configuration], {
      now: () => new Date("2026-11-03T20:00:00Z"),
      fetchImpl: async (_url, init) => {
        if (init?.method === "PATCH") {
          title = "Updated meeting";
          revision = "rev-2";
          return new Response(JSON.stringify(providerEvent({
            id: "event-1",
            title,
            etag: revision
          })), { status: 200 });
        }
        return new Response(JSON.stringify(providerEvent({
          id: "event-1",
          title,
          etag: revision
        })), { status: 200 });
      }
    });

    const updateRequest = action("calendar.event.update", {
      companyId: "company-a",
      connectionId: "calendar-primary",
      calendarId: "primary",
      providerEventId: "event-1",
      expectedRevision: "rev-1",
      title: "Updated meeting",
      conflictPolicy: "allow"
    });
    const ctx = context("calendar.event.update");
    const accepted = await adapter.execute(updateRequest, ctx);
    expect(accepted.status).toBe("accepted");
    await expect(adapter.status({
      requestId: updateRequest.id,
      providerOperationId: accepted.providerOperationId!
    }, ctx)).resolves.toMatchObject({ state: "completed" });

    await expect(adapter.execute(
      action("calendar.event.update", {
        companyId: "company-a",
        connectionId: "calendar-primary",
        calendarId: "primary",
        providerEventId: "event-1",
        expectedRevision: "old-revision",
        title: "Should conflict",
        conflictPolicy: "allow"
      }),
      context("calendar.event.update")
    )).resolves.toMatchObject({
      status: "rejected",
      output: { conflict: true, reason: "revision-mismatch" }
    });
  });

  it("cancels with verification and accepts provider deletion as confirmed cancellation", async () => {
    let cancelled = false;
    const adapter = new CalendarSchedulingAdapter([configuration], {
      fetchImpl: async (_url, init) => {
        if (init?.method === "DELETE") {
          cancelled = true;
          return new Response("{}", { status: 204 });
        }
        if (cancelled) {
          return new Response("{}", { status: 404 });
        }
        return new Response(JSON.stringify(providerEvent()), { status: 200 });
      }
    });
    const request = action("calendar.event.cancel", {
      companyId: "company-a",
      connectionId: "calendar-primary",
      calendarId: "primary",
      providerEventId: "event-1",
      expectedRevision: "rev-1"
    });
    const ctx = context("calendar.event.cancel");
    const accepted = await adapter.execute(request, ctx);
    expect(accepted).toMatchObject({
      status: "accepted",
      output: { operation: "cancel", providerEventId: "event-1" }
    });
    await expect(adapter.status({
      requestId: request.id,
      providerOperationId: accepted.providerOperationId!
    }, ctx)).resolves.toMatchObject({ state: "completed" });
  });

  it("fails closed on calendar allowlist drift and unsafe provider config", async () => {
    const adapter = new CalendarSchedulingAdapter([configuration], {
      fetchImpl: async () => new Response("{}", { status: 200 })
    });
    await expect(adapter.execute(
      action("calendar.event.read", {
        companyId: "company-a",
        connectionId: "calendar-primary",
        calendarId: "other",
        timeMin: "2026-11-03T17:00:00-08:00",
        timeMax: "2026-11-03T20:00:00-08:00",
        timeZone: "America/Los_Angeles",
        maxResults: 10
      }),
      context("calendar.event.read", ["calendar.events.read"])
    )).rejects.toMatchObject({ code: "POLICY_BLOCKED" });

    expect(() => new CalendarSchedulingAdapter([{
      ...configuration,
      baseUrl: "http://calendar.example.test/"
    }])).toThrow(/HTTPS/i);
    expect(() => new CalendarSchedulingAdapter([{
      ...configuration,
      itemPath: "calendars/{calendarId}/events/static"
    }])).toThrow(/eventId/i);
  });

  it("parses strict server-only configuration", () => {
    const env = { GETDONE_CALENDAR_ACTIONS_JSON: JSON.stringify([configuration]) };
    expect(readCalendarProviderConfigurationsFromEnv(env)).toHaveLength(1);
    expect(() => readCalendarProviderConfigurationsFromEnv({
      GETDONE_CALENDAR_ACTIONS_JSON: JSON.stringify([{
        ...configuration,
        rawToken: "secret"
      }])
    })).toThrow();
  });
});
