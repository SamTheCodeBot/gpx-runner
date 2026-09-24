import { adminDb } from "@/lib/firebaseAdmin";

/**
 * A daily ceiling on what ingestion may spend, enforced by us.
 *
 * Until 2026-09-24 this project ran on the Firestore free tier, and the free
 * tier was doing a job nobody had asked it to do: it was the brake. A sync that
 * read the whole collection could only misbehave 17 times before Firestore
 * stopped serving, and the damage was an outage that ended at midnight.
 *
 * Blaze removes that brake. Nothing now stands between a loop that reads in
 * circles and the bill, which is a strictly worse failure mode: an outage is
 * loud and free, a runaway is quiet and charged. So the ceiling has to be ours,
 * and it has to live on the server — the import loop in the profile card has a
 * 400-batch stop in it, but that is a courtesy to the user, not a control. A
 * reloaded tab resets it, and a bug in the "are we done yet" logic would drive
 * it in a circle for as long as the browser is open.
 *
 * What this counts is deliberately not "money". It counts the two things that
 * actually scale the bill and that only ingestion does: files pulled from the
 * provider, and batches run. One document read and one write per batch buys a
 * hard stop on both, which is a trade worth making at roughly 0.0000006 SEK.
 *
 * The budgets are sized from the real account: 1,434 activities, 100 downloads
 * per batch, so a complete history import is about 15 batches and 1,434 files.
 * Everything here is several times that. A user who legitimately reaches these
 * numbers has done something no normal use of the app can do.
 */

export const BUDGET_COLLECTION = "ingestionBudgets";

/** Files pulled from a provider, across every import and sync, per day. */
export const DAILY_DOWNLOAD_BUDGET = 4_000;

/** History batches per day. A full 1,434-run import is about 15. */
export const DAILY_BATCH_BUDGET = 150;

/** Reconciliation pulls per day, whether from the button or from a webhook. */
export const DAILY_SYNC_BUDGET = 300;

export type BudgetKind = "downloads" | "batches" | "syncs";

const CEILINGS: Record<BudgetKind, number> = {
  downloads: DAILY_DOWNLOAD_BUDGET,
  batches: DAILY_BATCH_BUDGET,
  syncs: DAILY_SYNC_BUDGET,
};

export class BudgetExhaustedError extends Error {
  code = "daily_budget_exhausted";
  kind: BudgetKind;
  spent: number;
  ceiling: number;

  constructor(kind: BudgetKind, spent: number, ceiling: number) {
    super(`Daily ingestion budget for ${kind} is spent: ${spent}/${ceiling}`);
    this.name = "BudgetExhaustedError";
    this.kind = kind;
    this.spent = spent;
    this.ceiling = ceiling;
  }
}

/**
 * UTC days, not Pacific ones.
 *
 * Firestore's own free allowance rolls over at midnight America/Los_Angeles,
 * and it is tempting to match it. This deliberately does not: this budget is
 * about our spending, not about the free tier, and a boundary that moves twice
 * a year with US daylight saving is a boundary that will eventually be wrong in
 * a way nobody can reproduce.
 */
export function budgetDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function docId(uid: string, day: string): string {
  return `${uid}__${day}`;
}

export type BudgetState = {
  uid: string;
  day: string;
  downloads: number;
  batches: number;
  syncs: number;
  updatedAt: string;
};

export async function readBudget(uid: string, now: Date = new Date()): Promise<BudgetState> {
  const day = budgetDay(now);
  const snap = await adminDb().collection(BUDGET_COLLECTION).doc(docId(uid, day)).get();

  const data = snap.exists ? (snap.data() as Partial<BudgetState>) : {};
  return {
    uid,
    day,
    downloads: data.downloads ?? 0,
    batches: data.batches ?? 0,
    syncs: data.syncs ?? 0,
    updatedAt: data.updatedAt ?? new Date(0).toISOString(),
  };
}

/**
 * Claim budget before doing the work, and refuse when it is gone.
 *
 * Checked before the spend rather than after it, so the ceiling is a ceiling
 * and not a post-mortem. The increment is not transactional: two concurrent
 * batches can both read 149 and both write 150, so the real ceiling is
 * "approximately DAILY_BATCH_BUDGET" rather than exactly it. That is the right
 * trade here — a transaction costs a read and a write of its own on every
 * batch to defend against an overshoot of one or two batches, and the numbers
 * are already an order of magnitude above legitimate use.
 */
export async function claimBudget(input: {
  uid: string;
  kind: BudgetKind;
  amount?: number;
  now?: Date;
}): Promise<BudgetState> {
  const { uid, kind } = input;
  const amount = input.amount ?? 1;
  const now = input.now ?? new Date();
  const day = budgetDay(now);

  const current = await readBudget(uid, now);
  const ceiling = CEILINGS[kind];

  if (current[kind] >= ceiling) {
    throw new BudgetExhaustedError(kind, current[kind], ceiling);
  }

  const next: BudgetState = {
    ...current,
    day,
    [kind]: current[kind] + amount,
    updatedAt: now.toISOString(),
  } as BudgetState;

  await adminDb().collection(BUDGET_COLLECTION).doc(docId(uid, day)).set(next);

  return next;
}

/**
 * Record a spend that already happened, without refusing anything.
 *
 * Downloads are counted this way: a batch cannot know in advance how many files
 * it will pull, and refusing the whole batch because its last file would cross
 * the line would strand the import. The next claim sees the total and stops
 * there instead.
 */
export async function recordSpend(input: {
  uid: string;
  kind: BudgetKind;
  amount: number;
  now?: Date;
}): Promise<void> {
  if (input.amount <= 0) return;

  const now = input.now ?? new Date();
  const day = budgetDay(now);
  const current = await readBudget(input.uid, now);

  await adminDb()
    .collection(BUDGET_COLLECTION)
    .doc(docId(input.uid, day))
    .set({
      ...current,
      day,
      [input.kind]: current[input.kind] + input.amount,
      updatedAt: now.toISOString(),
    });
}

/** Has this user already spent the budget for `kind` today? */
export async function budgetSpent(
  uid: string,
  kind: BudgetKind,
  now: Date = new Date(),
): Promise<boolean> {
  const state = await readBudget(uid, now);
  return state[kind] >= CEILINGS[kind];
}
