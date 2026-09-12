import type {
  RoundTripRequest,
  RouteProvider,
  RouteProviderFailure,
  RouteProviderResult,
  RouteRequest,
  RoundTripCapableProvider,
} from "../../types";

/**
 * A hard ceiling on how many routing calls one click may cost.
 *
 * The free openrouteservice plan allows roughly 40 directions calls a minute
 * and 2,000 a day. A single "Generate Route" used to spend 30–38 of them, so
 * three clicks exhausted the minute and the whole product supported about 57
 * route generations a day across every user. No amount of tuning fixes that on
 * its own, because any path that is merely *usually* cheap will find a shape of
 * input that makes it expensive again.
 *
 * So the count is not an emergent property of the search any more. It is a
 * number, decided before the search starts, that the search is not allowed to
 * exceed — shared by every generator working on the same request, so the engine
 * and the round-trip fallback draw from one purse rather than two.
 */

/** What one request may spend, unless the caller says otherwise. */
export const DEFAULT_PROVIDER_BUDGET = 8;

export class ProviderBudget {
  private spent = 0;
  private hits = 0;
  private refused = 0;

  constructor(readonly limit: number = DEFAULT_PROVIDER_BUDGET) {}

  /** Calls that actually went to the provider. */
  get calls(): number {
    return this.spent;
  }

  /** Calls answered from the cache, which cost the provider nothing. */
  get cacheHits(): number {
    return this.hits;
  }

  get remaining(): number {
    return Math.max(0, this.limit - this.spent);
  }

  get exhausted(): boolean {
    return this.spent >= this.limit;
  }

  /** True when the budget actually stopped a call that wanted to happen. */
  get wasRefused(): boolean {
    return this.refused > 0;
  }

  /**
   * Claims one call. Returns false when there is nothing left, and the caller
   * must then make do with what it has already found.
   */
  spend(): boolean {
    if (this.spent >= this.limit) {
      this.refused += 1;
      return false;
    }
    this.spent += 1;
    return true;
  }

  noteCacheHit(): void {
    this.hits += 1;
  }

  /** The scalars a response's `debug` block can carry. */
  toDebug(): Record<string, number | boolean> {
    return {
      providerCalls: this.spent,
      providerBudget: this.limit,
      providerCacheHits: this.hits,
      providerBudgetExhausted: this.wasRefused,
    };
  }
}

/**
 * Routed geometry, remembered.
 *
 * The same waypoints, profile and preferences always produce the same line, so
 * asking twice is a call spent on an answer we already have. Two generators on
 * one request routinely propose the same loop — and a runner who clicks again
 * after nudging nothing but the familiarity slider re-proposes most of them.
 *
 * Process-local on purpose. This runs serverless, so a warm instance keeps the
 * cache and a cold one does not; that is a bonus, never something correctness
 * leans on. No external store, no invalidation problem, no new infrastructure.
 */
const MAX_CACHE_ENTRIES = 96;
const geometryCache = new Map<string, RouteProviderResult>();

function cacheGet(key: string): RouteProviderResult | undefined {
  const hit = geometryCache.get(key);
  if (!hit) return undefined;
  // Re-insert so the map's insertion order is least-recently-used first.
  geometryCache.delete(key);
  geometryCache.set(key, hit);
  return hit;
}

function cacheSet(key: string, value: RouteProviderResult): void {
  geometryCache.set(key, value);
  while (geometryCache.size > MAX_CACHE_ENTRIES) {
    const oldest = geometryCache.keys().next();
    if (oldest.done) break;
    geometryCache.delete(oldest.value);
  }
}

/** Tests only: the cache outliving a case would make the next one a lie. */
export function resetRouteCache(): void {
  geometryCache.clear();
}

/**
 * What makes two routing calls the same call. Deliberately not the timeout:
 * how long we were willing to wait has no bearing on the line that comes back.
 */
function preferenceKey(input: {
  routeStyle?: string;
  preferQuiet?: boolean;
  preferGreen?: boolean;
}): string {
  return [input.routeStyle ?? "mixed", input.preferQuiet ? "quiet" : "-", input.preferGreen ? "green" : "-"].join(
    ",",
  );
}

/** ~1 m of precision: finer than that is noise, coarser would merge real waypoints. */
function coordinateKey(point: { lat: number; lng: number }): string {
  return `${point.lat.toFixed(5)},${point.lng.toFixed(5)}`;
}

export function routeRequestKey(input: RouteRequest): string {
  return `route|${preferenceKey(input)}|${input.coordinates.map(coordinateKey).join(";")}`;
}

export function roundTripRequestKey(input: RoundTripRequest): string {
  return [
    "roundtrip",
    preferenceKey(input),
    input.requestMode ?? "preferred",
    coordinateKey(input.start),
    Math.round(input.targetDistanceMeters),
    input.points ?? 5,
    input.seed ?? 0,
  ].join("|");
}

/**
 * A provider that answers from the cache where it can, counts what it spends,
 * and refuses once the budget is gone.
 *
 * Refusal is not recorded as a provider failure: openrouteservice did nothing
 * wrong, we simply stopped asking. The distinction matters downstream, where a
 * recorded failure changes what the runner is told went wrong.
 */
export class BudgetedProvider implements RoundTripCapableProvider {
  constructor(
    private readonly inner: RouteProvider,
    readonly budget: ProviderBudget,
  ) {}

  async route(input: RouteRequest): Promise<RouteProviderResult | null> {
    const key = routeRequestKey(input);
    const cached = cacheGet(key);
    if (cached) {
      this.budget.noteCacheHit();
      return cached;
    }

    if (!this.budget.spend()) return null;

    const result = await this.inner.route(input);
    if (result && result.geometry.length >= 2) cacheSet(key, result);
    return result;
  }

  async roundTrip(input: RoundTripRequest): Promise<RouteProviderResult | null> {
    const inner = this.inner as Partial<RoundTripCapableProvider>;
    if (typeof inner.roundTrip !== "function") return null;

    const key = roundTripRequestKey(input);
    const cached = cacheGet(key);
    if (cached) {
      this.budget.noteCacheHit();
      return cached;
    }

    if (!this.budget.spend()) return null;

    const result = await inner.roundTrip(input);
    if (result && result.geometry.length >= 2) cacheSet(key, result);
    return result;
  }

  takeFailures(): RouteProviderFailure[] {
    return this.inner.takeFailures?.() ?? [];
  }
}
