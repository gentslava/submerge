import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuthStatus, useLogout } from "@/features/auth/useAuth";
import { PROXY_ENDPOINT } from "@/lib/constants";
import type { Theme } from "@/lib/theme";
import { useTheme } from "@/lib/theme-context";
import { useTRPC } from "@/lib/trpc";

export function SettingsScreen() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { theme, setTheme } = useTheme();

  const authStatus = useAuthStatus();
  const logout = useLogout();

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

  function persistInterval(raw: string) {
    const trimmed = raw.trim();
    if (!/^\d+$/.test(trimmed)) return; // reject empty / non-integer input
    const n = Number(trimmed);
    if (n < 1) return; // reject 0
    settingsMutation.mutate({ key: "pollInterval", value: String(n) });
  }

  async function copyHwid(hwid: string) {
    try {
      await navigator.clipboard.writeText(hwid);
      toast.success("Скопировано");
    } catch {
      toast.error("Не удалось скопировать");
    }
  }

  const hwid = data?.hwid;
  const mihomoSecret = data?.mihomoSecret;

  return (
    <div className="mx-auto max-w-4xl p-4 md:p-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-text-primary">Настройки</h1>
        <p className="text-sm text-text-secondary">Тема, подключение и идентификатор устройства</p>
      </header>

      {settingsQuery.isLoading ? (
        <div className="flex flex-col gap-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
      ) : settingsQuery.isError ? (
        <div className="rounded-xl border border-border-subtle bg-surface p-8 text-center text-text-secondary">
          Не удалось загрузить настройки.{" "}
          <Button variant="ghost" size="sm" onClick={() => settingsQuery.refetch()}>
            Повторить
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <Card className="p-5">
            <h2 className="mb-4 text-sm font-semibold text-text-primary">Внешний вид</h2>
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm text-text-secondary">Тема</span>
              {/*
                Theme uses localStorage (getTheme) as the source of truth, applied
                synchronously on load before React renders. data?.theme is persisted to
                the server for cross-device parity but is intentionally NOT read back here:
                for this single-admin app the local choice wins, so this divergence is by
                design, not an oversight.
              */}
              <Segmented
                aria-label="Тема"
                options={[
                  { value: "dark", label: "Тёмная" },
                  { value: "light", label: "Светлая" },
                ]}
                value={theme}
                onChange={(v) => {
                  const t = v as Theme;
                  setTheme(t);
                  settingsMutation.mutate({ key: "theme", value: t });
                }}
              />
            </div>
          </Card>

          <Card className="p-5">
            <h2 className="mb-4 text-sm font-semibold text-text-primary">Подключение</h2>
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between gap-4">
                <span className="text-sm text-text-secondary">Прокси</span>
                <span className="rounded-md bg-elevated px-2.5 py-1 font-mono text-xs text-text-tertiary">
                  {PROXY_ENDPOINT}
                </span>
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-sm text-text-secondary">mihomo secret</span>
                {typeof mihomoSecret === "string" && mihomoSecret.length > 0 ? (
                  <Badge variant="accent">Задан</Badge>
                ) : (
                  <Badge variant="neutral">Не задан</Badge>
                )}
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-sm text-text-secondary">Интервал опроса, с</span>
                <Input
                  key={data?.pollInterval ?? "5"}
                  type="number"
                  aria-label="Интервал опроса (секунды)"
                  min={1}
                  step={1}
                  defaultValue={data?.pollInterval ?? "5"}
                  onBlur={(e) => persistInterval(e.target.value)}
                  className="w-24"
                />
              </div>
            </div>
          </Card>

          <Card className="p-5">
            <h2 className="mb-4 text-sm font-semibold text-text-primary">HWID</h2>
            {hwid ? (
              <div className="flex items-center justify-between gap-3">
                <span title={hwid} className="truncate font-mono text-xs text-text-secondary">
                  {hwid}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Скопировать HWID"
                  onClick={() => void copyHwid(hwid)}
                >
                  <Copy size={16} />
                </Button>
              </div>
            ) : (
              <p className="text-sm text-text-tertiary">
                Будет создан при первом обращении к happ-источнику
              </p>
            )}
          </Card>

          {authStatus.data?.required ? (
            <Card className="p-5">
              <h2 className="mb-4 text-sm font-semibold text-text-primary">Сессия</h2>
              <div className="flex items-center justify-between gap-4">
                <span className="text-sm text-text-secondary">Выйти из аккаунта</span>
                <Button
                  variant="destructive"
                  disabled={logout.isPending}
                  onClick={() => logout.mutate()}
                >
                  Выйти
                </Button>
              </div>
            </Card>
          ) : null}
        </div>
      )}
    </div>
  );
}
