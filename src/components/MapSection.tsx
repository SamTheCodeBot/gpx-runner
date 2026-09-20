"use client";

import dynamic from "next/dynamic";
import { Icon } from "./ui";
import type { GPXRoute } from "@/app/types";
import type { PersonalHeatmapMode } from "@/components/Map";
import { frequencyStops, RECENCY_BANDS, type VisitGrid } from "@/engine/heatmap";
import type { RouteFamiliaritySegment } from "@/lib/routeFamiliarity";

const MapWithNoSSR = dynamic(() => import("@/components/Map"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full bg-surface-dim flex items-center justify-center">
      <div className="text-on-surface-variant text-sm">Loading map&hellip;</div>
    </div>
  ),
});

interface MapSectionProps {
  routes: GPXRoute[];
  selectedRoute: GPXRoute | null;
  suggestedRoute: GPXRoute | null;
  showHeatmap: boolean;
  fitAllRoutes?: boolean;
  showPersonalHeatmap: boolean;
  personalHeatmapMode?: PersonalHeatmapMode;
  /** Counted once by the page that owns the history, so map and legend agree. */
  heatmapGrid?: VisitGrid | null;
  heatmapStops?: number[];
  heatmapPaceRange?: { min: number; max: number } | null;
  onToggleHeatmap: () => void;
  onTogglePersonalHeatmap: () => void;
  isLoading: boolean;
  selectedStartPoint: [number, number] | null;
  isSelectingStartPoint: boolean;
  onMapClick: (lat: number, lon: number) => void;
  showMapControls?: boolean;
  showPersonalHeatmapControl?: boolean;
  familiaritySegments?: RouteFamiliaritySegment[];
}

/** The ramp, as CSS, so the legend swatch is the same gradient the map drew. */
const FREQUENCY_GRADIENT = "linear-gradient(90deg, rgb(56 132 255), rgb(18 221 251), rgb(163 230 53), rgb(251 191 36), rgb(244 63 94))";
const RECENCY_SWATCHES = ["rgb(34 211 160)", "rgb(163 230 53)", "rgb(251 191 36)", "rgb(249 115 22)", "rgb(120 113 140)"];

