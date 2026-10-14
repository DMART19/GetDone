import type { SqlQueryable } from "@/lib/persistence/postgres/client";
import { runWithPostgresTenantScope } from "@/lib/persistence/postgres/tenant-context.server";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { Business, BusinessContext, BusinessSection } from "./contracts";

/** Catalog access mirrors the Control API's three active membership checks. */
export async function listBusinesses(db: SqlQueryable, userId: string): Promise<Business[]> {
  const result = await db.query<{ id: string; portfolio_id: string; name: string; role: string }>(`
    SELECT c.id, p.id AS portfolio_id, c.name, pm.role
    FROM portfolio_memberships pm
    JOIN portfolios p ON p.id=pm.portfolio_id AND p.company_id=pm.company_id
    JOIN companies c ON c.id=pm.company_id AND c.organization_id=p.organization_id
    JOIN organization_memberships om ON om.organization_id=p.organization_id AND om.user_id=pm.user_id
    JOIN company_memberships cm ON cm.company_id=c.id AND cm.user_id=pm.user_id
    WHERE pm.user_id=$1 AND pm.status='active' AND om.status='active' AND cm.status='active'
    ORDER BY c.name, c.id`, [userId]);
  return result.rows.map(row => ({ id: row.id, portfolioId: row.portfolio_id, name: row.name, role: row.role }));
}

export async function readBusinessContext(db: SqlQueryable, userId: string, portfolioId: string, environment: string): Promise<BusinessContext> {
  // Never use a caller-supplied company ID or a client-side selection as authorization.
  const business = (await listBusinesses(db, userId)).find(item => item.portfolioId === portfolioId);
  if (!business) throw new ControlPlaneError("FORBIDDEN", "No active membership for this business");
  return runWithPostgresTenantScope({ portfolioId: business.portfolioId, companyId: business.id }, async () => {
    const sections: BusinessContext["sections"] = {
      objectives: { records: [] }, integrations: { records: [] },
      signals: { records: [], note: "A persistent signal feed is not connected to this view yet. No signal health is inferred." },
      decisions: { records: [] }, jobs: { records: [] }, outcomes: { records: [] }
    };
    const kinds = { objectives: "objective", integrations: "integration", decisions: "decision", jobs: "job", outcomes: "outcome" } as const;
    for (const [section, kind] of Object.entries(kinds)) {
      // Select an explicit presentation allowlist; bindings, metadata and credentials never leave the server.
      const result = await db.query<{ id: string; title: string; status: string; updated_at: Date | string }>(`
        SELECT id, COALESCE(payload->>'normalizedGoal', payload->>'displayName', payload->>'title', payload->>'metric', id) AS title,
          COALESCE(payload->>'status', payload->>'state', 'unknown') AS status, updated_at
        FROM control_plane_entities
        WHERE portfolio_id=$1 AND company_id=$2 AND entity_type=$3
          AND (payload->>'environment'=$4 OR ($3 IN ('decision','job','outcome') AND NOT payload ? 'environment'))
        ORDER BY updated_at DESC, id LIMIT 20`, [business.portfolioId, business.id, kind, environment]);
      sections[section as BusinessSection] = {
        records: result.rows.map(row => ({ id: row.id, title: row.title, status: row.status,
          updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at })),
        note: "Most recent 20 records."
      };
    }
    return { business, sections };
  });
}

export async function withBusinessActivity(db: SqlQueryable, businesses: Business[], environment: string): Promise<Business[]> {
  const result: Business[] = [];
  for (const business of businesses) {
    const lastActivityAt = await runWithPostgresTenantScope({ portfolioId: business.portfolioId, companyId: business.id }, async () => {
      const activity = await db.query<{ last_activity_at: Date | string | null }>(`
        SELECT MAX(updated_at) AS last_activity_at FROM control_plane_entities
        WHERE portfolio_id=$1 AND company_id=$2
          AND entity_type IN ('objective','integration','decision','job','outcome')
          AND (payload->>'environment'=$3 OR (entity_type IN ('decision','job','outcome') AND NOT payload ? 'environment'))`,
      [business.portfolioId, business.id, environment]);
      const value = activity.rows[0]?.last_activity_at;
      return value instanceof Date ? value.toISOString() : value ?? undefined;
    });
    result.push({ ...business, ...(lastActivityAt ? { lastActivityAt } : {}) });
  }
  return result;
}
