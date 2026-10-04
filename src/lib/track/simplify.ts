/**
 * Shape-preserving line simplification for the overview map.
 *
 * WHY THIS FILE EXISTS
 *
 * routes/summaries used to cut every track to its overview point budget
 * (120 points) with the same trick used elsewhere in this repo: keep every
 * Nth point by ARRAY INDEX. That is fine on a roughly straight stretch, and
 * silently wrong wherever a route doubles back on itself (an out-and-back
 * leg, a loop, a tight U-turn): the kept points on the outbound and return
 * legs can be many array-indices apart while sitting only metres apart on
 * the ground, and a sparse enough cut connects two of them with one long
 * straight line stitched across the gap -- every point on that line is
 * real, the line between them is not a path the runner ever took. This was
 * confirmed live: an intervals.icu-sourced run (far denser GPS sampling
 * than this app's older manual uploads -- up to 4,000 stored points for one
 * run, see MAX_STORED_TRACK_POINTS, against maybe a few hundred for an
 * older lower-rate upload) looked correct in the single-route detail view
 * (a 200-point budget, same index-based cut, just less aggressive) and
 * wrong in this 120-point overview. One blind spot -- index-based thinning
 * has no notion of a point being a turn -- amplified harder by a smaller
 * budget on a denser source track.
 *
 * A first attempt at a fix used Douglas-Peucker. It is the textbook answer
 * for "simplify this line" and it is the wrong tool for "simplify this line
 * to an exact POINT COUNT": DP’s recursive splitting allocates points by
 * GLOBAL deviation from the chord of whichever span it is currently
 * subdividing, which can and did spend most of a 120-point budget on one
 * curvier-than-average stretch while leaving a comparatively straighter
 * stretch elsewhere under-served -- a different, still-visible version of
 * the original problem, caught by this file's own tests before it shipped
 * a second time.
 *
 * THE FIX: VISVALINGAM-WHYATT
 *
 * Repeatedly remove whichever point currently contributes the LEAST to the
 * line's shape -- measured as the area of the triangle it forms with its
 * current immediate neighbours -- reconnecting its two neighbours directly,
 * and recomputing their triangle areas now that they are adjacent. Stop once
 * down to the point budget.
 *
 * This is the property DP and index-thinning both lack: a point is NEVER
 * reconnected to anything except its own current immediate neighbour in the
 * sequence. The algorithm can never produce a line between two points that
 * were not already next to each other after everything between them was
 * judged insignificant and removed -- it cannot teleport a connection
 * across a gap the runner never ran through, which is exactly the failure
 * mode this file exists to close off. Verified directly: in the adversarial
 * out-and-back fixture this file's own tests construct, the longest
 * resulting segment sits in the middle of one straight leg, nowhere near
 * the turnaround -- see tests/simplify.test.ts.
 *
 * COST BOUND
 *
 * This endpoint already decodes every route a user owns in one request
 * (one real account: 1,442 decodes in one request -- see that endpoint's
 * own file comment). The straightforward Visvalingam-Whyatt implementation
 * below rescans for the globally smallest triangle on every removal, which
 * is O(n²); left unbounded that is a real risk multiplied across hundreds
 * of routes in one request. A cheap, DISTANCE-based pre-thin runs first
 * specifically to cap n at PRE_SIMPLIFY_CAP before the O(n²) step ever
 * runs, independent of how many thousands of raw points one ultra-distance
 * run holds. It is distance-based rather than index-based for the same
 * reason as the main fix: an index-based pre-thin can reintroduce the
 * exact cross-leg artefact one step earlier in the pipeline, which is
 * exactly what the first, now-reverted version of this pre-thin did.
 */

type Coordinate = [number, number];

const EARTH_RADIUS_M = 6371000;

/** Local equirectangular projection to metres -- adequate at the scale of
 * one running route (a few kilometres); every use below is a threshold or
 * ordering comparison, never a stored distance, so the small error far from
 * the reference latitude is irrelevant here. */
function toLocalMeters(point: Coordinate, refLatRad: number): [number, number] {
  const [lon, lat] = point;
  const x = ((lon * Math.PI) / 180) * EARTH_RADIUS_M * Math.cos(refLatRad);
  const y = ((lat * Math.PI) / 180) * EARTH_RADIUS_M;
  return [x, y];
}

function pointDistanceMeters(a: Coordinate, b: Coordinate): number {
  const refLatRad = (a[1] * Math.PI) / 180;
  const [ax, ay] = toLocalMeters(a, refLatRad);
  const [bx, by] = toLocalMeters(b, refLatRad);
  return Math.hypot(ax - bx, ay - by);
}

