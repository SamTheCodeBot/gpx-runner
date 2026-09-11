"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { useUserProfile } from "@/lib/hooks";
import {
  ERASURE_CONFIRMATION,
  formatDateTime,
  isStaleConsent,
  privacyErrorMessage,
  privacyFetch,
  privacyJson,
  PURPOSE_LABELS,
  sourceLabel,
  toErrorView,
  useConsentState,
  useIntervalsConnection,
  type ErasureReceiptView,
  type ErrorView,
} from "@/lib/privacy";
import { Icon } from "@/components/ui";
import type { ConsentRecord } from "@/app/types";

/**
 * Privacy and data — the ongoing rights surface (GDPR Art. 7(3), 15, 17, 20).
 *
 * Everything a person is entitled to do with their own data lives on one page,
 * one tap from the profile: see what is connected, see exactly what they agreed
 * to and when, withdraw it, take a copy, or have it deleted.
 *
 * Withdrawal sits in the same place and takes the same single click as giving
 * consent, because Art. 7(3) requires it to be as easy — a right buried three
 * screens deep is not one.
 */

type Busy =
  | { kind: "withdraw"; id: string }
  | { kind: "export" }
  | { kind: "erase" }
  | null;

function Card({
  icon,
  eyebrow,
  title,
  children,
  tone = "normal",
}: {
  icon: string;
  eyebrow: string;
  title: string;
  children: React.ReactNode;
  tone?: "normal" | "danger";
}) {
  return (
    <section
      className={`bg-surface-container-lowest rounded-3xl p-6 shadow-sm border ${
        tone === "danger" ? "border-error/20" : "border-outline-variant/10"
      }`}
    >
      <div className="flex items-start gap-3 mb-4">
        <div
          className={`w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 ${
            tone === "danger" ? "bg-error/10" : "bg-primary/10"
          }`}
        >
          <Icon name={icon} className={`text-xl ${tone === "danger" ? "text-error" : "text-primary"}`} />
        </div>
        <div className="min-w-0">
          <p
            className={`text-[10px] font-extrabold uppercase tracking-wider ${
              tone === "danger" ? "text-error" : "text-on-surface-variant"
            }`}
          >
            {eyebrow}
          </p>
          <h2 className="text-sm font-extrabold text-on-surface mt-0.5">{title}</h2>
        </div>
      </div>
      {children}
    </section>
  );
}

function ErrorNote({ error }: { error: ErrorView }) {
  return (
    <div className="mt-3 px-3 py-2 bg-error-container rounded-xl">
      <p className="text-xs font-medium text-error">{error.message}</p>
      <p className="text-[10px] text-error/70 mt-0.5 font-mono">{error.code}</p>
    </div>
  );
}

