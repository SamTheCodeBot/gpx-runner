import { haversineMeters } from "@/engine/utils/geo";
import { adminDb } from "@/lib/firebaseAdmin";
import { fingerprintTrack } from "./fingerprint";
import { stampRetention } from "./retention";
import type {
  ActivitySourceId,
  CanonicalActivity,
  GPXRoute,
  NormalizedActivity,
  RawPayloadRef,
  SourceActivityFile,
} from "@/app/types";

/**
 * Persistence for the ingestion spine.
 *
 * Three collections are written:
 *   `activities`           canonical activity records (provider-agnostic)
 *   `routes`               the geometry, in the existing `GPXRoute` shape so
 *                          maps, heatmaps and familiarity keep working
 *   `rawActivityPayloads`  the original provider file, separate and short-TTL
 *
 * Keeping raw payloads in their own collection is deliberate: they carry a
 * different retention period from the canonical record and can be purged
 * without touching the user's training history.
 */

export const ACTIVITY_COLLECTION = "activities";
export const ROUTE_COLLECTION = "routes";
export const RAW_PAYLOAD_COLLECTION = "rawActivityPayloads";

export type IngestOutcome = "created" | "updated" | "duplicate" | "skipped";

export type IngestResult = {
  outcome: IngestOutcome;
  activityId: string;
  /** Set when the outcome is `duplicate`: the record we already held. */
  duplicateOf?: string;
  reason?: string;
};

/**
 * Compact projection of what we already hold, used for duplicate detection.
 * Loaded once per ingestion run rather than per activity.
 */
export type DedupeCandidate = {
  id: string;
  source: ActivitySourceId;
  startedAt: string;
  distanceMeters: number;
  fingerprint?: string;
  startPoint?: [number, number];
};

/** Two recordings of one run never start more than this far apart. */
const DUPLICATE_START_WINDOW_MS = 10 * 60 * 1000;
/** Providers disagree on distance by smoothing artefacts, not by much. */
const DUPLICATE_DISTANCE_TOLERANCE = 0.03;
const DUPLICATE_DISTANCE_FLOOR_M = 200;
/** GPS fixes at the same start line, from two devices or two exports. */
const DUPLICATE_START_POINT_M = 500;

export async function loadDedupeCandidates(ownerUid: string): Promise<DedupeCandidate[]> {
  // Single equality filter: served by the automatic single-field index, so no
  // composite index has to be deployed for ingestion to work.
  const snap = await adminDb()
    .collection(ACTIVITY_COLLECTION)
    .where("ownerUid", "==", ownerUid)
    .select("source", "startedAt", "distanceMeters", "fingerprint", "startPoint")
    .get();

  return snap.docs.map((doc) => ({
    id: doc.id,
    source: doc.get("source") as ActivitySourceId,
    startedAt: (doc.get("startedAt") as string) ?? "",
    distanceMeters: (doc.get("distanceMeters") as number) ?? 0,
    fingerprint: doc.get("fingerprint") as string | undefined,
    startPoint: doc.get("startPoint") as [number, number] | undefined,
  }));
}

/**
 * Is this the same run we already hold from another source?
 *
 * Two stages. The fingerprint is an exact-match fast path. Because any rounding
 * scheme has boundaries, it is backed by a tolerance comparison: same owner,
 * start times within ten minutes, distances within 3%, and — when both records
 * carry one — start points within 500 m. A person cannot run two different runs
 * at the same time, so this is decisive without being brittle.
 *
 * Records from the *same* source are ignored here: those are handled exactly by
 * the document id, and a provider legitimately re-sending an edited activity
 * must update rather than be discarded as a duplicate.
 */
export function findDuplicate(
  candidates: DedupeCandidate[],
  incoming: {
    source: ActivitySourceId;
    startedAt: string;
    distanceMeters: number;
    fingerprint: string;
    startPoint?: [number, number];
  },
): DedupeCandidate | null {
  const startedAt = new Date(incoming.startedAt).valueOf();
  const distanceTolerance = Math.max(
    DUPLICATE_DISTANCE_FLOOR_M,
    incoming.distanceMeters * DUPLICATE_DISTANCE_TOLERANCE,
  );

  for (const candidate of candidates) {
    if (candidate.source === incoming.source) continue;

    if (candidate.fingerprint && candidate.fingerprint === incoming.fingerprint) return candidate;

    const candidateStart = new Date(candidate.startedAt).valueOf();
    if (!Number.isFinite(candidateStart) || !Number.isFinite(startedAt)) continue;
    if (Math.abs(candidateStart - startedAt) > DUPLICATE_START_WINDOW_MS) continue;
    if (Math.abs(candidate.distanceMeters - incoming.distanceMeters) > distanceTolerance) continue;

    if (candidate.startPoint && incoming.startPoint) {
      const apart = haversineMeters(
        { lat: candidate.startPoint[1], lng: candidate.startPoint[0] },
        { lat: incoming.startPoint[1], lng: incoming.startPoint[0] },
      );
      if (apart > DUPLICATE_START_POINT_M) continue;
    }

    return candidate;
  }

  return null;
}

