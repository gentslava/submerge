import {
  type ChannelPolicy,
  DEFAULT_POLL_INTERVAL,
  DEFAULT_SPEED_POLICY,
  PSEUDO_NODE_SET,
} from "@submerge/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Eye, EyeOff, type LucideIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuthStatus, useLogout } from "@/features/auth/useAuth";
import { PolicyEditor } from "@/features/channels/PolicyEditor";
import { liveIndicator } from "@/features/live/status";
import { warnIfNotApplied } from "@/lib/apply-toast";
import { copyToClipboard } from "@/lib/clipboard";
import { PROXY_ENDPOINT } from "@/lib/constants";
import { formatRelative } from "@/lib/duration";
import type { Theme } from "@/lib/theme";
import { useTheme } from "@/lib/theme-context";
import { useTRPC } from "@/lib/trpc";
import { cn } from "@/lib/utils";

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
  const pollMs = DEFAULT_POLL_INTERVAL * 1000;
  const healthQuery = useQuery(
    trpc.nodes.health.queryOptions(undefined, { refetchInterval: pollMs }),
  );

  const invalidate = () => qc.invalidateQueries({ queryKey: trpc.settings.get.queryKey() });

  const settingsMutation = useMutation(
    trpc.settings.set.mutationOptions({
      onSuccess: (data) => {
        void invalidate();
        toast.success("Сохранено");
        warnIfNotApplied(data.applied);
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const setPolicyMutation = useMutation(
    trpc.channels.setPolicy.mutationOptions({
      onSuccess: (data) => {
        void qc.invalidateQueries({ queryKey: trpc.channels.get.queryKey() });
        toast.success("Сохранено");
        warnIfNotApplied(data.applied);
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
  // are all editable from this screen, via the shared PolicyEditor. Falls back to the
  // speed default while channelQuery hasn't loaded yet (PolicyEditor takes a required,
  // never-undefined policy — the loading placeholder is this screen's concern).
  const policy: ChannelPolicy = channelQuery.data?.policy ?? DEFAULT_SPEED_POLICY;
  // Real (pinnable) exit nodes for the manual policy's dropdown — mihomo's built-in
  // groups/policies aren't valid pin targets.
  const nodeNames = (nodesQuery.data?.all ?? [])
    .map((n) => n.name)
    .filter((n) => !PSEUDO_NODE_SET.has(n));
  // The node the Default channel is actually routing through right now, resolved
  // past AUTO — seeds PolicyEditor's manual pin with "wherever we already are"
  // instead of an arbitrary first entry when switching Авто → Приоритетный узел.
  const now = nodesQuery.data?.now ?? null;
  const autoNow = nodesQuery.data?.autoNow ?? null;
  const activeNode = (now === "AUTO" ? autoNow : now) ?? undefined;

  const hwid = data?.hwid;
  const mihomoSecret = data?.mihomoSecret ?? "";
  const proxyEndpoint = data?.proxyEndpoint ?? PROXY_ENDPOINT;
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
            <PolicyEditor
              policy={policy}
              nodeNames={nodeNames}
              {...(activeNode !== undefined ? { activeNode } : {})}
              onChange={(p) => setPolicyMutation.mutate({ id: "default", policy: p })}
            />
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
            <Row label="Адрес прокси" sub="Локальный SOCKS / HTTP — адрес для клиентов">
              <div className="flex w-full items-center gap-2.5 md:w-auto">
                <Input
                  key={proxyEndpoint}
                  aria-label="Адрес прокси"
                  defaultValue={proxyEndpoint}
                  onBlur={(e) => persistText("proxyEndpoint", e.target.value)}
                  className="w-full font-mono text-sub md:w-[260px]"
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
      <span title={value} className="min-w-0 flex-1 truncate font-mono text-sub text-text-primary">
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
        className="min-w-0 flex-1 bg-transparent font-mono text-sub text-text-primary outline-none placeholder:text-text-tertiary"
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
