"use client";

import { useState, useRef, useMemo, useEffect, useCallback } from "react";
import { useAuth, logout } from "@/lib/auth";
import { downloadGPXFile } from "@/lib/utils";
import { useGPXRoutes, useRouteSuggestions, useUserProfile, useRouteTemplate } from "@/lib/hooks";
import type { ZoneEditAction } from "@/types";
import { Icon, LoginScreen } from "@/components/ui";
import { Sidebar, MobileDrawer } from "@/components/Sidebar";
import { MapSection } from "@/components/MapSection";
import type { GPXRoute } from "../types";
import type { NoGoZone } from "@/types";

const ZONE_COLORS = [
  "#ef4444", // red
  "#f97316", // orange
  "#eab308", // yellow
  "#22c55e", // green
  "#3b82f6", // blue
  "#8b5cf6", // violet
];

function randomZoneColor() {
  return ZONE_COLORS[Math.floor(Math.random() * ZONE_COLORS.length)];
}

export default function SuggestPage() {
  const { user, loading: authLoading } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState("");
  const [authSuccess, setAuthSuccess] = useState("");
  const [isRegistering, setIsRegistering] = useState(false);
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [username, setUsername] = useState("");

  const { routes, uploadFiles, loading: isUploading } = useGPXRoutes(user?.uid ?? null);

  const [showDrawer, setShowDrawer] = useState(false);
  const [selectedStartPoint, setSelectedStartPoint] = useState<[number, number] | null>(null);
  const [isSelectingStartPoint, setIsSelectingStartPoint] = useState(false);
  const [suggestDistance, setSuggestDistance] = useState(5);
  const [preferQuiet, setPreferQuiet] = useState(true);
  const [preferGreen, setPreferGreen] = useState(false);
  const [elevationPreference, setElevationPreference] = useState<"any" | "hilly" | "flat">("any");
  const [generationCount, setGenerationCount] = useState(0);
  const [showHeatmap, setShowHeatmap] = useState(true);

  // ── No-go zones state ───────────────────────────────────────────────────
  const [zonesExpanded, setZonesExpanded] = useState(false);
  const [zonesEnabled, setZonesEnabled] = useState(true);
  const [isDrawingZone, setIsDrawingZone] = useState(false);
  const [drawingPolygon, setDrawingPolygon] = useState<[number, number][]>([]);
  const [newZoneName, setNewZoneName] = useState("");
  const [newZoneColor, setNewZoneColor] = useState(randomZoneColor());

  // ── Zone editing state ─────────────────────────────────────────────────────
  const [editingZoneId, setEditingZoneId] = useState<string | null>(null);
  // Per-zone undo stacks keyed by zone id
  const [undoStacks, setUndoStacks] = useState<Record<string, ZoneEditAction[]>>({});
  // Live preview zones while editing
  const [previewZones, setPreviewZones] = useState<NoGoZone[] | null>(null);

  const { template, loading: templateLoading, saving, error, saveZones, deleteZone } = useRouteTemplate(user?.uid ?? null);
  const [zoneError, setZoneError] = useState<string | null>(null);

  // Preview zones are used when editing; fall back to saved zones
  const zones: NoGoZone[] = previewZones ?? template?.zones ?? [];

  const stats = useMemo(() => {
    if (!routes.length) return null;
    const totalDistance = routes.reduce((s, r) => s + (r.distance || 0), 0) / 1000;
    const totalElevation = routes.reduce((s, r) => s + (r.elevationGain || 0), 0);
    return { totalRuns: routes.length, totalDistance: Math.round(totalDistance * 10) / 10, totalElevation: Math.round(totalElevation) };
  }, [routes]);

  const { suggestedRoute, isSuggesting, suggestionError, getSuggestion, clearSuggestion } =
    useRouteSuggestions(suggestDistance, false);

  useEffect(() => {
    setGenerationCount(0);
  }, [selectedStartPoint, suggestDistance, preferQuiet, preferGreen, elevationPreference]);

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(""); setAuthSuccess("");
    if (showForgotPassword) {
      const { resetPassword: rp } = await import("@/lib/auth");
      try { await rp(email); setAuthSuccess("✓ Check your email"); setShowForgotPassword(false); }
      catch (err: any) { setAuthError(err.message || "Failed"); }
      return;
    }
    try {
      const { login: lg, register: reg } = await import("@/lib/auth");
      if (isRegistering) {
        await reg(email, password);
        await saveProfile({ username: username.trim(), displayName: username.trim() });
      } else {
        await lg(email, password);
      }
    } catch (err: any) { setAuthError(err.message || "Authentication failed"); }
  };

  const handleLogout = async () => { await logout(); };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    await uploadFiles(files, routes);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleRouteUpload = async (gpxFiles: File[], tcxFiles: File[]) => {
    if (!gpxFiles.length) return;
    if (tcxFiles.length > 0) {
      console.info("[route upload] TCX files selected for future metrics import", tcxFiles.map((file) => file.name));
    }
    await uploadFiles(gpxFiles, routes, tcxFiles);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleMapClick = (lat: number, lon: number) => {
    if (isSelectingStartPoint) { setSelectedStartPoint([lon, lat]); setIsSelectingStartPoint(false); return; }
    if (isDrawingZone) {
      setDrawingPolygon((prev) => [...prev, [lon, lat]]);
    }
  };

  // Double-click on map while drawing → close polygon and save zone
  const handleZoneDrawDblClick = useCallback((lat: number, lon: number) => {
    if (!isDrawingZone || drawingPolygon.length < 3) return;
    // Close the polygon
    const closed: [number, number][] = [...drawingPolygon];
    const newZone: NoGoZone = {
      id: `zone-${Date.now()}`,
      name: newZoneName.trim() || `Zone ${zones.length + 1}`,
      polygon: closed,
      color: newZoneColor,
      createdAt: new Date().toISOString(),
    };
    saveZones([...zones, newZone]);
    setDrawingPolygon([]);
    setIsDrawingZone(false);
    setNewZoneName("");
    setNewZoneColor(randomZoneColor());
  }, [isDrawingZone, drawingPolygon, newZoneName, newZoneColor, zones, saveZones]);

  const handleGenerate = () => {
    const directionShift = generationCount % 4;
    setGenerationCount((count) => count + 1);
    getSuggestion(selectedStartPoint, routes, {
      preferQuiet,
      preferGreen,
      elevationPreference,
      directionShift,
      noGoZones: zonesEnabled ? zones : [],
    });
  };

  const startDrawing = () => {
    if (!newZoneName.trim()) {
      setNewZoneName(`Zone ${zones.length + 1}`);
    }
    setIsDrawingZone(true);
    setDrawingPolygon([]);
  };

  const cancelDrawing = () => {
    setIsDrawingZone(false);
    setDrawingPolygon([]);
    setNewZoneName("");
    setNewZoneColor(randomZoneColor());
  };

  const removeZone = async (zoneId: string) => {
    await saveZones(zones.filter((z) => z.id !== zoneId));
  };

  // ── Zone edit handlers ─────────────────────────────────────────────────────
  const startEditZone = (zoneId: string) => {
    setEditingZoneId(zoneId);
    setUndoStacks({});
    const zone = (template?.zones ?? []).find((z) => z.id === zoneId);
    if (zone) setPreviewZones([...template!.zones!]);
  };

  const stopEditing = async (save: boolean) => {
    if (!editingZoneId) return;
    if (save && previewZones) {
      await saveZones(previewZones);
    }
    setEditingZoneId(null);
    setUndoStacks({});
    setPreviewZones(null);
  };

  const handleZonePointMove = (zoneId: string, pointIndex: number, newPos: [number, number]) => {
    setPreviewZones((prev) => {
      if (!prev) return prev;
      return prev.map((z) =>
        z.id === zoneId
          ? { ...z, polygon: z.polygon.map((p, i) => (i === pointIndex ? newPos : p)) }
          : z
      );
    });
    setUndoStacks((prev) => ({
      ...prev,
      [zoneId]: [
        ...(prev[zoneId] ?? []),
        {
          type: "move_point",
          pointIndex,
          oldPos: (previewZones ?? []).find((z) => z.id === zoneId)?.polygon[pointIndex] ?? newPos,
          newPos,
        },
      ],
    }));
  };

  const handleZonePointDelete = (zoneId: string, pointIndex: number) => {
    setPreviewZones((prev) => {
      if (!prev) return prev;
      return prev
        .map((z) =>
          z.id === zoneId ? { ...z, polygon: z.polygon.filter((_, i) => i !== pointIndex) } : z
        )
        .filter((z) => z.polygon.length >= 3 || true);
    });
    setUndoStacks((prev) => {
      const zone = (previewZones ?? []).find((z) => z.id === zoneId);
      return {
        ...prev,
        [zoneId]: [
          ...(prev[zoneId] ?? []),
          { type: "remove_point", pointIndex, point: zone?.polygon[pointIndex] ?? [0, 0] },
        ],
      };
    });
  };

  const handleZoneEditAddPoint = (zoneId: string, lat: number, lon: number) => {
    setPreviewZones((prev) => {
      if (!prev) return prev;
      // Add point at end of polygon
      return prev.map((z) =>
        z.id === zoneId ? { ...z, polygon: [...z.polygon, [lon, lat]] } : z
      );
    });
    setUndoStacks((prev) => ({
      ...prev,
      [zoneId]: [
        ...(prev[zoneId] ?? []),
        { type: "add_point", pointIndex: ((previewZones ?? []).find((z) => z.id === zoneId)?.polygon.length ?? 0), point: [lon, lat] },
      ],
    }));
  };

  // Ctrl+Z undo for zone editing
  useEffect(() => {
    if (!editingZoneId) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "z") {
        e.preventDefault();
        const stack = undoStacks[editingZoneId] ?? [];
        if (!stack.length) return;
        const last = stack[stack.length - 1];
        setPreviewZones((prev) => {
          if (!prev) return prev;
          return prev.map((z) => {
            if (z.id !== editingZoneId) return z;
            if (last.type === "move_point") {
              return { ...z, polygon: z.polygon.map((p, i) => (i === last.pointIndex ? last.oldPos : p)) };
            }
            if (last.type === "remove_point") {
              const copy = [...z.polygon];
              copy.splice(last.pointIndex, 0, last.point);
              return { ...z, polygon: copy };
            }
            if (last.type === "add_point") {
              return { ...z, polygon: z.polygon.slice(0, -1) };
            }
            return z;
          });
        });
        setUndoStacks((prev) => ({ ...prev, [editingZoneId]: stack.slice(0, -1) }));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [editingZoneId, undoStacks]);

  const { profile, loading, saveProfile } = useUserProfile(user?.uid ?? null);


  if (authLoading) {
    return <div className="min-h-screen bg-background flex items-center justify-center"><div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin" /></div>;
  }

  if (!user) {
    return <LoginScreen email={email} setEmail={setEmail} password={password} setPassword={setPassword}
      authError={authError} authSuccess={authSuccess} isRegistering={isRegistering} setIsRegistering={setIsRegistering}
      showForgotPassword={showForgotPassword} setShowForgotPassword={setShowForgotPassword}
      username={username} setUsername={setUsername} handleAuth={handleAuth} setAuthError={setAuthError} />;
  }

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
        <Sidebar user={user} profile={profile} profileLoading={loading} onLogout={handleLogout}
          fileInputRef={fileInputRef} onFileUpload={handleFileUpload} onRouteUpload={handleRouteUpload} />

        <div className="flex-1 flex flex-col md:flex-row overflow-hidden">
          {/* Left panel: controls + generated route */}
          <div className="flex-1 overflow-y-auto px-4 pt-5 pb-4 md:p-6 md:pt-4 space-y-5 custom-scrollbar">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-2xl bg-primary-container flex items-center justify-center shrink-0">
                <Icon name="explore" filled className="text-on-primary-container text-xl" />
              </div>
              <div>
                <h2 className="text-xl font-extrabold text-on-surface">Route Suggestions</h2>
                <p className="text-xs text-on-surface-variant">Generate a loop from your running history</p>
              </div>
            </div>

            {stats && (
              <div className="grid grid-cols-3 gap-2">
                {[
                  { label: "Runs", value: stats.totalRuns, icon: "directions_run" },
                  { label: "Distance", value: `${stats.totalDistance} km`, icon: "route" },
                  { label: "Elevation", value: `${stats.totalElevation} m`, icon: "terrain" },
                ].map(({ label, value, icon }) => (
                  <div key={label} className="bg-surface-container rounded-xl px-3 py-2.5 text-center">
                    <div className="flex justify-center mb-1">
                      <span className="material-symbols-outlined text-on-surface-variant text-sm">{icon}</span>
                    </div>
                    <p className="text-xs font-bold text-on-surface">{value}</p>
                    <p className="text-[9px] text-on-surface-variant uppercase tracking-wider">{label}</p>
                  </div>
                ))}
              </div>
            )}

            {/* ── No-go zones panel ── */}
            <div className="bg-surface-container border border-outline-variant/20 rounded-2xl overflow-hidden">
              {/* Panel header — always visible */}
              <button
                onClick={() => setZonesExpanded((v) => !v)}
                className="w-full flex items-center justify-between px-4 py-3 hover:bg-surface-container-high transition-colors"
              >
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-lg bg-secondary/20 flex items-center justify-center">
                    <Icon name="do_not_disturb_on" className="text-secondary text-base" />
                  </div>
                  <div className="text-left">
                    <p className="text-xs font-bold text-on-surface">No-Go Zones</p>
                    <p className="text-[10px] text-on-surface-variant">
                      {zones.length === 0 ? "No zones — all routes allowed" : `${zones.length} zone${zones.length !== 1 ? "s" : ""} defined`}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {/* Enable/disable toggle */}
                  {zones.length > 0 && (
                    <button
                      onClick={(e) => { e.stopPropagation(); setZonesEnabled((v) => !v); }}
                      className={`relative w-9 h-5 rounded-full transition-colors ${zonesEnabled ? "bg-secondary" : "bg-surface-container-high"}`}
                      aria-label={zonesEnabled ? "Disable zones" : "Enable zones"}
                    >
                      <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${zonesEnabled ? "translate-x-4" : ""}`} />
                    </button>
                  )}
                  <Icon name={zonesExpanded ? "expand_less" : "expand_more"} className="text-on-surface-variant text-xl" />
                </div>
              </button>

              {/* Expanded zone editor */}
              {zonesExpanded && (
                <div className="px-4 pb-4 space-y-3 border-t border-outline-variant/20">
                  {/* Zone save error */}
                  {(zoneError ?? error) && !saving && (
                    <div className="flex items-center gap-2 px-3 py-2 bg-error-container/50 border border-error/20 rounded-xl">
                      <Icon name="error" className="text-error text-sm shrink-0" />
                      <span className="text-xs text-error">{zoneError ?? error}</span>
                      <button onClick={() => setZoneError(null)} className="ml-auto text-error/60 hover:text-error text-xs">✕</button>
                    </div>
                  )}
                  {/* Loading zones */}
                  {templateLoading ? (
                    <div className="flex items-center justify-center py-6 gap-2">
                      <div className="w-4 h-4 border-2 border-secondary border-t-transparent rounded-full animate-spin" />
                      <span className="text-xs text-on-surface-variant">Loading zones…</span>
                    </div>
                  ) : (
                    <>{/* Existing zones list */}
                    {zones.length > 0 && (
                    <div className="space-y-2 mt-3">
                      {zones.map((zone) => (
                        <div key={zone.id} className={`flex items-center gap-2 px-3 py-2 bg-surface-container-high rounded-xl ${editingZoneId === zone.id ? 'ring-2 ring-secondary' : ''}`}>
                          <div className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: zone.color }} />
                          <span className="flex-1 text-xs font-medium text-on-surface truncate">{zone.name}</span>
                          <span className="text-[10px] text-on-surface-variant">{zone.polygon.length} pts</span>
                          {editingZoneId === zone.id ? (
                            <>
                              <span className="text-[10px] text-secondary font-bold">Editing…</span>
                              <button
                                onClick={() => stopEditing(true)}
                                className="p-1 hover:bg-surface-container-low rounded-lg transition-colors text-green-500"
                                title="Save & exit edit"
                              >
                                <Icon name="check" className="text-sm" />
                              </button>
                              <button
                                onClick={() => stopEditing(false)}
                                className="p-1 hover:bg-surface-container-low rounded-lg transition-colors text-on-surface-variant"
                                title="Discard changes"
                              >
                                <Icon name="close" className="text-sm" />
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                onClick={() => startEditZone(zone.id)}
                                className="p-1 hover:bg-surface-container-low rounded-lg transition-colors"
                                title="Edit zone"
                              >
                                <Icon name="edit" className="text-on-surface-variant text-sm" />
                              </button>
                              <button
                                onClick={() => removeZone(zone.id)}
                                className="p-1 hover:bg-surface-container-low rounded-lg transition-colors"
                                title="Remove zone"
                              >
                                <Icon name="delete" className="text-on-surface-variant text-sm" />
                              </button>
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {zones.length === 0 && (
                    <p className="text-xs text-on-surface-variant mt-2">No zones yet — draw one below</p>
                  )}
                  </>
                  )}

                  {/* Drawing controls */}
                  {!isDrawingZone ? (
                    <div className="space-y-2 mt-3">
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={newZoneName}
                          onChange={(e) => setNewZoneName(e.target.value)}
                          placeholder={`Zone ${zones.length + 1}`}
                          className="flex-1 px-3 py-1.5 bg-surface-container-high rounded-xl text-xs text-on-surface placeholder:text-on-surface-variant outline-none focus:ring-1 focus:ring-secondary"
                          onKeyDown={(e) => { if (e.key === "Enter") startDrawing(); }}
                        />
                        {/* Color picker */}
                        <div className="flex items-center gap-1 px-2 py-1.5 bg-surface-container-high rounded-xl">
                          {ZONE_COLORS.map((c) => (
                            <button
                              key={c}
                              onClick={() => setNewZoneColor(c)}
                              className={`w-4 h-4 rounded-full transition-transform ${newZoneColor === c ? "scale-125 ring-2 ring-offset-1 ring-on-surface" : "opacity-60 hover:opacity-100"}`}
                              style={{ backgroundColor: c }}
                            />
                          ))}
                        </div>
                      </div>
                      <button
                        onClick={startDrawing}
                        disabled={saving}
                        className="w-full py-2 bg-secondary/20 hover:bg-secondary/30 text-secondary rounded-xl text-xs font-bold transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50"
                      >
                        <Icon name="edit_square" className="text-sm" />
                        {saving ? "Saving…" : "Draw New Zone on Map"}
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-2 mt-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <div className="w-3 h-3 rounded-full" style={{ backgroundColor: newZoneColor }} />
                          <span className="text-xs font-bold text-secondary">{newZoneName || `Zone ${zones.length + 1}`}</span>
                        </div>
                        <button
                          onClick={cancelDrawing}
                          className="px-3 py-1.5 bg-surface-container-high hover:bg-surface-container-low rounded-xl text-xs font-medium text-on-surface-variant transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                      <p className="text-xs text-on-surface-variant">
                        {drawingPolygon.length < 3
                          ? `Tap map to add points (${drawingPolygon.length}/3 min needed)…`
                          : `Double-click map to close polygon (${drawingPolygon.length} points)`}
                      </p>
                      {drawingPolygon.length >= 3 && (
                        <button
                          onClick={() => handleZoneDrawDblClick(0, 0)}
                          disabled={saving}
                          className="w-full py-2 bg-secondary text-on-secondary rounded-xl text-xs font-bold transition-colors flex items-center justify-center gap-1.5 disabled:opacity-50"
                        >
                          <Icon name="check" className="text-sm" />
                          {saving ? "Saving…" : "Close Polygon & Save Zone"}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Route controls — Distance */}
              <div className="px-4 pt-4 pb-4 space-y-4">
                {/* Distance */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-on-surface-variant">Distance</span>
                    <span className="text-xs font-bold text-primary">{suggestDistance} km</span>
                  </div>
                  <input type="range" min={1} max={30} step={0.5} value={suggestDistance}
                    onChange={e => setSuggestDistance(parseFloat(e.target.value))} className="w-full accent-primary" />
                </div>

                {/* Route preferences */}
                <div className="space-y-3">
                  <div>
                    <span className="text-xs font-medium text-on-surface-variant">Elevation</span>
                    <div className="mt-1.5 grid grid-cols-3 gap-1 rounded-xl bg-surface-container-high p-1">
                      {[
                        { value: "any", label: "Any" },
                        { value: "hilly", label: "Hilly" },
                        { value: "flat", label: "Flat" },
                      ].map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => setElevationPreference(option.value as typeof elevationPreference)}
                          className={`py-1.5 rounded-lg text-xs font-bold transition-colors ${
                            elevationPreference === option.value
                              ? "bg-secondary text-on-secondary"
                              : "text-on-surface-variant hover:bg-surface-container"
                          }`}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <label className="flex items-center justify-between gap-3 px-3 py-2 bg-surface-container-high rounded-xl">
                      <span className="text-xs font-medium text-on-surface">Prefer quiet roads</span>
                      <input type="checkbox" checked={preferQuiet} onChange={(e) => setPreferQuiet(e.target.checked)} className="accent-primary" />
                    </label>
                    <label className="flex items-center justify-between gap-3 px-3 py-2 bg-surface-container-high rounded-xl">
                      <span className="text-xs font-medium text-on-surface">Prefer green areas</span>
                      <input type="checkbox" checked={preferGreen} onChange={(e) => setPreferGreen(e.target.checked)} className="accent-primary" />
                    </label>
                  </div>
                </div>

                {/* Start point */}
                <div>
                  <div className="mb-1.5">
                    <span className="text-xs font-medium text-on-surface-variant">Start Point</span>
                  </div>
                  {selectedStartPoint ? (
                    <div className="flex items-center gap-2">
                      <div className="flex-1 px-3 py-1.5 bg-surface-container-high rounded-xl text-xs text-on-surface font-mono">
                        {selectedStartPoint[1].toFixed(4)}, {selectedStartPoint[0].toFixed(4)}
                      </div>
                      <button onClick={() => { setSelectedStartPoint(null); setIsSelectingStartPoint(true); }}
                        className="px-3 py-1.5 bg-surface-container-high hover:bg-surface-container-low rounded-xl text-xs font-medium text-on-surface-variant transition-colors">Change</button>
                    </div>
                  ) : (
                    <button onClick={() => setIsSelectingStartPoint(true)}
                      className="w-full py-2 bg-primary-container text-on-primary-container rounded-xl text-xs font-bold hover:opacity-90 transition-opacity">📍 Pick on Map</button>
                  )}
                  {isSelectingStartPoint && (
                    <p className="mt-1.5 text-xs text-primary font-medium animate-pulse">↖ Tap anywhere on the map to set the start point</p>
                  )}
                </div>

                {/* Generate */}
                <button onClick={handleGenerate} disabled={isSuggesting}
                  className="w-full py-2.5 bg-primary text-on-primary rounded-xl text-sm font-bold hover:opacity-90 disabled:opacity-50 transition-opacity flex items-center justify-center gap-2">
                  {isSuggesting
                    ? <><Icon name="progress_activity" className="text-sm animate-spin" /> Generating&hellip;</>
                    : <><Icon name="sprint" className="text-sm" /> Generate Route</>}
                </button>
              </div>

              {/* Route generation error */}
              {suggestionError && (
                <div className="mx-4 mb-4 bg-error-container/40 border border-error/20 rounded-2xl p-4 animate-fade-in">
                  <div className="flex items-center gap-2 mb-1">
                    <Icon name="error" className="text-error text-base" />
                    <span className="text-[10px] font-extrabold uppercase tracking-wider text-error">No runnable route found</span>
                  </div>
                  <p className="text-xs text-on-surface-variant">
                    {suggestionError}
                  </p>
                </div>
              )}

              {/* Generated result */}
              {suggestedRoute && (
                <div className="mx-4 mb-4 bg-primary-container/10 border border-primary-container/30 rounded-2xl p-4 animate-fade-in">
                  <div className="flex items-center gap-2 mb-2">
                    <Icon name="check_circle" filled className="text-secondary text-base" />
                    <span className="text-[10px] font-extrabold uppercase tracking-wider text-secondary">Generated Route</span>
                  </div>
                  <h4 className="text-base font-extrabold text-primary">{suggestedRoute.name}</h4>
                  <p className="text-xs text-on-surface-variant mt-0.5">
                    {(suggestedRoute.distance / 1000).toFixed(1)} km
                    {` · +${Math.round(suggestedRoute.elevationGain || 0)}m estimated climb`}
                  </p>
                  <div className="mt-3 flex items-center gap-2">
                    <button onClick={handleGenerate} disabled={isSuggesting}
                      className="flex-1 py-2 bg-primary-container hover:bg-primary-container/70 text-on-primary-container rounded-xl text-xs font-bold transition-colors flex items-center justify-center gap-1.5">
                      <Icon name="refresh" className="text-sm" /> Regenerate
                    </button>
                    <button onClick={() => downloadGPXFile(suggestedRoute)}
                      className="py-2 px-3 bg-surface-container hover:bg-surface-container-high text-on-surface-variant rounded-xl transition-colors">
                      <Icon name="download" className="text-sm" />
                    </button>
                    <button onClick={clearSuggestion}
                      className="py-2 px-3 bg-surface-container hover:bg-surface-container-high text-on-surface-variant rounded-xl transition-colors">
                      <Icon name="close" className="text-sm" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Right panel: map */}
          <div className="w-full md:w-1/2 md:shrink-0 order-1 md:order-none relative">
            <div className="h-52 sm:h-64 md:h-full p-4 md:pr-6 md:pt-6 md:pb-4">
              <MapSection
                routes={routes}
                selectedRoute={suggestedRoute}
                suggestedRoute={suggestedRoute}
                showHeatmap={showHeatmap}
                showPersonalHeatmap={false}
                onToggleHeatmap={() => setShowHeatmap(!showHeatmap)}
                onTogglePersonalHeatmap={() => {}}
                isLoading={isUploading}
                selectedStartPoint={selectedStartPoint}
                isSelectingStartPoint={isSelectingStartPoint}
                onMapClick={handleMapClick}
                noGoZones={zonesEnabled ? zones : []}
                drawingPolygon={drawingPolygon}
                onZoneDrawClick={(lat, lon) => {
                  if (isDrawingZone) {
                    setDrawingPolygon((prev) => [...prev, [lon, lat]]);
                  }
                }}
                isDrawingZone={isDrawingZone}
                editingZoneId={editingZoneId}
                onZonePointMove={handleZonePointMove}
                onZonePointDelete={handleZonePointDelete}
                onZoneEditAddPoint={handleZoneEditAddPoint}
              />
            </div>
            {/* Mobile map controls */}
            <div className="flex md:hidden items-center justify-between px-4 pt-3 pb-1">
              <div className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: "rgb(255 65 164)" }} />
                <span className="text-[9px] text-on-surface-variant">Suggestion</span>
              </div>
              <button
                onClick={() => setShowHeatmap(!showHeatmap)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold transition-colors ${showHeatmap ? "bg-secondary text-on-secondary" : "bg-surface-container-high text-on-surface-variant"}`}
              >
                <Icon name="layers" className="text-[10px] inline mr-0.5" />
                {showHeatmap ? "Hide" : "Show"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Mobile drawer */}
      <MobileDrawer
        isOpen={showDrawer}
        onClose={() => setShowDrawer(false)}
        user={user}
        profile={profile}
        profileLoading={loading}
        onLogout={handleLogout}
        fileInputRef={fileInputRef}
        onFileUpload={handleFileUpload}
        onRouteUpload={handleRouteUpload}
      />
    </div>
  );
}
