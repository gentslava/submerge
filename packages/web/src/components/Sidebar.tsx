import { Link } from "@tanstack/react-router";
import { Copy, Power, RotateCw, Waves } from "lucide-react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { useAuthStatus, useLogout } from "@/features/auth/useAuth";
import { useLiveState } from "@/features/live/LiveProvider";
import { useActiveNode } from "@/features/nodes/useActiveNode";
import { PROXY_ENDPOINT } from "@/lib/constants";
import { NAV_ENTRIES, type NavEntry } from "./nav";

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
        <TogglesCard />
        <ProxyCard />
        <LogoutRow />
      </div>
    </aside>
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
      <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-md bg-accent">
        <Waves size={18} className="text-accent-fg" />
      </span>
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

  // Inert placeholder — no route/screen yet. Rendered with the mockup's row
  // markup but non-navigating.
  return (
    // biome-ignore lint/a11y/useSemanticElements: inert nav entry — a real <a> would imply a navigable destination
    <div
      role="link"
      aria-disabled="true"
      aria-label={entry.soon ? `${label} (скоро)` : label}
      tabIndex={-1}
      className={`flex h-10 cursor-default items-center gap-2.5 rounded-md px-2.5 text-text-secondary ${
        entry.soon ? "opacity-50" : ""
      }`}
    >
      <Icon size={18} className="shrink-0" />
      <span className="flex-1 text-sm font-medium">{label}</span>
      {entry.soon && (
        <span className="rounded-full bg-hover px-[7px] py-0.5 text-[9px] font-semibold tracking-[0.4px] text-text-secondary">
          СКОРО
        </span>
      )}
    </div>
  );
}

function TogglesCard() {
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border-subtle bg-elevated px-3 py-[11px]">
      <div className="flex items-center justify-between">
        <span className="text-meta text-text-secondary">LAN-доступ</span>
        {/* TODO: wire to a server action (toggle LAN proxy bind) in a later phase. */}
        <Switch checked disabled onCheckedChange={() => {}} aria-label="LAN-доступ" />
      </div>
      {/* TODO: wire to a server action (restart mihomo core) in a later phase. */}
      <button
        type="button"
        disabled
        className="flex h-7 w-full items-center justify-center gap-1.5 rounded-md border border-border-default bg-hover text-meta text-text-primary disabled:cursor-not-allowed disabled:opacity-60"
      >
        <RotateCw size={14} />
        Перезапустить ядро
      </button>
    </div>
  );
}

function ProxyCard() {
  const { mihomo } = useLiveState();
  const activeNode = useActiveNode();

  const status =
    mihomo === null
      ? { dot: "bg-idle", label: "Проверка" }
      : mihomo
        ? { dot: "bg-online", label: "Подключено" }
        : { dot: "bg-timeout", label: "Отключено" };

  const copyAddress = () => {
    void navigator.clipboard.writeText(PROXY_ENDPOINT);
    toast.success("Скопировано");
  };

  return (
    <div className="flex flex-col gap-[9px] rounded-lg border border-border-subtle bg-elevated p-[13px]">
      <div className="flex items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${status.dot}`} />
        <span className="text-meta text-text-secondary">{status.label}</span>
      </div>
      <div className="flex items-center justify-between">
        <span className="font-mono text-sub font-medium text-text-primary">{PROXY_ENDPOINT}</span>
        <button
          type="button"
          onClick={copyAddress}
          aria-label="Скопировать адрес"
          className="text-text-tertiary hover:text-text-secondary"
        >
          <Copy size={13} />
        </button>
      </div>
      <span className="font-mono text-[11px] text-text-tertiary">
        Активный узел · {activeNode ?? "—"}
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
