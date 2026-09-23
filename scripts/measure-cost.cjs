/**
 * What a full-history import actually costs in Firestore.
 *
 * Runs the real adapter — real download, real GPX parse, real normalize, real
 * thinning and the real storage caps — over a sample of this athlete's history,
 * and measures the documents that would be written. Nothing is written and no
 * database is touched.
 *
 * Reads the compiled output in `.test-build`, so run `npm test` (or
 * `npx tsc -p tsconfig.test.json`) first.
 *
 *   node scripts/measure-cost.cjs [sampleSize]
 */

require("../.test-build/tests/helpers/alias.js");

const { intervalsIcuSource } = require("../.test-build/src/lib/ingestion/adapters/intervalsIcu.js");
const store = require("../.test-build/src/lib/ingestion/store.js");
const { decideSummaryScope } = require("../.test-build/src/lib/ingestion/sportPolicy.js");

const KEY = process.env.INTERVALS_API_KEY;
const ATHLETE = process.env.INTERVALS_ATHLETE_ID;
if (!KEY || !ATHLETE) {
  console.error("INTERVALS_API_KEY and INTERVALS_ATHLETE_ID must be set");
  process.exit(1);
}

const sampleSize = Number(process.argv[2] || 40);
const credentials = { authMode: "api_key", apiKey: KEY, externalId: ATHLETE };

const mb = (bytes) => +(bytes / 1024 / 1024).toFixed(1);

async function main() {
  const page = await intervalsIcuSource.listActivitiesSince(credentials, {
    since: "1990-01-01T00:00:00.000Z",
    until: new Date().toISOString(),
  });

  const eligible = page.activities.filter((activity) => decideSummaryScope(activity).ingest);

  // Spread the sample across the whole history rather than taking the newest N:
  // track length and recording device change enormously between 2011 and 2026.
  const step = Math.max(1, Math.floor(eligible.length / sampleSize));
  const sample = eligible.filter((_, index) => index % step === 0).slice(0, sampleSize);

  const rows = [];
  for (const summary of sample) {
    try {
      const file = await intervalsIcuSource.fetchActivityFile(credentials, summary.sourceActivityId);
      if (!file) continue;
      const normalized = intervalsIcuSource.normalize({ ownerUid: "measure", summary, file });

      const rawPoints = normalized.coordinates.length;
      const stored = store.thinForStorage(normalized.coordinates, store.MAX_STORED_TRACK_POINTS);
      const stapledSamples = store.thinForStorage(normalized.samples || [], store.MAX_STORED_SAMPLES);

      const routeBytes = Buffer.byteLength(
        JSON.stringify({
          coordinates: stored.map(([lon, lat]) => ({ lat, lon })),
          samples: stapledSamples,
        }),
      );
      const activityBytes = Buffer.byteLength(
        JSON.stringify(Object.assign({}, normalized, { coordinates: undefined, samples: undefined })),
      );

      rows.push({
        year: String(summary.startedAt).slice(0, 4),
        gpxBytes: Buffer.byteLength(typeof file.content === "string" ? file.content : ""),
        rawPoints,
        storedPoints: stored.length,
        routeBytes,
        activityBytes,
        // Firestore builds index entries per array element; an array of maps
        // costs entries per field per element. This is what blows the
        // per-document index budget, not the raw byte count.
        indexEntries: stored.length * 2 * 2,
      });
    } catch (error) {
      rows.push({ error: String((error && error.message) || error) });
    }
  }

  const ok = rows.filter((row) => !row.error);
  const mean = (pick) => ok.reduce((total, row) => total + pick(row), 0) / Math.max(1, ok.length);
  const max = (pick) => Math.max.apply(null, ok.map(pick));

  const population = eligible.length;

  console.log(
    JSON.stringify(
      {
        sampled: ok.length,
        failed: rows.filter((row) => row.error).length,
        failures: rows.filter((row) => row.error).slice(0, 5),
        eligiblePopulation: population,
        perActivity: {
          gpxBytesMean: Math.round(mean((r) => r.gpxBytes)),
          rawPointsMean: Math.round(mean((r) => r.rawPoints)),
          rawPointsMax: max((r) => r.rawPoints),
          storedPointsMean: Math.round(mean((r) => r.storedPoints)),
          routeBytesMean: Math.round(mean((r) => r.routeBytes)),
          routeBytesMax: max((r) => r.routeBytes),
          activityBytesMean: Math.round(mean((r) => r.activityBytes)),
          indexEntriesMax: max((r) => r.indexEntries),
        },
        fullImportProjection: {
          // Per activity: the canonical record, the route, and one audit row.
          // Raw payloads are off for history imports.
          documentWrites: population * 3,
          storedMB: mb(population * (mean((r) => r.routeBytes) + mean((r) => r.activityBytes))),
          downloadedMB: mb(population * mean((r) => r.gpxBytes)),
          rawPayloadMBIfRetained: mb(population * mean((r) => r.gpxBytes)),
        },
        thinningBite: {
          overCap: ok.filter((r) => r.rawPoints > store.MAX_STORED_TRACK_POINTS).length,
          ofSampled: ok.length,
        },
        yearsCovered: Object.keys(
          ok.reduce((acc, r) => Object.assign(acc, { [r.year]: true }), {}),
        ).sort(),
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
