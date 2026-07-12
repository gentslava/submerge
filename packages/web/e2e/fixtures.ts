import type { Page } from "@playwright/test";

const defaultPolicy = {
  kind: "speed",
  testUrl: "https://www.gstatic.com/generate_204",
  intervalSec: 300,
  toleranceMs: 50,
  reevaluateWhileHealthy: true,
};

const defaultChannel = {
  id: "default",
  name: "Default",
  priority: 0,
  enabled: true,
  isDefault: true,
  policy: defaultPolicy,
  matcher: { presets: [], domains: [], keywords: [], ruleProviders: [], geosite: [], geoip: [] },
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
  "channels.get": defaultChannel,
  "channels.list": [defaultChannel],
  "settings.get": { hwid: "fixture-hwid", mihomoSecret: "", proxyEndpoint: "127.0.0.1:7890" },
  "nodes.bandwidth": [],
  "nodes.health": { connected: true },
  "channels.recentDecisions": [],
  "connections.list": [],
};

export type FixtureOverrides = Record<string, unknown>;

function responseFor(procedure: string, overrides: FixtureOverrides): unknown {
  if (Object.hasOwn(overrides, procedure)) return overrides[procedure];
  return responses[procedure] ?? null;
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

    const body = path.split(",").map((procedure) => ({
      result: { data: responseFor(procedure, overrides) },
    }));
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
}

export async function expectNoDocumentOverflow(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
  );
}
