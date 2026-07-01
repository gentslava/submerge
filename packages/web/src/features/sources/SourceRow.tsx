import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Source, SourceKind, SubscriptionMeta } from "@submerge/shared";
import {
  Calendar,
  GripVertical,
  Inbox,
  Link as LinkIcon,
  Lock,
  RefreshCw,
  ShieldCheck,
  Timer,
  Trash2,
} from "lucide-react";
import { type CSSProperties, forwardRef, type ReactNode } from "react";
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

// Short badge label per kind. Single-node protocol kinds (vless/trojan/…) fall back
// to their own name — the kind IS the protocol, so it reads correctly as-is.
const KIND_SHORT: Partial<Record<SourceKind, string>> = {
  sub: "подписка",
  happ: "happ",
  vless: "VLESS",
  hysteria2: "Hysteria2",
  vmess: "VMess",
  trojan: "Trojan",
  ss: "Shadowsocks",
  tuic: "TUIC",
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
    <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5 md:flex-none md:shrink-0 md:items-end">
      {hasTraffic && (
        <div className="flex min-w-0 items-center gap-2">
          {total != null && (
            <span className="h-1.5 w-16 shrink-0 overflow-hidden rounded-full bg-hover md:w-24">
              <span
                className="block h-full rounded-full bg-accent"
                style={{ width: `${pct ?? 0}%` }}
              />
            </span>
          )}
          <span className="truncate font-mono text-xs text-text-secondary">
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

// The sortable list row: wires dnd-kit and renders the shared shell with a live handle.
export function SourceRow(props: SourceRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: props.source.id });
  const style: CSSProperties = { transform: CSS.Transform.toString(transform), transition };
  const label = props.source.label || props.source.value;

  return (
    <SourceRowShell
      ref={setNodeRef}
      style={style}
      // While this row is the one being dragged, hide it in place — the DragOverlay
      // renders the floating copy — so the drop can't "jump" between the two.
      className={cn(isDragging && "opacity-0")}
      handle={
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label={`Перетащить «${label}» для сортировки`}
          className="flex h-8 w-5 shrink-0 cursor-grab touch-none items-center justify-center text-text-tertiary transition-colors hover:text-text-secondary active:cursor-grabbing"
        >
          <GripVertical className="h-[18px] w-[18px]" aria-hidden="true" />
        </button>
      }
      {...props}
    />
  );
}

interface ShellProps extends SourceRowProps {
  handle: ReactNode;
  style?: CSSProperties;
  className?: string;
  // The floating DragOverlay copy — reads as a lifted card.
  overlay?: boolean;
}

// Presentational row shared by the sortable list and the DragOverlay copy.
export const SourceRowShell = forwardRef<HTMLDivElement, ShellProps>(function SourceRowShell(
  { source, onToggle, onRefresh, onRemove, busy, handle, style, className, overlay },
  ref,
) {
  const isBusy = busy === true;

  function handleRemove() {
    if (window.confirm("Удалить источник?")) onRemove();
  }

  return (
    <div
      ref={ref}
      style={style}
      className={cn(
        "flex flex-col gap-3 border-b border-border-subtle px-4 py-3.5 last:border-0 md:flex-row md:items-center md:gap-3.5",
        !source.enabled && "opacity-50",
        overlay && "rounded-lg border bg-surface opacity-100 shadow-lg",
        className,
      )}
    >
      {/* Lead: handle + icon + name/badges. On desktop this trio is the row's flex-1
          lead; on mobile it's the first stacked line. */}
      <div className="flex min-w-0 items-center gap-3.5 md:flex-1">
        {handle}

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
            <Badge variant="mono">{KIND_SHORT[source.kind] ?? source.kind}</Badge>
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
      </div>

      {/* Meta + controls. md:contents dissolves this wrapper on desktop so both become
          direct row children (meta then controls, right-aligned); on mobile they share
          a second line — metadata left, controls right. */}
      <div className="flex items-center justify-between gap-3 md:contents">
        {/* Subscription metadata (traffic / expiry / auto), or a note for plain vless configs */}
        {source.meta ? (
          <SourceMeta meta={source.meta} />
        ) : source.kind === "vless" ? (
          <span className="shrink-0 font-mono text-[11px] text-text-tertiary">
            конфиг · без срока и лимита
          </span>
        ) : null}

        {/* Controls — ml-auto keeps them right-aligned on mobile even when there's no
            meta on the left; md:contents lets the desktop row lay them out normally. */}
        <div className="flex shrink-0 items-center gap-2.5 ml-auto md:ml-0 md:pl-1.5">
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
    </div>
  );
});

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
