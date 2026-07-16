import type {
  DiagnosticCheckStatus,
  DiagnosticRouteResult,
  DiagnosticServiceResult,
  DiagnosticsResult,
} from "@submerge/shared";
import {
  Boxes,
  Gauge,
  Globe2,
  LoaderCircle,
  Route,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  diagnosticStateCopy,
  diagnosticStatusVisual,
  formatDiagnosticDuration,
  passCount,
  safeDiagnosticTitle,
} from "./view";

export interface DiagnosticsSectionsProps {
  result: DiagnosticsResult;
  running: boolean;
}

export function DiagnosticsSections({ result, running }: DiagnosticsSectionsProps) {
  return (
    <div className="diagnostics-sections flex min-w-0 flex-col gap-3.5">
      <Verdict result={result} running={running} />
      <div className="diagnostics-overview-grid grid min-w-0 gap-3.5">
        <ExternalIpCard result={result.externalIp} />
        <ComponentsCard components={result.components} />
      </div>
      <div className="diagnostics-details-grid grid min-w-0 gap-3.5">
        <RoutesCard routes={result.routes} />
        <ServicesCard services={result.services} />
        <RuntimeConfigCard config={result.config} />
      </div>
    </div>
  );
}

function Verdict({ result, running }: DiagnosticsSectionsProps) {
  const copy = diagnosticStateCopy(running ? "running" : result.state);
  const tone = {
    ok: "border-online bg-online-bg text-online",
    warning: "border-slow bg-slow-bg text-slow",
    error: "border-timeout bg-timeout-bg text-timeout",
    running: "border-accent-border bg-accent-bg text-accent-text",
  }[copy.tone];
  return (
    <section
      aria-labelledby="diagnostics-verdict-title"
      className={cn(
        "diagnostics-verdict flex min-w-0 items-center gap-3 rounded-lg border px-4 py-3.5",
        tone,
      )}
    >
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface/60">
        {running ? (
          <LoaderCircle
            aria-hidden="true"
            size={18}
            className="animate-spin motion-reduce:animate-none"
          />
        ) : (
          <ShieldCheck aria-hidden="true" size={18} />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <h2 id="diagnostics-verdict-title" className="text-cardtitle text-text-primary">
            {copy.title}
          </h2>
          <span className="rounded-full bg-surface/60 px-2 py-0.5 text-micro font-semibold tracking-[0.4px]">
            {copy.badge}
          </span>
        </span>
        <span className="text-fine text-text-secondary">{copy.detail}</span>
        <span className="flex flex-wrap items-center gap-x-2 text-fine text-text-tertiary">
          <span>{result.summary}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={result.completedAt}>
            завершено {formatCompletedAt(result.completedAt)}
          </time>
        </span>
      </span>
      {running ? (
        <span role="status" className="shrink-0 text-fine font-medium">
          Обновляем результаты
        </span>
      ) : null}
    </section>
  );
}

function CardShell({
  label,
  icon,
  className,
  count,
  children,
}: {
  label: string;
  icon: ReactNode;
  className?: string;
  count?: ReactNode;
  children: ReactNode;
}) {
  const headingId = `diagnostics-${label.toLowerCase().replaceAll(/[^a-zа-я0-9]+/giu, "-")}`;
  return (
    <section
      aria-label={label}
      aria-labelledby={headingId}
      className={cn(
        "diagnostics-card min-w-0 rounded-lg border border-border-subtle bg-surface",
        className,
      )}
    >
      <header className="diagnostics-card-header flex min-w-0 items-center gap-3 px-4 pb-3 pt-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-elevated text-text-secondary">
          {icon}
        </span>
        <h2 id={headingId} className="min-w-0 flex-1 text-cardtitle text-text-primary">
          {label}
        </h2>
        {count}
      </header>
      {children}
    </section>
  );
}

function ExternalIpCard({ result }: { result: DiagnosticsResult["externalIp"] }) {
  const visual = diagnosticStatusVisual(result.status, result.durationMs);
  return (
    <CardShell label="Внешний IP" icon={<Globe2 aria-hidden="true" size={18} />}>
      <div className="flex min-w-0 flex-col gap-2 px-4 pb-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span
            title={safeDiagnosticTitle(result.ip)}
            className={cn(
              "min-w-0 truncate font-mono text-page-title-compact text-text-primary",
              result.status !== "ok" && "text-text-tertiary",
            )}
          >
            {safeDiagnosticTitle(result.ip)}
          </span>
          {result.country || result.colo ? (
            <span className="rounded-full bg-online-bg px-2 py-1 font-mono text-fine text-online">
              {[result.country, result.colo].filter(Boolean).join(" · ")}
            </span>
          ) : null}
        </div>
        {result.status === "ok" ? (
          <>
            <p className="min-w-0 truncate font-mono text-fine text-text-secondary">
              через{" "}
              <span title={safeDiagnosticTitle(result.route)}>
                {safeDiagnosticTitle(result.route)}
              </span>
              {result.node ? (
                <>
                  {" · "}
                  <span title={result.node}>{result.node}</span>
                </>
              ) : null}
            </p>
            <p className="font-mono text-fine text-text-tertiary">
              Cloudflare trace · {formatDiagnosticDuration(result.durationMs)}
            </p>
          </>
        ) : (
          <p className="text-fine text-text-secondary">{result.detail}</p>
        )}
        <span className="sr-only">{visual.label}</span>
      </div>
    </CardShell>
  );
}

function ComponentsCard({ components }: { components: DiagnosticsResult["components"] }) {
  return (
    <CardShell label="Компоненты" icon={<Boxes aria-hidden="true" size={18} />}>
      <div className="px-4 pb-3">
        {components.map((component) => {
          const visual = diagnosticStatusVisual(component.status, component.durationMs);
          return (
            <div
              key={component.id}
              className="flex min-w-0 items-center gap-3 border-b border-border-subtle py-3 first:pt-1 last:border-b-0"
            >
              <StatusDot status={component.status} durationMs={component.durationMs} />
              <span className="min-w-0 flex-1 truncate font-mono text-sub font-medium text-text-primary">
                {component.id}
              </span>
              <span className="min-w-0 truncate font-mono text-fine text-text-tertiary">
                {component.version ?? component.detail}
              </span>
              <span className={cn("shrink-0 font-mono text-fine", visual.textClass)}>
                {formatDiagnosticDuration(component.durationMs)}
              </span>
            </div>
          );
        })}
      </div>
    </CardShell>
  );
}

function RoutesCard({ routes }: { routes: DiagnosticsResult["routes"] }) {
  const count = passCount(routes);
  return (
    <CardShell
      label="Проверка маршрутов"
      className="diagnostics-routes-card"
      icon={<Route aria-hidden="true" size={18} />}
      count={<PassBadge passed={count.passed} attempted={count.attempted} />}
    >
      {routes.length === 0 ? (
        <p className="px-4 pb-4 text-sub text-text-tertiary">Маршруты не проверялись</p>
      ) : (
        <div className="min-w-0 border-t border-border-subtle">
          <table
            aria-label="Маршруты"
            className="diagnostics-routes-desktop w-full table-fixed border-collapse"
          >
            <thead className="diagnostics-routes-columns bg-elevated text-caption text-text-tertiary">
              <tr>
                <th scope="col" className="px-4 py-2.5 text-left font-medium">
                  КАНАЛ
                </th>
                <th scope="col" className="px-2 py-2.5 text-left font-medium">
                  ПРОВЕРКА
                </th>
                <th scope="col" className="px-2 py-2.5 text-left font-medium">
                  УЗЕЛ
                </th>
                <th scope="col" className="px-2 py-2.5 text-left font-medium">
                  СТАТУС
                </th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">
                  ЗАДЕРЖКА
                </th>
              </tr>
            </thead>
            <tbody>
              {routes.map((route) => (
                <DesktopRouteRow key={route.channelId} route={route} />
              ))}
            </tbody>
          </table>
          <ul aria-label="Маршруты" className="diagnostics-routes-compact hidden">
            {routes.map((route) => (
              <CompactRouteRow key={route.channelId} route={route} />
            ))}
          </ul>
        </div>
      )}
    </CardShell>
  );
}

function DesktopRouteRow({ route }: { route: DiagnosticRouteResult }) {
  const visual = diagnosticStatusVisual(route.status, route.durationMs);
  return (
    <tr className="border-b border-border-subtle last:border-b-0">
      <td className="min-w-0 px-4 py-3">
        <span
          title={route.channelName}
          className="block truncate text-sub font-medium text-text-primary"
        >
          {route.channelName}
        </span>
      </td>
      <td className="min-w-0 px-2 py-3">
        <span
          title={route.targetHost}
          className="block truncate font-mono text-fine text-text-tertiary"
        >
          {route.targetHost}
        </span>
      </td>
      <td className="min-w-0 px-2 py-3">
        <span
          title={safeDiagnosticTitle(route.node)}
          className="block truncate font-mono text-fine text-text-secondary"
        >
          {safeDiagnosticTitle(route.node)}
        </span>
      </td>
      <td className="min-w-0 px-2 py-3">
        <span className="flex min-w-0 flex-col gap-0.5">
          <StatusLabel status={route.status} durationMs={route.durationMs} />
          {route.status !== "ok" ? (
            <span title={route.detail} className="truncate text-caption text-text-tertiary">
              {route.detail}
            </span>
          ) : null}
        </span>
      </td>
      <td className={cn("px-4 py-3 text-right font-mono text-fine", visual.textClass)}>
        {formatDiagnosticDuration(route.durationMs)}
      </td>
    </tr>
  );
}

function CompactRouteRow({ route }: { route: DiagnosticRouteResult }) {
  const visual = diagnosticStatusVisual(route.status, route.durationMs);
  return (
    <li className="flex min-w-0 flex-col gap-1.5 border-b border-border-subtle px-4 py-3 last:border-b-0">
      <div className="flex min-w-0 items-center gap-2">
        <StatusDot status={route.status} durationMs={route.durationMs} />
        <span
          title={route.channelName}
          className="min-w-0 flex-1 truncate text-label text-text-primary"
        >
          {route.channelName}
        </span>
        <span className={cn("shrink-0 font-mono text-fine", visual.textClass)}>
          {formatDiagnosticDuration(route.durationMs)}
        </span>
      </div>
      <p className="min-w-0 truncate font-mono text-fine text-text-tertiary">
        <span title={route.targetHost}>{route.targetHost}</span>
        <span aria-hidden="true"> → </span>
        <span title={safeDiagnosticTitle(route.node)}>{safeDiagnosticTitle(route.node)}</span>
      </p>
      <span className="text-fine text-text-secondary">{visual.label}</span>
      {route.status !== "ok" ? (
        <span title={route.detail} className="text-fine text-text-tertiary">
          {route.detail}
        </span>
      ) : null}
    </li>
  );
}

function ServicesCard({ services }: { services: DiagnosticsResult["services"] }) {
  const count = passCount(services);
  return (
    <CardShell
      label="Доступность сервисов"
      className="diagnostics-services-card"
      icon={<Gauge aria-hidden="true" size={18} />}
      count={<PassBadge passed={count.passed} attempted={count.attempted} />}
    >
      <div className="px-4 pb-3">
        {services.map((service) => (
          <ServiceRow key={service.id} service={service} />
        ))}
      </div>
    </CardShell>
  );
}

function ServiceRow({ service }: { service: DiagnosticServiceResult }) {
  const visual = diagnosticStatusVisual(service.status, service.durationMs);
  return (
    <div className="flex min-w-0 items-center gap-2.5 py-2">
      <StatusDot status={service.status} durationMs={service.durationMs} />
      <span className="min-w-0 flex-1 truncate text-sub text-text-primary">{service.label}</span>
      <span className="sr-only">{visual.label}</span>
      <span className={cn("shrink-0 font-mono text-fine", visual.textClass)}>
        {service.status === "ok" ? formatDiagnosticDuration(service.durationMs) : service.detail}
      </span>
    </div>
  );
}

function RuntimeConfigCard({ config }: { config: DiagnosticsResult["config"] }) {
  const rows = [
    ["SOCKS / HTTP", config.proxyEndpoint],
    ["Режим", config.mode],
    ["DNS", booleanValue(config.dns)],
    ["IPv6", booleanValue(config.ipv6)],
    ["TUN", booleanValue(config.tun)],
  ] as const;
  return (
    <CardShell
      label="Конфигурация mihomo"
      className="diagnostics-config-card"
      icon={<SlidersHorizontal aria-hidden="true" size={18} />}
      count={<StatusLabel status={config.status} durationMs={null} />}
    >
      <div className="px-4 pb-3">
        {rows.map(([label, value]) => (
          <div key={label} className="flex min-w-0 items-center gap-4 py-2">
            <span className="min-w-0 flex-1 text-fine text-text-tertiary">{label}</span>
            <span
              title={safeDiagnosticTitle(value)}
              className="max-w-[65%] truncate font-mono text-fine text-text-primary"
            >
              {safeDiagnosticTitle(value)}
            </span>
          </div>
        ))}
      </div>
    </CardShell>
  );
}

function StatusDot({
  status,
  durationMs,
}: {
  status: DiagnosticCheckStatus;
  durationMs: number | null;
}) {
  const visual = diagnosticStatusVisual(status, durationMs);
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      <span aria-hidden="true" className={cn("h-1.5 w-1.5 rounded-full", visual.dotClass)} />
      <span className="sr-only">{visual.label}</span>
    </span>
  );
}

function StatusLabel({
  status,
  durationMs,
}: {
  status: DiagnosticCheckStatus;
  durationMs: number | null;
}) {
  const visual = diagnosticStatusVisual(status, durationMs);
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5 text-fine", visual.textClass)}>
      <span
        aria-hidden="true"
        className={cn("h-1.5 w-1.5 shrink-0 rounded-full", visual.dotClass)}
      />
      <span className="truncate">{visual.label}</span>
    </span>
  );
}

function PassBadge({ passed, attempted }: { passed: number; attempted: number }) {
  const tone =
    attempted === 0
      ? "bg-elevated text-text-tertiary"
      : passed === attempted
        ? "bg-online-bg text-online"
        : passed === 0
          ? "bg-timeout-bg text-timeout"
          : "bg-slow-bg text-slow";
  const dot =
    attempted === 0
      ? "bg-idle"
      : passed === attempted
        ? "bg-online"
        : passed === 0
          ? "bg-timeout"
          : "bg-slow";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-1 font-mono text-fine",
        tone,
      )}
    >
      <span className="sr-only">
        {passed} из {attempted} проверок пройдено
      </span>
      <span aria-hidden="true" className={cn("h-1.5 w-1.5 rounded-full", dot)} />
      <span aria-hidden="true">
        {passed} / {attempted}
      </span>
    </span>
  );
}

function booleanValue(value: boolean | null): string | null {
  if (value === null) return null;
  return value ? "Включён" : "Выключен";
}

function formatCompletedAt(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}