export default function PrivacyAndDataPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();

  // Firebase resolves after the first render here, so routing decisions wait
  // for auth to settle rather than bouncing a user who is in fact signed in.
  useEffect(() => {
    if (authLoading) return;
    if (!user) router.replace("/");
  }, [user, authLoading, router]);

  const { profile } = useUserProfile(user?.uid ?? null);
  const intervals = useIntervalsConnection();
  const consents = useConsentState();

  const [busy, setBusy] = useState<Busy>(null);
  const [actionError, setActionError] = useState<ErrorView | null>(null);
  const [notice, setNotice] = useState("");

  const [includeRaw, setIncludeRaw] = useState(false);
  const [eraseOpen, setEraseOpen] = useState(false);
  const [eraseScope, setEraseScope] = useState<"account" | "intervals_icu">("account");
  const [confirmText, setConfirmText] = useState("");
  const [receipt, setReceipt] = useState<ErasureReceiptView | null>(null);

  const connection = intervals.data?.connection ?? null;
  const records = [...(consents.data?.granted ?? [])].sort((a, b) =>
    String(b.grantedAt ?? "").localeCompare(String(a.grantedAt ?? "")),
  );

  /**
   * Withdrawing provider-ingest consent also drops the stored credentials:
   * keeping a live API key for a provider we are no longer permitted to read
   * would make the withdrawal cosmetic. `/api/intervals/disconnect` revokes
   * upstream, deletes the credentials and marks the consent withdrawn, in that
   * order. Sharing purposes have no credentials, so the consent route is enough.
   */
  const withdraw = async (record: ConsentRecord) => {
    if (!user) return;
    setBusy({ kind: "withdraw", id: record.id });
    setActionError(null);
    setNotice("");
    try {
      if (record.purpose === "provider_ingest" && record.source === "intervals_icu") {
        await privacyJson(user, "/api/intervals/disconnect", { method: "POST" });
        setNotice(
          "Consent withdrawn and intervals.icu disconnected. The runs already imported are still here — delete them below if you want them gone.",
        );
      } else {
        await privacyJson(user, "/api/gdpr/consent", {
          method: "POST",
          body: JSON.stringify({
            purpose: record.purpose,
            source: record.source,
            granted: false,
          }),
        });
        setNotice("Consent withdrawn.");
      }
      consents.reload();
      intervals.reload();
    } catch (caught) {
      setActionError(toErrorView(caught));
    } finally {
      setBusy(null);
    }
  };

  /** Art. 15 and 20: the whole record, in one machine-readable file. */
  const downloadExport = async () => {
    if (!user) return;
    setBusy({ kind: "export" });
    setActionError(null);
    setNotice("");
    try {
      const res = await privacyFetch(user, `/api/gdpr/export${includeRaw ? "?includeRaw=1" : ""}`);
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
        const code = typeof data?.code === "string" ? data.code : `http_${res.status}`;
        setActionError({
          message: privacyErrorMessage(
            code,
            typeof data?.error === "string" ? data.error : undefined,
          ),
          code,
        });
        return;
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `gpx-runner-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setNotice("Your data export has been downloaded.");
    } catch {
      setActionError({ message: privacyErrorMessage("network_error"), code: "network_error" });
    } finally {
      setBusy(null);
    }
  };

  /** Art. 17: a hard delete, behind a typed confirmation the endpoint demands. */
  const erase = async () => {
    if (!user) return;
    setBusy({ kind: "erase" });
    setActionError(null);
    setNotice("");
    try {
      const result = await privacyJson<ErasureReceiptView>(user, "/api/gdpr/erase", {
        method: "POST",
        body: JSON.stringify({ confirm: confirmText.trim(), scope: eraseScope }),
      });
      setReceipt(result);
      setEraseOpen(false);
      setConfirmText("");
      consents.reload();
      intervals.reload();
    } catch (caught) {
      setActionError(toErrorView(caught));
    } finally {
      setBusy(null);
    }
  };

  const downloadReceipt = () => {
    if (!receipt) return;
    const blob = new Blob([JSON.stringify(receipt, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `gpx-runner-erasure-receipt-${receipt.receiptId}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  if (authLoading || !user) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-on-surface-variant text-sm">Loading&hellip;</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="bg-surface-container-lowest border-b border-outline-variant/20 px-4 py-3 flex items-center gap-3">
        <Link
          href="/profile"
          className="flex items-center gap-2 text-on-surface-variant hover:text-on-surface transition-colors rounded focus:outline-none focus:ring-2 focus:ring-primary/40"
        >
          <Icon name="arrow_back" className="text-xl" />
          <span className="text-sm font-medium">Profile</span>
        </Link>
        <div className="flex-1" />
        <span className="text-xs text-on-surface-variant font-medium">GPX running</span>
      </header>

      <main className="flex-1 flex justify-center items-start py-8 px-4">
        <div className="w-full max-w-md space-y-5">
          <div className="text-center">
            <h1 className="text-2xl font-extrabold text-on-surface font-headline">Privacy &amp; data</h1>
            <p className="text-sm text-on-surface-variant mt-1">
              What is connected, what you agreed to, and how to take it back.
            </p>
          </div>

          {notice && (
            <div className="px-3 py-2 bg-secondary-container text-on-secondary-container text-xs rounded-xl">
              {notice}
            </div>
          )}
          {actionError && <ErrorNote error={actionError} />}

          {/* --- Connections ------------------------------------------------ */}
          <Card icon="cable" eyebrow="Connections" title="Services connected to your account">
            {intervals.loading ? (
              <div className="h-16 bg-surface-container rounded-xl animate-pulse" />
            ) : intervals.error ? (
              <ErrorNote error={intervals.error} />
            ) : connection ? (
              <div className="rounded-2xl border border-outline-variant/40 p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-extrabold text-on-surface">intervals.icu</p>
                  <span className="text-[10px] font-extrabold uppercase tracking-wider text-on-secondary-container bg-secondary-container rounded-full px-2 py-0.5">
                    Active
                  </span>
                </div>
                <dl className="mt-3 space-y-1.5 text-xs">
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
                    <dt className="text-on-surface-variant">Connected at</dt>
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
              </div>
            ) : (
              <p className="text-xs text-on-surface-variant">
                No provider is connected.{" "}
                <Link
                  href="/profile"
                  className="text-primary font-bold underline rounded focus:outline-none focus:ring-2 focus:ring-primary/40"
                >
                  Connect intervals.icu
                </Link>{" "}
                from your profile.
              </p>
            )}

            {profile?.strava && (
              <div className="mt-3 rounded-2xl border border-outline-variant/40 p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-extrabold text-on-surface">Strava</p>
                  <span className="text-[10px] font-extrabold uppercase tracking-wider text-on-surface-variant bg-surface-container rounded-full px-2 py-0.5">
                    Legacy
                  </span>
                </div>
                <p className="text-xs text-on-surface-variant mt-2">
                  Connected {formatDateTime(profile.strava.connectedAt)}. Managed on your{" "}
                  <Link
                    href="/profile"
                    className="text-primary font-bold underline rounded focus:outline-none focus:ring-2 focus:ring-primary/40"
                  >
                    profile
                  </Link>
                  .
                </p>
              </div>
            )}
          </Card>

          {/* --- Consent history -------------------------------------------- */}
          <Card icon="history_edu" eyebrow="Consent history" title="What you agreed to, and when">
            {profile?.termsAcceptedAt && (
              <div className="rounded-2xl bg-surface-container-low p-3 mb-3">
                <p className="text-xs font-bold text-on-surface">Terms and privacy notice</p>
                <p className="text-[11px] text-on-surface-variant mt-0.5">
                  Accepted {formatDateTime(profile.termsAcceptedAt)}
                  {profile.termsVersion ? ` · version ${profile.termsVersion}` : ""}
                </p>
                <p className="text-[10px] text-on-surface-variant/80 mt-1 leading-snug">
                  This is the agreement the service runs on, not consent to share data with anyone.
                  It cannot be withdrawn while the account exists — delete the account instead.
                </p>
              </div>
            )}

            {consents.loading ? (
              <div className="h-20 bg-surface-container rounded-xl animate-pulse" />
            ) : consents.error ? (
              <ErrorNote error={consents.error} />
            ) : records.length === 0 ? (
              <p className="text-xs text-on-surface-variant">
                You have not given any consent yet. Nothing is being imported from any provider.
              </p>
            ) : (
              <ul className="space-y-3">
                {records.map((record) => {
                  const stale = isStaleConsent(record, consents.data);
                  const withdrawing = busy?.kind === "withdraw" && busy.id === record.id;
                  return (
                    <li key={record.id} className="rounded-2xl border border-outline-variant/40 p-4">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-xs font-bold text-on-surface">
                            {PURPOSE_LABELS[record.purpose] ?? "Consent"}
                            {record.source ? ` · ${sourceLabel(record.source)}` : ""}
                          </p>
                          <p className="text-[11px] text-on-surface-variant mt-0.5">
                            {record.granted
                              ? `Given ${formatDateTime(record.grantedAt)}`
                              : `Withdrawn ${formatDateTime(record.withdrawnAt ?? record.grantedAt)}`}
                            {record.version ? ` · version ${record.version}` : ""}
                          </p>
                        </div>
                        <span
                          className={`text-[10px] font-extrabold uppercase tracking-wider rounded-full px-2 py-0.5 shrink-0 ${
                            record.granted
                              ? "bg-secondary-container text-on-secondary-container"
                              : "bg-surface-container text-on-surface-variant"
                          }`}
                        >
                          {record.granted ? "Active" : "Withdrawn"}
                        </span>
                      </div>

                      {stale && (
                        <p className="mt-2 px-3 py-2 bg-tertiary-fixed text-on-tertiary-fixed text-[11px] rounded-xl leading-snug">
                          The wording has been updated since you agreed. Importing is paused until you
                          agree to the new version.
                        </p>
                      )}

                      {record.text && (
                        <details className="mt-2">
                          <summary className="text-[11px] text-primary font-bold cursor-pointer rounded focus:outline-none focus:ring-2 focus:ring-primary/40">
                            Show the exact wording you agreed to
                          </summary>
                          <blockquote className="mt-2 text-[11px] leading-relaxed text-on-surface-variant border-l-2 border-outline-variant pl-3">
                            {record.text}
                          </blockquote>
                        </details>
                      )}

                      {record.granted && (
                        <button
                          type="button"
                          onClick={() => withdraw(record)}
                          disabled={busy !== null}
                          className="mt-3 w-full py-2.5 border border-outline-variant rounded-xl text-xs font-bold text-on-surface hover:bg-surface-container transition-colors disabled:opacity-40 flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-primary/40"
                        >
                          {withdrawing ? (
                            <>
                              <Icon name="progress_activity" className="text-sm animate-spin" /> Withdrawing…
                            </>
                          ) : (
                            <>
                              <Icon name="undo" className="text-sm" /> Withdraw this consent
                            </>
                          )}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            <p className="text-[10px] text-on-surface-variant/80 mt-3 leading-snug">
              Withdrawing takes one click and stops future imports immediately. Runs already imported
              stay until you delete them below.
            </p>
          </Card>

          {/* --- Export ------------------------------------------------------ */}
          <Card icon="download" eyebrow="Access and portability" title="Download my data">
            <p className="text-xs text-on-surface-variant leading-relaxed">
              One JSON file with your profile, every activity, the full GPS geometry of every route,
              your consent records and your connection details. Provider credentials are never
              included.
            </p>

            <div className="mt-3 flex items-start gap-2">
              <input
                id="include-raw"
                type="checkbox"
                checked={includeRaw}
                onChange={(event) => setIncludeRaw(event.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 rounded accent-primary cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary/40"
              />
              <label htmlFor="include-raw" className="text-xs leading-snug text-on-surface cursor-pointer">
                Also include the original files downloaded from providers. Bigger file, same runs.
              </label>
            </div>

            <button
              type="button"
              onClick={downloadExport}
              disabled={busy !== null}
              className="mt-4 w-full py-3 bg-primary text-on-primary rounded-xl text-sm font-bold hover:opacity-90 transition-opacity disabled:opacity-40 flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
              {busy?.kind === "export" ? (
                <>
                  <Icon name="progress_activity" className="text-base animate-spin" /> Preparing…
                </>
              ) : (
                <>
                  <Icon name="download" className="text-base" /> Download my data
                </>
              )}
            </button>
          </Card>

          {/* --- Erasure ----------------------------------------------------- */}
          <Card icon="delete_forever" eyebrow="Erasure" title="Delete my data" tone="danger">
            {receipt ? (
              <div>
                <div className="rounded-2xl bg-surface-container-low p-4">
                  <p className="text-xs font-bold text-on-surface">{receipt.confirmation}</p>
                  <dl className="mt-3 space-y-1 text-[11px]">
                    <div className="flex justify-between gap-3">
                      <dt className="text-on-surface-variant">Receipt</dt>
                      <dd className="text-on-surface font-mono text-right break-all">
                        {receipt.receiptId}
                      </dd>
                    </div>
                    {Object.entries(receipt.deleted).map(([key, count]) => (
                      <div key={key} className="flex justify-between gap-3">
                        <dt className="text-on-surface-variant capitalize">{key}</dt>
                        <dd className="text-on-surface font-medium text-right">{count} deleted</dd>
                      </div>
                    ))}
                  </dl>
                  {receipt.upstreamFailed.length > 0 && (
                    <p className="mt-3 px-3 py-2 bg-error-container text-error text-[11px] rounded-xl leading-snug">
                      Access could not be revoked at{" "}
                      {receipt.upstreamFailed.map(sourceLabel).join(", ")}. Your data here is deleted,
                      but revoke GPX running in that provider&apos;s own settings to be sure.
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={downloadReceipt}
                  className="mt-3 w-full py-2.5 border border-outline-variant rounded-xl text-xs font-bold text-on-surface hover:bg-surface-container transition-colors flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-primary/40"
                >
                  <Icon name="receipt_long" className="text-sm" /> Save this receipt
                </button>
                {receipt.scope === "account" && (
                  <p className="text-[10px] text-on-surface-variant/80 mt-3 leading-snug">
                    Your sign-in still exists so you can close this properly. Remove it with{" "}
                    <Link
                      href="/profile"
                      className="text-primary font-bold underline rounded focus:outline-none focus:ring-2 focus:ring-primary/40"
                    >
                      delete account
                    </Link>{" "}
                    on your profile.
                  </p>
                )}
              </div>
            ) : !eraseOpen ? (
              <>
                <p className="text-xs text-on-surface-variant leading-relaxed">
                  A real delete: activities, tracks, original provider files, connections and consent
                  records are removed for good, and access at the provider is revoked first. There is
                  no undo and no backup copy to restore from.
                </p>
                <button
                  type="button"
                  onClick={() => {
                    setEraseOpen(true);
                    setActionError(null);
                  }}
                  className="mt-4 w-full py-3 bg-error-container text-error rounded-xl text-sm font-bold hover:opacity-90 transition-opacity flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-error/40"
                >
                  <Icon name="delete_forever" className="text-base" /> Delete my data
                </button>
              </>
            ) : (
              <div className="space-y-3">
                <fieldset>
                  <legend className="text-[10px] font-extrabold uppercase tracking-wider text-on-surface-variant mb-2">
                    What should be deleted
                  </legend>
                  <div className="space-y-2">
                    <div className="flex items-start gap-2">
                      <input
                        id="scope-account"
                        type="radio"
                        name="erase-scope"
                        checked={eraseScope === "account"}
                        onChange={() => setEraseScope("account")}
                        className="mt-0.5 h-4 w-4 shrink-0 accent-error cursor-pointer focus:outline-none focus:ring-2 focus:ring-error/40"
                      />
                      <label htmlFor="scope-account" className="text-xs leading-snug text-on-surface cursor-pointer">
                        <span className="font-bold">Everything.</span> Every run, route, connection,
                        consent record and your profile.
                      </label>
                    </div>
                    <div className="flex items-start gap-2">
                      <input
                        id="scope-intervals"
                        type="radio"
                        name="erase-scope"
                        checked={eraseScope === "intervals_icu"}
                        onChange={() => setEraseScope("intervals_icu")}
                        className="mt-0.5 h-4 w-4 shrink-0 accent-error cursor-pointer focus:outline-none focus:ring-2 focus:ring-error/40"
                      />
                      <label htmlFor="scope-intervals" className="text-xs leading-snug text-on-surface cursor-pointer">
                        <span className="font-bold">Only what came from intervals.icu.</span> Your own
                        uploads and Strava runs are left alone.
                      </label>
                    </div>
                  </div>
                </fieldset>

                <div>
                  <label
                    htmlFor="erase-confirm"
                    className="text-[10px] font-extrabold uppercase tracking-wider text-on-surface-variant block mb-1"
                  >
                    Type {ERASURE_CONFIRMATION} to confirm
                  </label>
                  <input
                    id="erase-confirm"
                    type="text"
                    value={confirmText}
                    onChange={(event) => setConfirmText(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={ERASURE_CONFIRMATION}
                    className="w-full px-3 py-2.5 bg-surface-container border border-outline-variant rounded-xl text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:ring-2 focus:ring-error/30"
                  />
                </div>

                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setEraseOpen(false);
                      setConfirmText("");
                    }}
                    className="flex-1 py-2.5 border border-outline-variant rounded-xl text-sm font-medium text-on-surface hover:bg-surface-container transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={erase}
                    disabled={busy !== null || confirmText.trim() !== ERASURE_CONFIRMATION}
                    className="flex-1 py-2.5 bg-error text-on-error rounded-xl text-sm font-bold hover:opacity-90 transition-opacity disabled:opacity-40 flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-error/40"
                  >
                    {busy?.kind === "erase" ? (
                      <>
                        <Icon name="progress_activity" className="text-base animate-spin" /> Deleting…
                      </>
                    ) : (
                      <>
                        <Icon name="delete_forever" className="text-base" /> Delete for good
                      </>
                    )}
                  </button>
                </div>
              </div>
            )}
          </Card>

          <div className="text-center">
            <Link
              href="/privacy"
              className="text-xs text-primary font-medium hover:underline rounded focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
              Read the full privacy notice
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}
