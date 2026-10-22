import type { PlannerInputEnvelope } from "@/lib/orchestration/planning-flow";
import { isContextItemFresh } from "@/lib/intelligence/context";
import { reasoningRoleRequest, type ReasoningRole } from "@/lib/operations/reasoning-roles";

/**
 * Structured advisory handoffs inside the existing single AI Gateway planning call.
 * No additional models, worker services, tools, approvals, or execution authority.
 * Authority remains with the deterministic coordinator and verification system.
 */
export interface ReasoningHandoff {
  readonly role: ReasoningRole;
  readonly purpose: string;
  readonly contextIds: readonly string[];
  readonly mayExecute: false;
  readonly mayAuthorize: false;
  readonly mayVerifyOutcome: false;
}
export function boundedReasoningHandoffs(
  input: PlannerInputEnvelope,
  options: { maxHandoffs?: number; now?: number } = {}
): readonly ReasoningHandoff[] {
  const maxHandoffs = Math.min(3, Math.max(0, Math.floor(options.maxHandoffs ?? 3)));
  const now = options.now ?? Date.parse(input.createdAt);
  const contextIds = input.context.items
    .filter(item => item.portfolioId === input.scope.portfolioId
      && (!input.scope.companyId || item.companyId === input.scope.companyId)
      && isContextItemFresh(item, now))
    .slice(0, 12).map(item => item.id);
  const roles: readonly ReasoningRole[] = ["researcher", "strategist", "planner"];
  return Object.freeze(roles.slice(0, maxHandoffs).map(role => {
    const request = reasoningRoleRequest(role, role === "researcher"
      ? "Identify evidence gaps. Never invent facts or access external resources."
      : role === "strategist"
        ? "Select the measurable objective and safe strategy using provided evidence."
        : "Construct a dependency-aware proposed plan; approval and execution are separate.");
    return Object.freeze({
      role, purpose: request.purpose, contextIds: Object.freeze([...contextIds]),
      mayExecute: false as const, mayAuthorize: false as const, mayVerifyOutcome: false as const
    });
  }));
}
