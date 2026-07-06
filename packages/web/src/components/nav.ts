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
  { kind: "link", to: "/connections", label: "Соединения", icon: Cable },
  { kind: "link", to: "/routing", label: "Маршрутизация", icon: Route },
  { kind: "placeholder", label: "Логи", icon: SquareTerminal },
  { kind: "link", to: "/sources", label: "Источники", icon: Layers },
  { kind: "placeholder", label: "Диагностика", icon: Stethoscope },
  { kind: "link", to: "/settings", label: "Настройки", icon: Settings },
];

/** Routes that have real screens — used by the mobile BottomNav. */
export const NAV_LINKS: NavLink[] = NAV_ENTRIES.filter((e): e is NavLink => e.kind === "link");
