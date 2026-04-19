"use client";

import { useState, useEffect } from "react";
import { Icon } from "./ui";
import type { User } from "firebase/auth";
import type { UserProfile } from "@/app/types";
import { useAccountDeletion } from "@/lib/hooks";

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
  { icon: "bolt",                    label: "Sunset Chaser",      color: "#830046" },
];

function getGreeting() {
  const h = new Date().getHours();
  if (h < 6)  return "Night owl runner";
  if (h < 12) return "Morning runner";
  if (h < 17) return "Afternoon runner";
  if (h < 21) return "Evening runner";
  return "Night owl runner";
}

interface UserProfileModalProps {
  user: User;
  profile: UserProfile | null;
  onSave: (data: Partial<UserProfile>) => Promise<void>;
  onClose: () => void;
}

export function UserProfileModal({ user, profile, onSave, onClose }: UserProfileModalProps) {
  const [displayName, setDisplayName] = useState(profile?.displayName || user.email?.split("@")[0] || "Runner");
  const [avatar, setAvatar]           = useState(profile?.avatar || "directions_run");
  const [password, setPassword]       = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [pwError, setPwError]        = useState("");
  const [pwSuccess, setPwSuccess]    = useState("");
  const [isChangingPw, setIsChangingPw] = useState(false);
  const [saving, setSaving]          = useState(false);
  const [saved, setSaved]             = useState(false);
  const [saveError, setSaveError]     = useState("");
  const [deletePassword, setDeletePassword] = useState("");
  const { deleteAccount, isDeleting, error: deleteError } = useAccountDeletion();

  // Sync state when profile loads from Firestore
  useEffect(() => {
    if (profile) {
      if (profile.displayName && profile.displayName !== displayName) {
        setDisplayName(profile.displayName);
      }
      if (profile.avatar && profile.avatar !== avatar) {
        setAvatar(profile.avatar);
      }
    }
  }, [profile]);

  const greeting = getGreeting();
  const joinedAt = profile?.joinedAt
    ? new Date(profile.joinedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
    : "Just joined";

  const handleSave = async () => {
    if (!displayName.trim()) return;
    setSaving(true);
    setSaveError("");
    try {
      await onSave({ displayName: displayName.trim(), avatar });
      setSaved(true);
      setTimeout(() => { window.location.reload(); }, 800);
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
        await updatePassword(auth.currentUser, newPassword);
        setPwSuccess("Password updated!");
        setPassword(""); setNewPassword(""); setConfirmPassword("");
        setTimeout(() => setPwSuccess(""), 3000);
      }
    } catch (e: any) {
      setPwError(e?.message || "Failed to update password");
    } finally {
      setIsChangingPw(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (!deletePassword) return;
    if (!confirm(`Are you absolutely sure? This will permanently delete your account and make all your routes anonymous. This cannot be undone.`)) return;
    await deleteAccount(user.uid, deletePassword);
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" onClick={onClose} />

      {/* Panel */}
      <div className="relative bg-surface-container-lowest rounded-3xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto custom-scrollbar animate-fade-in">

        {/* Header */}
        <div className="sticky top-0 bg-surface-container-lowest z-10 px-6 pt-6 pb-4 flex items-center justify-between border-b border-outline-variant/10">
          <div>
            <h2 className="text-base font-extrabold text-primary font-headline">Profile</h2>
            <p className="text-xs text-on-surface-variant mt-0.5">{greeting}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-xl hover:bg-surface-container transition-colors">
            <Icon name="close" className="text-on-surface-variant text-sm" />
          </button>
        </div>

        <div className="px-6 pb-6 space-y-6">

          {/* Avatar picker */}
          <div>
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
          <div>
            <label className="text-[10px] font-extrabold uppercase tracking-wider text-on-surface-variant block mb-1.5">Display Name</label>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="w-full px-3 py-2.5 bg-surface-container border border-outline-variant rounded-xl text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:ring-2 focus:ring-primary/30 transition-shadow"
            />
          </div>

          {/* Save error */}
          {saveError && (
            <div className="px-3 py-2 bg-error-container text-error text-xs rounded-xl">{saveError}</div>
          )}

          {/* Save button */}
          <button
            onClick={handleSave}
            disabled={saving || !displayName.trim()}
            className="w-full py-3 bg-primary text-on-primary rounded-xl text-sm font-bold hover:opacity-90 transition-opacity disabled:opacity-40 flex items-center justify-center gap-2"
          >
            {saving
              ? <><Icon name="progress_activity" className="text-base animate-spin" /> Saving…</>
              : saved
                ? <><Icon name="check" className="text-base" /> Saved!</>
                : "Save Profile"
            }
          </button>

          <div className="border-t border-outline-variant/20" />

          {/* Email (read-only) */}
          <div>
            <label className="text-[10px] font-extrabold uppercase tracking-wider text-on-surface-variant block mb-1.5">Email (login)</label>
            <div className="px-3 py-2.5 bg-surface-dim border border-outline-variant rounded-xl text-sm text-on-surface-variant">
              {user.email}
            </div>
            <p className="text-[10px] text-on-surface-variant/60 mt-1">Email cannot be changed</p>
          </div>

          {/* Stats summary */}
          {profile && (profile.totalRuns > 0 || profile.totalDistance > 0) && (
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-surface-container rounded-2xl p-4 text-center">
                <p className="text-2xl font-extrabold text-primary">{profile.totalRuns}</p>
                <p className="text-[10px] font-extrabold uppercase tracking-wider text-on-surface-variant mt-0.5">Runs</p>
              </div>
              <div className="bg-surface-container rounded-2xl p-4 text-center">
                <p className="text-2xl font-extrabold text-primary">{profile.totalDistance.toFixed(0)}</p>
                <p className="text-[10px] font-extrabold uppercase tracking-wider text-on-surface-variant mt-0.5">km logged</p>
              </div>
            </div>
          )}

          <div className="border-t border-outline-variant/20" />

          {/* Password change */}
          <div>
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
          <div>
            <p className="text-[10px] font-extrabold uppercase tracking-wider text-error mb-3">Delete Account</p>
            <p className="text-xs text-on-surface-variant mb-3">
              Permanently delete your account and anonymize all your routes (they will belong to &quot;a runner&quot;). This cannot be undone.
            </p>
            <input
              type="password"
              placeholder="Enter your password to confirm"
              value={deletePassword}
              onChange={(e) => setDeletePassword(e.target.value)}
              className="w-full px-3 py-2.5 bg-surface-container border border-outline-variant rounded-xl text-sm text-on-surface placeholder:text-on-surface-variant/50 focus:outline-none focus:ring-2 focus:ring-error/30 transition-shadow mb-2"
            />
            {deleteError && <p className="text-xs text-error font-medium mb-2">{deleteError}</p>}
            <button
              onClick={handleDeleteAccount}
              disabled={isDeleting || !deletePassword}
              className="w-full py-2.5 bg-error-container text-error rounded-xl text-sm font-bold hover:opacity-90 transition-opacity disabled:opacity-40 flex items-center justify-center gap-2"
            >
              {isDeleting
                ? <><Icon name="progress_activity" className="text-base animate-spin" /> Deleting…</>
                : <><Icon name="warning" className="text-base" /> Delete my account</>
              }
            </button>
          </div>

          <div className="border-t border-outline-variant/20" />

          {/* Footer info */}
          <div className="flex items-center justify-between text-[10px] text-on-surface-variant/60">
            <span>{greeting} · {joinedAt}</span>
            <span className="uppercase tracking-wider">GPX running</span>
          </div>

        </div>
      </div>
    </div>
  );
}
