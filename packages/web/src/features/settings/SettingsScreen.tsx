import { type ChannelPolicy, DEFAULT_POLL_INTERVAL, DEFAULT_SPEED_POLICY } from "@submerge/shared";
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
import { liveIndicator } from "@/features/live/status";
import { copyToClipboard } from "@/lib/clipboard";
import { PROXY_ENDPOINT } from "@/lib/constants";
import { formatInterval, formatRelative } from "@/lib/duration";
import type { Theme } from "@/lib/theme";
import { useTheme } from "@/lib/theme-context";
import { useTRPC } from "@/lib/trpc";
import { cn } from "@/lib/utils";

const POLL_PRESETS = [1, 2, 5, 10, 30];
// Check interval: from the most frequent (unstable links — fastest switching) to the
// longest (stable — don't keep pinging configs). Large values read as minutes.
const CHECK_PRESETS = [5, 10, 30, 60, 300, 600];

// mihomo built-in groups/policies — never valid "priority node" (manual pin) targets.
const PSEUDO_NODES = new Set([
  "AUTO",
  "PROXY",
  "DIRECT",
  "REJECT",
  "REJECT-DROP",
  "PASS",
  "COMPATIBLE",
  "GLOBAL",
]);

// Render interval <option>s (с / мин), keeping the current value present even off-preset.
function secondsOptions(presets: number[], current: string) {
  const cur = Number(current);
  const values =
    Number.isFinite(cur) && cur > 0 && !presets.includes(cur)
      ? [...presets, cur].sort((a, b) => a - b)
      : presets;
  return values.map((v) => (
    <option key={v} value={String(v)}>
      {formatInterval(v)}
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
  const channelQuery = useQuery(trpc.channels.get.queryOptions());
  const decisionsQuery = useQuery(trpc.channels.recentDecisions.queryOptions());
  const nodesQuery = useQuery(trpc.nodes.list.queryOptions());

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

  const setPolicyMutation = useMutation(
    trpc.channels.setPolicy.mutationOptions({
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: trpc.channels.get.queryKey() });
        toast.success("Сохранено");
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  function persistText(key: string, raw: string) {
    const v = raw.trim();
    if (v.length === 0) return;
    settingsMutation.mutate({ key, value: v });
  }

  // The Default channel's policy — `speed`, `sticky`, and `manual` (priority node)
  // are all editable from this screen.
  const policy = channelQuery.data?.policy;
  // Real (pinnable) exit nodes for the manual policy's dropdown — mihomo's built-in
  // groups/policies aren't valid pin targets.
  const nodeNames = (nodesQuery.data?.all ?? [])
    .map((n) => n.name)
    .filter((n) => !PSEUDO_NODES.has(n));
  // Seed the manual pin from the currently-active node, else the first available one.
  function defaultPinnedNode(): string | undefined {
    const view = nodesQuery.data;
    const active = view ? (view.now === "AUTO" ? view.autoNow : view.now) : null;
    if (active && nodeNames.includes(active)) return active;
    return nodeNames[0];
  }
  const speedPolicy: Extract<ChannelPolicy, { kind: "speed" }> =
    policy?.kind === "speed"
      ? policy
      : (DEFAULT_SPEED_POLICY as Extract<ChannelPolicy, { kind: "speed" }>);
  function updateSpeed(patch: Partial<Extract<ChannelPolicy, { kind: "speed" }>>) {
    if (policy?.kind !== "speed") return;
    setPolicyMutation.mutate({ id: "default", policy: { ...policy, ...patch } });
  }

  // Switch the Default channel's policy kind, carrying over shared fields where they
  // exist and seeding the rest with sane defaults. `manual` needs a concrete node, so
  // it seeds from the current active node (or the first available one).
  function switchPolicy(kind: ChannelPolicy["kind"]) {
    if (!policy || policy.kind === kind) return;
    if (kind === "manual") {
      const pinnedNode = defaultPinnedNode();
      if (!pinnedNode) {
        toast.error("Нет доступных узлов для закрепления");
        return;
      }
      setPolicyMutation.mutate({
        id: "default",
        policy: { kind: "manual", pinnedNode, onFailure: "fallback" },
      });
      return;
    }
    const testUrl = "testUrl" in policy ? policy.testUrl : "https://www.gstatic.com/generate_204";
    const intervalSec = "intervalSec" in policy ? policy.intervalSec : 60;
    const next: ChannelPolicy =
      kind === "speed"
        ? { kind: "speed", testUrl, intervalSec, toleranceMs: 50, reevaluateWhileHealthy: true }
        : {
            kind: "sticky",
            testUrl,
            intervalSec,
            failureThreshold: 3,
            maxHoldHours: null,
            initialCriterion: "fastest",
          };
    setPolicyMutation.mutate({ id: "default", policy: next });
  }

  function updateSticky(patch: Partial<Extract<ChannelPolicy, { kind: "sticky" }>>) {
    if (policy?.kind !== "sticky") return;
    setPolicyMutation.mutate({ id: "default", policy: { ...policy, ...patch } });
  }

  function updateManual(patch: Partial<Extract<ChannelPolicy, { kind: "manual" }>>) {
    if (policy?.kind !== "manual") return;
    setPolicyMutation.mutate({ id: "default", policy: { ...policy, ...patch } });
  }

  const hwid = data?.hwid;
  const mihomoSecret = data?.mihomoSecret ?? "";
  const proxyEndpoint = data?.proxyEndpoint ?? PROXY_ENDPOINT;
  const pollInterval = data?.pollInterval ?? String(DEFAULT_POLL_INTERVAL);
  const engine = liveIndicator(
    healthQuery.isLoading ? null : (healthQuery.data?.connected ?? false),
    { idle: "Проверка", ok: "Подключено", down: "Отключено" },
  );

  return (
    <div className="flex flex-col gap-[26px] px-4 pt-5 pb-10 md:px-8 md:pt-[26px]">
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

          <Section title="Авто-выбор узла" desc="Как submerge держит активным лучший узел.">
            <Row
              label="Политика"
              sub="По задержке — гонка; стабильный IP — держит узел; приоритетный — ваш узел"
            >
              <Segmented
                aria-label="Политика выбора"
                value={policy?.kind ?? "speed"}
                onChange={(v) => switchPolicy(v as ChannelPolicy["kind"])}
                options={[
                  { value: "speed", label: "По задержке" },
                  { value: "sticky", label: "Стабильный IP" },
                  { value: "manual", label: "Приоритетный узел" },
                ]}
              />
            </Row>
            {policy?.kind === "sticky" ? (
              <>
                <Row label="Проверочный URL" sub="Куда mihomo шлёт проверочный запрос">
                  <Input
                    key={policy.testUrl}
                    type="url"
                    aria-label="Проверочный URL"
                    defaultValue={policy.testUrl}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v.length > 0) updateSticky({ testUrl: v });
                    }}
                    className="w-full font-mono text-[13px] md:w-[360px]"
                  />
                </Row>
                <Row label="Интервал проверки, с" sub="Как часто переизмерять задержку">
                  <Select
                    aria-label="Интервал проверки"
                    value={String(policy.intervalSec)}
                    onChange={(e) => updateSticky({ intervalSec: Number(e.target.value) })}
                  >
                    {secondsOptions(CHECK_PRESETS, String(policy.intervalSec))}
                  </Select>
                </Row>
                <Row label="Порог сбоев" sub="Подряд идущих неудач перед переключением узла">
                  <Input
                    key={policy.failureThreshold}
                    type="number"
                    aria-label="Порог сбоев"
                    min={1}
                    step={1}
                    defaultValue={policy.failureThreshold}
                    onBlur={(e) => {
                      const trimmed = e.target.value.trim();
                      if (!/^\d+$/.test(trimmed) || Number(trimmed) < 1) return;
                      updateSticky({ failureThreshold: Number(trimmed) });
                    }}
                    className="w-[90px] text-center font-mono"
                  />
                </Row>
                <Row label="Держать не дольше, ч" sub="Пусто — держать узел неограниченно долго">
                  <Input
                    key={policy.maxHoldHours ?? "unlimited"}
                    type="number"
                    aria-label="Держать не дольше (ч)"
                    min={1}
                    step={1}
                    placeholder="∞"
                    defaultValue={policy.maxHoldHours ?? ""}
                    onBlur={(e) => {
                      const trimmed = e.target.value.trim();
                      if (trimmed === "") {
                        updateSticky({ maxHoldHours: null });
                        return;
                      }
                      if (!/^\d+$/.test(trimmed) || Number(trimmed) < 1) return;
                      updateSticky({ maxHoldHours: Number(trimmed) });
                    }}
                    className="w-[90px] text-center font-mono"
                  />
                </Row>
                <Row
                  label="Критерий выбора"
                  sub="По скорости — наименьший пинг; по стабильности — узел с меньшими потерями пакетов"
                >
                  <Segmented
                    aria-label="Критерий выбора"
                    value={policy.initialCriterion}
                    onChange={(v) =>
                      updateSticky({ initialCriterion: v as "fastest" | "lowest-loss" })
                    }
                    options={[
                      { value: "fastest", label: "По скорости" },
                      { value: "lowest-loss", label: "По стабильности" },
                    ]}
                  />
                </Row>
              </>
            ) : policy?.kind === "manual" ? (
              <>
                <Row label="Приоритетный узел" sub="Через него идёт трафик большую часть времени">
                  <Select
                    aria-label="Приоритетный узел"
                    value={policy.pinnedNode}
                    onChange={(e) => updateManual({ pinnedNode: e.target.value })}
                    className="w-full md:w-[280px]"
                  >
                    {/* Keep the current pin present even if it's momentarily absent from the live list. */}
                    {(nodeNames.includes(policy.pinnedNode)
                      ? nodeNames
                      : [policy.pinnedNode, ...nodeNames]
                    ).map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </Select>
                </Row>
                <Row
                  label="При отказе узла"
                  sub="Если приоритетный узел недоступен — уйти на запасной или держать его"
                >
                  <Segmented
                    aria-label="При отказе узла"
                    value={policy.onFailure}
                    onChange={(v) => updateManual({ onFailure: v as "fallback" | "hold" })}
                    options={[
                      { value: "fallback", label: "Запасной узел" },
                      { value: "hold", label: "Держать" },
                    ]}
                  />
                </Row>
              </>
            ) : (
              <>
                <Row label="Тест-URL" sub="Куда mihomo шлёт проверочный запрос">
                  <Input
                    key={speedPolicy.testUrl}
                    type="url"
                    aria-label="Тест-URL"
                    defaultValue={speedPolicy.testUrl}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v.length > 0) updateSpeed({ testUrl: v });
                    }}
                    className="w-full font-mono text-[13px] md:w-[360px]"
                  />
                </Row>
                <Row label="Интервал проверки" sub="Как часто переизмерять задержку">
                  <Select
                    aria-label="Интервал проверки"
                    value={String(speedPolicy.intervalSec)}
                    onChange={(e) => updateSpeed({ intervalSec: Number(e.target.value) })}
                  >
                    {secondsOptions(CHECK_PRESETS, String(speedPolicy.intervalSec))}
                  </Select>
                </Row>
                <Row label="Допуск, мс" sub="Не переключаться при разнице меньше допуска">
                  <Input
                    key={speedPolicy.toleranceMs}
                    type="number"
                    aria-label="Допуск (мс)"
                    min={0}
                    step={1}
                    defaultValue={speedPolicy.toleranceMs}
                    onBlur={(e) => {
                      const trimmed = e.target.value.trim();
                      if (!/^\d+$/.test(trimmed)) return;
                      updateSpeed({ toleranceMs: Number(trimmed) });
                    }}
                    className="w-[90px] text-center font-mono"
                  />
                </Row>
                <Row
                  label="Переоценивать, пока узел жив"
                  sub="Переизмерять задержку каждый интервал, даже если активный узел здоров"
                >
                  <Switch
                    checked={speedPolicy.reevaluateWhileHealthy}
                    onCheckedChange={(v) => updateSpeed({ reevaluateWhileHealthy: v })}
                    aria-label="Переоценивать, пока узел жив"
                  />
                </Row>
              </>
            )}
            <div className="flex flex-col gap-2 px-[18px] py-4">
              <span className="text-sm font-medium text-text-primary">История решений</span>
              {decisionsQuery.data && decisionsQuery.data.length > 0 ? (
                <ul className="flex flex-col gap-1.5">
                  {decisionsQuery.data.slice(0, 10).map((entry) => (
                    <li key={entry.at} className="font-mono text-xs text-text-tertiary">
                      {entry.reason} · {formatRelative(entry.at)}
                    </li>
                  ))}
                </ul>
              ) : (
                <span className="text-xs text-text-tertiary">Пока нет переключений</span>
              )}
            </div>
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
            <Row label="Адрес прокси" sub="Локальный SOCKS / HTTP — адрес для клиентов">
              <div className="flex w-full items-center gap-2.5 md:w-auto">
                <Input
                  key={proxyEndpoint}
                  aria-label="Адрес прокси"
                  defaultValue={proxyEndpoint}
                  onBlur={(e) => persistText("proxyEndpoint", e.target.value)}
                  className="w-full font-mono text-[13px] md:w-[260px]"
                />
                <IconButton
                  onClick={() => copyToClipboard(proxyEndpoint)}
                  label="Скопировать адрес"
                  icon={Copy}
                  size={16}
                />
              </div>
            </Row>
          </Section>

          <Section title="HWID" desc="Идентификатор устройства для источников с привязкой.">
            <Row label="Текущий HWID" sub="Передаётся источникам с включённой привязкой">
              {hwid ? (
                <ReadonlyCopyField
                  value={hwid}
                  widthClass="w-full md:w-[260px]"
                  copyLabel="Скопировать HWID"
                />
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
    <div className="flex flex-col gap-2 border-b border-border-subtle px-[18px] py-4 last:border-0 md:flex-row md:items-center md:justify-between md:gap-6">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-sm font-medium text-text-primary">{label}</span>
        <span className="text-xs text-text-tertiary">{sub}</span>
      </div>
      <div className="flex w-full items-center gap-2.5 md:w-auto md:shrink-0">{children}</div>
    </div>
  );
}

