"use client";

import { useState } from "react";

interface IconProps {
  name: string;
  filled?: boolean;
  className?: string;
}

export function Icon({ name, filled, className = "" }: IconProps) {
  return (
    <span className={`material-symbols-outlined${filled ? " filled" : ""} ${className}`}>
      {name}
    </span>
  );
}

// ─── StatCard ────────────────────────────────────────────────────────────────

interface StatCardProps {
  label: string;
  value: string;
  unit?: string;
  icon: string;
}

export function StatCard({ label, value, unit, icon }: StatCardProps) {
  return (
    <div className="bg-surface-container rounded-xl px-2 py-1.5 sm:px-3 sm:py-2 flex items-center gap-1.5 sm:gap-2 shadow-card">
      <div className="w-5 h-5 sm:w-6 sm:h-6 rounded flex items-center justify-center shrink-0">
        <Icon name={icon} className="text-on-surface-variant text-xs sm:text-sm" />
      </div>
      <div>
        <p className="text-[7px] sm:text-[8px] font-extrabold uppercase tracking-wider text-on-surface-variant leading-tight">
          {label}
        </p>
        <p className="text-xs sm:text-sm font-extrabold text-primary leading-none">
          {value}{unit && <span className="text-[9px] sm:text-[10px] font-medium text-on-surface-variant ml-0.5">{unit}</span>}
        </p>
      </div>
    </div>
  );
}

// ─── RouteRow ────────────────────────────────────────────────────────────────

interface GPXRoute {
  id: string;
  name: string;
  date: string;
  coordinates: [number, number][];
  distance: number;
  elevationGain: number;
  color?: string;
  type?: string;
}

interface RouteRowProps {
  route: GPXRoute;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onDownload: () => void;
  onEdit: () => void;
  wishlisted?: boolean;
  isFavorite?: boolean;
  onToggleWishlist?: (routeId: string) => void;
  onToggleFavorite?: (routeId: string) => void;
}

export function RouteRow({
  route, selected, onSelect, onDelete, onDownload, onEdit,
  wishlisted, isFavorite, onToggleWishlist, onToggleFavorite,
}: RouteRowProps) {
  const date = new Date(route.date);
  const distKm = (route.distance / 1000).toFixed(1);
  const elevM = Math.round(route.elevationGain);

  return (
    <div
      className={`bg-surface-container rounded-2xl p-3 flex items-center gap-2 cursor-pointer
        transition-all hover:bg-surface-container-high group
        ${selected ? "ring-2 ring-primary shadow-sm" : ""}`}
      onClick={onSelect}
    >
      {/* Color dot */}
      <div
        className="w-2.5 h-2.5 rounded-full shrink-0"
        style={{ backgroundColor: route.type === 'trail' ? 'rgb(18 221 251)' : route.type === 'mixed' ? 'rgb(197 45 255)' : 'rgb(255 65 164)' }}
      />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-bold text-on-surface truncate">{route.name}</p>
        <p className="text-[10px] text-on-surface-variant mt-0.5">
          {date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
          &nbsp;·&nbsp;{distKm} km&nbsp;·&nbsp;{elevM}m ↑&nbsp;
          {route.type && <>·&nbsp;<span className={`capitalize ${route.type === "road" ? "text-pink-400" : route.type === "trail" ? "text-cyan-400" : "text-purple-400"}`}>{route.type}</span></>}
        </p>
      </div>
      {/* Row action buttons — always visible when selected on mobile; hover-reveal on desktop */}
      <div className={`flex items-center gap-0.5 sm:opacity-0 transition-opacity supports-hover:hover:opacity-100 group-hover:sm:opacity-100 ${selected ? "opacity-100" : "opacity-0 sm:opacity-0"}`}>
        {onToggleFavorite && (
          <button
            onClick={(e) => { e.stopPropagation(); onToggleFavorite(route.id); }}
            className={`p-1.5 rounded-lg transition-colors ${isFavorite ? "text-yellow-500" : "text-on-surface-variant hover:text-yellow-500"} hover:bg-surface-container-highest`}
            title={isFavorite ? "Remove from favorites" : "Add to favorites"}
          >
            <Icon name={isFavorite ? "star" : "star_outline"} className="text-sm" />
          </button>
        )}
        {onToggleWishlist && (
          <button
            onClick={(e) => { e.stopPropagation(); onToggleWishlist(route.id); }}
            className={`p-1.5 rounded-lg transition-colors ${wishlisted ? "text-primary" : "text-on-surface-variant hover:text-primary"} hover:bg-surface-container-highest`}
            title={wishlisted ? "Remove from wishlist" : "Save to wishlist"}
          >
            <Icon name={wishlisted ? "bookmark" : "bookmark_add"} className="text-sm" />
          </button>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); onEdit(); }}
          className="p-1.5 rounded-lg hover:bg-surface-container-highest text-on-surface-variant hover:text-primary transition-colors"
          title="Edit"
        >
          <Icon name="edit" className="text-sm" />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onDownload(); }}
          className="p-1.5 rounded-lg hover:bg-surface-container-highest text-on-surface-variant hover:text-primary transition-colors"
          title="Download GPX"
        >
          <Icon name="download" className="text-sm" />
        </button>
      </div>
    </div>
  );
}

