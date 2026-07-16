import pino from "pino";
import { makeOperationalEvent, type OperationalEventKey } from "./modules/logs/events.js";
import type { LogDraft } from "./modules/logs/hub.js";

// Single process-wide logger. Import from here instead of creating new pino
// instances so name/config stay consistent across modules.
export const log = pino({ name: "submerge" });

type UiEventSink = (draft: LogDraft) => void;
let uiEventSink: UiEventSink = () => {};

export function setUiEventSink(sink: UiEventSink): void {
  uiEventSink = sink;
}

export function operationalLog(
  key: OperationalEventKey,
  fields: Record<string, unknown> = {},
  err?: unknown,
): void {
  const event = makeOperationalEvent(key, fields);
  const stdoutFields = {
    ...(event.draft.fields ?? {}),
    ...(err === undefined ? {} : { err }),
  };
  switch (event.draft.level) {
    case "debug":
      log.debug(stdoutFields, event.stdoutMessage);
      break;
    case "info":
      log.info(stdoutFields, event.stdoutMessage);
      break;
    case "warning":
      log.warn(stdoutFields, event.stdoutMessage);
      break;
    case "error":
      log.error(stdoutFields, event.stdoutMessage);
      break;
  }
  uiEventSink(event.draft);
}
