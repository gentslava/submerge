import type { LogEvent, LogLevel } from "@submerge/shared";
import { useMutation } from "@tanstack/react-query";
import { Pause, Play, Search, Trash2, WifiOff } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useReducer, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { useTRPC, useTRPCClient } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import {
  classifyLogEmpty,
  filterLogEvents,
  initialLogFilters,
  initialLogsClientState,
  type LogFilters,
  logsReducer,
  resetLogFilters,
  visibleLogEvents,
} from "./store";

const LEVEL_OPTIONS = [
  { value: "all", label: "Все" },
  { value: "info", label: "INFO" },
  { value: "warning", label: "WARN" },
  { value: "error", label: "ERROR" },
];

export function LogsScreen() {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const [state, dispatch] = useReducer(logsReducer, initialLogsClientState);
  const [filters, setFilters] = useState<LogFilters>(initialLogFilters);
  const clearMutation = useMutation(
    trpc.logs.clear.mutationOptions({
      onError: (error) => toast.error(error.message),
    }),
  );

  useEffect(() => {
    const subscription = client.logs.stream.subscribe(undefined, {
      onData: (message) => dispatch({ type: "message", message: message.data }),
      onError: () => dispatch({ type: "connection-lost" }),
      onConnectionStateChange: (connection) => {
        if (connection.state === "connecting") dispatch({ type: "connection-lost" });
      },
    });
    return () => subscription.unsubscribe();
  }, [client]);

  const visible = visibleLogEvents(state);
  const filtered = useMemo(() => filterLogEvents(visible, filters), [filters, visible]);
  const emptyState = classifyLogEmpty(visible, filtered, filters);

  return (
    <div className="responsive-page responsive-page--logs page-content logs-screen flex h-full min-h-0 min-w-0 flex-col px-4 pt-5 pb-8">
      <header className="logs-header flex min-w-0 items-center justify-between gap-4">
        <div className="min-w-0 flex flex-col gap-[5px]">
          <h1 className="logs-title text-page-title-compact text-text-primary">Логи</h1>
          <p className="text-sub text-text-secondary">События mihomo и submerge</p>
        </div>
        <div className="logs-actions flex shrink-0 items-center gap-2.5">
          <Button
            type="button"
            variant="secondary"
            size="md"
            aria-label={state.paused ? "Продолжить" : "Пауза"}
            onClick={() => dispatch({ type: state.paused ? "continue" : "pause" })}
            className="logs-action"
          >
            {state.paused ? (
              <Play aria-hidden="true" size={16} />
            ) : (
              <Pause aria-hidden="true" size={16} />
            )}
            <span className="logs-action-label">{state.paused ? "Продолжить" : "Пауза"}</span>
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="md"
            aria-label="Очистить"
            disabled={clearMutation.isPending}
            onClick={() => clearMutation.mutate()}
            className="logs-action"
          >
            <Trash2 aria-hidden="true" size={16} />
            <span className="logs-action-label">Очистить</span>
          </Button>
        </div>
      </header>

      <div className="logs-filter-bar flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="logs-filters flex min-w-0 flex-wrap items-center gap-2.5">
          <label htmlFor="logs-search" className="sr-only">
            Поиск в логах
          </label>
          <div className="logs-search flex h-9 min-w-0 items-center gap-2 rounded-md border border-border-default bg-input px-3">
            <Search aria-hidden="true" size={15} className="shrink-0 text-text-tertiary" />
            <input
              id="logs-search"
              type="search"
              value={filters.query}
              onChange={(event) =>
                setFilters((current) => ({ ...current, query: event.target.value }))
              }
              placeholder="Поиск в логах"
              className="min-w-0 flex-1 bg-transparent text-sub text-text-primary outline-none placeholder:text-text-tertiary"
            />
          </div>

          <label htmlFor="logs-source" className="sr-only">
            Источник
          </label>
          <Select
            id="logs-source"
            aria-label="Источник"
            value={filters.source}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                source: event.target.value as LogFilters["source"],
              }))
            }
            className="logs-source-select"
          >
            <option value="all">Все источники</option>
            <option value="mihomo">mihomo</option>
            <option value="submerge">submerge</option>
          </Select>

          <div className="logs-severity min-w-0">
            <Segmented
              options={LEVEL_OPTIONS}
              value={filters.level}
              onChange={(level) =>
                setFilters((current) => ({ ...current, level: level as LogFilters["level"] }))
              }
              aria-label="Уровень"
            />
          </div>
        </div>
        <div className="logs-count flex shrink-0 items-center gap-2 font-mono text-meta text-text-tertiary">
          <span className="logs-stream-state-label items-center gap-1.5">
            <span
              aria-hidden="true"
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                state.connection === "live" ? "bg-online" : "bg-slow",
              )}
            />
            {state.connection === "live"
              ? "live"
              : state.connection === "connecting"
                ? "подключение"
                : "переподключение"}
          </span>
          <span>{state.events.length} из 500</span>
          {state.paused && state.unseen > 0 ? (
            <span
              role="status"
              aria-live="polite"
              className="rounded-full bg-accent-bg px-2 py-1 text-accent-text"
            >
              {state.unseen} новых
            </span>
          ) : null}
        </div>
      </div>

      {state.connection === "reconnecting" ? (
        <div
          role="status"
          className="logs-reconnecting flex items-center gap-2.5 rounded-lg border border-slow bg-slow-bg px-3 py-2.5 text-sub text-slow"
        >
          <WifiOff aria-hidden="true" size={16} className="shrink-0" />
          <span>
            Переподключаем поток · показываем последние события
            {state.nextRetryAt ? (
              <span className="block text-fine">
                Следующая попытка:{" "}
                <time dateTime={state.nextRetryAt}>{formatTime(state.nextRetryAt)}</time>
              </span>
            ) : null}
          </span>
        </div>
      ) : null}

      <section
        aria-label="События mihomo и submerge"
        aria-busy={state.connection === "connecting"}
        className="logs-list min-h-0 min-w-0 flex-1 overflow-y-auto rounded-lg border border-border-subtle bg-surface"
      >
        {state.connection === "connecting" && state.cursor === null ? (
          <LogMessageState>Подключаем поток событий…</LogMessageState>
        ) : emptyState === "empty" ? (
          <LogMessageState>Событий пока нет</LogMessageState>
        ) : emptyState === "filtered-empty" ? (
          <LogMessageState>
            <span>По фильтрам ничего не найдено</span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              aria-label="Сбросить фильтры"
              onClick={() => setFilters(resetLogFilters())}
            >
              Сбросить фильтры
            </Button>
          </LogMessageState>
        ) : (
          <ol className="m-0 list-none p-0">
            {filtered.map((event) => (
              <LogRow key={event.id} event={event} />
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}

function LogMessageState({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[240px] flex-col items-center justify-center gap-3 p-6 text-center text-sub text-text-secondary">
      {children}
    </div>
  );
}

function LogRow({ event }: { event: LogEvent }) {
  return (
    <li className="logs-row grid min-w-0 grid-cols-[70px_60px_82px_minmax(0,1fr)] items-center gap-3.5 border-b border-border-subtle px-4 py-[9px] last:border-b-0">
      <time dateTime={event.time} className="logs-time font-mono text-meta text-text-tertiary">
        {formatTime(event.time)}
      </time>
      <LevelBadge level={event.level} />
      <span className="logs-source-badge inline-flex h-[19px] items-center justify-center rounded-sm bg-hover px-1 font-mono text-micro font-semibold text-text-secondary">
        {event.source.toUpperCase()}
      </span>
      <p className="logs-message min-w-0 break-words font-mono text-[12.5px] text-text-secondary">
        {event.message}
        {Object.entries(event.fields ?? {}).map(([key, value]) => (
          <span key={key} className="text-text-tertiary">
            {` · ${key}=${String(value)}`}
          </span>
        ))}
      </p>
    </li>
  );
}

function LevelBadge({ level }: { level: LogLevel }) {
  const label = level === "warning" ? "WARN" : level.toUpperCase();
  return (
    <span
      className={cn(
        "inline-flex w-[60px] items-center justify-center rounded-sm bg-hover px-0 py-[3px] font-mono text-micro font-semibold",
        level === "error" && "bg-timeout-bg text-timeout",
        level === "warning" && "bg-slow-bg text-slow",
        level === "info" && "text-accent-text",
        level === "debug" && "text-text-tertiary",
      )}
    >
      {label}
    </span>
  );
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}
