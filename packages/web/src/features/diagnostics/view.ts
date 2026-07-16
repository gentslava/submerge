import type { DiagnosticCheckStatus, DiagnosticState } from "@submerge/shared";

export function formatDiagnosticDuration(value: number | null): string {
  if (value === null) return "—";
  if (value < 1) return "<1 мс";
  return `${Math.round(value)} мс`;
}

export function passCount(entries: readonly { status: DiagnosticCheckStatus }[]): {
  passed: number;
  attempted: number;
} {
  return entries.reduce(
    (count, entry) => {
      if (entry.status === "skipped") return count;
      count.attempted++;
      if (entry.status === "ok") count.passed++;
      return count;
    },
    { passed: 0, attempted: 0 },
  );
}

export function safeDiagnosticTitle(value: string | null | undefined): string {
  return value?.trim() || "—";
}

export interface DiagnosticStatusVisual {
  label: string;
  dotClass: string;
  textClass: string;
}

export function diagnosticStatusVisual(
  status: DiagnosticCheckStatus,
  durationMs: number | null,
): DiagnosticStatusVisual {
  if (status === "ok" && durationMs !== null && durationMs >= 500) {
    return { label: "Работает медленно", dotClass: "bg-slow", textClass: "text-slow" };
  }
  if (status === "ok") {
    return { label: "Работает", dotClass: "bg-online", textClass: "text-online" };
  }
  if (status === "failed") {
    return { label: "Ошибка", dotClass: "bg-timeout", textClass: "text-timeout" };
  }
  return { label: "Пропущено", dotClass: "bg-idle", textClass: "text-text-tertiary" };
}

export type DiagnosticDisplayState = DiagnosticState | "running";

export interface DiagnosticStateCopy {
  title: string;
  detail: string;
  badge: string;
  tone: "ok" | "warning" | "error" | "running";
}

const STATE_COPY: Record<DiagnosticDisplayState, DiagnosticStateCopy> = {
  running: {
    title: "Проверка выполняется",
    detail: "Проверяем компоненты, маршруты и доступность сервисов.",
    badge: "ПРОВЕРКА",
    tone: "running",
  },
  "mihomo-down": {
    title: "mihomo недоступен",
    detail: "Контроллер mihomo недоступен. Проверьте процесс и настройки подключения.",
    badge: "ОШИБКА",
    tone: "error",
  },
  "no-nodes": {
    title: "Нет прокси-узлов",
    detail: "mihomo доступен, но ни один прокси-узел не загружен.",
    badge: "НЕТ УЗЛОВ",
    tone: "warning",
  },
  "no-internet": {
    title: "Нет выхода в интернет",
    detail: "Все выполненные исходящие проверки через mihomo завершились ошибкой.",
    badge: "НЕТ СЕТИ",
    tone: "error",
  },
  "external-ip-unavailable": {
    title: "Внешний IP не определён",
    detail: "Контрольный IP не получен. Само по себе это не доказывает сбой прокси.",
    badge: "ПРОВЕРИТЬ",
    tone: "warning",
  },
  partial: {
    title: "Есть замечания",
    detail: "Часть проверок требует внимания. Подробности показаны в блоках ниже.",
    badge: "ЗАМЕЧАНИЯ",
    tone: "warning",
  },
  ready: {
    title: "Все проверки пройдены",
    detail: "Прокси, маршруты и контрольные сервисы доступны.",
    badge: "ГОТОВО",
    tone: "ok",
  },
};

export function diagnosticStateCopy(state: DiagnosticDisplayState): DiagnosticStateCopy {
  return STATE_COPY[state];
}
