import "server-only";
import { authorizeRequest } from "@/lib/auth/guard";
import { PostgresAuthAdapter } from "@/lib/auth/postgres-adapter";
import { readWebAuthnServerConfig } from "@/lib/auth/webauthn-config";
import { developmentSeedAllowed } from "@/lib/control-plane/runtime-environment";
import { getPostgresRuntimeFromEnv } from "@/lib/persistence/postgres/runtime.server";
import { listBusinesses, readBusinessContext, withBusinessActivity } from "./repository";

export function isBusinessPreview() {
  return developmentSeedAllowed({ runtimeEnvironment: process.env.GETDONE_RUNTIME_ENV, dataMode: process.env.GETDONE_DATA_MODE });
}
export async function businessSession(request: Request) {
  const db = getPostgresRuntimeFromEnv().database;
  const { session } = await authorizeRequest(new PostgresAuthAdapter(db, { cookieName: readWebAuthnServerConfig().cookieName }), request);
  return { db, session };
}
export async function getBusinessCatalog(request: Request, activity = false) {
  if (isBusinessPreview()) return [];
  const { db, session } = await businessSession(request);
  const businesses = await listBusinesses(db, session.userId);
  return activity ? withBusinessActivity(db, businesses, process.env.GETDONE_RUNTIME_ENV!) : businesses;
}
export async function getBusinessContext(request: Request, portfolioId: string) {
  const { db, session } = await businessSession(request);
  return readBusinessContext(db, session.userId, portfolioId, process.env.GETDONE_RUNTIME_ENV!);
}
