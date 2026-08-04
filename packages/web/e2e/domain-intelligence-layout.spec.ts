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
      fqdn: "user-rejected-very-long-subdomain-for-an.internal-service-gateway.service.example",
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
  const configure = page.getByRole("link", { name: "Настроить" });
  await expect(configure).toHaveClass(/page-header-action/u);
  await expect.poll(async () => (await configure.boundingBox())?.height).toBe(40);
  await expect(page.getByText("только отчёт", { exact: true })).toBeVisible();
  await expect(page.getByText("report-only", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Подтверждать вручную" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(page.getByText("+.service.example", { exact: true })).toBeVisible();
  await expect(page.getByText("только точный адрес", { exact: true })).toBeVisible();
  await expect(page.locator(".domain-exact-scope-note")).toContainText(
    "Адрес входит в список «Не расширять»",
  );
  await expect(page.getByRole("button", { name: "Подробнее о app.pages.example" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Открыть детали www.service.example" }),
  ).not.toBeVisible();

  await page.getByRole("button", { name: "Подробнее о www.service.example" }).click();
  await expect(page.getByText("DIRECT", { exact: true })).toBeVisible();
  await expect(page.getByText("PROXY", { exact: true })).toBeVisible();
  await expect(page.getByText("ПОКРЫТИЕ", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Проверить сейчас" })).toBeVisible();

  await page.screenshot({ path: "/tmp/submerge-auto-rules-dark-1440.png", fullPage: true });
  await expectNoDocumentOverflow(page);
});

for (const width of [984, 1440, 1915]) {
  test(`desktop candidate actions stay aligned and long identities never overlap at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1024 });
    const pendingCandidate: DomainCandidateList["items"][number] = {
      ...candidateBase,
      fqdn: "api.pending.service.example",
      status: "pending",
      decision: {
        ...decision,
        status: "pending",
        confidence: "low",
        reasons: ["insufficient-direct-failures"],
      },
    };
    const longExactCandidate: DomainCandidateList["items"][number] = {
      ...candidateBase,
      fqdn: "avatars.githubusercontent.com",
      siteGroup: "githubusercontent.com",
      selectedScope: "exact",
      proposedRule: "avatars.githubusercontent.com",
      eligibleScopes: ["exact"],
      siteUnavailableReason: "non-widenable-suffix",
    };
    const pendingExactCandidate: DomainCandidateList["items"][number] = {
      ...pendingCandidate,
      fqdn: "prod-lt-playstoregatewayadapter-pa.googleapis.com",
      siteGroup: "googleapis.com",
      selectedScope: "exact",
      proposedRule: "prod-lt-playstoregatewayadapter-pa.googleapis.com",
      eligibleScopes: ["exact"],
      siteUnavailableReason: "non-widenable-suffix",
    };
    const candidateItems: DomainCandidateList = {
      items: [candidateBase, pendingCandidate, longExactCandidate, pendingExactCandidate],
      nextCursor: null,
    };
    await openDomainIntelligence(page, settings, overview, {
      "domainIntelligence.list": listFixture(candidateItems, exclusions),
    });

    const rows = page.locator(
      ".domain-candidate-list > .domain-candidate-item > .domain-candidate-row",
    );
    const baselineActions = await rows.first().locator(".domain-candidate-actions").boundingBox();
    const baselineActionColumns = await rows
      .first()
      .locator(".domain-candidate-actions")
      .locator(":scope > :not(.sr-only)")
      .evaluateAll((elements) =>
        elements.map((element) => {
          const rect = element.getBoundingClientRect();
          return { x: rect.x, width: rect.width };
        }),
      );
    expect(baselineActions).not.toBeNull();
    for (const row of await rows.all()) {
      const copy = await row.locator(".domain-candidate-copy").boundingBox();
      const actions = await row.locator(".domain-candidate-actions").boundingBox();
      expect(copy).not.toBeNull();
      expect(actions).not.toBeNull();
      expect(Math.abs((actions?.x ?? 0) - (baselineActions?.x ?? 0))).toBeLessThanOrEqual(1);
      expect(Math.abs((actions?.width ?? 0) - (baselineActions?.width ?? 0))).toBeLessThanOrEqual(
        1,
      );
      expect((copy?.x ?? 0) + (copy?.width ?? 0)).toBeLessThanOrEqual(actions?.x ?? 0);
      const actionColumns = await row
        .locator(".domain-candidate-actions")
        .locator(":scope > :not(.sr-only)")
        .evaluateAll((elements) =>
          elements.map((element) => {
            const rect = element.getBoundingClientRect();
            return { x: rect.x, width: rect.width };
          }),
        );
      expect(actionColumns).toHaveLength(baselineActionColumns.length);
      for (const [index, action] of actionColumns.entries()) {
        expect(Math.abs(action.x - (baselineActionColumns[index]?.x ?? 0))).toBeLessThanOrEqual(1);
        expect(
          Math.abs(action.width - (baselineActionColumns[index]?.width ?? 0)),
        ).toBeLessThanOrEqual(1);
      }
      expect(
        await row
          .locator(".domain-candidate-rule")
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
      for (const text of await row.locator(".domain-generated-rule").all()) {
        expect(await text.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
          true,
        );
      }
      expect(
        await row.locator(".domain-candidate-rule").evaluate((element) => {
          const textRects = Array.from(
            element.querySelectorAll<HTMLElement>(
              ".domain-observed-name, .domain-generated-group, .domain-rule-scope",
            ),
            (child) => child.getBoundingClientRect(),
          );
          return textRects.every((rect, index) =>
            textRects.slice(index + 1).every((other) => {
              const overlapWidth =
                Math.min(rect.right, other.right) - Math.max(rect.left, other.left);
              const overlapHeight =
                Math.min(rect.bottom, other.bottom) - Math.max(rect.top, other.top);
              return overlapWidth <= 0 || overlapHeight <= 0;
            }),
          );
        }),
      ).toBe(true);
    }

    if (width === 1915) {
      await page.screenshot({ path: "/tmp/submerge-domain-candidate-actions-1915.png" });
    }

    await page
      .getByRole("button", { name: `Исключения · ${overview.bucketCounts.exclusion}` })
      .click();
    await expect(page.locator("#domain-exclusions .domain-candidate-actions").first()).toHaveCSS(
      "display",
      "flex",
    );
    await expectNoDocumentOverflow(page);
  });
}

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

test("mobile exposes the current auto-rule mode through a compact selector", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openDomainIntelligence(page);

  await expect(page.locator(".domain-mode-segmented")).toBeHidden();
  const modeTrigger = page.getByRole("button", { name: "Режим: Подтверждать вручную" });
  await expect(modeTrigger).toBeVisible();
  await expect(
    page.getByText(
      "Submerge предлагает правила и ждёт. В custom.txt ничего не попадает без вашего подтверждения.",
      { exact: true },
    ),
  ).not.toBeVisible();
  await expect(page.locator(".domain-mode-status")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await modeTrigger.click();

  const dialog = page.getByRole("dialog", { name: "Режим автоправил" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: /^Автоматически/u })).toBeDisabled();
  const close = page.getByRole("button", { name: "Закрыть «Режим автоправил»" });
  await expect(close).toBeVisible();
  await page.screenshot({ path: "/tmp/submerge-domain-mode-drawer-390.png", fullPage: true });
  await close.click();
  await expect(dialog).toHaveCount(0);
  await expect(modeTrigger).toBeFocused();
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
  const exclusionsTrigger = page.getByRole("button", { name: "Исключения · 0" });
  await exclusionsTrigger.click();
  await expect(page.getByRole("button", { name: "К кандидатам" })).toBeFocused();
  await expect(page.getByText("Исключений нет")).toBeVisible();
  await expect(page.getByText("Нечего подтверждать")).toHaveCount(0);
  await page.getByRole("button", { name: "К кандидатам" }).click();
  await expect(page.getByText("Исключений нет")).toHaveCount(0);
  await expect(page.getByText("Нечего подтверждать")).toBeVisible();
  await expect(exclusionsTrigger).toBeFocused();
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
  await expect(page.locator(".domain-exclusions-trigger-header")).not.toBeVisible();
  const exclusionsTrigger = page.locator(".domain-exclusions-trigger-mobile");
  await expect(exclusionsTrigger).toBeVisible();
  expect((await exclusionsTrigger.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await exclusionsTrigger.click();
  await expect(page.getByRole("button", { name: "К кандидатам" })).toBeFocused();

  for (const action of [
    page.getByRole("button", { name: "Вернуть" }),
    page.getByRole("button", { name: "Проверить снова" }),
    page.getByRole("link", { name: "Показать правило" }),
    page.getByRole("link", { name: "Изменить фильтр" }),
  ]) {
    await expect(action).toBeVisible();
    expect((await action.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
  await expect(page.locator("#domain-exclusions").getByText("только точный адрес")).toHaveCount(0);
  await page.getByRole("button", { name: "К кандидатам" }).click();
  await expect(exclusionsTrigger).toBeFocused();
  await expectNoDocumentOverflow(page);
});

test("compact exact-only candidate explains why widening is unavailable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openDomainIntelligence(page);

  const exactCard = page.locator(".domain-candidate-item").filter({ hasText: "app.pages.example" });
  await expect(exactCard.locator(".domain-candidate-summary-compact")).toContainText(
    "Адрес входит в список «Не расширять»",
  );
  await expect(exactCard.locator(".domain-exact-scope-note")).not.toBeVisible();
  await expectNoDocumentOverflow(page);
});

for (const width of [320, 390]) {
  test(`long exclusion stays bounded with a compact reason chip at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await openDomainIntelligence(page);
    await page.locator(".domain-exclusions-trigger-mobile").click();

    const row = page.locator("#domain-exclusions .domain-exclusion-row").first();
    const domain = row.locator(".domain-observed-name");
    const chip = row.locator(".domain-exclusion-reason");
    await expect(row).toBeVisible();
    expect(await domain.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    const rowBox = await row.boundingBox();
    const chipBox = await chip.boundingBox();
    expect(rowBox).not.toBeNull();
    expect(chipBox).not.toBeNull();
    expect(chipBox?.width ?? Number.POSITIVE_INFINITY).toBeLessThan((rowBox?.width ?? 0) * 0.75);
    await expectNoDocumentOverflow(page);
  });
}

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
  await page
    .getByRole("group", { name: "Область правила" })
    .getByRole("button", { name: "www.service.example", exact: true })
    .click();
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
  const dialog = page.getByRole("dialog", { name: "Не добавлять" });
  await expect(dialog).toBeVisible();
  await expect.poll(async () => Math.round((await dialog.boundingBox())?.width ?? 0)).toBe(520);
  const dialogBox = await dialog.boundingBox();
  expect(Math.round((dialogBox?.x ?? 0) + (dialogBox?.width ?? 0) / 2)).toBe(720);
  await expect(
    page.getByRole("textbox", { name: "Доменные зоны, которые не добавлять" }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Суффиксы, которые не расширять" })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Закрыть редактор «Не добавлять»" }).click();
  await page.getByRole("button", { name: /Не расширять/u }).click();
  const widenDialog = page.getByRole("dialog", { name: "Не расширять" });
  await expect(page.getByRole("textbox", { name: "Суффиксы, которые не расширять" })).toBeVisible();
  await expect.poll(() => widenDialog.getAttribute("data-starting-style")).toBeNull();
  await expect.poll(() => widenDialog.getAttribute("data-ending-style")).toBeNull();
  await expect(widenDialog).toHaveCSS("opacity", "1");
  await page.screenshot({ path: "/tmp/submerge-domain-settings-dark-1440.png", fullPage: true });
  await expectNoDocumentOverflow(page);
});

test("mobile uses a centered settings icon and bottom-sheet filter editor", async ({ page }) => {
  await page.setViewportSize({ width: 425, height: 844 });
  await openDomainIntelligence(page);

  const configure = page.getByRole("link", { name: "Настроить" });
  const configureBox = await configure.boundingBox();
  const iconBox = await configure.locator("svg").boundingBox();
  expect(
    Math.abs(
      (configureBox?.x ?? 0) +
        (configureBox?.width ?? 0) / 2 -
        ((iconBox?.x ?? 0) + (iconBox?.width ?? 0) / 2),
    ),
  ).toBeLessThanOrEqual(0.5);

  await page.goto("/settings");
  const trigger = page.getByRole("button", { name: /Не добавлять/u });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Не добавлять" });
  await dialog.waitFor({ state: "attached" });
  const entrySamples: number[] = [];
  for (let index = 0; index < 6; index += 1) {
    entrySamples.push((await dialog.boundingBox())?.y ?? 0);
    await page.waitForTimeout(50);
  }
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("data-swipe-direction", "down");
  const dialogBox = await dialog.boundingBox();
  expect(entrySamples[0] ?? 0).toBeGreaterThan((dialogBox?.y ?? 0) + 24);
  expect(entrySamples.at(-1) ?? 0).toBeLessThan(entrySamples[0] ?? 0);
  expect(dialogBox?.x).toBe(0);
  expect(dialogBox?.width).toBe(425);
  expect((dialogBox?.y ?? 0) + (dialogBox?.height ?? 0)).toBe(844);

  const handleBox = await page.locator(".responsive-dialog-handle").boundingBox();
  if (!dialogBox || !handleBox) throw new Error("Drawer geometry is unavailable");
  const handleX = handleBox.x + handleBox.width / 2;
  const handleY = handleBox.y + handleBox.height / 2;
  await page.mouse.move(handleX, handleY);
  await page.mouse.down();
  await page.mouse.move(handleX, handleY + 72, { steps: 8 });
  await expect
    .poll(async () => (await dialog.boundingBox())?.y ?? 0)
    .toBeGreaterThan(dialogBox.y + 24);
  await page.mouse.move(handleX, handleY, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(async () => Math.abs(((await dialog.boundingBox())?.y ?? 0) - dialogBox.y))
    .toBeLessThanOrEqual(1);
  await page.screenshot({ path: "/tmp/submerge-domain-settings-drawer-425.png", fullPage: true });

  const compactClose = page.getByRole("button", { name: "Закрыть редактор «Не добавлять»" });
  await expect(compactClose).toBeVisible();
  const compactCloseBox = await compactClose.boundingBox();
  expect(compactCloseBox?.width).toBeGreaterThanOrEqual(44);
  expect(compactCloseBox?.height).toBeGreaterThanOrEqual(44);
  const compactCloseVisualBox = await compactClose
    .locator(".responsive-dialog-mobile-close-visual")
    .boundingBox();
  expect(compactCloseVisualBox?.width).toBeLessThanOrEqual(32);
  expect(compactCloseVisualBox?.height).toBeLessThanOrEqual(32);
  if (!compactCloseVisualBox) throw new Error("Drawer close geometry is unavailable");
  const closeTopInset = compactCloseVisualBox.y - dialogBox.y;
  const closeRightInset =
    dialogBox.x + dialogBox.width - compactCloseVisualBox.x - compactCloseVisualBox.width;
  expect(Math.abs(closeTopInset - closeRightInset)).toBeLessThanOrEqual(1);
  await compactClose.focus();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await expect(dialog).toBeVisible();
  await page.locator(".responsive-dialog-backdrop--drawer").click({ position: { x: 8, y: 8 } });
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

for (const width of [320, 390, 767, 768]) {
  test(`filter editor uses the responsive dialog placement at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await openDomainIntelligence(page);
    await page.goto("/settings");
    const trigger = page.getByRole("button", { name: /Не расширять/u });
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "Не расширять" });
    await expect(dialog).toBeVisible();
    await expect.poll(() => dialog.getAttribute("data-starting-style")).toBeNull();
    const box = await dialog.boundingBox();
    if (!box) throw new Error("Responsive editor geometry is unavailable");

    if (width < 768) {
      expect(box.x).toBe(0);
      expect(box.width).toBe(width);
      await expect(page.locator(".responsive-dialog-handle")).toBeVisible();
    } else {
      await expect.poll(async () => Math.round((await dialog.boundingBox())?.width ?? 0)).toBe(520);
      const settledBox = await dialog.boundingBox();
      expect(Math.round((settledBox?.x ?? 0) + (settledBox?.width ?? 0) / 2)).toBe(width / 2);
      await expect(page.locator(".responsive-dialog-handle")).toHaveCount(0);
    }
    await page.screenshot({ path: `/tmp/submerge-domain-settings-${width}.png`, fullPage: true });
    await expectNoDocumentOverflow(page);
  });
}

for (const width of [320, 390, 425, 768, 983, 984, 1024, 1440]) {
  test(`candidate list stays complete and overflow-free at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 1440 ? 1024 : 844 });
    await openDomainIntelligence(page);

    await expect(page.getByText("+.internal-service-gateway.product.example")).toBeVisible();
    if (width < 984) {
      const reject = page.getByRole("button", { name: "Не добавлять www.service.example" });
      const cardDetails = page.getByRole("button", { name: "Открыть детали www.service.example" });
      const inlineDetails = page.getByRole("button", { name: "Подробнее о www.service.example" });
      const details = (await cardDetails.isVisible()) ? cardDetails : inlineDetails;
      expect((await reject.boundingBox())?.height).toBeGreaterThanOrEqual(44);
      expect((await details.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    }
    if (width < 768) {
      await expect(page.getByRole("link", { name: "Ещё" })).toHaveClass(/active/u);
    }
    if (width === 390) {
      await expect(
        page.locator(".domain-candidate-panel--cards .domain-candidate-item"),
      ).toHaveCount(candidates.items.length);
      await expect(page.locator(".domain-candidate-expand").first()).not.toBeVisible();
      await expect(page.locator(".domain-exact-scope-note")).not.toBeVisible();
      const prefix = page.locator(".domain-observed-prefix").last();
      const suffix = page.locator(".domain-observed-suffix").last();
      await expect(suffix).toHaveText("product.example");
      expect(await prefix.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
        true,
      );
    }
    if (width === 390 || width === 1440) {
      const longCardDetails = page.getByRole("button", {
        name: "Открыть детали very-long-subdomain-for-an.internal-service-gateway.product.example",
      });
      const longInlineDetails = page.getByRole("button", {
        name: "Подробнее о very-long-subdomain-for-an.internal-service-gateway.product.example",
      });
      await ((await longCardDetails.isVisible()) ? longCardDetails : longInlineDetails).click();
      await expect(
        page.getByRole("button", { name: "+.internal-service-gateway.product.example" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", {
          name: "very-long-subdomain-for-an.internal-service-gateway.product.example",
          exact: true,
        }),
      ).toBeVisible();
    }
    await expectNoDocumentOverflow(page);
  });
}
