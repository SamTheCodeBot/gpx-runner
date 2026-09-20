"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  formatDateTime,
  privacyJson,
  toErrorView,
  useIntervalsConnection,
  type ErrorView,
  type IngestionRunView,
  type ProviderConnectionView,
} from "@/lib/privacy";
import { Icon } from "@/components/ui";
import { ProviderConsentDialog } from "@/components/ProviderConsentDialog";

/**
 * The intervals.icu connection surface, on the profile page beside Strava.
 *
 * Connecting always goes through `ProviderConsentDialog`: there is no path in
 * this component that starts an authorisation without the consent text having
 * been shown and agreed to first, which is the same order the backend enforces.
 */

/** The OAuth callback lands back here with one of these in the query string. */
const CALLBACK_MESSAGES: Record<string, { tone: "ok" | "warn" | "error"; text: string }> = {
  connected: { tone: "ok", text: "intervals.icu connected. Run a sync to import your runs." },
  denied: { tone: "warn", text: "You declined at intervals.icu, so nothing was connected." },
  consent: {
    tone: "warn",
    text: "Consent was missing or withdrawn, so the connection was not completed. Start again and agree to the permission text.",
  },
  error: {
    tone: "error",
    text: "The intervals.icu connection could not be completed. Nothing was stored — try connecting again.",
  },
};

/** Machine reasons from the ingestion run, said out loud. */
function skippedLabel(reason: string): string {
  if (reason.startsWith("sport_not_ingested")) return "not a foot sport";
  switch (reason) {
    case "already_ingested":
      return "already imported";
    case "no_gps_track":
      return "no GPS track";
    case "no_file":
      return "no file at intervals.icu";
    case "download_limit":
      return "left for the next sync";
    default:
      return reason;
  }
}

function summarizeRun(run: IngestionRunView): string {
  const parts: string[] = [];
  if (run.imported) parts.push(`imported ${run.imported}`);
  if (run.updated) parts.push(`updated ${run.updated}`);
  if (run.duplicates) parts.push(`${run.duplicates} already here from another source`);

  const skipped = run.skipped.reduce<Record<string, number>>((acc, entry) => {
    const label = skippedLabel(entry.reason);
    acc[label] = (acc[label] ?? 0) + 1;
    return acc;
  }, {});
  const skippedText = Object.entries(skipped)
    .map(([label, count]) => `${count} ${label}`)
    .join(", ");

  // A failure no longer stops the run, so it has to be said out loud — an
  // import that quietly left two runs behind is worse than one that admits it.
  const failedCount = run.failed?.length ?? 0;
  const failedText = failedCount
    ? ` ${failedCount} could not be imported and will be retried on the next sync.`
    : "";

  if (parts.length === 0) {
    return run.scanned === 0
      ? "No activities found in that window."
      : `Nothing new to import${skippedText ? ` — ${skippedText}.` : "."}${failedText}`;
  }
  return `Scanned ${run.scanned}: ${parts.join(", ")}${skippedText ? `. Skipped ${skippedText}` : ""}.${failedText}`;
}

