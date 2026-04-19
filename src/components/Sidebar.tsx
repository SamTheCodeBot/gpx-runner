"use client";

import { Icon } from "./ui";
import type { User } from "firebase/auth";

interface SidebarProps {
  user: User | null;
  onLogout: () => void;
  fileInputRef: React.RefObject<HTMLInputElement>;
  onFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

export function Sidebar({ user, onLogout, fileInputRef, onFileUpload }: SidebarProps) {
  return (
    <aside className="hidden md:flex w-64 bg-primary text-on-primary flex-col shrink-0">
      {/* Logo area */}
      <div className="p-6">
        <div className="flex items-center gap-3 mb-1">
          <div className="w-9 h-9 rounded-xl bg-primary-container flex items-center justify-center shrink-0">
            <Icon name="sprint" filled className="text-on-primary-container text-xl" />
          </div>
          <h1 className="text-xl font-extrabold tracking-tight font-headline text-on-primary">GPX running</h1>
        </div>
        <p className="text-[10px] text-on-primary-container/80 font-medium">Track your runs</p>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 space-y-0.5 mt-1">
        <a className="flex items-center gap-3 px-4 py-3 rounded-xl bg-primary-container text-on-primary" href="#">
          <Icon name="route" filled className="text-base" />
          <span className="font-semibold text-sm">My Routes</span>
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
      <div className="px-5 py-5 border-t border-white/10 flex items-center gap-3">
        <img
          alt="Profile"
          className="w-10 h-10 rounded-full border-2 border-primary-container object-cover bg-primary-container shrink-0"
          src={`https://ui-avatars.com/api/?name=${encodeURIComponent(user?.email || "U")}&background=001b44&color=fff&bold=true`}
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-bold text-on-primary truncate">{user?.email?.split("@")[0]}</p>
          <p className="text-[10px] text-on-primary-container/80 uppercase tracking-wider">Runner</p>
        </div>
        <button
          onClick={onLogout}
          className="p-1.5 hover:bg-white/10 rounded-lg transition-colors"
          title="Sign out"
        >
          <Icon name="logout" className="text-sm" />
        </button>
      </div>
    </aside>
  );
}

// ─── MobileDrawer ─────────────────────────────────────────────────────────────

interface MobileDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  user: User | null;
  onLogout: () => void;
  fileInputRef: React.RefObject<HTMLInputElement>;
  onFileUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
}

export function MobileDrawer({ isOpen, onClose, user, onLogout, fileInputRef, onFileUpload }: MobileDrawerProps) {
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
              <p className="text-[10px] text-on-primary-container/80">Track your runs</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-white/10 rounded-xl transition-colors">
            <Icon name="close" className="text-on-primary-container text-base" />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-4 py-4 space-y-1">
          <div className="px-4 py-3 rounded-xl bg-primary-container">
            <div className="flex items-center gap-3">
              <Icon name="route" filled className="text-base" />
              <span className="font-semibold text-sm">My Routes</span>
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
        <div className="px-5 py-5 border-t border-white/10 flex items-center gap-3">
          <img
            alt="Profile"
            className="w-10 h-10 rounded-full border-2 border-primary-container object-cover bg-primary-container shrink-0"
            src={`https://ui-avatars.com/api/?name=${encodeURIComponent(user?.email || "U")}&background=001b44&color=fff&bold=true`}
          />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold text-on-primary truncate">{user?.email?.split("@")[0]}</p>
            <p className="text-[10px] text-on-primary-container/80 uppercase tracking-wider">Runner</p>
          </div>
          <button
            onClick={() => { onLogout(); onClose(); }}
            className="p-1.5 hover:bg-white/10 rounded-lg transition-colors"
            title="Sign out"
          >
            <Icon name="logout" className="text-sm" />
          </button>
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
