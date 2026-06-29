import { Activity, Inbox, Settings } from "lucide-react";
import type { ComponentType } from "react";

export interface NavItem {
  to: "/" | "/sources" | "/settings";
  label: string;
  icon: ComponentType<{ size?: number }>;
}

export const NAV_ITEMS: NavItem[] = [
  { to: "/", label: "Узлы", icon: Activity },
  { to: "/sources", label: "Источники", icon: Inbox },
  { to: "/settings", label: "Настройки", icon: Settings },
];