// Bordered field box (mockup: bg-input, border, radius 8, h-9). Width is per-field —
// the mockup sizes them differently (secret 320, proxy 220, HWID 260), so callers set it.
function FieldBox({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "flex h-9 items-center gap-2.5 overflow-hidden rounded-md border border-border-default bg-input px-3",
        className,
      )}
    >
      {children}
    </div>
  );
}

// Icon button (reveal / copy) — text-tertiary with a hover tint, no chrome (mockup).
function IconButton({
  onClick,
  label,
  icon: Icon,
  size = 15,
}: {
  onClick(): void;
  label: string;
  icon: LucideIcon;
  size?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex shrink-0 items-center text-text-tertiary transition-colors hover:text-text-secondary"
    >
      <Icon size={size} aria-hidden="true" />
    </button>
  );
}

// Read-only value with the copy icon INSIDE the box (like the secret) — only the box
// WIDTH differs per field (proxy 220px, HWID 260px), not the copy placement.
function ReadonlyCopyField({
  value,
  widthClass,
  copyLabel,
}: {
  value: string;
  widthClass: string;
  copyLabel: string;
}) {
  return (
    <FieldBox className={widthClass}>
      <span
        title={value}
        className="min-w-0 flex-1 truncate font-mono text-[13px] text-text-primary"
      >
        {value}
      </span>
      <IconButton onClick={() => copyToClipboard(value)} label={copyLabel} icon={Copy} />
    </FieldBox>
  );
}

// Editable mihomo secret (mockup Pnnav): a 320px box with reveal + copy INSIDE it.
// Saving rotates the engine (server rewrites + reloads the config) and re-points the client.
function SecretField({ value, onSave }: { value: string; onSave(v: string): void }) {
  const [reveal, setReveal] = useState(false);
  return (
    <FieldBox className="w-full md:w-[320px]">
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
      <IconButton
        onClick={() => setReveal((r) => !r)}
        label={reveal ? "Скрыть секрет" : "Показать секрет"}
        icon={reveal ? EyeOff : Eye}
      />
      <IconButton onClick={() => copyToClipboard(value)} label="Скопировать секрет" icon={Copy} />
    </FieldBox>
  );
}
