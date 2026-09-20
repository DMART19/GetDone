import { createHmac, timingSafeEqual } from "node:crypto";
import { ControlPlaneError } from "@/lib/control-plane/errors";

export interface HmacSignatureOptions {
  rawBody: string | Uint8Array;
  signature: string;
  secret: string;
  timestamp?: string;
  toleranceSeconds?: number;
  nowMs?: number;
  prefix?: string;
}

function bodyBuffer(rawBody: string | Uint8Array) {
  return typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : Buffer.from(rawBody);
}

function normalizeHexSignature(signature: string, prefix: string) {
  const value = signature.startsWith(prefix) ? signature.slice(prefix.length) : signature;
  if (!/^[a-fA-F0-9]{64}$/.test(value)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Callback signature has an invalid format");
  }
  return value.toLowerCase();
}

function verifyTimestamp(timestamp: string, toleranceSeconds: number, nowMs: number) {
  if (!/^\d{10,13}$/.test(timestamp)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Callback timestamp has an invalid format");
  }

  const numeric = Number(timestamp);
  const timestampMs = timestamp.length === 10 ? numeric * 1000 : numeric;
  if (!Number.isFinite(timestampMs)) {
    throw new ControlPlaneError("VALIDATION_FAILED", "Callback timestamp is invalid");
  }

  if (Math.abs(nowMs - timestampMs) > toleranceSeconds * 1000) {
    throw new ControlPlaneError("FORBIDDEN", "Callback timestamp is outside the allowed replay window");
  }
}

export function computeHmacSha256(
  rawBody: string | Uint8Array,
  secret: string,
  timestamp?: string,
  prefix = "sha256="
) {
  if (!secret) throw new ControlPlaneError("VALIDATION_FAILED", "Callback secret is required");
  const hmac = createHmac("sha256", secret);
  if (timestamp) hmac.update(`${timestamp}.`, "utf8");
  hmac.update(bodyBuffer(rawBody));
  return `${prefix}${hmac.digest("hex")}`;
}

export function verifyHmacSha256Callback(options: HmacSignatureOptions) {
  const {
    rawBody,
    signature,
    secret,
    timestamp,
    toleranceSeconds = 300,
    nowMs = Date.now(),
    prefix = "sha256="
  } = options;

  if (!secret) throw new ControlPlaneError("VALIDATION_FAILED", "Callback secret is required");
  if (timestamp) verifyTimestamp(timestamp, toleranceSeconds, nowMs);

  const providedHex = normalizeHexSignature(signature, prefix);
  const expected = computeHmacSha256(rawBody, secret, timestamp, "").toLowerCase();
  const providedBuffer = Buffer.from(providedHex, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");

  return providedBuffer.length === expectedBuffer.length && timingSafeEqual(providedBuffer, expectedBuffer);
}

export function requireValidHmacSha256Callback(options: HmacSignatureOptions) {
  if (!verifyHmacSha256Callback(options)) {
    throw new ControlPlaneError("FORBIDDEN", "Callback signature verification failed");
  }
}
