import { expect, test } from "@playwright/test";
import {
  DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
  type DomainCandidateList,
  type DomainIntelligenceOverview,
  type DomainIntelligenceSettingsView,
  domainCandidateListInputSchema,
} from "@submerge/shared";
import {
  expectNoDocumentOverflow,
  type FixtureOverrides,
  installTrpcFixture,
  trpcFixtureByInput,
  trpcFixtureError,
} from "./fixtures";

const now = Date.parse("2026-08-04T12:00:00.000Z");

const settings: DomainIntelligenceSettingsView = {
  configurationState: "ready",
  settings: {
    ...DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
    enabled: true,
    defaultRuleScope: "site",
    automationMode: "review",
  },
  automatic: { available: false, reason: "publisher-unavailable" },
};

const overview: DomainIntelligenceOverview = {
  generatedAt: now,
  period: { from: now - 24 * 60 * 60 * 1_000, to: now },
  health: {
    status: "healthy",
    reason: "correlated",
    snapshotDomainConnections: 28,
    correlatedConnections: 24,
    updatedAt: now,
  },
  dailyAggregates: [{ day: "2026-08-04", connectionCount: 1_284, uniqueDomainCount: 184 }],
  candidateCounts: { queued: 0, pending: 0, confirmed: 3, blocked: 1, excluded: 1 },
  bucketCounts: { candidate: 3, exclusion: 2 },
  evidenceIntegrityCounts: { missingDecisions: 0, invalidDecisions: 0 },
  exclusionCounts: [
    { reason: "proxy-unstable", count: 1 },
    { reason: "telemetry-pattern", count: 1 },
  ],
};

const decision = {
  evaluatedAt: now,
  status: "confirmed" as const,
  confidence: "high" as const,
  reasons: [],
  windowStart: now - 24 * 60 * 60 * 1_000,
  evidence: {
    directQualifyingFailures: 3,
    directSpacedFailures: 3,
    directAddressDiversityRequired: false,
    directAddressDiversitySatisfied: true,
    proxyHttpSuccesses: 2,
    proxyTransportFailures: 0,
    proxyUncertainFailures: 0,
  },
};

const candidateBase: DomainCandidateList["items"][number] = {
  fqdn: "www.service.example",
  siteGroup: "service.example",
  bucket: "candidate",
  reviewState: "active",
  status: "confirmed",
  selectedScope: "site",
  proposedRule: "+.service.example",
  eligibleScopes: ["exact", "site"],
  scopeValid: true,
  siteUnavailableReason: null,
  exclusionReason: null,
  policyExclusionReason: null,
  firstSeenAt: now - 24 * 60 * 60 * 1_000,
  lastSeenAt: now,
  lastValidationAt: now,
  nextValidationAt: now + 60_000,
  connectionCount: 47,
  evidenceAvailable: true,
  evidenceIntegrityIssue: null,
  decision,
  latestAttempts: {
    direct: {
      attemptedAt: now,
      category: "connect_timeout",
      transportSuccess: false,
      httpStatus: null,
      connectDurationMs: 8_000,
      tlsDurationMs: null,
      totalDurationMs: 8_000,
      redirectCount: 0,
      finalOrigin: "https://www.service.example",
    },
    proxy: {
      attemptedAt: now,
      category: "http_response",
      transportSuccess: true,
      httpStatus: 200,
      connectDurationMs: 120,
      tlsDurationMs: 80,
      totalDurationMs: 260,
      redirectCount: 0,
      finalOrigin: "https://www.service.example",
    },
  },
};

const candidates: DomainCandidateList = {
  nextCursor: null,
  items: [
    candidateBase,
    {
      ...candidateBase,
      fqdn: "app.pages.example",
      siteGroup: "pages.example",
      selectedScope: "exact",
      proposedRule: "app.pages.example",
      eligibleScopes: ["exact"],
      siteUnavailableReason: "non-widenable-suffix",
      connectionCount: 18,
    },
    {
      ...candidateBase,
      fqdn: "very-long-subdomain-for-an.internal-service-gateway.product.example",
      siteGroup: "internal-service-gateway.product.example",
      proposedRule: "+.internal-service-gateway.product.example",
      connectionCount: 12,
    },
    {
      ...candidateBase,
      fqdn: "an-extraordinarily-long-registrable-domain-name.product.example",
      siteGroup: "an-extraordinarily-long-registrable-domain-name.product.example",
      proposedRule: "+.an-extraordinarily-long-registrable-domain-name.product.example",
      connectionCount: 9,
    },
  ],
};

