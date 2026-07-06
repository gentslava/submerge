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

/** Routes that have real screens. */
export const NAV_LINKS: NavLink[] = NAV_ENTRIES.filter((e): e is NavLink => e.kind === "link");

/** Primary links shown in the mobile bottom bar (everything except `secondary`). */
export const NAV_PRIMARY_LINKS: NavLink[] = NAV_LINKS.filter((l) => !l.secondary);

/** Secondary links surfaced on the mobile "Ещё" screen instead of the bottom bar. */
export const NAV_SECONDARY_LINKS: NavLink[] = NAV_LINKS.filter((l) => l.secondary);
