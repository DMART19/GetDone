const Module = require("node:module");
const path = require("node:path");

const workerRoot = path.resolve(__dirname, "..", "dist-worker");
const originalResolveFilename = Module._resolveFilename;

Module._resolveFilename = function resolveGetDoneWorkerAlias(
  request,
  parent,
  isMain,
  options
) {
  const mapped = typeof request === "string" && request.startsWith("@/")
    ? path.join(workerRoot, request.slice(2))
    : request;
  return originalResolveFilename.call(this, mapped, parent, isMain, options);
};
