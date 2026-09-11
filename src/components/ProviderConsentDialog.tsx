"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import {
  PrivacyApiError,
  privacyJson,
  toErrorView,
  type ConsentTextView,
  type ErrorView,
  type ProviderConnectionView,
} from "@/lib/privacy";
import { Icon } from "@/components/ui";

/**
 * Provider connection consent — GDPR Art. 6(1)(a).
 *
 * This is the real consent, and it is asked here and nowhere else: at the
 * moment the user connects intervals.icu, never bundled into signup, because
 * consent that is a precondition of the service is not freely given (Art.
 * 7(4)). Declining leaves the rest of the app working exactly as before.
 *
 * The wording shown is the exact string the server returned. It is never
 * paraphrased in this component, because the server stores what it showed as
 * the evidence of consent (Art. 7(1)) — a component that displayed different
 * words would make that evidence a lie. The plain-language summary below it is
 * clearly labelled as a summary and sits outside the quoted text.
 *
 * The agreed version is echoed back on connect. If the wording moved on while
 * this dialog was open the server answers 409 `consent_version_mismatch`, and
 * the handler below swaps in the new text and un-ticks the box: the user agrees
 * again, to the words they can actually see.
 */

interface ProviderConsentDialogProps {
  open: boolean;
  /** Current wording, from `GET /api/intervals/connect`. */
  consent: ConsentTextView;
  scope?: string;
  onClose: () => void;
  onConnected: (connection: ProviderConnectionView) => void;
}

const WILL_READ = [
  "The GPS track of each run",
  "Start time, distance, duration and elevation",
  "The activity name and sport",
];

const WILL_NOT_READ = [
  "Heart rate",
  "Sleep and HRV",
  "Power, cadence and weight",
];

type BusyMode = "oauth" | "api_key" | null;

