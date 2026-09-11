// ---------------------------------------------------------------------------
// Activity ingestion spine
// ---------------------------------------------------------------------------
// GPX Runner owns its canonical activity model. Every sync provider is a
// swappable adapter that normalises into `CanonicalActivity`; no provider type
// is allowed to leak into the rest of the app. An adapter can be removed (API
// shut down, terms change, legal entity missing) without the product losing its
// data or its shape.
//
// GDPR NOTE (the model is the contract, so the notes live on the model):
//   Controller:      the operator of this GPX Runner deployment (Sweden/EU).
//   Personal data:   GPS traces are location data about an identified person.
//   Lawful basis:    Art. 6(1)(a) consent for third-party ingestion (recorded in
//                    `ConsentRecord` before any pull), Art. 6(1)(b) contract for
//                    activities the user uploads themselves to use the service.
//   Purpose limit:   show a user their own runs, generate routes, and — only
//                    where the user opted in — share routes with a club.
//                    Ingested data must not be repurposed without new consent.
//   Art. 9 minimisation: heart rate, HRV, sleep, power and other physiological
//                    metrics are SPECIAL CATEGORY health data. This spine
//                    deliberately does NOT ingest or store them. Adapters must
//                    request GPS + summary only. If a provider returns them
//                    anyway, drop them at normalisation — do not persist.
//   Storage limit:   every stored record carries `retention`, and raw provider
//                    payloads are kept separately with a shorter TTL.
// ---------------------------------------------------------------------------

/**
 * Registered ingestion adapters. Adding a provider means adding an id here and
 * an `ActivitySource` implementation — nothing else in the app changes.
 */
export type ActivitySourceId =
  | 'intervals_icu'
  | 'strava'
  | 'garmin'
  | 'apple_health'
  | 'file_upload';

/** Sport is normalised across providers; we only ingest foot sports today. */
export type CanonicalSport = 'run' | 'trail_run' | 'walk' | 'hike' | 'other';

/**
 * Sharing is opt-in. Anything ingested starts at `private` and only a deliberate
 * user action moves it outwards. Never default this to anything else.
 */
export type ActivityVisibility = 'private' | 'club' | 'public';

/**
 * Retention policies are named so they can be reasoned about and changed in one
 * place. Concrete durations live in `src/lib/ingestion/retention.ts`.
 */
export type RetentionPolicyId =
  | 'activity_user_lifetime' // kept until the user deletes it or their account
  | 'raw_payload_short' // provider payloads, short TTL, debugging/reprocessing only
  | 'consent_evidence' // consent proof, kept to demonstrate Art. 7(1) compliance
  | 'sync_audit'; // sync/webhook audit lines

/** Stamped onto every stored record so retention is a property of the data. */
export interface RetentionStamp {
  policy: RetentionPolicyId;
  /** ISO timestamp after which the record is eligible for deletion, if bounded. */
  expiresAt?: string;
}

/**
 * The provider-agnostic activity. This is the only activity shape the rest of
 * the product is allowed to know about.
 */
export interface CanonicalActivity {
  /** Our id, always `${source}:${sourceActivityId}` — stable and collision-free. */
  id: string;
  ownerUid: string;
  source: ActivitySourceId;
  /** The provider's own id for this activity, as a string (ids are not all numeric). */
  sourceActivityId: string;
  /** Instant the activity started, ISO 8601 UTC. */
  startedAt: string;
  /** IANA zone the activity was recorded in, when the provider reports it. */
  timezone?: string;
  sport: CanonicalSport;
  /** Raw provider sport label, kept for debugging and for better mapping later. */
  sourceSport?: string;
  name: string;
  distanceMeters: number;
  /** Moving time where the provider distinguishes it, else elapsed. */
  durationSeconds: number;
  elevationGainMeters: number;
  /**
   * Reference to the stored geometry. The track itself lives in the `routes`
   * collection (existing `GPXRoute` documents) so maps, heatmaps and
   * familiarity keep working unchanged.
   */
  trackRef: ActivityTrackRef;
  /** Pointer to the retained raw provider file, if one was kept. */
  rawFileRef?: RawPayloadRef;
  ingestedAt: string;
  /** Set when a later sync updated the record. */
  updatedAt?: string;
  /** Content fingerprint: the exact-match fast path for dedupe. */
  fingerprint: string;
  /** First track point, [lon, lat]. Used by the tolerant duplicate check. */
  startPoint?: [number, number];
  /** Set when this record was recognised as the same run from another source. */
  duplicateOf?: string;
  /** Opt-in sharing. Always `private` at ingest time. */
  visibility: ActivityVisibility;
  retention: RetentionStamp;
  /** Id of the consent record that authorised this ingestion, when applicable. */
  consentId?: string;
}

