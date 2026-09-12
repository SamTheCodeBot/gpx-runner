# Street completion projects

Run every street in a place. Phase 1: inventory, projects, coverage, progress.
Gap-aware route suggestion is explicitly **not** part of this.

## The shape of it

| Thing | Where |
| --- | --- |
| Scope polygon, clipping | `src/engine/streets/scope.ts` |
| OSM ways → streets | `src/engine/streets/inventory.ts` |
| "Have I run this street?" | `src/engine/streets/coverage.ts` |
| Snapshot, drift, adoption | `src/engine/streets/snapshot.ts` |
| Query building and parsing | `src/engine/streets/overpass.ts` |
| Network, cache, backoff | `src/lib/overpass.ts` |
| Firestore storage | `src/lib/streetProjects.ts` |
| API | `src/app/api/street-projects/**` |
| Surface | `src/app/projects/page.tsx` |

## Decisions worth not relitigating

**The unit is the street.** Not the neighbourhood: OSM tags those as labelled
*points*, so their extent cannot be derived at all. Streets need no boundary.

**One scope concept.** A pin with a radius and an administrative boundary both
become a ring of coordinates. Nothing downstream branches on which one it was —
inventory, clipping, snapshot and progress see a polygon and only a polygon.
Hand-drawn polygons would slot in here; they are deferred, not designed out.

**The street count is shown live, before anything is created.** It is what stops
a project being drawn around Falkenberg *kommun* — which contains Ullared, a
different town 40 km away — instead of the town. The app makes no attempt to
understand Swedish administrative semantics; it shows the number.

**Same name = same street, across junctions.** OSM chops a street at every
junction: 1,124 named ways around one town are 632 streets. Ways of one name are
joined when they share a node, when their ends touch, or when they run within
500 m of each other; they stay apart when they are further than that with no
junction, which is how two unrelated *Storgatan* survive. Dual carriageways
collapse: a way that merely repeats ground the street already has is dropped, so
one side of the road completes the street.

**Inclusion: named, runnable, public.** Requiring `name` does most of the work —
farm tracks, service alleys and most footpaths carry no name. On top of that,
`motorway`, `trunk`, their `_link`s, `highway=track`, `access=private|no` and
pedestrian *areas* are excluded.

**Complete at 90% of the in-scope length, or when under 25 m is left.** A flat
95% is brutal on a 1.5 km street and unreachable on a 40 m stub, and OSM geometry
runs past where anyone actually goes — turning circles, junction stubs. Matching
reuses the familiarity corridor (16 m) and the same 40 m spatial grid.

**Streets straddling the edge count, but only their inside part.** Ground the
owner deliberately drew outside his area must never block his project.

**The denominator is a snapshot.** OSM gains streets weekly. Recomputing the
list live would lower his percentage after a run he did nothing wrong on, which
is how a progress bar stops meaning anything. `POST /refresh` reports what
changed and changes nothing; `POST /adopt` moves the number, itemised, on
request. The UI names the new streets before the bar moves.

**History pre-fills.** A new project is measured against every logged run
immediately, so it opens on what the owner has already done.

## Being a good Overpass citizen

Overpass is free and shared. Answers are cached on disk (`/tmp`) for a week and
in memory, calls run through one queue with a minimum gap, 429/504 and the HTML
"too busy" page are met with 5 s / 15 s / 45 s backoff across three endpoints,
and a stale cached answer is preferred over a failure. Queries are **bounding
box**, not `poly:` — a hundred-edge polygon filter makes Overpass test every way
it selects and reliably times out; the ring is applied in code instead. Nothing
here is called from a hot path: a street list is fetched on creation or on an
explicit refresh, and read from Firestore every other time.

## Measured, 12 Sep 2026

Live Overpass, home at 56.9070, 12.5072:

| Scope | Ways in box | Streets | Network | Overpass | Grouping | Snapshot |
| --- | --- | --- | --- | --- | --- | --- |
| 3 km circle | 1,124 | 445 | 162.1 km | — | 89 ms | 153 KB |
| 6 km circle | 1,124 | 632 | 256.6 km | 605 ms | 104 ms | 228 KB |

The owner's recorded extract (`tests/fixtures/falkenberg-ways.json.gz`,
residential/living_street/unclassified/pedestrian only) holds **895 named ways**
and 614 name strings; the inventory turns those into **611 streets** — five ways
are `access=no`, and three of the 614 names are the same street spelt with a
different capital.

Coverage of 612 streets against a 1,458 km history: index 438 ms, coverage
112 ms, map split 108 ms.
