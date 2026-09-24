"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Icon, LoginScreen } from "@/components/ui";
import { MobileDrawer, Sidebar } from "@/components/Sidebar";
import { buildFamiliarityIndex } from "@/engine/familiarity";
import {
  computeProjectCoverage,
  describeStreetCoverage,
  sortStreetCoverage,
  type StreetCoverage,
  type StreetCoverageSplit,
  type StreetSort,
} from "@/engine/streets/coverage";
import { describeExclusions, partitionStreets } from "@/engine/streets/exclusions";
import type { Street } from "@/engine/streets/inventory";
import type { BoundaryCandidate } from "@/engine/streets/overpass";
import { buildStreetPickIndex, pickStreetAt } from "@/engine/streets/pick";
import { circleScope, scopeCenter } from "@/engine/streets/scope";
import { encodeStreets } from "@/engine/streets/serialize";
import { MAX_SELECTED_STREETS } from "@/engine/streets/streetRoute";
import { toLatLngTrack } from "@/engine/trackHistory";
import { logout, useAuth } from "@/lib/auth";
import { useGPXRoutes, useUnifiedRoutes, useUserProfile } from "@/lib/hooks";
import { termsAcknowledgement } from "@/lib/privacy";
import {
  ApiError,
  adoptStreetAdditions,
  cacheStreets,
  cachedStreets,
  createProject,
  findBoundaries,
  listProjects,
  loadProject,
  patchProject,
  planStreetRoute,
  previewScope,
  addNearbyStreets,
  addStreetAt,
  findNearbyStreets,
  identifyStreetAt,
  refreshProject,
  setStreetExclusions,
  type NearbyResult,
  type PlannedStreetRoute,
  type StreetAtPoint,
  type ProjectSummary,
  type ScopePreview,
  type ScopeRequest,
} from "@/lib/streetProjectClient";
import { downloadGPXFile } from "@/lib/utils";
import type { LatLng } from "@/types";

const StreetProjectMap = dynamic(() => import("@/components/StreetProjectMap"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full bg-surface-dim flex items-center justify-center">
      <div className="text-on-surface-variant text-sm">Loading map&hellip;</div>
    </div>
  ),
});

/**
 * Street completion projects.
 *
 * The origin story of this whole app, finally given its own surface: he wanted
 * to see where he had run, which turned into wanting to run *every street in
 * Falkenberg*. That is not a route suggestion and it does not belong bolted to
 * one — it is a thing you start, and then watch move over months.
 *
 * So: a menu of its own, a progress bar, and a street list. Creating one costs
 * a pin, a radius and a name, because he has three towns in his life and a
 * wizard would mean he only ever made the first project.
 */

const DEFAULT_RADIUS_METERS = 3000;
const PREVIEW_DEBOUNCE_MS = 700;
const EMPTY_STREETS: Street[] = [];
/** More rows than this and the browser starts to feel the list. */
const STREET_LIST_CAP = 300;

/**
 * What the map is drawing.
 *
 * "Everything" is the progress view this page opened life with: green for done,
 * grey for not. "Left to run" drops every finished street off the map entirely,
 * which is the view he asked for — with the done streets gone, the gaps that
 * are left stop being a texture and start being clusters, and a cluster is a
 * run. Picking between them is his, because they answer different questions and
 * the page cannot know which one he is asking today.
 */
type MapMode = "all" | "left";

const MAP_MODES: Array<{ id: MapMode; label: string }> = [
  { id: "all", label: "Everything" },
  { id: "left", label: "Left to run" },
];

/**
 * How far outside the project to look for streets it missed.
 *
 * Three choices, not a slider. The question he is answering is "just over the
 * edge" or "the next neighbourhood", and a slider would invite him to tune a
 * number that only has to be roughly right.
 */
const NEARBY_MARGINS: Array<{ meters: number; label: string }> = [
  { meters: 500, label: "0.5 km" },
  { meters: 1000, label: "1 km" },
  { meters: 2000, label: "2 km" },
];

function formatKm(meters: number): string {
  return `${Math.round(meters / 100) / 10} km`;
}

/**
 * A project squeezed into one line of a dropdown.
 *
 * The card this replaced carried a progress bar, a percentage and the OSM
 * badge. Two of those three still have a home directly under the map, in the
 * detail header, so the only thing the option has to earn its width with is
 * the number that tells him which project he is looking for — and the one
 * thing the detail panel cannot say about a project he has *not* selected,
 * which is that it has streets waiting.
 */
function projectOptionLabel(
  project: ProjectSummary,
  coverage: ReturnType<typeof computeProjectCoverage> | null,
): string {
  const percent = coverage ? `${Math.round(coverage.ratio * 100)}%` : "…";
  const pending = project.pendingAdditionCount > 0 ? ` · ${project.pendingAdditionCount} new in OSM` : "";
  return `${project.name} · ${percent}${pending}`;
}

