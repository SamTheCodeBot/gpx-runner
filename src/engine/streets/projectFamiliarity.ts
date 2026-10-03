import { buildFamiliarityIndex, type FamiliarityIndex } from "@/engine/familiarity";
import { toLatLngTrack } from "@/engine/trackHistory";
import type { StreetScope } from "@/engine/streets/scope";

/**
 * One project's familiarity index: every one of the owner's logged runs,
 * handed straight to buildFamiliarityIndex.
 *
 * This used to geographically pre-filter the owner's history first
 * (selectTracksNearStart + boundTracksNearStart, the same bounding route
 * suggestions use) before handing it to buildFamiliarityIndex. Reverted
 * (2026-10-03): on a real account it silently excluded roughly two-thirds
 * of the owner's own home-turf runs -- a project went from a correct 44%
 * (247/563 streets, matching the unbounded computation) to 14% (79/563)
 * with the exact same street inventory underneath it. Three separate
 * attempts at tuning that bounding's radius, track count and point budget
 * each fixed one symptom (a crash, a reload instability, a precision loss)
 * while the underlying exclusion bug was never actually found.
 *
 * The crash this bounding was built to prevent has its own fix now --
 * useGPXRoutes decodes in yielded chunks (see hooks.ts) -- so coverage no
 * longer needs to avoid processing the owner's whole history to stay
 * responsive; it only needs to not do it synchronously, which it already
 * does not. buildFamiliarityIndex's own internal 18 m simplification is
 * the same one every other page already relies on.
 *
 * `scope` is unused -- kept in the signature because every call site has
 * one to hand and a future, deliberately scoped optimisation may want it
 * again. See streetCoverage.test.ts's "never silently drops a runner's own
 * history" case for the regression this guards against.
 */
export function buildProjectFamiliarityIndex(
  _scope: StreetScope,
  routes: Array<{ coordinates: [number, number][] }>,
): FamiliarityIndex {
  const tracks = routes.map((route) => toLatLngTrack(route.coordinates)).filter((track) => track.length >= 2);
  return buildFamiliarityIndex(tracks);
}
