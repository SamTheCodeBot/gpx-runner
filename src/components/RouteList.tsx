"use client";

import { Icon, RouteRow } from "./ui";
import type { GPXRoute } from "@/app/types";

interface RouteListProps {
  filteredRoutes: GPXRoute[];
  selectedRoute: GPXRoute | null;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  showFilters: boolean;
  filter: { month?: string; type?: string; list?: "all" | "favorites" | "wishlist" };
  setFilter: (f: { month?: string; type?: string; list?: "all" | "favorites" | "wishlist" }) => void;
  setShowFilters: (v: boolean) => void;
  getMonthOptions: () => string[];
  onSelectRoute: (r: GPXRoute | null) => void;
  onDeleteRoute: (id: string) => void;
  onDownloadRoute: (r: GPXRoute) => void;
  onEditRoute: (r: GPXRoute) => void;
  fileInputRef: React.RefObject<HTMLInputElement>;
  onFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  wishlist: GPXRoute[];
  favorites: string[];
  onToggleFavorite: (routeId: string) => void;
}

export function RouteList({
  filteredRoutes, selectedRoute, searchQuery, onSearchChange,
  showFilters, filter, setFilter, setShowFilters, getMonthOptions,
  onSelectRoute, onDeleteRoute, onDownloadRoute, onEditRoute,
  fileInputRef, onFileUpload, wishlist, favorites, onToggleFavorite,
}: RouteListProps) {
  const hasActiveFilters = !!(filter.month || filter.type || filter.list);

  return (
    <div>
      {/* Header: title left, filter button right */}
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-extrabold text-primary font-headline">
          All Routes
          <span className="ml-2 text-xs font-medium text-on-surface-variant">({filteredRoutes.length})</span>
        </h3>
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-colors border ${
            showFilters || hasActiveFilters
              ? "bg-primary-container border-primary-container text-on-primary-container"
              : "bg-surface-container border-outline-variant text-on-surface-variant hover:border-outline"
          }`}
        >
          <Icon name="tune" className="text-xs" />Filters
        </button>
      </div>

      {/* Search */}
      <div className="relative mb-3">
        <Icon name="search" className="absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-sm" />
        <input
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          className="w-full pl-10 pr-4 py-2 bg-surface-container border border-outline-variant rounded-full text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
          placeholder="Search routes..."
        />
      </div>

      {/* Filter bar: wishlist/favorites pills + type/month filters */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {/* List filter: All / Favorites / Wishlist */}
        {wishlist.length > 0 || favorites.length > 0 ? (
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-container rounded-full border border-outline-variant">
            <button
              onClick={() => setFilter({ ...filter, list: "all" })}
              className={`px-2 py-0.5 rounded-full text-xs font-medium transition-colors ${
                !filter.list || filter.list === "all"
                  ? "bg-primary-container text-on-primary-container"
                  : "text-on-surface-variant hover:text-on-surface"
              }`}
            >All</button>
            {favorites.length > 0 && (
              <button
                onClick={() => setFilter({ ...filter, list: filter.list === "favorites" ? "all" : "favorites" })}
                className={`px-2 py-0.5 rounded-full text-xs font-medium transition-colors flex items-center gap-1 ${
                  filter.list === "favorites"
                    ? "bg-yellow-100 text-yellow-700"
                    : "text-on-surface-variant hover:text-yellow-500"
                }`}
              >⭐ <span className="hidden sm:inline">Favorites</span><span className="sm:hidden">{favorites.length}</span></button>
            )}
            {wishlist.length > 0 && (
              <button
                onClick={() => setFilter({ ...filter, list: filter.list === "wishlist" ? "all" : "wishlist" })}
                className={`px-2 py-0.5 rounded-full text-xs font-medium transition-colors flex items-center gap-1 ${
                  filter.list === "wishlist"
                    ? "bg-primary-container text-on-primary-container"
                    : "text-on-surface-variant hover:text-primary"
                }`}
              ><Icon name="bookmark" className="text-xs" /><span className="hidden sm:inline">Wishlist</span><span className="sm:hidden">{wishlist.length}</span></button>
            )}
          </div>
        ) : null}
        {(filter.month || filter.type || filter.list) && (
          <button
            onClick={() => setFilter({})}
            className="text-xs text-error font-medium hover:underline"
          >
            Clear all
          </button>
        )}
      </div>

      {/* Filter panel */}
      {showFilters && (
        <div className="bg-surface-container-lowest border border-outline-variant/30 rounded-2xl p-3 mb-3 flex flex-wrap items-center gap-2 animate-fade-in">
          <select
            value={filter.month || ""}
            onChange={(e) => setFilter({ ...filter, month: e.target.value || undefined })}
            className="px-3 py-1.5 bg-surface-container border border-outline-variant rounded-xl text-xs text-on-surface focus:outline-none"
          >
            <option value="">All months</option>
            {getMonthOptions().map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <select
            value={filter.type || "all"}
            onChange={(e) => setFilter({ ...filter, type: e.target.value === "all" ? undefined : e.target.value })}
            className="px-3 py-1.5 bg-surface-container border border-outline-variant rounded-xl text-xs text-on-surface focus:outline-none"
          >
            <option value="all">All types</option>
            <option value="road">Road</option>
            <option value="trail">Trail</option>
            <option value="mixed">Mixed</option>
          </select>
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
              isFavorite={favorites.includes(route.id)}
              onSelect={() => onSelectRoute(selectedRoute?.id === route.id ? null : route)}
              onDelete={() => onDeleteRoute(route.id)}
              onDownload={() => onDownloadRoute(route)}
              onEdit={() => onEditRoute(route)}
              onToggleFavorite={() => onToggleFavorite(route.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
