import { Link } from "@tanstack/react-router";
import { Power } from "lucide-react";
import { useAuthStatus, useLogout } from "@/features/auth/useAuth";
import { NAV_ENTRIES, type NavEntry } from "./nav";
import { ProxyStatusCard } from "./ProxyStatusCard";

export function Sidebar() {
  return (
    <aside className="hidden md:flex h-dvh w-[248px] shrink-0 flex-col justify-between border-r border-border-subtle bg-surface pt-5 pr-3.5 pb-[18px] pl-3.5">
      <div className="flex flex-col gap-6">
        <Brand />
        <nav className="flex flex-col gap-0.5">
          {NAV_ENTRIES.map((entry) => (
            <NavRow key={entry.label} entry={entry} />
          ))}
        </nav>
      </div>

      <div className="flex flex-col gap-3">
        <ProxyStatusCard />
        <LogoutRow />
      </div>
    </aside>
  );
}

// Brand mark — periscope surfacing through waves (the approved logo), drawn white
// on the accent tile. The full logo (with shadow + wordmark) lives in public/logo.svg.
function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="11.68 6.5 108 108" className={className} aria-hidden="true">
      <rect x="11.68" y="6.5" width="108" height="108" rx="31" fill="#6366f1" />
      <g fill="none" stroke="#fff" strokeWidth={4} strokeLinecap="round" strokeLinejoin="round">
        <circle cx="65.68" cy="45.5" r="15" />
        <circle cx="65.68" cy="45.5" r="8.6" />
        <path d="M59.68 67.87h12" />
        <path d="M59.68 59.25v17.25" />
        <path d="M71.68 59.25v17.25" />
        <path d="M38.68 83.5c6-4 12-4 18 0s12 4 18 0 12-4 18 0" />
        <path d="M33.68 95.5c6-4 12-4 18 0s12 4 18 0 12-4 18 0 12 4 18 0" />
      </g>
    </svg>
  );
}

function Brand() {
  // Clickable → home (Узлы); padding 6 + hover box matches the mockup brand frame.
  // Line-heights mirror the mockup's text boxes (20px / 12px) so the two lines sit
  // with the right gap — leading-none cramped them together.
  return (
    <Link
      to="/"
      aria-label="submerge — на главную"
      className="flex items-center gap-2.5 rounded-md p-1.5 transition-colors hover:bg-hover"
    >
      <BrandMark className="h-[34px] w-[34px] shrink-0" />
      <span className="flex flex-col gap-px">
        <span className="font-mono text-cardtitle leading-[20px] text-text-primary">submerge</span>
        <span className="text-micro font-semibold uppercase leading-[12px] tracking-[0.8px] text-text-tertiary">
          self-hosted
        </span>
      </span>
    </Link>
  );
}

function NavRow({ entry }: { entry: NavEntry }) {
  const { icon: Icon, label } = entry;

  if (entry.kind === "link") {
    return (
      <Link
        to={entry.to}
        activeOptions={{ exact: entry.to === "/" }}
        className="flex h-10 items-center gap-2.5 rounded-md px-2.5 text-text-secondary transition-colors hover:bg-hover hover:text-text-primary [&.active]:bg-accent-bg [&.active]:text-accent-text [&.active]:hover:bg-accent-bg [&.active]:hover:text-accent-text"
      >
        <Icon size={18} className="shrink-0" />
        <span className="text-sm font-medium [.active_&]:font-semibold">{label}</span>
      </Link>
    );
  }

  // Inert placeholder — no screen yet: dimmed, non-navigating, tagged "СКОРО".
  return (
    // biome-ignore lint/a11y/useSemanticElements: inert nav entry — a real <a> would imply a navigable destination
    <div
      role="link"
      aria-disabled="true"
      aria-label={`${label} (скоро)`}
      tabIndex={-1}
      className="flex h-10 cursor-default items-center gap-2.5 rounded-md px-2.5 text-text-secondary opacity-50"
    >
      <Icon size={18} className="shrink-0" />
      <span className="flex-1 text-sm font-medium">{label}</span>
      <span className="rounded-full bg-hover px-[7px] py-0.5 text-[9px] font-semibold tracking-[0.4px] text-text-secondary">
        СКОРО
      </span>
    </div>
  );
}

function LogoutRow() {
  const { data: authStatus } = useAuthStatus();
  const logout = useLogout();

  // Render only when auth is enabled.
  if (!authStatus?.required) return null;

  return (
    <button
      type="button"
      onClick={() => logout.mutate()}
      className="flex items-center gap-[9px] rounded-md px-2.5 py-2 text-text-tertiary hover:text-text-secondary"
    >
      <Power size={16} />
      <span className="text-sub">Выйти</span>
    </button>
  );
}
