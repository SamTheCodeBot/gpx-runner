import type {
  RouteProviderFailure,
  RouteProviderFailureKind,
  RouteProviderFailureSummary,
} from "../../types";

/**
 * Provider failures, made legible.
 *
 * A routing call that returns nothing is not one event, it is several very
 * different ones: the key was refused, the quota ran out, the request was
 * malformed, the network dropped it — or there genuinely is no route. Only the
 * last of those is a fact about the runner's start point; the rest are facts
 * about us. Reporting them all as "no loop route found from this start point"
 * is how a deployment stays broken.
 */

/** Worst first. Whatever is highest in this list is what a human should be told. */
const SEVERITY: RouteProviderFailureKind[] = [
  "unauthorized",
  "forbidden",
  "rate-limited",
  "rejected",
  "provider-error",
  "timeout",
  "network",
  "empty",
];

export function summarizeProviderFailures(
  failures: readonly RouteProviderFailure[],
): RouteProviderFailureSummary {
  const byKind: Partial<Record<RouteProviderFailureKind, number>> = {};
  for (const failure of failures) {
    byKind[failure.kind] = (byKind[failure.kind] ?? 0) + 1;
  }

  const worst = SEVERITY.map((kind) => failures.find((failure) => failure.kind === kind)).find(Boolean);

  return {
    total: failures.length,
    byKind,
    worst,
    providerRefused: failures.some((failure) => failure.kind !== "empty"),
    rateLimited: failures.some((failure) => failure.kind === "rate-limited"),
    unauthorized: failures.some(
      (failure) => failure.kind === "unauthorized" || failure.kind === "forbidden",
    ),
  };
}

export function mergeProviderFailureSummaries(
  ...summaries: RouteProviderFailureSummary[]
): RouteProviderFailureSummary {
  const byKind: Partial<Record<RouteProviderFailureKind, number>> = {};
  for (const summary of summaries) {
    for (const [kind, count] of Object.entries(summary.byKind)) {
      const key = kind as RouteProviderFailureKind;
      byKind[key] = (byKind[key] ?? 0) + (count ?? 0);
    }
  }

  const worst = SEVERITY.map((kind) => summaries.find((s) => s.worst?.kind === kind)?.worst).find(Boolean);

  return {
    total: summaries.reduce((sum, summary) => sum + summary.total, 0),
    byKind,
    worst,
    providerRefused: summaries.some((summary) => summary.providerRefused),
    rateLimited: summaries.some((summary) => summary.rateLimited),
    unauthorized: summaries.some((summary) => summary.unauthorized),
  };
}

export const NO_PROVIDER_FAILURES: RouteProviderFailureSummary = {
  total: 0,
  byKind: {},
  providerRefused: false,
  rateLimited: false,
  unauthorized: false,
};

/**
 * The summary, flattened into the plain scalars a debug payload allows.
 * Never carries anything the provider was authenticated with.
 */
export function providerFailureDebug(
  summary: RouteProviderFailureSummary,
): Record<string, number | string | boolean> {
  const debug: Record<string, number | string | boolean> = {
    providerCallsFailed: summary.total,
    providerRefused: summary.providerRefused,
  };

  for (const [kind, count] of Object.entries(summary.byKind)) {
    debug[`providerFailure_${kind.replace(/-/g, "_")}`] = count ?? 0;
  }

  if (summary.worst) {
    debug.providerFailureKind = summary.worst.kind;
    if (summary.worst.status !== undefined) debug.providerFailureStatus = summary.worst.status;
    if (summary.worst.code !== undefined) debug.providerFailureCode = summary.worst.code;
    if (summary.worst.message) debug.providerFailureMessage = summary.worst.message;
  }

  return debug;
}
