import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  assembleBoundaryRing,
  buildBoundaryCandidateQuery,
  buildBoundaryGeometryQuery,
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

type CacheEntry = { fetchedAt: number; payload: unknown };

const memoryCache = new Map<string, CacheEntry>();
let lastCallAt = 0;
let queue: Promise<unknown> = Promise.resolve();

export class OverpassError extends Error {
  constructor(
    message: string,
    readonly code: "busy" | "rate_limited" | "unavailable" | "bad_response",
  ) {
    super(message);
    this.name = "OverpassError";
  }
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
};

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

  const run = queue.then(() => fetchWithBackoff(query));
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

async function fetchWithBackoff(query: string): Promise<unknown> {
  let lastError: OverpassError = new OverpassError("Overpass did not answer", "unavailable");

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const endpoint = ENDPOINTS[attempt % ENDPOINTS.length];

    const gap = Date.now() - lastCallAt;
    if (gap < MIN_CALL_GAP_MS) await sleep(MIN_CALL_GAP_MS - gap);

    try {
      return await callOverpass(endpoint, query);
    } catch (error) {
      lastError = error instanceof OverpassError ? error : new OverpassError(String(error), "unavailable");
      if (lastError.code === "bad_response") throw lastError;

      // 5 s, 15 s, 45 s. Overpass says "too busy" far more often than it says
      // anything else, and the cure for a busy shared service is waiting.
      const backoff = 5000 * 3 ** attempt;
      if (attempt < MAX_ATTEMPTS - 1) await sleep(backoff);
    }
  }

  throw lastError;
}

async function callOverpass(endpoint: string, query: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
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
      const retryAfter = Number(response.headers.get("retry-after"));
      if (Number.isFinite(retryAfter) && retryAfter > 0) await sleep(Math.min(60_000, retryAfter * 1000));
      throw new OverpassError("Overpass rate limit reached", "rate_limited");
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
