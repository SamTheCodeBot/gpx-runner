"use client";

import dynamic from "next/dynamic";
import { Icon } from "./ui";
import type { GPXRoute } from "@/app/types";

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
  onToggleHeatmap: () => void;
  isLoading: boolean;
  selectedStartPoint: [number, number] | null;
  isSelectingStartPoint: boolean;
  onMapClick: (lat: number, lon: number) => void;
}

function MapLegend() {
  return (
    <div className="hidden md:flex absolute bottom-4 left-4 z-20">
      <div className="bg-surface-container-lowest/90 backdrop-blur-md px-3 py-2 rounded-xl flex items-center gap-4 shadow-sm">
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: "rgb(255 65 164)" }} />
          <span className="text-[10px] font-extrabold text-primary uppercase tracking-wider">Road</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: "rgb(18 221 251)" }} />
          <span className="text-[10px] font-extrabold text-primary uppercase tracking-wider">Trail</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: "rgb(197 45 255)" }} />
          <span className="text-[10px] font-extrabold text-primary uppercase tracking-wider">Mixed</span>
        </div>
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
        {showHeatmap ? "Heatmap ON" : "Heatmap OFF"}
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
  routes, selectedRoute, suggestedRoute, showHeatmap,
  onToggleHeatmap, isLoading, selectedStartPoint, isSelectingStartPoint, onMapClick,
}: MapSectionProps) {
  // Routes with coordinates for display
  const displayRoutes = suggestedRoute ? [] : routes.filter(
    (r) => r.coordinates && r.coordinates.length > 0 && Array.isArray(r.coordinates[0])
  );

  return (
    <div className="w-full h-full bg-surface-container-lowest rounded-2xl overflow-hidden relative shadow-sm md:shadow-card">
      <MapWithNoSSR
        routes={displayRoutes}
        selectedRoute={selectedRoute}
        showHeatmap={showHeatmap}
        suggestedRoute={suggestedRoute ?? undefined}
        selectedStartPoint={selectedStartPoint}
        isSelectingStartPoint={isSelectingStartPoint}
        onMapClick={onMapClick}
        darkMode={false}
      />

      <MapLegend />
      <HeatmapToggle showHeatmap={showHeatmap} onToggleHeatmap={onToggleHeatmap} />
      <LoadingOverlay isLoading={isLoading} />
      <StartPointHint isSelectingStartPoint={isSelectingStartPoint} />
    </div>
  );
}
