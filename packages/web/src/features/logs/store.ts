import type { LogEvent, LogLevel, LogSource, LogStreamMessage } from "@submerge/shared";
import { pluralRu } from "@/lib/plural";

export const LOG_CAPACITY = 500;

export interface LogsClientState {
  connection: "connecting" | "live" | "reconnecting";
  nextRetryAt: string | null;
  cursor: number | null;
  events: readonly LogEvent[];
  paused: boolean;
  pausedEvents: readonly LogEvent[];
  pausedCursor: number | null;
  unseen: number;
}

export const initialLogsClientState: LogsClientState = {
  connection: "connecting",
  nextRetryAt: null,
  cursor: null,
  events: [],
  paused: false,
  pausedEvents: [],
  pausedCursor: null,
  unseen: 0,
};

export type LogsClientAction =
  | { type: "message"; message: LogStreamMessage }
  | { type: "connection-lost" }
  | { type: "pause" }
  | { type: "continue" };

function normalizedEvents(events: readonly LogEvent[]): LogEvent[] {
  const unique = new Map<number, LogEvent>();
  for (const event of events) unique.set(event.id, event);
  return [...unique.values()].sort((left, right) => right.id - left.id).slice(0, LOG_CAPACITY);
}

function unseenSince(events: readonly LogEvent[], cursor: number | null): number {
  if (cursor === null) return 0;
  return events.reduce((count, event) => count + Number(event.id > cursor), 0);
}

function isStale(state: LogsClientState, cursor: number): boolean {
  return state.cursor !== null && cursor <= state.cursor;
}

export function logsReducer(state: LogsClientState, action: LogsClientAction): LogsClientState {
  if (action.type === "connection-lost") {
    return {
      ...state,
      connection: state.cursor === null ? "connecting" : "reconnecting",
      nextRetryAt: null,
    };
  }
  if (action.type === "pause") {
    if (state.paused) return state;
    return {
      ...state,
      paused: true,
      pausedEvents: [...state.events],
      pausedCursor: state.cursor,
      unseen: 0,
    };
  }
  if (action.type === "continue") {
    if (!state.paused) return state;
    return {
      ...state,
      paused: false,
      pausedEvents: [],
      pausedCursor: null,
      unseen: 0,
    };
  }

  const message = action.message;
  switch (message.type) {
    case "snapshot": {
      const events = normalizedEvents(message.events);
      return {
        ...state,
        connection: message.upstream,
        nextRetryAt: message.nextRetryAt,
        cursor: message.cursor,
        events,
        unseen: state.paused ? unseenSince(events, state.pausedCursor) : 0,
      };
    }
    case "status":
      if (isStale(state, message.cursor)) return state;
      return {
        ...state,
        connection: message.upstream,
        nextRetryAt: message.nextRetryAt,
        cursor: message.cursor,
      };
    case "append": {
      if (isStale(state, message.cursor)) return state;
      const events = normalizedEvents([message.event, ...state.events]);
      return {
        ...state,
        cursor: message.cursor,
        events,
        unseen: state.paused ? unseenSince(events, state.pausedCursor) : 0,
      };
    }
    case "clear":
      if (isStale(state, message.cursor)) return state;
      return {
        ...state,
        cursor: message.cursor,
        events: [],
        pausedEvents: [],
        pausedCursor: state.paused ? message.cursor : null,
        unseen: 0,
      };
  }
}

export function visibleLogEvents(state: LogsClientState): readonly LogEvent[] {
  return state.paused ? state.pausedEvents : state.events;
}

export interface LogFilters {
  query: string;
  source: "all" | LogSource;
  level: "all" | Exclude<LogLevel, "debug">;
}

export const initialLogFilters: LogFilters = {
  query: "",
  source: "all",
  level: "all",
};

export function resetLogFilters(): LogFilters {
  return { ...initialLogFilters };
}

function logFiltersActive(filters: LogFilters): boolean {
  return filters.query.trim() !== "" || filters.source !== "all" || filters.level !== "all";
}

export function logCountLabel(
  availableCount: number,
  matchedCount: number,
  filters: LogFilters,
): string {
  if (logFiltersActive(filters)) {
    const availableLabel =
      availableCount >= LOG_CAPACITY ? `последних ${LOG_CAPACITY}` : String(availableCount);
    return `${matchedCount} найдено · из ${availableLabel}`;
  }
  if (availableCount >= LOG_CAPACITY) return `Последние ${LOG_CAPACITY}`;
  return `${availableCount} ${pluralRu(availableCount, ["событие", "события", "событий"])}`;
}

export function filterLogEvents(events: readonly LogEvent[], filters: LogFilters): LogEvent[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return events.filter((event) => {
    if (filters.source !== "all" && event.source !== filters.source) return false;
    if (filters.level !== "all" && event.level !== filters.level) return false;
    if (!query) return true;
    const values = [event.message, ...Object.values(event.fields ?? {})];
    return values.some((value) => String(value).toLocaleLowerCase().includes(query));
  });
}

export type LogEmptyState = "empty" | "filtered-empty" | null;

export function classifyLogEmpty(
  allEvents: readonly LogEvent[],
  filteredEvents: readonly LogEvent[],
  filters: LogFilters,
): LogEmptyState {
  if (allEvents.length === 0) return "empty";
  if (logFiltersActive(filters) && filteredEvents.length === 0) return "filtered-empty";
  return null;
}
