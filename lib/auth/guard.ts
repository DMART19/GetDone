import type { AuthAdapter, AuthRequirement, AuthSession } from "@/lib/auth/contracts";
import { requireActiveSession, requireFreshStepUp } from "@/lib/auth/session";

export interface AuthorizedRequest {
  session: AuthSession;
  requirement: AuthRequirement;
}

export async function authorizeRequest(
  adapter: AuthAdapter,
  request: Request,
  requirement: AuthRequirement = "session"
): Promise<AuthorizedRequest> {
  const session = requireActiveSession(await adapter.getSession(request));

  if (requirement === "fresh-step-up") {
    requireFreshStepUp(session);
  }

  return { session, requirement };
}
