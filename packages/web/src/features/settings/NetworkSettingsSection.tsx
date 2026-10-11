import {
  DEFAULT_POLL_INTERVAL,
  type GatewayProfile,
  gatewayProfileSchema,
  type NetworkProfile,
} from "@submerge/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { type FocusEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LabeledControlRow as Row } from "@/components/ui/labeled-control-row";
import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { copyToClipboard } from "@/lib/clipboard";
import { type RouterOutputs, useTRPC } from "@/lib/trpc";
import { cn } from "@/lib/utils";

type Configuration = RouterOutputs["gateway"]["configuration"];
type Readiness = RouterOutputs["gateway"]["readiness"];
const splitValues = (value: string) => value.split(/[\s,]+/u).filter(Boolean);
const checkLabels: Record<string, string> = {
  "admin-password": "Пароль администратора: минимум 16 символов",
  "engine-secret": "Секрет mihomo: минимум 16 символов",
  network: "Отдельное LAN-подключение контейнера",
  "private-lists": "Доступ к опубликованным спискам",
  configuration: "Сохранённая конфигурация",
  runtime: "Связь с движком и режим маршрутизации",
  "tun-interface": "TUN-интерфейс",
  "tun-disabled": "TUN отключён",
  "dns-udp": "DNS по UDP",
  "dns-tcp": "DNS по TCP",
  "dns-upstream": "Внешний DNS",
  "local-dns": "Локальный DNS",
  "lan-wan-interfaces": "LAN- и WAN-подключения",
  "default-rule": "VPN по умолчанию",
  "vpn-pool": "Доступные VPN-ноды",
  "vpn-egress": "Соединение через VPN",
  "config-applied": "Применение конфигурации",
};
function checkLabel(name: string) {
  if (name.startsWith("provider:")) return `Загрузка списка ${name.slice(9)}`;
  return checkLabels[name] ?? name;
}
function Section({ children }: { children: ReactNode }) {
  return (
    <section
      aria-label="Режим подключения"
      className="network-settings flex min-w-0 flex-col gap-3.5"
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-cardtitle font-semibold text-text-primary">Режим подключения</h2>
        <p className="settings-section-description hidden text-sub text-text-secondary">
          Прокси и TUN используют одни каналы и правила.
        </p>
      </div>
      <div className="overflow-hidden rounded-lg border border-border-subtle bg-surface">
        {children}
      </div>
    </section>
  );
}

export function NetworkSettingsSection() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const poll = DEFAULT_POLL_INTERVAL * 1000;
  const configuration = useQuery(
    trpc.gateway.configuration.queryOptions(undefined, { refetchInterval: poll }),
  );
  const readiness = useQuery(
    trpc.gateway.readiness.queryOptions(undefined, { refetchInterval: poll }),
  );
  const mutation = useMutation(
    trpc.gateway.set.mutationOptions({
      onSuccess: (result) => {
        if (result.applied) toast.success("Режим применён");
      },
      onSettled: async () => {
        await Promise.all([
          qc.invalidateQueries({ queryKey: trpc.gateway.configuration.queryKey() }),
          qc.invalidateQueries({ queryKey: trpc.gateway.readiness.queryKey() }),
        ]);
      },
    }),
  );
  const error = mutation.error
    ? `Не удалось применить режим: ${mutation.error.message}`
    : mutation.data?.applied === false
      ? "Конфигурация сохранена, но режим не применён. Проверьте движок и повторите применение."
      : null;
  if (!configuration.data)
    return (
      <Section>
        {configuration.isError ? (
          <div className="flex flex-col items-start gap-3 px-[18px] py-4">
            <p role="alert" className="text-sub text-timeout">
              Не удалось загрузить режим подключения.
            </p>
            <Button variant="secondary" size="sm" onClick={() => configuration.refetch()}>
              Повторить
            </Button>
          </div>
        ) : (
          <Skeleton className="h-24 w-full" />
        )}
      </Section>
    );
  return (
    <NetworkSettingsForm
      key={configuration.data.profile.profile}
      configuration={configuration.data}
      readiness={readiness.isError ? undefined : readiness.data}
      checkError={readiness.isError}
      pending={mutation.isPending}
      checking={readiness.isFetching}
      error={error}
      onApply={(profile) => mutation.mutate(profile)}
      onCheck={() => {
        void readiness.refetch();
        void configuration.refetch();
      }}
    />
  );
}

