import { NextRequest, NextResponse } from 'next/server';
import { generateOpenRouteServiceRoundTrip, generateTrainingRoutes } from "@/api/routeGeneratorService";
import { buildFamiliarityIndex, computeFamiliarityRatio } from "@/engine/familiarity";
import {
  buildFamiliarityReport,
  isFamiliarityTarget,
  toEngineMode,
  type FamiliarityTarget,
} from "@/engine/familiarityReport";
import { boundTracksNearStart, historyRadiusMeters, toLatLngTrack } from "@/engine/trackHistory";
import { simplifyByDistance, toSegments } from "@/engine/utils/geo";
import type { GeneratedRoute, LatLng, RouteStyle } from "@/types";

/**
 * Route suggestions.
 *
 * Familiarity can only be steered on the waypoint path: openrouteservice's
 * `round_trip` takes a start point, a seed and a length, so there is no way to
 * push it onto or away from ground the runner already knows. This endpoint
 * therefore runs the familiarity engine whenever the runner has logged tracks
 * near the start, and only falls back to `round_trip` when there is no history
 * to measure against (or the engine found nothing at all).
 */

type TrackInput = [number, number][]; // [lng, lat]

type SuggestionRequest = {
  distance?: number;
  centerLat?: number;
  centerLon?: number;
  /** familiar | mixed | unfamiliar. */
  familiarityMode?: string;
  /** Legacy boolean from the first version of the UI. */
  avoidFamiliar?: boolean;
  /** The runner's logged activity tracks, already trimmed by the client. */
  tracks?: TrackInput[];
  /** Legacy shape, still accepted. */
  existingRoutes?: { coordinates?: TrackInput }[];
  routeStyle?: RouteStyle;
  preferQuiet?: boolean;
  preferGreen?: boolean;
  elevationPreference?: 'any' | 'hilly' | 'flat';
  directionShift?: number;
};

/** Server-side guard rails: a bad client must not be able to post a phone book. */
const MAX_TRACKS = 150;
const MAX_POINTS_PER_TRACK = 600;
const MAX_TOTAL_POINTS = 30_000;

/**
 * How long the platform lets this function run. Without it Vercel applies its
 * own default and kills the request with no body at all, which the client can
 * only report as "timed out". 60 s is inside every current plan's ceiling.
 */
export const maxDuration = 60;

/**
 * Our own deadline, set well below `maxDuration` so the work is cut short by us
 * — with a real answer and an honest message — rather than by the platform.
 */
const REQUEST_BUDGET_MS = 25_000;

