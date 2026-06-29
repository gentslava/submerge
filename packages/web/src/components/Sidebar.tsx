import { Link } from "@tanstack/react-router";
import { Activity, Inbox, Radio, ScrollText, Settings, Waypoints } from "lucide-react";
import { StatusDot } from "./StatusDot";
import { ThemeToggle } from "./ThemeToggle";

const NAV = [
  { to: "/", label: "Узлы", icon: Activity },
  { to: "/sources", label: "Источники", icon: Inbox },
  { to: "/settings", label: "Настройки", icon: Settings },
] as const;

const SOON = [
  { label: "Трафик", icon: Radio },
  { label: "Соединения", icon: Waypoints },
  { label: "Логи", icon: ScrollText },
] as const;

export function Sidebar() {
  return (
    <aside className="hidden md:flex w-60 shrink-0 flex-col gap-1 border-r border-border-subtle bg-surface p-3">
      <div className="px-2 py-3 font-semibold text-text-primary">submerge</div>
      <StatusDot />
      <nav className="mt-3 flex flex-col gap-1">
        {NAV.map(({ to, label, icon: Icon }) =>
          to === "/" ? (
            <Link
              key={to}
              to={to}
              activeOptions={{ exact: true }}
              className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-text-secondary hover:bg-hover [&.active]:bg-accent-bg [&.active]:text-accent-text"
            >
              <Icon size={16} /> {label}
            </Link>
          ) : (
            <Link
              key={to}
              to={to}
              className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-text-secondary hover:bg-hover [&.active]:bg-accent-bg [&.active]:text-accent-text"
            >
              <Icon size={16} /> {label}
            </Link>
          ),
        )}
      </nav>
      <div className="mt-4 mb-1 px-2.5 text-[11px] font-semibold tracking-wide text-text-tertiary">
        СКОРО
      </div>
      <div className="flex flex-col gap-1">
        {SOON.map(({ label, icon: Icon }) => (
          <div
            key={label}
            className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-text-disabled cursor-not-allowed"
          >
            <Icon size={16} /> {label}
          </div>
        ))}
      </div>
      <div className="mt-auto flex flex-col gap-2">
        <div className="rounded-md bg-elevated px-2.5 py-1.5 font-mono text-xs text-text-tertiary">
          SOCKS · 127.0.0.1:7890
        </div>
        <ThemeToggle />
      </div>
    </aside>
  );
}
