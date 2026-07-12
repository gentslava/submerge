import type { NodeItem } from "@submerge/shared";
import {
  Activity,
  Ban,
  Check,
  ChevronDown,
  Ellipsis,
  Gauge,
  Loader2,
  Undo2,
  Zap,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  dotColors,
  latencyClass,
  latencyLabel,
  latencyTextColors,
  serverCountLabel,
  typeBadges,
} from "./nodeView";
import { useSpeedTest } from "./SpeedTestContext";

interface NodeRowProps {
  item: NodeItem;
  isActive: boolean;
  pinging?: boolean;
  onSelect(): void;
  onPing(): void;
  onToggleExcluded(excluded: boolean): void;
}

export function NodeRow({
  item,
  isActive,
  pinging = false,
  onSelect,
  onPing,
  onToggleExcluded,
}: NodeRowProps) {
  const lClass = latencyClass(item.delay);
  const members = item.members ?? [];
  const isGroup = members.length > 0;
  const isExcluded = item.excluded ?? false;
  const [expanded, setExpanded] = useState(false);
  const speedTest = useSpeedTest();
  // Cached throughput (Phase 4c). Works for a collapsed group too: the group name is
  // in the hidden PROBE group, so the test routes through whichever member the group
  // currently resolves to — i.e. "how fast this group is right now".
  const mbps = speedTest?.mbpsOf(item.name) ?? null;
  const testing = speedTest?.testing.has(item.name) ?? false;
  const canSpeedTest = speedTest !== null;
  // Sub-line: a collapsed group shows its server count ("5 серверов"); a plain
  // node shows its protocol badges (VLESS · TCP · Reality / · WS · TLS), plus the
  // cached download speed once measured.
  const badges = isGroup ? serverCountLabel(members.length) : typeBadges(item).join(" · ");
  const sub = mbps != null ? `${badges} · ${mbps.toFixed(0)} Мбит/с` : badges;

  // Dot + name (+ trailing chevron for groups) + sub. The dot stays the first
  // element in both the group and singleton layouts so status dots line up.
  const nodeCell = (
    <>
      <span aria-hidden="true" className={cn("h-2 w-2 shrink-0 rounded-full", dotColors[lClass])} />
      <div className="flex min-w-0 flex-col gap-[3px]">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-semibold text-text-primary">{item.name}</span>
          {isExcluded && (
            <span className="shrink-0 rounded-full bg-hover px-[7px] py-0.5 text-[9px] font-semibold uppercase tracking-[0.4px] text-text-tertiary">
              исключён
            </span>
          )}
          {isGroup && (
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "h-3.5 w-3.5 shrink-0 text-text-tertiary transition-transform",
                !expanded && "-rotate-90",
              )}
            />
          )}
        </span>
        {sub !== "" && <span className="truncate text-xs text-text-tertiary">{sub}</span>}
      </div>
    </>
  );

  return (
    <>
      <MobileNodeRow
        item={item}
        isActive={isActive}
        pinging={pinging}
        testing={testing}
        canSpeedTest={canSpeedTest}
        isExcluded={isExcluded}
        sub={sub}
        isGroup={isGroup}
        expanded={expanded}
        onToggleExpanded={() => setExpanded((value) => !value)}
        onSelect={onSelect}
        onPing={onPing}
        onSpeedTest={() => speedTest?.request(item.name)}
        onToggleExcluded={onToggleExcluded}
      />

      <div
        className={cn(
          "node-row-desktop hidden items-center gap-4 border-b border-border-subtle px-4 py-[13px] last:border-b-0",
          isActive && "bg-accent-bg",
          isExcluded && "opacity-60",
        )}
      >
        {/* Node cell (fills). For a group the whole cell is a toggle button so
            clicking the name/row area expands its members; ⚡ and Выбрать stay
            separate controls. Singletons render the same cell as a plain div. */}
        {isGroup ? (
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            aria-expanded={expanded}
            aria-label={`Показать серверы ${item.name}`}
            className="flex min-w-0 flex-1 items-center gap-3 text-left"
          >
            {nodeCell}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-3">{nodeCell}</div>
        )}

        {/* Ping value — a spinner stands in while this node is being pinged */}
        <div className="node-row-ping-cell flex w-16 shrink-0 items-center justify-end">
          {pinging ? (
            <Loader2 className="h-4 w-4 animate-spin text-text-tertiary" aria-label="Опрос…" />
          ) : (
            <span className={cn("font-mono text-sm font-medium", latencyTextColors[lClass])}>
              {latencyLabel(item.delay)}
            </span>
          )}
        </div>

        {/* Inline ping button — transparent icon button (no border/fill), zap 18 */}
        <div className="flex w-12 shrink-0 justify-center">
          <button
            type="button"
            onClick={onPing}
            disabled={pinging || isExcluded}
            aria-label={`Пинговать ${item.name}`}
            className="flex h-10 w-10 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-hover hover:text-text-primary disabled:pointer-events-none disabled:opacity-50"
          >
            <Zap className="h-[18px] w-[18px]" aria-hidden="true" />
          </button>
        </div>

        {/* Speed-test button (singleton nodes only) — measures throughput on demand
            behind a traffic-cost confirmation. A fixed-width cell keeps every row's
            columns aligned; groups render an empty spacer of the same width. */}
        <div className="flex w-12 shrink-0 justify-center">
          {canSpeedTest && (
            <button
              type="button"
              onClick={() => speedTest?.request(item.name)}
              disabled={testing || isExcluded}
              aria-label={`Тест скорости ${item.name}`}
              title="Тест скорости (расходует трафик)"
              className="flex h-10 w-10 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-hover hover:text-text-primary disabled:pointer-events-none disabled:opacity-50"
            >
              {testing ? (
                <Loader2 className="h-[18px] w-[18px] animate-spin" aria-hidden="true" />
              ) : (
                <Gauge className="h-[18px] w-[18px]" aria-hidden="true" />
              )}
            </button>
          )}
        </div>

        {/* Exclude toggle — deny-list a node (dropped from the engine) or restore it */}
        <div className="flex w-10 shrink-0 justify-center">
          <button
            type="button"
            onClick={() => onToggleExcluded(!isExcluded)}
            aria-label={isExcluded ? `Вернуть ${item.name}` : `Исключить ${item.name}`}
            title={isExcluded ? "Вернуть в работу" : "Исключить из подключений"}
            className={cn(
              "flex h-10 w-10 items-center justify-center rounded-md transition-colors hover:bg-hover",
              isExcluded
                ? "text-text-secondary hover:text-text-primary"
                : "text-text-tertiary hover:text-timeout",
            )}
          >
            {isExcluded ? (
              <Undo2 className="h-[18px] w-[18px]" aria-hidden="true" />
            ) : (
              <Ban className="h-[18px] w-[18px]" aria-hidden="true" />
            )}
          </button>
        </div>

        {/* Action cell */}
        <div className="node-row-action-cell flex w-auto shrink-0 justify-end">
          {isActive ? (
            // Solid accent (not opacity-dimmed) — the active node reads as "on", not disabled.
            <Button
              variant="primary"
              size="sm"
              disabled
              className="node-row-action-button w-[92px] disabled:opacity-100"
            >
              <Check className="h-4 w-4" aria-hidden="true" />
              Активен
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              className="node-row-action-button w-[92px]"
              disabled={isExcluded}
              onClick={onSelect}
            >
              Выбрать
            </Button>
          )}
        </div>
      </div>

      {expanded &&
        members.map((m) => (
          <div key={m.name}>
            <div className="node-member-mobile flex items-center justify-between gap-3 border-b border-border-subtle bg-elevated px-4 py-3">
              <span className="flex min-w-0 items-center gap-2.5">
                <span
                  aria-hidden="true"
                  className={cn("h-2 w-2 shrink-0 rounded-full", dotColors[latencyClass(m.delay)])}
                />
                <span className="truncate text-sub text-text-secondary">
                  {m.active ? `${m.name} · активен` : m.name}
                </span>
              </span>
              <span
                className={cn(
                  "shrink-0 font-mono text-sub",
                  latencyTextColors[latencyClass(m.delay)],
                )}
              >
                {latencyLabel(m.delay)}
              </span>
            </div>
            <div className="node-member-desktop hidden items-center gap-4 border-b border-border-subtle bg-elevated px-4 py-2.5 pl-11 last:border-b-0">
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <span
                  aria-hidden="true"
                  className={cn("h-2 w-2 shrink-0 rounded-full", dotColors[latencyClass(m.delay)])}
                />
                <span className="truncate text-sm text-text-secondary">
                  {m.active ? `${m.name} · активен` : m.name}
                </span>
              </div>
              <div className="flex w-24 shrink-0 items-center justify-end">
                <span className={cn("font-mono text-sm", latencyTextColors[latencyClass(m.delay)])}>
                  {latencyLabel(m.delay)}
                </span>
              </div>
              {/* Mirror the parent's ping / speed-test / exclude cells so member
                  delay values line up. */}
              <span aria-hidden="true" className="w-12 shrink-0" />
              <span aria-hidden="true" className="w-12 shrink-0" />
              <span aria-hidden="true" className="w-10 shrink-0" />
              <span aria-hidden="true" className="w-[120px] shrink-0" />
            </div>
          </div>
        ))}
    </>
  );
}

