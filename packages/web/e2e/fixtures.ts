import { expect, type Page } from "@playwright/test";
import type { DirectChannel, ProxyChannel } from "@submerge/shared";

const defaultPolicy = {
  kind: "speed",
  testUrl: "https://www.gstatic.com/generate_204",
  intervalSec: 300,
  toleranceMs: 50,
  reevaluateWhileHealthy: true,
};

export const directChannelFixture: DirectChannel = {
  id: "direct",
  name: "Direct",
  target: "direct",
  priority: 0,
  enabled: true,
  isDefault: false,
  directPresets: { privateNetworks: true, localDomains: true },
  matcher: {
    presets: ["telegram"],
    domains: ["internal.example.test"],
    keywords: ["intranet"],
    ruleProviders: [{ url: "https://rules.example.test/direct.yaml", behavior: "classical" }],
    geosite: ["private"],
    geoip: ["PRIVATE"],
    cidrs: ["100.64.0.0/10"],
  },
};

export const defaultChannelFixture: ProxyChannel = {
  id: "default",
  name: "Default",
  target: "proxy",
  priority: 1,
  enabled: true,
  isDefault: true,
  policy: defaultPolicy,
  matcher: {
    presets: [],
    domains: [],
    keywords: [],
    ruleProviders: [],
    geosite: [],
    geoip: [],
    cidrs: [],
  },
  lastReason: null,
  lastReasonAt: null,
};

const responses: Record<string, unknown> = {
  "auth.me": { authed: true, required: false },
  "nodes.list": {
    now: "AUTO",
    autoNow: "Амстердам — основной маршрут",
    all: [
      {
        name: "Амстердам — основной маршрут",
        type: "vless",
        delay: 42,
        network: "tcp",
        security: "reality",
        history: [38, 40, 42, 41, 42],
      },
      {
        name: "Длинное имя резервного узла для проверки обрезания",
        type: "vless",
        delay: 118,
        network: "tcp",
        security: "tls",
        history: [112, 118],
      },
    ],
  },
  "sources.list": [],
  "channels.get": defaultChannelFixture,
  "channels.list": [directChannelFixture, defaultChannelFixture],
  "channels.reorder": { ok: true, applied: true },
  "channels.updateDirect": { channel: directChannelFixture, applied: true },
  "settings.get": { hwid: "fixture-hwid", mihomoSecret: "", proxyEndpoint: "127.0.0.1:7890" },
  "nodes.bandwidth": [],
  "nodes.health": { connected: true },
  "channels.recentDecisions": [],
  "connections.list": { connections: [] },
};

export type FixtureOverrides = Record<string, unknown>;

interface TrpcFixtureError {
  fixtureError: true;
  message: string;
}

export function trpcFixtureError(message: string): TrpcFixtureError {
  return { fixtureError: true, message };
}

function isTrpcFixtureError(value: unknown): value is TrpcFixtureError {
  return (
    typeof value === "object" &&
    value != null &&
    "fixtureError" in value &&
    value.fixtureError === true &&
    "message" in value &&
    typeof value.message === "string"
  );
}

function responseFor(procedure: string, overrides: FixtureOverrides): unknown {
  if (Object.hasOwn(overrides, procedure)) return overrides[procedure];
  if (Object.hasOwn(responses, procedure)) return responses[procedure];
  throw new Error(`Unknown tRPC fixture procedure: ${procedure}`);
}

export async function installTrpcFixture(
  page: Page,
  overrides: FixtureOverrides = {},
): Promise<void> {
  await page.unroute("**/trpc/**");
  await page.route("**/trpc/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/trpc\//, "");
    if (path === "live.stream") {
      await route.abort("blockedbyclient");
      return;
    }

    const body = path.split(",").map((procedure) => {
      const response = responseFor(procedure, overrides);
      if (isTrpcFixtureError(response)) {
        return {
          error: {
            json: {
              message: response.message,
              code: -32603,
              data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500, path: procedure },
            },
          },
        };
      }
      return { result: { data: response } };
    });
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
}

export async function expectNoDocumentOverflow(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  await expect
    .poll(
      () =>
        page.evaluate(() =>
          [
            ["document", document.documentElement],
            ["app-main", document.querySelector<HTMLElement>(".app-main")],
            ["responsive-page", document.querySelector<HTMLElement>(".responsive-page")],
          ]
            .filter((entry): entry is [string, HTMLElement] => entry[1] != null)
            .map(([name, element]) => ({
              name,
              scrollWidth: element.scrollWidth,
              clientWidth: element.clientWidth,
            }))
            .filter(({ scrollWidth, clientWidth }) => scrollWidth > clientWidth + 1),
        ),
      {
        message: "Expected document and application scroll containers not to overflow",
        timeout: 1000,
      },
    )
    .toEqual([]);
}
