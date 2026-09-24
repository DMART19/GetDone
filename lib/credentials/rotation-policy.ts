export type RotationProvider = "gmail" | "slack" | "openrouter" | "configured-https" | "webhook";
export type CredentialJobPhase = "queued" | "claimed" | "accepted" | "verification-pending";
export type CredentialVersionSelection = "latest-active" | "not-applicable";

export interface CredentialRotationDecision {
  provider: RotationProvider;
  phase: CredentialJobPhase;
  selection: CredentialVersionSelection;
  preservesProviderOperationId: boolean;
  reason: string;
}

export function credentialRotationDecision(
  provider: RotationProvider,
  phase: CredentialJobPhase
): CredentialRotationDecision {
  if (provider === "openrouter" && (phase === "accepted" || phase === "verification-pending")) {
    return Object.freeze({
      provider,
      phase,
      selection: "not-applicable",
      preservesProviderOperationId: false,
      reason: "OpenRouter model calls are synchronous in GetDone and do not persist an accepted provider operation for later verification."
    });
  }

  const postAcceptance = phase === "accepted" || phase === "verification-pending";
  return Object.freeze({
    provider,
    phase,
    selection: "latest-active",
    preservesProviderOperationId: postAcceptance,
    reason: postAcceptance
      ? "Resume keeps the persisted provider operation identity but redeems the latest active credential version for status/verification/cancellation."
      : "No provider operation has been accepted yet, so the next provider call redeems the latest active credential version."
  });
}

export const CREDENTIAL_ROTATION_MATRIX = Object.freeze(
  (["gmail", "slack", "openrouter", "configured-https", "webhook"] as const)
    .flatMap((provider) => (
      (["queued", "claimed", "accepted", "verification-pending"] as const)
        .map((phase) => credentialRotationDecision(provider, phase))
    ))
);