export function ProviderConsentDialog({
  open,
  consent,
  scope,
  onClose,
  onConnected,
}: ProviderConsentDialogProps) {
  const { user } = useAuth();
  const [view, setView] = useState<ConsentTextView>(consent);
  const [agreed, setAgreed] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<BusyMode>(null);
  const [error, setError] = useState<ErrorView | null>(null);
  const [wordingChanged, setWordingChanged] = useState(false);

  const dialogRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Opening is always a clean slate: nothing pre-ticked, no secret left over
  // from a previous attempt.
  useEffect(() => {
    if (!open) return;
    setView(consent);
    setAgreed(false);
    setApiKey("");
    setBusy(null);
    setError(null);
    setWordingChanged(false);
  }, [open, consent]);

  // Focus management: move focus into the dialog, keep Tab inside it, close on
  // Escape, and hand focus back to whatever opened it.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    headingRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;

      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => element.offsetParent !== null);
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [open, onClose]);

  const connect = useCallback(
    async (mode: "oauth" | "api_key") => {
      if (!user || !agreed || busy) return;
      if (mode === "api_key" && !apiKey.trim()) {
        setError({ message: "Paste your intervals.icu API key first.", code: "api_key_missing" });
        return;
      }

      setBusy(mode);
      setError(null);
      try {
        // The key travels once, in a POST body, over HTTPS. Never a query
        // string, never localStorage, never a log line.
        const payload: Record<string, unknown> = { mode, consentVersion: view.version };
        if (mode === "api_key") payload.apiKey = apiKey.trim();

        const data = await privacyJson<{
          mode: string;
          url?: string;
          connection?: ProviderConnectionView;
        }>(user, "/api/intervals/connect", { method: "POST", body: JSON.stringify(payload) });

        if (mode === "oauth") {
          if (!data.url) {
            setError({
              message: "The server did not return an intervals.icu authorisation link. Try again.",
              code: "authorize_url_missing",
            });
            setBusy(null);
            return;
          }
          setApiKey("");
          window.location.href = data.url;
          return;
        }

        setApiKey("");
        if (data.connection) onConnected(data.connection);
      } catch (caught) {
        // The wording moved while this dialog was open. Show the new text and
        // make the user agree to it — the old tick is meaningless now.
        if (
          caught instanceof PrivacyApiError &&
          caught.code === "consent_version_mismatch" &&
          caught.consent
        ) {
          setView(caught.consent);
          setAgreed(false);
          setWordingChanged(true);
        }
        setError(toErrorView(caught));
        setBusy(null);
        return;
      }
      setBusy(null);
    },
    [user, agreed, busy, apiKey, view.version, onConnected],
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="intervals-consent-title"
        className="relative bg-surface-container-lowest rounded-3xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto p-6 animate-fade-in"
      >
        <div className="flex items-start justify-between gap-3 mb-4">
          <div>
            <p className="text-[10px] font-extrabold uppercase tracking-wider text-on-surface-variant">
              Your permission is needed
            </p>
            <h3
              id="intervals-consent-title"
              ref={headingRef}
              tabIndex={-1}
              className="text-base font-extrabold text-primary font-headline focus:outline-none"
            >
              Connect intervals.icu
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close without connecting"
            className="p-1.5 rounded-lg hover:bg-surface-container transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            <Icon name="close" className="text-on-surface-variant text-sm" />
          </button>
        </div>

        {wordingChanged && (
          <div className="mb-3 px-3 py-2 bg-tertiary-fixed rounded-xl text-xs text-on-tertiary-fixed flex items-start gap-2">
            <Icon name="update" className="text-sm mt-0.5 shrink-0" />
            <span>
              The wording changed while this was open. Here is the current version — please read it
              and agree again.
            </span>
          </div>
        )}

        {/* The exact stored wording. Rendered verbatim, never paraphrased. */}
        <div className="rounded-2xl border border-outline-variant bg-surface-container-low p-4">
          <p className="text-[10px] font-extrabold uppercase tracking-wider text-on-surface-variant mb-2">
            What you are agreeing to · version {view.version}
          </p>
          <blockquote
            id="intervals-consent-text"
            className="text-xs leading-relaxed text-on-surface border-l-2 border-primary/40 pl-3"
          >
            {view.text}
          </blockquote>
        </div>

        {/* Clearly a summary, clearly outside the quoted text above. */}
        <div className="grid grid-cols-2 gap-2 mt-3">
          <div className="rounded-2xl bg-secondary-container/60 p-3">
            <p className="text-[10px] font-extrabold uppercase tracking-wider text-on-secondary-container mb-1.5">
              Will be read
            </p>
            <ul className="space-y-1">
              {WILL_READ.map((item) => (
                <li key={item} className="flex items-start gap-1.5 text-[11px] leading-snug text-on-surface">
                  <Icon name="check" className="text-[13px] mt-0.5 shrink-0 text-secondary" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-2xl bg-surface-container p-3">
            <p className="text-[10px] font-extrabold uppercase tracking-wider text-on-surface-variant mb-1.5">
              Never read
            </p>
            <ul className="space-y-1">
              {WILL_NOT_READ.map((item) => (
                <li
                  key={item}
                  className="flex items-start gap-1.5 text-[11px] leading-snug text-on-surface-variant"
                >
                  <Icon name="block" className="text-[13px] mt-0.5 shrink-0" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>

        {scope && (
          <p className="text-[10px] text-on-surface-variant/70 mt-2">
            Requested scope at intervals.icu: <span className="font-mono">{scope}</span>
          </p>
        )}

        <div className="mt-4 flex items-start gap-2">
          <input
            id="intervals-consent-agree"
            type="checkbox"
            checked={agreed}
            onChange={(event) => setAgreed(event.target.checked)}
            aria-describedby="intervals-consent-text"
            className="mt-0.5 h-4 w-4 shrink-0 rounded accent-primary cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
          <label
            htmlFor="intervals-consent-agree"
            className="text-xs leading-snug text-on-surface cursor-pointer"
          >
            I have read the permission above and I agree to it.
          </label>
        </div>

        {error && (
          <div className="mt-3 px-3 py-2 bg-error-container rounded-xl">
            <p className="text-xs font-medium text-error">{error.message}</p>
            <p className="text-[10px] text-error/70 mt-0.5 font-mono">{error.code}</p>
          </div>
        )}

        <div className="mt-4 space-y-2">
          <button
            type="button"
            onClick={() => connect("oauth")}
            disabled={!agreed || busy !== null}
            className="w-full py-3 bg-primary text-on-primary rounded-xl text-sm font-bold hover:opacity-90 transition-opacity disabled:opacity-40 flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            {busy === "oauth" ? (
              <>
                <Icon name="progress_activity" className="text-base animate-spin" /> Opening intervals.icu…
              </>
            ) : (
              <>
                <Icon name="open_in_new" className="text-base" /> Connect with intervals.icu
              </>
            )}
          </button>

          <div className="flex items-center gap-2 py-1">
            <div className="h-px flex-1 bg-outline-variant" />
            <span className="text-[10px] font-extrabold uppercase tracking-wider text-on-surface-variant">
              or use a personal API key
            </span>
            <div className="h-px flex-1 bg-outline-variant" />
          </div>

          <div>
            <label
              htmlFor="intervals-api-key"
              className="text-[10px] font-extrabold uppercase tracking-wider text-on-surface-variant block mb-1"
            >
              intervals.icu API key
            </label>
            <input
              id="intervals-api-key"
              name="intervals-api-key"
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              placeholder="From Settings → Developer at intervals.icu"
              aria-describedby="intervals-api-key-help"
              className="w-full px-3 py-2.5 bg-surface-container border border-outline-variant rounded-xl text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            <p id="intervals-api-key-help" className="text-[10px] text-on-surface-variant/80 mt-1 leading-snug">
              Sent once over HTTPS, encrypted before it is stored, and never shown again. It is not
              kept in this browser.
            </p>
          </div>

          <button
            type="button"
            onClick={() => connect("api_key")}
            disabled={!agreed || busy !== null || apiKey.trim().length === 0}
            className="w-full py-3 border border-outline-variant rounded-xl text-sm font-bold text-on-surface hover:bg-surface-container transition-colors disabled:opacity-40 flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            {busy === "api_key" ? (
              <>
                <Icon name="progress_activity" className="text-base animate-spin" /> Connecting…
              </>
            ) : (
              <>
                <Icon name="key" className="text-base" /> Connect with API key
              </>
            )}
          </button>

          {!agreed && (
            <p className="text-[10px] text-on-surface-variant text-center">
              Tick the box above to enable these.
            </p>
          )}
        </div>

        <button
          type="button"
          onClick={onClose}
          className="w-full mt-3 py-2.5 text-xs font-medium text-on-surface-variant hover:text-on-surface transition-colors rounded-xl focus:outline-none focus:ring-2 focus:ring-primary/40"
        >
          Not now
        </button>

        <p className="text-[10px] text-on-surface-variant/70 mt-2 text-center leading-snug">
          Saying no changes nothing else — the rest of GPX running works the same. You can withdraw
          this later in one click on{" "}
          <Link
            href="/profile/privacy"
            className="text-primary font-bold underline rounded focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            privacy &amp; data
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