export function NetworkSettingsForm({
  configuration,
  readiness,
  pending,
  checking,
  checkError = false,
  error,
  onApply,
  onCheck,
}: {
  configuration: Configuration;
  readiness: Readiness | undefined;
  pending: boolean;
  checking: boolean;
  checkError?: boolean;
  error: string | null;
  onApply: (profile: NetworkProfile) => void;
  onCheck: () => void;
}) {
  const [mode, setMode] = useState(configuration.profile.profile);
  const modePointerIntent = useRef(false);
  const [tun, setTun] = useState(configuration.tun);
  const [localDns, setLocalDns] = useState(tun.localResolvers.join(", "));
  const [validation, setValidation] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [fileToAdd, setFileToAdd] = useState("");
  const [textValues, setTextValues] = useState(() => ({
    nameservers: tun.nameservers.join("\n"),
    bootstrapResolvers: tun.bootstrapResolvers.join("\n"),
    localDomains: tun.localDomains.join("\n"),
    serviceCidrs: tun.serviceCidrs.join("\n"),
    ruZones: tun.ruZones.join("\n"),
    ruGeosite: tun.ruGeosite.join("\n"),
    ruGeoip: tun.ruGeoip.join("\n"),
  }));
  const dirtyFields = useRef(new Set<keyof GatewayProfile>());
  const lastConfiguration = useRef(configuration.tun);
  useEffect(() => {
    const signature = JSON.stringify(configuration.tun);
    if (signature === JSON.stringify(lastConfiguration.current)) return;
    const previous = lastConfiguration.current;
    lastConfiguration.current = configuration.tun;
    const edited = new Set(dirtyFields.current);
    const draft = { ...tun, localResolvers: splitValues(localDns) };
    const preserved = [...edited].filter(
      (key) =>
        JSON.stringify(draft[key]) !== JSON.stringify(configuration.tun[key]) ||
        JSON.stringify(previous[key]) === JSON.stringify(configuration.tun[key]),
    );
    dirtyFields.current = new Set(preserved);
    setTun({
      ...configuration.tun,
      ...Object.fromEntries(preserved.map((key) => [key, tun[key]])),
    });
    if (!edited.has("localResolvers")) setLocalDns(configuration.tun.localResolvers.join(", "));
    const refreshedText = { ...textValues };
    for (const key of Object.keys(textValues) as Array<keyof typeof textValues>) {
      if (!edited.has(key)) refreshedText[key] = configuration.tun[key].join("\n");
    }
    setTextValues(refreshedText);
  }, [configuration.tun, tun, localDns, textValues]);
  const candidate = { ...tun, localResolvers: splitValues(localDns) };
  const modeChanged = mode !== configuration.profile.profile;
  const showTun = mode === "gateway";
  const failures = readiness?.checks.filter((check) => !check.ok) ?? [];
  const missing = configuration.prerequisites.filter((check) => check.ok === false);
  const status = checkError
    ? "Проверка недоступна"
    : !readiness
      ? "Проверка режима…"
      : !readiness.ready
        ? "Режим не подтверждён"
        : readiness.profile === "gateway"
          ? "TUN работает"
          : "Прокси работает";

  function update<K extends keyof GatewayProfile>(
    key: K,
    value: GatewayProfile[K],
    immediate = false,
  ) {
    dirtyFields.current.add(key);
    setTun((current) => ({ ...current, [key]: value }));
    setValidation(null);
    if (immediate) persist(mode, { ...candidate, [key]: value });
  }
  function persist(nextMode = mode, nextTun = candidate, force = false) {
    if (pending) return;
    if (nextMode === "gateway") {
      const parsed = gatewayProfileSchema.safeParse(nextTun);
      if (!parsed.success) {
        const field = String(parsed.error.issues[0]?.path[0]);
        const labels: Record<string, string> = {
          nameservers: "внешние DNS",
          bootstrapResolvers: "bootstrap DNS",
          localDomains: "локальные домены",
          privateLists: "списки",
          lanInterface: "LAN-интерфейс",
          outboundInterface: "WAN-интерфейс",
          dnsListen: "адрес DNS",
          dnsPort: "DNS-порт",
          fakeIpRange: "Fake-IP диапазон",
          tunDevice: "TUN-интерфейс",
          tunStack: "стек TUN",
          mtu: "MTU",
          routeTable: "таблица маршрутов",
          routeRule: "приоритет маршрута",
          serviceCidrs: "служебные подсети",
          ruZones: "RU-зоны",
          ruGeosite: "RU GeoSite",
          ruGeoip: "RU GeoIP",
        };
        setValidation(
          field === "localResolvers"
            ? "Укажите отдельный локальный DNS: IPv4-адрес, при необходимости с портом. Он не должен возвращать запросы в DNS Submerge."
            : `Проверьте дополнительные настройки: ${labels[field] ?? field}.`,
        );
        if (field !== "localResolvers") setAdvanced(true);
        return;
      }
      setValidation(null);
      if (force || error || JSON.stringify(parsed.data) !== JSON.stringify(configuration.profile))
        onApply(parsed.data);
    } else if (force || error || configuration.profile.profile !== "proxy")
      onApply({ profile: "proxy" });
  }
  function persistOnBlur(event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) {
    // A pointer click may blur the input without focusing a button (WebKit).
    // Moving to the mode switch must not activate the old mode on the way out.
    const movingToMode =
      modePointerIntent.current ||
      (event.relatedTarget instanceof HTMLElement &&
        event.relatedTarget.closest(".segmented-control--stretch"));
    modePointerIntent.current = false;
    if (movingToMode) return;
    persist();
  }
  function addFile() {
    if (!fileToAdd) return;
    const stem = fileToAdd
      .replace(/\.txt$/u, "")
      .toLowerCase()
      .replace(/[^a-z0-9-]/gu, "-")
      .slice(0, 36);
    const base = /^[a-z]/u.test(stem) && stem !== "capture" ? stem : `list-${stem}`;
    let name = base;
    let suffix = 1;
    while (tun.privateLists.some((list) => list.name === name)) name = `${base}-${suffix++}`;
    update(
      "privateLists",
      [...tun.privateLists, { name, file: fileToAdd, target: "proxy", behavior: "domain" }],
      true,
    );
    setFileToAdd("");
  }
  function textSetting(
    key:
      | "nameservers"
      | "bootstrapResolvers"
      | "localDomains"
      | "serviceCidrs"
      | "ruZones"
      | "ruGeosite"
      | "ruGeoip",
    label: string,
    sub: string,
  ) {
    return (
      <Row label={label} sub={sub}>
        <Textarea
          aria-label={label}
          disabled={pending}
          value={textValues[key]}
          onChange={(e) => {
            const raw = e.target.value;
            setTextValues((current) => ({ ...current, [key]: raw }));
            update(key, splitValues(raw));
          }}
          onBlur={persistOnBlur}
          className="network-settings-textarea settings-field-260 min-w-0 text-sub"
        />
      </Row>
    );
  }
  function numberSetting(
    key: "dnsPort" | "mtu" | "routeTable" | "routeRule",
    label: string,
    sub: string,
  ) {
    return (
      <Row label={label} sub={sub}>
        <Input
          aria-label={label}
          disabled={pending}
          type="number"
          value={Number.isNaN(tun[key]) ? "" : tun[key]}
          onChange={(e) => update(key, e.target.value === "" ? Number.NaN : Number(e.target.value))}
          onBlur={persistOnBlur}
          className="settings-field-260 w-full font-mono text-sub"
        />
      </Row>
    );
  }
  return (
    <Section>
      <Row label="Режим подключения" sub="Как трафик попадает в Submerge">
        <div className="settings-field-260 w-full">
          <Segmented
            aria-label="Режим подключения"
            stretch
            disabled={pending}
            onPointerDown={() => {
              modePointerIntent.current = true;
            }}
            onPointerCancel={() => {
              modePointerIntent.current = false;
            }}
            options={[
              { value: "proxy", label: "Прокси" },
              { value: "gateway", label: "TUN" },
            ]}
            value={mode}
            onChange={(value) => {
              modePointerIntent.current = false;
              const nextMode = value as "proxy" | "gateway";
              setMode(nextMode);
              setValidation(null);
              if (nextMode === "proxy" || candidate.localResolvers.length > 0) persist(nextMode);
            }}
          />
        </div>
      </Row>
      <p className="px-[18px] py-4 text-sub text-text-secondary">
        {showTun
          ? "TUN принимает трафик устройств. HTTP/SOCKS-прокси также доступен."
          : "Приложения подключаются к HTTP/SOCKS-прокси."}
      </p>
      {showTun && (
        <>
          <Row label="Локальный DNS" sub="Отдельный DNS для имён вашей сети">
            <Input
              aria-label="Локальный DNS"
              aria-invalid={validation?.startsWith("Укажите отдельный локальный DNS") ?? false}
              aria-describedby={!localDns ? "network-local-dns-help" : undefined}
              disabled={pending}
              value={localDns}
              placeholder="IP-адрес DNS вашей сети"
              onChange={(e) => {
                dirtyFields.current.add("localResolvers");
                setLocalDns(e.target.value);
                setValidation(null);
              }}
              onBlur={persistOnBlur}
              className="settings-field-260 w-full font-mono text-sub"
            />
          </Row>
          {!localDns && (
            <p id="network-local-dns-help" className="px-[18px] pb-4 text-xs text-text-tertiary">
              Укажите DNS роутера или отдельного сервера, который разрешает локальные имена и не
              пересылает их обратно в Submerge.
            </p>
          )}
        </>
      )}
      <div
        className="flex flex-col gap-2 border-b border-border-subtle px-[18px] py-4"
        aria-live="polite"
      >
        <span
          className={cn(
            "text-sm font-medium",
            readiness?.ready ? "text-online" : "text-text-secondary",
          )}
        >
          {status}
        </span>
        <p className="text-sub text-text-secondary">
          {pending
            ? "Применение настроек…"
            : modeChanged
              ? showTun && candidate.localResolvers.length === 0
                ? "Для включения TUN укажите локальный DNS."
                : `${showTun ? "TUN" : "Прокси"} ещё не включён.`
              : readiness?.ready
                ? readiness.profile === "gateway"
                  ? "DNS · TUN · списки · VPN — проверки пройдены"
                  : "HTTP/SOCKS-прокси доступен"
                : "Проверьте подключение и условия запуска."}
        </p>
        {failures.length > 0 && (
          <ul className="flex flex-col gap-1 text-xs text-timeout">
            {failures.map((check) => (
              <li key={check.name}>{checkLabel(check.name)}</li>
            ))}
          </ul>
        )}
        {showTun && missing.length > 0 && (
          <div className="flex flex-col gap-1 text-xs text-timeout">
            <span>Для запуска TUN требуется:</span>
            <ul>
              {missing.map((check) => (
                <li key={check.name}>{checkLabel(check.name)}</li>
              ))}
            </ul>
          </div>
        )}
        {showTun && (readiness?.profile !== "gateway" || !readiness.ready) && (
          <p className="text-xs text-text-tertiary">
            Доступ движка к TUN и NET_ADMIN проверяется при применении. Права задаются один раз при
            развёртывании контейнера.
          </p>
        )}
        <div>
          <Button variant="secondary" size="sm" disabled={checking || pending} onClick={onCheck}>
            {checking ? "Проверка…" : "Проверить"}
          </Button>
        </div>
      </div>
      {showTun && (
        <>
          <details
            open={advanced}
            onToggle={(e) => setAdvanced(e.currentTarget.open)}
            className="network-settings-details border-b border-border-subtle"
          >
            <summary className="flex cursor-pointer items-center gap-2 px-[18px] py-4 text-sub text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border">
              <ChevronRight
                aria-hidden="true"
                className={cn("h-4 w-4 shrink-0", advanced && "rotate-90")}
              />
              Дополнительные настройки
            </summary>
            {textSetting(
              "nameservers",
              "Внешние DNS",
              "Независимые публичные IPv4-резолверы, по одному на строку",
            )}
            {textSetting(
              "bootstrapResolvers",
              "Bootstrap DNS",
              "Публичные IPv4-адреса для начального разрешения",
            )}
            {textSetting(
              "localDomains",
              "Локальные домены",
              "Суффиксы, которые разрешает локальный DNS",
            )}
            {(["lanInterface", "outboundInterface", "tunDevice"] as const).map((key) => (
              <Row
                key={key}
                label={
                  {
                    lanInterface: "LAN-интерфейс",
                    outboundInterface: "WAN-интерфейс",
                    tunDevice: "TUN-интерфейс",
                  }[key]
                }
                sub={
                  key === "lanInterface"
                    ? "Подключение устройств"
                    : key === "outboundInterface"
                      ? "Выход в интернет"
                      : "Имя отдельного виртуального интерфейса"
                }
              >
                <Input
                  aria-label={
                    {
                      lanInterface: "LAN-интерфейс",
                      outboundInterface: "WAN-интерфейс",
                      tunDevice: "TUN-интерфейс",
                    }[key]
                  }
                  value={tun[key]}
                  disabled={pending}
                  onChange={(e) => update(key, e.target.value)}
                  onBlur={persistOnBlur}
                  className="settings-field-260 w-full font-mono text-sub"
                />
              </Row>
            ))}
            <Row label="Адрес DNS" sub="0.0.0.0 слушает на всех интерфейсах контейнера">
              <Input
                aria-label="Адрес DNS"
                disabled={pending}
                value={tun.dnsListen}
                onChange={(e) => update("dnsListen", e.target.value)}
                onBlur={persistOnBlur}
                className="settings-field-260 w-full font-mono text-sub"
              />
            </Row>
            {numberSetting(
              "dnsPort",
              "DNS-порт",
              "Отдельный порт для AdGuard или другого DNS-сервера",
            )}
            <Row label="Fake-IP диапазон" sub="Отдельный диапазон для этого экземпляра">
              <Select
                aria-label="Fake-IP диапазон"
                disabled={pending}
                value={tun.fakeIpRange}
                onChange={(e) => update("fakeIpRange", e.target.value, true)}
                className="settings-field-260 w-full font-mono"
              >
                <option value="198.19.0.1/16">198.19.0.1/16</option>
                <option value="198.18.0.1/16">198.18.0.1/16</option>
              </Select>
            </Row>
            <Row label="Стек TUN" sub="Обработка пакетов в движке">
              <Select
                aria-label="Стек TUN"
                disabled={pending}
                value={tun.tunStack}
                onChange={(e) =>
                  update("tunStack", e.target.value as GatewayProfile["tunStack"], true)
                }
              >
                <option value="mixed">Mixed</option>
                <option value="system">System</option>
                <option value="gvisor">gVisor</option>
              </Select>
            </Row>
            {numberSetting("mtu", "MTU, байт", "Максимальный размер пакета")}
            {numberSetting(
              "routeTable",
              "Таблица маршрутов",
              "Отдельный номер для этого экземпляра",
            )}
            {numberSetting(
              "routeRule",
              "Приоритет маршрута",
              "Отдельный номер для этого экземпляра",
            )}
            {textSetting("serviceCidrs", "Служебные подсети", "CIDR-диапазоны с прямым доступом")}
            {textSetting("ruZones", "RU-зоны", "Доменные суффиксы с прямым доступом")}
            {textSetting("ruGeosite", "RU GeoSite", "Категории российских компаний")}
            {textSetting("ruGeoip", "RU GeoIP", "Коды стран; проверяется реальный IP домена")}
            <div className="flex min-w-0 flex-col gap-3 px-[18px] py-4">
              <div>
                <h3 className="text-sm font-medium text-text-primary">Опубликованные списки</h3>
                <p className="text-xs text-text-tertiary">
                  Файлы из подключённого тома. notblocked сохраняет точные домены.
                </p>
              </div>
              {tun.privateLists.length === 0 && (
                <p className="text-sub text-text-secondary">Списки не подключены</p>
              )}
              {tun.privateLists.map((list, index) => (
                <div
                  key={list.name}
                  className="network-settings-list flex min-w-0 flex-wrap items-center gap-2.5"
                >
                  <span className="min-w-0 flex-1 break-all font-mono text-sub text-text-secondary">
                    {list.file}
                  </span>
                  <Select
                    aria-label={`Маршрут ${list.file}`}
                    value={list.target}
                    disabled={pending}
                    onChange={(e) =>
                      update(
                        "privateLists",
                        tun.privateLists.map((item, i) =>
                          i === index
                            ? {
                                ...item,
                                target: e.target.value as typeof list.target,
                                behavior:
                                  e.target.value === "notblocked" ? "domain" : item.behavior,
                              }
                            : item,
                        ),
                        true,
                      )
                    }
                    className="w-full"
                  >
                    <option value="notblocked">notblocked</option>
                    <option value="proxy">Прокси</option>
                    <option value="ru">RU / Direct</option>
                  </Select>
                  <Select
                    aria-label={`Формат ${list.file}`}
                    value={list.behavior}
                    disabled={pending || list.target === "notblocked"}
                    onChange={(e) =>
                      update(
                        "privateLists",
                        tun.privateLists.map((item, i) =>
                          i === index
                            ? { ...item, behavior: e.target.value as typeof list.behavior }
                            : item,
                        ),
                        true,
                      )
                    }
                    className="w-full"
                  >
                    <option value="domain">Домены</option>
                    <option value="classical">Правила</option>
                    <option value="ipcidr">IP / CIDR</option>
                  </Select>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    aria-label={`Убрать ${list.file}`}
                    onClick={() =>
                      update(
                        "privateLists",
                        tun.privateLists.filter((_, i) => i !== index),
                        true,
                      )
                    }
                  >
                    Убрать
                  </Button>
                </div>
              ))}
              {configuration.availableLists.length === 0 ? (
                <p className="text-xs text-text-tertiary">
                  Опубликованных файлов нет. Подключите том списков при развёртывании.
                </p>
              ) : (
                <div className="network-settings-list-add flex min-w-0 flex-wrap gap-2.5">
                  <Select
                    aria-label="Добавить опубликованный список"
                    value={fileToAdd}
                    disabled={pending || tun.privateLists.length >= 32}
                    onChange={(e) => setFileToAdd(e.target.value)}
                    className="w-full"
                  >
                    <option value="">Выберите файл</option>
                    {configuration.availableLists
                      .filter((file) => !tun.privateLists.some((list) => list.file === file))
                      .map((file) => (
                        <option key={file} value={file}>
                          {file}
                        </option>
                      ))}
                  </Select>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!fileToAdd || pending}
                    onClick={addFile}
                  >
                    Добавить
                  </Button>
                </div>
              )}
            </div>
          </details>
          <div className="flex flex-col gap-2 px-[18px] py-4">
            <h3 className="text-sm font-medium text-text-primary">Подключение устройств</h3>
            {configuration.connection.access === "lan" && configuration.connection.lanAddress ? (
              <>
                <p className="break-words text-sub text-text-secondary">
                  Шлюз: <span className="font-mono">{configuration.connection.lanAddress}</span>
                  <br />
                  {configuration.connection.dnsAddress && (
                    <>
                      DNS для AdGuard:{" "}
                      <span className="font-mono">{configuration.connection.dnsAddress}</span>
                      <br />
                    </>
                  )}
                  Направьте через этот шлюз выбранные устройства.
                </p>
                {!configuration.connection.dnsAddress && (
                  <p className="text-xs text-timeout">
                    DNS не слушает на LAN-адресе. В дополнительных настройках укажите адрес DNS
                    0.0.0.0 или LAN-адрес контейнера, изменения сохраняются автоматически.
                  </p>
                )}
                <div>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      copyToClipboard(
                        `Шлюз: ${configuration.connection.lanAddress}${configuration.connection.dnsAddress ? `\nDNS для AdGuard: ${configuration.connection.dnsAddress}` : ""}`,
                      )
                    }
                  >
                    Скопировать адреса
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-sub text-text-secondary">
                LAN-адрес для устройств ещё не подготовлен. Подключите контейнер к вашей локальной
                сети при развёртывании; после этого здесь появятся адрес шлюза и DNS для AdGuard.
              </p>
            )}
            {(!readiness?.ready || readiness.profile !== "gateway" || error) && (
              <p className="text-xs text-text-tertiary">
                Подключайте устройства после успешного применения TUN и проверок.
              </p>
            )}
          </div>
        </>
      )}
      {(validation || error) && (
        <p role="alert" className="break-words px-[18px] py-4 text-sub text-timeout">
          {validation ?? error}
        </p>
      )}
      {(error ||
        readiness?.checks.some((check) => check.name === "config-applied" && !check.ok)) && (
        <div className="flex flex-wrap items-center gap-2.5 px-[18px] py-4">
          <Button disabled={pending} onClick={() => persist(mode, candidate, true)}>
            {pending ? "Повторение…" : "Повторить"}
          </Button>
        </div>
      )}
    </Section>
  );
}
