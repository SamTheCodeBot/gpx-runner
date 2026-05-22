"use client";

import { useState } from "react";
import { Icon } from "./ui";
import { User } from "firebase/auth";

interface AdminSidebarProps {
  user: User | null;
  activeView: string;
  onViewChange: (view: string) => void;
  onLogout: () => void;
}

export function AdminSidebar({ user, activeView, onViewChange, onLogout }: AdminSidebarProps) {
  const [collapsed, setCollapsed] = useState(false);

  const navItems = [
    { id: "dashboard", label: "Dashboard", icon: "dashboard", sublabel: "Stats overview" },
    { id: "routes", label: "Routes", icon: "map", sublabel: "All uploaded routes" },
  ];

  const isActive = (id: string) => activeView === id;

  return (
    <aside className={`hidden md:flex ${collapsed ? "w-20" : "w-64"} h-full bg-surface-container-lowest border-r border-outline-variant/20 flex-col shrink-0 overflow-visible transition-all duration-300 ease-out relative`}>
      <button
        type="button"
        onClick={() => setCollapsed(!collapsed)}
        className="absolute -right-4 top-6 z-40 flex h-8 w-8 items-center justify-center rounded-full border border-outline-variant/40 bg-surface-container-lowest text-on-surface-variant shadow-card hover:bg-surface-container-high transition-colors"
        title={collapsed ? "Expand menu" : "Collapse menu"}
        aria-label={collapsed ? "Expand menu" : "Collapse menu"}
      >
        <Icon name={collapsed ? "chevron_right" : "chevron_left"} className="text-lg" />
      </button>

      {/* Logo area */}
      <div className={collapsed ? "px-4 py-6" : "p-5"}>
        <div className={`flex items-center gap-3 ${collapsed ? "justify-center" : ""}`}>
          <div className="w-9 h-9 rounded-xl bg-primary-container flex items-center justify-center shrink-0">
            <Icon name="shield" filled className="text-on-primary-container text-xl" />
          </div>
          {!collapsed && (
            <div>
              <h1 className="text-base font-extrabold tracking-tight font-headline text-primary">Crew Captain</h1>
              <p className="text-[10px] text-on-surface-variant font-medium">Admin Dashboard</p>
            </div>
          )}
        </div>
      </div>

      {/* Nav */}
      <nav className={`flex-1 ${collapsed ? "px-3" : "px-3"} py-2 space-y-0.5 overflow-y-auto`}>
        <span className={`px-4 py-1 text-[10px] font-extrabold uppercase tracking-widest text-on-surface-variant ${collapsed ? "hidden" : ""}`}>Menu</span>

        {navItems.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onViewChange(item.id)}
            className={`w-full flex items-center ${collapsed ? "justify-center px-0" : "gap-3 px-4"} py-3 rounded-xl transition-colors ${
              isActive(item.id)
                ? "bg-primary-container text-on-primary-container"
                : "text-on-surface-variant hover:bg-surface-container-high"
            }`}
            title={item.label}
          >
            <Icon name={item.icon} filled={isActive(item.id)} className="text-base" />
            {!collapsed && (
              <div className="text-left">
                <span className="font-semibold text-sm block">{item.label}</span>
                <span className="text-[10px] text-on-surface-variant/70 block">{item.sublabel}</span>
              </div>
            )}
          </button>
        ))}
      </nav>

      {/* User section */}
      <div className={`${collapsed ? "px-3 py-5 flex-col gap-3" : "px-5 py-5"} border-t border-outline-variant/20 flex items-center justify-between`}>
        <div className={`flex items-center gap-3 ${collapsed ? "justify-center" : ""}`}>
          <div className="w-9 h-9 rounded-full bg-primary-container flex items-center justify-center shrink-0">
            <Icon name="account_circle" className="text-on-primary-container text-lg" />
          </div>
          {!collapsed && (
            <div className="min-w-0">
              <p className="text-sm font-bold text-on-surface truncate">{user?.email?.split("@")[0] || "Admin"}</p>
              <p className="text-[10px] text-on-surface-variant uppercase tracking-wider">Crew Captain</p>
            </div>
          )}
        </div>
        <button
          onClick={onLogout}
          className={`p-1.5 hover:bg-surface-container-high rounded-lg transition-colors ${collapsed ? "" : ""}`}
          title="Sign out"
        >
          <Icon name="logout" className="text-on-surface-variant text-sm" />
        </button>
      </div>
    </aside>
  );
}