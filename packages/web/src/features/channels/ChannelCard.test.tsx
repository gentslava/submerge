import type { Channel } from "@submerge/shared";
import { act, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelCard } from "./ChannelCard";

const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");

const channel: Channel = {
  id: "channel-ai",
  name: "AI",
  target: "proxy",
  priority: 0,
  enabled: true,
  isDefault: false,
  policy: {
    kind: "manual",
    pinnedNode: "NL-1",
    onFailure: "fallback",
  },
  matcher: {
    presets: ["openai", "claude", "gemini", "perplexity", "grok", "copilot", "midjourney"],
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

const advancedChannel: Channel = {
  ...channel,
  id: "channel-advanced",
  name: "Advanced",
  matcher: {
    presets: [],
    domains: [],
    keywords: ["ads"],
    ruleProviders: [{ url: "https://rules.example.com/list.yaml", behavior: "classical" }],
    geosite: ["category-ai"],
    geoip: ["US"],
    cidrs: ["10.0.0.0/8"],
  },
};

const defaultChannel: Channel = {
  ...channel,
  id: "default",
  name: "Default",
  isDefault: true,
};

function channelProps() {
  return {
    nodeNames: ["NL-1"],
    onToggleEnabled: vi.fn(),
    onUpdateName: vi.fn(),
    onUpdateMatcher: vi.fn(),
    onUpdatePolicy: vi.fn(),
    onRemove: vi.fn(),
  };
}

function renderChannel(channelValue: Channel = channel) {
  return render(<ChannelCard channel={channelValue} {...channelProps()} />);
}

describe("ChannelCard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalFonts) Object.defineProperty(document, "fonts", originalFonts);
    else Reflect.deleteProperty(document, "fonts");
  });

  it("summarizes every supported matcher family", () => {
    const { container } = renderChannel(advancedChannel);

    const summary = within(container.querySelector(".matcher-summary") as HTMLElement);
    expect(summary.getByText("ключ:ads")).toBeInTheDocument();
    expect(summary.getByText("список:rules.example.com")).toBeInTheDocument();
    expect(summary.getByText("geosite:category-ai")).toBeInTheDocument();
    expect(summary.queryByText("geoip:US")).not.toBeInTheDocument();
    expect(summary.getByText("+2")).toBeInTheDocument();
    expect(summary.queryByText("Правила не заданы")).not.toBeInTheDocument();
  });

  it("does not claim an unknown pool state for regular or Default channels", () => {
    const callbacks = channelProps();
    const { rerender } = render(<ChannelCard channel={channel} {...callbacks} />);
    expect(screen.queryByText("Все узлы")).not.toBeInTheDocument();

    rerender(<ChannelCard channel={defaultChannel} {...callbacks} />);
    expect(screen.queryByText("Все узлы")).not.toBeInTheDocument();
  });

  it("remeasures matcher chips after fonts become ready", async () => {
    let fontsReady = false;
    let resolveFonts: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      resolveFonts = () => {
        fontsReady = true;
        resolve();
      };
    });
    Object.defineProperty(document, "fonts", { configurable: true, value: { ready } });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(260);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function offsetWidth(
      this: HTMLElement,
    ) {
      if (this.textContent?.trim().startsWith("+")) return 32;
      return fontsReady ? 100 : 40;
    });
    vi.stubGlobal(
      "getComputedStyle",
      () => ({ columnGap: "8px", paddingLeft: "4px", paddingRight: "4px" }) as CSSStyleDeclaration,
    );

    const { container } = renderChannel();
    const summary = within(container.querySelector(".matcher-summary") as HTMLElement);
    expect(summary.getByText("Gemini")).toBeInTheDocument();

    await act(async () => {
      resolveFonts?.();
      await ready;
    });

    expect(summary.queryByText("Gemini")).not.toBeInTheDocument();
  });

  it("reserves a counter for matcher items that do not fit in the summary", () => {
    const { container } = renderChannel();

    const summary = within(container.querySelector(".matcher-summary") as HTMLElement);
    expect(summary.getByText("+4")).toBeInTheDocument();
    expect(summary.queryByText("Все узлы")).not.toBeInTheDocument();
  });

  it("does not count a chip that only fits inside the summary padding", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(183);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function offsetWidth(
      this: HTMLElement,
    ) {
      return this.textContent?.trim().startsWith("+") ? 32 : 64;
    });
    vi.stubGlobal(
      "getComputedStyle",
      () => ({ columnGap: "8px", paddingLeft: "4px", paddingRight: "4px" }) as CSSStyleDeclaration,
    );

    const { container } = renderChannel();

    const summary = within(container.querySelector(".matcher-summary") as HTMLElement);
    expect(summary.getByText("OpenAI")).toBeInTheDocument();
    expect(summary.queryByText("Claude")).not.toBeInTheDocument();
    expect(summary.getByText("+6")).toBeInTheDocument();
  });

  it("uses a count-only fallback when even the compact summary is too wide", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(111);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function offsetWidth(
      this: HTMLElement,
    ) {
      return this.textContent?.trim().startsWith("+") ? 32 : 64;
    });
    vi.stubGlobal(
      "getComputedStyle",
      () => ({ columnGap: "8px", paddingLeft: "4px", paddingRight: "4px" }) as CSSStyleDeclaration,
    );

    const { container } = renderChannel();

    const summary = within(container.querySelector(".matcher-summary") as HTMLElement);
    expect(summary.queryByText("Все узлы")).not.toBeInTheDocument();
    expect(summary.getByText("+7")).toBeInTheDocument();
  });
});
