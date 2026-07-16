import { Link, useRouterState } from "@tanstack/react-router";
import { Ellipsis } from "lucide-react";
import { toast } from "sonner";
import { NAV_MOBILE_MORE, NAV_MOBILE_PRIMARY } from "./nav";

const linkClass =
  "flex h-12 w-1/5 shrink-0 flex-col items-center justify-center gap-1 px-0.5 text-fine font-medium text-text-tertiary [&.active]:font-semibold [&.active]:text-accent-text";

export function BottomNav() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const moreActive = NAV_MOBILE_MORE.some(
    (entry) => entry.kind === "link" && entry.to === pathname,
  );
  return (
    <nav
      data-popup-bottom-boundary
      className="fixed inset-x-0 bottom-0 z-30 flex min-h-[var(--mobile-bottom-nav-height)] border-t border-border-subtle bg-surface pb-[max(12px,env(safe-area-inset-bottom))] pt-2 md:hidden"
    >
      {NAV_MOBILE_PRIMARY.map((entry) => {
        const { label, icon: Icon } = entry;
        if (entry.kind === "placeholder") {
          return (
            <button
              key={label}
              type="button"
              onClick={() => toast.info(`Раздел «${label}» пока в разработке`)}
              className={`${linkClass} text-text-tertiary`}
            >
              <Icon size={21} className="shrink-0" />
              <span className="w-full truncate text-center">{label}</span>
            </button>
          );
        }
        return (
          <Link
            key={entry.to}
            to={entry.to}
            activeOptions={{ exact: entry.to === "/" }}
            className={linkClass}
          >
            <Icon size={21} className="shrink-0" />
            <span className="w-full truncate text-center">{label}</span>
          </Link>
        );
      })}
      <Link
        to="/more"
        aria-current={moreActive ? "page" : undefined}
        className={`${linkClass}${moreActive ? " active" : ""}`}
      >
        <Ellipsis size={21} className="shrink-0" />
        <span className="w-full truncate text-center">Ещё</span>
      </Link>
    </nav>
  );
}
