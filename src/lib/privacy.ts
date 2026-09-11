"use client";

import { useCallback, useEffect, useState } from "react";
import type { User } from "firebase/auth";
import { useAuth } from "@/lib/auth";
import type { ActivitySourceId, ConsentPurpose, ConsentRecord } from "@/app/types";

/**
 * Client side of the GDPR surfaces.
 *
 * Three distinct things live behind three distinct surfaces, and the split is
 * deliberate:
 *
 *   1. Terms and privacy notice at signup — lawful basis Art. 6(1)(b), contract.
 *      Accepting them is not "consent" in the GDPR sense and must not be styled
 *      or stored as if it were.
 *   2. Provider ingest consent — Art. 6(1)(a), asked at the moment of
 *      connecting, never bundled into signup. Art. 7(4): consent that is a
 *      precondition of the service is not freely given.
 *   3. The ongoing rights surface — access, portability, erasure and withdrawal.
 *
 * Nothing here paraphrases a consent text. The wording shown to the user is
 * always the exact string the server returned, and the version that came with
 * it is echoed back on the grant, so a stale tab cannot record agreement to
 * wording nobody read.
 */

// --- Terms acknowledgement (contract, not consent) ---------------------------

/** Bump when the signup wording changes. Stored on the profile as evidence. */
export const TERMS_VERSION = "2026-09-11.1";

/**
 * What the service holds under the contract basis, in plain words. This is the
 * signup summary — it is not a consent text and grants no provider access.
 */
export const SIGNUP_DATA_SUMMARY: { icon: string; label: string; detail: string }[] = [
  {
    icon: "mail",
    label: "Your email address",
    detail: "So you can sign in and recover your account.",
  },
  {
    icon: "route",
    label: "The runs you upload",
    detail:
      "GPS track, distance, elevation and time, so the app can draw your maps and your stats.",
  },
  {
    icon: "lock",
    label: "Private by default",
    detail: "Nothing you upload is shared with anyone unless you choose to share it.",
  },
  {
    icon: "ecg_heart",
    label: "No health metrics",
    detail: "Heart rate, HRV and sleep are never collected or stored.",
  },
];

/**
 * Stamped onto the profile when an account is created. Records *which* wording
 * was accepted, not just that a box was ticked, so the acknowledgement can be
 * shown back to the user and re-asked when the terms change.
 */
export function termsAcknowledgement(): { termsAcceptedAt: string; termsVersion: string } {
  return { termsAcceptedAt: new Date().toISOString(), termsVersion: TERMS_VERSION };
}

// --- Views over the API responses -------------------------------------------

export interface ConsentTextView {
  version: string;
  text: string;
}

export interface ProviderConnectionView {
  source: ActivitySourceId;
  externalId: string;
  displayName?: string;
  scope?: string;
  authMode: "oauth" | "api_key";
  connectedAt: string;
  lastSyncAt?: string;
}

/** `GET /api/intervals/connect` */
export interface IntervalsConnectState {
  consent: ConsentTextView;
  scope: string;
  connection: ProviderConnectionView | null;
}

/** `GET /api/gdpr/consent` */
export interface ConsentStateView {
  available: { key: string; version: string; text: string }[];
  granted: ConsentRecord[];
}

/** `POST /api/intervals/sync` */
export interface IngestionRunView {
  mode: "recent" | "backfill";
  scanned: number;
  eligible: number;
  imported: number;
  updated: number;
  duplicates: number;
  skipped: { sourceActivityId: string; reason: string }[];
}

/** `POST /api/gdpr/erase` */
export interface ErasureReceiptView {
  receiptId: string;
  scope: "account" | ActivitySourceId;
  erasedAt: string;
  deleted: Record<string, number>;
  upstreamRevoked: ActivitySourceId[];
  upstreamFailed: ActivitySourceId[];
  confirmation: string;
}

/** The literal string `/api/gdpr/erase` demands before it deletes anything. */
export const ERASURE_CONFIRMATION = "DELETE MY DATA";

// --- Errors ------------------------------------------------------------------

/**
 * The ingestion layer already returns structured codes. Carrying the code to
 * the UI is the whole point: "something went wrong" tells the user nothing they
 * can act on, "intervals.icu rejected your API key" tells them exactly what to
 * fix.
 */
const ERROR_COPY: Record<string, string> = {
  consent_missing:
    "You have not agreed to import activities from this provider yet. Connect it and agree to the consent text first.",
  consent_outdated:
    "The consent wording has changed since you agreed. Read the new wording and agree again to keep importing.",
  consent_version_mismatch:
    "The consent wording was updated while this page was open. Read the new wording below and agree again.",
  provider_not_connected:
    "No intervals.icu connection is stored for your account. Connect it before syncing.",
  token_decrypt_failed:
    "Your stored intervals.icu credentials could not be read. Disconnect and connect again.",
  encryption_key_missing:
    "This server is not set up to store provider credentials, so nothing was saved. The operator needs to set TOKEN_ENCRYPTION_KEY.",
  intervals_env_missing:
    "This server is missing its intervals.icu API credentials. The operator needs to set INTERVALS_CLIENT_ID and INTERVALS_CLIENT_SECRET.",
  intervals_token_exchange_failed:
    "intervals.icu rejected the authorisation. Start the connection again.",
  intervals_authorization_failed:
    "intervals.icu rejected your credentials. If you connected with an API key, check it in your intervals.icu settings and connect again.",
  intervals_rate_limited:
    "intervals.icu is rate-limiting us. Wait a few minutes, then run the sync again.",
  intervals_unavailable:
    "intervals.icu is not responding. Nothing was changed — try again later.",
  intervals_api_failed:
    "intervals.icu returned an unexpected error. Try again; if it keeps happening, disconnect and reconnect.",
  firebase_config_failed:
    "The server could not reach its database, so nothing was changed. The operator needs to check the Firebase configuration.",
  confirmation_required: `Type ${ERASURE_CONFIRMATION} exactly to confirm.`,
  unknown_scope: "That data scope does not exist.",
  sync_failed: "The sync did not finish. Importing is repeatable, so try again.",
  http_401: "Your session has expired. Sign in again.",
  http_403: "You are not allowed to do that.",
  network_error: "Could not reach the server. Check your connection and try again.",
};

