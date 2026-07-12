import type { ChannelPolicy } from "@submerge/shared";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AutoStrategyCard } from "./AutoStrategyCard";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a href="/settings">{children}</a>,
}));

vi.mock("@/features/live/LiveProvider", () => ({
  useLiveState: () => ({ mihomo: true }),
}));

const policy: ChannelPolicy = {
  kind: "speed",
  testUrl: "https://www.gstatic.com/generate_204",
  intervalSec: 300,
  toleranceMs: 50,
  reevaluateWhileHealthy: true,
};

describe("AutoStrategyCard", () => {
  it("keeps its compact parameter grid available instead of hiding it", () => {
    render(
      <AutoStrategyCard
        policy={policy}
        isAuto={true}
        autoNow="NL-1"
        now="AUTO"
        onAuto={vi.fn()}
        onManual={vi.fn()}
      />,
    );

    const params = screen.getByTestId("nodes-auto-params");
    expect(params).toHaveClass("grid");
    expect(params).not.toHaveClass("hidden");
    expect(screen.getByText("ПРОВЕРОЧНЫЙ URL")).toBeInTheDocument();
  });
});
