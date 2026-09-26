import { ControlPlaneError } from "@/lib/control-plane/errors";

const DEFAULT_READ_TIMEOUT_MS = 30_000;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 50_000;
const MAX_JSON_STRING_LENGTH = 1_000_000;

export interface ProviderResponseReadOptions {
  allowedContentTypes?: readonly string[];
  readTimeoutMs?: number;
  maxJsonDepth?: number;
  maxJsonNodes?: number;
  maxJsonStringLength?: number;
}

function mediaType(response: Response) {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? null;
}

function contentTypeAllowed(actual: string, allowed: readonly string[]) {
  return allowed.some((candidate) => {
    const normalized = candidate.toLowerCase();
    if (normalized === actual) return true;
    if (normalized === "application/*+json") {
      return actual.startsWith("application/") && actual.endsWith("+json");
    }
    return false;
  });
}

export function assertProviderResponseContentType(
  response: Response,
  allowed: readonly string[]
) {
  const actual = mediaType(response);
  if (!actual) return;
  if (!contentTypeAllowed(actual, allowed)) {
    throw new ControlPlaneError(
      "UNAVAILABLE",
      `Provider returned unsupported content type: ${actual}`
    );
  }
}

function parseContentLength(response: Response) {
  const raw = response.headers.get("content-length");
  if (raw === null) return null;
  if (!/^\d+$/.test(raw.trim())) {
    throw new ControlPlaneError("UNAVAILABLE", "Provider returned invalid Content-Length");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ControlPlaneError("UNAVAILABLE", "Provider returned invalid Content-Length");
  }
  return value;
}

async function readWithDeadline(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ControlPlaneError("UNAVAILABLE", "Provider response body timed out")),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function readBoundedProviderBody(
  response: Response,
  limit: number,
  options: ProviderResponseReadOptions = {}
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 5_000_000) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Response limit must be 1-5000000 bytes");
  }
  if (options.allowedContentTypes) {
    assertProviderResponseContentType(response, options.allowedContentTypes);
  }

  const contentLength = parseContentLength(response);
  if (contentLength !== null && contentLength > limit) {
    await response.body?.cancel();
    throw new ControlPlaneError("UNAVAILABLE", "Provider response exceeds configured size limit");
  }
  if (!response.body) return "";

  const timeoutMs = options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Provider body timeout must be 1-120000 ms");
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await readWithDeadline(reader, timeoutMs);
      } catch (error) {
        try { await reader.cancel(); } catch {}
        if (error instanceof ControlPlaneError) throw error;
        throw new ControlPlaneError("UNAVAILABLE", "Provider response body was truncated");
      }
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) {
        try { await reader.cancel(); } catch {}
        throw new ControlPlaneError("UNAVAILABLE", "Provider response exceeds configured size limit");
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof ControlPlaneError) throw error;
    throw new ControlPlaneError("UNAVAILABLE", "Provider response body was truncated");
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ControlPlaneError("UNAVAILABLE", "Provider response is not valid UTF-8");
  }
}

function assertJsonBounds(
  value: unknown,
  options: ProviderResponseReadOptions
) {
  const maxDepth = options.maxJsonDepth ?? MAX_JSON_DEPTH;
  const maxNodes = options.maxJsonNodes ?? MAX_JSON_NODES;
  const maxStringLength = options.maxJsonStringLength ?? MAX_JSON_STRING_LENGTH;
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let nodes = 0;

  while (stack.length) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > maxNodes) {
      throw new ControlPlaneError("UNAVAILABLE", "Provider JSON exceeds structural node limit");
    }
    if (current.depth > maxDepth) {
      throw new ControlPlaneError("UNAVAILABLE", "Provider JSON exceeds nesting limit");
    }
    if (typeof current.value === "string" && current.value.length > maxStringLength) {
      throw new ControlPlaneError("UNAVAILABLE", "Provider JSON string exceeds configured limit");
    }
    if (Array.isArray(current.value)) {
      for (const item of current.value) {
        stack.push({ value: item, depth: current.depth + 1 });
      }
      continue;
    }
    if (current.value && typeof current.value === "object") {
      for (const [key, item] of Object.entries(current.value as Record<string, unknown>)) {
        if (key.length > 1_000) {
          throw new ControlPlaneError("UNAVAILABLE", "Provider JSON key exceeds configured limit");
        }
        stack.push({ value: item, depth: current.depth + 1 });
      }
    }
  }
  return value;
}

export async function readBoundedProviderJson(
  response: Response,
  limit: number,
  options: ProviderResponseReadOptions = {}
): Promise<unknown> {
  const text = await readBoundedProviderBody(response, limit, {
    ...options,
    allowedContentTypes: options.allowedContentTypes ?? [
      "application/json",
      "application/*+json",
      "text/json",
      "text/plain"
    ]
  });
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new ControlPlaneError("UNAVAILABLE", "Provider returned malformed JSON");
  }
  return assertJsonBounds(parsed, options);
}

function providerIdsFromEnvelope(record: Record<string, unknown>) {
  return ["providerOperationId", "operationId", "id"]
    .map((key) => record[key])
    .filter((value): value is string => typeof value === "string" && value.length > 0);
}

export function assertProviderJsonSuccess(
  parsed: unknown,
  headerProviderOperationId?: string | null
) {
  assertJsonBounds(parsed, {});
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const record = parsed as Record<string, unknown>;

  if (record.ok === false || record.success === false) {
    throw new ControlPlaneError("UNAVAILABLE", "Provider returned a false success indicator");
  }
  if (record.error !== undefined && record.error !== null && record.error !== false && record.error !== "") {
    throw new ControlPlaneError("UNAVAILABLE", "Provider returned an error inside a successful HTTP response");
  }

  const ids = providerIdsFromEnvelope(record);
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length > 1) {
    throw new ControlPlaneError("UNAVAILABLE", "Provider returned conflicting operation identifiers");
  }
  if (headerProviderOperationId && uniqueIds.length === 1 && uniqueIds[0] !== headerProviderOperationId) {
    throw new ControlPlaneError("UNAVAILABLE", "Provider header/body operation identifiers conflict");
  }
}

export function assertProviderSuccessEnvelope(
  body: string,
  headerProviderOperationId?: string | null
) {
  const trimmed = body.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new ControlPlaneError("UNAVAILABLE", "Provider success response contains malformed JSON");
  }
  assertProviderJsonSuccess(parsed, headerProviderOperationId);
}