export interface ActivityTrackRef {
  /** Firestore collection holding the geometry, currently always `routes`. */
  collection: string;
  /** Document id in that collection. */
  id: string;
  pointCount: number;
}

export interface RawPayloadRef {
  collection: string;
  id: string;
  /** `gpx` | `tcx` | `fit` | `json` */
  format: string;
  byteSize: number;
}

/** A single activity as the provider lists it, before any file is downloaded. */
export interface SourceActivitySummary {
  sourceActivityId: string;
  startedAt: string;
  timezone?: string;
  name: string;
  sourceSport?: string;
  sport: CanonicalSport;
  distanceMeters: number;
  durationSeconds: number;
  elevationGainMeters: number;
  /** False when the provider tells us there is no GPS track to fetch. */
  hasTrack: boolean;
}

/** Downloaded activity file, still unparsed. */
export interface SourceActivityFile {
  format: 'gpx' | 'tcx';
  content: string;
}

/** Where a cursor-based `listActivitiesSince` should resume from. */
export interface ActivityCursor {
  /** ISO timestamp; adapters list activities that started at or after this. */
  since: string;
  /** Upper bound, defaults to now. */
  until?: string;
  limit?: number;
}

export interface ActivityListPage {
  activities: SourceActivitySummary[];
  /** Cursor to persist for the next reconciliation run. */
  nextCursor: ActivityCursor;
}

/**
 * Credentials an adapter needs for one user, already decrypted by the caller.
 * Adapters never touch Firestore or the encryption key themselves.
 */
export interface SourceCredentials {
  accessToken?: string;
  /** Personal API key path (single-user fallback). */
  apiKey?: string;
  /** Provider-side account id, e.g. the intervals.icu athlete id. */
  externalId?: string;
  scope?: string;
}

export interface ConnectResult {
  externalId: string;
  displayName?: string;
  scope?: string;
  accessToken?: string;
  apiKey?: string;
}

/**
 * The adapter contract. Implement these five operations and the provider is
 * fully wired into the spine — ingestion, dedupe, retention, export and erasure
 * all work without further provider-specific code.
 */
export interface ActivitySource {
  readonly id: ActivitySourceId;
  /** Human label for UI and for the consent text. */
  readonly displayName: string;

  /** Complete an authorisation handshake and return what we must store. */
  connect(input: ActivitySourceConnectInput): Promise<ConnectResult>;

  /** Revoke upstream access. Must be safe to call on an already-dead token. */
  disconnect(credentials: SourceCredentials): Promise<void>;

  /** List activities from a cursor forward, newest-safe and resumable. */
  listActivitiesSince(
    credentials: SourceCredentials,
    cursor: ActivityCursor,
  ): Promise<ActivityListPage>;

  /** Download one activity as a parseable track file (GPX or TCX). */
  fetchActivityFile(
    credentials: SourceCredentials,
    sourceActivityId: string,
  ): Promise<SourceActivityFile | null>;

  /** Normalise a provider summary plus its track file into our canonical shape. */
  normalize(input: NormalizeInput): NormalizedActivity;
}

export interface ActivitySourceConnectInput {
  /** OAuth authorisation code, when the adapter uses OAuth. */
  code?: string;
  /** Personal API key, when the adapter supports that fallback. */
  apiKey?: string;
  redirectUri?: string;
}

export interface NormalizeInput {
  ownerUid: string;
  summary: SourceActivitySummary;
  file: SourceActivityFile;
}

/**
 * Adapter output: the canonical activity minus the fields only the store can
 * fill in (track/raw refs, retention, ids), plus the parsed geometry.
 */
export interface NormalizedActivity {
  ownerUid: string;
  source: ActivitySourceId;
  sourceActivityId: string;
  startedAt: string;
  timezone?: string;
  sport: CanonicalSport;
  sourceSport?: string;
  name: string;
  distanceMeters: number;
  durationSeconds: number;
  elevationGainMeters: number;
  /** [lon, lat] pairs, GeoJSON order, matching `GPXRoute.coordinates`. */
  coordinates: [number, number][];
  /** Elevation/time only. Never heart rate — see the Art. 9 note above. */
  samples?: RouteMetricSample[];
}

// --- Consent -----------------------------------------------------------------

/**
 * Consent is per purpose, not a single blanket flag, so a user can allow
 * ingestion without allowing club sharing.
 */
export type ConsentPurpose =
  | 'provider_ingest' // pull my activities from a named third-party provider
  | 'club_sharing' // show my routes on a club page
  | 'public_sharing'; // show my routes publicly

/**
 * Art. 7(1) requires the controller to be able to *demonstrate* consent, so we
 * store the exact text shown, its version, and when it was given — not a bare
 * boolean. Withdrawal is recorded rather than deleted, so the audit trail
 * survives (Art. 7(3): withdrawal must be as easy as giving consent).
 */