// ─── UploadModal ─────────────────────────────────────────────────────────────

interface UploadModalProps {
  route: GPXRoute;
  onAccept: (name: string, type: string) => void;
  onCancel: () => void;
}

export function UploadModal({ route, onAccept, onCancel }: UploadModalProps) {
  const [name, setName] = useState(route.name || "");
  const [type, setType] = useState<string>("road");

  const accept = () => {
    if (!name.trim()) return;
    onAccept(name.trim(), type);
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative bg-surface-container-lowest rounded-3xl shadow-xl w-full max-w-sm p-6 animate-fade-in">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-base font-extrabold text-primary font-headline">Name Your Run</h3>
          <button onClick={onCancel} className="p-1.5 rounded-lg hover:bg-surface-container transition-colors">
            <Icon name="close" className="text-on-surface-variant text-sm" />
          </button>
        </div>
        <div className="space-y-4">
          <div>
            <label className="text-[10px] font-extrabold uppercase tracking-wider text-on-surface-variant block mb-1">Name</label>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && accept()}
              placeholder="Morning run, Trail exploring…"
              className="w-full px-3 py-2 bg-surface-container border border-outline-variant rounded-xl text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
          <div>
            <label className="text-[10px] font-extrabold uppercase tracking-wider text-on-surface-variant block mb-1">Type</label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="w-full px-3 py-2 bg-surface-container border border-outline-variant rounded-xl text-sm text-on-surface focus:outline-none"
            >
              <option value="road">Road</option>
              <option value="trail">Trail</option>
              <option value="mixed">Mixed</option>
            </select>
          </div>
        </div>
        <div className="flex gap-2 mt-5">
          <button onClick={onCancel} className="flex-1 py-2.5 border border-outline-variant rounded-xl text-sm font-medium text-on-surface-variant hover:bg-surface-container transition-colors">
            Cancel
          </button>
          <button onClick={accept} disabled={!name.trim()} className="flex-1 py-2.5 bg-primary text-on-primary rounded-xl text-sm font-bold hover:opacity-90 transition-opacity disabled:opacity-40">
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── EditModal ────────────────────────────────────────────────────────────────

interface EditModalProps {
  route: GPXRoute;
  onSave: (name: string, type: string) => void;
  onClose: () => void;
  onDelete: () => void;
}

export function EditModal({ route, onSave, onClose, onDelete }: EditModalProps) {
  const [name, setName] = useState(route.name);
  const [type, setType] = useState(route.type || "road");

  const save = () => {
    if (!name.trim()) return;
    onSave(name.trim(), type);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-surface-container-lowest rounded-3xl shadow-xl w-full max-w-sm p-6 animate-fade-in">
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-base font-extrabold text-primary font-headline">Edit Route</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-surface-container transition-colors">
            <Icon name="close" className="text-on-surface-variant text-sm" />
          </button>
        </div>
        <div className="space-y-4">
          <div>
            <label className="text-[10px] font-extrabold uppercase tracking-wider text-on-surface-variant block mb-1">Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 bg-surface-container border border-outline-variant rounded-xl text-sm text-on-surface focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>
          <div>
            <label className="text-[10px] font-extrabold uppercase tracking-wider text-on-surface-variant block mb-1">Type</label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="w-full px-3 py-2 bg-surface-container border border-outline-variant rounded-xl text-sm text-on-surface focus:outline-none"
            >
              <option value="road">Road</option>
              <option value="trail">Trail</option>
              <option value="mixed">Mixed</option>
            </select>
          </div>
        </div>
        <div className="flex gap-2 mt-5">
          <button onClick={onClose} className="flex-1 py-2.5 border border-outline-variant rounded-xl text-sm font-medium text-on-surface-variant hover:bg-surface-container transition-colors">
            Cancel
          </button>
          <button onClick={save} className="flex-1 py-2.5 bg-primary text-on-primary rounded-xl text-sm font-bold hover:opacity-90 transition-opacity">
            Save
          </button>
        </div>
        <button
          onClick={() => { if (confirm("Delete this route permanently?\nThis cannot be undone.")) { onDelete(); onClose(); } }}
          className="w-full mt-3 py-2 border border-error/40 text-error/70 rounded-xl text-xs font-medium hover:bg-error-container hover:border-error/60 hover:text-error transition-colors"
        >
          Delete route
        </button>
      </div>
    </div>
  );
}

// ─── LoginScreen ───────────────────────────────────────────────────────────────

interface LoginScreenProps {
  email: string;
  setEmail: (v: string) => void;
  username: string;
  setUsername: (v: string) => void;
  password: string;
  setPassword: (v: string) => void;
  authError: string;
  authSuccess: string;
  isRegistering: boolean;
  setIsRegistering: (v: boolean) => void;
  showForgotPassword: boolean;
  setShowForgotPassword: (v: boolean) => void;
  handleAuth: (e: React.FormEvent) => void;
  setAuthError: (v: string) => void;
}

export function LoginScreen({
  email, setEmail, username, setUsername, password, setPassword,
  authError, authSuccess, isRegistering, setIsRegistering,
  showForgotPassword, setShowForgotPassword, handleAuth,
  setAuthError,
}: LoginScreenProps) {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex items-center gap-3 mb-8 justify-center">
          <div className="w-12 h-12 rounded-2xl bg-primary-container flex items-center justify-center">
            <span className="material-symbols-outlined filled text-on-primary-container text-2xl">sprint</span>
          </div>
          <div>
            <h1 className="text-2xl font-extrabold text-primary font-headline tracking-tight">GPX running</h1>
            <p className="text-xs text-on-surface-variant">Track your runs</p>
          </div>
        </div>

        {/* Card */}
        <div className="bg-surface-container-lowest rounded-3xl shadow-lg p-6">
          <h2 className="text-lg font-extrabold text-primary mb-1">
            {showForgotPassword ? "Reset password" : isRegistering ? "Create account" : "Welcome back"}
          </h2>
          <p className="text-xs text-on-surface-variant mb-5">
            {showForgotPassword
              ? "Enter your email to receive a reset link"
              : isRegistering
              ? "Sign up to start tracking your runs"
              : "Sign in to access your route data"}
          </p>

          {authError && (
            <div className="mb-3 px-3 py-2 bg-error-container rounded-xl text-xs font-medium text-error">{authError}</div>
          )}
          {authSuccess && (
            <div className="mb-3 px-3 py-2 bg-green-100 rounded-xl text-xs font-medium text-green-800">{authSuccess}</div>
          )}

          <form onSubmit={handleAuth} className="space-y-3">
            <div>
              <label className="text-[10px] font-extrabold uppercase tracking-wider text-on-surface-variant block mb-1">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="runner@example.com"
                required
                className="w-full px-3 py-2.5 bg-surface-container border border-outline-variant rounded-xl text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            </div>
            {isRegistering && (
              <div>
                <label className="text-[10px] font-extrabold uppercase tracking-wider text-on-surface-variant block mb-1">Username</label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Choose a unique username"
                  required={isRegistering}
                  minLength={3}
                  maxLength={30}
                  pattern="[a-zA-Z0-9_]+"
                  title="Letters, numbers and underscores only"
                  className="w-full px-3 py-2.5 bg-surface-container border border-outline-variant rounded-xl text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
            )}
            {!showForgotPassword && (
              <div>
                <label className="text-[10px] font-extrabold uppercase tracking-wider text-on-surface-variant block mb-1">Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  minLength={6}
                  className="w-full px-3 py-2.5 bg-surface-container border border-outline-variant rounded-xl text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </div>
            )}
            <button type="submit" className="w-full py-3 bg-primary text-on-primary rounded-xl text-sm font-bold hover:opacity-90 transition-opacity mt-1">
              {showForgotPassword ? "Send reset link" : isRegistering ? "Create account" : "Sign in"}
            </button>
          </form>

          <div className="mt-4 flex items-center justify-between">
            {!showForgotPassword && (
              <button
                onClick={() => { setIsRegistering(!isRegistering); setAuthError(""); }}
                className="text-xs text-primary font-medium hover:underline"
              >
                {isRegistering ? "Already have an account? Sign in" : "No account? Sign up"}
              </button>
            )}
            {!isRegistering && !showForgotPassword && (
              <button
                onClick={() => { setShowForgotPassword(!showForgotPassword); setAuthError(""); }}
                className="text-xs text-on-surface-variant hover:text-primary"
              >
                Forgot password?
              </button>
            )}
            {showForgotPassword && (
              <button
                onClick={() => { setShowForgotPassword(false); setAuthError(""); }}
                className="text-xs text-primary font-medium hover:underline"
              >
                Back to sign in
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
