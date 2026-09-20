import { ControlPlaneError } from "@/lib/control-plane/errors";
import type { GetDoneEnvironment } from "@/lib/control-plane/request-context";

export interface RuntimeEnvironmentInput {
  runtimeEnvironment: string | undefined;
  nodeEnvironment?: string | undefined;
  dataMode?: string | undefined;
}

export function parseAuthoritativeRuntimeEnvironment(value: string | undefined): GetDoneEnvironment {
  if (value === "development" || value === "staging" || value === "production") {
    return value;
  }

  throw new ControlPlaneError(
    "UNAVAILABLE",
    "GETDONE_RUNTIME_ENV must be explicitly configured as development, staging, or production"
  );
}

export function developmentApiAllowed(input: RuntimeEnvironmentInput) {
  const runtime = parseAuthoritativeRuntimeEnvironment(input.runtimeEnvironment);

  if (input.nodeEnvironment === "production") return false;
  if (runtime === "production") return false;
  if (input.dataMode !== "development-seed") return false;

  return true;
}

export function assertDevelopmentApiAllowed(input: RuntimeEnvironmentInput) {
  if (!developmentApiAllowed(input)) {
    throw new ControlPlaneError("NOT_FOUND", "Development API is disabled");
  }
}
