import type { DiagnosticsResult } from "@submerge/shared";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DiagnosticsSections } from "./DiagnosticsSections";

function result(overrides: Partial<DiagnosticsResult> = {}): DiagnosticsResult {
  return {
    startedAt: "2026-07-16T08:00:00.000Z",
    completedAt: "2026-07-16T08:00:02.000Z",
    durationMs: 2000,
    state: "ready",
    summary: "2 из 2 маршрутов · 6 из 6 сервисов",
    components: [
      {
        id: "submerge",
        status: "ok",
        durationMs: 12,
        version: "0.2.0",
        detail: "SQLite доступна",
        errorCode: null,
      },
      {
        id: "mihomo",
        status: "ok",
        durationMs: 4,
        version: "v1.19.12",
        detail: "Контроллер доступен",
        errorCode: null,
      },
      {
        id: "happ-decoder",
        status: "ok",
        durationMs: 18,
        version: null,
        detail: "Доступен",
        errorCode: null,
      },
    ],
    externalIp: {
      status: "ok",
      ip: "185.107.56.42",
      country: "NL",
      colo: "AMS",
      durationMs: 84,
      route: "Default",
      node: "nl-ams-01",
      detail: "Внешний IP определён",
      errorCode: null,
    },
    routes: [
      {
        channelId: "default",
        channelName: "Default",
        targetHost: "www.gstatic.com",
        node: "nl-ams-01",
        status: "ok",
        durationMs: 48,
        detail: "Маршрут доступен",
        errorCode: null,
      },
      {
        channelId: "ch1",
        channelName: "AI",
        targetHost: "chatgpt.com",
        node: "de-fra-02",
        status: "ok",
        durationMs: 70,
        detail: "Маршрут доступен",
        errorCode: null,
      },
    ],
    services: [
      ["google", "Google", 44],
      ["youtube", "YouTube", 52],
      ["telegram", "Telegram", 61],
      ["cloudflare", "Cloudflare", 39],
      ["chatgpt", "ChatGPT", 70],
      ["steam", "Steam", 800],
    ].map(([id, label, durationMs]) => ({
      id: id as DiagnosticsResult["services"][number]["id"],
      label: String(label),
      status: "ok" as const,
      durationMs: Number(durationMs),
      httpStatus: 200,
      detail: "Доступен",
      errorCode: null,
    })),
    config: {
      status: "ok",
      proxyEndpoint: "127.0.0.1:7890",
      mode: "rule",
      dns: true,
      ipv6: false,
      tun: false,
      errorCode: null,
    },
    ...overrides,
  };
}

