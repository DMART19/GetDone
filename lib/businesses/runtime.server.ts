import "server-only";
import { authorizeRequest } from "@/lib/auth/guard";
import { PostgresAuthAdapter } from "@/lib/auth/postgres-adapter";
import { readWebAuthnServerConfig } from "@/lib/auth/webauthn-config";
import { developmentSeedAllowed } from "@/lib/control-plane/runtime-environment";
import { getPostgresRuntimeFromEnv } from "@/lib/persistence/postgres/runtime.server";
import { getAuthPostgresDatabaseFromEnv } from "@/lib/persistence/postgres/auth-runtime.server";
import { listBusinesses, readBusinessContext, withBusinessActivity } from "./repository";
import { portfolioAttentionOverview } from "./portfolio-attention";

export function isBusinessPreview() {
  return developmentSeedAllowed({ runtimeEnvironment: process.env.GETDONE_RUNTIME_ENV, dataMode: process.env.GETDONE_DATA_MODE });
}
export async function businessSession(request: Request) {
  // A session exists before we know its business/tenant. The tenant-runtime
  // role intentionally cannot read unscoped auth tables under RLS.
  const authDb = getAuthPostgresDatabaseFromEnv();
  const { session } = await authorizeRequest(
    new PostgresAuthAdapter(authDb, { cookieName: readWebAuthnServerConfig().cookieName }),
    request
  );
  return { db: getPostgresRuntimeFromEnv().database, authDb, session };
}
export async function getBusinessCatalog(request: Request, activity = false) {
  if (isBusinessPreview()) return [];
  const { db, authDb, session } = await businessSession(request);
  const businesses = await listBusinesses(authDb, session.userId);
  return activity ? withBusinessActivity(db, businesses, process.env.GETDONE_RUNTIME_ENV!) : businesses;
}
export async function getBusinessContext(request: Request, portfolioId: string) {
  const { db, authDb, session } = await businessSession(request);
  return readBusinessContext(db, session.userId, portfolioId, process.env.GETDONE_RUNTIME_ENV!, authDb);
}

/** Authenticates once, then reads each company under its own tenant scope. */
export async function getPortfolioAttention(request: Request) {
  if (isBusinessPreview()) return portfolioAttentionOverview([], { totalBusinesses: 0 });
  const { db, authDb, session } = await businessSession(request);
  const businesses = await listBusinesses(authDb, session.userId);
  const selected = businesses.slice(0, 12);
  const contexts = [];
  for (const business of selected) {
    contexts.push(await readBusinessContext(db, session.userId, business.portfolioId,
      process.env.GETDONE_RUNTIME_ENV!, authDb));
  }
  return portfolioAttentionOverview(contexts, { totalBusinesses: businesses.length });
}