export interface ConsentRecord {
  id: string;
  uid: string;
  purpose: ConsentPurpose;
  /** Which provider this consent covers, for `provider_ingest`. */
  source?: ActivitySourceId;
  /** Version of the consent text, bumped whenever the wording changes. */
  version: string;
  /** The exact wording the user agreed to, stored verbatim as evidence. */
  text: string;
  granted: boolean;
  grantedAt: string;
  withdrawnAt?: string;
  retention: RetentionStamp;
}

/**
 * Stored provider connection. Tokens are AES-256-GCM encrypted at rest and are
 * never written to logs or returned by any API route.
 */
export interface ProviderConnection {
  uid: string;
  source: ActivitySourceId;
  externalId: string;
  displayName?: string;
  scope?: string;
  /** Encrypted envelope, see `src/lib/tokenCrypto.ts`. Never plaintext. */
  accessTokenEnc?: string;
  /** Encrypted personal API key, for the single-user fallback path. */
  apiKeyEnc?: string;
  /** How the connection was authorised. */
  authMode: 'oauth' | 'api_key';
  connectedAt: string;
  updatedAt: string;
  lastSyncAt?: string;
  /** Resume point for cursor-based reconciliation. */
  cursor?: ActivityCursor;
  consentId?: string;
}

export interface RouteMetricSample {
  coordinate: [number, number]; // [lon, lat]
  elevation?: number;
  time?: string;
  heartRate?: number;
  paceMinPerKm?: number;
}

export interface GPXRoute {
  id: string;
  name: string;
  date: string;
  coordinates: [number, number][]; // [lon, lat]
  distance: number; // meters
  elevationGain: number; // meters
  duration?: number; // minutes
  color: string;
  userId?: string; // Firebase user ID for cloud sync
  type?: 'road' | 'trail' | 'mixed'; // Route type tag
  countries?: string[];
  isWishlisted?: boolean;
  isFavorite?: boolean;
  isRoundTrip?: boolean;
  startPoint?: [number, number];
  samples?: RouteMetricSample[];
  hasTcx?: boolean;
  strava?: {
    activityId: number;
    sportType?: string;
    syncedAt: string;
  };
  /**
   * Ingestion-spine linkage. Routes created by an adapter point back at their
   * `CanonicalActivity` so export and erasure can find every artefact of one
   * ingested run. Legacy routes and the existing Strava sync leave this unset.
   */
  activity?: {
    id: string;
    source: ActivitySourceId;
    sourceActivityId: string;
    ingestedAt: string;
  };
  /** Opt-in sharing; absent means private. */
  visibility?: ActivityVisibility;
  retention?: RetentionStamp;
}

export interface RouteStats {
  totalRuns: number;
  totalDistance: number; // km
  totalElevation: number; // meters
  totalTime: number; // minutes
}

export interface RouteFilter {
  year?: string; // YYYY
  month?: string; // MM
  minDistance?: number; // km
  maxDistance?: number; // km
  type?: 'road' | 'trail' | 'mixed' | 'all'; // Filter by route type
  country?: string;
}

export interface RouteSuggestionRequest {
  distance: number; // km
  type: 'road' | 'trail' | 'mixed';
  avoidFamiliar: boolean;
  centerLat: number;
  centerLon: number;
  existingRoutes?: { coordinates: [number, number][] }[];
}

export interface RouteSuggestion {
  coordinates: [number, number][];
  distance: number;
  elevationGain: number;
  name: string;
  startPoint?: [number, number]; // [lon, lat]
  isRoundTrip?: boolean;
  familiarityScore?: number; // 0-100 percentage
}

export interface UserProfile {
  [key: string]: any;
  username: string; // unique login username
  displayName: string;
  avatar: string; // Material Symbols icon name
  joinedAt: string; // ISO date string
  /**
   * When the user accepted the terms and the privacy notice at signup, and the
   * version of that wording.
   *
   * This is NOT consent. Accepting the terms is Art. 6(1)(b) — the contract the
   * service is provided under — and it authorises nothing beyond running the
   * service. Permission to pull data from a third-party provider is Art.
   * 6(1)(a) consent, is asked separately at the moment of connecting, and lives
   * in `ConsentRecord`. Never treat this field as a provider grant.
   */
  termsAcceptedAt?: string;
  termsVersion?: string;
  totalRuns: number; // cached count
  totalDistance: number; // cached km
  userId?: string; // Firebase UID (stored in document)
  wishlisted?: string[]; // array of route IDs
  favorites?: string[]; // array of route IDs
  strava?: {
    athleteId: number;
    athleteName?: string;
    scope: string;
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    connectedAt: string;
    updatedAt: string;
  };
}