interface MobileNodeRowProps {
  item: NodeItem;
  isActive: boolean;
  pinging: boolean;
  testing: boolean;
  canSpeedTest: boolean;
  isExcluded: boolean;
  sub: string;
  isGroup: boolean;
  expanded: boolean;
  onToggleExpanded(): void;
  onSelect(): void;
  onPing(): void;
  onSpeedTest(): void;
  onToggleExcluded(excluded: boolean): void;
}

function MobileNodeRow({
  item,
  isActive,
  pinging,
  testing,
  canSpeedTest,
  isExcluded,
  sub,
  isGroup,
  expanded,
  onToggleExpanded,
  onSelect,
  onPing,
  onSpeedTest,
  onToggleExcluded,
}: MobileNodeRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPlacement, setMenuPlacement] = useState<"above" | "below">("above");
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const lClass = latencyClass(item.delay);

  useEffect(() => {
    if (!menuOpen) return;
    const closeOnOutsidePress = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  // Open away from the nearest edge. The menu initially renders above (the common,
  // bottom-nav-safe case), then this layout effect flips it before paint if the
  // trigger is near the viewport top. The fixed bottom nav is a lower boundary,
  // so a menu never flips into it.
  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!menuOpen || !trigger || !menu) return;

    const gap = 8;
    const triggerBounds = trigger.getBoundingClientRect();
    const menuHeight = menu.getBoundingClientRect().height;
    const bottomNavTop = document
      .querySelector<HTMLElement>("nav.fixed")
      ?.getBoundingClientRect().top;
    const availableAbove = triggerBounds.top;
    const availableBelow = (bottomNavTop ?? window.innerHeight) - triggerBounds.bottom;
    const fitsAbove = availableAbove >= menuHeight + gap;
    const fitsBelow = availableBelow >= menuHeight + gap;

    setMenuPlacement(fitsAbove || !fitsBelow ? "above" : "below");
  }, [menuOpen]);

  return (
    <div
      className={cn(
        "node-row-mobile relative flex flex-col gap-2.5 border-b border-border-subtle px-3.5 py-3 last:border-b-0",
        isActive && "bg-accent-bg",
        isExcluded && "opacity-60",
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        {isGroup ? (
          <button
            type="button"
            onClick={onToggleExpanded}
            aria-expanded={expanded}
            aria-label={`Показать серверы ${item.name}`}
            className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
          >
            <span
              aria-hidden="true"
              className={cn("h-2 w-2 shrink-0 rounded-full", dotColors[lClass])}
            />
            <span className="truncate text-cardtitle text-text-primary">{item.name}</span>
            <ChevronDown
              aria-hidden="true"
              className={cn(
                "h-4 w-4 shrink-0 text-text-tertiary transition-transform",
                !expanded && "-rotate-90",
              )}
            />
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <span
              aria-hidden="true"
              className={cn("h-2 w-2 shrink-0 rounded-full", dotColors[lClass])}
            />
            <span className="truncate text-cardtitle text-text-primary">{item.name}</span>
          </div>
        )}
        <span
          className={cn(
            "shrink-0 rounded-full bg-hover px-2.5 py-1 font-mono text-sub font-medium",
            latencyTextColors[lClass],
          )}
        >
          {pinging ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-label="Опрос…" />
          ) : (
            latencyLabel(item.delay)
          )}
        </span>
      </div>

      <div className="flex min-w-0 items-center justify-between gap-3">
        <span className="min-w-0 truncate text-xs text-text-tertiary">{sub}</span>
        <div className="flex shrink-0 items-center gap-2">
          {isActive ? (
            <Button
              variant="primary"
              size="md"
              disabled
              className="h-11 min-w-[114px] disabled:opacity-100"
            >
              <Check className="h-4 w-4" aria-hidden="true" />
              Активен
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="md"
              className="h-11 min-w-[114px]"
              disabled={isExcluded}
              onClick={onSelect}
            >
              Выбрать
            </Button>
          )}
          <div className="relative">
            <button
              ref={triggerRef}
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              aria-label={`Действия для ${item.name}`}
              aria-expanded={menuOpen}
              className="flex h-11 w-11 items-center justify-center rounded-md border border-accent-border bg-accent-bg text-accent-text transition-colors hover:bg-hover"
            >
              <Ellipsis className="h-[18px] w-[18px]" aria-hidden="true" />
            </button>

            {menuOpen && (
              <div
                ref={menuRef}
                className={cn(
                  "absolute right-0 z-20 flex w-[210px] flex-col gap-0.5 rounded-md border border-border-default bg-elevated p-1.5",
                  menuPlacement === "above"
                    ? "bottom-[calc(100%+0.5rem)]"
                    : "top-[calc(100%+0.5rem)]",
                )}
              >
                <MenuItem
                  label="Проверить пинг"
                  icon={Activity}
                  disabled={pinging || isExcluded}
                  onClick={() => {
                    setMenuOpen(false);
                    onPing();
                  }}
                />
                {canSpeedTest && (
                  <MenuItem
                    label="Замерить скорость"
                    icon={Zap}
                    disabled={testing || isExcluded}
                    onClick={() => {
                      setMenuOpen(false);
                      onSpeedTest();
                    }}
                  />
                )}
                <MenuItem
                  label={isExcluded ? "Вернуть узел" : "Отключить узел"}
                  icon={isExcluded ? Undo2 : Ban}
                  danger={!isExcluded}
                  onClick={() => {
                    setMenuOpen(false);
                    onToggleExcluded(!isExcluded);
                  }}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function MenuItem({
  label,
  icon: Icon,
  onClick,
  disabled = false,
  danger = false,
}: {
  label: string;
  icon: typeof Activity;
  onClick(): void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex h-10 items-center gap-2.5 whitespace-nowrap rounded-sm px-2.5 text-sub font-medium text-text-primary transition-colors hover:bg-hover disabled:pointer-events-none disabled:opacity-50",
        danger && "bg-timeout-bg text-timeout hover:bg-timeout-bg",
      )}
    >
      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
      {label}
    </button>
  );
}
