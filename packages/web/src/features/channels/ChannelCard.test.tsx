import type { DirectChannel, ProxyChannel } from "@submerge/shared";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelCard } from "./ChannelCard";

const originalFonts = Object.getOwnPropertyDescriptor(document, "fonts");

const channel: ProxyChannel = {
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

const advancedChannel: ProxyChannel = {
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

const defaultChannel: ProxyChannel = {
  ...channel,
  id: "default",
  name: "Default",
  isDefault: true,
};

const directChannel: DirectChannel = {
  id: "direct",
  name: "Direct",
  target: "direct",
  priority: 0,
  enabled: true,
  isDefault: false,
  directPresets: { privateNetworks: true, localDomains: true },
  matcher: {
    presets: [],
    domains: [],
    keywords: [],
    ruleProviders: [],
    geosite: [],
    geoip: [],
    cidrs: ["192.168.50.0/24"],
  },
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

function renderChannel(channelValue: ProxyChannel = channel) {
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
      () =>
        ({
          columnGap: "8px",
          paddingLeft: "4px",
          paddingRight: "4px",
          getPropertyValue: () => "",
        }) as unknown as CSSStyleDeclaration,
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
      () =>
        ({
          columnGap: "8px",
          paddingLeft: "4px",
          paddingRight: "4px",
          getPropertyValue: () => "",
        }) as unknown as CSSStyleDeclaration,
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
      () =>
        ({
          columnGap: "8px",
          paddingLeft: "4px",
          paddingRight: "4px",
          getPropertyValue: () => "",
        }) as unknown as CSSStyleDeclaration,
    );

    const { container } = renderChannel();

    const summary = within(container.querySelector(".matcher-summary") as HTMLElement);
    expect(summary.queryByText("Все узлы")).not.toBeInTheDocument();
    expect(summary.getByText("+7")).toBeInTheDocument();
  });

  it("renders a target-specific Direct card without proxy-only actions", () => {
    const onUpdateDirect = vi.fn();
    render(
      <ChannelCard
        channel={directChannel}
        onUpdateDirect={onUpdateDirect}
        reorderControl={<button type="button">reorder-direct</button>}
      />,
    );

    expect(screen.getByText("Direct")).toBeInTheDocument();
    expect(screen.getByText("Системный")).toBeInTheDocument();
    expect(screen.getByText("DIRECT")).toBeInTheDocument();
    const summary = within(document.querySelector(".matcher-summary") as HTMLElement);
    expect(summary.getByText("Локальная сеть")).toBeInTheDocument();
    expect(summary.getByText("Локальные домены")).toBeInTheDocument();
    expect(summary.getByText("192.168.50.0/24")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "reorder-direct" })).toBeInTheDocument();
    expect(screen.queryByText(/по задержке/i)).not.toBeInTheDocument();
  });

  it("keeps the compact Direct identity above its matcher summary on the surface color", () => {
    const { container } = render(
      <ChannelCard
        channel={directChannel}
        onUpdateDirect={vi.fn()}
        initiallyExpanded
        reorderControl={<button type="button">reorder-direct</button>}
      />,
    );

    const header = container.querySelector(".direct-channel-header");
    expect(header).toHaveClass("bg-surface");
    expect(header).not.toHaveClass("bg-elevated");
    expect(header?.children[0]).toHaveClass("direct-channel-identity-controls");
    expect(header?.children[1]).toHaveClass("matcher-summary");
  });

  it("keeps the Direct matcher summary transparent to the full-header toggle", () => {
    const { container } = render(<ChannelCard channel={directChannel} onUpdateDirect={vi.fn()} />);

    expect(container.querySelector(".direct-channel-header .matcher-summary")).toHaveClass(
      "pointer-events-none",
    );
  });

  it("updates Direct enabled state and opens the Direct-only editor", () => {
    const onUpdateDirect = vi.fn();
    render(<ChannelCard channel={directChannel} onUpdateDirect={onUpdateDirect} />);

    fireEvent.click(screen.getByRole("switch", { name: "Включить канал «Direct»" }));
    expect(onUpdateDirect).toHaveBeenCalledWith({ enabled: false });

    fireEvent.click(
      screen.getAllByRole("button", { name: "Развернуть канал «Direct»" })[0] as HTMLElement,
    );
    expect(screen.getByText("Системные исключения")).toBeInTheDocument();
    expect(screen.queryByLabelText("Имя канала")).not.toBeInTheDocument();
    expect(screen.queryByText("Пул")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /удалить канал/i })).not.toBeInTheDocument();
  });

  it("dims a disabled Direct card while keeping its saved summary visible", () => {
    const { container } = render(
      <ChannelCard channel={{ ...directChannel, enabled: false }} onUpdateDirect={vi.fn()} />,
    );
    expect(container.firstElementChild).toHaveClass("opacity-50");
    const summary = within(container.querySelector(".matcher-summary") as HTMLElement);
    expect(summary.getByText("192.168.50.0/24")).toBeInTheDocument();
  });

  it("blocks a second Direct edit while the first mutation is pending", () => {
    const onUpdateDirect = vi.fn();
    const { rerender } = render(
      <ChannelCard channel={directChannel} onUpdateDirect={onUpdateDirect} initiallyExpanded />,
    );

    fireEvent.click(screen.getByRole("switch", { name: "Частные сети" }));
    expect(onUpdateDirect).toHaveBeenCalledTimes(1);

    rerender(
      <ChannelCard
        channel={directChannel}
        onUpdateDirect={onUpdateDirect}
        initiallyExpanded
        busy
      />,
    );
    const localDomains = screen.getByRole("switch", { name: "Локальные домены" });
    expect(localDomains).toBeDisabled();
    fireEvent.click(localDomains);
    expect(onUpdateDirect).toHaveBeenCalledTimes(1);
  });
});
