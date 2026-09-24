/**
 * `@/` for the compiled test build.
 *
 * The app imports by alias and `tsc` leaves aliases alone, so anything under
 * `src/lib` was unreachable from `node --test` — which is why the network
 * layer had no tests until an abort reached a runner's screen. Eight lines
 * here beat rewriting production imports to relative paths to suit the runner.
 */
const path = require("node:path");
const Module = require("node:module");

const root = path.join(__dirname, "..", ".test-build", "src");
const resolve = Module._resolveFilename;

Module._resolveFilename = function (request, ...rest) {
  return resolve.call(this, request.startsWith("@/") ? path.join(root, request.slice(2)) : request, ...rest);
};