export function IntervalsConnectionCard() {
  const { user, authLoading, data, setData, loading, error, reload } = useIntervalsConnection();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [callbackStatus, setCallbackStatus] = useState("");
  const [busy, setBusy] = useState<"recent" | "backfill" | "disconnect" | null>(null);
  const [actionError, setActionError] = useState<ErrorView | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    setCallbackStatus(new URLSearchParams(window.location.search).get("intervals") || "");
  }, []);

  const connection = data?.connection ?? null;

  const runSync = async (mode: "recent" | "backfill") => {
    if (!user) return;
    setBusy(mode);
    setActionError(null);
    setMessage("");
    try {
      const run = await privacyJson<IngestionRunView>(user, "/api/intervals/sync", {
        method: "POST",
        body: JSON.stringify({ mode }),
      });
      setMessage(summarizeRun(run));
      reload();
    } catch (caught) {
      setActionError(toErrorView(caught));
    } finally {
      setBusy(null);
    }
  };

  /**
   * Withdrawal in one click (Art. 7(3)): revokes at intervals.icu, deletes the
   * stored credentials and marks the consent withdrawn. Already-imported runs
   * stay — deleting those is a separate, deliberate action.
   */
  const disconnect = async () => {
    if (!user) return;
    setBusy("disconnect");
    setActionError(null);
    setMessage("");
    try {
      await privacyJson<{ ok: boolean }>(user, "/api/intervals/disconnect", { method: "POST" });
      setData(data ? { ...data, connection: null } : null);
      setCallbackStatus("");
      setMessage("Disconnected and consent withdrawn. The runs already imported are still here.");
    } catch (caught) {
      setActionError(toErrorView(caught));
    } finally {
      setBusy(null);
    }
  };

  const handleConnected = (fresh: ProviderConnectionView) => {
    setDialogOpen(false);
    setCallbackStatus("");
    setMessage("intervals.icu connected. Run a sync to import your runs.");
    setData(data ? { ...data, connection: fresh } : null);
  };

  const callback = CALLBACK_MESSAGES[callbackStatus];
  const busyAny = busy !== null;

  return (
    <div className="bg-surface-container-lowest rounded-3xl p-6 shadow-sm border border-outline-variant/10">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-2xl bg-primary/10 flex items-center justify-center shrink-0">
          <Icon name="monitoring" className="text-primary text-xl" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[10px] font-extrabold uppercase tracking-wider text-on-surface-variant">
            intervals.icu
          </p>
          <h2 className="text-sm font-extrabold text-on-surface mt-0.5">
            {connection ? "Connected to intervals.icu" : "Connect intervals.icu"}
          </h2>
          <p className="text-xs text-on-surface-variant mt-1">
            {connection
              ? "Your runs are imported with their GPS track and summary. No health metrics are ever read."
              : "Import your runs automatically. You will see exactly what is read, and agree to it, before anything connects."}
          </p>
        </div>
      </div>

      {(authLoading || loading) && (
        <div className="mt-4 h-10 bg-surface-container rounded-xl animate-pulse" />
      )}

      {!authLoading && !loading && (
        <>
          {callback && (
            <div
              className={`mt-3 px-3 py-2 rounded-xl text-xs ${
                callback.tone === "ok"
                  ? "bg-secondary-container text-on-secondary-container"
                  : callback.tone === "warn"
                    ? "bg-surface-container text-on-surface-variant"
                    : "bg-error-container text-error"
              }`}
            >
              {callback.text}
            </div>
          )}

          {error && (
            <div className="mt-3 px-3 py-2 bg-error-container rounded-xl">
              <p className="text-xs font-medium text-error">{error.message}</p>
              <p className="text-[10px] text-error/70 mt-0.5 font-mono">{error.code}</p>
            </div>
          )}

          {actionError && (
            <div className="mt-3 px-3 py-2 bg-error-container rounded-xl">
              <p className="text-xs font-medium text-error">{actionError.message}</p>
              <p className="text-[10px] text-error/70 mt-0.5 font-mono">{actionError.code}</p>
            </div>
          )}

          {message && (
            <div className="mt-3 px-3 py-2 bg-secondary-container text-on-secondary-container text-xs rounded-xl">
              {message}
            </div>
          )}

          {connection ? (
            <>
              <dl className="mt-4 space-y-1.5 text-xs">
                <div className="flex justify-between gap-3">
                  <dt className="text-on-surface-variant">Account</dt>
                  <dd className="text-on-surface font-medium text-right truncate">
                    {connection.displayName || connection.externalId}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-on-surface-variant">Authorised with</dt>
                  <dd className="text-on-surface font-medium text-right">
                    {connection.authMode === "api_key" ? "Personal API key" : "OAuth"}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-on-surface-variant">Connected</dt>
                  <dd className="text-on-surface font-medium text-right">
                    {formatDateTime(connection.connectedAt)}
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-on-surface-variant">Last sync</dt>
                  <dd className="text-on-surface font-medium text-right">
                    {connection.lastSyncAt ? formatDateTime(connection.lastSyncAt) : "Never"}
                  </dd>
                </div>
              </dl>

              <div className="mt-4 grid grid-cols-1 gap-2">
                <button
                  type="button"
                  onClick={() => runSync("recent")}
                  disabled={busyAny}
                  className="w-full py-3 bg-primary text-on-primary rounded-xl text-sm font-bold hover:opacity-90 transition-opacity disabled:opacity-40 flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-primary/40"
                >
                  {busy === "recent" ? (
                    <>
                      <Icon name="progress_activity" className="text-base animate-spin" /> Syncing…
                    </>
                  ) : (
                    "Sync last 30 days"
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => runSync("backfill")}
                  disabled={busyAny}
                  className="w-full py-3 bg-surface-container text-on-surface rounded-xl text-sm font-bold hover:bg-surface-container-high transition-colors disabled:opacity-40 flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-primary/40"
                >
                  {busy === "backfill" ? (
                    <>
                      <Icon name="progress_activity" className="text-base animate-spin" /> Importing…
                    </>
                  ) : (
                    "Import the last year"
                  )}
                </button>
                <button
                  type="button"
                  onClick={disconnect}
                  disabled={busyAny}
                  className="w-full py-3 border border-outline-variant rounded-xl text-sm font-bold text-on-surface hover:bg-surface-container transition-colors disabled:opacity-40 flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-primary/40"
                >
                  {busy === "disconnect" ? (
                    <>
                      <Icon name="progress_activity" className="text-base animate-spin" /> Disconnecting…
                    </>
                  ) : (
                    "Disconnect and withdraw consent"
                  )}
                </button>
              </div>
              <p className="text-[10px] text-on-surface-variant/80 mt-2 leading-snug">
                Disconnecting revokes access at intervals.icu straight away and keeps the runs it
                already imported. To delete those too, use{" "}
                <Link
                  href="/profile/privacy"
                  className="text-primary font-bold underline rounded focus:outline-none focus:ring-2 focus:ring-primary/40"
                >
                  privacy &amp; data
                </Link>
                .
              </p>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setDialogOpen(true)}
              disabled={!data}
              className="mt-4 w-full py-3 bg-primary text-on-primary rounded-xl text-sm font-bold hover:opacity-90 transition-opacity disabled:opacity-40 flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
              <Icon name="link" className="text-base" />
              Connect intervals.icu
            </button>
          )}
        </>
      )}

      {data && (
        <ProviderConsentDialog
          open={dialogOpen}
          consent={data.consent}
          scope={data.scope}
          onClose={() => setDialogOpen(false)}
          onConnected={handleConnected}
        />
      )}
    </div>
  );
}
