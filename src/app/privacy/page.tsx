import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy notice · GPX running",
  description: "What GPX running stores about you, why, for how long, and how to get it back or delete it.",
};

// Read at request time so the deployment's controller details come from the
// environment rather than being baked in at build.
export const dynamic = "force-dynamic";

/**
 * The user-facing privacy notice (GDPR Art. 13).
 *
 * `docs/gdpr.md` is the internal working document for whoever operates the
 * deployment; this is the plain-language version a person reads before they
 * sign up. It is public and unauthenticated on purpose — a notice you have to
 * log in to read is not a notice.
 *
 * Keep the two in step. If the data table here and the one in docs/gdpr.md ever
 * disagree, the code is the tiebreaker and both documents are wrong.
 */

const HELD: { what: string; why: string; basis: string }[] = [
  {
    what: "Your email address",
    why: "To sign you in, and to let you reset your password.",
    basis: "Contract — Art. 6(1)(b)",
  },
  {
    what: "Your profile: username, display name, avatar, totals",
    why: "To show your account in the app.",
    basis: "Contract — Art. 6(1)(b)",
  },
  {
    what: "The runs you upload: GPS track, start time, distance, duration, elevation, name",
    why: "To draw your maps, your statistics and your route suggestions.",
    basis: "Contract — Art. 6(1)(b)",
  },
  {
    what: "Runs imported from a provider you connect, such as intervals.icu",
    why: "So your runs arrive without a manual export. Only if you connect it and agree.",
    basis: "Consent — Art. 6(1)(a)",
  },
  {
    what: "Your provider connection: the provider account id and an encrypted access token",
    why: "To fetch your activities on your behalf. Encrypted at rest, never shown to anyone.",
    basis: "Consent — Art. 6(1)(a)",
  },
  {
    what: "Consent records: what you agreed to, the exact wording, its version, and when",
    why: "Because the law requires the controller to be able to show what you agreed to.",
    basis: "Legal obligation — Art. 7(1)",
  },
  {
    what: "Sync and webhook audit lines",
    why: "To keep imports correct and debuggable. Minimal and short-lived.",
    basis: "Legitimate interests — Art. 6(1)(f)",
  },
];

const RECIPIENTS: { name: string; role: string }[] = [
  { name: "Google (Firebase Auth, Firestore)", role: "Hosts the database and the sign-in system." },
  { name: "intervals.icu", role: "Only if you connect it. Sends us the activities you consented to import." },
  { name: "Strava", role: "Only if you connect it. Same." },
  { name: "openrouteservice / HeiGIT", role: "Receives coordinates when you generate a route." },
  { name: "Map tile providers", role: "Your browser requests map tiles directly from them." },
  { name: "The hosting provider", role: "Request logs." },
];

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="bg-surface-container-lowest rounded-3xl p-6 shadow-sm border border-outline-variant/10">
      <h2 className="text-sm font-extrabold text-on-surface font-headline mb-3">{title}</h2>
      {children}
    </section>
  );
}

