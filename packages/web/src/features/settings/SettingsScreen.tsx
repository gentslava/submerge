import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import type { Theme } from "@/lib/theme";
import { useTheme } from "@/lib/theme-context";
import { useTRPC } from "@/lib/trpc";

const PROXY_ENDPOINT = "127.0.0.1:7890";

export function SettingsScreen() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const { theme, setTheme } = useTheme();

  const settingsQuery = useQuery(trpc.settings.get.queryOptions());
  const data = settingsQuery.data;

  const invalidate = () => qc.invalidateQueries({ queryKey: trpc.settings.get.queryKey() });

  const themeMutation = useMutation(
    trpc.settings.set.mutationOptions({
      onSuccess: () => {
        void invalidate();
        toast.success("Сохранено");
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const intervalMutation = useMutation(
    trpc.settings.set.mutationOptions({
      onSuccess: () => {
        void invalidate();
        toast.success("Сохранено");
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  // TODO(phase-4): consume pollInterval in live queries
  function persistInterval(raw: string) {
    const trimmed = raw.trim();
    if (trimmed === "") return; // ignore empty
    const n = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(n) || n < 1) return; // clamp to a sane positive integer
    intervalMutation.mutate({ key: "pollInterval", value: String(n) });
  }

  async function copyHwid(hwid: string) {
    await navigator.clipboard.writeText(hwid);
    toast.success("Скопировано");
  }

  const hwid = data?.hwid;
  const mihomoSecret = data?.mihomoSecret;

  return (
    <div className="mx-auto max-w-4xl p-4 md:p-8">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold text-text-primary">Настройки</h1>
        <p className="text-sm text-text-secondary">Тема, подключение и идентификатор устройства</p>
      </header>

      {settingsQuery.isPending ? (
        <div className="flex flex-col gap-4">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-32 w-full" />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <Card className="p-5">
            <h2 className="mb-4 text-sm font-semibold text-text-primary">Внешний вид</h2>
            <div className="flex items-center justify-between gap-4">
              <span className="text-sm text-text-secondary">Тема</span>
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
                  themeMutation.mutate({ key: "theme", value: t });
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
                  type="number"
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
                  variant="subtle"
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
        </div>
      )}
    </div>
  );
}
