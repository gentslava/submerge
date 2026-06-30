import type { Source, SourceKind, SubscriptionMeta } from "@submerge/shared";
import {
  Calendar,
  Inbox,
  Link as LinkIcon,
  Lock,
  RefreshCw,
  ShieldCheck,
  Timer,
  Trash2,
} from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { formatBytes } from "@/features/nodes/nodeView";
import { pluralRu } from "@/lib/plural";
import { cn } from "@/lib/utils";

interface SourceRowProps {
  source: Source;
  onToggle(): void;
  onRefresh(): void;
  onRemove(): void;
  busy?: boolean;
}

const KIND_SHORT: Record<SourceKind, string> = {
  sub: "подписка",
  vless: "vless",
  happ: "happ",
};

function KindIcon({ kind }: { kind: SourceKind }) {
  const cls = "h-[18px] w-[18px] shrink-0 text-text-secondary";
  if (kind === "happ") return <Lock aria-hidden className={cls} />;
  if (kind === "vless") return <LinkIcon aria-hidden className={cls} />;
  return <Inbox aria-hidden className={cls} />;
}

// DD.MM.YYYY for a unix-seconds expiry.
function formatDate(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
}

// Right-aligned subscription metadata: traffic usage + expiry + refresh interval.
function SourceMeta({ meta }: { meta: SubscriptionMeta }) {
  const { used, total, expire, updateHours } = meta;
  const hasTraffic = used != null || total != null;
  const pct = used != null && total ? Math.min(100, Math.round((used / total) * 100)) : null;
  return (
    <div className="flex shrink-0 flex-col items-end gap-1.5">
      {hasTraffic && (
        <div className="flex items-center gap-2">
          {total != null && (
            <span className="h-1.5 w-24 overflow-hidden rounded-full bg-canvas">
              <span
                className="block h-full rounded-full bg-accent"
                style={{ width: `${pct ?? 0}%` }}
              />
            </span>
          )}
          <span className="font-mono text-xs text-text-secondary">
            {used != null ? formatBytes(used) : "—"}
            {total != null ? ` / ${formatBytes(total)}` : ""}
          </span>
        </div>
      )}
      {(expire != null || updateHours != null) && (
        <div className="flex items-center gap-3 font-mono text-[11px] text-text-tertiary">
          {expire != null && (
            <span className="flex items-center gap-1.5">
              <Calendar className="h-3 w-3" aria-hidden="true" />
              до {formatDate(expire)}
            </span>
          )}
          {updateHours != null && (
            <span className="flex items-center gap-1.5">
              <Timer className="h-3 w-3" aria-hidden="true" />
              авто {updateHours} ч
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export function SourceRow({ source, onToggle, onRefresh, onRemove, busy }: SourceRowProps) {
  const isBusy = busy === true;

  function handleRemove() {
    if (window.confirm("Удалить источник?")) onRemove();
  }

  return (
    <div
      className={cn(
        "flex items-center gap-3.5 border-b border-border-subtle px-4 py-3.5 last:border-0",
        !source.enabled && "opacity-50",
      )}
    >
      {/* Kind icon tile */}
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-elevated">
        <KindIcon kind={source.kind} />
      </span>

      {/* Name + badges (fills) */}
      <div className="flex min-w-0 flex-1 flex-col gap-[7px]">
        <span className="truncate text-sm font-medium text-text-primary" title={source.value}>
          {source.label || source.value}
        </span>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="mono">{KIND_SHORT[source.kind]}</Badge>
          <span className="text-xs text-text-tertiary">
            {source.proxies.length} {pluralRu(source.proxies.length, ["узел", "узла", "узлов"])}
          </span>
          {source.hwid && (
            <Badge variant="accent">
              <ShieldCheck className="h-[11px] w-[11px]" aria-hidden="true" />
              HWID
            </Badge>
          )}
        </div>
      </div>

      {/* Subscription metadata (traffic / expiry / auto), or a note for plain vless configs */}
      {source.meta ? (
        <SourceMeta meta={source.meta} />
      ) : source.kind === "vless" ? (
        <span className="shrink-0 font-mono text-[11px] text-text-tertiary">
          конфиг · без срока и лимита
        </span>
      ) : null}

      {/* Controls */}
      <div className="flex shrink-0 items-center gap-2.5 pl-1.5">
        <Switch
          checked={source.enabled}
          onCheckedChange={onToggle}
          disabled={isBusy}
          aria-label="Включить источник"
        />
        <IconBtn onClick={onRefresh} disabled={isBusy} label="Обновить источник">
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
        </IconBtn>
        <IconBtn onClick={handleRemove} disabled={isBusy} label="Удалить источник" danger>
          <Trash2 className="h-4 w-4" aria-hidden="true" />
        </IconBtn>
      </div>
    </div>
  );
}

function IconBtn({
  onClick,
  disabled,
  label,
  danger,
  children,
}: {
  onClick(): void;
  disabled: boolean;
  label: string;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className={cn(
        "flex h-8 w-8 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-hover disabled:pointer-events-none disabled:opacity-50",
        danger ? "hover:text-timeout" : "hover:text-text-secondary",
      )}
    >
      {children}
    </button>
  );
}
