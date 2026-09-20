import { ControlPlaneError } from "@/lib/control-plane/errors";

export interface IdempotencyRecord<T = unknown> {
  key: string;
  fingerprint: string;
  status: "in-progress" | "completed" | "failed";
  createdAt: string;
  completedAt?: string;
  result?: T;
}

export interface IdempotencyStore {
  get<T = unknown>(key: string): Promise<IdempotencyRecord<T> | null>;
  put<T = unknown>(record: IdempotencyRecord<T>): Promise<void>;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, IdempotencyRecord>();

  async get<T = unknown>(key: string) {
    return (this.records.get(key) as IdempotencyRecord<T> | undefined) ?? null;
  }

  async put<T = unknown>(record: IdempotencyRecord<T>) {
    this.records.set(record.key, record);
  }
}

export async function claimIdempotency(
  store: IdempotencyStore,
  key: string,
  fingerprint: string
) {
  const existing = await store.get(key);
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      throw new ControlPlaneError("IDEMPOTENCY_CONFLICT", "Idempotency key was reused for a different request");
    }
    return { record: existing, isNew: false as const };
  }

  const record: IdempotencyRecord = {
    key,
    fingerprint,
    status: "in-progress",
    createdAt: new Date().toISOString()
  };
  await store.put(record);
  return { record, isNew: true as const };
}