function ProgressBar({ ratio, tone = "primary" }: { ratio: number; tone?: "primary" | "secondary" }) {
  const percent = Math.max(0, Math.min(100, ratio * 100));
  return (
    <div className="h-2.5 w-full rounded-full bg-surface-container-high overflow-hidden">
      <div
        className={`h-full rounded-full transition-[width] duration-700 ${
          tone === "primary" ? "bg-primary" : "bg-secondary"
        }`}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

export default function StreetProjectsPage() {
  const { user, loading: authLoading } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authSuccess, setAuthSuccess] = useState("");
  const [isRegistering, setIsRegistering] = useState(false);
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [username, setUsername] = useState("");
  const [showDrawer, setShowDrawer] = useState(false);

  const { routes, uploadFiles } = useGPXRoutes(user?.uid ?? null);
  const { routes: unifiedRoutes } = useUnifiedRoutes(user?.uid ?? null, routes);
  const { profile, loading: profileLoading, saveProfile } = useUserProfile(user?.uid ?? null);

  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [streetsById, setStreetsById] = useState<Record<string, Street[]>>({});
  const [pendingById, setPendingById] = useState<Record<string, { streets: Street[]; removedNames: string[] }>>({});
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "creating" | "refreshing" | "adopting">(null);
  const [mode, setMode] = useState<"list" | "create">("list");
  // The scope being drawn while creating a project. It lives up here because the
  // big map on the right draws it: one map, not a large one plus a cramped
  // duplicate under the form. Declared with the other hooks, above the
  // unauthenticated early return, so the hook order never changes.
  const [createPin, setCreatePin] = useState<LatLng | null>(null);
  const [createRing, setCreateRing] = useState<LatLng[]>([]);
  const [focusStreetId, setFocusStreetId] = useState<string | null>(null);
  // What the map was last told to fly to, which is not the same as what is
  // selected. A list click means "show me where this is", so the map goes
  // there. A map click means "what is this one" — he is already looking at it,
  // and flying to it would snatch away the surroundings he picked it out of.
  // Only list clicks touch this, and the nonce is what makes picking the same
  // street twice fly to it twice.
  const [fitTarget, setFitTarget] = useState<{ streetId: string | null; nonce: number }>({
    streetId: null,
    nonce: 0,
  });
  const [mapMode, setMapMode] = useState<MapMode>("all");
  const [showDone, setShowDone] = useState(false);
  // Struck-off roads stay on the map by default, muted: he has to be able to
  // see what he took out, and put it back from the same place he removed it.
  const [showExcluded, setShowExcluded] = useState(true);
  const [excluding, setExcluding] = useState(false);
  // The other half of editing a project: streets the circle missed. Held only
  // while he is looking at them — they are an offer, not part of the project.
  const [nearby, setNearby] = useState<NearbyResult | null>(null);
  const [nearbyMargin, setNearbyMargin] = useState(NEARBY_MARGINS[0].meters);
  const [findingNearby, setFindingNearby] = useState(false);
  // Pointing at a road: the local answer to a local problem. A tap asks OSM
  // what is under it, and nothing is added until he has seen the name.
  const [pointingAtRoad, setPointingAtRoad] = useState(false);
  const [pointedStreet, setPointedStreet] = useState<StreetAtPoint | null>(null);
  const [pointing, setPointing] = useState(false);
  // Kept so the confirm re-resolves the same spot server-side rather than
  // trusting geometry the browser is holding.
  const [pointedPoint, setPointedPoint] = useState<LatLng | null>(null);
  const [pointedTolerance, setPointedTolerance] = useState(30);
  const [streetSort, setStreetSort] = useState<StreetSort>("progress");
  // Ticked streets, the start they are run from, and the route that came back.
  const [checkedStreetIds, setCheckedStreetIds] = useState<string[]>([]);
  const [routeStart, setRouteStart] = useState<LatLng | null>(null);
  const [pickingStart, setPickingStart] = useState(false);
  const [plannedRoute, setPlannedRoute] = useState<PlannedStreetRoute | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [planningRoute, setPlanningRoute] = useState(false);

  // ── The history every project is measured against ────────────────────────
  // One history, many scopes: a Varberg run counts towards Varberg and nothing
  // else, and two overlapping projects may both count the same run without
  // either knowing about the other.
  const tracks = useMemo<LatLng[][]>(
    () => unifiedRoutes.map((route) => toLatLngTrack(route.coordinates)).filter((track) => track.length >= 2),
    [unifiedRoutes],
  );

  const familiarityIndex = useMemo(() => buildFamiliarityIndex(tracks), [tracks]);
  const historyKm = useMemo(
    () => Math.round(unifiedRoutes.reduce((sum, route) => sum + (route.distance || 0), 0) / 100) / 10,
    [unifiedRoutes],
  );

  // Struck-off streets, by project. Read off the project summaries rather than
  // held in their own state, so the server's answer is the only version of this
  // that exists and an excluded street cannot come back on a reload.
  const excludedIdsByProject = useMemo(() => {
    const result: Record<string, string[]> = {};
    for (const project of projects) result[project.id] = project.excludedStreetIds;
    return result;
  }, [projects]);

  const coverageById = useMemo(() => {
    const result: Record<string, ReturnType<typeof computeProjectCoverage>> = {};
    for (const [id, streets] of Object.entries(streetsById)) {
      // Excluded streets are out of the denominator: the percentage is over
      // what he has actually taken on, which is what he asked for.
      const { active } = partitionStreets(streets, excludedIdsByProject[id] ?? []);
      if (active.length > 0) result[id] = computeProjectCoverage(active, familiarityIndex);
    }
    return result;
  }, [streetsById, familiarityIndex, excludedIdsByProject]);

  const selectedProject = projects.find((project) => project.id === selectedId) ?? null;
  // Memoised because the map split below is the one genuinely expensive thing
  // on this page: a fresh `[]` every render would redraw a whole town's streets
  // on every keystroke.
  const allSelectedStreets = useMemo(
    () => (selectedId ? streetsById[selectedId] ?? EMPTY_STREETS : EMPTY_STREETS),
    [selectedId, streetsById],
  );

  const { active: selectedStreets, excluded: excludedStreets } = useMemo(
    () => partitionStreets(allSelectedStreets, selectedProject?.excludedStreetIds ?? []),
    [allSelectedStreets, selectedProject],
  );

  // Drawn muted, and drawn from the raw geometry: there is no coverage to split
  // a struck-off street into, because it is not being measured any more.
  const excludedLines = useMemo(
    () => (showExcluded ? excludedStreets.flatMap((street) => street.geometry) : undefined),
    [excludedStreets, showExcluded],
  );

  /**
   * Streets on offer from outside the area, and the index that lets him tap
   * one. Drawn from raw geometry: they are not in the project, so there is no
   * coverage to split them into yet.
   */
  const nearbyStreets = useMemo<Street[]>(
    () => (nearby ? [...nearby.additions, ...nearby.extensions.map((extension) => extension.street)] : []),
    [nearby],
  );

  const nearbyLines = useMemo(() => {
    // The road he just pointed at is drawn the same blue as the rest of the
    // offer: it is the same kind of thing, arrived at by a different gesture.
    const pieces = nearbyStreets.flatMap((street) => street.geometry);
    if (pointedStreet) pieces.push(...pointedStreet.street.geometry);
    return pieces.length > 0 ? pieces : undefined;
  }, [nearbyStreets, pointedStreet]);

  const nearbyPickIndex = useMemo(() => buildStreetPickIndex(nearbyStreets), [nearbyStreets]);
  const selectedCoverage = selectedId ? coverageById[selectedId] ?? null : null;
  const selectedPending = selectedId ? pendingById[selectedId] ?? null : null;

  // Every street cut into the part he has run and the part he has not, once.
  // This is the expensive thing on the page — a town is tens of thousands of
  // sampled points — so it is computed against the history and then read from,
  // rather than recomputed every time a checkbox moves.
  const coverageDetailById = useMemo(() => {
    const result = new Map<string, StreetCoverageSplit>();
    for (const street of selectedStreets) result.set(street.id, describeStreetCoverage(street, familiarityIndex));
    return result;
  }, [selectedStreets, familiarityIndex]);

  const mapStreets = useMemo(
    () =>
      mapMode === "left"
        ? selectedStreets.filter((street) => !coverageDetailById.get(street.id)?.complete)
        : selectedStreets,
    [mapMode, selectedStreets, coverageDetailById],
  );

  const mapLines = useMemo(() => {
    if (!selectedProject || mapStreets.length === 0) return undefined;
    const covered: LatLng[][] = [];
    const missing: LatLng[][] = [];
    for (const street of mapStreets) {
      const detail = coverageDetailById.get(street.id);
      if (!detail) continue;
      missing.push(...detail.missing);
      // In "left to run" the green comes off too. Half a street he has run is
      // not what he is looking for, and leaving it drawn puts the clusters back
      // in the noise they were hiding in.
      if (mapMode === "all") covered.push(...detail.covered);
    }
    return { covered, missing };
  }, [selectedProject, mapStreets, coverageDetailById, mapMode]);

  // Built over what is drawn, so a map showing only unrun streets cannot select
  // a finished one.
  const pickIndex = useMemo(() => buildStreetPickIndex(mapStreets), [mapStreets]);

  const checkedLines = useMemo(() => {
    if (checkedStreetIds.length === 0) return undefined;
    const out: LatLng[][] = [];
    for (const id of checkedStreetIds) {
      const detail = coverageDetailById.get(id);
      if (!detail) continue;
      out.push(...detail.missing);
      // Ticking a street does not put the half he has already run back on a map
      // he asked to show only what he has not.
      if (mapMode === "all") out.push(...detail.covered);
    }
    return out;
  }, [checkedStreetIds, coverageDetailById, mapMode]);

  // Handed to the map to frame, never to draw.
  const focusGeometry = useMemo(() => {
    if (!fitTarget.streetId) return undefined;
    return selectedStreets.find((street) => street.id === fitTarget.streetId)?.geometry;
  }, [fitTarget, selectedStreets]);

  const focusDetail = focusStreetId ? coverageDetailById.get(focusStreetId) ?? null : null;

  const focusLines = useMemo(() => {
    const detail = focusStreetId ? coverageDetailById.get(focusStreetId) : undefined;
    return detail ? { covered: detail.covered, missing: detail.missing } : undefined;
  }, [focusStreetId, coverageDetailById]);

  const focusedStreet = useMemo(
    () => selectedCoverage?.streets.find((street) => street.streetId === focusStreetId) ?? null,
    [selectedCoverage, focusStreetId],
  );

  const focusFromList = useCallback((streetId: string | null) => {
    setFocusStreetId(streetId);
    setFitTarget((current) => ({ streetId, nonce: current.nonce + 1 }));
  }, []);

  // ── The ticked streets, and the route they become ─────────────────────────

  const effectiveStart = useMemo<LatLng | null>(
    () => routeStart ?? (selectedProject ? scopeCenter(selectedProject.scope) : null),
    [routeStart, selectedProject],
  );

  const routeGeometry = useMemo<LatLng[] | undefined>(() => {
    if (!plannedRoute || plannedRoute.coordinates.length < 2) return undefined;
    return plannedRoute.coordinates.map(([lng, lat]) => ({ lat, lng }));
  }, [plannedRoute]);

  const checkedMeters = useMemo(() => {
    if (!selectedCoverage) return 0;
    const checked = new Set(checkedStreetIds);
    return selectedCoverage.streets
      .filter((street) => checked.has(street.streetId))
      .reduce((sum, street) => sum + street.lengthMeters, 0);
  }, [selectedCoverage, checkedStreetIds]);

  // Switching projects throws all of it away: a tick list and a route belong to
  // the town they were made in.
  useEffect(() => {
    setCheckedStreetIds([]);
    setPlannedRoute(null);
    setRouteError(null);
    setPickingStart(false);
    setRouteStart(null);
    setFocusStreetId(null);
    setFitTarget({ streetId: null, nonce: 0 });
    // An offer of streets outside Falkenberg means nothing in Varberg.
    setNearby(null);
    setPointingAtRoad(false);
    setPointedStreet(null);
    setPointedPoint(null);
  }, [selectedId]);

  const toggleChecked = useCallback((streetId: string) => {
    setRouteError(null);
    setCheckedStreetIds((current) => {
      if (current.includes(streetId)) return current.filter((id) => id !== streetId);
      // Stop at the cap rather than accepting a tick the route will silently
      // drop later. The bar below the list says why the box would not go on.
      if (current.length >= MAX_SELECTED_STREETS) return current;
      return [...current, streetId];
    });
  }, []);

  /**
   * Look just outside the project for streets the area missed.
   *
   * Costs an Overpass read and changes nothing: what comes back is an offer.
   * The project's own area is never grown — growing it would mean the next
   * refresh quietly inventoried a bigger town and moved the goalposts, which
   * is the one thing the frozen snapshot exists to prevent.
   */
  const handleFindNearby = useCallback(
    async (marginMeters: number) => {
      if (!user || !selectedProject) return;
      setFindingNearby(true);
      setErrorMessage(null);
      setNearbyMargin(marginMeters);
      try {
        const found = await findNearbyStreets(user, selectedProject.id, marginMeters);
        setNearby(found);
        setStatusMessage(found.message);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "Could not read the street map.");
      } finally {
        setFindingNearby(false);
      }
    },
    [user, selectedProject],
  );

  const handleAddNearby = useCallback(
    async (streetIds: string[]) => {
      if (!user || !selectedProject || streetIds.length === 0) return;
      setFindingNearby(true);
      setErrorMessage(null);
      try {
        const result = await addNearbyStreets(user, selectedProject.id, streetIds, nearbyMargin);
        const projectId = selectedProject.id;

        setStreetsById((current) => ({ ...current, [projectId]: result.streets }));
        cacheStreets(projectId, result.project.snapshotTakenAt, encodeStreets(result.streets));
        setProjects((current) =>
          current.map((project) =>
            // The scope is deliberately unchanged, so it is kept from the copy
            // already in hand rather than taken from a response that omits it.
            project.id === projectId ? { ...result.project, scope: project.scope } : project,
          ),
        );

        // What is left of the offer, minus what he just took.
        setNearby((current) =>
          current
            ? {
                ...current,
                additions: current.additions.filter((street) => !streetIds.includes(street.id)),
                extensions: current.extensions.filter(
                  (extension) =>
                    !streetIds.includes(extension.street.id) && !streetIds.includes(extension.replacesId),
                ),
              }
            : current,
        );

        setStatusMessage(
          `${result.addedCount} street${result.addedCount === 1 ? "" : "s"} added. The project is now ${
            result.project.streetCount
          } streets.`,
        );
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "Could not add those streets.");
      } finally {
        setFindingNearby(false);
      }
    },
    [user, selectedProject, nearbyMargin],
  );

  /**
   * A tap while pointing at a road: ask OSM what is under it.
   *
   * Nothing is added here. He sees the name and the length first, because a tap
   * on a map is a coarse instrument and "Storgatan, 900 m" is the only way to
   * know the finger landed on the road he meant.
   */
  const handlePointAtRoad = useCallback(
    async (lat: number, lng: number, toleranceMeters: number) => {
      if (!user || !selectedProject) return;
      setPointing(true);
      setErrorMessage(null);
      setPointedStreet(null);
      try {
        const found = await identifyStreetAt(user, selectedProject.id, { lat, lng }, toleranceMeters);
        setPointedStreet(found);
        if (found.kind === "already_in_project") {
          setStatusMessage(`${found.name} is already in this project.`);
        }
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "Could not read that road.");
      } finally {
        setPointing(false);
      }
    },
    [user, selectedProject],
  );

  const handleAddPointedStreet = useCallback(
    async (point: LatLng, toleranceMeters: number) => {
      if (!user || !selectedProject) return;
      setPointing(true);
      setErrorMessage(null);
      try {
        const result = await addStreetAt(user, selectedProject.id, point, toleranceMeters);
        const projectId = selectedProject.id;

        setStreetsById((current) => ({ ...current, [projectId]: result.streets }));
        cacheStreets(projectId, result.project.snapshotTakenAt, encodeStreets(result.streets));
        setProjects((current) =>
          current.map((project) =>
            // The scope is unchanged by design, so it is kept rather than taken
            // from a response that deliberately omits it.
            project.id === projectId ? { ...result.project, scope: project.scope } : project,
          ),
        );

        setPointedStreet(null);
        setStatusMessage(
          result.kind === "extension"
            ? `${result.name} now counts for its whole length.`
            : `${result.name} added. The project is now ${result.project.streetCount} streets.`,
        );
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "Could not add that road.");
      } finally {
        setPointing(false);
      }
    },
    [user, selectedProject],
  );

  /**
   * A click on the map: name that street, and tick it.
   *
   * One gesture doing two things on purpose. What he asked for was to see the
   * gaps near each other and then run them, and making him find the same street
   * again in a list of six hundred to tick it would be the app losing the thread
   * between those two halves. Clicking it again unticks it, which is the same
   * bargain the checkbox makes.
   *
   * A click on open ground drops the selection, because that is what clicking
   * away means everywhere else.
   */
  const handleMapPick = useCallback(
    (lat: number, lng: number, toleranceMeters: number) => {
      // Pointing at a road takes the tap before anything else: he has said what
      // this gesture means, and a road he wants to add is by definition one the
      // project's own street list cannot answer for.
      if (pointingAtRoad) {
        setPointedPoint({ lat, lng });
        setPointedTolerance(toleranceMeters);
        void handlePointAtRoad(lat, lng, toleranceMeters);
        return;
      }

      // While an offer of outside streets is on screen, a tap on one of the
      // blue ones adds it. He spotted the gap by looking at the map, so the fix
      // belongs on the map and not only in a list he would have to find the
      // same street in all over again.
      if (nearbyStreets.length > 0) {
        const candidate = pickStreetAt({ lat, lng }, nearbyPickIndex, toleranceMeters);
        if (candidate) {
          handleAddNearby([candidate.streetId]);
          return;
        }
      }

      const pick = pickStreetAt({ lat, lng }, pickIndex, toleranceMeters);

      // Clicking away drops the selection without moving the map. He is
      // looking at a cluster; refitting to the whole town for a missed tap
      // would throw it off screen.
      if (!pick) {
        setFocusStreetId(null);
        return;
      }

      setFocusStreetId(pick.streetId);
      // The list has two halves and only one is on screen. Show the half the
      // street he just picked actually lives in, or the row he is being scrolled
      // to is not rendered at all.
      setShowDone(coverageDetailById.get(pick.streetId)?.complete ?? false);

      if (!checkedStreetIds.includes(pick.streetId) && checkedStreetIds.length >= MAX_SELECTED_STREETS) {
        setRouteError(
          `That is the most one route can cover (${MAX_SELECTED_STREETS}). Untick one to make room for this street.`,
        );
        return;
      }

      toggleChecked(pick.streetId);
    },
    [
      pickIndex,
      checkedStreetIds,
      coverageDetailById,
      toggleChecked,
      nearbyStreets,
      nearbyPickIndex,
      handleAddNearby,
      pointingAtRoad,
      handlePointAtRoad,
    ],
  );

  const handleBuildRoute = useCallback(async () => {
    if (!user || !selectedProject || checkedStreetIds.length === 0 || !effectiveStart) return;
    setPlanningRoute(true);
    setRouteError(null);
    try {
      const route = await planStreetRoute(user, selectedProject.id, {
        start: effectiveStart,
        streetIds: checkedStreetIds,
      });
      setPlannedRoute(route);
      focusFromList(null);
      setStatusMessage(
        `${Math.round(route.distanceMeters / 100) / 10} km through ${route.streetNames.length} street${
          route.streetNames.length === 1 ? "" : "s"
        }.`,
      );
    } catch (error) {
      setRouteError(error instanceof Error ? error.message : "Could not build that route.");
    } finally {
      setPlanningRoute(false);
    }
  }, [user, selectedProject, checkedStreetIds, effectiveStart, focusFromList]);

  const handleDownloadRoute = useCallback(() => {
    if (!plannedRoute) return;
    downloadGPXFile({ name: plannedRoute.name, coordinates: plannedRoute.coordinates });
  }, [plannedRoute]);

  // ── Loading ───────────────────────────────────────────────────────────────

  const reloadProjects = useCallback(async () => {
    if (!user) return;
    setProjectsLoading(true);
    try {
      const loaded = await listProjects(user);
      setProjects(loaded);
      setSelectedId((current) => current ?? loaded.find((project) => !project.archivedAt)?.id ?? null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Could not load your projects.");
    } finally {
      setProjectsLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void reloadProjects();
  }, [reloadProjects]);

  useEffect(() => {
    if (!user || !selectedId) return;
    const project = projects.find((candidate) => candidate.id === selectedId);
    if (!project || streetsById[selectedId]) return;

    const cached = cachedStreets(project.id, project.snapshotTakenAt);
    if (cached && cached.length > 0) {
      setStreetsById((current) => ({ ...current, [project.id]: cached }));
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        const detail = await loadProject(user, project.id);
        if (cancelled) return;
        setStreetsById((current) => ({ ...current, [project.id]: detail.streets }));
        setPendingById((current) => ({
          ...current,
          [project.id]: { streets: detail.pending.streets, removedNames: detail.pending.removedNames },
        }));
        cacheStreets(project.id, project.snapshotTakenAt, encodeStreets(detail.streets));
      } catch (error) {
        if (!cancelled) setErrorMessage(error instanceof Error ? error.message : "Could not load that project.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user, selectedId, projects, streetsById]);

  // ── Auth plumbing, same as every other page ───────────────────────────────

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError("");
    setAuthSuccess("");
    if (showForgotPassword) {
      const { resetPassword } = await import("@/lib/auth");
      try {
        await resetPassword(email);
        setAuthSuccess("✓ Check your email");
        setShowForgotPassword(false);
      } catch (err: any) {
        setAuthError(err.message || "Failed");
      }
      return;
    }
    try {
      const { login, register } = await import("@/lib/auth");
      if (isRegistering) {
        await register(email, password);
        await saveProfile({ username: username.trim(), displayName: username.trim(), ...termsAcknowledgement() });
      } else {
        await login(email, password);
      }
    } catch (err: any) {
      setAuthError(err.message || "Authentication failed");
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    await uploadFiles(files, routes);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleRouteUpload = async (gpxFiles: File[], tcxFiles: File[]) => {
    if (!gpxFiles.length) return;
    await uploadFiles(gpxFiles, routes, tcxFiles);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // ── Actions ───────────────────────────────────────────────────────────────

  const handleCreated = (project: ProjectSummary, streets: Street[]) => {
    setProjects((current) => [project, ...current]);
    setStreetsById((current) => ({ ...current, [project.id]: streets }));
    cacheStreets(project.id, project.snapshotTakenAt, encodeStreets(streets));
    setSelectedId(project.id);
    setMode("list");

    const coverage = computeProjectCoverage(streets, familiarityIndex);
    setStatusMessage(
      coverage.streetsComplete > 0
        ? `${project.name}: your ${historyKm} km already covers ${coverage.streetsComplete} of ${coverage.streetsTotal} streets.`
        : `${project.name}: ${coverage.streetsTotal} streets to go.`,
    );
  };

  const handleRefresh = async () => {
    if (!user || !selectedProject) return;
    setBusy("refreshing");
    setErrorMessage(null);
    try {
      const result = await refreshProject(user, selectedProject.id);
      setPendingById((current) => ({
        ...current,
        [selectedProject.id]: { streets: result.added, removedNames: result.removedNames },
      }));
      setStatusMessage(result.message);
      setProjects((current) =>
        current.map((project) =>
          project.id === selectedProject.id
            ? { ...project, pendingAdditionCount: result.added.length, lastRefreshedAt: new Date().toISOString() }
            : project,
        ),
      );
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Could not reach OpenStreetMap.");
    } finally {
      setBusy(null);
    }
  };

  const handleAdoptAll = async () => {
    if (!user || !selectedProject || !selectedPending || selectedPending.streets.length === 0) return;
    setBusy("adopting");
    try {
      const ids = selectedPending.streets.map((street) => street.id);
      const result = await adoptStreetAdditions(user, selectedProject.id, ids);
      const merged = [...selectedStreets, ...result.adopted].sort(
        (a, b) => a.name.localeCompare(b.name, "sv-SE") || a.part - b.part,
      );
      setStreetsById((current) => ({ ...current, [selectedProject.id]: merged }));
      cacheStreets(result.project.id, result.project.snapshotTakenAt, encodeStreets(merged));
      setProjects((current) => current.map((project) => (project.id === result.project.id ? result.project : project)));
      setPendingById((current) => ({ ...current, [selectedProject.id]: { streets: [], removedNames: [] } }));
      setStatusMessage(
        `${result.adopted.length} street${result.adopted.length === 1 ? "" : "s"} added. The project is now ${
          result.project.streetCount
        } streets.`,
      );
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Could not add those streets.");
    } finally {
      setBusy(null);
    }
  };

  /**
   * Strike a road off the project, or put it back.
   *
   * The tag rules cannot know that the 80 km/h road with no pavement is not
   * runnable — only he can. Excluding shrinks the denominator, which was his
   * call: he is the one keeping track of the numbers and the one deciding what
   * comes out, so a road he has ruled out should stop counting as something he
   * owes rather than capping his project below 100 forever.
   *
   * The street is never deleted. It stays in the snapshot with its geometry,
   * which is what makes putting it back one tap and no refetch.
   */
  const handleToggleExclusion = useCallback(
    async (streetIds: string[], excluded: boolean) => {
      if (!user || !selectedProject || streetIds.length === 0) return;
      setExcluding(true);
      setErrorMessage(null);
      try {
        const updated = await setStreetExclusions(user, selectedProject.id, streetIds, excluded);
        setProjects((current) => current.map((project) => (project.id === updated.id ? updated : project)));
        // A struck-off street cannot stay ticked for a route through streets
        // he has just said he will not run.
        if (excluded) setCheckedStreetIds((current) => current.filter((id) => !streetIds.includes(id)));
        setFocusStreetId(null);

        const count = streetIds.length;
        setStatusMessage(
          excluded
            ? `${count} street${count === 1 ? "" : "s"} taken out. Your percentage is now over ${
                updated.streetCount - updated.excludedStreetIds.length
              } streets.`
            : `${count} street${count === 1 ? "" : "s"} back in the project.`,
        );
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : "Could not change that street.");
      } finally {
        setExcluding(false);
      }
    },
    [user, selectedProject],
  );

  const handleArchiveToggle = async () => {
    if (!user || !selectedProject) return;
    try {
      const updated = await patchProject(user, selectedProject.id, { archived: !selectedProject.archivedAt });
      setProjects((current) => current.map((project) => (project.id === updated.id ? updated : project)));
      setStatusMessage(updated.archivedAt ? `${updated.name} archived. Nothing was deleted.` : `${updated.name} is active again.`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Could not update that project.");
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!user) {
    return (
      <LoginScreen
        email={email}
        setEmail={setEmail}
        password={password}
        setPassword={setPassword}
        authError={authError}
        authSuccess={authSuccess}
        isRegistering={isRegistering}
        setIsRegistering={setIsRegistering}
        showForgotPassword={showForgotPassword}
        setShowForgotPassword={setShowForgotPassword}
        username={username}
        setUsername={setUsername}
        handleAuth={handleAuth}
        setAuthError={setAuthError}
      />
    );
  }

  const activeProjects = projects.filter((project) => !project.archivedAt);
  const archivedProjects = projects.filter((project) => project.archivedAt);
  const defaultPin: LatLng | null = tracks.length > 0 ? tracks[0][0] : null;
  const creating = mode === "create";

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      <header className="md:hidden flex items-center justify-between px-4 py-3 border-b border-outline-variant bg-primary text-on-primary">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-primary-container flex items-center justify-center">
            <Icon name="sprint" filled className="text-on-primary-container text-sm" />
          </div>
          <span className="font-headline font-extrabold text-base">GPX running</span>
        </div>
        <button onClick={() => setShowDrawer(true)} className="p-1.5 hover:bg-primary-container rounded-lg transition-colors">
          <Icon name="menu" className="text-xl" />
        </button>
      </header>

      <div className="flex-1 flex overflow-hidden">
        <Sidebar
          user={user}
          profile={profile}
          profileLoading={profileLoading}
          onLogout={() => logout()}
          fileInputRef={fileInputRef}
          onFileUpload={handleFileUpload}
          onRouteUpload={handleRouteUpload}
        />

        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Title, project picker and "new" on one line.

              These three used to be the top of a 420px column that ran the
              full height of the page, which meant a permanent third of the
              window was spent on a heading and a list he reads once — and the
              map, the only thing on this page that actually needs room, got
              what was left. Picking a project is a single decision made rarely,
              so it collapses to a dropdown, and the column goes away entirely
              unless he is creating a project, where the panel and the map have
              to be on screen together. */}
          <div className="shrink-0 flex flex-wrap items-center gap-3 px-4 py-3 md:px-6 border-b border-outline-variant/30">
            <div className="flex items-center gap-3 min-w-0 mr-auto">
              <div className="w-10 h-10 rounded-2xl bg-primary-container flex items-center justify-center shrink-0">
                <Icon name="flag" filled className="text-on-primary-container text-xl" />
              </div>
              <div className="min-w-0">
                <h2 className="text-xl font-extrabold text-on-surface truncate">Street projects</h2>
                <p className="hidden sm:block text-xs text-on-surface-variant truncate">
                  Run every street in a place, one street at a time
                </p>
              </div>
            </div>

            {!creating && projects.length > 0 && (
              <select
                aria-label="Project"
                value={selectedId ?? ""}
                onChange={(event) => {
                  setSelectedId(event.target.value || null);
                  focusFromList(null);
                }}
                className="min-w-0 sm:min-w-[15rem] max-w-full px-3 py-2.5 bg-surface-container border border-outline-variant rounded-2xl text-sm font-extrabold text-on-surface focus:outline-none focus:border-primary/60"
              >
                {activeProjects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {projectOptionLabel(project, coverageById[project.id] ?? null)}
                  </option>
                ))}
                {archivedProjects.length > 0 && (
                  <optgroup label="Archived">
                    {archivedProjects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {projectOptionLabel(project, coverageById[project.id] ?? null)}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            )}

            {!creating && projectsLoading && projects.length === 0 && (
              <span className="text-xs text-on-surface-variant">Loading your projects&hellip;</span>
            )}

            <button
              onClick={() => {
                setMode(creating ? "list" : "create");
                setErrorMessage(null);
              }}
              className="shrink-0 rounded-2xl bg-primary text-on-primary px-4 py-2.5 font-extrabold text-sm flex items-center justify-center gap-2 hover:opacity-90 transition-opacity"
            >
              <Icon name={creating ? "close" : "add_location_alt"} className="text-lg" />
              {creating ? "Cancel" : "New project"}
            </button>
          </div>

          {(statusMessage || errorMessage) && (
            <div className="shrink-0 px-4 md:px-6 pt-3 space-y-2">
              {statusMessage && (
                <div className="rounded-2xl bg-secondary-container/60 border border-secondary/30 px-4 py-3 text-xs text-on-surface flex gap-2">
                  <Icon name="info" className="text-base text-secondary shrink-0" />
                  <span>{statusMessage}</span>
                </div>
              )}
              {errorMessage && (
                <div className="rounded-2xl bg-error-container/60 border border-error/30 px-4 py-3 text-xs text-on-surface flex gap-2">
                  <Icon name="error" className="text-base text-error shrink-0" />
                  <span>{errorMessage}</span>
                </div>
              )}
            </div>
          )}

          <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
            {creating && (
              <div className="w-full lg:w-[420px] shrink-0 overflow-y-auto px-4 pt-5 pb-6 md:p-6 custom-scrollbar">
                <CreateProjectPanel
                  user={user}
                  defaultPin={defaultPin}
                  pin={createPin ?? defaultPin}
                  onPinChange={setCreatePin}
                  onRingChange={setCreateRing}
                  onCancel={() => setMode("list")}
                  onCreated={handleCreated}
                  busy={busy === "creating"}
                  setBusy={(value) => setBusy(value ? "creating" : null)}
                  onError={setErrorMessage}
                />
              </div>
            )}

          <div
            className={`flex-1 flex flex-col overflow-hidden ${
              creating ? "border-t lg:border-t-0 lg:border-l border-outline-variant/30" : ""
            }`}
          >
            <div className="h-[45vh] lg:h-[55%] shrink-0 relative">
              <StreetProjectMap
                ring={creating ? createRing : selectedProject ? selectedProject.scope.ring : []}
                // The surrounding streets stay drawn while one is picked. The
                // whole point of picking a street off this map is to see what
                // else is near it, and hiding its neighbours to make it stand
                // out would hide the only thing worth looking at. It stands out
                // by being cased in white and coloured instead.
                lines={creating ? undefined : mapLines}
                excluded={creating ? undefined : excludedLines}
                candidates={creating ? undefined : nearbyLines}
                checked={creating ? undefined : checkedLines}
                focus={creating ? undefined : focusGeometry}
                focusLines={creating ? undefined : focusLines}
                route={creating ? undefined : routeGeometry}
                pin={
                  creating
                    ? createPin ?? defaultPin
                    : effectiveStart ?? defaultPin
                }
                onMapClick={
                  creating
                    ? (lat, lng) => setCreatePin({ lat, lng })
                    : pickingStart
                      ? (lat, lng) => {
                          setRouteStart({ lat, lng });
                          setPickingStart(false);
                        }
                      : handleMapPick
                }
                fitKey={
                  creating
                    ? `create:${createRing.length}:${(createPin ?? defaultPin)?.lat.toFixed(3)}`
                    : fitTarget.streetId
                      ? `${selectedProject?.id}:street:${fitTarget.streetId}#${fitTarget.nonce}`
                      : plannedRoute
                        ? `${selectedProject?.id}:route:${plannedRoute.streetOrder.join(",")}`
                        : selectedProject?.id
                }
              />

              {!creating && pickingStart && (
                <div className="absolute inset-0 z-[500] flex items-start justify-center pt-4 pointer-events-none">
                  <div className="bg-primary text-on-primary px-4 py-2 rounded-xl text-xs font-bold shadow-lg pointer-events-auto flex items-center gap-2">
                    <Icon name="place" className="text-xs" />
                    Click the map to set where the route starts
                    <button onClick={() => setPickingStart(false)} className="underline font-extrabold">
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* The answer to "which 123 m are missing", in words as well as in
                  colour — and sat at the bottom of the map, out of the way of
                  the view switch and of the street it is describing. */}
              {!creating && focusedStreet && (
                <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-[500] max-w-[92%]">
                  <div className="flex items-center gap-2.5 rounded-full bg-surface-container-lowest/95 backdrop-blur-md px-3 py-1.5 shadow-lg">
                    {checkedStreetIds.includes(focusedStreet.streetId) && (
                      <Icon name="check_circle" filled className="text-sm text-primary shrink-0" />
                    )}
                    <span className="text-xs font-extrabold text-on-surface truncate">
                      {focusedStreet.name}
                      {focusedStreet.part > 0 && (
                        <span className="font-medium text-on-surface-variant"> · part {focusedStreet.part}</span>
                      )}
                    </span>

                    {focusDetail && (
                      <span className="flex items-center gap-2 shrink-0 text-[11px] tabular-nums">
                        <span className="flex items-center gap-1">
                          <span
                            className="w-2.5 h-1.5 rounded-full"
                            style={{ backgroundColor: "rgb(34 197 94)" }}
                          />
                          <span className="text-on-surface-variant">{Math.round(focusDetail.coveredMeters)} m</span>
                        </span>
                        {focusDetail.complete ? (
                          <span className="font-extrabold text-secondary">done</span>
                        ) : (
                          <span className="flex items-center gap-1">
                            <span
                              className="w-2.5 h-1.5 rounded-full"
                              style={{ backgroundColor: "rgb(239 68 68)" }}
                            />
                            <span className="font-extrabold text-on-surface">
                              {Math.round(focusDetail.missingMeters)} m left
                            </span>
                          </span>
                        )}
                        <span className="text-on-surface-variant hidden sm:inline">
                          of {Math.round(focusDetail.lengthMeters)} m
                        </span>
                      </span>
                    )}

                    <button
                      onClick={() => focusFromList(null)}
                      className="text-[10px] font-extrabold text-primary shrink-0"
                    >
                      Clear
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* The view switch sits under the map, not on it. Floated top-left
                it landed on Leaflet's own zoom buttons, and two controls in one
                corner means every tap is a guess. */}
            {!creating && selectedProject && (
              <div className="shrink-0 flex justify-center border-b border-outline-variant/30 px-4 py-2">
                <div className="inline-flex rounded-full bg-surface-container-low p-0.5">
                  {MAP_MODES.map((option) => (
                    <button
                      key={option.id}
                      onClick={() => setMapMode(option.id)}
                      className={`px-3 py-1 rounded-full text-[11px] font-extrabold transition-colors ${
                        option.id === mapMode
                          ? "bg-primary text-on-primary"
                          : "text-on-surface-variant hover:text-on-surface"
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="flex-1 overflow-y-auto p-4 md:p-6 custom-scrollbar">
              {selectedProject && selectedCoverage ? (
                <ProjectDetail
                  project={selectedProject}
                  coverage={selectedCoverage}
                  pending={selectedPending}
                  busy={busy}
                  showDone={showDone}
                  onToggleDone={() => setShowDone((current) => !current)}
                  streetSort={streetSort}
                  onSortChange={setStreetSort}
                  onFocus={focusFromList}
                  focusStreetId={focusStreetId}
                  focusDetail={focusDetail}
                  checkedStreetIds={checkedStreetIds}
                  onToggleChecked={toggleChecked}
                  onClearChecked={() => {
                    setCheckedStreetIds([]);
                    setRouteError(null);
                  }}
                  checkedMeters={checkedMeters}
                  customStart={routeStart}
                  onPickStart={() => setPickingStart(true)}
                  onResetStart={() => setRouteStart(null)}
                  onBuildRoute={handleBuildRoute}
                  planningRoute={planningRoute}
                  plannedRoute={plannedRoute}
                  routeError={routeError}
                  onDownloadRoute={handleDownloadRoute}
                  onClearRoute={() => {
                    setPlannedRoute(null);
                    setRouteError(null);
                  }}
                  onRefresh={handleRefresh}
                  onAdoptAll={handleAdoptAll}
                  onArchiveToggle={handleArchiveToggle}
                  excludedStreets={excludedStreets}
                  onToggleExclusion={handleToggleExclusion}
                  excluding={excluding}
                  showExcluded={showExcluded}
                  onToggleShowExcluded={() => setShowExcluded((current) => !current)}
                  nearby={nearby}
                  nearbyMargin={nearbyMargin}
                  findingNearby={findingNearby}
                  onFindNearby={handleFindNearby}
                  onAddNearby={handleAddNearby}
                  onClearNearby={() => setNearby(null)}
                  pointingAtRoad={pointingAtRoad}
                  onTogglePointing={() => {
                    setPointingAtRoad((current) => !current);
                    setPointedStreet(null);
                  }}
                  pointedStreet={pointedStreet}
                  pointing={pointing}
                  onConfirmPointed={() => {
                    if (pointedPoint) void handleAddPointedStreet(pointedPoint, pointedTolerance);
                  }}
                  onDismissPointed={() => setPointedStreet(null)}
                />
              ) : !creating && !projectsLoading && projects.length === 0 ? (
                <div className="max-w-xl rounded-2xl bg-surface-container px-4 py-5 text-xs text-on-surface-variant space-y-2">
                  <p className="font-extrabold text-on-surface text-sm">Nothing started yet.</p>
                  <p>
                    Drop a pin on the town you run in and pick a radius. Every named street inside it becomes part of
                    the project — and the {historyKm} km you have already logged counts from the first second.
                  </p>
                </div>
              ) : (
                <p className="text-xs text-on-surface-variant">
                  {selectedProject ? "Reading the street list…" : "Pick a project, or start a new one."}
                </p>
              )}
            </div>
          </div>
          </div>
        </div>
      </div>

      <MobileDrawer
        isOpen={showDrawer}
        onClose={() => setShowDrawer(false)}
        user={user}
        profile={profile}
        onLogout={() => logout()}
        fileInputRef={fileInputRef}
        onFileUpload={handleFileUpload}
        onRouteUpload={handleRouteUpload}
      />
    </div>
  );
}

function ProjectDetail({
  project,
  coverage,
  pending,
  busy,
  showDone,
  onToggleDone,
  streetSort,
  onSortChange,
  onFocus,
  focusStreetId,
  focusDetail,
  checkedStreetIds,
  onToggleChecked,
  onClearChecked,
  checkedMeters,
  customStart,
  onPickStart,
  onResetStart,
  onBuildRoute,
  planningRoute,
  plannedRoute,
  routeError,
  onDownloadRoute,
  onClearRoute,
  onRefresh,
  onAdoptAll,
  onArchiveToggle,
  excludedStreets,
  onToggleExclusion,
  excluding,
  showExcluded,
  onToggleShowExcluded,
  nearby,
  nearbyMargin,
  findingNearby,
  onFindNearby,
  onAddNearby,
  onClearNearby,
  pointingAtRoad,
  onTogglePointing,
  pointedStreet,
  pointing,
  onConfirmPointed,
  onDismissPointed,
}: {
  project: ProjectSummary;
  coverage: ReturnType<typeof computeProjectCoverage>;
  pending: { streets: Street[]; removedNames: string[] } | null;
  busy: null | "creating" | "refreshing" | "adopting";
  showDone: boolean;
  onToggleDone: () => void;
  streetSort: StreetSort;
  onSortChange: (sort: StreetSort) => void;
  onFocus: (id: string | null) => void;
  focusStreetId: string | null;
  focusDetail: StreetCoverageSplit | null;
  checkedStreetIds: string[];
  onToggleChecked: (streetId: string) => void;
  onClearChecked: () => void;
  checkedMeters: number;
  customStart: LatLng | null;
  onPickStart: () => void;
  onResetStart: () => void;
  onBuildRoute: () => void;
  planningRoute: boolean;
  plannedRoute: PlannedStreetRoute | null;
  routeError: string | null;
  onDownloadRoute: () => void;
  onClearRoute: () => void;
  onRefresh: () => void;
  onAdoptAll: () => void;
  onArchiveToggle: () => void;
  excludedStreets: Street[];
  onToggleExclusion: (streetIds: string[], excluded: boolean) => void;
  excluding: boolean;
  showExcluded: boolean;
  onToggleShowExcluded: () => void;
  nearby: NearbyResult | null;
  nearbyMargin: number;
  findingNearby: boolean;
  onFindNearby: (marginMeters: number) => void;
  onAddNearby: (streetIds: string[]) => void;
  onClearNearby: () => void;
  pointingAtRoad: boolean;
  onTogglePointing: () => void;
  pointedStreet: StreetAtPoint | null;
  pointing: boolean;
  onConfirmPointed: () => void;
  onDismissPointed: () => void;
}) {
  const remaining = sortStreetCoverage(
    coverage.streets.filter((street) => !street.complete),
    streetSort,
  );
  const done = sortStreetCoverage(
    coverage.streets.filter((street) => street.complete),
    streetSort,
  );

  const listed = showDone ? done : remaining;
  // The cap keeps six hundred rows out of the DOM, but a street picked off the
  // map has to be on screen or the click did nothing visible. If it fell
  // outside the cap it goes on top, where he is about to be scrolled anyway.
  const capped = listed.slice(0, STREET_LIST_CAP);
  const focusedOutsideCap =
    focusStreetId && !capped.some((street) => street.streetId === focusStreetId)
      ? listed.find((street) => street.streetId === focusStreetId)
      : undefined;
  const visible = focusedOutsideCap ? [focusedOutsideCap, ...capped] : capped;

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-lg font-extrabold text-on-surface truncate">{project.name}</h3>
          <span className="text-2xl font-extrabold text-primary">{Math.round(coverage.ratio * 100)}%</span>
        </div>
        <ProgressBar ratio={coverage.ratio} />
        <p className="text-xs text-on-surface-variant">
          {coverage.streetsComplete} of {coverage.streetsTotal} streets · {formatKm(coverage.coveredMeters)} of{" "}
          {formatKm(coverage.totalMeters)} run ({Math.round(coverage.distanceRatio * 100)}% by distance)
        </p>
        {/* Said out loud under the headline, because a percentage over a
            denominator he has edited has to show the edit. */}
        {excludedStreets.length > 0 && (
          <p className="text-[11px] text-on-surface-variant">
            Not counted: {describeExclusions(excludedStreets)} you have taken out.
          </p>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          onClick={onRefresh}
          disabled={busy === "refreshing"}
          className="rounded-xl bg-surface-container-high px-3 py-2 text-xs font-extrabold text-on-surface flex items-center gap-1.5 disabled:opacity-50"
        >
          <Icon name="sync" className="text-sm" />
          {busy === "refreshing" ? "Asking OSM…" : "Check OSM for new streets"}
        </button>
        <button
          onClick={onArchiveToggle}
          className="rounded-xl bg-surface-container-high px-3 py-2 text-xs font-extrabold text-on-surface flex items-center gap-1.5"
        >
          <Icon name={project.archivedAt ? "unarchive" : "archive"} className="text-sm" />
          {project.archivedAt ? "Unarchive" : "Archive"}
        </button>
      </div>

      {pending && pending.streets.length > 0 && (
        <div className="rounded-2xl border border-tertiary/40 bg-tertiary-container/40 p-4 space-y-3">
          <p className="text-sm font-extrabold text-on-surface">
            {pending.streets.length} new street{pending.streets.length === 1 ? "" : "s"} in OpenStreetMap
          </p>
          <p className="text-xs text-on-surface-variant">
            Your percentage has not moved. It will only change if you add these — and then you will know exactly which
            streets did it.
          </p>
          <ul className="text-xs text-on-surface space-y-1 max-h-40 overflow-y-auto custom-scrollbar">
            {pending.streets.map((street) => (
              <li key={street.id} className="flex justify-between gap-3">
                <span className="truncate">{street.name}</span>
                <span className="text-on-surface-variant shrink-0">{Math.round(street.lengthMeters)} m</span>
              </li>
            ))}
          </ul>
          <button
            onClick={onAdoptAll}
            disabled={busy === "adopting"}
            className="rounded-xl bg-primary text-on-primary px-3 py-2 text-xs font-extrabold disabled:opacity-50"
          >
            {busy === "adopting" ? "Adding…" : "Add them to this project"}
          </button>
        </div>
      )}

      {pending && pending.removedNames.length > 0 && (
        <p className="text-[11px] text-on-surface-variant">
          No longer in OSM, kept in your project: {pending.removedNames.join(", ")}
        </p>
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-extrabold uppercase tracking-wider text-on-surface-variant">
            {showDone ? `Done (${done.length})` : `Left to run (${remaining.length})`}
          </p>
          <button onClick={onToggleDone} className="text-xs font-extrabold text-primary">
            {showDone ? "Show what's left" : "Show what's done"}
          </button>
        </div>

        {!showDone && <StreetSortControl sort={streetSort} onChange={onSortChange} />}

        <StreetRouteBar
          checkedCount={checkedStreetIds.length}
          checkedMeters={checkedMeters}
          onClearChecked={onClearChecked}
          customStart={customStart}
          onPickStart={onPickStart}
          onResetStart={onResetStart}
          onBuildRoute={onBuildRoute}
          planningRoute={planningRoute}
          plannedRoute={plannedRoute}
          routeError={routeError}
          onDownloadRoute={onDownloadRoute}
          onClearRoute={onClearRoute}
        />

        <ul className="divide-y divide-outline-variant/20">
          {visible.map((street) => (
            <StreetRow
              key={street.streetId}
              street={street}
              focused={street.streetId === focusStreetId}
              split={street.streetId === focusStreetId ? focusDetail : null}
              onFocus={() => onFocus(street.streetId === focusStreetId ? null : street.streetId)}
              checked={checkedStreetIds.includes(street.streetId)}
              onToggleChecked={() => onToggleChecked(street.streetId)}
              checkDisabled={
                checkedStreetIds.length >= MAX_SELECTED_STREETS && !checkedStreetIds.includes(street.streetId)
              }
              onExclude={() => onToggleExclusion([street.streetId], true)}
              excluding={excluding}
            />
          ))}
        </ul>

        {listed.length > STREET_LIST_CAP && (
          <p className="text-[11px] text-on-surface-variant pt-2">
            Showing the first {STREET_LIST_CAP} of {listed.length}.
          </p>
        )}
      </div>

      {/* The other half of editing a project: what the area missed.
          A circle drawn round a pin never lands exactly on a town, and the
          alternative to this is deleting the project and starting again —
          throwing away the months of progress that made it worth keeping. */}
      <div className="rounded-2xl border border-outline-variant/30 bg-surface-container-low p-4 space-y-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-extrabold uppercase tracking-wider text-on-surface-variant">
            Add streets the area missed
          </p>
          {nearby && (
            <button onClick={onClearNearby} className="text-xs font-extrabold text-on-surface-variant">
              Done
            </button>
          )}
        </div>

        {/* The first tool offered, because it is the one that answers "I want
            that road there". The margin scan below asks a whole town a question
            to solve one road's problem, and pays for it in seconds. */}
        <button
          onClick={onTogglePointing}
          disabled={pointing}
          className={`w-full rounded-xl px-3 py-2 text-xs font-extrabold flex items-center justify-center gap-1.5 disabled:opacity-50 ${
            pointingAtRoad ? "bg-primary text-on-primary" : "bg-surface-container-high text-on-surface"
          }`}
        >
          <Icon name={pointingAtRoad ? "touch_app" : "add_location_alt"} className="text-sm" />
          {pointingAtRoad ? "Tap a road on the map…" : "Point at a road on the map"}
        </button>

        {pointingAtRoad && !pointedStreet && (
          <p className="text-[11px] text-on-surface-variant">
            {pointing ? "Asking OSM what is there…" : "Tap the road itself, anywhere along it. Nothing is added until you say so."}
          </p>
        )}

        {pointedStreet && (
          <div className="rounded-xl border border-primary/40 bg-surface-container p-3 space-y-2">
            <p className="text-sm font-extrabold text-on-surface">{pointedStreet.name}</p>
            <p className="text-[11px] text-on-surface-variant">
              {pointedStreet.kind === "extension"
                ? `Already in your project as ${pointedStreet.wasMeters} m. The whole street is ${pointedStreet.nowMeters} m.`
                : pointedStreet.kind === "already_in_project"
                  ? "This one is already in your project, all of it."
                  : `${pointedStreet.lengthMeters} m, not in your project.`}
            </p>
            <div className="flex gap-2">
              {pointedStreet.kind !== "already_in_project" && (
                <button
                  onClick={onConfirmPointed}
                  disabled={pointing}
                  className="rounded-xl bg-primary text-on-primary px-3 py-1.5 text-xs font-extrabold disabled:opacity-50"
                >
                  {pointedStreet.kind === "extension" ? "Use all of it" : "Add it"}
                </button>
              )}
              <button
                onClick={onDismissPointed}
                className="rounded-xl bg-surface-container-high px-3 py-1.5 text-xs font-extrabold text-on-surface"
              >
                {pointedStreet.kind === "already_in_project" ? "Close" : "Not that one"}
              </button>
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-on-surface-variant">Or look outside by</span>
          {NEARBY_MARGINS.map((option) => (
            <button
              key={option.meters}
              onClick={() => onFindNearby(option.meters)}
              disabled={findingNearby}
              className={`rounded-full px-3 py-1 text-[11px] font-extrabold transition-colors disabled:opacity-40 ${
                nearby && option.meters === nearbyMargin
                  ? "bg-primary text-on-primary"
                  : "bg-surface-container-high text-on-surface"
              }`}
            >
              {option.label}
            </button>
          ))}
          {findingNearby && <span className="text-[11px] text-on-surface-variant">Asking OSM…</span>}
        </div>

        {nearby && (nearby.additions.length > 0 || nearby.extensions.length > 0) ? (
          <>
            <p className="text-[11px] text-on-surface-variant">
              Drawn in blue on the map. Adding one grows the denominator — you will see exactly which street did it.
            </p>

            {nearby.extensions.length > 0 && (
              <ul className="space-y-1">
                {nearby.extensions.map((extension) => (
                  <li key={extension.replacesId} className="flex items-center justify-between gap-3 text-xs">
                    <span className="truncate text-on-surface">
                      {extension.street.name}
                      <span className="text-on-surface-variant">
                        {" "}
                        · cut short at {extension.wasMeters} m, really {extension.nowMeters} m
                      </span>
                    </span>
                    <button
                      onClick={() => onAddNearby([extension.replacesId])}
                      disabled={findingNearby}
                      className="shrink-0 font-extrabold text-primary disabled:opacity-40"
                    >
                      Use all of it
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {nearby.additions.length > 0 && (
              <ul className="space-y-1 max-h-48 overflow-y-auto custom-scrollbar">
                {nearby.additions.map((street) => (
                  <li key={street.id} className="flex items-center justify-between gap-3 text-xs">
                    <span className="truncate text-on-surface-variant">
                      {street.name}
                      {street.part > 0 && <span> · part {street.part}</span>}
                      <span className="text-on-surface-variant/70"> · {Math.round(street.lengthMeters)} m</span>
                    </span>
                    <button
                      onClick={() => onAddNearby([street.id])}
                      disabled={findingNearby}
                      className="shrink-0 font-extrabold text-primary disabled:opacity-40"
                    >
                      Add
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {nearby.additions.length > 1 && (
              <button
                onClick={() => onAddNearby(nearby.additions.map((street) => street.id))}
                disabled={findingNearby}
                className="rounded-xl bg-primary text-on-primary px-3 py-2 text-xs font-extrabold disabled:opacity-50"
              >
                Add all {nearby.additions.length}
              </button>
            )}

            {nearby.truncated && (
              <p className="text-[11px] text-on-surface-variant">
                That is a lot of streets. Try a smaller margin if this is more town than you meant.
              </p>
            )}
          </>
        ) : (
          nearby && <p className="text-[11px] text-on-surface-variant">{nearby.message}</p>
        )}
      </div>

      {/* Everything he has ruled out, in one place, each with the way back.
          An exclusion he cannot find again is a decision he cannot revise. */}
      {excludedStreets.length > 0 && (
        <div className="rounded-2xl border border-outline-variant/30 bg-surface-container-low p-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-extrabold uppercase tracking-wider text-on-surface-variant">
              Taken out ({excludedStreets.length})
            </p>
            <button onClick={onToggleShowExcluded} className="text-xs font-extrabold text-primary">
              {showExcluded ? "Hide on map" : "Show on map"}
            </button>
          </div>
          <p className="text-[11px] text-on-surface-variant">
            Out of your percentage, still in the snapshot. Put one back and the denominator grows again.
          </p>
          <ul className="space-y-1 max-h-48 overflow-y-auto custom-scrollbar">
            {excludedStreets.map((street) => (
              <li key={street.id} className="flex items-center justify-between gap-3 text-xs">
                <span className="truncate text-on-surface-variant">
                  {street.name}
                  {street.part > 0 && <span> · part {street.part}</span>}
                  <span className="text-on-surface-variant/70"> · {Math.round(street.lengthMeters)} m</span>
                </span>
                <button
                  onClick={() => onToggleExclusion([street.id], false)}
                  disabled={excluding}
                  className="shrink-0 font-extrabold text-primary disabled:opacity-40"
                >
                  Put back
                </button>
              </li>
            ))}
          </ul>
          <button
            onClick={() => onToggleExclusion(excludedStreets.map((street) => street.id), false)}
            disabled={excluding}
            className="text-[11px] font-extrabold text-on-surface-variant disabled:opacity-40"
          >
            Put all of them back
          </button>
        </div>
      )}

      <p className="text-[11px] text-on-surface-variant">
        Street list taken from OpenStreetMap on {new Date(project.snapshotTakenAt).toLocaleDateString()} — {project.wayCount}{" "}
        mapped ways, {project.streetCount} streets. Data © OpenStreetMap contributors.
      </p>
    </div>
  );
}

const STREET_SORTS: Array<{ id: StreetSort; label: string; hint: string }> = [
  { id: "progress", label: "Most done", hint: "Nearly finished streets first" },
  { id: "remaining", label: "Least left", hint: "Fewest metres still to run first" },
  { id: "name", label: "A\u2013Z", hint: "Alphabetical" },
];

/**
 * Which way the list is pointing, said out loud.
 *
 * A list that silently reorders itself is a list you cannot trust: the same
 * street is at the top for two different reasons on two different days. The
 * active sort is named, and the line underneath says what that means, because
 * "most done" and "least left" disagree more often than they sound like they
 * should.
 */
function StreetSortControl({ sort, onChange }: { sort: StreetSort; onChange: (sort: StreetSort) => void }) {
  const active = STREET_SORTS.find((option) => option.id === sort) ?? STREET_SORTS[0];

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 flex-wrap">
        <Icon name="sort" className="text-sm text-on-surface-variant" />
        {STREET_SORTS.map((option) => (
          <button
            key={option.id}
            onClick={() => onChange(option.id)}
            className={`px-2.5 py-1 rounded-full text-[11px] font-extrabold transition-colors ${
              option.id === sort
                ? "bg-primary-container text-on-primary-container"
                : "bg-surface-container text-on-surface-variant hover:text-on-surface"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
      <p className="text-[10px] text-on-surface-variant pl-1">{active.hint} · finished streets sit under “Done”.</p>
    </div>
  );
}

/**
 * The ticked streets, and what can be done with them.
 *
 * Deliberately plain: a start, the streets, and back. No familiarity band, no
 * percentage, no opinion about whether this is a good run — he has already
 * decided that by ticking the boxes. The only judgement the app makes is the
 * order, and that is arithmetic.
 */
function StreetRouteBar({
  checkedCount,
  checkedMeters,
  onClearChecked,
  customStart,
  onPickStart,
  onResetStart,
  onBuildRoute,
  planningRoute,
  plannedRoute,
  routeError,
  onDownloadRoute,
  onClearRoute,
}: {
  checkedCount: number;
  checkedMeters: number;
  onClearChecked: () => void;
  customStart: LatLng | null;
  onPickStart: () => void;
  onResetStart: () => void;
  onBuildRoute: () => void;
  planningRoute: boolean;
  plannedRoute: PlannedStreetRoute | null;
  routeError: string | null;
  onDownloadRoute: () => void;
  onClearRoute: () => void;
}) {
  if (checkedCount === 0 && !plannedRoute && !routeError) return null;

  const atCap = checkedCount >= MAX_SELECTED_STREETS;

  return (
    <div className="rounded-2xl border border-primary/30 bg-primary-container/30 p-3 space-y-3">
      {checkedCount > 0 && (
        <>
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-extrabold text-on-surface">
              {checkedCount} street{checkedCount === 1 ? "" : "s"} ticked
              <span className="font-medium text-on-surface-variant"> · {formatKm(checkedMeters)} of street</span>
            </p>
            <button onClick={onClearChecked} className="text-xs font-extrabold text-error shrink-0">
              Clear
            </button>
          </div>

          <div className="flex items-center gap-2 flex-wrap text-[11px] text-on-surface-variant">
            <Icon name="place" className="text-sm" />
            <span>{customStart ? "Starting from your pin" : "Starting from the middle of the project"}</span>
            <button onClick={onPickStart} className="font-extrabold text-primary">
              {customStart ? "Move it" : "Pick a start"}
            </button>
            {customStart && (
              <button onClick={onResetStart} className="font-extrabold text-on-surface-variant underline">
                Reset
              </button>
            )}
          </div>

          {atCap && (
            <p className="text-[11px] text-on-surface">
              That is the most one route can cover ({MAX_SELECTED_STREETS}). Untick something to swap it for another
              street, or build this one and come back for the rest.
            </p>
          )}

          <button
            onClick={onBuildRoute}
            disabled={planningRoute}
            className="w-full rounded-xl bg-primary text-on-primary px-3 py-2.5 text-xs font-extrabold disabled:opacity-50 flex items-center justify-center gap-1.5"
          >
            <Icon name={planningRoute ? "progress_activity" : "route"} className={`text-sm ${planningRoute ? "animate-spin" : ""}`} />
            {planningRoute ? "Finding a way round…" : `Build a route through ${checkedCount === 1 ? "it" : "them"}`}
          </button>
        </>
      )}

      {routeError && (
        <p className="text-[11px] text-error font-medium flex items-start gap-1.5">
          <Icon name="error" className="text-sm shrink-0" />
          <span>{routeError}</span>
        </p>
      )}

      {plannedRoute && (
        <div className="rounded-xl bg-surface-container-lowest p-3 space-y-2">
          <div className="flex items-baseline justify-between gap-3">
            <p className="text-sm font-extrabold text-on-surface">
              {Math.round(plannedRoute.distanceMeters / 100) / 10} km
            </p>
            <span className="text-[11px] text-on-surface-variant">
              {plannedRoute.streetNames.length} street{plannedRoute.streetNames.length === 1 ? "" : "s"}
              {plannedRoute.elevationGainMeters ? ` · ${Math.round(plannedRoute.elevationGainMeters)} m up` : ""}
            </span>
          </div>
          <p className="text-[11px] text-on-surface-variant">
            In order: {plannedRoute.streetNames.slice(0, 6).join(" → ")}
            {plannedRoute.streetNames.length > 6 ? ` → … → back to the start` : " → back to the start"}
          </p>
          <div className="flex gap-2">
            <button
              onClick={onDownloadRoute}
              className="flex-1 rounded-xl bg-surface-container-high px-3 py-2 text-xs font-extrabold text-on-surface flex items-center justify-center gap-1.5"
            >
              <Icon name="download" className="text-sm" />
              Download GPX
            </button>
            <button onClick={onClearRoute} className="rounded-xl px-3 py-2 text-xs font-extrabold text-on-surface-variant">
              Hide
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function StreetRow({
  street,
  focused,
  split,
  onFocus,
  checked,
  onToggleChecked,
  checkDisabled,
  onExclude,
  excluding,
}: {
  street: StreetCoverage;
  focused: boolean;
  /** Only for the focused row: the same split the map is drawing. */
  split: StreetCoverageSplit | null;
  onFocus: () => void;
  checked: boolean;
  onToggleChecked: () => void;
  checkDisabled: boolean;
  onExclude: () => void;
  excluding: boolean;
}) {
  const rowRef = useRef<HTMLLIElement>(null);

  // Picked on the map, found in the list. Six hundred rows is a long way to
  // scroll to confirm that the click landed where he thought it did.
  useEffect(() => {
    if (focused) rowRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focused]);

  return (
    <li
      ref={rowRef}
      className={`flex items-center rounded-lg transition-colors ${
        focused ? "bg-surface-container-high ring-1 ring-primary/40" : "hover:bg-surface-container"
      }`}
    >
      {/* The ring he asked for, now a box you can tick. Its own button rather
          than part of the row, so picking a street to look at and picking a
          street to run are two different gestures in the same place. */}
      <button
        role="checkbox"
        aria-checked={checked}
        aria-label={`Include ${street.name} in a route`}
        onClick={onToggleChecked}
        disabled={checkDisabled}
        title={checkDisabled ? `That is the most one route can cover (${MAX_SELECTED_STREETS})` : undefined}
        className="py-2.5 pl-2 pr-1 shrink-0 disabled:opacity-30"
      >
        <Icon
          name={checked ? "check_circle" : "radio_button_unchecked"}
          filled={checked}
          className={`text-base ${
            checked ? "text-primary" : street.complete ? "text-secondary" : "text-on-surface-variant"
          }`}
        />
      </button>

      <button
        onClick={onFocus}
        className="flex-1 min-w-0 text-left py-2.5 px-2 flex items-center gap-3"
      >
        <span className="flex-1 min-w-0">
          <span className="block text-sm text-on-surface truncate">
            {street.name}
            {street.part > 0 && <span className="text-on-surface-variant"> · part {street.part}</span>}
          </span>
          <span className="block text-[11px] text-on-surface-variant">
            {street.complete
              ? `${Math.round(street.lengthMeters)} m done`
              : `${Math.round(street.remainingMeters)} m left of ${Math.round(street.lengthMeters)} m`}
          </span>
          {/* The map's legend, said once beside the street it belongs to,
              rather than parked in a corner where it explains nothing. */}
          {focused && split && !split.complete && (
            <span className="mt-1 flex items-center gap-2 text-[10px] font-bold">
              <span className="flex items-center gap-1">
                <span className="w-3 h-1 rounded-full" style={{ backgroundColor: "rgb(34 197 94)" }} />
                <span className="text-on-surface-variant">{Math.round(split.coveredMeters)} m run</span>
              </span>
              <span className="flex items-center gap-1">
                <span className="w-3 h-1 rounded-full" style={{ backgroundColor: "rgb(239 68 68)" }} />
                <span className="text-on-surface-variant">{Math.round(split.missingMeters)} m missing</span>
              </span>
            </span>
          )}
        </span>
        {!street.complete && (
          <span className="flex items-center gap-1.5 shrink-0">
            {/* The number the “most done” sort is ordering on, so the order is
                something he can check rather than take on faith. */}
            <span className="text-[11px] font-extrabold text-on-surface-variant tabular-nums w-8 text-right">
              {Math.round(street.ratio * 100)}%
            </span>
            <span className="w-12">
              <ProgressBar ratio={street.ratio} tone="secondary" />
            </span>
          </span>
        )}
      </button>

      {/* Only on the row he is looking at. Six hundred rows each carrying a
          delete-shaped button is a page that looks like it wants tidying;
          revealed on focus, it is there exactly when he has just looked at a
          road on the map and decided it is a dual carriageway. */}
      {focused && (
        <button
          onClick={onExclude}
          disabled={excluding}
          title="Not runnable — take it out of this project"
          aria-label={`Exclude ${street.name} from this project`}
          className="py-2.5 pl-1 pr-2 shrink-0 text-on-surface-variant hover:text-error disabled:opacity-30"
        >
          <Icon name="block" className="text-base" />
        </button>
      )}
    </li>
  );
}

function CreateProjectPanel({
  user,
  defaultPin,
  pin,
  onPinChange,
  onRingChange,
  onCancel,
  onCreated,
  busy,
  setBusy,
  onError,
}: {
  user: NonNullable<ReturnType<typeof useAuth>["user"]>;
  defaultPin: LatLng | null;
  /** Owned by the page, because the page's map is where it is placed. */
  pin: LatLng | null;
  onPinChange: (point: LatLng | null) => void;
  onRingChange: (ring: LatLng[]) => void;
  onCancel: () => void;
  onCreated: (project: ProjectSummary, streets: Street[]) => void;
  busy: boolean;
  setBusy: (value: boolean) => void;
  onError: (message: string | null) => void;
}) {
  const setPin = onPinChange;
  const [radiusMeters, setRadiusMeters] = useState(DEFAULT_RADIUS_METERS);
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<ScopePreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [boundaries, setBoundaries] = useState<BoundaryCandidate[] | null>(null);
  const [boundary, setBoundary] = useState<BoundaryCandidate | null>(null);

  const scopeRequest = useMemo<ScopeRequest | null>(() => {
    if (boundary) {
      return { kind: "boundary", osmId: boundary.osmId, name: boundary.name, adminLevel: boundary.adminLevel };
    }
    if (!pin) return null;
    return { kind: "circle", lat: pin.lat, lng: pin.lng, radiusMeters };
  }, [boundary, pin, radiusMeters]);

  /**
   * The live street count.
   *
   * This is the safety check, and it is the reason the app never has to reason
   * about what a Swedish admin level means: "Falkenberg kommun" sounds right
   * and contains a town forty kilometres away, and the only thing that says so
   * in time is a number that changes while you drag the slider.
   */
  useEffect(() => {
    if (!scopeRequest) return;
    let cancelled = false;
    setPreviewing(true);

    const timer = setTimeout(() => {
      void (async () => {
        try {
          const result = await previewScope(user, scopeRequest);
          if (!cancelled) {
            setPreview(result);
            onError(null);
          }
        } catch (error) {
          if (!cancelled) {
            setPreview(null);
            onError(
              error instanceof ApiError && error.retryable
                ? "OpenStreetMap is busy right now — try that again in a moment."
                : error instanceof Error
                  ? error.message
                  : "Could not count the streets there.",
            );
          }
        } finally {
          if (!cancelled) setPreviewing(false);
        }
      })();
    }, PREVIEW_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      setPreviewing(false);
      clearTimeout(timer);
    };
  }, [scopeRequest, user, onError]);

  const previewRing = useMemo(() => {
    if (preview) return preview.scope.ring;
    if (pin && !boundary) return circleScope(pin, radiusMeters).ring;
    return [];
  }, [preview, pin, radiusMeters, boundary]);

  const handleFindBoundaries = async () => {
    if (!pin) return;
    try {
      const found = await findBoundaries(user, pin.lat, pin.lng);
      setBoundaries(found);
      if (found.length === 0) onError("OSM has no administrative boundary around that point — use a radius instead.");
    } catch (error) {
      onError(error instanceof Error ? error.message : "Could not look up boundaries.");
    }
  };

  const handleCreate = async () => {
    if (!scopeRequest) return;
    setBusy(true);
    onError(null);
    try {
      const suggested = boundary?.name ?? (preview ? `Streets around here` : "Street project");
      const { project, streets } = await createProject(user, name.trim() || suggested, scopeRequest);
      onCreated(project, streets);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Could not create that project.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-surface-container p-4 space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-extrabold text-on-surface">New project</p>
          <button onClick={onCancel} className="text-xs font-extrabold text-on-surface-variant">
            Cancel
          </button>
        </div>

        <div className="space-y-2">
          <label className="text-[11px] uppercase tracking-wider text-on-surface-variant">Centre</label>
          <div className="flex gap-2">
            <input
              value={pin ? pin.lat.toFixed(4) : ""}
              onChange={(event) =>
                setPin({ lat: Number(event.target.value), lng: pin?.lng ?? 0 })
              }
              placeholder="lat"
              className="flex-1 rounded-xl bg-surface-container-lowest px-3 py-2 text-sm text-on-surface"
            />
            <input
              value={pin ? pin.lng.toFixed(4) : ""}
              onChange={(event) =>
                setPin({ lat: pin?.lat ?? 0, lng: Number(event.target.value) })
              }
              placeholder="lng"
              className="flex-1 rounded-xl bg-surface-container-lowest px-3 py-2 text-sm text-on-surface"
            />
          </div>
          <p className="text-[11px] text-on-surface-variant">
            Defaults to where your runs start. Tap the map to move it.
          </p>
        </div>

        {!boundary && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-[11px] uppercase tracking-wider text-on-surface-variant">Radius</label>
              <span className="text-xs font-extrabold text-on-surface">{(radiusMeters / 1000).toFixed(1)} km</span>
            </div>
            <input
              type="range"
              min={500}
              max={15000}
              step={250}
              value={radiusMeters}
              onChange={(event) => setRadiusMeters(Number(event.target.value))}
              className="w-full accent-primary"
            />
          </div>
        )}

        <div className="rounded-xl bg-surface-container-lowest px-3 py-3 text-sm">
          {previewing && <span className="text-on-surface-variant">Counting streets…</span>}
          {!previewing && preview && (
            <div className="space-y-1">
              <p className="font-extrabold text-on-surface">
                {preview.streetCount} streets · {formatKm(preview.totalMeters)}
              </p>
              <p className="text-[11px] text-on-surface-variant">
                {preview.areaKm2} km² · from {preview.wayCount} mapped ways
                {preview.longestStreets.length > 0 && ` · longest: ${preview.longestStreets.slice(0, 3).join(", ")}`}
              </p>
            </div>
          )}
          {!previewing && !preview && <span className="text-on-surface-variant">Drop a pin to count the streets.</span>}
        </div>

        <div className="space-y-2">
          {boundary ? (
            <div className="flex items-center justify-between rounded-xl bg-surface-container-lowest px-3 py-2">
              <span className="text-xs text-on-surface truncate">
                {boundary.name} · level {boundary.adminLevel}
              </span>
              <button onClick={() => setBoundary(null)} className="text-xs font-extrabold text-primary shrink-0">
                Use a radius
              </button>
            </div>
          ) : (
            <button
              onClick={handleFindBoundaries}
              disabled={!pin}
              className="text-xs font-extrabold text-primary disabled:opacity-40"
            >
              Snap to a town boundary instead
            </button>
          )}

          {!boundary && boundaries && boundaries.length > 0 && (
            <ul className="space-y-1">
              {boundaries.map((candidate) => (
                <li key={candidate.osmId}>
                  <button
                    onClick={() => setBoundary(candidate)}
                    className="w-full text-left rounded-xl bg-surface-container-lowest px-3 py-2 text-xs text-on-surface hover:bg-surface-container-high"
                  >
                    {candidate.name}
                    <span className="text-on-surface-variant"> · level {candidate.adminLevel}</span>
                    {candidate.kind && <span className="text-on-surface-variant"> · {candidate.kind}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="space-y-2">
          <label className="text-[11px] uppercase tracking-wider text-on-surface-variant">Name</label>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={boundary?.name ?? "Every street in town"}
            className="w-full rounded-xl bg-surface-container-lowest px-3 py-2 text-sm text-on-surface"
          />
        </div>

        <button
          onClick={handleCreate}
          disabled={busy || !scopeRequest || !preview || preview.streetCount === 0}
          className="w-full rounded-2xl bg-primary text-on-primary px-4 py-3 font-extrabold text-sm disabled:opacity-50"
        >
          {busy ? "Taking the street list…" : "Start project"}
        </button>

        <p className="text-[11px] text-on-surface-variant">
          The street list is frozen now, so new mapping can never quietly lower your percentage. Your existing runs count
          from the first second.
        </p>
      </div>

      <ScopeReporter ring={previewRing} onChange={onRingChange} />
    </div>
  );
}

/**
 * Hands the scope being drawn up to the page, which draws it on the one real
 * map. Renders nothing: there used to be a second, smaller map here showing the
 * same circle, and two maps of the same thing is one map too many.
 */
function ScopeReporter({ ring, onChange }: { ring: LatLng[]; onChange: (ring: LatLng[]) => void }) {
  useEffect(() => {
    onChange(ring);
  }, [ring, onChange]);
  return null;
}
