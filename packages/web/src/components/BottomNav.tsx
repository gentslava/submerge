import { Link } from "@tanstack/react-router";
import { Menu, Radio } from "lucide-react";
import { NAV_ITEMS } from "./nav";

const linkClass =
  "flex h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[10px] text-text-secondary [&.active]:text-accent-text";

export function BottomNav() {
  return (
    <nav className="md:hidden fixed bottom-0 inset-x-0 flex border-t border-border-subtle bg-surface">
      {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
        <Link key={to} to={to} activeOptions={{ exact: to === "/" }} className={linkClass}>
          <Icon size={18} />
          {label}
        </Link>
      ))}
      {/* Disabled placeholder */}
      {/* biome-ignore lint/a11y/useSemanticElements: inert "coming soon" entry — a real <a> would imply a navigable destination */}
      <div
        role="link"
        aria-disabled="true"
        aria-label="Трафик (скоро)"
        tabIndex={-1}
        className="flex h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[10px] text-text-disabled cursor-not-allowed"
      >
        <Radio size={18} />
        Трафик
      </div>
      <Link to="/more" className={linkClass}>
        <Menu size={18} />
        Ещё
      </Link>
    </nav>
  );
}
