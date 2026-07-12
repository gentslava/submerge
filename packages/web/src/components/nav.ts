import {
  Activity,
  Cable,
  Layers,
  type LucideIcon,
  Route,
  Server,
  Settings,
  SquareTerminal,
  Stethoscope,
} from "lucide-react";

/** A nav entry that routes to a real screen (functional <Link>). */
export interface NavLink {
  kind: "link";
  to: "/" | "/sources" | "/connections" | "/routing" | "/settings";
  label: string;
  icon: LucideIcon;
  // Mobile only: `secondary` links live under "Ещё" instead of the bottom bar
  // (keeps the bottom nav uncrowded). They still appear in the desktop sidebar.
  secondary?: boolean;
}

/**
 * A nav entry with no screen yet — rendered inert (no route, no navigation),
 * dimmed and tagged "СКОРО".
 */
export interface NavPlaceholder {
  kind: "placeholder";
  label: string;
  icon: LucideIcon;
}

export type NavEntry = NavLink | NavPlaceholder;

/**
 * The 8 sidebar nav items, in mockup order. Узлы / Источники / Маршрутизация /
 * Настройки are real routes; the rest have no screens yet and render as inert
 * placeholders.
 */
export const NAV_ENTRIES: NavEntry[] = [
  { kind: "link", to: "/", label: "Узлы", icon: Server },
  { kind: "placeholder", label: "Трафик", icon: Activity },
  { kind: "link", to: "/connections", label: "Соединения", icon: Cable, secondary: true },
  { kind: "link", to: "/routing", label: "Маршрутизация", icon: Route },
  { kind: "placeholder", label: "Логи", icon: SquareTerminal },
  { kind: "link", to: "/sources", label: "Источники", icon: Layers },
  { kind: "placeholder", label: "Диагностика", icon: Stethoscope },
  { kind: "link", to: "/settings", label: "Настройки", icon: Settings },
];

// The phone tab bar is deliberately task-focused: status / traffic / logs / sources
// stay one tap away, while configuration pages move under «Ещё». Placeholder tabs
// acknowledge taps with an explicit "in development" message until their routes exist.
const MOBILE_PRIMARY_LABELS = new Set(["Узлы", "Трафик", "Логи", "Источники"]);
export const NAV_MOBILE_PRIMARY: NavEntry[] = NAV_ENTRIES.filter((entry) =>
  MOBILE_PRIMARY_LABELS.has(entry.label),
);

/** Real configuration pages and diagnostics surfaced by the mobile «Ещё» screen. */
export const NAV_MOBILE_MORE: NavEntry[] = NAV_ENTRIES.filter(
  (entry) => !MOBILE_PRIMARY_LABELS.has(entry.label),
);
