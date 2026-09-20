import { ControlPlaneError } from "@/lib/control-plane/errors";

export type MobileDeepLinkTarget =
  | { kind: "decision"; decisionId: string }
  | { kind: "resource-add" }
  | { kind: "task-result"; taskId: string }
  | { kind: "resource"; resourceId: string }
  | { kind: "resource-incident"; resourceId: string; incidentId: string }
  | { kind: "resource-decision"; resourceId: string; decisionId: string };

function safeId(value: string, label: string) {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(normalized)) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} contains unsafe characters`);
  }
  return encodeURIComponent(normalized);
}

export function buildMobileDeepLink(target: MobileDeepLinkTarget) {
  switch (target.kind) {
    case "resource-add":
      return "/resources/add";
    case "decision":
      return `/decisions/${safeId(target.decisionId, "decisionId")}`;
    case "task-result":
      return `/?focus=task-result&id=${safeId(target.taskId, "taskId")}`;
    case "resource":
      return `/resources/${safeId(target.resourceId, "resourceId")}`;
    case "resource-incident":
      return `/resources/${safeId(target.resourceId, "resourceId")}?incident=${safeId(target.incidentId, "incidentId")}`;
    case "resource-decision":
      return `/decisions/${safeId(target.decisionId, "decisionId")}?resource=${safeId(target.resourceId, "resourceId")}`;
  }
}

export function assertSafeInternalDeepLink(path: string) {
  if (
    !path.startsWith("/")
    || path.startsWith("//")
    || path.includes("\\")
    || path.includes("..")
    || /^\/(?:https?:|javascript:|data:)/i.test(path)
  ) {
    throw new ControlPlaneError("FORBIDDEN", "Deep link must remain inside the GetDone origin");
  }
  return path;
}
