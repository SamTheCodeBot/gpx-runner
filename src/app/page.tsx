'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import dynamic from 'next/dynamic';
import {
  doc,
  setDoc,
  deleteDoc,
  collection,
  onSnapshot,
  query,
  serverTimestamp,
} from 'firebase/firestore';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { db, storage } from '@/lib/firebase';
import { useAuth } from '@/lib/auth';
import { GPXRoute, RouteFilter } from './types';
import { parseGpxToTrackPoints } from '@/engine/gpx';

const Map = dynamic(() => import('@/components/Map'), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full bg-surface-dim flex items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <div className="w-10 h-10 border-4 border-primary border-t-transparent rounded-full animate-spin" />
        <p className="text-sm text-on-surface-variant font-label">Loading map…</p>
      </div>
    </div>
  ),
});

function haversineDistance(coord1: [number, number], coord2: [number, number]): number {
  const R = 6371;
  const dLat = ((coord2[1] - coord1[1]) * Math.PI) / 180;
  const dLon = ((coord2[0] - coord1[0]) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((coord1[1] * Math.PI) / 180) *
      Math.cos((coord2[1] * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

const ROUTE_COLORS: Record<string, string> = {
  road: '#001b44',
  trail: '#006d43',
};

function getRouteColor(type?: string): string {
  return ROUTE_COLORS[type ?? 'road'] ?? '#001b44';
}

function parseGpxToRouteData(xml: string): {
  coordinates: [number, number][];
  distanceKm: number;
  elevationGainM: number;
} {
  const parser = new DOMParser();
  const doc2 = parser.parseFromString(xml, 'text/xml');
  const pts = Array.from(doc2.querySelectorAll('trkpt')) as Element[];

  const coordinates: [number, number][] = pts.map((p) => [
    parseFloat(p.getAttribute('lon') ?? '0'),
    parseFloat(p.getAttribute('lat') ?? '0'),
  ]);

  const elevations: number[] = pts
    .map((p) => {
      const el = p.querySelector('ele');
      return el ? parseFloat(el.textContent ?? '0') : NaN;
    })
    .filter((e) => !isNaN(e));

  let distanceKm = 0;
  for (let i = 1; i < coordinates.length; i++) {
    distanceKm += haversineDistance(coordinates[i - 1], coordinates[i]);
  }

  let elevationGainM = 0;
  for (let i = 1; i < elevations.length; i++) {
    const diff = elevations[i] - elevations[i - 1];
    if (diff > 0) elevationGainM += diff;
  }

  return { coordinates, distanceKm, elevationGainM };
}

function generateGpx(name: string, coordinates: [number, number][]): string {
  const trkpts = coordinates
    .map(([lon, lat]) => `      <trkpt lat="${lat}" lon="${lon}"></trkpt>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="ApexRun">
  <trk><name>${name}</name><trkseg>
${trkpts}
  </trkseg></trk>
</gpx>`;
}

// ─── Auth Screen ─────────────────────────────────────────────────────────────
function AuthScreen({ darkMode }: { darkMode: boolean }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const bg = darkMode ? 'bg-[#1b1c1c]' : 'bg-background';
  const cardBg = darkMode ? 'bg-[#262729]' : 'bg-surface-container-lowest';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const { login, register } = await import('@/lib/auth');
      if (mode === 'login') await login(email, password);
      else await register(email, password);
    } catch (err: any) {
      setError(err.message ?? 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={`min-h-screen ${bg} flex items-center justify-center p-4`}>
      <div className={`${cardBg} rounded-3xl shadow-ambient p-8 w-full max-w-sm`}>
        <div className="flex items-center gap-3 mb-8 justify-center">
          <div className="w-10 h-10 rounded-xl bg-primary-container flex items-center justify-center">
            <span className="material-symbols-outlined text-white" style={{ fontVariationSettings: "'FILL' 1" }}>sprint</span>
          </div>
          <h1 className="text-2xl font-headline font-extrabold text-primary">Apex Run</h1>
        </div>
        <h2 className="text-lg font-headline font-bold text-on-surface mb-6 text-center">
          {mode === 'login' ? 'Welcome back' : 'Create account'}
        </h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          <input type="email" placeholder="Email address" value={email} onChange={(e) => setEmail(e.target.value)} required
            className={`w-full px-4 py-3 rounded-xl text-sm font-body outline-none focus:ring-2 focus:ring-primary/30 transition-all ${darkMode ? 'bg-[#303030] text-white placeholder:text-[#888] border border-[#444]' : 'bg-surface-container-low text-on-surface'}`} />
          <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required
            className={`w-full px-4 py-3 rounded-xl text-sm font-body outline-none focus:ring-2 focus:ring-primary/30 transition-all ${darkMode ? 'bg-[#303030] text-white placeholder:text-[#888] border border-[#444]' : 'bg-surface-container-low text-on-surface'}`} />
          {error && <p className="text-error text-xs font-label">{error}</p>}
          <button type="submit" disabled={loading}
            className="w-full bg-primary text-on-primary py-3 rounded-xl font-bold text-sm flex items-center justify-center gap-2 hover:opacity-90 active:scale-[0.98] transition-all disabled:opacity-50">
            {loading ? (
              <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              <><span className="material-symbols-outlined text-sm">{mode === 'login' ? 'login' : 'person_add'}</span>{mode === 'login' ? 'Sign In' : 'Create Account'}</>
            )}
          </button>
        </form>
        <p className="text-xs text-on-surface-variant font-label text-center mt-4">
          {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
          <button onClick={() => setMode(mode === 'login' ? 'register' : 'login')} className="text-primary font-semibold hover:underline ml-1">
            {mode === 'login' ? 'Sign up' : 'Sign in'}
          </button>
        </p>
      </div>
    </div>
  );
}

// ─── Route Edit Modal ─────────────────────────────────────────────────────────
function RouteEditModal({ route, darkMode, onSave, onClose, onDelete }: {
  route: GPXRoute; darkMode: boolean;
  onSave: (updates: Partial<GPXRoute>) => void; onClose: () => void; onDelete: () => void;
}) {
  const [name, setName] = useState(route.name);
  const [type, setType] = useState<'road' | 'trail'>(route.type ?? 'road');
  const bg = darkMode ? 'bg-[#262729]' : 'bg-surface-container-lowest';
  const inputBg = darkMode ? 'bg-[#303030] text-white border border-[#444]' : 'bg-surface-container-low text-on-surface';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <div className={`${bg} rounded-3xl shadow-ambient p-6 w-full max-w-sm`}>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-headline font-extrabold text-primary">Edit Route</h2>
          <button onClick={onClose} className="p-2 hover:bg-surface-container rounded-xl transition-colors">
            <span className="material-symbols-outlined text-on-surface-variant text-xl">close</span>
          </button>
        </div>
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-label font-semibold text-on-surface-variant mb-1.5 uppercase tracking-wider">Route Name</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)}
              className={`w-full px-4 py-3 rounded-xl text-sm font-body outline-none focus:ring-2 focus:ring-primary/30 transition-all ${inputBg}`} />
          </div>
          <div>
            <label className="block text-xs font-label font-semibold text-on-surface-variant mb-1.5 uppercase tracking-wider">Route Type</label>
            <div className="flex gap-2">
              {(['road', 'trail'] as const).map((t) => (
                <button key={t} onClick={() => setType(t)}
                  className={`flex-1 py-2.5 rounded-xl text-sm font-label font-bold uppercase tracking-wide transition-all flex items-center justify-center gap-2 ${type === t ? (t === 'road' ? 'bg-primary text-on-primary' : 'bg-secondary text-on-secondary') : darkMode ? 'bg-[#303030] text-[#aaa]' : 'bg-surface-container-low text-on-surface-variant'}`}>
                  <span className="material-symbols-outlined text-sm">{t === 'road' ? 'route' : 'terrain'}</span>{t}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="flex gap-3 mt-6">
          <button onClick={onDelete}
            className="flex-1 py-3 rounded-xl text-sm font-label font-semibold bg-error-container text-on-error-container hover:opacity-90 transition-opacity flex items-center justify-center gap-2">
            <span className="material-symbols-outlined text-sm">delete</span>Delete
          </button>
          <button onClick={() => onSave({ name: name || 'Untitled', type })}
            className="flex-1 py-3 rounded-xl text-sm font-label font-bold bg-primary text-on-primary hover:opacity-90 transition-opacity">
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Upload Modal ─────────────────────────────────────────────────────────────
function UploadModal({ darkMode, onClose, onUpload }: {
  darkMode: boolean;
  onClose: () => void;
  onUpload: (name: string, type: 'road' | 'trail', file: File) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [type, setType] = useState<'road' | 'trail'>('road');
  const [parsed, setParsed] = useState<{ distanceKm: number; elevationGainM: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bg = darkMode ? 'bg-[#262729]' : 'bg-surface-container-lowest';
  const inputBg = darkMode ? 'bg-[#303030] text-white border border-[#444]' : 'bg-surface-container-low text-on-surface';

  const handleFileChange = async (f: File) => {
    if (!f.name.endsWith('.gpx')) return;
    setFile(f);
    if (!name) setName(f.name.replace(/\.gpx$/i, ''));
    const text = await f.text();
    try { setParsed(parseGpxToRouteData(text)); } catch { /* ignore */ }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm">
      <div className={`${bg} rounded-3xl shadow-ambient p-6 w-full max-w-md`}>
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-headline font-extrabold text-primary">Upload GPX</h2>
          <button onClick={onClose} className="p-2 hover:bg-surface-container rounded-xl transition-colors">
            <span className="material-symbols-outlined text-on-surface-variant text-xl">close</span>
          </button>
        </div>
        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); const f = e.dataTransfer.files[0]; if (f) handleFileChange(f); }}
          onClick={() => fileInputRef.current?.click()}
          className={`border-2 border-dashed rounded-3xl p-8 text-center cursor-pointer transition-all ${dragging ? 'border-primary bg-primary-fixed/10' : darkMode ? 'border-[#444] hover:border-primary/50' : 'border-outline-variant hover:border-primary'}`}>
          <span className="material-symbols-outlined text-4xl text-on-surface-variant mb-3 block">{file ? 'check_circle' : 'upload_file'}</span>
          <p className="text-sm font-label font-semibold text-on-surface">{file ? file.name : 'Drop your .GPX file here'}</p>
          <p className="text-xs text-on-surface-variant mt-1 font-label">or click to browse</p>
          <input ref={fileInputRef} type="file" accept=".gpx" className="hidden" onChange={(e) => e.target.files?.[0] && handleFileChange(e.target.files[0])} />
        </div>
        {parsed && (
          <div className="mt-3 flex gap-3">
            <div className="flex-1 bg-surface-container-low rounded-xl p-3 text-center">
              <p className="text-[10px] font-label uppercase tracking-wider text-on-surface-variant">Distance</p>
              <p className="text-sm font-headline font-extrabold text-primary">{parsed.distanceKm.toFixed(1)} km</p>
            </div>
            <div className="flex-1 bg-surface-container-low rounded-xl p-3 text-center">
              <p className="text-[10px] font-label uppercase tracking-wider text-on-surface-variant">Elevation</p>
              <p className="text-sm font-headline font-extrabold text-primary">{Math.round(parsed.elevationGainM)} m</p>
            </div>
          </div>
        )}
        {file && (
          <div className="mt-4 space-y-3">
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Route name"
              className={`w-full px-4 py-3 rounded-xl text-sm font-body outline-none focus:ring-2 focus:ring-primary/30 transition-all ${inputBg}`} />
            <div className="flex gap-2">
              {(['road', 'trail'] as const).map((t) => (
                <button key={t} onClick={() => setType(t)}
                  className={`flex-1 py-2.5 rounded-xl text-sm font-label font-bold uppercase tracking-wide transition-all flex items-center justify-center gap-2 ${type === t ? (t === 'road' ? 'bg-primary text-on-primary' : 'bg-secondary text-on-secondary') : darkMode ? 'bg-[#303030] text-[#aaa]' : 'bg-surface-container-low text-on-surface-variant'}`}>
                  <span className="material-symbols-outlined text-sm">{t === 'road' ? 'route' : 'terrain'}</span>{t}
                </button>
              ))}
            </div>
            <button onClick={() => onUpload(name || file.name.replace(/\.gpx$/i, ''), type, file)}
              className="w-full bg-primary text-on-primary py-3 rounded-xl font-bold text-sm flex items-center justify-center gap-2 hover:opacity-90 active:scale-[0.98] transition-all">
              <span className="material-symbols-outlined text-sm">cloud
