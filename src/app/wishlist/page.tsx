"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { useGPXRoutes, useWishlist, useFavorites } from "@/lib/hooks";
import { downloadGPXFile } from "@/lib/utils";
import { Icon } from "@/components/ui";
import { RouteList } from "@/components/RouteList";
import { GPXRoute } from "@/app/types";

export default function WishlistPage() {
  const { user, loading: authLoading } = useAuth();
  const { routes, deleteRoute, updateRoute } = useGPXRoutes(user?.uid ?? null);
  const { wishlist, toggleWishlist } = useWishlist(user?.uid ?? null);
  const { favorites, toggleFavorite } = useFavorites(user?.uid ?? null);

  const [selectedRoute, setSelectedRoute] = useState<GPXRoute | null>(null);
  const [editingRoute, setEditingRoute] = useState<GPXRoute | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [filter, setFilter] = useState<{ month?: string; type?: string; list?: "all" | "favorites" | "wishlist" }>({});

  if (authLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-on-surface-variant text-sm">Loading&hellip;</div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center flex-col gap-4">
        <div className="text-on-surface-variant">Please sign in to view your wishlist.</div>
        <Link href="/" className="text-primary font-bold hover:underline">← Back to home</Link>
      </div>
    );
  }

  const wishlistedRoutes = routes.filter(r => wishlist.includes(r.id));

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="h-14 bg-surface-container-lowest border-b border-outline-variant/10 flex items-center justify-between px-4 md:px-8 shrink-0">
        <div className="flex items-center gap-3">
          <Link href="/" className="flex items-center gap-2 text-on-surface-variant hover:text-primary transition-colors">
            <Icon name="arrow_back" className="text-xl" />
            <span className="text-sm font-medium hidden sm:inline">Back</span>
          </Link>
          <div className="w-px h-5 bg-outline-variant mx-1" />
          <div className="flex items-center gap-2">
            <Icon name="bookmark" filled className="text-primary text-lg" />
            <span className="text-sm font-extrabold text-primary font-headline">Wishlist</span>
            <span className="text-xs font-medium text-on-surface-variant">({wishlistedRoutes.length})</span>
          </div>
        </div>
      </header>

      {/* Routes list */}
      <main className="max-w-2xl mx-auto p-4 md:p-6">
        {wishlistedRoutes.length === 0 ? (
          <div className="text-center py-16">
            <div className="w-16 h-16 rounded-2xl bg-surface-container flex items-center justify-center mx-auto mb-4">
              <Icon name="bookmark_add" className="text-on-surface-variant text-2xl" />
            </div>
            <h3 className="text-lg font-extrabold text-on-surface mb-2">Your wishlist is empty</h3>
            <p className="text-sm text-on-surface-variant mb-6">
              Tap the bookmark icon on any route to save it here for later.
            </p>
            <Link
              href="/"
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-primary text-on-primary rounded-xl text-sm font-bold hover:opacity-90 transition-opacity"
            >
              <Icon name="route" className="text-sm" />
              Browse Routes
            </Link>
          </div>
        ) : (
          <RouteList
            filteredRoutes={wishlistedRoutes}
            selectedRoute={selectedRoute}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            showFilters={showFilters}
            filter={filter}
            setFilter={setFilter}
            setShowFilters={setShowFilters}
            getMonthOptions={() => Array.from(new Set(wishlistedRoutes.map(r => r.date.substring(0, 7)))).sort().reverse()}
            onSelectRoute={setSelectedRoute}
            onDeleteRoute={(id) => { deleteRoute(id, routes); }}
            onDownloadRoute={downloadGPXFile}
            onEditRoute={setEditingRoute}
            fileInputRef={{ current: null } as React.RefObject<HTMLInputElement>}
            onFileUpload={() => {}}
            wishlist={wishlist}
            favorites={favorites}
            onToggleWishlist={(routeId) => toggleWishlist(routeId)}
            onToggleFavorite={(routeId) => toggleFavorite(routeId)}
          />
        )}
      </main>
    </div>
  );
}