export async function POST(request: NextRequest) {
  const deadlineAt = Date.now() + REQUEST_BUDGET_MS;

  try {
    const body = (await request.json()) as SuggestionRequest;

    if (!Number.isFinite(body.distance) || !Number.isFinite(body.centerLat) || !Number.isFinite(body.centerLon)) {
      return NextResponse.json({ error: 'Invalid route request' }, { status: 400 });
    }

    if (!process.env.OPENROUTESERVICE_API_KEY) {
      return NextResponse.json(
        { error: 'Route generation is not configured on the server (missing openrouteservice API key).' },
        { status: 503 },
      );
    }

    const targetDistanceKm = Math.min(100, Math.max(1, Number(body.distance)));
    const start: LatLng = { lat: Number(body.centerLat), lng: Number(body.centerLon) };
    const target = resolveTarget(body);
    const routeStyle: RouteStyle = body.routeStyle === 'road' || body.routeStyle === 'trail' ? body.routeStyle : 'mixed';
    const preferQuiet = body.preferQuiet !== false; // quiet ways are the default for runners
    const preferGreen = Boolean(body.preferGreen);

    const tracks = collectTracks(body, start, targetDistanceKm);
    const hasHistory = tracks.length > 0;

    if (hasHistory) {
      const engine = await generateTrainingRoutes({
        start,
        targetDistanceKm,
        toleranceKm: 0.5,
        familiarityMode: toEngineMode(target),
        routeCollections: tracks,
        maxCandidates: 18,
        alternatives: 3,
        routeStyle,
        preferQuiet,
        preferGreen,
        deadlineAt,
      });

      // `routes` met every constraint. `nearMisses` met every *hard* one — real
      // length, real loop shape, safe roads, routed by the provider — and only
      // missed the familiarity band, so it comes back with the true percentage
      // attached rather than as "no route found".
      const candidate: GeneratedRoute | undefined = engine.routes[0] ?? engine.nearMisses[0];
      // Belt and braces: geometry that no routing provider drew can cross
      // houses and water, and is never shown to a runner.
      const best = candidate?.routedByProvider ? candidate : undefined;

      if (best) {
        const report = buildFamiliarityReport({
          ratio: best.familiarityMeasured ? best.familiarityRatio : null,
          target,
          hasHistory: best.familiarityMeasured,
        });

        return NextResponse.json({
          coordinates: best.geometry.map((point) => [point.lng, point.lat] as [number, number]),
          distance: best.distanceMeters,
          elevationGain: best.elevationGainMeters ?? 0,
          samples: best.geometry.map((point) => ({
            coordinate: [point.lng, point.lat] as [number, number],
            elevation: point.elevation,
          })),
          name: routeName(target, best.distanceMeters),
          isRoundTrip: true,
          type: routeStyle,
          startPoint: [start.lng, start.lat] as [number, number],
          familiarity: report,
          traffic: best.traffic,
          debug: {
            ...best.debug,
            tracksConsidered: tracks.length,
            rejectedCount: engine.rejectedCount,
            timedOut: engine.timedOut,
          },
          source: 'familiarity-engine',
        });
      }
    }

    // No history to measure against, or the familiarity engine came up empty:
    // fall back to the round-trip generator, then report the familiarity of
    // whatever it produced so the answer is never silent about it.
    const result = await generateOpenRouteServiceRoundTrip({
      start,
      targetDistanceKm,
      toleranceKm: 0.5,
      alternatives: 3,
      routeStyle,
      preferQuiet,
      preferGreen,
      elevationPreference: body.elevationPreference ?? 'any',
      directionShift: Number.isFinite(body.directionShift) ? Number(body.directionShift) : 0,
      deadlineAt,
    });

    const best = result.routes[0];
    if (!best) {
      // Nothing survived. Loop shape and road safety are not negotiable, so an
      // honest refusal is the right answer here — but say which it was.
      const message = result.unsafeRejectedCount > 0
        ? 'No route found that avoids the highest-traffic roads from this start point.'
        : Date.now() >= deadlineAt
          ? 'Ran out of time looking for a loop from this start point. Please try again.'
          : 'No loop route found from this start point.';
      return NextResponse.json({ error: message }, { status: 422 });
    }

    const ratio = hasHistory ? familiarityOf(best.geometry, tracks) : null;
    const report = buildFamiliarityReport({ ratio, target, hasHistory });

    return NextResponse.json({
      coordinates: best.geometry.map((point) => [point.lng, point.lat] as [number, number]),
      distance: best.distanceMeters,
      elevationGain: best.elevationGainMeters,
      samples: best.geometry.map((point) => ({
        coordinate: [point.lng, point.lat] as [number, number],
        elevation: point.elevation,
      })),
      name: routeName(target, best.distanceMeters),
      isRoundTrip: true,
      type: routeStyle,
      startPoint: [start.lng, start.lat] as [number, number],
      familiarity: report,
      debug: { ...best.debug, tracksConsidered: tracks.length },
      source: 'openrouteservice-round-trip',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to generate route';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function resolveTarget(body: SuggestionRequest): FamiliarityTarget {
  if (isFamiliarityTarget(body.familiarityMode)) return body.familiarityMode;
  if (body.familiarityMode === 'new') return 'unfamiliar';
  if (typeof body.avoidFamiliar === 'boolean') return body.avoidFamiliar ? 'unfamiliar' : 'mixed';
  return 'mixed';
}

function routeName(target: FamiliarityTarget, distanceMeters: number): string {
  const label = target === 'familiar' ? 'Familiar' : target === 'unfamiliar' ? 'New ground' : 'Mixed';
  return `${label} loop - ${(distanceMeters / 1000).toFixed(1)}km`;
}

/**
 * Keeps only the parts of the runner's history that could possibly overlap a
 * loop of this length from this start, and thins them out. Familiarity is a
 * ~10 m question, so ~20 m sampling is plenty.
 */
function collectTracks(body: SuggestionRequest, start: LatLng, targetDistanceKm: number): LatLng[][] {
  const raw: TrackInput[] = [
    ...(Array.isArray(body.tracks) ? body.tracks : []),
    ...(Array.isArray(body.existingRoutes) ? body.existingRoutes.map((route) => route?.coordinates ?? []) : []),
  ];

  return boundTracksNearStart(raw.map(toLatLngTrack), start, {
    radiusMeters: historyRadiusMeters(targetDistanceKm),
    maxTracks: MAX_TRACKS,
    maxPointsPerTrack: MAX_POINTS_PER_TRACK,
    maxTotalPoints: MAX_TOTAL_POINTS,
  });
}

function familiarityOf(geometry: LatLng[], tracks: LatLng[][]): number {
  const segments = toSegments(simplifyByDistance(geometry, 18)).filter((segment) => segment.distanceMeters >= 8);
  return computeFamiliarityRatio(segments, buildFamiliarityIndex(tracks));
}
