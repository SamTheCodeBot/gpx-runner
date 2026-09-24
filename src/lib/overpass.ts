import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  assembleBoundaryRing,
  buildBoundaryCandidateQuery,
  buildBoundaryGeometryQuery,
  buildNamedStreetQuery,
  buildStreetAtPointQuery,
  buildStreetQuery,
  parseBoundaryCandidates,
  parseOverpassWays,
  type BoundaryCandidate,
} from "@/engine/streets/overpass";
import type { OsmWay } from "@/engine/streets/inventory";
import { boundaryScope, type StreetScope } from "@/engine/streets/scope";
import type { LatLng } from "@/types";

/**
 * The one place this app talks to Overpass.
 *
 * Overpass is free, shared, and run by volunteers. It is also the only source
 * of truth for what streets exist. Both facts shape this module: every answer
 * is cached on disk and in memory, calls are serialised with a minimum gap
 * between them, and a 429 or a 504 is met with a wait rather than a retry
 * storm. Nothing here is called from a hot path — a street list is fetched when
 * a project is created or explicitly refreshed, and read from storage every
 * other time.
 */

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

/** A street list is worth a week; towns do not change by the hour. */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Minimum gap between two calls from this process. Politeness, not policy. */
const MIN_CALL_GAP_MS = 1200;
const MAX_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 180_000;

/**
 * What a 429 from Overpass actually means.
 *
 * Not "go away" — "all four of your slots are in use". `/api/status` counts
 * the seconds until one frees and the answer is usually a single digit. The
 * client used to treat a 429 as a reason to walk to the next mirror, which
 * traded a four-second wait on the fast, current server for a thirty-eight
 * second one on a mirror two months stale. Now it waits and asks again.
 */
const RATE_LIMIT_PAUSE_MS = 5_000;

/**
 * The least time an attempt needs before it is worth opening a socket.
 *
 * Below this the fetch can only be aborted by its own timeout, and an abort is
 * not an answer — it is the same failure wearing a worse sentence. The guard
 * used to be `budget <= 0`, so a request with 1.5 s left still started a call
 * that could not finish, and the runner was shown "AbortError: This operation
 * was aborted".
 */
const MIN_ATTEMPT_BUDGET_MS = 8_000;

/** How long an endpoint that did not answer at all is left out of rotation. */
const ENDPOINT_COOLDOWN_MS = 5 * 60_000;

/**
 * Endpoints that failed to answer, and when to believe in them again.
 *
 * Only silence counts. A 429 or a 504 is a server saying something about
 * itself while perfectly healthy; a timeout or a dead socket is a server that
 * is not there, and spending a second attempt — and another slice of the
 * budget — proving that again is how a request runs out of time.
 */
const endpointDownUntil = new Map<string, number>();

