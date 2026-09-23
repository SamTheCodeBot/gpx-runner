/**
 * A stand-in intervals.icu, served through `global.fetch`.
 *
 * Stubbing at the network boundary rather than at the adapter means the tests
 * run the real HTTP client, the real adapter, the real sport policy and the
 * real GPX parser. A history import that only worked because the adapter was
 * replaced by a stub would not be worth much.
 *
 * It answers the two endpoints the import uses and counts every call, so a test
 * can assert that a resumed import does not re-download what it already has.
 */

export type FakeActivity = {
  id: string;
  /** Local ISO with no offset, exactly as intervals.icu serves it. */
  start_date_local: string;
  type: string;
  distance: number;
  moving_time: number;
  total_elevation_gain?: number;
  trainer?: boolean;
  source?: string;
  name?: string;
};

export type FakeIntervals = {
  activities: FakeActivity[];
  listCalls: { oldest: string; newest: string; returned: number }[];
  gpxCalls: string[];
  /** Ids that should fail the GPX download, and how. */
  failGpx: Map<string, { status: number }>;
  /** Throw a transport error after this many GPX downloads. Then reset. */
  breakAfterDownloads: number | null;
  restore: () => void;
};

/** Small, valid GPX with a handful of points so the parser has real work. */
export function gpxFor(activity: FakeActivity): string {
  const start = new Date(`${activity.start_date_local}Z`).valueOf();
  const points = Math.max(4, Math.min(40, Math.round(activity.moving_time / 60)));
  const trkpts = Array.from({ length: points }, (_, index) => {
    const lat = (56.9 + index * 0.0009).toFixed(6);
    const lon = (12.49 + index * 0.0011).toFixed(6);
    const time = new Date(start + index * 60_000).toISOString();
    return `<trkpt lat="${lat}" lon="${lon}"><ele>${10 + index}</ele><time>${time}</time></trkpt>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="fake"><trk><name>${
    activity.name ?? "Run"
  }</name><trkseg>${trkpts}</trkseg></trk></gpx>`;
}

export function installFakeIntervals(activities: FakeActivity[]): FakeIntervals {
  const original = global.fetch;

  const fake: FakeIntervals = {
    activities,
    listCalls: [],
    gpxCalls: [],
    failGpx: new Map(),
    breakAfterDownloads: null,
    restore: () => {
      global.fetch = original;
    },
  };

  global.fetch = (async (input: unknown) => {
    const url = new URL(String(input));

    if (/\/api\/v1\/athlete\/[^/]+\/activities$/.test(url.pathname)) {
      const oldest = url.searchParams.get("oldest") ?? "1970-01-01T00:00:00";
      const newest = url.searchParams.get("newest") ?? "2999-01-01T00:00:00";
      const from = new Date(`${oldest}Z`).valueOf();
      const to = new Date(`${newest}Z`).valueOf();

      const matched = fake.activities.filter((activity) => {
        const at = new Date(`${activity.start_date_local}Z`).valueOf();
        return at >= from && at <= to;
      });

      fake.listCalls.push({ oldest, newest, returned: matched.length });
      return new Response(JSON.stringify(matched), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    const gpxMatch = /^\/api\/v1\/activity\/([^/]+)\/gpx-file$/.exec(url.pathname);
    if (gpxMatch) {
      const id = decodeURIComponent(gpxMatch[1]);

      if (
        fake.breakAfterDownloads !== null &&
        fake.gpxCalls.length >= fake.breakAfterDownloads
      ) {
        fake.breakAfterDownloads = null;
        // What a dropped connection mid-import actually looks like.
        throw new TypeError("fetch failed");
      }

      fake.gpxCalls.push(id);

      const failure = fake.failGpx.get(id);
      if (failure) {
        return new Response("nope", { status: failure.status });
      }

      const activity = fake.activities.find((candidate) => candidate.id === id);
      if (!activity) return new Response("not found", { status: 404 });
      return new Response(gpxFor(activity), { status: 200 });
    }

    throw new Error(`FakeIntervals got an unexpected request: ${url.pathname}`);
  }) as typeof global.fetch;

  return fake;
}

/**
 * A believable history: many years, uneven density, and a gap in the middle.
 *
 * Anything dated in the future is dropped. The import's window stops at "now",
 * so a generator that quietly produced next month's runs would make every count
 * in every test wrong by an amount that changes with the calendar.
 */
export function buildHistory(options: {
  years: number[];
  runsPerYear: number;
}): FakeActivity[] {
  const activities: FakeActivity[] = [];
  const cutoff = Date.now();
  let sequence = 0;

  for (const year of options.years) {
    for (let index = 0; index < options.runsPerYear; index += 1) {
      const month = String(((index * 3) % 12) + 1).padStart(2, "0");
      const day = String(((index * 7) % 27) + 1).padStart(2, "0");
      const hour = String((index % 12) + 6).padStart(2, "0");
      const startedAt = `${year}-${month}-${day}T${hour}:30:00`;
      if (new Date(`${startedAt}Z`).valueOf() >= cutoff) continue;
      sequence += 1;
      activities.push({
        id: `a${sequence}`,
        start_date_local: startedAt,
        type: index % 9 === 0 ? "TrailRun" : "Run",
        distance: 5000 + index * 137,
        moving_time: 1800 + index * 11,
        total_elevation_gain: 40,
        source: "GARMIN_CONNECT",
        name: `Run ${sequence}`,
      });
    }
  }

  return activities;
}
