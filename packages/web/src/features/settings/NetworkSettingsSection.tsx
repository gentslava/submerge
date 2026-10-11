import { type NetworkSettings, networkSettingsSchema } from "@submerge/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LabeledControlRow as Row } from "@/components/ui/labeled-control-row";
import { Segmented } from "@/components/ui/segmented";
import { Skeleton } from "@/components/ui/skeleton";
import { useTRPC } from "@/lib/trpc";

export function NetworkSettingsSection() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const configuration = useQuery(trpc.gateway.configuration.queryOptions());
  const mutation = useMutation(
    trpc.gateway.set.mutationOptions({
      onSuccess: (_result, input) =>
        qc.setQueryData(trpc.gateway.configuration.queryKey(), networkSettingsSchema.parse(input)),
      onSettled: () => qc.invalidateQueries({ queryKey: trpc.gateway.configuration.queryKey() }),
    }),
  );
  if (!configuration.data)
    return (
      <section aria-label="Режим подключения" className="flex flex-col gap-3.5">
        <h2 className="text-cardtitle font-semibold text-text-primary">Режим подключения</h2>
        {configuration.isError ? (
          <div className="flex items-center gap-3">
            <p role="alert" className="text-sub text-timeout">
              Не удалось загрузить настройки.
            </p>
            <Button variant="secondary" size="sm" onClick={() => configuration.refetch()}>
              Повторить
            </Button>
          </div>
        ) : (
          <Skeleton className="h-24 w-full" />
        )}
      </section>
    );
  return (
    <NetworkSettingsForm
      configuration={configuration.data}
      pending={mutation.isPending}
      pendingMode={mutation.isPending ? mutation.variables?.mode : undefined}
      error={
        mutation.variables?.mode !== configuration.data.mode
          ? (mutation.error?.message ?? null)
          : null
      }
      dnsError={
        mutation.variables?.mode === configuration.data.mode
          ? (mutation.error?.message ?? null)
          : null
      }
      onApply={(input) => mutation.mutate(input)}
    />
  );
}

export function NetworkSettingsForm({
  configuration,
  pending,
  pendingMode,
  error,
  dnsError,
  onApply,
}: {
  configuration: NetworkSettings;
  pending: boolean;
  pendingMode: NetworkSettings["mode"] | undefined;
  error: string | null;
  dnsError?: string | null;
  onApply: (value: NetworkSettings) => void;
}) {
  const [dns, setDns] = useState<string | null>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const dnsValue = dns ?? configuration.localResolvers.join(", ");
  function saveDns() {
    if (pending || dns === null) return;
    const localResolvers = dns
      .trim()
      .split(/[\s,]+/u)
      .filter(Boolean);
    const parsed = networkSettingsSchema.safeParse({ ...configuration, localResolvers });
    if (!parsed.success) {
      setValidation(
        "Укажите IP-адрес DNS-сервера, например 192.168.1.1, или оставьте поле пустым.",
      );
      return;
    }
    setValidation(null);
    if (localResolvers.join() !== configuration.localResolvers.join()) onApply(parsed.data);
  }
  return (
    <>
      <section
        aria-label="Режим подключения"
        className="network-settings flex min-w-0 flex-col gap-3.5"
      >
        <h2 className="text-cardtitle font-semibold text-text-primary">Режим подключения</h2>
        <div className="overflow-hidden rounded-lg border border-border-subtle bg-surface">
          <Row
            label="Режим"
            sub={
              configuration.mode === "tun"
                ? "Трафик устройств проходит через Submerge."
                : "Для приложений с настройкой HTTP/SOCKS-прокси."
            }
          >
            <div className="settings-field-260 w-full">
              <Segmented
                stretch
                aria-label="Режим подключения"
                value={configuration.mode}
                disabled={pending}
                options={[
                  { value: "proxy", label: "Прокси" },
                  { value: "tun", label: "TUN" },
                ]}
                onChange={(mode) => {
                  if (mode !== configuration.mode)
                    onApply({ ...configuration, mode: mode as NetworkSettings["mode"] });
                }}
              />
            </div>
          </Row>
          {((pending && pendingMode !== configuration.mode) || error) && (
            <div className="px-[18px] py-3">
              {pending ? (
                <p role="status" className="text-sub text-text-secondary">
                  {pendingMode !== configuration.mode
                    ? pendingMode === "tun"
                      ? "Включаем TUN…"
                      : "Включаем прокси…"
                    : "Сохраняем DNS…"}
                </p>
              ) : (
                <p role="alert" className="text-sub text-timeout">
                  {error}
                </p>
              )}
            </div>
          )}
        </div>
      </section>
      <section aria-label="DNS" className="flex min-w-0 flex-col gap-3.5">
        <h2 className="text-cardtitle font-semibold text-text-primary">DNS</h2>
        <div className="overflow-hidden rounded-lg border border-border-subtle bg-surface">
          <Row
            label="DNS домашней сети"
            sub="Если открываете устройства по имени, например nas.lan, укажите IP-адрес DNS-сервера вашей сети. Иначе оставьте пустым."
          >
            <Input
              aria-label="DNS домашней сети"
              placeholder="Не используется"
              value={dnsValue}
              disabled={pending}
              aria-invalid={Boolean(validation)}
              className="settings-field-260 w-full font-mono text-sub"
              onChange={(event) => {
                setDns(event.target.value);
                setValidation(null);
              }}
              onBlur={saveDns}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          </Row>
          {pending && pendingMode === configuration.mode && (
            <p role="status" className="px-[18px] py-3 text-sub text-text-secondary">
              Сохраняем DNS…
            </p>
          )}
          {dnsError && !validation && (
            <p role="alert" className="px-[18px] py-3 text-sub text-timeout">
              {dnsError}
            </p>
          )}
          {validation && (
            <p role="alert" className="px-[18px] py-3 text-sub text-timeout">
              {validation}
            </p>
          )}
        </div>
      </section>
    </>
  );
}
