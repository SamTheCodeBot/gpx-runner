import { NextRequest, NextResponse } from 'next/server';
import { generateOpenRouteServiceRoundTrip, generateTrainingRoutes } from "@/api/routeGeneratorService";
import { buildFamiliarityIndex, computeFamiliarityRatio } from "@/engine/familiarity";
import {
  buildFamiliarityReport,
  isFamiliarityTarget,
  toEngineMode,
  type FamiliarityTarget,
} from "@/engine/familiarityReport";
import {
  NO_PROVIDER_FAILURES,
  mergeProviderFailureSummaries,
  providerFailureDebug,
} from "@/engine/providers/failures";
import {
  pickByTier,
  type SuggestionTierId,
  type TierPick,
} from "@/engine/routeTiers";
import { boundTracksNearStart, historyRadiusMeters, toLatLngTrack } from "@/engine/trackHistory";
import { simplifyByDistance, toSegments } from "@/engine/utils/geo";
import type { RoundTripSuggestionResult } from "@/api/routeGeneratorService";
import type {
  GeneratedRoute,
  LatLng,
  RouteProviderFailureSummary,
  RouteStyle,
  RouteTrafficSummary,
} from "@/types";

/** One candidate answer, flattened so both generators can be compared fairly. */
type Suggestion = {
  geometry: LatLng[];
  distanceMeters: number;
  elevationGainMeters?: number;
  /** 0..1, or null when there is no history near the start to measure against. */
  ratio: number | null;
  hasHistory: boolean;
  traffic?: RouteTrafficSummary;
  debug: Record<string, unknown>;
  source: string;
};

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

    /**
     * What the runner gets, keyed by tier. The order lives in
     * `SUGGESTION_TIERS`; this only fills in what each tier has to offer, and
     * `pickByTier` walks them top to bottom. An out-and-back sits at the
     * bottom, so it can only ever be reached when every loop tier is empty.
     */
    const candidates: Partial<Record<SuggestionTierId, Suggestion>> = {};

    const engine = hasHistory
      ? await generateTrainingRoutes({
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
        })
      : null;

    if (engine) {
      const fromEngine = (route: GeneratedRoute | undefined, source: string): Suggestion | undefined =>
        // Belt and braces: geometry that no routing provider drew can cross
        // houses and water, and is never shown to a runner.
        route?.routedByProvider
          ? {
              geometry: route.geometry,
              distanceMeters: route.distanceMeters,
              elevationGainMeters: route.elevationGainMeters ?? 0,
              ratio: route.familiarityMeasured ? route.familiarityRatio : null,
              hasHistory: route.familiarityMeasured,
              traffic: route.traffic,
              debug: {
                ...route.debug,
                tracksConsidered: tracks.length,
                rejectedCount: engine.rejectedCount,
                timedOut: engine.timedOut,
              },
              source,
            }
          : undefined;

      candidates['loop-familiarity-matched'] = fromEngine(engine.routes[0], 'familiarity-engine');
      candidates['loop-familiarity-missed'] = fromEngine(engine.nearMisses[0], 'familiarity-engine');
      candidates['loop-off-distance'] = fromEngine(engine.bestEffort[0], 'familiarity-engine-best-effort');
      candidates['out-and-back'] = fromEngine(engine.outAndBacks[0], 'familiarity-engine-out-and-back');
    }

    // A loop the runner knows beats anything the plain generator can offer, so
    // only pay for the round-trip call when the engine has not already won.
    const early = pickByTier(candidates);
    if (early && !early.tier.isOutAndBack && early.tier.id !== 'loop-off-distance') {
      return respond(early, { start, target, routeStyle, targetDistanceKm });
    }

    // No history to measure against, or the familiarity engine came up empty:
    // fall back to the round-trip generator, then report the familiarity of
    // whatever it produced so the answer is never silent about it.
    const fallback = await generateOpenRouteServiceRoundTrip({
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

    const fromFallback = (
      route: RoundTripSuggestionResult | undefined,
      source: string,
    ): Suggestion | undefined =>
      route
        ? {
            geometry: route.geometry,
            distanceMeters: route.distanceMeters,
            elevationGainMeters: route.elevationGainMeters,
            ratio: hasHistory ? familiarityOf(route.geometry, tracks) : null,
            hasHistory,
            debug: { ...route.debug, tracksConsidered: tracks.length },
            source,
          }
        : undefined;

    candidates['loop-round-trip'] = fromFallback(fallback.routes[0], 'openrouteservice-round-trip');
    candidates['out-and-back'] =
      candidates['out-and-back'] ??
      fromFallback(fallback.outAndBacks[0], 'openrouteservice-round-trip-out-and-back');

    const picked = pickByTier(candidates);
    if (!picked) {
      // Nothing survived. Before blaming the start point, look at what the
      // routing provider actually said: a refused key or an exhausted quota is
      // our problem, not a fact about where this runner lives.
      return refuse({
        providerFailures: mergeProviderFailureSummaries(
          engine?.providerFailures ?? NO_PROVIDER_FAILURES,
          fallback.providerFailures,
        ),
        unsafeRejectedCount: fallback.unsafeRejectedCount + (engine?.unsafeRejectedCount ?? 0),
        outOfTime: Date.now() >= deadlineAt || Boolean(engine?.timedOut),
        tracksConsidered: tracks.length,
        rejectedCount: fallback.rejectedCount + (engine?.rejectedCount ?? 0),
      });
    }

    return respond(picked, { start, target, routeStyle, targetDistanceKm });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to generate route';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * The refusal, when there is genuinely nothing to give.
 *
 * Which refusal it is matters. "No loop route found from this start point" is a
 * statement about Falkenberg; if the truth is that openrouteservice answered
 * 429 to every one of forty calls, that sentence is false, unactionable, and
 * sent a working deployment to be debugged as a routing failure. So the
 * provider's own answer decides both the status and the wording, and the raw
 * counts ride along in `debug`.
 */
function refuse(context: {
  providerFailures: RouteProviderFailureSummary;
  unsafeRejectedCount: number;
  outOfTime: boolean;
  tracksConsidered: number;
  rejectedCount: number;
}): NextResponse {
  const { providerFailures: failures } = context;
  const debug = {
    ...providerFailureDebug(failures),
    tracksConsidered: context.tracksConsidered,
    rejectedCount: context.rejectedCount,
    unsafeRejectedCount: context.unsafeRejectedCount,
    outOfTime: context.outOfTime,
  };

  if (failures.unauthorized) {
    return NextResponse.json(
      {
        error:
          'Route generation is not working: the routing provider rejected this server’s credentials.',
        debug,
      },
      { status: 503 },
    );
  }

  if (failures.rateLimited) {
    return NextResponse.json(
      {
        error:
          'The routing provider is rate-limiting us at the moment. Please try again in a minute.',
        debug,
      },
      { status: 429 },
    );
  }

  if (failures.providerRefused) {
    return NextResponse.json(
      {
        error: 'The routing provider could not answer right now. Please try again.',
        debug,
      },
      { status: 503 },
    );
  }

  if (context.unsafeRejectedCount > 0) {
    return NextResponse.json(
      {
        error: 'No route found that avoids the highest-traffic roads from this start point.',
        debug,
      },
      { status: 422 },
    );
  }

  if (context.outOfTime) {
    return NextResponse.json(
      {
        error: 'Ran out of time looking for a loop from this start point. Please try again.',
        debug,
      },
      { status: 422 },
    );
  }

  return NextResponse.json(
    { error: 'No loop route found from this start point.', debug },
    { status: 422 },
  );
}

/**
 * The one place a suggestion turns into a response, so every tier is reported
 * the same way — including whether the runner is being handed a there-and-back.
 */
function respond(
  picked: TierPick<Suggestion>,
  context: { start: LatLng; target: FamiliarityTarget; routeStyle: RouteStyle; targetDistanceKm: number },
): NextResponse {
  const { tier, candidate } = picked;
  const report = buildFamiliarityReport({
    ratio: candidate.ratio,
    target: context.target,
    hasHistory: candidate.hasHistory,
  });
  const notice = tier.describe({
    targetMeters: context.targetDistanceKm * 1000,
    distanceMeters: candidate.distanceMeters,
  });

  return NextResponse.json({
    coordinates: candidate.geometry.map((point) => [point.lng, point.lat] as [number, number]),
    distance: candidate.distanceMeters,
    elevationGain: candidate.elevationGainMeters ?? 0,
    samples: candidate.geometry.map((point) => ({
      coordinate: [point.lng, point.lat] as [number, number],
      elevation: point.elevation,
    })),
    name: routeName(context.target, candidate.distanceMeters, tier.isOutAndBack),
    // An out-and-back is precisely not a round trip, and the map should not
    // claim otherwise.
    isRoundTrip: !tier.isOutAndBack,
    isOutAndBack: tier.isOutAndBack,
    tier: tier.id,
    matchedRequest: notice === null,
    notice,
    type: context.routeStyle,
    startPoint: [context.start.lng, context.start.lat] as [number, number],
    familiarity: report,
    traffic: candidate.traffic,
    debug: { ...candidate.debug, tier: tier.id },
    source: candidate.source,
  });
}

function resolveTarget(body: SuggestionRequest): FamiliarityTarget {
  if (isFamiliarityTarget(body.familiarityMode)) return body.familiarityMode;
  if (body.familiarityMode === 'new') return 'unfamiliar';
  if (typeof body.avoidFamiliar === 'boolean') return body.avoidFamiliar ? 'unfamiliar' : 'mixed';
  return 'mixed';
}

function routeName(target: FamiliarityTarget, distanceMeters: number, isOutAndBack = false): string {
  const label = target === 'familiar' ? 'Familiar' : target === 'unfamiliar' ? 'New ground' : 'Mixed';
  const shape = isOutAndBack ? 'out & back' : 'loop';
  return `${label} ${shape} - ${(distanceMeters / 1000).toFixed(1)}km`;
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