export function canonicalActivityId(source: ActivitySourceId, sourceActivityId: string): string {
  return `${source}:${sourceActivityId}`;
}

/** Same wire shape the existing route documents use: coordinates as {lat, lon}. */
function serializeRoute(route: GPXRoute): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    ...route,
    coordinates: route.coordinates.map(([lon, lat]) => ({ lat, lon })),
  };

  if (route.samples?.length) {
    payload.samples = route.samples.map((sample) => {
      const serialized: Record<string, unknown> = {
        coordinate: { lon: sample.coordinate[0], lat: sample.coordinate[1] },
      };
      if (sample.elevation !== undefined) serialized.elevation = sample.elevation;
      if (sample.time !== undefined) serialized.time = sample.time;
      // heartRate is never written by the ingestion spine (Art. 9 minimisation).
      if (sample.paceMinPerKm !== undefined) serialized.paceMinPerKm = sample.paceMinPerKm;
      return serialized;
    });
  } else {
    delete payload.samples;
  }

  Object.keys(payload).forEach((key) => {
    if (payload[key] === undefined) delete payload[key];
  });

  return payload;
}

function routeColorFor(source: ActivitySourceId): string {
  switch (source) {
    case "intervals_icu":
      return "#12ddfb";
    case "strava":
      return "#fc4c02";
    default:
      return "rgb(255 65 164)";
  }
}

async function storeRawPayload(input: {
  activityId: string;
  ownerUid: string;
  source: ActivitySourceId;
  file: SourceActivityFile;
}): Promise<RawPayloadRef | null> {
  // Opting out of raw retention entirely is a legitimate minimisation choice.
  if (process.env.STORE_RAW_PAYLOADS === "false") return null;

  const byteSize = Buffer.byteLength(input.file.content, "utf8");
  // Firestore documents cap at ~1 MiB; a long ultra track can exceed that.
  // The canonical record and geometry are already stored, so skipping the raw
  // copy loses nothing the product depends on.
  if (byteSize > 900_000) return null;

  const id = input.activityId.replace(/[^\w.-]/g, "_");
  await adminDb()
    .collection(RAW_PAYLOAD_COLLECTION)
    .doc(id)
    .set({
      id,
      activityId: input.activityId,
      ownerUid: input.ownerUid,
      source: input.source,
      format: input.file.format,
      content: input.file.content,
      byteSize,
      storedAt: new Date().toISOString(),
      retention: stampRetention("raw_payload_short"),
    });

  return { collection: RAW_PAYLOAD_COLLECTION, id, format: input.file.format, byteSize };
}

/**
 * Dedupe, then persist.
 *
 * Two independent checks:
 *   1. `(source, sourceActivityId)` \u2014 the same provider delivering twice, e.g.
 *      a webhook and the nightly reconciliation pull racing each other.
 *   2. content fingerprint \u2014 the same run arriving through two adapters. The
 *      later arrival is recorded as a duplicate and does not create a second
 *      route, so club stats and heatmaps are not silently doubled.
 */
