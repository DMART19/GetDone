import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => {
  const authDb = { query: vi.fn() };
  const tenantDb = { query: vi.fn(), transaction: vi.fn() };
  return {
    authDb, tenantDb,
    authAdapterConnection: vi.fn(),
    listBusinesses: vi.fn(),
    withBusinessActivity: vi.fn(),
    readBusinessContext: vi.fn()
  };
});

// Vitest does not bundle Next.js server-only marker; mock the marker, not the boundary.\nvi.mock("server-only", () => ({}));\n\nvi.mock("@/lib/persistence/postgres/auth-runtime.server", () => ({
  getAuthPostgresDatabaseFromEnv: () => fixture.authDb
}));
vi.mock("@/lib/persistence/postgres/runtime.server", () => ({
  getPostgresRuntimeFromEnv: () => ({ database: fixture.tenantDb })
}));
vi.mock("@/lib/auth/postgres-adapter", () => ({
  PostgresAuthAdapter: class {
    constructor(db: unknown) { fixture.authAdapterConnection(db); }
    async getSession() {
      return {
        userId: "owner-a", sessionId: "s-a",
        issuedAt: "2026-10-17T00:00:00.000Z",
        authenticatedAt: "2026-10-17T00:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z"
      };
    }
  }
}));
vi.mock("@/lib/auth/webauthn-config", () => ({
  readWebAuthnServerConfig: () => ({ cookieName: "getdone_session" })
}));
vi.mock("@/lib/control-plane/runtime-environment", () => ({
  developmentSeedAllowed: () => false
}));
vi.mock("./repository", () => ({
  listBusinesses: fixture.listBusinesses,
  withBusinessActivity: fixture.withBusinessActivity,
  readBusinessContext: fixture.readBusinessContext
}));

import { businessSession, getBusinessCatalog, getBusinessContext } from "./runtime.server";

const request = () => new Request("https://getdone-web-staging.onrender.com/api/businesses", {
  headers: { cookie: "getdone_session=private-test-placeholder" }
});

beforeEach(() => {
  vi.clearAllMocks();
  fixture.listBusinesses.mockResolvedValue([{ id: "c-a", portfolioId: "p-a", name: "Acme" }]);
  fixture.withBusinessActivity.mockResolvedValue([{ id: "c-a", portfolioId: "p-a", name: "Acme", lastActivityAt: "2026-10-17T00:00:00Z" }]);
  fixture.readBusinessContext.mockResolvedValue({ business: { id: "c-a", portfolioId: "p-a" }, sections: {} });
});

describe("business API pre-tenant authentication boundary", () => {
  it("authenticates using only the restricted identity role, leaving the tenant database for business data", async () => {
    const result = await businessSession(request());
    expect(fixture.authAdapterConnection).toHaveBeenCalledWith(fixture.authDb);
    expect(result).toMatchObject({ db: fixture.tenantDb, authDb: fixture.authDb, session: { userId: "owner-a" } });
    expect(fixture.authAdapterConnection).not.toHaveBeenCalledWith(fixture.tenantDb);
  });

  it("lists only owner memberships from the authentication pool and scopes activity to the tenant pool", async () => {
    const result = await getBusinessCatalog(request(), true);
    expect(fixture.listBusinesses).toHaveBeenCalledWith(fixture.authDb, "owner-a");
    expect(fixture.withBusinessActivity).toHaveBeenCalledWith(fixture.tenantDb,
      [{ id: "c-a", portfolioId: "p-a", name: "Acme" }], process.env.GETDONE_RUNTIME_ENV);
    expect(result).toHaveLength(1);
    expect(fixture.listBusinesses).not.toHaveBeenCalledWith(fixture.tenantDb, "owner-a");
  });

  it("resolves the requested portfolio with pre-tenant membership access before reading tenant-scoped context", async () => {
    await getBusinessContext(request(), "p-a");
    expect(fixture.readBusinessContext).toHaveBeenCalledWith(
      fixture.tenantDb, "owner-a", "p-a", process.env.GETDONE_RUNTIME_ENV, fixture.authDb
    );
  });
});