export default function PrivacyNoticePage() {
  const controller =
    process.env.GDPR_CONTROLLER_NAME || "The operator of this GPX running deployment";
  const contact = process.env.GDPR_CONTACT_EMAIL || null;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="bg-surface-container-lowest border-b border-outline-variant/20 px-4 py-3 flex items-center gap-3">
        <Link
          href="/"
          className="flex items-center gap-2 text-on-surface-variant hover:text-on-surface transition-colors rounded focus:outline-none focus:ring-2 focus:ring-primary/40"
        >
          <span className="material-symbols-outlined text-xl">arrow_back</span>
          <span className="text-sm font-medium">Back</span>
        </Link>
        <div className="flex-1" />
        <span className="text-xs text-on-surface-variant font-medium">GPX running</span>
      </header>

      <main className="flex-1 flex justify-center items-start py-8 px-4">
        <div className="w-full max-w-2xl space-y-5">
          <div className="text-center">
            <h1 className="text-2xl font-extrabold text-on-surface font-headline">Privacy notice</h1>
            <p className="text-sm text-on-surface-variant mt-1">
              What this app holds about you, why, and what you can do about it.
            </p>
          </div>

          <Card title="Who is responsible">
            <p className="text-xs text-on-surface-variant leading-relaxed">
              {controller} decides why and how your data is processed, and is the data controller.
              {contact ? " Questions and rights requests go to " : " A published contact address is not configured on this deployment yet."}
              {contact && (
                <a
                  href={`mailto:${contact}`}
                  className="text-primary font-bold underline rounded focus:outline-none focus:ring-2 focus:ring-primary/40"
                >
                  {contact}
                </a>
              )}
              {contact ? "." : ""}
            </p>
          </Card>

          <Card title="What is held, and why">
            <ul className="space-y-3">
              {HELD.map((row) => (
                <li key={row.what} className="border-b border-outline-variant/20 pb-3 last:border-0 last:pb-0">
                  <p className="text-xs font-bold text-on-surface">{row.what}</p>
                  <p className="text-xs text-on-surface-variant mt-0.5">{row.why}</p>
                  <p className="text-[10px] font-extrabold uppercase tracking-wider text-on-surface-variant/70 mt-1">
                    {row.basis}
                  </p>
                </li>
              ))}
            </ul>
          </Card>

          <Card title="What is never collected">
            <p className="text-xs text-on-surface-variant leading-relaxed">
              Heart rate, HRV, sleep, power, cadence and weight are health data. This app does not
              request them, does not store them, and drops them if a provider sends them anyway.
              When it imports from intervals.icu it asks only for the GPS track and the activity
              summary.
            </p>
          </Card>

          <Card title="A GPS track says where you live">
            <p className="text-xs text-on-surface-variant leading-relaxed">
              The first and last point of a run is usually someone&apos;s front door. That is why
              every route and every imported activity starts private, visible only to you, and stays
              that way unless you deliberately share it.
            </p>
          </Card>

          <Card title="How long it is kept">
            <ul className="space-y-2 text-xs text-on-surface-variant">
              <li>
                <span className="font-bold text-on-surface">Your runs:</span> until you delete them
                or delete your data.
              </li>
              <li>
                <span className="font-bold text-on-surface">Original provider files:</span> marked
                for deletion after 30 days.
              </li>
              <li>
                <span className="font-bold text-on-surface">Consent records:</span> 3 years, because
                the controller has to be able to show what you agreed to.
              </li>
              <li>
                <span className="font-bold text-on-surface">Sync audit lines:</span> 90 days.
              </li>
            </ul>
          </Card>

          <Card title="Who else sees it">
            <ul className="space-y-2">
              {RECIPIENTS.map((row) => (
                <li key={row.name} className="text-xs text-on-surface-variant">
                  <span className="font-bold text-on-surface">{row.name}.</span> {row.role}
                </li>
              ))}
            </ul>
          </Card>

          <Card title="Your rights">
            <ul className="space-y-2 text-xs text-on-surface-variant">
              <li>
                <span className="font-bold text-on-surface">See and take your data</span> — download
                everything held about you as one JSON file, including the full GPS geometry.
              </li>
              <li>
                <span className="font-bold text-on-surface">Delete it</span> — a real delete, not a
                hidden flag, either for one provider or for the whole account.
              </li>
              <li>
                <span className="font-bold text-on-surface">Withdraw consent</span> — at any time,
                in one click, as easily as it was given. Withdrawing stops future imports; it does
                not by itself delete runs already imported, and a separate button does that.
              </li>
              <li>
                <span className="font-bold text-on-surface">Correct your data</span> — route names
                and types are editable in the app.
              </li>
            </ul>
            <Link
              href="/profile/privacy"
              className="mt-4 w-full py-3 bg-primary text-on-primary rounded-xl text-sm font-bold hover:opacity-90 transition-opacity flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-primary/40"
            >
              <span className="material-symbols-outlined text-base">shield_person</span>
              Privacy &amp; data settings
            </Link>
            <p className="text-[10px] text-on-surface-variant/70 mt-2 text-center">
              Sign in first — these actions only ever act on your own account.
            </p>
          </Card>

          <Card title="If you are unhappy with how this is handled">
            <p className="text-xs text-on-surface-variant leading-relaxed">
              You can complain to your national data protection authority. In Sweden that is
              Integritetsskyddsmyndigheten (IMY).
            </p>
          </Card>

          <p className="text-center text-[10px] text-on-surface-variant/60 pb-4">
            Signing up does not connect any other service. Permission to import your runs from a
            provider is asked separately, at the moment you connect it.
          </p>
        </div>
      </main>
    </div>
  );
}
