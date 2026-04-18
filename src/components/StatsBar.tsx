"use client";

import { StatCard } from "./ui";
import type { RouteStats } from "@/lib/hooks";

export function StatsBar({ stats }: { stats: RouteStats | null }) {
  return (
    <div className="grid grid-cols-3 gap-3 md:gap-5">
      <StatCard label="Total Runs" value={stats?.totalRuns?.toString() ?? "0"} icon="directions_run" />
      <StatCard label="Total Distance" value={stats?.totalDistance?.toString() ?? "0"} unit="km" icon="distance" />
      <StatCard label="Total Elevation" value={stats?.totalElevation?.toString() ?? "0"} unit="m" icon="terrain" />
    </div>
  );
}
