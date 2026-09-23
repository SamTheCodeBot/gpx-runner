import Module from "node:module";
import path from "node:path";

/**
 * An in-memory stand-in for the Firestore handle `@/lib/firebaseAdmin` exports.
 *
 * The point is to test the real code rather than a sketch of it. The history
 * import's two hardest claims — that an interrupted import resumes instead of
 * restarting, and that a second full import writes nothing new — are claims
 * about what reaches the database, so a test that stubs `ingestActivity` proves
 * nothing about either. With this in place the tests drive the actual
 * `runHistoryBatch`, `ingestActivity`, dedupe and cursor code, and then look at
 * what is in the store afterwards.
 *
 * It implements exactly the Firestore surface the ingestion spine uses:
 * `collection().doc()` get/set/delete, chained `where` equality filters with
 * `select`, and `getAll` with a field mask. Anything else throws loudly rather
 * than quietly returning nothing.
 */

export type DocData = Record<string, unknown>;

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

function readPath(data: DocData, field: string): unknown {
  return field.split(".").reduce<unknown>((current, part) => {
    if (current && typeof current === "object") return (current as DocData)[part];
    return undefined;
  }, data);
}

function snapshotOf(id: string, data: DocData | undefined) {
  return {
    id,
    exists: data !== undefined,
    data: () => clone(data),
    get: (field: string) => (data ? clone(readPath(data, field)) : undefined),
    ref: { id },
  };
}

export class FakeFirestore {
  /** collection name -> doc id -> data */
  readonly store = new Map<string, Map<string, DocData>>();

  /** Every read and write, so tests can assert on cost and on idempotency. */
  readonly reads: { collection: string; kind: "doc" | "query" | "getAll"; count: number }[] = [];
  readonly writes: { collection: string; id: string; op: "set" | "delete" }[] = [];

  private coll(name: string): Map<string, DocData> {
    let existing = this.store.get(name);
    if (!existing) {
      existing = new Map();
      this.store.set(name, existing);
    }
    return existing;
  }

  /** Total documents read, the number Firestore would actually bill for. */
  get readCount(): number {
    return this.reads.reduce((total, entry) => total + entry.count, 0);
  }

  get writeCount(): number {
    return this.writes.length;
  }

  resetCounters(): void {
    this.reads.length = 0;
    this.writes.length = 0;
  }

  docs(collection: string): DocData[] {
    return Array.from(this.coll(collection).values()).map((data) => clone(data));
  }

  collection(name: string) {
    const self = this;
    const collectionRef = {
      doc(id: string) {
        return {
          id,
          get path() {
            return `${name}/${id}`;
          },
          async get() {
            self.reads.push({ collection: name, kind: "doc", count: 1 });
            return snapshotOf(id, self.coll(name).get(id));
          },
          async set(data: DocData, options?: { merge?: boolean }) {
            const previous = self.coll(name).get(id);
            const next =
              options?.merge && previous ? { ...previous, ...clone(data) } : clone(data);
            self.coll(name).set(id, next);
            self.writes.push({ collection: name, id, op: "set" });
          },
          async delete() {
            self.coll(name).delete(id);
            self.writes.push({ collection: name, id, op: "delete" });
          },
          /** Marker so `getAll` can tell which collection a ref belongs to. */
          __fake: { collection: name, id },
        };
      },
      where(field: string, op: string, value: unknown) {
        if (op !== "==") throw new Error(`FakeFirestore only implements "==", got "${op}"`);
        return makeQuery([{ field, value }], undefined);
      },
    };

    function makeQuery(
      filters: { field: string; value: unknown }[],
      fields: string[] | undefined,
    ) {
      const query = {
        where(field: string, op: string, value: unknown) {
          if (op !== "==") throw new Error(`FakeFirestore only implements "==", got "${op}"`);
          return makeQuery([...filters, { field, value }], fields);
        },
        select(...selected: string[]) {
          return makeQuery(filters, selected);
        },
        limit(count: number) {
          return { ...query, async get() { return run(count); } };
        },
        async get() {
          return run();
        },
      };

      async function run(limit?: number) {
        const all = Array.from(self.coll(name).entries())
          .filter(([, data]) => filters.every((f) => readPath(data, f.field) === f.value))
          .slice(0, limit ?? Infinity);
        self.reads.push({ collection: name, kind: "query", count: all.length });

        const docs = all.map(([id, data]) => {
          const projected = fields
            ? Object.fromEntries(fields.map((f) => [f, readPath(data, f)]))
            : data;
          return snapshotOf(id, projected as DocData);
        });

        return {
          docs,
          empty: docs.length === 0,
          size: docs.length,
          forEach: (fn: (doc: (typeof docs)[number]) => void) => docs.forEach(fn),
        };
      }

      return query;
    }

    return collectionRef;
  }

  async getAll(...args: unknown[]) {
    const refs = args.filter(
      (arg): arg is { __fake: { collection: string; id: string } } =>
        Boolean(arg && typeof arg === "object" && "__fake" in (arg as object)),
    );
    this.reads.push({ collection: "getAll", kind: "getAll", count: refs.length });
    return refs.map((ref) =>
      snapshotOf(ref.__fake.id, this.coll(ref.__fake.collection).get(ref.__fake.id)),
    );
  }
}

/**
 * The instance `adminDb()` currently hands out.
 *
 * Indirection rather than a fresh module each time, because the modules under
 * test bind `adminDb` at import time: replacing the cached module afterwards
 * would leave them holding the first database for ever, and every test after
 * the first would silently assert against an empty store.
 */
const holder: { db: FakeFirestore | null } = { db: null };
let installed = false;

/**
 * Put the fake in the module cache before anything requires the real one, and
 * hand back a clean database. Safe to call again between tests.
 *
 * `@/lib/firebaseAdmin` reaches for a service account the moment it is asked
 * for a handle, so it has to be replaced rather than configured. Must be called
 * before importing any module that uses it.
 */
export function installFakeFirestore(): FakeFirestore {
  const db = new FakeFirestore();
  holder.db = db;
  if (installed) return db;
  installed = true;

  const resolved = path.resolve(__dirname, "..", "..", "src", "lib", "firebaseAdmin.ts");
  const jsPath = resolved.replace(/\.ts$/, ".js");
  const candidates = [resolved, jsPath];

  for (const candidate of candidates) {
    const stub = new Module(candidate, undefined) as Module & { exports: DocData };
    stub.filename = candidate;
    stub.loaded = true;
    stub.exports = {
      adminDb: () => {
        if (!holder.db) throw new Error("installFakeFirestore() was never called");
        return holder.db;
      },
      adminAuth: () => {
        throw new Error("adminAuth is not available in tests");
      },
    };
    require.cache[candidate] = stub as unknown as NodeJS.Module;
  }

  return db;
}
