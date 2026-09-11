import Module from "node:module";
import path from "node:path";

/**
 * The app uses the `@/*` path alias. Tests compile to plain CommonJS, where
 * that alias means nothing, so resolve it the same way tsconfig does. Must run
 * before any module that uses the alias is required.
 */
const SRC_ROOT = path.resolve(__dirname, "..", "..", "src");

type Resolver = (
  request: string,
  parent: unknown,
  isMain: boolean,
  options?: unknown,
) => string;

const loader = Module as unknown as { _resolveFilename: Resolver };
const originalResolve = loader._resolveFilename;

loader._resolveFilename = function resolveWithAlias(request, parent, isMain, options) {
  const mapped = request.startsWith("@/") ? path.join(SRC_ROOT, request.slice(2)) : request;
  return originalResolve.call(this, mapped, parent, isMain, options);
};

export {};
