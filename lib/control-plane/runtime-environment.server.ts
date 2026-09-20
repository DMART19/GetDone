import { assertDevelopmentApiAllowed, parseAuthoritativeRuntimeEnvironment } from "@/lib/control-plane/runtime-environment";

export function readServerRuntimeEnvironment() {
  return parseAuthoritativeRuntimeEnvironment(process.env.GETDONE_RUNTIME_ENV);
}

export function requireDevelopmentApiRuntime() {
  assertDevelopmentApiAllowed({
    runtimeEnvironment: process.env.GETDONE_RUNTIME_ENV,
    nodeEnvironment: process.env.NODE_ENV,
    dataMode: process.env.GETDONE_DATA_MODE
  });
  return readServerRuntimeEnvironment();
}