const exclusions: DomainCandidateList = {
  nextCursor: null,
  items: [
    {
      ...candidateBase,
      fqdn: "rejected.service.example",
      bucket: "exclusion",
      reviewState: "rejected",
      exclusionReason: "user-rejected",
      nextValidationAt: null,
    },
    {
      ...candidateBase,
      fqdn: "edge.shared.example",
      bucket: "exclusion",
      status: "blocked",
      exclusionReason: "proxy-unstable",
    },
    {
      ...candidateBase,
      fqdn: "static.notblocked.example",
      bucket: "exclusion",
      status: "blocked",
      exclusionReason: "already-covered",
    },
    {
      ...candidateBase,
      fqdn: "telemetry.client.example",
      bucket: "exclusion",
      status: "excluded",
      selectedScope: null,
      proposedRule: null,
      eligibleScopes: [],
      scopeValid: false,
      siteUnavailableReason: "policy-excluded",
      exclusionReason: "telemetry-pattern",
      policyExclusionReason: "telemetry-pattern",
      nextValidationAt: null,
      evidenceAvailable: false,
      evidenceIntegrityIssue: null,
      decision: null,
      latestAttempts: { direct: null, proxy: null },
    },
  ],
};

function listFixture(
  candidateItems: DomainCandidateList = candidates,
  exclusionItems: DomainCandidateList = exclusions,
) {
  return trpcFixtureByInput((input) => {
    const { view } = domainCandidateListInputSchema.parse(input);
    if (view !== "candidates" && view !== "exclusions") {
      throw new Error(`Unexpected domainIntelligence.list view: ${String(view)}`);
    }
    return view === "exclusions" ? exclusionItems : candidateItems;
  });
}

async function openDomainIntelligence(
  page: Parameters<typeof installTrpcFixture>[0],
  settingsView: DomainIntelligenceSettingsView = settings,
  report: DomainIntelligenceOverview = overview,
  overrides: FixtureOverrides = {},
) {
  await installTrpcFixture(page, {
    "domainIntelligence.settings": settingsView,
    "domainIntelligence.overview": report,
    "domainIntelligence.list": listFixture(),
    ...overrides,
  });
  await page.goto("/auto-rules");
  await expect(page.getByRole("heading", { name: "Автоправила" })).toBeVisible();
}

test("populated dark desktop matches the approved Auto Rules hierarchy", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1024 });
  await openDomainIntelligence(page);

  await expect(page.getByRole("link", { name: "Автоправила" })).toHaveClass(/active/u);
  await expect(page.getByRole("button", { name: "Подтверждать вручную" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(page.getByText("+.service.example", { exact: true })).toBeVisible();
  await expect(page.getByText("только точный адрес", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Подробнее о app.pages.example" }).click();
  await expect(page.getByText(/Для адреса найден суффикс из списка «Не расширять»/u)).toBeVisible();
  await expect(page.getByRole("button", { name: "Сайт целиком" })).toBeDisabled();

  await page.screenshot({ path: "/tmp/submerge-auto-rules-dark-1440.png", fullPage: true });
  await expectNoDocumentOverflow(page);
});

test("first install requires a visible scope choice", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openDomainIntelligence(page, {
    configurationState: "unconfigured",
    settings: DEFAULT_DOMAIN_INTELLIGENCE_REPORT_SETTINGS,
    automatic: { available: false, reason: "publisher-unavailable" },
  });

  const enable = page.getByRole("button", { name: "Включить наблюдение" });
  await expect(enable).toBeDisabled();
  await page.getByRole("button", { name: "Только точный адрес" }).click();
  await expect(enable).toBeEnabled();
  await expectNoDocumentOverflow(page);
});

test("light desktop uses shared Indigo Console surface tokens", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1440, height: 1024 });
  await openDomainIntelligence(page);

  await expect(page.locator("html")).not.toHaveClass(/dark/u);
  await expect(page.locator(".domain-mode-card")).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
  await page.screenshot({ path: "/tmp/submerge-auto-rules-light-1440.png", fullPage: true });
  await expectNoDocumentOverflow(page);
});

test("empty candidate and exclusion states remain distinct", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1024 });
  const emptyList: DomainCandidateList = { items: [], nextCursor: null };
  await openDomainIntelligence(
    page,
    settings,
    {
      ...overview,
      candidateCounts: { queued: 0, pending: 0, confirmed: 0, blocked: 0, excluded: 0 },
      bucketCounts: { candidate: 0, exclusion: 0 },
      exclusionCounts: [],
    },
    { "domainIntelligence.list": listFixture(emptyList, emptyList) },
  );

  await expect(page.getByText("Нечего подтверждать")).toBeVisible();
  await page.getByRole("button", { name: /Исключения/u }).click();
  await expect(page.getByText("Исключений нет")).toBeVisible();
  await expectNoDocumentOverflow(page);
});

test("degraded observer state is visible and candidates stay collapsed", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1024 });
  await openDomainIntelligence(page, settings, {
    ...overview,
    health: { ...overview.health, status: "degraded", reason: "parser-drift" },
  });

  await expect(page.getByText("Наблюдение неполное")).toBeVisible();
  await expect(page.getByText("ПОКРЫТИЕ")).toHaveCount(0);
  const details = page.getByRole("button", { name: "Подробнее о www.service.example" });
  await details.click();
  await expect(page.getByText("ПОКРЫТИЕ")).toBeVisible();
  await details.click();
  await expect(page.getByText("ПОКРЫТИЕ")).toHaveCount(0);
});