export async function ingestActivity(input: {
  normalized: NormalizedActivity;
  file?: SourceActivityFile;
  consentId?: string;
  /** Preloaded once per run; fetched here if omitted. */
  candidates?: DedupeCandidate[];
}): Promise<IngestResult> {
  const { normalized } = input;
  const db = adminDb();
  const activityId = canonicalActivityId(normalized.source, normalized.sourceActivityId);

  if (!normalized.coordinates.length) {
    return { outcome: "skipped", activityId, reason: "no_gps_track" };
  }

  const fingerprint = fingerprintTrack({
    startedAt: normalized.startedAt,
    distanceMeters: normalized.distanceMeters,
    coordinates: normalized.coordinates,
  });
  const startPoint = normalized.coordinates[0];

  const activityRef = db.collection(ACTIVITY_COLLECTION).doc(activityId);
  const existing = await activityRef.get();
  const now = new Date().toISOString();

  // 2. Cross-adapter duplicate: same owner, same run, different source.
  if (!existing.exists) {
    const candidates = input.candidates ?? (await loadDedupeCandidates(normalized.ownerUid));
    const held = findDuplicate(candidates, {
      source: normalized.source,
      startedAt: normalized.startedAt,
      distanceMeters: normalized.distanceMeters,
      fingerprint,
      startPoint,
    });

    if (held) {
      // Recorded, not discarded: we remember that this provider also has the
      // run, so a later sync does not keep re-downloading it, but no second
      // route is created and club stats are not doubled.
      await activityRef.set({
        id: activityId,
        ownerUid: normalized.ownerUid,
        source: normalized.source,
        sourceActivityId: normalized.sourceActivityId,
        startedAt: normalized.startedAt,
        distanceMeters: Math.round(normalized.distanceMeters),
        fingerprint,
        startPoint,
        duplicateOf: held.id,
        ingestedAt: now,
        visibility: "private",
        retention: stampRetention("activity_user_lifetime"),
      });
      return { outcome: "duplicate", activityId, duplicateOf: held.id };
    }
  }

  const routeId = activityId.replace(/[^\w.-]/g, "_");
  const route: GPXRoute = {
    id: routeId,
    name: normalized.name,
    date: normalized.startedAt,
    coordinates: normalized.coordinates,
    distance: Math.round(normalized.distanceMeters),
    elevationGain: Math.round(normalized.elevationGainMeters),
    duration: Math.round((normalized.durationSeconds / 60) * 10) / 10,
    color: routeColorFor(normalized.source),
    type: normalized.sport === "trail_run" ? "trail" : "road",
    userId: normalized.ownerUid,
    samples: normalized.samples,
    activity: {
      id: activityId,
      source: normalized.source,
      sourceActivityId: normalized.sourceActivityId,
      ingestedAt: now,
    },
    // Private by default. Sharing is always a separate, deliberate action.
    visibility: "private",
    retention: stampRetention("activity_user_lifetime"),
  };

  await db.collection(ROUTE_COLLECTION).doc(routeId).set(serializeRoute(route), { merge: true });

  const rawFileRef = input.file
    ? await storeRawPayload({
        activityId,
        ownerUid: normalized.ownerUid,
        source: normalized.source,
        file: input.file,
      })
    : null;

  const activity: CanonicalActivity = {
    id: activityId,
    ownerUid: normalized.ownerUid,
    source: normalized.source,
    sourceActivityId: normalized.sourceActivityId,
    startedAt: normalized.startedAt,
    sport: normalized.sport,
    name: normalized.name,
    distanceMeters: Math.round(normalized.distanceMeters),
    durationSeconds: Math.round(normalized.durationSeconds),
    elevationGainMeters: Math.round(normalized.elevationGainMeters),
    trackRef: {
      collection: ROUTE_COLLECTION,
      id: routeId,
      pointCount: normalized.coordinates.length,
    },
    ingestedAt: existing.exists ? (existing.data() as CanonicalActivity).ingestedAt : now,
    fingerprint,
    startPoint,
    visibility: "private",
    retention: stampRetention("activity_user_lifetime"),
  };

  if (normalized.timezone) activity.timezone = normalized.timezone;
  if (normalized.sourceSport) activity.sourceSport = normalized.sourceSport;
  if (rawFileRef) activity.rawFileRef = rawFileRef;
  if (existing.exists) activity.updatedAt = now;
  if (input.consentId) activity.consentId = input.consentId;

  await activityRef.set(activity, { merge: true });

  return { outcome: existing.exists ? "updated" : "created", activityId };
}

/** Ids the spine already holds for a source, used to skip re-downloading files. */
export async function knownSourceActivityIds(
  ownerUid: string,
  source: ActivitySourceId,
): Promise<Set<string>> {
  const snap = await adminDb()
    .collection(ACTIVITY_COLLECTION)
    .where("ownerUid", "==", ownerUid)
    .where("source", "==", source)
    .select("sourceActivityId")
    .get();

  const ids = new Set<string>();
  snap.forEach((doc) => {
    const value = doc.get("sourceActivityId");
    if (typeof value === "string") ids.add(value);
  });
  return ids;
}
