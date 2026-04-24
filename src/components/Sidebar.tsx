"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
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
}

export function Sidebar({ user, profile, profileLoading, onLogout, fileInputRef, onFileUpload }: SidebarProps) {
  const pathname = usePathname();
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
        <Link href="/suggest" className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-colors ${isActive("/suggest") ? "bg-primary-container text-on-primary" : "text-on-primary/80 hover:bg-primary-container/60"}`}>
          <Icon name="explore" filled={isActive("/suggest")} className="text-base" />
          <span className="font-semibold text-sm">Route Suggestions</span>
        </Link>

        {/* Divider */}
        <div className="my-3 border-t border-white/10" />

        {/* Heatmap & badges — fun extras */}
        <span className="px-4 py-1 text-[10px] font-extrabold uppercase tracking-widest text-on-primary/50">Extras</span>

        <a className="flex items-center gap-3 px-4 py-3 rounded-xl text-on-primary/80 hover:bg-primary-container/60 transition-colors" href="/">
          <Icon name="whatshot" className="text-base" />
          <div>
            <span className="font-semibold text-sm">Personal Heatmap</span>
            <span className="block text-[10px] text-on-primary/50">Your running density</span>
          </div>
        </a>

        <a className="flex items-center gap-3 px-4 py-3 rounded-xl text-on-primary/80 hover:bg-primary-container/60 transition-colors" href="/badges">
          <Icon name="emoji_events" className="text-base" />
          <div>
            <span className="font-semibold text-sm">Badges</span>
            <span className="block text-[10px] text-on-primary/50">Collect achievements</span>
          </div>
        </a>

        <a className="flex items-center gap-3 px-4 py-3 rounded-xl text-on-primary/50 hover:bg-primary-container/40 transition-colors cursor-not-allowed" href="#">
          <Icon name="groups" className="text-base" />
          <div>
            <span className="font-semibold text-sm">Run Clubs</span>
            <span className="block text-[10px] text-on-primary/50">Coming soon</span>
          </div>
        </a>

      </nav>

      {/* Upload GPX button */}
      <div className="px-4 mb-2">
        <label className="w-full bg-primary-container text-on-primary py-3 rounded-xl font-bold text-xs flex items-center justify-center gap-2 hover:opacity-90 active:scale-[0.98] transition-all cursor-pointer">
          <Icon name="add" className="text-sm" />
          Add route (GPX)
          <input ref={fileInputRef} type="file" accept=".gpx" multiple onChange={onFileUpload} className="hidden" />
        </label>
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
}

export function MobileDrawer({ isOpen, onClose, user, profile, profileLoading, onLogout, fileInputRef, onFileUpload }: MobileDrawerProps) {
  const pathname = usePathname();
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
          <Link href="/suggest" onClick={onClose} className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-colors ${isActive("/suggest") ? "bg-primary-container text-on-primary" : "text-on-primary/80 hover:bg-primary-container/60"}`}>
            <Icon name="explore" filled={isActive("/suggest")} className="text-base" />
            <span className="font-semibold text-sm">Route Suggestions</span>
          </Link>

          {/* Divider */}
          <div className="my-3 border-t border-white/10" />
          <span className="px-4 py-1 text-[10px] font-extrabold uppercase tracking-widest text-on-primary/50">Extras</span>

          <a className="flex items-center gap-3 px-4 py-3 rounded-xl text-on-primary/80 hover:bg-primary-container/60 transition-colors" href="/">
            <Icon name="whatshot" className="text-base" />
            <div>
              <span className="font-semibold text-sm">Personal Heatmap</span>
              <span className="block text-[10px] text-on-primary/50">Your running density</span>
            </div>
          </a>

          <a className="flex items-center gap-3 px-4 py-3 rounded-xl text-on-primary/80 hover:bg-primary-container/60 transition-colors" href="/badges">
            <Icon name="emoji_events" className="text-base" />
            <div>
              <span className="font-semibold text-sm">Badges</span>
              <span className="block text-[10px] text-on-primary/50">Collect achievements</span>
            </div>
          </a>

          <div className="flex items-center gap-3 px-4 py-3 rounded-xl text-on-primary/40 cursor-not-allowed">
            <Icon name="groups" className="text-base" />
            <div>
              <span className="font-semibold text-sm">Run Clubs</span>
              <span className="block text-[10px] text-on-primary/50">Coming soon</span>
            </div>
          </div>
        </nav>

        {/* Upload GPX button */}
        <div className="px-4 mb-2">
          <label className="w-full bg-primary-container text-on-primary py-3 rounded-xl font-bold text-xs flex items-center justify-center gap-2 hover:opacity-90 active:scale-[0.98] transition-all cursor-pointer">
            <Icon name="add" className="text-sm" />
            Add route (GPX)
            <input ref={fileInputRef} type="file" accept=".gpx" multiple onChange={(e) => { onFileUpload(e); onClose(); }} className="hidden" />
          </label>
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
        <span className="text-[10px] font-bold">Add GPX</span>
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