function paceLabel(metersPerMinute: number): string {
  // The scale is held as speed so it ramps the intuitive way; a runner reads
  // minutes per kilometre, so it is turned back at the last possible moment.
  const minPerKm = metersPerMinute > 0 ? 1 / metersPerMinute : 0;
  const minutes = Math.floor(minPerKm);
  const seconds = Math.round((minPerKm - minutes) * 60);
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * The legend, with real numbers on it.
 *
 * The old one said "Frequency" beside a gradient and left it there — which
 * told the reader that some colour meant more than another colour, and nothing
 * else. A legend whose numbers a runner cannot check against his own memory of
 * a road is decoration. Every tick here is a count the map actually drew.
 */
function MapLegend({
  showPersonalHeatmap,
  mode,
  stops,
  paceRange,
}: {
  showPersonalHeatmap: boolean;
  mode: PersonalHeatmapMode;
  stops: number[];
  paceRange: { min: number; max: number } | null;
}) {
  if (!showPersonalHeatmap) return null;

  return (
    <div className="absolute bottom-4 left-4 z-20 max-w-[calc(100%-2rem)]">
      <div className="bg-surface-container-lowest/90 backdrop-blur-md px-3 py-2 rounded-xl shadow-sm space-y-1.5">
        {mode === "recency" ? (
          <div className="flex items-center gap-2 flex-wrap">
            {RECENCY_BANDS.map((band, index) => (
              <div key={band.label} className="flex items-center gap-1">
                <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: RECENCY_SWATCHES[index] }} />
                <span className="text-[10px] font-bold text-on-surface-variant">{band.label}</span>
              </div>
            ))}
          </div>
        ) : (
          <>
            <div className="h-2 w-full min-w-[160px] rounded-full" style={{ background: FREQUENCY_GRADIENT }} />
            <div className="flex items-center justify-between gap-3">
              {mode === "pace" ? (
                <>
                  <span className="text-[10px] font-bold text-on-surface-variant">
                    {paceRange ? `${paceLabel(paceRange.min)} /km` : "slower"}
                  </span>
                  <span className="text-[9px] font-extrabold uppercase tracking-wider text-on-surface-variant">Pace</span>
                  <span className="text-[10px] font-bold text-on-surface-variant">
                    {paceRange ? `${paceLabel(paceRange.max)} /km` : "faster"}
                  </span>
                </>
              ) : (
                <>
                  {(stops.length > 0 ? stops : [1]).map((stop, index) => (
                    <span key={`${stop}-${index}`} className="text-[10px] font-bold text-on-surface-variant tabular-nums">
                      {stop}
                      {index === 0 ? " run" : ""}
                    </span>
                  ))}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function HeatmapToggle({ showHeatmap, onToggleHeatmap }: { showHeatmap: boolean; onToggleHeatmap: () => void }) {
  return (
    <div className="hidden md:block absolute top-4 right-4 z-20">
      <button
        onClick={onToggleHeatmap}
        className={`px-3 py-1.5 rounded-xl text-[10px] font-bold shadow-sm transition-colors ${
          showHeatmap
            ? "bg-primary text-on-primary"
            : "bg-surface-container-lowest text-on-surface-variant hover:bg-surface-container"
        }`}
      >
        <Icon name="layers" className="text-xs inline mr-1" />
        {showHeatmap ? "Hide routes" : "Show routes"}
      </button>
    </div>
  );
}

function PersonalHeatmapToggle({ showPersonalHeatmap, onToggle }: { showPersonalHeatmap: boolean; onToggle: () => void }) {
  return (
    <div className="hidden md:block absolute top-[88px] right-4 z-20">
      <button
        onClick={onToggle}
        className={`px-3 py-1.5 rounded-xl text-[10px] font-bold shadow-sm transition-colors ${
          showPersonalHeatmap
            ? "bg-primary text-on-primary"
            : "bg-surface-container-lowest text-on-surface-variant hover:bg-surface-container"
        }`}
        title="Personal heatmap — repeated sections use stronger route colours"
      >
        <Icon name="whatshot" className="text-xs inline mr-1" />
        {showPersonalHeatmap ? "Heatmap on" : "My heatmap"}
      </button>
    </div>
  );
}

function LoadingOverlay({ isLoading }: { isLoading: boolean }) {
  if (!isLoading) return null;
  return (
    <div className="absolute inset-0 bg-[#fbf9f8]/70 flex items-center justify-center z-30">
      <div className="bg-surface-container-lowest px-6 py-4 rounded-2xl shadow-lg flex items-center gap-3">
        <Icon name="progress_activity" className="text-primary animate-spin text-xl" />
        <span className="text-sm font-medium text-on-surface">Processing GPX&hellip;</span>
      </div>
    </div>
  );
}

function StartPointHint({ isSelectingStartPoint }: { isSelectingStartPoint: boolean }) {
  if (!isSelectingStartPoint) return null;
  return (
    <div className="absolute inset-0 z-20 flex items-start justify-center pt-4 pointer-events-none">
      <div className="bg-primary text-on-primary px-4 py-2 rounded-xl text-xs font-bold shadow-lg pointer-events-auto">
        <Icon name="place" className="text-xs inline mr-1" />
        Click the map to set start point
      </div>
    </div>
  );
}

export function MapSection({
  routes, selectedRoute, suggestedRoute, showHeatmap, showPersonalHeatmap,
  fitAllRoutes = false,
  personalHeatmapMode = "frequency",
  heatmapGrid = null,
  heatmapStops = [],
  heatmapPaceRange = null,
  onToggleHeatmap, onTogglePersonalHeatmap, isLoading, selectedStartPoint, isSelectingStartPoint, onMapClick,
  showMapControls = true,
  showPersonalHeatmapControl = true,
  familiaritySegments,
}: MapSectionProps) {
  const displayRoutes = suggestedRoute ? [] : routes.filter(
    (r) => r.coordinates && r.coordinates.length > 0 && Array.isArray(r.coordinates[0])
  );

  return (
    <div className="w-full h-full bg-surface-container-lowest rounded-2xl overflow-hidden relative shadow-sm md:shadow-card">
      <MapWithNoSSR
        routes={displayRoutes}
        selectedRoute={selectedRoute}
        showHeatmap={showHeatmap}
        fitAllRoutes={fitAllRoutes}
        showPersonalHeatmap={showPersonalHeatmap}
        personalHeatmapMode={personalHeatmapMode}
        heatmapGrid={heatmapGrid}
        heatmapStops={heatmapStops}
        heatmapPaceRange={heatmapPaceRange}
        suggestedRoute={suggestedRoute ?? undefined}
        selectedStartPoint={selectedStartPoint}
        isSelectingStartPoint={isSelectingStartPoint}
        onMapClick={onMapClick}
        darkMode={false}
        familiaritySegments={familiaritySegments}
      />

      <MapLegend
        showPersonalHeatmap={showPersonalHeatmap}
        mode={personalHeatmapMode}
        stops={heatmapStops}
        paceRange={heatmapPaceRange}
      />
      {showMapControls && (
        <>
          <HeatmapToggle showHeatmap={showHeatmap} onToggleHeatmap={onToggleHeatmap} />
          {showPersonalHeatmapControl && (
            <PersonalHeatmapToggle showPersonalHeatmap={showPersonalHeatmap} onToggle={onTogglePersonalHeatmap} />
          )}
        </>
      )}
      <LoadingOverlay isLoading={isLoading} />
      <StartPointHint isSelectingStartPoint={isSelectingStartPoint} />
    </div>
  );
}
