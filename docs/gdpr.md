# GDPR — GPX Runner

A working document for whoever operates this deployment. It records what personal
data the system holds, why it is allowed to hold it, how long it keeps it, who
else touches it, and which endpoints implement the user's rights. It is not legal
advice and it is not marketing copy. Keep it accurate as the code changes.

**Last reviewed:** 2026-09-11, against the ingestion spine on
`feat/ingestion-intervals-icu`.

## Roles

The operator of this deployment is the **data controller**. GPS traces are
personal data about identifiable people — a home address is usually the first
and last point of a run — so this is not a borderline case. The controller is
based in Sweden, so Swedish implementation and the IMY are the relevant
supervisory context.

Users of the app are the **data subjects**. If the product later hosts run
clubs, club admins viewing shared routes are recipients, not separate
controllers, because the operator still decides purposes and means.

## What is held

| Data | Where | Source |
| --- | --- | --- |
| GPS track (lat/lon, elevation, timestamps) | `routes` | User upload, or an ingestion adapter |
| Activity summary (start time, distance, duration, elevation, name, sport) | `activities` | Same |
| Account profile (username, display name, avatar, totals) | `userProfiles` | User |
| Provider connection (external athlete id, scope, encrypted token) | `providerConnections` | OAuth or personal API key |
| Consent evidence (purpose, version, exact text, timestamp) | `consentRecords` | User action |
| Original provider file (GPX) | `rawActivityPayloads` | Ingestion adapter |
| Webhook delivery ids, erasure receipts | `webhookDeliveries`, `erasureLog` | System |

### What is deliberately not held

Heart rate, HRV, sleep, power, cadence, weight and every other physiological
metric are **special category data** under Art. 9. The ingestion spine does not
collect them:

- the intervals.icu activity list is requested with an explicit `fields`
  allow-list, so the metrics are never transferred;
- GPX downloads are requested with `hr=false&power=false`;
- the TCX parser in `src/engine/gpx.ts` skips `HeartRateBpm` by design;
- `store.ts` never writes a `heartRate` sample from an ingested activity.

This is a deliberate product boundary, not an oversight. Ingesting Art. 9 data
would require an Art. 9(2) exception — in practice explicit consent plus a
materially heavier compliance posture — for features this product does not need.

> Note: the older Strava sync at `/api/strava/sync` predates the spine and does
> store a heart-rate stream on routes it imports. It remains a personal-use
> adapter for the operator's own account. Before any multi-user or club feature
> touches Strava-imported routes, either strip that field or bring it under the
> Art. 9 regime.

## Lawful basis and purpose

| Processing | Basis | Purpose |
| --- | --- | --- |
| Pulling activities from a third-party provider | **Art. 6(1)(a) consent** | Bring the user's own runs into the app without manual export |
| Storing runs the user uploads, account data | **Art. 6(1)(b) contract** | Provide the service the user signed up for |
| Showing a route to a club or publicly | **Art. 6(1)(a) consent**, separate and opt-in | Club pages and shared routes |
| Webhook delivery ids, sync audit lines | **Art. 6(1)(f) legitimate interests** | Keep sync correct and debuggable; minimal and short-lived |

Purpose limitation: ingested data is used to show a user their own runs, to
generate and score routes, and — only where explicitly shared — to populate club
features. Any new purpose needs a new consent record, not a reinterpretation of
an old one.

Consent is captured **before** any third-party data is requested. There is no
code path that ingests without passing `requireConsent()` in
`src/lib/ingestion/consent.ts`. Each record stores the exact wording shown, its
version, and the timestamp, because Art. 7(1) requires the controller to be able
to demonstrate consent — a boolean proves nothing. Changing the wording bumps the
version, which invalidates old grants and forces re-consent.

## Retention

Configured in `src/lib/ingestion/retention.ts`, overridable by env var. Every
stored record carries its policy and expiry, so retention is a property of the
data rather than an assumption in a cleanup script.

| Policy | Default | Applies to |
| --- | --- | --- |
| `activity_user_lifetime` | until the user deletes it | Activities and tracks |
| `raw_payload_short` | 30 days (`RAW_PAYLOAD_RETENTION_DAYS`) | Original provider files |
| `consent_evidence` | 3 years (`CONSENT_RETENTION_DAYS`) | Consent records |
| `sync_audit` | 90 days (`SYNC_AUDIT_RETENTION_DAYS`) | Webhook deliveries, sync audit |

Raw payloads are stored in their own collection precisely so they can expire on
a shorter clock than the user's training history. Set `STORE_RAW_PAYLOADS=false`
to never retain them.

**Outstanding:** expiry is stamped but not yet swept. A scheduled job must delete
records whose `retention.expiresAt` has passed — otherwise these are intentions,
not retention periods. Until that job exists, the honest statement is that raw
payloads are *marked* for 30-day deletion.

## Security

- Provider tokens are encrypted at rest with **AES-256-GCM**
  (`src/lib/tokenCrypto.ts`), keyed from `TOKEN_ENCRYPTION_KEY`, with the
  envelope bound to `uid:source` as additional authenticated data so a stolen
  envelope cannot be replayed under another account.
- Tokens are never logged, never returned by any API route, and are excluded
  from the data export.
- OAuth state is HMAC-signed and provider-scoped (`src/lib/oauthState.ts`).
- The webhook rejects every delivery unless `INTERVALS_WEBHOOK_SECRET` is set
  and the delivery carries a matching signature or shared secret, and it
  de-duplicates retried deliveries.
- Firestore rules give clients read access only to their own activities and
  consent records, and no write access to any spine collection; encrypted
  credentials are unreadable by any client.
