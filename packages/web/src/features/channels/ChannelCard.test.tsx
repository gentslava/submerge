import type { Channel } from "@submerge/shared";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelCard } from "./ChannelCard";
import { fitMatcherItems } from "./matcher-summary";

const channel: Channel = {
  id: "channel-ai",
  name: "AI",
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
  },
  lastReason: null,
  lastReasonAt: null,
};

describe("ChannelCard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps a complete counter when selecting chips for the available width", () => {
    expect(
      fitMatcherItems({
        availableWidth: 260,
        itemWidths: [64, 68, 70],
        counterWidths: [0, 32, 32, 32],
        suffixWidth: 64,
        gap: 8,
      }),
    ).toBe(2);
  });

  it("reserves a counter for matcher items that do not fit in the summary", () => {
    render(
      <ChannelCard
        channel={channel}
        nodeNames={["NL-1"]}
        onToggleEnabled={vi.fn()}
        onUpdateName={vi.fn()}
        onUpdateMatcher={vi.fn()}
        onUpdatePolicy={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    // The first counter is rendered in the summary and the second only in the
    // invisible measurement layer. One occurrence would mean the visible summary
    // stopped accounting for the remaining chips.
    expect(screen.getAllByText("+4")).toHaveLength(2);
    expect(screen.getAllByText("Все узлы")[0]?.parentElement).not.toHaveClass("overflow-hidden");
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

    render(
      <ChannelCard
        channel={channel}
        nodeNames={["NL-1"]}
        onToggleEnabled={vi.fn()}
        onUpdateName={vi.fn()}
        onUpdateMatcher={vi.fn()}
        onUpdatePolicy={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    // One copy of each label belongs to the invisible measurement layer. The
    // visible summary must fall back to `+7 · Все узлы`, which fits even though
    // adding the first chip would overflow by 1px.
    expect(screen.getAllByText("OpenAI")).toHaveLength(1);
    expect(screen.getAllByText("Все узлы")).toHaveLength(2);
    expect(screen.getAllByText("+7")).toHaveLength(2);
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

    render(
      <ChannelCard
        channel={channel}
        nodeNames={["NL-1"]}
        onToggleEnabled={vi.fn()}
        onUpdateName={vi.fn()}
        onUpdateMatcher={vi.fn()}
        onUpdatePolicy={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.getAllByText("Все узлы")).toHaveLength(1);
    expect(screen.getAllByText("+7")).toHaveLength(2);
  });
});
