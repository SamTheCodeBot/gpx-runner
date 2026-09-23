/**
 * How does intervals.icu's activity listing actually behave?
 *
 * Specifically: does `limit` truncate from the newest end, is there an offset,
 * and what does the field-projected payload cost? The import's planning pass
 * depends on all three.
 */

const KEY = process.env.INTERVALS_API_KEY;
const ATHLETE = process.env.INTERVALS_ATHLETE_ID;
const AUTH = "Basic " + Buffer.from(["API_KEY", KEY].join(":")).toString("base64");

const FIELDS = [
  "id",
  "start_date_local",
  "type",
  "distance",
  "moving_time",
  "total_elevation_gain",
  "trainer",
  "source",
  "name",
  "timezone",
].join(",");

async function list(params) {
  const qs = new URLSearchParams(params).toString();
  const started = Date.now();
  const res = await fetch(`https://intervals.icu/api/v1/athlete/${ATHLETE}/activities?${qs}`, {
    headers: { Authorization: AUTH, "User-Agent": "gpx-runner-measurement" },
  });
  const text = await res.text();
  const body = res.ok ? JSON.parse(text) : [];
  const dates = body.map((a) => a.start_date_local).filter(Boolean).sort();
  return {
    status: res.status,
    ms: Date.now() - started,
    bytes: Buffer.byteLength(text),
    count: body.length,
    earliest: dates[0],
    latest: dates[dates.length - 1],
  };
}

const out = {};
const WIDE = { oldest: "1990-01-01T00:00:00", newest: "2026-12-31T00:00:00" };

out.noLimitWithFields = await list({ ...WIDE, fields: FIELDS });
out.limit200WithFields = await list({ ...WIDE, fields: FIELDS, limit: "200" });
out.limit5 = await list({ ...WIDE, fields: FIELDS, limit: "5" });

// Does the window actually let us page backwards past the limit?
if (out.limit5.earliest) {
  const before = new Date(new Date(`${out.limit5.earliest}Z`).valueOf() - 1000)
    .toISOString()
    .replace(/\.\d+Z$/, "");
  out.pagedBackFromLimit5 = await list({
    oldest: "1990-01-01T00:00:00",
    newest: before,
    fields: FIELDS,
    limit: "5",
  });
}

console.log(JSON.stringify(out, null, 2));