- Routes and activities default to `visibility: "private"`. Sharing is opt-in.

## Sub-processors and recipients

| Party | Role | What it sees |
| --- | --- | --- |
| Google (Firebase Auth, Firestore) | Sub-processor | All stored data, including GPS traces |
| intervals.icu | Source (independent controller of its own copy) | Receives our API calls; sends activity data the user consented to share |
| Strava | Source, personal-use adapter only | Same, for the operator's own account |
| openrouteservice / HeiGIT | Sub-processor | Coordinates sent for route generation |
| OpenFreeMap, OpenStreetMap, MapTiler, Stadia Maps, CARTO, Mapbox | Tile and geocoding providers, depending on `NEXT_PUBLIC_BASEMAP_PROVIDER` | Map viewport requests from the user's browser |
| Hosting provider | Sub-processor | Request logs |

**Outstanding:** confirm the Firestore region. If data sits outside the EEA, a
transfer mechanism is required. Route-generation calls send coordinates to
HeiGIT; the self-hosted OSRM option in `osrm/` avoids that hop entirely and is
the better choice if third-country transfer is a concern.

## User rights — implemented endpoints

All require a Firebase ID token as `Authorization: Bearer <token>`.

| Right | Endpoint | Behaviour |
| --- | --- | --- |
| Access, portability (Art. 15, 20) | `GET /api/gdpr/export` | Single JSON document with profile, activities, full route geometry, consents and connection metadata. `?includeRaw=1` embeds original provider files. Credentials excluded. |
| Erasure (Art. 17) | `POST /api/gdpr/erase` | Hard delete. Requires `{"confirm":"DELETE MY DATA"}`. `scope` is `account` or a single source id. Revokes upstream provider access first, then deletes activities, tracks, raw payloads, connections, consent records and the profile. Returns a receipt. |
| Consent, withdrawal (Art. 7) | `GET`/`POST /api/gdpr/consent` | Lists current wording and what the user agreed to; grants or withdraws a purpose in one call. |
| Withdraw provider access | `POST /api/intervals/disconnect` | Revokes at intervals.icu, deletes stored credentials, marks consent withdrawn. Keeps already-ingested activities — use the erasure endpoint to delete them. |

Erasure receipts are stored as a salted hash of the user id plus counts and a
timestamp, so the controller can demonstrate that an erasure happened without
retaining an identifier pointing back at the person.

**Outstanding:** rectification (Art. 16) is partly covered by ordinary route
editing in the app; there is no dedicated endpoint. Add one if activity metadata
becomes something a user cannot otherwise correct.

## User-facing surfaces

Three surfaces, deliberately separate. Merging any two of them — in particular
folding provider consent into signup — breaks the lawful basis, because consent
required to use the service is not freely given (Art. 7(4)).

| Surface | Where | What it is |
| --- | --- | --- |
| Terms and privacy notice | `LoginScreen` in `src/components/ui.tsx`, at account creation | Acceptance of the contract the service runs under (Art. 6(1)(b)). Stamped on the profile as `termsAcceptedAt` + `termsVersion`. Grants no provider access. |
| Privacy notice | `/privacy` (`src/app/privacy/page.tsx`) | The Art. 13 notice, public and unauthenticated. The user-facing counterpart of this document; controller name and contact come from `GDPR_CONTROLLER_NAME` and `GDPR_CONTACT_EMAIL` at request time. |
| Provider consent | `ProviderConsentDialog`, opened from the intervals.icu card on `/profile` | The Art. 6(1)(a) consent, asked at the moment of connecting. |
| Privacy and data | `/profile/privacy` | Connections, consent history, withdrawal, export, erasure. |

Rules the UI holds to, and which any redesign must keep:

- The consent dialog renders the exact `consentText()` string the server
  returned. It never paraphrases it, because the server stores what it showed as
  the evidence of consent. The plain-language summary beside it is labelled as a
  summary and sits outside the quoted text.
- The agreed `consentVersion` is echoed back on connect. On `409
  consent_version_mismatch` the dialog swaps in the returned wording, un-ticks
  the box and asks again, so agreement is always against words that were on
  screen.
- Nothing is ever pre-ticked, on any surface.
- The personal API key is a password field, sent once in a POST body, never in a
  query string, never written to `localStorage`, and never logged.
- Withdrawal is one click and sits on the same page as the consent history
  (Art. 7(3)). For `provider_ingest` it routes through
  `/api/intervals/disconnect`, so credentials are deleted rather than left live
  behind a withdrawn consent.
- Erasure requires typing `DELETE MY DATA` and surfaces the returned receipt,
  including any provider whose upstream revoke failed.
- Structured error codes from the ingestion layer are shown to the user with
  actionable copy, mapped in `src/lib/privacy.ts`.

Note that `/api/gdpr/erase` with `scope: "account"` deletes the data but not the
Firebase Auth user. The privacy page says so and points at the existing delete‑
account flow on `/profile`, which removes the sign-in itself.

## Before this goes live for other people

- [ ] Sweep expired records on a schedule (see Retention, above).
- [x] Publish a user-facing privacy notice (Art. 13) — at `/privacy`. This
      document stays internal; keep the two in step.
- [ ] Confirm the Firestore region and, if needed, a transfer mechanism.
- [ ] Decide whether a DPIA is warranted. Systematic collection of location data
      about a group of people points that way; the small scale points away.
      Document the decision either way.
- [ ] Strip or justify the heart-rate field on Strava-imported routes before any
      club feature can surface them.
- [ ] Once a legal entity exists, record it as the controller in
      `GDPR_CONTROLLER_NAME` and publish a contact address in
      `GDPR_CONTACT_EMAIL`.