export function privacyErrorMessage(code: string, fallback?: string): string {
  return ERROR_COPY[code] ?? fallback ?? "The request failed. Try again.";
}

export class PrivacyApiError extends Error {
  code: string;
  status: number;
  /** Present on a 409: the wording that must now be shown and agreed to. */
  consent?: ConsentTextView;

  constructor(
    message: string,
    options: { code: string; status: number; consent?: ConsentTextView },
  ) {
    super(message);
    this.name = "PrivacyApiError";
    this.code = options.code;
    this.status = options.status;
    this.consent = options.consent;
  }
}

export interface ErrorView {
  message: string;
  code: string;
}

export function toErrorView(error: unknown): ErrorView {
  if (error instanceof PrivacyApiError) return { message: error.message, code: error.code };
  return {
    message: privacyErrorMessage("network_error"),
    code: "network_error",
  };
}

// --- Fetch helpers -----------------------------------------------------------

/**
 * Every data-rights call is authenticated with a fresh Firebase ID token.
 *
 * Secrets only ever travel in a POST body over HTTPS — never in a query string,
 * where they would land in server logs and browser history — and no request or
 * response body is ever written to the console.
 */
export async function privacyFetch(
  user: User,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const idToken = await user.getIdToken();
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${idToken}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return fetch(path, { ...init, headers, cache: "no-store" });
}

export async function privacyJson<T>(
  user: User,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  let res: Response;
  try {
    res = await privacyFetch(user, path, init);
  } catch {
    throw new PrivacyApiError(privacyErrorMessage("network_error"), {
      code: "network_error",
      status: 0,
    });
  }

  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;

  if (!res.ok) {
    const code = typeof data?.code === "string" ? data.code : `http_${res.status}`;
    const serverMessage = typeof data?.error === "string" ? data.error : undefined;
    throw new PrivacyApiError(privacyErrorMessage(code, serverMessage), {
      code,
      status: res.status,
      consent: (data?.consent as ConsentTextView | undefined) ?? undefined,
    });
  }

  return data as T;
}

// --- Hooks -------------------------------------------------------------------

/**
 * Firebase auth in this app resolves *after* the first render, so a hook that
 * bails out on a null uid never recovers when the user turns up a tick later.
 * These hooks therefore track `authLoading` explicitly: stay in a loading state
 * until auth has settled, then load, and re-run when the uid changes.
 */
function useAuthedResource<T>(path: string | null) {
  const { user, loading: authLoading } = useAuth();
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ErrorView | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (authLoading) {
      // Auth has not settled. Not an error, and not "signed out" either.
      setLoading(true);
      return;
    }
    if (!user || !path) {
      setData(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    privacyJson<T>(user, path)
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(toErrorView(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [user, authLoading, path, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  return { user, authLoading, data, setData, loading, error, setError, reload };
}

export function useIntervalsConnection() {
  return useAuthedResource<IntervalsConnectState>("/api/intervals/connect");
}

export function useConsentState() {
  return useAuthedResource<ConsentStateView>("/api/gdpr/consent");
}

// --- Shared helpers ----------------------------------------------------------

export function consentKeyOf(purpose: ConsentPurpose, source?: ActivitySourceId): string {
  return source ? `${purpose}:${source}` : purpose;
}

export const PURPOSE_LABELS: Record<ConsentPurpose, string> = {
  provider_ingest: "Import my activities from a provider",
  club_sharing: "Show my shared routes to a run club",
  public_sharing: "Show my routes publicly",
};

export const SOURCE_LABELS: Partial<Record<ActivitySourceId, string>> = {
  intervals_icu: "intervals.icu",
  strava: "Strava",
  garmin: "Garmin",
  apple_health: "Apple Health",
  file_upload: "File upload",
};

export function sourceLabel(source?: ActivitySourceId): string {
  if (!source) return "";
  return SOURCE_LABELS[source] ?? source;
}

export function formatDateTime(value?: string): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "—";
  return date.toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * A grant against superseded wording is not a live consent: `requireConsent`
 * on the server rejects it, so the UI must say so rather than showing a green
 * tick next to something that will fail on the next sync.
 */
export function isStaleConsent(record: ConsentRecord, state: ConsentStateView | null): boolean {
  if (!record.granted || !state) return false;
  const current = state.available.find(
    (entry) => entry.key === consentKeyOf(record.purpose, record.source),
  );
  return Boolean(current && current.version !== record.version);
}
