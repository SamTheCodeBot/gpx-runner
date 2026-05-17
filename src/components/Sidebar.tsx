"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Icon } from "./ui";
import type { User } from "firebase/auth";
import type { UserProfile } from "@/app/types";

interface SidebarProps {
  user: User | null;
  profile: UserProfile | null;
  profileLoading?: boolean;
  onLogout: () => void;
  fileInputRef: React.RefObject<HTMLInputElement>;
  onFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRouteUpload?: (gpxFiles: File[], tcxFiles: File[]) => void;
}

function UploadRoutePrompt({
  onClose,
  onUpload,
}: {
  onClose: () => void;
  onUpload: (gpxFiles: File[], tcxFiles: File[]) => void;
}) {
  const [gpxFiles, setGpxFiles] = useState<File[]>([]);
  const [tcxFiles, setTcxFiles] = useState<File[]>([]);
  const [matchStatus, setMatchStatus] = useState<{ checking: boolean; ok: boolean; message: string }>({
    checking: false,
    ok: true,
    message: "TCX is optional. GPX-only uploads still work.",
  });

  type FileSignature = {
    name: string;
    startTime: number | null;
    startPoint: { lat: number; lon: number } | null;
  };

  const readSignature = useCallback(async (file: File, kind: "gpx" | "tcx"): Promise<FileSignature> => {
    const text = await file.text();
    const xml = new DOMParser().parseFromString(text, "application/xml");
    const parseTime = (value: string | null | undefined) => {
      if (!value) return null;
      const time = new Date(value).valueOf();
      return Number.isFinite(time) ? time : null;
    };

    if (kind === "gpx") {
      const point = xml.querySelector("trkpt");
      const time = parseTime(point?.querySelector("time")?.textContent || xml.querySelector("time")?.textContent);
      const lat = point ? Number(point.getAttribute("lat")) : NaN;
      const lon = point ? Number(point.getAttribute("lon")) : NaN;
      return {
        name: file.name,
        startTime: time,
        startPoint: Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null,
      };
    }

    const point = xml.querySelector("Trackpoint");
    const time = parseTime(point?.querySelector("Time")?.textContent);
    const lat = Number(point?.querySelector("LatitudeDegrees")?.textContent);
    const lon = Number(point?.querySelector("LongitudeDegrees")?.textContent);
    return {
      name: file.name,
      startTime: time,
      startPoint: Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null,
    };
  }, []);

  const distanceMeters = useCallback((a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
    const radius = 6371000;
    const lat1 = (a.lat * Math.PI) / 180;
    const lat2 = (b.lat * Math.PI) / 180;
    const dLat = lat2 - lat1;
    const dLon = ((b.lon - a.lon) * Math.PI) / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return radius * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  }, []);

  useEffect(() => {
    let cancelled = false;

    const validate = async () => {
      if (tcxFiles.length === 0) {
        setMatchStatus({ checking: false, ok: true, message: "TCX is optional. GPX-only uploads still work." });
        return;
      }
      if (gpxFiles.length === 0) {
        setMatchStatus({ checking: false, ok: false, message: "Choose a GPX route file before adding TCX metrics." });
        return;
      }
      if (gpxFiles.length !== tcxFiles.length) {
        setMatchStatus({ checking: false, ok: false, message: "For now, upload the same number of GPX and TCX files." });
        return;
      }

      setMatchStatus({ checking: true, ok: false, message: "Checking GPX and TCX match..." });
      try {
        const gpxSignatures = await Promise.all(gpxFiles.map((file) => readSignature(file, "gpx")));
        const tcxSignatures = await Promise.all(tcxFiles.map((file) => readSignature(file, "tcx")));
        const usedGpx = new Set<number>();

        for (const tcx of tcxSignatures) {
          const matchedIndex = gpxSignatures.findIndex((gpx, index) => {
            if (usedGpx.has(index)) return false;
            const timeOk =
              gpx.startTime !== null &&
              tcx.startTime !== null &&
              Math.abs(gpx.startTime - tcx.startTime) <= 15 * 60 * 1000;
            const pointOk =
              gpx.startPoint !== null &&
              tcx.startPoint !== null &&
              distanceMeters(gpx.startPoint, tcx.startPoint) <= 500;
            if (gpx.startTime !== null && tcx.startTime !== null && gpx.startPoint !== null && tcx.startPoint !== null) {
              return timeOk && pointOk;
            }
            return timeOk || pointOk;
          });

          if (matchedIndex === -1) {
            throw new Error('TCX file "' + tcx.name + '" does not match the selected GPX file.');
          }
          usedGpx.add(matchedIndex);
        }

        if (!cancelled) {
          setMatchStatus({ checking: false, ok: true, message: "GPX and TCX match." });
        }
      } catch (error) {
        if (!cancelled) {
          setMatchStatus({
            checking: false,
            ok: false,
            message: error instanceof Error ? error.message : "Could not verify that GPX and TCX match.",
          });
        }
      }
    };

    validate();
    return () => {
      cancelled = true;
    };
  }, [gpxFiles, tcxFiles, readSignature, distanceMeters]);

  const submit = () => {
    if (gpxFiles.length === 0 || !matchStatus.ok || matchStatus.checking) return;
    onUpload(gpxFiles, tcxFiles);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/35 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-surface-container-lowest rounded-3xl shadow-xl w-full max-w-md p-6 animate-fade-in">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h3 className="text-base font-extrabold text-primary font-headline">Upload route</h3>
            <p className="text-xs text-on-surface-variant mt-1">GPX is required. TCX adds pace and heart-rate data later.</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-surface-container transition-colors">
            <Icon name="close" className="text-on-surface-variant text-sm" />
          </button>
        </div>

        <div className="space-y-3">
          <label className="block rounded-2xl border border-outline-variant/50 bg-surface-container p-4 cursor-pointer hover:bg-surface-container-high transition-colors">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-primary-container flex items-center justify-center">
                <Icon name="route" className="text-primary text-lg" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-on-surface">GPX route file</p>
                <p className="text-xs text-on-surface-variant truncate">
                  {gpxFiles.length > 0 ? gpxFiles.map((file) => file.name).join(", ") : "Route geometry and elevation"}
                </p>
              </div>
              <span className="text-[10px] font-extrabold uppercase tracking-wider text-primary">Required</span>
            </div>
            <input
              type="file"
              accept=".gpx,application/gpx+xml"
              multiple
              onChange={(e) => setGpxFiles(Array.from(e.target.files || []))}
              className="hidden"
            />
          </label>

          <label className="block rounded-2xl border border-outline-variant/50 bg-surface-container p-4 cursor-pointer hover:bg-surface-container-high transition-colors">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-surface-container-high flex items-center justify-center">
                <Icon name="monitor_heart" className="text-on-surface-variant text-lg" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-on-surface">TCX metrics file</p>
                <p className="text-xs text-on-surface-variant truncate">
                  {tcxFiles.length > 0 ? tcxFiles.map((file) => file.name).join(", ") : "Optional pace and heart-rate data"}
                </p>
              </div>
              <span className="text-[10px] font-extrabold uppercase tracking-wider text-on-surface-variant">Optional</span>
            </div>
            <input
              type="file"
              accept=".tcx,application/vnd.garmin.tcx+xml,application/xml,text/xml"
              multiple
              onChange={(e) => setTcxFiles(Array.from(e.target.files || []))}
              className="hidden"
            />
          </label>
        </div>

        <div className={`mt-3 rounded-2xl px-3 py-2 text-xs ${
          matchStatus.ok
            ? "bg-primary-container/30 text-on-surface-variant"
            : "bg-error-container/40 text-error"
        }`}>
          {matchStatus.message}
        </div>

        <div className="flex gap-2 mt-5">
          <button onClick={onClose} className="flex-1 py-2.5 border border-outline-variant rounded-xl text-sm font-medium text-on-surface-variant hover:bg-surface-container transition-colors">
            Cancel
          </button>
          <button onClick={submit} disabled={gpxFiles.length === 0 || !matchStatus.ok || matchStatus.checking} className="flex-1 py-2.5 bg-primary text-on-primary rounded-xl text-sm font-bold hover:opacity-90 transition-opacity disabled:opacity-40">
            {matchStatus.checking ? "Checking..." : "Upload"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Sidebar({ user, profile, profileLoading, onLogout, fileInputRef, onFileUpload, onRouteUpload }: SidebarProps) {
  const pathname = usePathname();
  const [showUploadPrompt, setShowUploadPrompt] = useState(false);
  const isActive = (href: string) => href === "/" ? pathname === "/" : pathname.startsWith(href);
  const avatarIcon = profileLoading ? "directions_run" : (profile?.avatar || "directions_run");
  const displayName = profileLoading ? user?.email?.split("@")[0] || "Runner" : (profile?.displayName || user?.email?.split("@")[0]);

  return (
    <aside className="hidden md:flex w-64 h-full bg-primary text-on-primary flex-col shrink-0 overflow-hidden">
      {/* Logo area */}
      <div className="p-6">
        <div className="flex items-center gap-3 mb-1">
          <div className="w-9 h-9 rounded-xl bg-primary-container flex items-center justify-center shrink-0">
            <Icon name="sprint" filled className="text-on-primary-container text-xl" />
          </div>
          <h1 className="text-xl font-extrabold tracking-tight font-headline text-on-primary">GPX running</h1>
        </div>
        <p className="text-[10px] text-on-primary-container/80 font-medium">Every run, mapped out</p>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-2 space-y-0.5 overflow-y-auto">

        {/* Core nav */}
        <Link href="/" className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-colors ${isActive("/") ? "bg-primary-container text-on-primary" : "text-on-primary/80 hover:bg-primary-container/60"}`}>
          <Icon name="route" filled={isActive("/")} className="text-base" />
          <span className="font-semibold text-sm">My Routes</span>
        </Link>
        {/* Divider */}
        <div className="my-3 border-t border-white/10" />

        {/* Heatmap & badges — fun extras */}
        <span className="px-4 py-1 text-[10px] font-extrabold uppercase tracking-widest text-on-primary/50">Extras</span>

        <Link href="/heatmaps" className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-colors ${isActive("/heatmaps") ? "bg-primary-container text-on-primary" : "text-on-primary/80 hover:bg-primary-container/60"}`}>
          <Icon name="whatshot" filled={isActive("/heatmaps")} className="text-base" />
          <div>
            <span className="font-semibold text-sm">Personal Heatmaps</span>
            <span className="block text-[10px] text-on-primary/50">Route layers</span>
          </div>
        </Link>

        <a className="flex items-center gap-3 px-4 py-3 rounded-xl text-on-primary/80 hover:bg-primary-container/60 transition-colors" href="/badges">
          <Icon name="emoji_events" className="text-base" />
          <div>
            <span className="font-semibold text-sm">Badges</span>
            <span className="block text-[10px] text-on-primary/50">Collect achievements</span>
          </div>
        </a>

      </nav>

      {/* Upload route button */}
      <div className="px-4 mb-2">
        <button
          type="button"
          onClick={() => onRouteUpload ? setShowUploadPrompt(true) : fileInputRef.current?.click()}
          className="w-full bg-primary-container text-on-primary py-3 rounded-xl font-bold text-xs flex items-center justify-center gap-2 hover:opacity-90 active:scale-[0.98] transition-all cursor-pointer"
        >
          <Icon name="add" className="text-sm" />
          Upload route
        </button>
        <input ref={fileInputRef} type="file" accept=".gpx" multiple onChange={onFileUpload} className="hidden" />
      </div>

      {/* User section */}
      <div className="px-5 py-5 border-t border-white/10 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className={`material-symbols-outlined text-2xl text-on-primary transition-opacity ${profileLoading ? "opacity-30 animate-pulse" : ""}`}>{avatarIcon}</span>
          <div className="min-w-0">
            <p className="text-sm font-bold text-on-primary truncate">{displayName}</p>
            <p className="text-[10px] text-on-primary-container/80 uppercase tracking-wider">Runner</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Link
            href="/profile"
            className="p-1.5 hover:bg-white/10 rounded-lg transition-colors"
            title="Profile"
          >
            <Icon name="manage_accounts" className="text-sm" />
          </Link>
          <button
            onClick={onLogout}
            className="p-1.5 hover:bg-white/10 rounded-lg transition-colors"
            title="Sign out"
          >
            <Icon name="logout" className="text-sm" />
          </button>
        </div>
      </div>
      {showUploadPrompt && onRouteUpload && (
        <UploadRoutePrompt
          onClose={() => setShowUploadPrompt(false)}
          onUpload={onRouteUpload}
        />
      )}
    </aside>
  );
}

// ─── MobileDrawer ─────────────────────────────────────────────────────────────

interface MobileDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  user: User | null;
  profile: UserProfile | null;
  profileLoading?: boolean;
  onLogout: () => void;
  fileInputRef: React.RefObject<HTMLInputElement>;
  onFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRouteUpload?: (gpxFiles: File[], tcxFiles: File[]) => void;
}

export function MobileDrawer({ isOpen, onClose, user, profile, profileLoading, onLogout, fileInputRef, onFileUpload, onRouteUpload }: MobileDrawerProps) {
  const pathname = usePathname();
  const [showUploadPrompt, setShowUploadPrompt] = useState(false);
  const isActive = (href: string) => href === "/" ? pathname === "/" : pathname.startsWith(href);
  const avatarIcon = profileLoading ? "directions_run" : (profile?.avatar || "directions_run");
  const displayName = profileLoading ? user?.email?.split("@")[0] || "Runner" : (profile?.displayName || user?.email?.split("@")[0]);

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm" onClick={onClose} />

      {/* Drawer */}
      <aside className="fixed inset-y-0 left-0 z-50 w-72 bg-primary text-on-primary flex flex-col shadow-xl animate-slide-in">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-5 border-b border-white/10">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-primary-container flex items-center justify-center shrink-0">
              <Icon name="sprint" filled className="text-on-primary-container text-xl" />
            </div>
            <div>
              <h2 className="text-base font-extrabold tracking-tight font-headline">GPX running</h2>
              <p className="text-[10px] text-on-primary-container/80">Every run, mapped out</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-xl transition-colors">
            <Icon name="close" className="text-on-primary-container text-base" />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-4 py-4 space-y-1">
          <Link href="/" onClick={onClose} className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-colors ${isActive("/") ? "bg-primary-container text-on-primary" : "text-on-primary/80 hover:bg-primary-container/60"}`}>
            <Icon name="route" filled={isActive("/")} className="text-base" />
            <span className="font-semibold text-sm">My Routes</span>
          </Link>
          {/* Divider */}
          <div className="my-3 border-t border-white/10" />
          <span className="px-4 py-1 text-[10px] font-extrabold uppercase tracking-widest text-on-primary/50">Extras</span>

          <Link href="/heatmaps" onClick={onClose} className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-colors ${isActive("/heatmaps") ? "bg-primary-container text-on-primary" : "text-on-primary/80 hover:bg-primary-container/60"}`}>
            <Icon name="whatshot" filled={isActive("/heatmaps")} className="text-base" />
            <div>
              <span className="font-semibold text-sm">Personal Heatmaps</span>
              <span className="block text-[10px] text-on-primary/50">Route layers</span>
            </div>
          </Link>

          <a className="flex items-center gap-3 px-4 py-3 rounded-xl text-on-primary/80 hover:bg-primary-container/60 transition-colors" href="/badges">
            <Icon name="emoji_events" className="text-base" />
            <div>
              <span className="font-semibold text-sm">Badges</span>
              <span className="block text-[10px] text-on-primary/50">Collect achievements</span>
            </div>
          </a>

        </nav>

        {/* Upload route button */}
        <div className="px-4 mb-2">
          <button
            type="button"
            onClick={() => {
              if (onRouteUpload) setShowUploadPrompt(true);
              else fileInputRef.current?.click();
            }}
            className="w-full bg-primary-container text-on-primary py-3 rounded-xl font-bold text-xs flex items-center justify-center gap-2 hover:opacity-90 active:scale-[0.98] transition-all cursor-pointer"
          >
            <Icon name="add" className="text-sm" />
            Upload route
          </button>
          <input ref={fileInputRef} type="file" accept=".gpx" multiple onChange={(e) => { onFileUpload(e); onClose(); }} className="hidden" />
        </div>

        {/* User section */}
        <div className="px-5 py-5 border-t border-white/10 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className={`material-symbols-outlined text-2xl text-on-primary transition-opacity ${profileLoading ? "opacity-30 animate-pulse" : ""}`}>{avatarIcon}</span>
            <div className="min-w-0">
              <p className="text-sm font-bold text-on-primary truncate">{displayName}</p>
              <p className="text-[10px] text-on-primary-container/80 uppercase tracking-wider">Runner</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Link
              href="/profile"
              onClick={() => onClose()}
              className="p-1.5 hover:bg-white/10 rounded-lg transition-colors"
              title="Profile"
            >
              <Icon name="manage_accounts" className="text-sm" />
            </Link>
            <button
              onClick={() => { onLogout(); onClose(); }}
              className="p-1.5 hover:bg-white/10 rounded-lg transition-colors"
              title="Sign out"
            >
              <Icon name="logout" className="text-sm" />
            </button>
          </div>
        </div>
      </aside>
      {showUploadPrompt && onRouteUpload && (
        <UploadRoutePrompt
          onClose={() => setShowUploadPrompt(false)}
          onUpload={(gpxFiles, tcxFiles) => {
            onRouteUpload(gpxFiles, tcxFiles);
            onClose();
          }}
        />
      )}
    </>
  );
}

