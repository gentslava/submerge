import type { ChannelPolicy } from "@submerge/shared";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { PolicyEditor } from "./PolicyEditor";

// Controlled wrapper mirroring the real usage (Settings/Routing own the policy state):
// onChange updates the rendered policy AND forwards to a spy so tests can assert the
// final emitted policy.
function Harness({
  initial,
  onChange,
}: {
  initial: ChannelPolicy;
  onChange: (p: ChannelPolicy) => void;
}) {
  const [policy, setPolicy] = useState<ChannelPolicy>(initial);
  return (
    <PolicyEditor
      policy={policy}
      nodeNames={["NL-1", "DE-1"]}
      onChange={(p) => {
        setPolicy(p);
        onChange(p);
      }}
    />
  );
}

const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

describe("PolicyEditor — settings preserved across policy switches", () => {
  it("keeps the check interval through a round-trip via «Приоритетный узел»", () => {
    const onChange = vi.fn();
    render(
      <Harness
        initial={{
          kind: "speed",
          testUrl: "https://x/gen",
          intervalSec: 10,
          toleranceMs: 50,
          reevaluateWhileHealthy: true,
        }}
        onChange={onChange}
      />,
    );
    // speed(10) → manual (drops interval) → speed: the 10 s must survive, not reset to 60.
    click("Приоритетный узел");
    click("По задержке");
    const last = onChange.mock.calls.at(-1)?.[0] as ChannelPolicy;
    expect(last.kind).toBe("speed");
    expect(last.kind === "speed" && last.intervalSec).toBe(10);
  });

  it("carries the interval from speed into optimal (optimal has no tolerance knob)", () => {
    const onChange = vi.fn();
    render(
      <Harness
        initial={{
          kind: "speed",
          testUrl: "https://x/gen",
          intervalSec: 30,
          toleranceMs: 120,
          reevaluateWhileHealthy: true,
        }}
        onChange={onChange}
      />,
    );
    click("Оптимальный");
    const last = onChange.mock.calls.at(-1)?.[0] as ChannelPolicy;
    expect(last.kind).toBe("optimal");
    if (last.kind === "optimal") {
      expect(last.intervalSec).toBe(30);
      expect("toleranceMs" in last).toBe(false); // optimal's margin is relative, not a field
    }
  });

  it("preserves sticky's own knobs across a detour through another policy", () => {
    const onChange = vi.fn();
    render(
      <Harness
        initial={{
          kind: "sticky",
          testUrl: "https://x/gen",
          intervalSec: 15,
          failureThreshold: 5,
          maxHoldHours: 8,
          initialCriterion: "lowest-loss",
        }}
        onChange={onChange}
      />,
    );
    // sticky → speed → sticky: failureThreshold/maxHoldHours/criterion must come back.
    click("По задержке");
    click("Стабильный IP");
    const last = onChange.mock.calls.at(-1)?.[0] as ChannelPolicy;
    expect(last.kind).toBe("sticky");
    if (last.kind === "sticky") {
      expect(last.intervalSec).toBe(15);
      expect(last.failureThreshold).toBe(5);
      expect(last.maxHoldHours).toBe(8);
      expect(last.initialCriterion).toBe("lowest-loss");
    }
  });
});
