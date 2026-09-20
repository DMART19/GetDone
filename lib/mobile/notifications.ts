import type { MobileDeepLinkTarget } from "@/lib/mobile/deep-links";
import { buildMobileDeepLink } from "@/lib/mobile/deep-links";

export type NotificationAttention = "fyi" | "normal" | "high" | "critical";

export interface OwnerNotificationInput {
  id: string;
  attention: NotificationAttention;
  target: MobileDeepLinkTarget;
  sensitive: boolean;
  summary?: string;
}

export interface OwnerNotificationDelivery {
  id: string;
  push: boolean;
  destination: string;
  lockScreenTitle: string;
  lockScreenBody: string;
  requiresAuthoritativeFetch: true;
}

function genericBody(attention: NotificationAttention) {
  if (attention === "critical") return "Open GetDone to review a critical item securely.";
  if (attention === "high") return "Open GetDone to review an important item securely.";
  if (attention === "normal") return "A decision is ready for review in GetDone.";
  return "A new result is available in GetDone.";
}

export function planOwnerNotification(
  input: OwnerNotificationInput
): OwnerNotificationDelivery {
  const push = input.attention === "high" || input.attention === "critical";
  const body = input.sensitive || push
    ? genericBody(input.attention)
    : (input.summary?.trim() || genericBody(input.attention));

  return Object.freeze({
    id: input.id,
    push,
    destination: buildMobileDeepLink(input.target),
    lockScreenTitle: input.attention === "critical"
      ? "GetDone — Critical"
      : input.attention === "high"
        ? "GetDone — Attention needed"
        : "GetDone",
    lockScreenBody: body,
    requiresAuthoritativeFetch: true as const
  });
}
