/**
 * Measure what intervals.icu actually enforces, and what this athlete's
 * history actually costs. Read-only: it lists activities and downloads GPX.
 *
 * Credentials are read from the environment. Nothing is printed that could
 * identify or reconstruct them.
 *
 *   node scripts/measure-intervals.mjs
 */

const KEY = process.env.INTERVALS_API_KEY;
const ATHLETE = process.env.INTERVALS_ATHLETE_ID;
if (!KEY || !ATHLETE) {
  console.error("INTERVALS_API_KEY and INTERVALS_ATHLETE_ID must be set");
  process.exit(1);
}

const BASE = "https://intervals.icu/api/v1";
// intervals.icu uses HTTP basic with the literal username "API_KEY".
const AUTH = "Basic " + Buffer.from(["API_KEY", KEY].join(":")).toString("base64");

async function call(path) {
  const started = Date.now();
  const res = await fetch(BASE + path, {
    headers: { Authorization: AUTH, "User-Agent": "gpx-runner-measurement" },
  });
  return { res, ms: Date.now() - started };
}

function rateLimitHeaders(res) {
  const found = {};
  for (const [name, value] of res.headers.entries()) {
    if (/ratelimit|retry-after|x-rate/i.test(name)) found[name] = value;
  }
  return found;
}

const out = {};

// 1. The whole history in one listing call, the way planImport does it.
{
  const { res, ms } = await call(
    `/athlete/${ATHLETE}/activities?oldest=1990-01-01T00:00:00&newest=2026-12-31T00:00:00`,
  );
  const text = await res.text();
  out.listing = {
    status: res.status,
    ms,
    bytes: Buffer.byteLength(text),
    rateLimitHeaders: rateLimitHeaders(res),
  };
  if (res.ok) {
    const all = JSON.parse(text);
    const foot = all.filter((a) => /run/i.test(a.type ?? ""));
    const outdoorFoot = foot.filter((a) => !a.trainer && !/virtual/i.test(a.type ?? ""));
    const dated = all
      .map((a) => a.start_date_local)
      .filter(Boolean)
      .sort();
    out.account = {
      totalActivities: all.length,
      footSports: foot.length,
      outdoorFootSports: outdoorFoot.length,
      earliest: dated[0],
      latest: dated[dated.length - 1],
      typeBreakdown: Object.entries(
        all.reduce((acc, a) => ((acc[a.type ?? "?"] = (acc[a.type ?? "?"] ?? 0) + 1), acc), {}),
      )
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12),
    };
    globalThis.__runs = outdoorFoot;
  }
}

// 2. Sequential GPX downloads: real per-file latency and payload size.
{
  const runs = (globalThis.__runs ?? []).slice(0, 30);
  const samples = [];
  for (const run of runs) {
    const { res, ms } = await call(`/activity/${run.id}/gpx-file`);
    const body = await res.arrayBuffer();
    samples.push({ status: res.status, ms, bytes: body.byteLength });
    if (res.status === 429) {
      out.sequentialRateLimited = { at: samples.length, headers: rateLimitHeaders(res) };
      break;
    }
  }
  const ok = samples.filter((s) => s.status === 200);
  out.sequentialDownloads = {
    attempted: samples.length,
    ok: ok.length,
    statuses: [...new Set(samples.map((s) => s.status))],
    msMedian: median(ok.map((s) => s.ms)),
    msMax: Math.max(...ok.map((s) => s.ms)),
    bytesMedian: median(ok.map((s) => s.bytes)),
    bytesMean: Math.round(ok.reduce((sum, s) => sum + s.bytes, 0) / Math.max(1, ok.length)),
    bytesMax: Math.max(...ok.map((s) => s.bytes)),
  };
}

// 3. A burst, to find the real concurrency ceiling.
{
  const runs = (globalThis.__runs ?? []).slice(30, 60);
  if (runs.length) {
    const started = Date.now();
    const results = await Promise.all(
      runs.map(async (run) => {
        const { res, ms } = await call(`/activity/${run.id}/gpx-file`);
        await res.arrayBuffer();
        return { status: res.status, ms, headers: rateLimitHeaders(res) };
      }),
    );
    out.burst = {
      concurrent: runs.length,
      wallMs: Date.now() - started,
      statuses: results.reduce((acc, r) => ((acc[r.status] = (acc[r.status] ?? 0) + 1), acc), {}),
      anyRateLimitHeaders: results.map((r) => r.headers).filter((h) => Object.keys(h).length),
    };
  }
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

console.log(JSON.stringify(out, null, 2));
