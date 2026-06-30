import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useAuthStatus, useLogout } from "@/features/auth/useAuth";
import { useLiveState } from "@/features/live/LiveProvider";
import { PROXY_ENDPOINT } from "@/lib/constants";
import type { Theme } from "@/lib/theme";
import { useTheme } from "@/lib/theme-context";
import { useTRPC } from "@/lib/trpc";
import { cn } from "@/lib/utils";

// AUTO group defaults (mirror server nodes/config.ts) — used until settings load.
const AUTO_TEST_URL = "https://www.gstatic.com/generate_204";
const AUTO_INTERVAL = 300; // url-test group interval (s)
const AUTO_TOLERANCE = 50; // url-test tolerance (ms)

const STRATEGY_OPTIONS = [
  { value: "url-test", label: "По задержке" },
  { value: "fallback", label: "Отказоустойчивость" },
  { value: "load-balance", label: "Нагрузка" },
];
const POLL_PRESETS = [1, 2, 5, 10, 30];
const CHECK_PRESETS = [30, 60, 120, 300, 600];

// Render second-valued <option>s, keeping the current value present even off-preset.
function secondsOptions(presets: number[], current: string) {
  const cur = Number(current);
  const values =
    Number.isFinite(cur) && cur > 0 && !presets.includes(cur)
      ? [...presets, cur].sort((a, b) => a - b)
      : presets;
  return values.map((v) => (
    <option key={v} value={String(v)}>
      {v} с
    </option>
  ));
}

