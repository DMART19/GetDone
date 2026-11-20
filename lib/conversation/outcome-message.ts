/** Owner-facing descriptions must never imply provider success is verified success. */
export function ownerOutcomeMessage(input: {
  label: string;
  verified: boolean;
  terminal: boolean;
  verificationRefs?: readonly string[];
}): string {
  if (input.verified && (input.verificationRefs?.length ?? 0) > 0) {
    return `${input.label}. The result was independently verified.`;
  }
  if (input.verified) {
    return `${input.label}. Verification was reported, but no receipt is available here.`;
  }
  if (input.terminal) {
    return `${input.label}. This work ended without a verified outcome; review the reason before retrying.`;
  }
  return `${input.label}. Work is still in progress; no verified completion has been established.`;
}
