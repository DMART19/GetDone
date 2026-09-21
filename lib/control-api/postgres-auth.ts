import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import type { AuthSession } from "@/lib/auth/contracts";
import { createStepUpProof, type StepUpProof } from "@/lib/authorization/proofs";
import { hasFreshStepUp } from "@/lib/auth/session";
import type {
  ControlApiAuthorizationEvidenceResolver,
  ControlApiScopeResolver
} from "@/lib/control-api/service-adapter";
import type { ControlApiRole } from "@/lib/control-api/contracts";
import type { SqlQueryable } from "@/lib/persistence/postgres/client";

interface MembershipRow {
  portfolio_id: string;
  company_id: string;
  role: ControlApiRole;
}

export class PostgresControlApiScopeResolver implements ControlApiScopeResolver {
  constructor(
    private readonly db: SqlQueryable,
    private readonly environment: TrustedExecutionScope["environment"]
  ) {}

  async resolve(session: AuthSession, request: Request) {
    const requestedPortfolio = request.headers.get("x-getdone-portfolio-id")?.trim();
    const values: unknown[] = [session.userId];
    let portfolioFilter = "";
    if (requestedPortfolio) {
      values.push(requestedPortfolio);
      portfolioFilter = "AND pm.portfolio_id=$2";
    }

    const result = await this.db.query<MembershipRow>(
      `SELECT pm.portfolio_id,pm.company_id,pm.role
       FROM portfolio_memberships pm
       JOIN portfolios p ON p.id=pm.portfolio_id
       JOIN organization_memberships om
         ON om.organization_id=p.organization_id AND om.user_id=pm.user_id
       WHERE pm.user_id=$1
         AND pm.status='active'
         AND om.status='active'
         ${portfolioFilter}
       ORDER BY pm.portfolio_id`,
      values
    );

    if (result.rows.length === 0) {
      throw new ControlPlaneError("FORBIDDEN", "User has no active membership for the requested portfolio");
    }
    if (!requestedPortfolio && result.rows.length !== 1) {
      throw new ControlPlaneError(
        "VALIDATION_FAILED",
        "X-GetDone-Portfolio-Id is required when the user belongs to multiple portfolios"
      );
    }

    const membership = result.rows[0];
    return {
      scope: Object.freeze({
        userId: session.userId,
        portfolioId: membership.portfolio_id,
        companyId: membership.company_id,
        environment: this.environment
      }),
      role: membership.role
    };
  }
}

export class SessionStepUpEvidenceResolver
  implements ControlApiAuthorizationEvidenceResolver {
  constructor(
    private readonly now: () => Date = () => new Date(),
    private readonly maxAgeMs = 5 * 60_000
  ) {}

  async resolveStepUpProof(
    session: AuthSession,
    _request: Request,
    scope: TrustedExecutionScope
  ): Promise<StepUpProof | undefined> {
    const now = this.now();
    if (!hasFreshStepUp(session, this.maxAgeMs, now.getTime())) return undefined;
    const authenticatedAt = session.stepUpAuthenticatedAt!;
    return createStepUpProof({
      id: `session-step-up:${session.sessionId}:${authenticatedAt}`,
      actorId: session.userId,
      scope,
      method: "provider",
      authenticatedAt,
      expiresAt: new Date(Date.parse(authenticatedAt) + this.maxAgeMs).toISOString()
    });
  }
}
