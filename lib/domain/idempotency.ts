import { ControlPlaneError } from "@/lib/control-plane/errors";

export type IdempotencyRecordStatus = "IN_PROGRESS" | "COMPLETED" | "FAILED";
export type IdempotencyClaimState = "CREATED" | "IN_PROGRESS" | "COMPLETED" | "FAILED" | "CONFLICT";

export interface IdempotencyRecord<T = unknown> {
  key: string;
  fingerprint: string;
  status: IdempotencyRecordStatus;
  createdAt: string;
  completedAt?: string;
  failedAt?: string;
  result?: T;
  errorCode?: string;
}

export interface IdempotencyClaim<T = unknown> {
  state: IdempotencyClaimState;
  record: IdempotencyRecord<T>;
}

export interface IdempotencyStore {
  /**
   * Durable implementations MUST implement this as one atomic insert-or-read
   * operation backed by a unique key.
   */
  claim<T = unknown>(key: string, fingerprint: string, createdAt: string): Promise<IdempotencyClaim<T>>;
  complete<T = unknown>(key: string, fingerprint: string, result: T, completedAt: string): Promise<IdempotencyRecord<T>>;
  fail(key: string, fingerprint: string, errorCode: string, failedAt: string): Promise<IdempotencyRecord>;
  get<T = unknown>(key: string): Promise<IdempotencyRecord<T> | null>;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();

  async claim<T = unknown>(key: string, fingerprint: string, createdAt: string): Promise<IdempotencyClaim<T>> {
    const existing = this.records.get(key) as IdempotencyRecord<T> | undefined;
    if (existing) {
      if (existing.fingerprint !== fingerprint) return { state: "CONFLICT", record: existing };
      return { state: existing.status, record: existing };
    }

    const record: IdempotencyRecord<T> = {
      key,
      fingerprint,
      status: "IN_PROGRESS",
      createdAt
    };
    this.records.set(key, record);
    return { state: "CREATED", record };
  }

  async complete<T = unknown>(key: string, fingerprint: string, result: T, completedAt: string) {
    const existing = this.records.get(key);
    if (!existing || existing.fingerprint !== fingerprint) {
      throw new ControlPlaneError("IDEMPOTENCY_CONFLICT", "Cannot complete an unclaimed or mismatched idempotency record");
    }
    const next: IdempotencyRecord<T> = {
      ...existing,
      status: "COMPLETED",
      completedAt,
      result
    };
    this.records.set(key, next);
    return next;
  }

  async fail(key: string, fingerprint: string, errorCode: string, failedAt: string) {
    const existing = this.records.get(key);
    if (!existing || existing.fingerprint !== fingerprint) {
      throw new ControlPlaneError("IDEMPOTENCY_CONFLICT", "Cannot fail an unclaimed or mismatched idempotency record");
    }
    const next: IdempotencyRecord = {
      ...existing,
      status: "FAILED",
      failedAt,
      errorCode
    };
    this.records.set(key, next);
    return next;
  }

  async get<T = unknown>(key: string) {
    return (this.records.get(key) as IdempotencyRecord<T> | undefined) ?? null;
  }
}

export async function claimIdempotency<T = unknown>(
  store: IdempotencyStore,
  key: string,
  fingerprint: string,
  now = new Date()
): Promise<IdempotencyClaim<T>> {
  const claim = await store.claim<T>(key, fingerprint, now.toISOString());
  if (claim.state === "CONFLICT") {
    throw new ControlPlaneError("IDEMPOTENCY_CONFLICT", "Idempotency key was reused for a different request");
  }
  return claim;
}
