import { adminDb } from "@/lib/firebaseAdmin";
import type { Street } from "@/engine/streets/inventory";
import { decodeScope, decodeStreets, encodeScope, encodeStreets, chunkStreets, type WireStreet } from "@/engine/streets/serialize";
import type { StreetScope } from "@/engine/streets/scope";
import type { StreetProjectSummary } from "@/engine/streets/project";

/**
 * Storage for street completion projects.
 *
 * The project document holds the area and the headline numbers; the street list
 * itself lives in `inventory` chunks beneath it, because a town is tens of
 * thousands of coordinates and a Firestore document stops at a megabyte.
 *
 * Everything here runs through the Admin SDK on the server. Clients never write
 * these documents: the snapshot is the contract behind every percentage the
 * owner sees, and a snapshot a browser could edit would be worth nothing.
 */

export const PROJECT_COLLECTION = "streetProjects";
const INVENTORY_SUBCOLLECTION = "inventory";
const PENDING_DOC = "pendingAdditions";

export type StoredProject = StreetProjectSummary & { ownerUid: string; chunkCount: number };

type ProjectDoc = {
  ownerUid: string;
  name: string;
  createdAt: string;
  archivedAt: string | null;
  scope: ReturnType<typeof encodeScope>;
  streetCount: number;
  totalMeters: number;
  wayCount: number;
  snapshotTakenAt: string;
  chunkCount: number;
  lastRefreshedAt?: string | null;
  pendingAdditionCount?: number;
};

function toSummary(id: string, data: ProjectDoc): StoredProject {
  return {
    id,
    ownerUid: data.ownerUid,
    name: data.name,
    createdAt: data.createdAt,
    archivedAt: data.archivedAt ?? null,
    scope: decodeScope(data.scope),
    streetCount: data.streetCount ?? 0,
    totalMeters: data.totalMeters ?? 0,
    wayCount: data.wayCount ?? 0,
    snapshotTakenAt: data.snapshotTakenAt ?? data.createdAt,
    chunkCount: data.chunkCount ?? 0,
    lastRefreshedAt: data.lastRefreshedAt ?? null,
    pendingAdditionCount: data.pendingAdditionCount ?? 0,
  };
}

export async function createProject(input: {
  ownerUid: string;
  name: string;
  scope: StreetScope;
  streets: Street[];
  wayCount: number;
  takenAt?: string;
}): Promise<StoredProject> {
  const db = adminDb();
  const now = new Date().toISOString();
  const wire = encodeStreets(input.streets);
  const chunks = chunkStreets(wire);

  const ref = db.collection(PROJECT_COLLECTION).doc();
  const doc: ProjectDoc = {
    ownerUid: input.ownerUid,
    name: input.name,
    createdAt: now,
    archivedAt: null,
    scope: encodeScope(input.scope),
    streetCount: input.streets.length,
    totalMeters: Math.round(input.streets.reduce((sum, street) => sum + street.lengthMeters, 0)),
    wayCount: input.wayCount,
    snapshotTakenAt: input.takenAt ?? now,
    chunkCount: chunks.length,
    lastRefreshedAt: null,
    pendingAdditionCount: 0,
  };

  const batch = db.batch();
  batch.set(ref, doc);
  chunks.forEach((chunk, index) => {
    batch.set(ref.collection(INVENTORY_SUBCOLLECTION).doc(String(index)), { index, streets: chunk });
  });
  await batch.commit();

  return toSummary(ref.id, doc);
}

export async function listProjects(ownerUid: string): Promise<StoredProject[]> {
  const snap = await adminDb().collection(PROJECT_COLLECTION).where("ownerUid", "==", ownerUid).get();

  return snap.docs
    .map((doc) => toSummary(doc.id, doc.data() as ProjectDoc))
    .sort((a, b) => {
      // Archived projects keep their history but drop to the bottom: they are
      // finished chapters, not clutter to be deleted.
      if (Boolean(a.archivedAt) !== Boolean(b.archivedAt)) return a.archivedAt ? 1 : -1;
      return b.createdAt.localeCompare(a.createdAt);
    });
}

export async function loadProject(
  ownerUid: string,
  projectId: string,
): Promise<{ project: StoredProject; streets: Street[] } | null> {
  const ref = adminDb().collection(PROJECT_COLLECTION).doc(projectId);
  const doc = await ref.get();
  if (!doc.exists) return null;

  const data = doc.data() as ProjectDoc;
  if (data.ownerUid !== ownerUid) return null;

  const chunks = await ref.collection(INVENTORY_SUBCOLLECTION).get();
  const wire = chunks.docs
    .sort((a, b) => Number(a.id) - Number(b.id))
    .flatMap((chunk) => (chunk.get("streets") as WireStreet[]) ?? []);

  return { project: toSummary(doc.id, data), streets: decodeStreets(wire) };
}

