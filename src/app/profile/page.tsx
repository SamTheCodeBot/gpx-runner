"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { useUserProfile, useAccountDeletion } from "@/lib/hooks";
import { Icon } from "@/components/ui";

const RUNNING_AVATARS = [
  { icon: "directions_run",          label: "The Classic",          color: "#006d43" },
  { icon: "hiking",                  label: "Trail Blazer",        color: "#7c5c00" },
  { icon: "sprint",                  label: "Speedster",           color: "#910000" },
  { icon: "terrain",                 label: "Mountain Goat",       color: "#00527a" },
  { icon: "timer",                   label: "Marathoner",          color: "#5b0099" },
  { icon: "footprint",               label: "Consistent Strider",  color: "#7a3d00" },
  { icon: "sports_martial_arts",    label: "Race Day Hero",       color: "#b30000" },
  { icon: "pool",                    label: "Dawn Patroller",      color: "#006a6a" },
  { icon: "fitness_center",         label: "Ultra Runner",        color: "#3d3d00" },
  { icon: "bolt",                    label: "Sunset Chaser",        color: "#830046" },
];

function getGreeting() {
  const h = new Date().getHours();
  if (h < 6)  return "Night owl runner";
  if (h < 12) return "Morning runner";
  if (h < 17) return "Afternoon runner";
  if (h < 21) return "Evening runner";
  return "Night owl runner";
}

