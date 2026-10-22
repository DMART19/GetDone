/**
 * Advisory reasoning roles share the existing AI Gateway. These profiles do not
 * confer credentials, execution authority, budget changes, or verification trust.
 */
export const REASONING_ROLES = ["strategist", "researcher", "planner", "optimizer"] as const;
export type ReasoningRole = typeof REASONING_ROLES[number];
export interface RoleRequest {
  role: ReasoningRole;
  purpose: string;
  mayRequestEvidence: boolean;
  mayProposePlan: boolean;
  mayExecute: false;
  mayAuthorize: false;
  mayVerifyOutcome: false;
}
const abilities: Record<ReasoningRole, { mayRequestEvidence: boolean; mayProposePlan: boolean }> = {
  strategist: { mayRequestEvidence: true, mayProposePlan: true },
  researcher: { mayRequestEvidence: true, mayProposePlan: false },
  planner: { mayRequestEvidence: true, mayProposePlan: true },
  optimizer: { mayRequestEvidence: true, mayProposePlan: true }
};
export function reasoningRoleRequest(role: ReasoningRole, purpose: string): RoleRequest {
  if (!purpose.trim() || purpose.length > 2000 || !(role in abilities)) {
    throw new Error("Invalid reasoning role request");
  }
  return Object.freeze({ role, purpose: purpose.trim(), ...abilities[role],
    mayExecute: false, mayAuthorize: false, mayVerifyOutcome: false });
}
