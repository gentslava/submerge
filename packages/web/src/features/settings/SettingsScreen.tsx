import {
  DEFAULT_AUTO_STRATEGY,
  DEFAULT_AUTO_TEST_INTERVAL,
  DEFAULT_AUTO_TEST_URL,
  DEFAULT_AUTO_TOLERANCE,
  DEFAULT_POLL_INTERVAL,
} from "@submerge/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Eye, EyeOff, type LucideIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useAuthStatus, useLogout } from "@/features/auth/useAuth";
import { PROXY_ENDPOINT } from "@/lib/constants";
import type { Theme } from "@/lib/theme";
import { useTheme } from "@/lib/theme-context";
import { useTRPC } from "@/lib/trpc";
import { cn } from "@/lib/utils";

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

  const settingsQuery = useQuery(trpc.settings.get.queryOptions());
  const data = settingsQuery.data;

  // Engine reachability — polled at the panel's poll cadence and on demand
  // ("Проверить"), so the status updates live without a page reload (this is a
  // direct check, independent of the SSE live stream).
  const pollMs = (Number(data?.pollInterval) || DEFAULT_POLL_INTERVAL) * 1000;
  const healthQuery = useQuery(
    trpc.nodes.health.queryOptions(undefined, { refetchInterval: pollMs }),
  );

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

  const hwid = data?.hwid;
  const mihomoSecret = data?.mihomoSecret ?? "";
  const autoStrategy = data?.autoStrategy ?? DEFAULT_AUTO_STRATEGY;
  const autoUrl = data?.autoTestUrl ?? DEFAULT_AUTO_TEST_URL;
  const autoInterval = data?.autoTestInterval ?? String(DEFAULT_AUTO_TEST_INTERVAL);
  const autoTolerance = data?.autoTestTolerance ?? String(DEFAULT_AUTO_TOLERANCE);
  const autoSwitch = (data?.autoSwitchOnTimeout ?? "true") === "true";
  const pollInterval = data?.pollInterval ?? String(DEFAULT_POLL_INTERVAL);
  const engine = healthQuery.isLoading
    ? { dot: "bg-idle", label: "Проверка" }
    : healthQuery.data?.connected
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
          <Section title="Внешний вид" desc="Оформление панели.">
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
              <Button
                variant="secondary"
                size="sm"
                disabled={healthQuery.isFetching}
                onClick={() => healthQuery.refetch()}
              >
                {healthQuery.isFetching ? "Проверка…" : "Проверить"}
              </Button>
            </Row>
            <Row label="Секрет mihomo" sub="Токен для доступа к RESTful-API mihomo">
              <SecretField
                value={mihomoSecret}
                onSave={(v) => settingsMutation.mutate({ key: "mihomoSecret", value: v })}
              />
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
              <CopyValue value={PROXY_ENDPOINT} copyLabel="Скопировать адрес" />
            </Row>
          </Section>

          <Section title="HWID" desc="Идентификатор устройства для источников с привязкой.">
            <Row label="Текущий HWID" sub="Передаётся источникам с включённой привязкой">
              {hwid ? (
                <CopyValue value={hwid} copyLabel="Скопировать HWID" />
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

// Copy text to the clipboard with a toast — shared by every inline copy button.
async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("Скопировано");
  } catch {
    toast.error("Не удалось скопировать");
  }
}

// Shared field shell — a 320px box (mockup Pnnav: bg-input, border, radius) holding the
// value/input on the left and inline trailing icon buttons (reveal/copy) on the right.
// Keeping copy INSIDE the box keeps copyable fields the same width and aligned.
function FieldShell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "flex h-9 w-[320px] items-center gap-2.5 rounded-md border border-border-default bg-input px-3",
        className,
      )}
    >
      {children}
    </div>
  );
}

// A 15px inline icon button (reveal / copy) that lives inside a FieldShell.
function FieldIcon({
  onClick,
  label,
  icon: Icon,
}: {
  onClick(): void;
  label: string;
  icon: LucideIcon;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex shrink-0 items-center text-text-tertiary transition-colors hover:text-text-secondary"
    >
      <Icon className="h-[15px] w-[15px]" aria-hidden="true" />
    </button>
  );
}

// Read-only value with an inline copy button (proxy address, HWID).
function CopyValue({ value, copyLabel }: { value: string; copyLabel: string }) {
  return (
    <FieldShell>
      <span
        title={value}
        className="min-w-0 flex-1 truncate font-mono text-[13px] text-text-primary"
      >
        {value}
      </span>
      <FieldIcon onClick={() => copyToClipboard(value)} label={copyLabel} icon={Copy} />
    </FieldShell>
  );
}

// Editable mihomo secret — masked by default with reveal + copy inline (mockup Pnnav).
// Saving rotates the engine (server rewrites + reloads the config) and re-points the client.
function SecretField({ value, onSave }: { value: string; onSave(v: string): void }) {
  const [reveal, setReveal] = useState(false);
  return (
    <FieldShell>
      <input
        key={value}
        type={reveal ? "text" : "password"}
        aria-label="Секрет mihomo"
        placeholder="не задан"
        autoComplete="off"
        defaultValue={value}
        onBlur={(e) => {
          const v = e.target.value.trim();
          if (v && v !== value) onSave(v);
        }}
        className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-text-primary outline-none placeholder:text-text-tertiary"
      />
      <FieldIcon
        onClick={() => setReveal((r) => !r)}
        label={reveal ? "Скрыть секрет" : "Показать секрет"}
        icon={reveal ? EyeOff : Eye}
      />
      <FieldIcon onClick={() => copyToClipboard(value)} label="Скопировать секрет" icon={Copy} />
    </FieldShell>
  );
}
