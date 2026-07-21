import type { LogLevel } from "@submerge/shared";
import type { LogDraft } from "./hub.js";

export type OperationalEventKey =
  | "server-listening"
  | "boot-config-apply-failed"
  | "config-reload-failed"
  | "secret-rotation-write-failed"
  | "mihomo-live-failed"
  | "source-refresh-failed"
  | "source-refresh-scheduler-failed";

interface OperationalEventDefinition {
  level: LogLevel;
  uiMessage: string;
  stdoutMessage: string;
  fields: (input: Record<string, unknown>) => LogDraft["fields"];
}

const noFields = (): undefined => undefined;

const definitions: Record<OperationalEventKey, OperationalEventDefinition> = {
  "server-listening": {
    level: "info",
    uiMessage: "Сервер submerge запущен",
    stdoutMessage: "submerge server listening",
    fields: (input) => {
      const fields: NonNullable<LogDraft["fields"]> = {};
      if (typeof input.host === "string") fields.host = input.host;
      if (typeof input.port === "number" && Number.isFinite(input.port)) fields.port = input.port;
      return Object.keys(fields).length > 0 ? fields : undefined;
    },
  },
  "boot-config-apply-failed": {
    level: "warning",
    uiMessage: "Не удалось применить конфигурацию при запуске",
    stdoutMessage: "boot config apply failed",
    fields: noFields,
  },
  "config-reload-failed": {
    level: "warning",
    uiMessage: "Конфигурация записана, но mihomo не перезагрузил её",
    stdoutMessage: "config written but mihomo reload failed — applies on next reload",
    fields: noFields,
  },
  "secret-rotation-write-failed": {
    level: "warning",
    uiMessage: "Не удалось записать конфигурацию после смены секрета mihomo",
    stdoutMessage: "config write after secret rotation failed",
    fields: noFields,
  },
  "mihomo-live-failed": {
    level: "warning",
    uiMessage: "Сбой получения данных mihomo",
    stdoutMessage: "mihomo live failed",
    fields: (input) =>
      input.scope === "poll" || input.scope === "traffic" ? { scope: input.scope } : undefined,
  },
  "source-refresh-failed": {
    level: "warning",
    uiMessage: "Не удалось обновить источник",
    stdoutMessage: "source refresh failed",
    fields: (input) => {
      const fields: NonNullable<LogDraft["fields"]> = {};
      if (typeof input.sourceId === "number" && Number.isInteger(input.sourceId))
        fields.sourceId = input.sourceId;
      if (
        input.kind === "sub" ||
        input.kind === "happ" ||
        input.kind === "vless" ||
        input.kind === "hysteria2" ||
        input.kind === "vmess" ||
        input.kind === "trojan" ||
        input.kind === "ss" ||
        input.kind === "tuic" ||
        input.kind === "wireguard" ||
        input.kind === "amneziawg"
      )
        fields.kind = input.kind;
      if (input.trigger === "manual" || input.trigger === "scheduled" || input.trigger === "enable")
        fields.trigger = input.trigger;
      if (
        input.stage === "fetch" ||
        input.stage === "decode" ||
        input.stage === "validate" ||
        input.stage === "database" ||
        input.stage === "config-write" ||
        input.stage === "unknown"
      )
        fields.stage = input.stage;
      if (
        typeof input.category === "string" &&
        /^(timeout|dns|connection-reset|connection-refused|tls|network|decoder|invalid-content|permission-denied|disk-full|config-write|database|refresh-failed|http-\d{3})$/.test(
          input.category,
        )
      )
        fields.category = input.category;
      if (
        typeof input.consecutiveFailures === "number" &&
        Number.isInteger(input.consecutiveFailures)
      )
        fields.consecutiveFailures = input.consecutiveFailures;
      if (typeof input.nextAttemptAt === "number" && Number.isFinite(input.nextAttemptAt))
        fields.nextAttemptAt = input.nextAttemptAt;
      return Object.keys(fields).length > 0 ? fields : undefined;
    },
  },
  "source-refresh-scheduler-failed": {
    level: "warning",
    uiMessage: "Сбой планировщика обновления источников",
    stdoutMessage: "source refresh scheduler failed",
    fields: noFields,
  },
};

export interface OperationalEvent {
  draft: LogDraft;
  stdoutMessage: string;
}

export function makeOperationalEvent(
  key: OperationalEventKey,
  input: Record<string, unknown> = {},
): OperationalEvent {
  const definition = definitions[key];
  const fields = definition.fields(input);
  return {
    stdoutMessage: definition.stdoutMessage,
    draft: {
      source: "submerge",
      level: definition.level,
      message: definition.uiMessage,
      ...(fields ? { fields } : {}),
    },
  };
}