function healthyEndpoints(): string[] {
  const now = Date.now();
  const healthy = ENDPOINTS.filter((endpoint) => (endpointDownUntil.get(endpoint) ?? 0) <= now);
  return healthy.length > 0 ? healthy : ENDPOINTS;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

type CacheEntry = { fetchedAt: number; payload: unknown };

const memoryCache = new Map<string, CacheEntry>();
let lastCallAt = 0;
let queue: Promise<unknown> = Promise.resolve();

export class OverpassError extends Error {
  /** The endpoint never answered: a timeout, or a socket that went nowhere. */
  readonly noAnswer: boolean;
  /** What the server asked us to wait, when it said so. */
  readonly retryAfterMs: number;

  constructor(
    message: string,
    readonly code: "busy" | "rate_limited" | "unavailable" | "bad_response",
    options: { noAnswer?: boolean; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = "OverpassError";
    this.noAnswer = options.noAnswer ?? false;
    this.retryAfterMs = options.retryAfterMs ?? 0;
  }
}

/**
 * Every failure, said in a sentence a runner can act on.
 *
 * An aborted fetch stringifies to "AbortError: This operation was aborted",
 * which went straight through `String(error)` into the error banner. It names
 * a browser API, not a thing that happened to his project.
 */
function asOverpassError(error: unknown): OverpassError {
  if (error instanceof OverpassError) return error;
  if (isAbort(error)) {
    return new OverpassError(
      "OpenStreetMap did not answer in time. It is busy right now \u2014 please try again in a minute.",
      "busy",
      { noAnswer: true },
    );
  }
  return new OverpassError(
    "Could not reach OpenStreetMap. Please try again in a minute.",
    "unavailable",
    { noAnswer: true },
  );
}

function outOfTime(): OverpassError {
  return new OverpassError(
    "Ran out of time waiting for OpenStreetMap. It is busy right now \u2014 please try again in a minute.",
    "busy",
  );
}

function cacheKey(query: string): string {
  return createHash("sha1").update(query).digest("hex");
}

function cacheDir(): string {
  return path.join(os.tmpdir(), "gpx-runner-overpass");
}

async function readDiskCache(key: string): Promise<CacheEntry | null> {
  try {
    const raw = await readFile(path.join(cacheDir(), `${key}.json`), "utf8");
    const entry = JSON.parse(raw) as CacheEntry;
    return typeof entry?.fetchedAt === "number" ? entry : null;
  } catch {
    return null;
  }
}

async function writeDiskCache(key: string, entry: CacheEntry): Promise<void> {
  try {
    await mkdir(cacheDir(), { recursive: true });
    await writeFile(path.join(cacheDir(), `${key}.json`), JSON.stringify(entry), "utf8");
  } catch {
    // A cache that cannot be written is a slower app, not a broken one.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type OverpassOptions = {
  /** Ignore a cached answer this old or older. Defaults to a week. */
  maxAgeMs?: number;
  /** Fail instead of calling out when nothing is cached. */
  cachedOnly?: boolean;
  /**
   * When the caller's own budget runs out, as an epoch ms timestamp.
   *
   * Without this the retry ladder could spend 4 x 180 s of request timeout plus
   * 65 s of backoff — 785 s — inside a serverless function the platform kills
   * after 60. The platform won, the browser got a bare 504, and nothing in the
   * response said why. So every wait here is now clamped to the time actually
   * left, and an attempt that cannot finish is never started.
   */
  deadlineAt?: number;
};

/** Leave enough after the last call to parse the answer and build a response. */
const DEADLINE_RESERVE_MS = 3_000;

function msLeft(deadlineAt: number | undefined): number {
  return deadlineAt === undefined ? Number.POSITIVE_INFINITY : deadlineAt - Date.now() - DEADLINE_RESERVE_MS;
}

/**
 * Run one Overpass query, cache-first.
 *
 * Calls are funnelled through a single promise chain so two users creating
 * projects at the same moment queue behind each other rather than both hammer
 * the same public endpoint.
 */
export async function runOverpassQuery(query: string, options: OverpassOptions = {}): Promise<unknown> {
  const key = cacheKey(query);
  const maxAge = options.maxAgeMs ?? CACHE_TTL_MS;
  const now = Date.now();

  const cached = memoryCache.get(key) ?? (await readDiskCache(key));
  if (cached) {
    memoryCache.set(key, cached);
    if (now - cached.fetchedAt < maxAge) return cached.payload;
  }

  if (options.cachedOnly) {
    if (cached) return cached.payload;
    throw new OverpassError("No cached street data for this area", "unavailable");
  }

  const run = queue.then(() => fetchWithBackoff(query, options.deadlineAt));
  queue = run.catch(() => undefined);

  try {
    const payload = await run;
    const entry: CacheEntry = { fetchedAt: Date.now(), payload };
    memoryCache.set(key, entry);
    void writeDiskCache(key, entry);
    return payload;
  } catch (error) {
    // A stale answer beats no answer: the street list of a town last week is
    // still the street list of that town.
    if (cached) return cached.payload;
    throw error;
  }
}

async function fetchWithBackoff(query: string, deadlineAt?: number): Promise<unknown> {
  let lastError: OverpassError | null = null;
  const pool = healthyEndpoints();
  let index = 0;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const endpoint = pool[index % pool.length];

    const gap = Date.now() - lastCallAt;
    if (gap < MIN_CALL_GAP_MS) await sleep(Math.min(MIN_CALL_GAP_MS - gap, Math.max(0, msLeft(deadlineAt))));

    const budget = msLeft(deadlineAt);
    if (budget < MIN_ATTEMPT_BUDGET_MS) throw lastError && !lastError.noAnswer ? lastError : outOfTime();

    try {
      return await callOverpass(endpoint, query, Math.min(REQUEST_TIMEOUT_MS, budget));
    } catch (error) {
      lastError = asOverpassError(error);
      if (lastError.code === "bad_response") throw lastError;

      if (lastError.noAnswer) endpointDownUntil.set(endpoint, Date.now() + ENDPOINT_COOLDOWN_MS);

      // A rate limit is the one failure that says something about *when*: the
      // slot frees in seconds, on the server that is both fastest and most
      // current. So wait the slot out and ask it again rather than stepping
      // down to a mirror. Every other failure means try somewhere else.
      const rateLimited = lastError.code === "rate_limited";
      if (!rateLimited) index += 1;

      if (attempt === MAX_ATTEMPTS - 1) break;

      // A slot wait is whatever the server said. A busy service gets 5 s,
      // 15 s, 45 s, because waiting is the cure for load. A server that never
      // answered gets nothing: we are walking to a different machine, and the
      // silent one is not going to be less silent in five seconds. That wait
      // used to be charged to the budget on top of the timeout we had just
      // spent finding out it was dead.
      const pause = rateLimited
        ? lastError.retryAfterMs || RATE_LIMIT_PAUSE_MS
        : lastError.noAnswer
          ? 0
          : 5000 * 3 ** attempt;

      // Only wait when there is time to wait *and then ask*. Sleeping into the
      // deadline buys a slower way to fail.
      if (msLeft(deadlineAt) < pause + MIN_ATTEMPT_BUDGET_MS) break;
      if (pause > 0) await sleep(pause);
    }
  }

  throw lastError ?? outOfTime();
}

async function callOverpass(endpoint: string, query: string, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  lastCallAt = Date.now();

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        // Overpass asks for a contactable agent so it can tell a well-behaved
        // client from a runaway script.
        "User-Agent": "gpx-runner street-completion (https://github.com/gpx-runner)",
      },
      body: new URLSearchParams({ data: query }).toString(),
      signal: controller.signal,
    });

    if (response.status === 429) {
      // The wait itself belongs to the retry loop, which is the only code here
      // that knows how much of the request's budget is left. Sleeping up to a
      // minute inside a fifty-second budget, as this used to, guaranteed the
      // abort it was trying to avoid.
      const retryAfter = Number(response.headers.get("retry-after"));
      throw new OverpassError(
        "OpenStreetMap's query service is at its limit right now. Please try again in a minute.",
        "rate_limited",
        { retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(30_000, retryAfter * 1000) : 0 },
      );
    }

    if (response.status === 504 || response.status === 503) {
      throw new OverpassError("Overpass is too busy right now", "busy");
    }

    if (!response.ok) {
      throw new OverpassError(`Overpass returned ${response.status}`, "unavailable");
    }

    const text = await response.text();

    // Overpass answers a runtime error with HTTP 200 and a page of HTML.
    if (!text.trimStart().startsWith("{")) {
      const busy = /too busy|timeout|Dispatcher/i.test(text);
      throw new OverpassError(
        busy ? "Overpass is too busy right now" : "Overpass rejected the query",
        busy ? "busy" : "bad_response",
      );
    }

    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchStreetWays(scope: StreetScope, options: OverpassOptions = {}): Promise<OsmWay[]> {
  const payload = await runOverpassQuery(buildStreetQuery(scope), options);
  return parseOverpassWays(payload);
}

