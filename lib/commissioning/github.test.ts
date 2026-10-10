import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";
import type { PostgresTransactionalDatabase } from "@/lib/persistence/postgres/client";
import { commissionGithub } from "./github";
const env = {
  GETDONE_RUNTIME_ENV: "production", GETDONE_OWNER_USER_ID: "owner", GETDONE_OWNER_COMPANY_ID: "company", GETDONE_OWNER_PORTFOLIO_ID: "portfolio",
  GETDONE_GITHUB_APP_ID: "123", GETDONE_GITHUB_INSTALLATION_ID: "456", GETDONE_GITHUB_CREDENTIAL_PROVIDER_ID: "provider",
  GETDONE_GITHUB_CREDENTIAL_RESOURCE_IDS_JSON: '["worker"]',
  GETDONE_GITHUB_APP_PRIVATE_KEY_PEM: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  GETDONE_GITHUB_ACTIONS_JSON: JSON.stringify([{ id: "connection", companyId: "company", environment: "production", credentialProviderId: "provider", repositories: ["DMART19/GetDone"], protectedBranches: ["main"] }])
};
function fixture() {
  let record: unknown;
  const resource = { id: "worker", companyId: "company", portfolioId: "portfolio", state: "ready", trustClass: "production-eligible",
    environmentPermissions: ["production"], credentialBindingIds: ["github-binding:provider"], capabilityNames: ["github.repository.read", "github.branch.create", "github.commit.create", "github.pull-request.write", "github.issue.write"] };
  const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
    if (sql.includes("portfolio_memberships")) return { rows: [{}], rowCount: 1 };
    if (sql.includes("entity_type='resource'")) return { rows: [{ payload: resource }], rowCount: 1 };
    if (sql.includes("entity_type='integration'")) return { rows: record ? [{ payload: record }] : [], rowCount: record ? 1 : 0 };
    if (sql.includes("INSERT INTO control_plane_entities")) { record = JSON.parse(String(values?.[4])); return { rows: [], rowCount: 1 }; }
    if (sql.includes("getdone_append_audit_event")) return { rows: [{ chain_sequence: 1, event_hash: "hash" }], rowCount: 1 };
    throw new Error("Unexpected commissioning SQL");
  });
  const db = { query, transaction: async <T>(operation: (client: PoolClient) => Promise<T>) => operation({ query } as unknown as PoolClient) } as unknown as PostgresTransactionalDatabase;
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ id: 456, app_id: 123, suspended_at: null, permissions: { contents: "write", issues: "write", pull_requests: "write" } }));
  return { db, query, fetcher, resource };
}
describe("operator GitHub commissioning", () => {
  it("checks without writes by default and never requests installation tokens", async () => {
    const f = fixture(); expect((await commissionGithub(f.db, env, false, f.fetcher)).status).toBe("ready-to-configure");
    expect(f.query.mock.calls.some(([sql]) => sql.includes("INSERT"))).toBe(false);
    expect(f.fetcher.mock.calls.map(([url]) => url)).toEqual(["https://api.github.com/repos/DMART19/GetDone/installation"]);
  });
  it("creates an audited binding once and accepts a matching repeat", async () => {
    const f = fixture(); expect((await commissionGithub(f.db, env, true, f.fetcher)).status).toBe("configured");
    expect((await commissionGithub(f.db, env, true, f.fetcher)).status).toBe("already-configured");
    expect(f.query.mock.calls.filter(([sql]) => sql.includes("INSERT INTO control_plane_entities"))).toHaveLength(1);
    const sql = JSON.stringify(f.query.mock.calls); expect(sql).toContain("integration.commissioned"); expect(sql).not.toContain("PRIVATE KEY");
  });
  it("refuses unavailable resources and writes no integration", async () => {
    const f = fixture(); f.resource.state = "discovered";
    await expect(commissionGithub(f.db, env, true, f.fetcher)).rejects.toThrow(/governed enrollment/);
    expect(f.query.mock.calls.some(([sql]) => sql.includes("INSERT"))).toBe(false);
  });
  it("rejects a different, suspended, or underprivileged App installation", async () => {
    for (const change of [{ app_id: 999 }, { suspended_at: new Date().toISOString() }, { permissions: { contents: "read" } }]) {
      const f = fixture(); f.fetcher.mockResolvedValue(Response.json({ id: 456, app_id: 123, suspended_at: null, permissions: { contents: "write", issues: "write", pull_requests: "write" }, ...change }));
      await expect(commissionGithub(f.db, env, true, f.fetcher)).rejects.toThrow(/identity, status, or required permissions/);
      expect(f.query).not.toHaveBeenCalled();
    }
  });
  it("refuses non-production invocation before network access", async () => {
    const f = fixture(); await expect(commissionGithub(f.db, { ...env, GETDONE_RUNTIME_ENV: "staging" }, true, f.fetcher)).rejects.toThrow(/production configuration/);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});
