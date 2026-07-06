import { Activity, Route, ScrollText, Stethoscope, Waypoints } from "lucide-react";
import type { ComponentType } from "react";
import { Button } from "@/components/ui/button";
import { useReloadCore } from "@/features/settings/useReloadCore";
import { PROXY_ENDPOINT } from "@/lib/constants";

const SOON: { label: string; icon: ComponentType<{ size?: number }> }[] = [
  { label: "Соединения", icon: Waypoints },
  { label: "Трафик", icon: Activity },
  { label: "Логи", icon: ScrollText },
  { label: "Диагностика", icon: Stethoscope },
  { label: "Маршрутизация", icon: Route },
];

export function MoreRoute() {
  const reload = useReloadCore();
  return (
    <div className="mx-auto max-w-4xl p-4 md:p-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-text-primary">Ещё</h1>
        <p className="text-sm text-text-secondary">Будущие разделы и серверные действия</p>
      </header>

      <div className="flex flex-col gap-4">
        <div className="flex flex-col rounded-xl border border-border-subtle bg-surface">
          {SOON.map(({ label, icon: Icon }) => (
            // biome-ignore lint/a11y/useSemanticElements: inert "coming soon" entry — a real <a> would imply a navigable destination
            <div
              key={label}
              role="link"
              aria-disabled="true"
              aria-label={`${label} (скоро)`}
              tabIndex={-1}
              className="flex items-center gap-2.5 border-b border-border-subtle px-4 py-3 text-sm text-text-disabled cursor-not-allowed last:border-0"
            >
              <Icon size={16} />
              <span className="flex-1">{label}</span>
              <span className="text-fine font-semibold tracking-wide text-text-tertiary">
                СКОРО
              </span>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-3 rounded-xl border border-border-subtle bg-surface p-4">
          <div>
            <Button
              variant="secondary"
              size="sm"
              disabled={reload.isPending}
              onClick={() => reload.mutate()}
            >
              Перезагрузить конфиг
            </Button>
          </div>
          <div className="rounded-md bg-elevated px-2.5 py-1.5 font-mono text-xs text-text-tertiary">
            SOCKS · {PROXY_ENDPOINT}
          </div>
        </div>
      </div>
    </div>
  );
}