// ─── MobileBottomNav ───────────────────────────────────────────────────────────

interface MobileBottomNavProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
  fileInputRef: React.RefObject<HTMLInputElement>;
  onFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

export function MobileBottomNav({ activeTab, onTabChange, fileInputRef, onFileUpload }: MobileBottomNavProps) {
  return (
    <nav className="md:hidden bg-surface-container-lowest border-t border-outline-variant/20 flex shrink-0 pb-safe z-30">
      <button
        onClick={() => onTabChange("routes")}
        className={`flex-1 flex flex-col items-center gap-0.5 py-3 transition-colors ${activeTab === "routes" ? "text-primary" : "text-on-surface-variant"}`}
      >
        <Icon name="route" filled={activeTab === "routes"} className="text-xl" />
        <span className="text-[10px] font-bold">Routes</span>
      </button>

      <label className={`flex-1 flex flex-col items-center gap-0.5 py-3 cursor-pointer transition-colors ${activeTab === "add" ? "text-primary" : "text-on-surface-variant"}`}>
        <Icon name="add" className="text-xl" />
        <span className="text-[10px] font-bold">Upload</span>
        <input
          type="file"
          accept=".gpx"
          multiple
          onChange={(e) => { onFileUpload(e); onTabChange("routes"); }}
          className="hidden"
        />
      </label>

      <button
        onClick={() => onTabChange("map")}
        className={`flex-1 flex flex-col items-center gap-0.5 py-3 transition-colors ${activeTab === "map" ? "text-primary" : "text-on-surface-variant"}`}
      >
        <Icon name="map" filled={activeTab === "map"} className="text-xl" />
        <span className="text-[10px] font-bold">Map</span>
      </button>

      <button
        onClick={() => onTabChange("profile")}
        className={`flex-1 flex flex-col items-center gap-0.5 py-3 transition-colors ${activeTab === "profile" ? "text-primary" : "text-on-surface-variant"}`}
      >
        <Icon name="account_circle" filled={activeTab === "profile"} className="text-xl" />
        <span className="text-[10px] font-bold">Profile</span>
      </button>
    </nav>
  );
}