describe("DiagnosticsSections", () => {
  it("renders the approved healthy hierarchy and textual statuses", () => {
    render(<DiagnosticsSections result={result()} running={false} />);
    expect(screen.getByRole("heading", { name: "Все проверки пройдены" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Внешний IP" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Компоненты" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Проверка маршрутов" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Доступность сервисов" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Конфигурация mihomo" })).toBeInTheDocument();
    expect(screen.getAllByText("Работает").length).toBeGreaterThan(3);
    expect(screen.getAllByText("Работает медленно").length).toBeGreaterThan(0);
  });

  it("keeps the previous result visible during refresh", () => {
    render(<DiagnosticsSections result={result()} running />);
    expect(screen.getByRole("heading", { name: "Проверка выполняется" })).toBeInTheDocument();
    expect(screen.getByText("185.107.56.42")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Обновляем результаты");
  });

  it.each([
    ["partial", "Есть замечания"],
    ["mihomo-down", "mihomo недоступен"],
    ["no-nodes", "Нет прокси-узлов"],
    ["no-internet", "Нет выхода в интернет"],
    ["external-ip-unavailable", "Внешний IP не определён"],
  ] as const)("renders %s verdict with text", (state, title) => {
    render(<DiagnosticsSections result={result({ state })} running={false} />);
    expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
  });

  it("shows skipped dependents and safe failure detail when mihomo is down", () => {
    const failed = result({
      state: "mihomo-down",
      externalIp: {
        ...result().externalIp,
        status: "skipped",
        ip: null,
        country: null,
        colo: null,
        durationMs: null,
        route: null,
        node: null,
        detail: "mihomo недоступен",
        errorCode: "dependency-unavailable",
      },
      routes: [],
      services: result().services.map((service) => ({
        ...service,
        status: "skipped",
        durationMs: null,
        httpStatus: null,
        detail: "mihomo недоступен",
        errorCode: "dependency-unavailable",
      })),
      config: { ...result().config, status: "skipped", errorCode: "dependency-unavailable" },
    });
    render(<DiagnosticsSections result={failed} running={false} />);
    expect(screen.getAllByText("Пропущено").length).toBeGreaterThan(3);
    expect(screen.getAllByText("mihomo недоступен").length).toBeGreaterThan(1);
  });

  it("excludes skipped routes and services from attempted pass counts", () => {
    const base = result();
    render(
      <DiagnosticsSections
        running={false}
        result={result({
          routes: [
            base.routes[0] as DiagnosticsResult["routes"][number],
            {
              ...(base.routes[1] as DiagnosticsResult["routes"][number]),
              status: "skipped",
              durationMs: null,
              detail: "Пропущено",
              errorCode: "no-active-node",
            },
          ],
          services: base.services.map((service, index) =>
            index === 5
              ? {
                  ...service,
                  status: "skipped",
                  durationMs: null,
                  httpStatus: null,
                  detail: "Пропущено",
                  errorCode: "dependency-unavailable",
                }
              : service,
          ),
        })}
      />,
    );
    expect(within(screen.getByLabelText("Проверка маршрутов")).getByText("1 / 1")).toBeVisible();
    expect(within(screen.getByLabelText("Доступность сервисов")).getByText("5 / 5")).toBeVisible();
  });

  it("shows scoped route failure reasons and semantic route structure", () => {
    const base = result();
    render(
      <DiagnosticsSections
        running={false}
        result={result({
          routes: [
            {
              ...(base.routes[0] as DiagnosticsResult["routes"][number]),
              status: "failed",
              durationMs: null,
              detail: "Тайм-аут проверки через канал",
              errorCode: "timeout",
            },
          ],
        })}
      />,
    );

    expect(screen.getByRole("table", { name: "Маршруты" })).toBeInTheDocument();
    expect(screen.getAllByText("Тайм-аут проверки через канал")).toHaveLength(2);
  });

  it("marks partial pass counts as warnings and exposes failed config status", () => {
    const base = result();
    render(
      <DiagnosticsSections
        running={false}
        result={result({
          services: base.services.map((service, index) =>
            index === 0
              ? {
                  ...service,
                  status: "failed",
                  durationMs: null,
                  httpStatus: null,
                  detail: "Недоступен",
                  errorCode: "timeout",
                }
              : service,
          ),
          config: { ...base.config, status: "failed", errorCode: "unreachable" },
        })}
      />,
    );

    expect(screen.getByText("5 из 6 проверок пройдено").parentElement).toHaveClass("text-slow");
    expect(within(screen.getByLabelText("Конфигурация mihomo")).getByText("Ошибка")).toBeVisible();
  });

  it("renders unknown config honestly and preserves complete long values in titles", () => {
    const longChannel = "very-long-channel-name-that-must-not-be-lost";
    const longNode = "very-long-node-name-that-must-not-be-lost";
    const base = result();
    render(
      <DiagnosticsSections
        running={false}
        result={result({
          routes: [
            {
              ...(base.routes[0] as DiagnosticsResult["routes"][number]),
              channelName: longChannel,
              node: longNode,
            },
          ],
          config: { ...base.config, mode: null, dns: null, ipv6: null, tun: null },
        })}
      />,
    );
    expect(screen.getAllByTitle(longChannel)).toHaveLength(2);
    expect(screen.getAllByTitle(longNode)).toHaveLength(2);
    expect(within(screen.getByLabelText("Конфигурация mihomo")).getAllByText("—")).toHaveLength(4);
  });
});