test("list errors are not presented as an empty candidate list", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openDomainIntelligence(page, settings, overview, {
    "domainIntelligence.list": trpcFixtureByInput((input) => {
      if (typeof input !== "object" || input === null || !("view" in input)) {
        throw new Error("domainIntelligence.list fixture requires a view");
      }
      return input.view === "candidates"
        ? trpcFixtureError("candidate list unavailable")
        : exclusions;
    }),
  });

  await expect(page.getByText("Не удалось загрузить список доменов")).toBeVisible();
  await expect(page.getByText("Нечего подтверждать")).toHaveCount(0);
  await expectNoDocumentOverflow(page);
});

test("mobile exclusions expose reason-specific 44px actions", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openDomainIntelligence(page);
  await page.getByRole("button", { name: /Исключения/u }).click();

  for (const action of [
    page.getByRole("button", { name: "Вернуть" }),
    page.getByRole("button", { name: "Проверить снова" }),
    page.getByRole("link", { name: "Показать правило" }),
    page.getByRole("link", { name: "Изменить фильтр" }),
  ]) {
    await expect(action).toBeVisible();
    expect((await action.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
  await expect(page.getByText("только точный адрес")).toHaveCount(0);
  await expectNoDocumentOverflow(page);
});

test("unverified settings activation is reported as fail-closed", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1024 });
  await openDomainIntelligence(page, settings, overview, {
    "domainIntelligence.setSettings": { view: settings, applied: false },
  });

  await page.getByRole("button", { name: "Выключено" }).click();
  await expect(
    page.getByText("Настройки сохранены, но Mihomo не подтвердил активацию"),
  ).toBeVisible();
});

test("review mutation refusals expose their safe reason", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1024 });
  await openDomainIntelligence(page, settings, overview, {
    "domainIntelligence.setScope": { ok: false, reason: "scope-unavailable" },
  });

  await page.getByRole("button", { name: "Подробнее о www.service.example" }).click();
  await page.getByRole("button", { name: "Только точный адрес" }).click();
  await expect(page.getByText("Эта область больше недоступна")).toBeVisible();
});

test("candidate pagination loads the next cursor page", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1024 });
  await openDomainIntelligence(page, settings, overview, {
    "domainIntelligence.list": trpcFixtureByInput((input) => {
      const parsed = domainCandidateListInputSchema.parse(input);
      if (parsed.view === "exclusions") return exclusions;
      if (parsed.view !== "candidates") throw new Error("Unexpected list view");
      const cursor = parsed.cursor;
      return cursor
        ? { items: candidates.items.slice(1), nextCursor: null }
        : { items: candidates.items.slice(0, 1), nextCursor: "www.service.example" };
    }),
  });

  await expect(page.getByText("+.internal-service-gateway.product.example")).toHaveCount(0);
  await page.getByRole("button", { name: "Загрузить ещё" }).click();
  await expect(page.getByText("+.internal-service-gateway.product.example")).toBeVisible();
});

test("settings keeps Never add and Do not widen as separate editors", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1024 });
  await installTrpcFixture(page);
  await page.goto("/settings");
  await expect(page.getByRole("heading", { name: "Настройки", level: 1 })).toBeVisible();

  const autoRules = page.getByRole("heading", { name: "Автоправила", level: 2 });
  await autoRules.scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: /Не добавлять/u }).click();
  await expect(
    page.getByRole("textbox", { name: "Доменные зоны, которые не добавлять" }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Суффиксы, которые не расширять" })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Закрыть редактор «Не добавлять»" }).click();
  await page.getByRole("button", { name: /Не расширять/u }).click();
  await expect(page.getByRole("textbox", { name: "Суффиксы, которые не расширять" })).toBeVisible();
  await page.screenshot({ path: "/tmp/submerge-domain-settings-dark-1440.png", fullPage: true });
  await expectNoDocumentOverflow(page);
});

for (const width of [320, 390, 425, 768, 983, 984, 1024, 1440]) {
  test(`candidate list stays complete and overflow-free at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 1440 ? 1024 : 844 });
    await openDomainIntelligence(page);

    await expect(page.getByText("+.internal-service-gateway.product.example")).toBeVisible();
    if (width < 984) {
      const reject = page.getByRole("button", { name: "Не добавлять www.service.example" });
      const details = page.getByRole("button", { name: "Подробнее о www.service.example" });
      expect((await reject.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      expect((await details.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    }
    if (width < 768) {
      await expect(page.getByRole("link", { name: "Ещё" })).toHaveClass(/active/u);
    }
    if (width === 390) {
      const prefix = page.locator(".domain-observed-prefix").last();
      const suffix = page.locator(".domain-observed-suffix").last();
      await expect(suffix).toHaveText("product.example");
      expect(await prefix.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
        true,
      );
    }
    await expectNoDocumentOverflow(page);
  });
}