export function SettingsScreen() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { theme, setTheme } = useTheme();

  const authStatus = useAuthStatus();
  const logout = useLogout();
  const { mihomo } = useLiveState();

  const settingsQuery = useQuery(trpc.settings.get.queryOptions());
  const data = settingsQuery.data;

  const invalidate = () => qc.invalidateQueries({ queryKey: trpc.settings.get.queryKey() });

  const settingsMutation = useMutation(
    trpc.settings.set.mutationOptions({
      onSuccess: () => {
        void invalidate();
        toast.success("Сохранено");
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  function persistInt(key: string, raw: string, min: number) {
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) return; // reject empty / non-integer input
    if (Number(trimmed) < min) return;
    settingsMutation.mutate({ key, value: String(Number(trimmed)) });
  }

  function persistText(key: string, raw: string) {
    const v = raw.trim();
    if (v.length === 0) return;
    settingsMutation.mutate({ key, value: v });
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Скопировано");
    } catch {
      toast.error("Не удалось скопировать");
    }
  }

  const hwid = data?.hwid;
  const mihomoSecret = data?.mihomoSecret;
  const hasSecret = typeof mihomoSecret === "string" && mihomoSecret.length > 0;
  const autoStrategy = data?.autoStrategy ?? "url-test";
  const autoUrl = data?.autoTestUrl ?? AUTO_TEST_URL;
  const autoInterval = data?.autoTestInterval ?? String(AUTO_INTERVAL);
  const autoTolerance = data?.autoTestTolerance ?? String(AUTO_TOLERANCE);
  const autoSwitch = (data?.autoSwitchOnTimeout ?? "true") === "true";
  const pollInterval = data?.pollInterval ?? "5";
  const engine =
    mihomo === null
      ? { dot: "bg-idle", label: "Проверка" }
      : mihomo
        ? { dot: "bg-online", label: "Подключено" }
        : { dot: "bg-timeout", label: "Отключено" };

  return (
    <div className="flex flex-col gap-[26px] px-8 pt-[26px] pb-10">
      <header className="flex flex-col gap-[5px]">
        <h1 className="text-h1 text-text-primary">Настройки</h1>
        <p className="text-sub text-text-secondary">
          Локальная конфигурация панели и движка mihomo
        </p>
      </header>

      {settingsQuery.isLoading ? (
        <div className="flex flex-col gap-[26px]">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[120px] w-full rounded-lg" />
          ))}
        </div>
      ) : settingsQuery.isError ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-border-subtle bg-surface p-10 text-center text-text-secondary">
          <span>Не удалось загрузить настройки.</span>
          <Button variant="secondary" size="sm" onClick={() => settingsQuery.refetch()}>
            Повторить
          </Button>
        </div>
      ) : (
        <>
          <Section
            title="Внешний вид"
            desc="Оформление панели."
          >
            <Row label="Тема" sub="Тёмная · светлая · системная">
              {/*
                Theme uses localStorage (getTheme) as the source of truth, applied
                synchronously on load. data?.theme is persisted server-side for parity
                but intentionally not read back: the local choice wins (single admin).
                "Системная" (default) follows the OS until an explicit pick.
              */}
              <Segmented
                aria-label="Тема"
                options={[
                  { value: "dark", label: "Тёмная" },
                  { value: "light", label: "Светлая" },
                  { value: "system", label: "Системная" },
                ]}
                value={theme}
                onChange={(v) => {
                  const t = v as Theme;
                  setTheme(t);
                  settingsMutation.mutate({ key: "theme", value: t });
                }}
              />
            </Row>
          </Section>

          <Section
            title="Авто-выбор узла"
            desc="Политика группы PROXY: submerge сам держит активным лучший узел."
          >
            <Row label="Стратегия" sub="Как выбирать активный узел">
              <Segmented
                aria-label="Стратегия"
                options={STRATEGY_OPTIONS}
                value={autoStrategy}
                onChange={(v) => settingsMutation.mutate({ key: "autoStrategy", value: v })}
              />
            </Row>
            <Row label="Тест-URL" sub="Куда mihomo шлёт проверочный запрос">
              <Input
                key={autoUrl}
                type="url"
                aria-label="Тест-URL"
                defaultValue={autoUrl}
                onBlur={(e) => persistText("autoTestUrl", e.target.value)}
                className="w-[360px] font-mono text-[13px]"
              />
            </Row>
            <Row label="Интервал проверки" sub="Как часто переизмерять задержку">
              <Select
                aria-label="Интервал проверки"
                value={autoInterval}
                onChange={(e) =>
                  settingsMutation.mutate({ key: "autoTestInterval", value: e.target.value })
                }
              >
                {secondsOptions(CHECK_PRESETS, autoInterval)}
              </Select>
            </Row>
            <Row label="Допуск, мс" sub="Не переключаться при разнице меньше допуска">
              <Input
                key={autoTolerance}
                type="number"
                aria-label="Допуск (мс)"
                min={0}
                step={1}
                defaultValue={autoTolerance}
                onBlur={(e) => persistInt("autoTestTolerance", e.target.value, 0)}
                className="w-[90px] text-center font-mono"
              />
            </Row>
            <Row
              label="Переключаться при таймауте"
              sub="Сразу выбрать другой узел, если активный отвалился"
            >
              <Switch
                checked={autoSwitch}
                onCheckedChange={(v) =>
                  settingsMutation.mutate({ key: "autoSwitchOnTimeout", value: String(v) })
                }
                aria-label="Переключаться при таймауте"
              />
            </Row>
          </Section>

          <Section title="Подключение" desc="Доступ к API mihomo и локальному прокси.">
            <Row label="Состояние движка" sub="Связь панели с ядром mihomo">
              <span className="inline-flex items-center gap-2">
                <span aria-hidden="true" className={`h-2 w-2 rounded-full ${engine.dot}`} />
                <span className="text-sm text-text-secondary">{engine.label}</span>
              </span>
            </Row>
            <Row label="Секрет mihomo" sub="Токен для RESTful-API контроллера">
              {hasSecret ? (
                <>
                  <ValueBox className="text-text-secondary">••••••••••••</ValueBox>
                  <CopyBtn onClick={() => copy(mihomoSecret)} label="Скопировать секрет" />
                </>
              ) : (
                <Badge variant="neutral">Не задан</Badge>
              )}
            </Row>
            <Row label="Интервал опроса" sub="Частота обновления задержек и трафика">
              <Select
                aria-label="Интервал опроса"
                value={pollInterval}
                onChange={(e) =>
                  settingsMutation.mutate({ key: "pollInterval", value: e.target.value })
                }
              >
                {secondsOptions(POLL_PRESETS, pollInterval)}
              </Select>
            </Row>
            <Row label="Адрес прокси" sub="Локальный SOCKS / HTTP, только чтение">
              <ValueBox>{PROXY_ENDPOINT}</ValueBox>
              <CopyBtn onClick={() => copy(PROXY_ENDPOINT)} label="Скопировать адрес" />
            </Row>
          </Section>

          <Section title="HWID" desc="Идентификатор устройства для источников с привязкой.">
            <Row label="Текущий HWID" sub="Передаётся источникам с включённой привязкой">
              {hwid ? (
                <>
                  <ValueBox className="max-w-[260px]" title={hwid}>
                    {hwid}
                  </ValueBox>
                  <CopyBtn onClick={() => copy(hwid)} label="Скопировать HWID" />
                </>
              ) : (
                <span className="text-xs text-text-tertiary">
                  Будет создан при первом обращении к happ-источнику
                </span>
              )}
            </Row>
          </Section>

          {authStatus.data?.required ? (
            <Section title="Сессия" desc="Доступ к панели администратора.">
              <Row label="Выйти из аккаунта" sub="Завершить текущую сессию">
                <Button
                  variant="destructive"
                  disabled={logout.isPending}
                  onClick={() => logout.mutate()}
                >
                  Выйти
                </Button>
              </Row>
            </Section>
          ) : null}
        </>
      )}
    </div>
  );
}

function Section({ title, desc, children }: { title: string; desc: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3.5">
      <div className="flex flex-col gap-1">
        <h2 className="text-cardtitle text-text-primary">{title}</h2>
        <p className="text-sub text-text-secondary">{desc}</p>
      </div>
      <div className="flex flex-col overflow-hidden rounded-lg border border-border-subtle bg-surface">
        {children}
      </div>
    </section>
  );
}

function Row({ label, sub, children }: { label: string; sub: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-border-subtle px-[18px] py-4 last:border-0">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-sm font-medium text-text-primary">{label}</span>
        <span className="text-xs text-text-tertiary">{sub}</span>
      </div>
      <div className="flex shrink-0 items-center gap-2.5">{children}</div>
    </div>
  );
}

function ValueBox({
  children,
  className,
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-block max-w-full truncate rounded-md border border-border-default bg-input px-3 py-[9px] align-middle font-mono text-[13px] text-text-primary",
        className,
      )}
    >
      {children}
    </span>
  );
}

function CopyBtn({ onClick, label }: { onClick(): void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex h-8 w-8 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-hover hover:text-text-secondary"
    >
      <Copy className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}
