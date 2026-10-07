import type { ChannelPolicy } from "@submerge/shared";
import { fireEvent, render, screen, within } from "@testing-library/react";
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

describe("PolicyEditor — eligible priority nodes", () => {
  it("does not switch to manual while there are no eligible candidates", () => {
    const onChange = vi.fn();
    render(
      <PolicyEditor
        policy={{ kind: "optimal", testUrl: "https://x/gen", intervalSec: 30 }}
        nodeNames={[]}
        nodeNamesUnavailable="Загрузка пула узлов…"
        onChange={onChange}
      />,
    );
    click("Приоритетный узел");
    expect(onChange).not.toHaveBeenCalled();
  });
  it("shows a placeholder when the saved pin leaves the pool without selecting a replacement", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <PolicyEditor
        policy={{ kind: "manual", pinnedNode: "NL-1", onFailure: "hold" }}
        nodeNames={["NL-1", "DE-1"]}
        onChange={onChange}
      />,
    );
    rerender(
      <PolicyEditor
        policy={{ kind: "manual", pinnedNode: "NL-1", onFailure: "hold" }}
        nodeNames={["DE-1"]}
        onChange={onChange}
      />,
    );
    const select = screen.getByRole("combobox", { name: "Приоритетный узел" });
    expect(select).toHaveValue("");
    expect(within(select).queryByRole("option", { name: "NL-1" })).not.toBeInTheDocument();
    expect(within(select).getByRole("option", { name: "Выберите узел из пула" })).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(select, { target: { value: "DE-1" } });
    expect(onChange).toHaveBeenCalledWith({
      kind: "manual",
      pinnedNode: "DE-1",
      onFailure: "hold",
    });
  });

  it("disables selection when no pool nodes are available", () => {
    render(
      <PolicyEditor
        policy={{ kind: "manual", pinnedNode: "gone", onFailure: "hold" }}
        nodeNames={[]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("combobox", { name: "Приоритетный узел" })).toBeDisabled();
    expect(screen.getByRole("option", { name: "Нет доступных узлов в пуле" })).toBeVisible();
  });

  it("seeds manual policy from an eligible node when the current exit is outside the pool", () => {
    const onChange = vi.fn();
    render(
      <PolicyEditor
        policy={{ kind: "optimal", testUrl: "https://x/gen", intervalSec: 30 }}
        nodeNames={["DE-1"]}
        activeNode="NL-1"
        onChange={onChange}
      />,
    );
    click("Приоритетный узел");
    expect(onChange).toHaveBeenCalledWith({
      kind: "manual",
      pinnedNode: "DE-1",
      onFailure: "fallback",
    });
  });
});

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
