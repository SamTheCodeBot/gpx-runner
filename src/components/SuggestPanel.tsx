"use client";

import { Icon } from "./ui";

interface SuggestPanelProps {
  suggestDistance: number;
  onDistanceChange: (d: number) => void;
  avoidFamiliar: boolean;
  onAvoidChange: (v: boolean) => void;
  isSelectingStartPoint: boolean;
  onToggleStartPointSelect: () => void;
  selectedStartPoint: [number, number] | null;
  onClearStartPoint: () => void;
  isSuggesting: boolean;
  apiKeyMissing: boolean;
  onGenerate: () => void;
  onClose: () => void;
}

export function SuggestPanel({
  suggestDistance, onDistanceChange, avoidFamiliar, onAvoidChange,
  isSelectingStartPoint, onToggleStartPointSelect, selectedStartPoint, onClearStartPoint,
  isSuggesting, apiKeyMissing, onGenerate, onClose,
}: SuggestPanelProps) {
  return (
    <div className="bg-surface-container-lowest border border-outline-variant/20 rounded-2xl p-4 animate-fade-in">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Icon name="auto_awesome" className="text-primary text-lg" />
          <h3 className="text-sm font-extrabold text-primary font-headline">Generate Route</h3>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 hover:bg-surface-container rounded-xl transition-colors"
        >
          <Icon name="close" className="text-on-surface-variant text-sm" />
        </button>
      </div>

      <div className="space-y-4">
        {/* Distance slider */}
        <div>
          <label className="text-[10px] font-extrabold uppercase tracking-wider text-on-surface-variant mb-1 block">
            Distance (km)
          </label>
          <input
            type="range"
            min={1}
            max={20}
            step={0.5}
            value={suggestDistance}
            onChange={(e) => onDistanceChange(parseFloat(e.target.value))}
            className="w-full accent-primary"
          />
          <div className="text-center text-sm font-bold text-primary mt-1">{suggestDistance} km</div>
        </div>

        {/* Avoid familiar toggle */}
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="avoidFamiliar"
            checked={avoidFamiliar}
            onChange={(e) => onAvoidChange(e.target.checked)}
            className="accent-primary w-4 h-4"
          />
          <label htmlFor="avoidFamiliar" className="text-sm text-on-surface">Discover new routes</label>
        </div>

        {/* Start point */}
        <div className="flex gap-2 items-center">
          <button
            onClick={onToggleStartPointSelect}
            className={`flex-1 py-2 rounded-xl border text-xs font-semibold transition-colors ${
              isSelectingStartPoint
                ? "bg-primary-container border-primary-container text-on-primary-container"
                : "border-outline-variant text-on-surface-variant hover:bg-surface-container"
            }`}
          >
            <Icon name="place" className="text-xs inline mr-1" />
            {isSelectingStartPoint ? "Click map…" : "Set start point"}
          </button>
          {selectedStartPoint && (
            <button onClick={onClearStartPoint} className="py-2 px-3 rounded-xl border border-outline-variant text-xs text-on-surface-variant hover:bg-surface-container transition-colors">
              <Icon name="close" className="text-xs" />
            </button>
          )}
        </div>

        {selectedStartPoint && (
          <p className="text-[10px] text-on-surface-variant text-center">
            📍 {selectedStartPoint[1].toFixed(4)}, {selectedStartPoint[0].toFixed(4)}
          </p>
        )}

        {/* Generate button */}
        <button
          onClick={onGenerate}
          disabled={isSuggesting}
          className="w-full py-3 bg-primary text-on-primary rounded-xl text-sm font-bold hover:opacity-90 disabled:opacity-50 transition-opacity flex items-center justify-center gap-2"
        >
          {isSuggesting ? (
            <>
              <Icon name="progress_activity" className="animate-spin text-base" />
              Generating…
            </>
          ) : (
            <>
              <Icon name="route" className="text-base" />
              Generate route
            </>
          )}
        </button>

        {/* API key warning */}
        {apiKeyMissing && (
          <div className="bg-error-container/30 border border-error/20 rounded-xl px-3 py-2">
            <p className="text-[11px] text-error font-medium">
              <Icon name="warning" className="text-xs inline mr-1" />
              OpenRouteService API key not set. Add <code className="font-mono bg-error/10 px-1 rounded">OPENROUTESERVICE_API_KEY</code> to <code className="font-mono bg-error/10 px-1 rounded">.env.local</code>.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
