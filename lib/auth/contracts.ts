export interface AuthSession {
  sessionId: string;
  userId: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt?: string;
  authenticatedAt: string;
  stepUpAuthenticatedAt?: string;
}

export interface AuthSessionCredential {
  session: AuthSession;
  token: string;
}

export interface StepUpChallenge {
  challengeId: string;
  expiresAt: string;
  method: "passkey";
  challenge: string;
  rpId: string;
  allowCredentialIds: readonly string[];
  userVerification: "required";
}

export interface AuthAdapter {
  getSession(request: Request): Promise<AuthSession | null>;
  revokeSession(sessionId: string): Promise<void>;
  revokeOtherSessions(userId: string, currentSessionId: string): Promise<number>;
  beginStepUp(session: AuthSession): Promise<StepUpChallenge>;
  verifyStepUp(
    session: AuthSession,
    challengeId: string,
    response: unknown
  ): Promise<AuthSessionCredential>;
}

export interface PasskeyDescriptor {
  credentialId: string;
  userId: string;
  createdAt: string;
  lastUsedAt?: string;
}

export type AuthRequirement = "session" | "fresh-step-up";