/** Twice the signed area of the triangle a-b-c, in square metres. Doubling
 * and dropping the sign costs nothing here: every use is a magnitude
 * comparison between triangles, never a stored measurement. */
function triangleAreaMeters(a: Coordinate, b: Coordinate, c: Coordinate): number {
  const refLatRad = (b[1] * Math.PI) / 180;
  const [ax, ay] = toLocalMeters(a, refLatRad);
  const [bx, by] = toLocalMeters(b, refLatRad);
  const [cx, cy] = toLocalMeters(c, refLatRad);
  return Math.abs((bx - ax) * (cy - ay) - (cx - ax) * (by - ay)) / 2;
}

function pathLengthMeters(coords: Coordinate[]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i += 1) {
    total += pointDistanceMeters(coords[i - 1], coords[i]);
  }
  return total;
}

/**
 * Reduces a track toward roughly targetCount points by keeping a point only
 * once at least minSpacingMeters of REAL distance has accumulated since the
 * last point actually kept -- distance along the path the runner covered,
 * never position in the array. A point can only ever be skipped once the
 * path has genuinely moved past it, so this cannot connect two points
 * across a gap the runner did not cover, unlike an index-based pre-thin.
 */
function distanceThin(coords: Coordinate[], targetCount: number): Coordinate[] {
  if (coords.length <= targetCount) return coords;

  const totalMeters = pathLengthMeters(coords);
  if (totalMeters <= 0) return coords;

  const minSpacingMeters = totalMeters / targetCount;
  const kept: Coordinate[] = [coords[0]];
  let accumulated = 0;

  for (let i = 1; i < coords.length - 1; i += 1) {
    accumulated += pointDistanceMeters(coords[i - 1], coords[i]);
    if (accumulated >= minSpacingMeters) {
      kept.push(coords[i]);
      accumulated = 0;
    }
  }

  kept.push(coords[coords.length - 1]);
  return kept;
}

/**
 * Visvalingam-Whyatt simplification to an exact point budget. Endpoints are
 * never removed. O(n²) in the straightforward form used here (a full
 * rescan for the global minimum on every removal) -- acceptable because the
 * caller bounds n via distanceThin first; see this file's top comment.
 */
export function simplifyByPointBudget(coords: Coordinate[], targetPoints: number): Coordinate[] {
  const n = coords.length;
  if (n <= targetPoints || n < 3) return coords;

  const prev = new Int32Array(n);
  const next = new Int32Array(n);
  const area = new Float64Array(n);
  const alive = new Uint8Array(n).fill(1);

  for (let i = 0; i < n; i += 1) {
    prev[i] = i - 1;
    next[i] = i + 1;
  }
  next[n - 1] = -1;

  const computeArea = (i: number): number => {
    if (prev[i] < 0 || next[i] < 0) return Infinity; // endpoints: never removable
    return triangleAreaMeters(coords[prev[i]], coords[i], coords[next[i]]);
  };
  for (let i = 1; i < n - 1; i += 1) area[i] = computeArea(i);

  let aliveCount = n;
  while (aliveCount > targetPoints) {
    let minArea = Infinity;
    let minIndex = -1;
    for (let i = 1; i < n - 1; i += 1) {
      if (!alive[i]) continue;
      if (area[i] < minArea) {
        minArea = area[i];
        minIndex = i;
      }
    }
    if (minIndex === -1) break;

    alive[minIndex] = 0;
    const p = prev[minIndex];
    const nx = next[minIndex];
    next[p] = nx;
    prev[nx] = p;
    if (prev[p] >= 0) area[p] = computeArea(p);
    if (next[nx] >= 0) area[nx] = computeArea(nx);
    aliveCount -= 1;
  }

  const result: Coordinate[] = [];
  for (let i = 0; i < n; i += 1) {
    if (alive[i]) result.push(coords[i]);
  }
  return result;
}

const PRE_SIMPLIFY_CAP = 600;

/**
 * Reduce a track to at most targetPoints, preserving turns the way naive
 * index sampling does not. Safe to call with any input size: the expensive
 * O(n²) step never sees more than PRE_SIMPLIFY_CAP points, regardless of
 * how many thousands the source track holds -- bounded by real distance,
 * never by blindly dropping every Nth point, so the pre-thin step itself
 * cannot reintroduce the bug it exists to stay clear of.
 */
export function simplifyToBudget(coords: Coordinate[], targetPoints: number): Coordinate[] {
  if (coords.length <= targetPoints) return coords;

  const bounded = distanceThin(coords, PRE_SIMPLIFY_CAP);
  return simplifyByPointBudget(bounded, targetPoints);
}
