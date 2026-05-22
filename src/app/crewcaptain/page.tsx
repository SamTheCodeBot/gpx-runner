"use client";

import { useState, useEffect, useRef } from "react";
import { signInWithEmailAndPassword, signOut, User } from "firebase/auth";
import { auth } from "@/lib/firebase";
import { Icon } from "@/components/ui";
import { AdminSidebar } from "@/components/AdminSidebar";

interface AdminStats {
  registeredUsers: number;
  totalRoutes: number;
  roadRoutes: number;
  trailRoutes: number;
  mixedRoutes: number;
}

interface RouteSummary {
  id: string;
  name: string;
  type: "road" | "trail" | "mixed";
  coordinates: [number, number][];
}

const ADMIN_EMAIL = "mago@osterhult.com";
const SESSION_KEY = "cc_admin_token";

const TYPE_COLORS: Record<string, string> = {
  road: "rgb(255 65 164)",
  trail: "rgb(18 221 251)",
  mixed: "rgb(197 45 255)",
};

// ─── Login Screen ─────────────────────────────────────────────────────────────

function AdminLogin({ onLogin }: { onLogin: (user: User) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      const cred = await signInWithEmailAndPassword(auth!, email, password);
      if (cred.user.email?.toLowerCase() !== ADMIN_EMAIL.toLowerCase()) {
        await signOut(auth!);
        setError("Access denied \u2014 not an admin account.");
        return;
      }
      onLogin(cred.user);
    } catch (err: any) {
      setError(err.message || "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-3 mb-8 justify-center">
          <div className="w-12 h-12 rounded-2xl bg-primary-container flex items-center justify-center">
            <Icon name="shield" filled className="text-on-primary-container text-2xl" />
          </div>
          <div>
            <h1 className="text-2xl font-extrabold text-primary font-headline tracking-tight">Crew Captain</h1>
            <p className="text-xs text-on-surface-variant">Admin Dashboard</p>
          </div>
        </div>
        <div className="bg-surface-container-lowest rounded-3xl shadow-lg p-6">
          <h2 className="text-lg font-extrabold text-primary mb-1">Sign in</h2>
          <p className="text-xs text-on-surface-variant mb-5">Restricted access \u2014 crew only</p>
          {error && (
            <div className="mb-3 px-3 py-2 bg-error-container rounded-xl text-xs font-medium text-error">{error}</div>
          )}
          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="text-[10px] font-extrabold uppercase tracking-wider text-on-surface-variant block mb-1">Email</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="crew@example.com" required
                className="w-full px-3 py-2.5 bg-surface-container border border-outline-variant rounded-xl text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:ring-2 focus:ring-primary/30" />
            </div>
            <div>
              <label className="text-[10px] font-extrabold uppercase tracking-wider text-on-surface-variant block mb-1">Password</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022" required
                className="w-full px-3 py-2.5 bg-surface-container border border-outline-variant rounded-xl text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:ring-2 focus:ring-primary/30" />
            </div>
            <button type="submit" disabled={loading}
              className="w-full py-3 bg-primary text-on-primary rounded-xl text-sm font-bold hover:opacity-90 transition-opacity disabled:opacity-50">
              {loading ? "Signing in\u2026" : "Sign in"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

// ─── Dashboard View ─────────────────────────────────────────────────────────

function StatCard({ label, value, unit, icon }: { label: string; value: string; unit?: string; icon: string }) {
  return (
    <div className="bg-surface-container rounded-xl px-3 py-2.5 flex items-center gap-2 shadow-card">
      <div className="w-8 h-8 rounded-lg bg-surface-container-high flex items-center justify-center shrink-0">
        <Icon name={icon} className="text-on-surface-variant text-base" />
      </div>
      <div>
        <p className="text-[9px] font-extrabold uppercase tracking-wider text-on-surface-variant leading-tight">{label}</p>
        <p className="text-sm font-extrabold text-primary leading-none">
          {value}{unit && <span className="text-[10px] font-medium text-on-surface-variant ml-0.5">{unit}</span>}
        </p>
      </div>
    </div>
  );
}

function RouteMapCanvas({ routes, activeType }: { routes: RouteSummary[]; activeType: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvasEl = canvasRef.current;
    if (!canvasEl) { console.log("[Map] no canvas yet"); return; }
    const filtered = activeType === "all" ? routes : routes.filter((r) => r.type === activeType);
    console.log("[Map] rendering", filtered.length, "routes, activeType=", activeType, "canvas size:", canvasEl.width, "x", canvasEl.height);
    const ctx = canvasEl.getContext("2d");
    if (!ctx) return;
    const W = canvasEl.width;
    const H = canvasEl.height;
    ctx.clearRect(0, 0, W, H);
    if (filtered.length === 0) {
      console.log("[Map] no routes to draw");
      ctx.fillStyle = "rgb(99, 115, 139)";
      ctx.font = "14px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No routes for this filter", W / 2, H / 2);
      return;
    }
    console.log("[Map] coordinate bounds: lat", minLat, "-", maxLat, "lon", minLon, "-", maxLon);
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const route of filtered) {
      for (const [, lat] of route.coordinates) { if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat; }
      for (const [lon] of route.coordinates) { if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon; }
    }
    const pad = 0.02;
    minLat -= pad; maxLat += pad; minLon -= pad; maxLon += pad;
    ctx.fillStyle = "rgb(30, 34, 47)";
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 10; i++) {
      const x = (i / 10) * W; const y = (i / 10) * H;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    }
    const project = (lon: number, lat: number): [number, number] => {
      return [(lon - minLon) / (maxLon - minLon) * W, (maxLat - lat) / (maxLat - minLat) * H];
    };
    for (const route of filtered) {
      const color = TYPE_COLORS[route.type] || TYPE_COLORS.road;
      ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.globalAlpha = 0.8; ctx.lineJoin = "round"; ctx.lineCap = "round";
      ctx.beginPath();
      const coords = route.coordinates;
      if (coords.length > 0) {
        const [sx, sy] = project(coords[0][0], coords[0][1]); ctx.moveTo(sx, sy);
        for (let i = 1; i < coords.length; i++) { const [x, y] = project(coords[i][0], coords[i][1]); ctx.lineTo(x, y); }
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    for (const route of filtered) {
      const coords = route.coordinates;
      if (coords.length === 0) continue;
      const [sx, sy] = project(coords[0][0], coords[0][1]);
      const [ex, ey] = project(coords[coords.length - 1][0], coords[coords.length - 1][1]);
      ctx.fillStyle = "rgb(74, 222, 128)"; ctx.beginPath(); ctx.arc(sx, sy, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "rgb(255, 82, 82)"; ctx.beginPath(); ctx.arc(ex, ey, 4, 0, Math.PI * 2); ctx.fill();
    }
  }, [routes, activeType]);


  return (
    <div className="relative rounded-2xl overflow-hidden bg-[#1e222f]">
      <canvas ref={canvasRef} width={900} height={540} className="w-full h-full" />
      <div className="absolute bottom-3 left-3 flex items-center gap-3 bg-surface-container/80 backdrop-blur-sm rounded-xl px-3 py-1.5">
        <div className="flex items-center gap-1"><div className="w-2.5 h-2.5 rounded-full" style={{backgroundColor: TYPE_COLORS.road}} /><span className="text-[9px] font-medium text-on-surface-variant">Road</span></div>
        <div className="flex items-center gap-1"><div className="w-2.5 h-2.5 rounded-full" style={{backgroundColor: TYPE_COLORS.trail}} /><span className="text-[9px] font-medium text-on-surface-variant">Trail</span></div>
        <div className="flex items-center gap-1"><div className="w-2.5 h-2.5 rounded-full" style={{backgroundColor: TYPE_COLORS.mixed}} /><span className="text-[9px] font-medium text-on-surface-variant">Mixed</span></div>
        <div className="ml-1 flex items-center gap-1.5">
          <div className="w-2.5 h-2.5 rounded-full bg-green-400" /><span className="text-[9px] font-medium text-on-surface-variant">Start</span>
          <div className="w-2.5 h-2.5 rounded-full bg-red-400 ml-1" /><span className="text-[9px] font-medium text-on-surface-variant">End</span>
        </div>
      </div>
    </div>
  );
}

function DashboardView({ user }: { user: User }) {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [routes, setRoutes] = useState<RouteSummary[]>([]);
  const [activeType, setActiveType] = useState<string>("all");
  const [loadingStats, setLoadingStats] = useState(true);
  const [loadingRoutes, setLoadingRoutes] = useState(true);

  const loadStats = async (idToken: string) => {
    try {
      const res = await fetch("/api/crewcaptain/stats", { headers: { Authorization: `Bearer ${idToken}` } });
      if (res.ok) setStats(await res.json());
    } finally { setLoadingStats(false); }
  };

  const loadRoutes = async (idToken: string, type: string) => {
    setLoadingRoutes(true);
    try {
      const url = type === "all" ? "/api/crewcaptain/routes" : `/api/crewcaptain/routes?type=${type}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
      if (res.ok) { const data = await res.json(); setRoutes(data.routes || []); }
    } finally { setLoadingRoutes(false); }
  };

  useEffect(() => {
    const getIdToken = async () => {
      const idToken = await user.getIdToken();
      sessionStorage.setItem(SESSION_KEY, idToken);
      await Promise.all([loadStats(idToken), loadRoutes(idToken, activeType)]);
    };
    getIdToken();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleTypeChange = async (type: string) => {
    setActiveType(type);
    const idToken = sessionStorage.getItem(SESSION_KEY) || await user.getIdToken();
    await loadRoutes(idToken, type);
  };

  return (
    <div className="flex-1 overflow-y-auto px-4 pt-6 pb-8 custom-scrollbar">
      <div className="flex items-center gap-4 mb-6">
        <div className="w-12 h-12 rounded-2xl bg-primary-container flex items-center justify-center shrink-0 shadow-card">
          <Icon name="dashboard" filled className="text-on-primary-container text-2xl" />
        </div>
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface font-headline">Dashboard</h1>
          <p className="text-sm text-on-surface-variant">Platform overview and statistics</p>
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-8">
        {loadingStats ? (
          <>{[...Array(5)].map((_, i) => (<div key={i} className="bg-surface-container rounded-xl px-3 py-2.5 animate-pulse h-16" />))}</>
        ) : stats ? (
          <>
            <StatCard label="Registered Users" value={String(stats.registeredUsers)} icon="group" />
            <StatCard label="Total Routes" value={String(stats.totalRoutes)} icon="route" />
            <StatCard label="Road" value={String(stats.roadRoutes)} icon="directions_run" />
            <StatCard label="Trail" value={String(stats.trailRoutes)} icon="terrain" />
            <StatCard label="Mixed" value={String(stats.mixedRoutes)} icon="all_inclusive" />
          </>
        ) : (
          <p className="col-span-5 text-sm text-on-surface-variant text-center py-4">Failed to load stats.</p>
        )}
      </div>
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-extrabold text-on-surface">Route Map</h2>
          <div className="flex items-center gap-1.5">
            {["all", "road", "trail", "mixed"].map((type) => (
              <button key={type} onClick={() => handleTypeChange(type)}
                className={`px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-colors ${activeType === type ? "bg-primary text-on-primary" : "bg-surface-container text-on-surface-variant hover:bg-surface-container-high"}`}>
                {type}
              </button>
            ))}
          </div>
        </div>
        {loadingRoutes ? (
          <div className="h-64 sm:h-80 md:h-96 bg-surface-container rounded-2xl animate-pulse" />
        ) : routes.length === 0 ? (
          <div className="h-64 sm:h-80 md:h-96 bg-surface-container rounded-2xl flex items-center justify-center">
            <p className="text-on-surface-variant text-sm">No routes found in database</p>
          </div>
        ) : (
          <RouteMapCanvas routes={routes} activeType={activeType} />
        )}
        <p className="text-[10px] text-on-surface-variant mt-1.5 text-right">
          {routes.length} route{routes.length !== 1 ? "s" : ""} shown{activeType !== "all" ? ` (${activeType})` : ""}
        </p>
      </div>
    </div>
  );
}

// ─── Routes View ─────────────────────────────────────────────────────────────

function RoutesView({ user }: { user: User }) {
  const [routes, setRoutes] = useState<RouteSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeType, setActiveType] = useState<string>("all");

  useEffect(() => {
    const load = async () => {
      const idToken = await user.getIdToken();
      const url = activeType === "all" ? "/api/crewcaptain/routes" : `/api/crewcaptain/routes?type=${activeType}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${idToken}` } });
      if (res.ok) {
        const data = await res.json();
        setRoutes(data.routes || []);
      }
      setLoading(false);
    };
    load();
  }, [activeType, user]);

  return (
    <div className="flex-1 overflow-y-auto px-4 pt-6 pb-8 custom-scrollbar">
      <div className="flex items-center gap-4 mb-6">
        <div className="w-12 h-12 rounded-2xl bg-primary-container flex items-center justify-center shrink-0 shadow-card">
          <Icon name="map" filled className="text-on-primary-container text-2xl" />
        </div>
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface font-headline">Routes</h1>
          <p className="text-sm text-on-surface-variant">All uploaded routes</p>
        </div>
      </div>
      <div className="flex items-center gap-1.5 mb-4">
        {["all", "road", "trail", "mixed"].map((type) => (
          <button key={type} onClick={() => setActiveType(type)}
            className={`px-3 py-1.5 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-colors ${activeType === type ? "bg-primary text-on-primary" : "bg-surface-container text-on-surface-variant hover:bg-surface-container-high"}`}>
            {type}
          </button>
        ))}
      </div>
      {loading ? (
        <div className="h-64 bg-surface-container rounded-2xl animate-pulse" />
      ) : (
        <div className="space-y-2">
          {routes.map((route) => (
            <div key={route.id} className="bg-surface-container rounded-xl px-3 py-2.5 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center border border-outline-variant/20" style={{backgroundColor: TYPE_COLORS[route.type] + "33"}}>
                  <Icon name="route" className="text-on-surface-variant text-base" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-bold text-on-surface truncate">{route.name}</p>
                  <p className="text-[10px] text-on-surface-variant uppercase">{route.type}</p>
                </div>
              </div>
              <p className="text-[10px] text-on-surface-variant">{route.coordinates.length} pts</p>
            </div>
          ))}
        </div>
      )}
      <p className="text-[10px] text-on-surface-variant mt-3 text-right">{routes.length} route{routes.length !== 1 ? "s" : ""} total</p>
    </div>
  );
}

// ─── Users View ────────────────────────────────────────────────────────────

interface UserSummary {
  id: string;
  username: string;
  email: string;
  routeCount: number;
  stravaConnected: boolean;
  isAdmin: boolean;
}

function UsersView({ user }: { user: User }) {
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      const idToken = await user.getIdToken();
      const res = await fetch("/api/crewcaptain/users", { headers: { Authorization: `Bearer ${idToken}` } });
      if (res.ok) {
        const data = await res.json();
        setUsers(data.users || []);
      }
      setLoading(false);
    };
    load();
  }, [user]);

  return (
    <div className="flex-1 overflow-y-auto px-4 pt-6 pb-8 custom-scrollbar">
      <div className="flex items-center gap-4 mb-6">
        <div className="w-12 h-12 rounded-2xl bg-primary-container flex items-center justify-center shrink-0 shadow-card">
          <Icon name="group" filled className="text-on-primary-container text-2xl" />
        </div>
        <div>
          <h1 className="text-2xl font-extrabold text-on-surface font-headline">Users</h1>
          <p className="text-sm text-on-surface-variant">Registered users on the platform</p>
        </div>
      </div>
      {loading ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-16 bg-surface-container rounded-xl animate-pulse" />
          ))}
        </div>
      ) : (
        <>
          <div className="bg-surface-container rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-outline-variant/20">
                  <th className="px-3 py-2.5 text-left text-[10px] font-extrabold uppercase tracking-wider text-on-surface-variant">Username</th>
                  <th className="px-3 py-2.5 text-left text-[10px] font-extrabold uppercase tracking-wider text-on-surface-variant">Email</th>
                  <th className="px-3 py-2.5 text-right text-[10px] font-extrabold uppercase tracking-wider text-on-surface-variant">Routes</th>
                  <th className="px-3 py-2.5 text-center text-[10px] font-extrabold uppercase tracking-wider text-on-surface-variant">Strava</th>
                  <th className="px-3 py-2.5 text-center text-[10px] font-extrabold uppercase tracking-wider text-on-surface-variant">Admin</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-b border-outline-variant/10 last:border-0 hover:bg-surface-container-high/50 transition-colors">
                    <td className="px-3 py-2.5">
                      <span className="font-semibold text-on-surface">{u.username}</span>
                    </td>
                    <td className="px-3 py-2.5 text-on-surface-variant text-xs">{u.email}</td>
                    <td className="px-3 py-2.5 text-right">
                      <span className="font-bold text-primary">{u.routeCount}</span>
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-[9px] font-bold ${u.stravaConnected ? "bg-green-400/20 text-green-400" : "bg-surface-container-high text-on-surface-variant/50"}`}>
                        {u.stravaConnected ? "Y" : "N"}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-center">
                      <span className={`inline-flex items-center justify-center w-5 h-5 rounded-full text-[9px] font-bold ${u.isAdmin ? "bg-primary/20 text-primary" : "bg-surface-container-high text-on-surface-variant/50"}`}>
                        {u.isAdmin ? "Y" : "N"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[10px] text-on-surface-variant mt-3 text-right">{users.length} user{users.length !== 1 ? "s" : ""} total</p>
        </>
      )}
    </div>
  );
}

// Main Page
export default function CrewCaptainPage() {
  const [user, setUser] = useState<User | null>(null);
  const [activeView, setActiveView] = useState<string>("dashboard");

  useEffect(() => {
    if (auth?.currentUser && auth.currentUser.email?.toLowerCase() === ADMIN_EMAIL.toLowerCase()) {
      setUser(auth.currentUser);
    }
  }, []);

  const handleLogin = (newUser: User) => setUser(newUser);

  const handleLogout = async () => {
    await signOut(auth!);
    sessionStorage.removeItem(SESSION_KEY);
    setUser(null);
  };

  if (!user) return <AdminLogin onLogin={handleLogin} />;

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <AdminSidebar user={user} activeView={activeView} onViewChange={setActiveView} onLogout={handleLogout} />
      <main className="flex-1 flex flex-col overflow-hidden">
        {activeView === "dashboard" && <DashboardView user={user} />}
        {activeView === "routes" && <RoutesView user={user} />}
        {activeView === "users" && <UsersView user={user} />}
      </main>
    </div>
  );
}