export default function ProfilePage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();

  // Wait for Firebase auth to initialize before making any routing decisions
  useEffect(() => {
    if (authLoading) return; // still initializing
    if (!user) router.replace("/"); // not signed in
  }, [user, authLoading, router]);

  const { profile, saveProfile, loading: profileLoading } = useUserProfile(user?.uid ?? null);
  const { deleteAccount, isDeleting, error: deleteError } = useAccountDeletion();

  const [displayName, setDisplayName] = useState(profile?.displayName || user?.email?.split("@")[0] || "Runner");
  const [avatar, setAvatar]           = useState(profile?.avatar || "directions_run");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwError, setPwError]        = useState("");
  const [pwSuccess, setPwSuccess]    = useState("");
  const [isChangingPw, setIsChangingPw] = useState(false);
  const [saving, setSaving]          = useState(false);
  const [saved, setSaved]             = useState(false);
  const [saveError, setSaveError]     = useState("");

  // Delete account two-step state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deletePassword, setDeletePassword]       = useState("");

  // Sync displayName/avatar when profile loads
  useEffect(() => {
    if (profile) {
      if (profile.displayName) setDisplayName(profile.displayName);
      if (profile.avatar)     setAvatar(profile.avatar);
    }
  }, [profile]);

  const greeting  = getGreeting();
  const joinedAt  = profile?.joinedAt
    ? new Date(profile.joinedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
    : "Just joined";

  const handleSave = async () => {
    if (!displayName.trim()) return;
    setSaving(true);
    setSaveError("");
    try {
      await saveProfile({ displayName: displayName.trim(), avatar });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e: any) {
      if (e?.message === "DUPLICATE_NAME") {
        setSaveError(`The name "${displayName.trim()}" is already taken. Please choose another.`);
      } else {
        setSaveError(e?.message || "Failed to save. Please try again.");
      }
    } finally {
      setSaving(false);
    }
  };

  const handlePasswordChange = async () => {
    setPwError("");
    if (newPassword !== confirmPassword) { setPwError("Passwords don't match"); return; }
    if (newPassword.length < 6) { setPwError("Password must be at least 6 characters"); return; }
    setIsChangingPw(true);
    try {
      const { updatePassword } = await import("firebase/auth");
      const { auth } = await import("@/lib/firebase");
      if (auth?.currentUser) {
        await updatePassword(auth?.currentUser, newPassword);
        setPwSuccess("Password updated!");
        setNewPassword(""); setConfirmPassword("");
        setTimeout(() => setPwSuccess(""), 3000);
      }
    } catch (e: any) {
      setPwError(e?.message || "Failed to update password");
    } finally {
      setIsChangingPw(false);
    }
  };

  const handleDeleteClick = () => {
    setShowDeleteConfirm(true);
  };

  const handleDeleteConfirm = async () => {
    if (!deletePassword.trim()) return;
    await deleteAccount(user!.uid, deletePassword);
  };

  if (!user || profileLoading) {
    return (
      <div className="min-h-screen bg-background flex flex-col">
        <header className="bg-surface-container-lowest border-b border-outline-variant/20 px-4 py-3 flex items-center gap-3">
          <Link href="/" className="flex items-center gap-2 text-on-surface-variant hover:text-on-surface transition-colors">
            <Icon name="arrow_back" className="text-xl" />
            <span className="text-sm font-medium">My Routes</span>
          </Link>
          <div className="flex-1" />
          <span className="text-xs text-on-surface-variant font-medium">GPX running</span>
        </header>
        <main className="flex-1 flex justify-center items-start py-8 px-4">
          <div className="w-full max-w-md space-y-6 animate-pulse">
            <div className="text-center">
              <div className="h-8 w-20 mx-auto bg-surface-container rounded-xl" />
              <div className="h-4 w-32 mx-auto bg-surface-container rounded-xl mt-2" />
            </div>
            <div className="bg-surface-container-lowest rounded-3xl p-6 shadow-sm border border-outline-variant/10">
              <div className="grid grid-cols-5 gap-2">
                {[...Array(10)].map((_, i) => (
                  <div key={i} className="aspect-square bg-surface-container rounded-2xl" />
                ))}
              </div>
            </div>
            <div className="bg-surface-container-lowest rounded-3xl p-6 shadow-sm border border-outline-variant/10">
              <div className="h-4 bg-surface-container rounded-xl w-24 mb-2" />
              <div className="h-10 bg-surface-container rounded-xl" />
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">

      {/* Top bar */}
      <header className="bg-surface-container-lowest border-b border-outline-variant/20 px-4 py-3 flex items-center gap-3">
        <Link href="/" className="flex items-center gap-2 text-on-surface-variant hover:text-on-surface transition-colors">
          <Icon name="arrow_back" className="text-xl" />
          <span className="text-sm font-medium">My Routes</span>
        </Link>
        <div className="flex-1" />
        <span className="text-xs text-on-surface-variant font-medium">GPX running</span>
      </header>

      {/* Page content */}
      <main className="flex-1 flex justify-center items-start py-8 px-4">
        <div className="w-full max-w-md space-y-6">

          {/* Header */}
          <div className="text-center">
            <h1 className="text-2xl font-extrabold text-on-surface font-headline">Profile</h1>
            <p className="text-sm text-on-surface-variant mt-1">{greeting}</p>
          </div>

          {/* Avatar picker */}
          <div className="bg-surface-container-lowest rounded-3xl p-6 shadow-sm border border-outline-variant/10">
            <p className="text-[10px] font-extrabold uppercase tracking-wider text-on-surface-variant mb-3">Choose your avatar</p>
            <div className="grid grid-cols-5 gap-2">
              {RUNNING_AVATARS.map(({ icon, label, color }) => (
                <button
                  key={icon}
                  onClick={() => setAvatar(icon)}
                  title={label}
                  className={`w-full aspect-square rounded-2xl flex items-center justify-center transition-all ${
                    avatar === icon
                      ? "ring-2 ring-primary ring-offset-2 ring-offset-surface-container-lowest scale-105"
                      : "bg-surface-container hover:bg-surface-high"
                  }`}
                  style={avatar === icon ? { backgroundColor: color + "20" } : {}}
                >
                  <span
                    className="material-symbols-outlined text-2xl"
                    style={{ color: avatar === icon ? color : "var(--color-on-surface-variant)" }}
                  >
                    {icon}
                  </span>
                </button>
              ))}
            </div>
            {avatar && (
              <p className="text-center mt-2 text-xs font-medium text-on-surface-variant">
                {RUNNING_AVATARS.find(a => a.icon === avatar)?.label}
              </p>
            )}
          </div>

          {/* Name field */}
          <div className="bg-surface-container-lowest rounded-3xl p-6 shadow-sm border border-outline-variant/10">
            <label className="text-[10px] font-extrabold uppercase tracking-wider text-on-surface-variant block mb-1.5">Display Name</label>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full px-3 py-2.5 bg-surface-container border border-outline-variant rounded-xl text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:ring-2 focus:ring-primary/30 transition-shadow"
            />
            {saveError && (
              <div className="mt-2 px-3 py-2 bg-error-container text-error text-xs rounded-xl">{saveError}</div>
            )}
            <button
              onClick={handleSave}
              disabled={saving || !displayName.trim()}
              className="mt-3 w-full py-3 bg-primary text-on-primary rounded-xl text-sm font-bold hover:opacity-90 transition-opacity disabled:opacity-40 flex items-center justify-center gap-2"
            >
              {saving
                ? <><Icon name="progress_activity" className="text-base animate-spin" /> Saving…</>
                : saved
                  ? <><Icon name="check" className="text-base" /> Saved!</>
                  : "Save Profile"
              }
            </button>
          </div>

          {/* Email (read-only) */}
          <div className="bg-surface-container-lowest rounded-3xl p-6 shadow-sm border border-outline-variant/10">
            <label className="text-[10px] font-extrabold uppercase tracking-wider text-on-surface-variant block mb-1.5">Email (login)</label>
            <div className="px-3 py-2.5 bg-surface-dim border border-outline-variant rounded-xl text-sm text-on-surface-variant">
              {user.email}
            </div>
            <p className="text-[10px] text-on-surface-variant/60 mt-1">Email cannot be changed</p>
          </div>

          {/* Stats */}
          {profile && (profile.totalRuns > 0 || profile.totalDistance > 0) && (
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-surface-container-lowest rounded-3xl p-6 shadow-sm border border-outline-variant/10 text-center">
                <p className="text-2xl font-extrabold text-primary">{profile.totalRuns}</p>
                <p className="text-[10px] font-extrabold uppercase tracking-wider text-on-surface-variant mt-0.5">Runs</p>
              </div>
              <div className="bg-surface-container-lowest rounded-3xl p-6 shadow-sm border border-outline-variant/10 text-center">
                <p className="text-2xl font-extrabold text-primary">{profile.totalDistance.toFixed(0)}</p>
                <p className="text-[10px] font-extrabold uppercase tracking-wider text-on-surface-variant mt-0.5">km logged</p>
              </div>
            </div>
          )}

          {/* Change password */}
          <div className="bg-surface-container-lowest rounded-3xl p-6 shadow-sm border border-outline-variant/10">
            <p className="text-[10px] font-extrabold uppercase tracking-wider text-on-surface-variant mb-3">Change Password</p>
            <div className="space-y-2">
              <input
                type="password"
                placeholder="New password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="w-full px-3 py-2.5 bg-surface-container border border-outline-variant rounded-xl text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:ring-2 focus:ring-primary/30 transition-shadow"
              />
              <input
                type="password"
                placeholder="Confirm new password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handlePasswordChange()}
                className="w-full px-3 py-2.5 bg-surface-container border border-outline-variant rounded-xl text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:ring-2 focus:ring-primary/30 transition-shadow"
              />
              {pwError && <p className="text-xs text-error font-medium">{pwError}</p>}
              {pwSuccess && <p className="text-xs text-secondary font-medium">{pwSuccess}</p>}
              <button
                onClick={handlePasswordChange}
                disabled={isChangingPw || !newPassword || !confirmPassword}
                className="w-full py-2.5 border border-outline-variant rounded-xl text-sm font-medium text-on-surface hover:bg-surface-container transition-colors disabled:opacity-40 flex items-center justify-center gap-2"
              >
                {isChangingPw
                  ? <><Icon name="progress_activity" className="text-base animate-spin" /> Updating…</>
                  : "Update Password"
                }
              </button>
            </div>
          </div>

          {/* Delete account */}
          <div className="bg-surface-container-lowest rounded-3xl p-6 shadow-sm border border-error/20">
            <div className="flex items-center gap-2 mb-2">
              <Icon name="warning" className="text-error text-base" />
              <p className="text-[10px] font-extrabold uppercase tracking-wider text-error">Delete Account</p>
            </div>
            <p className="text-xs text-on-surface-variant mb-3">
              Permanently delete your account. All your routes will become anonymous (&quot;a runner&quot;) and your GPX files will be removed. This cannot be undone.
            </p>

            {!showDeleteConfirm ? (
              <button
                onClick={handleDeleteClick}
                className="w-full py-2.5 bg-error-container text-error rounded-xl text-sm font-bold hover:opacity-90 transition-opacity flex items-center justify-center gap-2"
              >
                <Icon name="delete_forever" className="text-base" />
                Delete my account
              </button>
            ) : (
              <div className="space-y-2">
                <div className="bg-error/10 border border-error/20 rounded-xl p-3">
                  <p className="text-xs text-error font-bold mb-1">This action is irreversible.</p>
                  <p className="text-xs text-on-surface-variant">All routes will be kept as &quot;a runner&quot;. Enter your password and click below to confirm.</p>
                </div>
                <input
                  type="password"
                  placeholder="Enter your password"
                  value={deletePassword}
                  onChange={(e) => setDeletePassword(e.target.value)}
                  className="w-full px-3 py-2.5 bg-surface-container border border-outline-variant rounded-xl text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:ring-2 focus:ring-error/30 transition-shadow"
                />
                {deleteError && (
                  <p className="text-xs text-error font-medium">{deleteError}</p>
                )}
                <div className="flex gap-2">
                  <button
                    onClick={() => { setShowDeleteConfirm(false); setDeletePassword(""); }}
                    className="flex-1 py-2.5 border border-outline-variant rounded-xl text-sm font-medium text-on-surface hover:bg-surface-container transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleDeleteConfirm}
                    disabled={isDeleting || !deletePassword}
                    className="flex-1 py-2.5 bg-error text-on-error rounded-xl text-sm font-bold hover:opacity-90 transition-opacity disabled:opacity-40 flex items-center justify-center gap-2"
                  >
                    {isDeleting
                      ? <><Icon name="progress_activity" className="text-base animate-spin" /> Deleting…</>
                      : <><Icon name="delete_forever" className="text-base" /> Yes, delete forever</>
                    }
                  </button>
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="text-center text-[10px] text-on-surface-variant/60">
            {greeting} · {joinedAt}
          </div>

        </div>
      </main>
    </div>
  );
}