export async function updateProject(
  ownerUid: string,
  projectId: string,
  patch: { name?: string; archived?: boolean },
): Promise<StoredProject | null> {
  const ref = adminDb().collection(PROJECT_COLLECTION).doc(projectId);
  const doc = await ref.get();
  if (!doc.exists || (doc.data() as ProjectDoc).ownerUid !== ownerUid) return null;

  const update: Partial<ProjectDoc> = {};
  if (typeof patch.name === "string" && patch.name.trim()) update.name = patch.name.trim().slice(0, 80);
  if (typeof patch.archived === "boolean") update.archivedAt = patch.archived ? new Date().toISOString() : null;

  if (Object.keys(update).length > 0) await ref.update(update);

  const fresh = await ref.get();
  return toSummary(fresh.id, fresh.data() as ProjectDoc);
}

/**
 * Park what OSM has gained until the owner has an opinion about it.
 *
 * Written beside the project rather than into it: until these are adopted they
 * are news, not part of the denominator, and nothing that computes a percentage
 * is allowed to see them.
 */
export async function savePendingAdditions(
  projectId: string,
  additions: Street[],
  removedNames: string[],
): Promise<void> {
  const db = adminDb();
  const ref = db.collection(PROJECT_COLLECTION).doc(projectId);
  const now = new Date().toISOString();

  await db.runTransaction(async (tx) => {
    tx.set(ref.collection(INVENTORY_SUBCOLLECTION).doc(PENDING_DOC), {
      foundAt: now,
      streets: encodeStreets(additions),
      removedNames,
    });
    tx.update(ref, { lastRefreshedAt: now, pendingAdditionCount: additions.length });
  });
}

export async function loadPendingAdditions(
  ownerUid: string,
  projectId: string,
): Promise<{ streets: Street[]; removedNames: string[]; foundAt: string | null }> {
  const ref = adminDb().collection(PROJECT_COLLECTION).doc(projectId);
  const doc = await ref.get();
  if (!doc.exists || (doc.data() as ProjectDoc).ownerUid !== ownerUid) {
    return { streets: [], removedNames: [], foundAt: null };
  }

  const pending = await ref.collection(INVENTORY_SUBCOLLECTION).doc(PENDING_DOC).get();
  if (!pending.exists) return { streets: [], removedNames: [], foundAt: null };

  return {
    streets: decodeStreets((pending.get("streets") as WireStreet[]) ?? []),
    removedNames: (pending.get("removedNames") as string[]) ?? [],
    foundAt: (pending.get("foundAt") as string) ?? null,
  };
}

/**
 * Fold chosen additions into the snapshot.
 *
 * The whole street list is rewritten rather than appended to, so the chunking
 * stays sized by bytes and a project never ends up with one document holding a
 * single street.
 */
export async function adoptPendingAdditions(
  ownerUid: string,
  projectId: string,
  streetIds: string[],
): Promise<{ project: StoredProject; adopted: Street[] } | null> {
  const loaded = await loadProject(ownerUid, projectId);
  if (!loaded) return null;

  const pending = await loadPendingAdditions(ownerUid, projectId);
  const wanted = new Set(streetIds);
  const adopted = pending.streets.filter((street) => wanted.has(street.id));
  if (adopted.length === 0) return { project: loaded.project, adopted: [] };

  const merged = [...loaded.streets, ...adopted].sort(
    (a, b) => a.name.localeCompare(b.name, "sv-SE") || a.part - b.part,
  );

  const db = adminDb();
  const ref = db.collection(PROJECT_COLLECTION).doc(projectId);
  const chunks = chunkStreets(encodeStreets(merged));
  const existing = await ref.collection(INVENTORY_SUBCOLLECTION).get();

  const batch = db.batch();
  for (const doc of existing.docs) {
    if (doc.id !== PENDING_DOC) batch.delete(doc.ref);
  }
  chunks.forEach((chunk, index) => {
    batch.set(ref.collection(INVENTORY_SUBCOLLECTION).doc(String(index)), { index, streets: chunk });
  });

  const remaining = pending.streets.filter((street) => !wanted.has(street.id));
  batch.set(ref.collection(INVENTORY_SUBCOLLECTION).doc(PENDING_DOC), {
    foundAt: pending.foundAt ?? new Date().toISOString(),
    streets: encodeStreets(remaining),
    removedNames: pending.removedNames,
  });

  batch.update(ref, {
    streetCount: merged.length,
    totalMeters: Math.round(merged.reduce((sum, street) => sum + street.lengthMeters, 0)),
    chunkCount: chunks.length,
    snapshotTakenAt: new Date().toISOString(),
    pendingAdditionCount: remaining.length,
  });

  await batch.commit();

  const fresh = await ref.get();
  return { project: toSummary(fresh.id, fresh.data() as ProjectDoc), adopted };
}

export async function deleteProjectData(ownerUid: string, projectId: string): Promise<boolean> {
  const ref = adminDb().collection(PROJECT_COLLECTION).doc(projectId);
  const doc = await ref.get();
  if (!doc.exists || (doc.data() as ProjectDoc).ownerUid !== ownerUid) return false;

  const chunks = await ref.collection(INVENTORY_SUBCOLLECTION).get();
  const batch = adminDb().batch();
  for (const chunk of chunks.docs) batch.delete(chunk.ref);
  batch.delete(ref);
  await batch.commit();
  return true;
}
