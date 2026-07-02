import { Link } from "@tanstack/react-router";
import { Menu } from "lucide-react";
import { NAV_LINKS } from "./nav";

const linkClass =
  "flex h-14 flex-1 flex-col items-center justify-center gap-0.5 text-micro text-text-secondary [&.active]:text-accent-text";

export function BottomNav() {
  return (
    <nav className="md:hidden fixed bottom-0 inset-x-0 flex border-t border-border-subtle bg-surface">
      {NAV_LINKS.map(({ to, label, icon: Icon }) => (
        <Link key={to} to={to} activeOptions={{ exact: to === "/" }} className={linkClass}>
          <Icon size={18} />
          {label}
        </Link>
      ))}
      {/* Future sections (Трафик / Логи / …) live in "Ещё" as "СКОРО" rows — no dead tabs here. */}
      <Link to="/more" className={linkClass}>
        <Menu size={18} />
        Ещё
      </Link>
    </nav>
  );
}
