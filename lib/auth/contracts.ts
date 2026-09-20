export interface AuthSession {
  sessionId: string;
  userId: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt?: string;
  authenticatedAt: string;
  stepUpAuthenticatedAt?: string;
}

export interface StepUpChallenge {
  challengeId: string;
  expiresAt: string;
  method: "passkey" | "provider";
}

export interface AuthAdapter {
  getSession(request: Request): Promise<AuthSession | null>;
  revokeSession(sessionId: string): Promise<void>;
  beginStepUp(session: AuthSession): Promise<StepUpChallenge>;
  verifyStepUp(challengeId: string, response: unknown): Promise<AuthSession>;
}

export interface PasskeyDescriptor {
  credentialId: string;
  userId: string;
  createdAt: string;
  lastUsedAt?: string;
}

export type AuthRequirement = "session" | "fresh-step-up";