/**
 * The named runnable ways under a tap.
 *
 * Cheap on purpose: a few metres of ground instead of a town. This is the
 * query behind pointing at a road, and the reason pointing works where
 * inventorying a margin band times out.
 */
export async function fetchWaysAtPoint(
  point: LatLng,
  radiusMeters: number,
  options: OverpassOptions = {},
): Promise<OsmWay[]> {
  const payload = await runOverpassQuery(buildStreetAtPointQuery(point, radiusMeters), options);
  return parseOverpassWays(payload);
}

/** Every way of one named street near a point, so a tapped fragment becomes a street. */
export async function fetchNamedWaysNear(
  point: LatLng,
  name: string,
  radiusMeters: number,
  options: OverpassOptions = {},
): Promise<OsmWay[]> {
  const payload = await runOverpassQuery(buildNamedStreetQuery(point, name, radiusMeters), options);
  return parseOverpassWays(payload);
}

export async function fetchBoundaryCandidates(point: LatLng): Promise<BoundaryCandidate[]> {
  const payload = await runOverpassQuery(buildBoundaryCandidateQuery(point), { maxAgeMs: CACHE_TTL_MS });
  return parseBoundaryCandidates(payload);
}

export async function fetchBoundaryScope(candidate: BoundaryCandidate): Promise<StreetScope | null> {
  const payload = await runOverpassQuery(buildBoundaryGeometryQuery(candidate.osmId));
  const ring = assembleBoundaryRing(payload);
  if (ring.length < 4) return null;

  return boundaryScope(ring, {
    kind: "boundary",
    osmId: candidate.osmId,
    osmType: "relation",
    name: candidate.name,
    adminLevel: candidate.adminLevel,
  });
}
