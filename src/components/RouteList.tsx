"use client";

import { Icon, RouteRow } from "./ui";
import type { GPXRoute } from "@/app/types";

interface RouteListProps {
  filteredRoutes: GPXRoute[];
  selectedRoute: GPXRoute | null;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  showFilters: boolean;
  filter: { month?: string; type?: string };
  setFilter: (f: { month?: string; type?: string }) => void;
  setShowFilters: (v: boolean) => void;
  getMonthOptions: () => string[];
  onSelectRoute: (r: GPXRoute | null) => void;
  onDeleteRoute: (id: string) => void;
  onDownloadRoute: (r: GPXRoute) => void;
  onEditRoute: (r: GPXRoute) => void;
  fileInputRef: React.RefObject<HTMLInputElement>;
  onFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

export function RouteList({
  filteredRoutes, selectedRoute, searchQuery, onSearchChange,
  showFilters, filter, setFilter, setShowFilters, getMonthOptions,
  onSelectRoute, onDeleteRoute, onDownloadRoute, onEditRoute,
  fileInputRef, onFileUpload,
}: RouteListProps) {
  const hasActiveFilters = !!(filter.month || filter.type);

  return (
    <div>
      {/* Header with filter button on right */}
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-extrabold text-primary font-headline">
          All Routes
          <span className="ml-2 text-xs font-medium text-on-surface-variant">({filteredRoutes.length})</span>
        </h3>
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-medium transition-colors border ${
            showFilters || hasActiveFilters
              ? "bg-primary-container border-primary-container text-on-primary-container"
              : "bg-surface-container border-outline-variant text-on-surface-variant hover:border-outline"
          }`}
        >
          <Icon name="tune" className="text-[9px]" />Filters
        </button>
      </div>

      {/* Filter panel */}
      {showFilters && (
        <div className="bg-surface-container-lowest border border-outline-variant/30 rounded-xl p-2 mb-2 flex flex-wrap items-center gap-2 animate-fade-in">
          <select
            value={filter.month || ""}
            onChange={(e) => setFilter({ ...filter, month: e.target.value || undefined })}
            className="px-2 py-1 bg-surface-container border border-outline-variant rounded-lg text-[10px] text-on-surface focus:outline-none"
          >
            <option value="">All months</option>
            {getMonthOptions().map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <select
            value={filter.type || "all"}
            onChange={(e) => setFilter({ ...filter, type: e.target.value === "all" ? undefined : e.target.value })}
            className="px-2 py-1 bg-surface-container border border-outline-variant rounded-lg text-[10px] text-on-surface focus:outline-none"
          >
            <option value="all">All types</option>
            <option value="road">Road</option>
            <option value="trail">Trail</option>
            <option value="mixed">Mixed</option>
          </select>
          {(filter.month || filter.type) && (
            <button
              onClick={() => setFilter({})}
              className="text-[10px] text-error font-medium hover:underline ml-auto"
            >
              Clear
            </button>
          )}
        </div>
      )}

      {/* Routes */}
      {filteredRoutes.length === 0 ? (
        <div className="text-center py-10">
          <div className="w-14 h-14 rounded-2xl bg-surface-container flex items-center justify-center mx-auto mb-3">
            <Icon name="route" className="text-on-surface-variant text-2xl" />
          </div>
          <h4 className="text-base font-extrabold text-on-surface mb-1">No routes yet</h4>
          <p className="text-sm text-on-surface-variant mb-4">Upload a GPX file to get started</p>
          <label className="inline-flex items-center gap-2 px-4 py-2.5 bg-primary text-on-primary rounded-xl text-sm font-bold cursor-pointer hover:opacity-90 transition-opacity">
            <Icon name="upload" className="text-sm" />Upload GPX
            <input ref={fileInputRef} type="file" accept=".gpx" multiple onChange={onFileUpload} className="hidden" />
          </label>
        </div>
      ) : (
        <div className="space-y-2">
          {filteredRoutes.map((route) => (
            <RouteRow
              key={route.id}
              route={route}
              selected={selectedRoute?.id === route.id}
              onSelect={() => onSelectRoute(selectedRoute?.id === route.id ? null : route)}
              onDelete={() => onDeleteRoute(route.id)}
              onDownload={() => onDownloadRoute(route)}
              onEdit={() => onEditRoute(route)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
