import { haversineMeters } from "@/engine/utils/geo";
import { adminDb } from "@/lib/firebaseAdmin";
import { fingerprintTrack } from "./fingerprint";
import { stampRetention } from "./retention";
import { decideActivityScope } from "./sportPolicy";
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

/**
 * Firestore stops at 1 MiB per document, and indexes every element of an array
 * of maps. A track is the only field here that grows without bound, and
 * intervals.icu serves its GPX from per-second streams — so a three-hour run
 * arrives as ~11,000 points whatever the watch originally recorded, and the
 * write is rejected outright. Because the loop writes one activity at a time,
 * the shorter runs earlier in the same sync were already stored: the import
 * looked half-done, and every retry died on the same long run.
 *
 * So the geometry is thinned before it is written, never truncated — the run
 * still ends where he stopped. 4,000 points across a 50 km ultra is a point
 * every 12 m, finer than anything downstream reads: the familiarity index
 * simplifies to 18 m, street coverage to 30 m, the map draws 500.
 */
export const MAX_STORED_TRACK_POINTS = 4000;

/** The same cap the browser upload path has always applied to samples. */
export const MAX_STORED_SAMPLES = 900;

/**
 * Keep at most `maxItems`, evenly spaced, always including the last one.
 * Sampling coarser rather than cutting short is the whole point: a truncated
 * track is a different run, a thinned one is the same run drawn with fewer
 * pencil strokes.
 */
export function thinForStorage<T>(items: T[], maxItems: number): T[] {
  if (items.length <= maxItems) return items;
  const step = Math.ceil(items.length / maxItems);
  const kept = items.filter((_, index) => index % step === 0);
  const last = items[items.length - 1];
  if (kept[kept.length - 1] !== last) kept.push(last);
  return kept;
}

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

  // Fail closed, a second time. The sync loop already applied the sport policy
  // to the provider summary; this re-applies it to what was actually parsed out
  // of the file, so a webhook path, a future adapter or a provider that lied in
  // its summary still cannot create an app-visible indoor or trackless
  // activity. Nothing is written when this rejects — not even a stub.
  const scope = decideActivityScope({
    sport: normalized.sport,
    sourceSport: normalized.sourceSport,
    indoor: normalized.indoor,
    uploadSource: normalized.uploadSource,
    hasTrack: normalized.coordinates.length > 0,
    distanceMeters: normalized.distanceMeters,
  });
  if (!scope.ingest) {
    return { outcome: "skipped", activityId, reason: scope.reason };
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
  // Thinned for storage only. The fingerprint and the duplicate check above ran
  // against the full-resolution track, so what we hold stays comparable with
  // the same run arriving from another provider.
  const storedCoordinates = thinForStorage(normalized.coordinates, MAX_STORED_TRACK_POINTS);
  const storedSamples = normalized.samples?.length
    ? thinForStorage(normalized.samples, MAX_STORED_SAMPLES)
    : undefined;

  const route: GPXRoute = {
    id: routeId,
    name: normalized.name,
    date: normalized.startedAt,
    coordinates: storedCoordinates,
    distance: Math.round(normalized.distanceMeters),
    elevationGain: Math.round(normalized.elevationGainMeters),
    duration: Math.round((normalized.durationSeconds / 60) * 10) / 10,
    color: routeColorFor(normalized.source),
    type: normalized.sport === "trail_run" ? "trail" : "road",
    userId: normalized.ownerUid,
    samples: storedSamples,
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
      pointCount: storedCoordinates.length,
    },
    ingestedAt: existing.exists ? (existing.data() as CanonicalActivity).ingestedAt : now,
    fingerprint,
    startPoint,
    visibility: "private",
    retention: stampRetention("activity_user_lifetime"),
  };

  if (normalized.timezone) activity.timezone = normalized.timezone;
  if (normalized.sourceSport) activity.sourceSport = normalized.sourceSport;
  // Stored so the reconciliation pass can re-judge this record later without
  // going back to the provider.
  if (normalized.indoor !== undefined) activity.indoor = normalized.indoor;
  if (normalized.uploadSource) activity.uploadSource = normalized.uploadSource;
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
