import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./button";

describe("Button", () => {
  it("forwards its ref to the native button", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Button ref={ref}>Действия</Button>);

    expect(ref.current).toBe(screen.getByRole("button", { name: "Действия" }));
  });

  it("renders its label and primary variant classes", () => {
    render(<Button>Пинг всех</Button>);
    const btn = screen.getByRole("button", { name: "Пинг всех" });
    expect(btn).toBeInTheDocument();
    expect(btn.className).toContain("bg-accent");
  });
  it("applies the secondary variant (bordered)", () => {
    render(<Button variant="secondary">Обновить</Button>);
    expect(screen.getByRole("button", { name: "Обновить" }).className).toContain(
      "border-border-default",
    );
  });
  it("applies the ghost variant (borderless)", () => {
    render(<Button variant="ghost">Призрак</Button>);
    const cls = screen.getByRole("button", { name: "Призрак" }).className;
    expect(cls).toContain("bg-transparent");
    expect(cls).not.toContain("border-border-default");
  });
  it("provides the shared mobile header action size", () => {
    render(
      <Button size="headerIcon" aria-label="Обновить">
        X
      </Button>,
    );
    const cls = screen.getByRole("button", { name: "Обновить" }).className;
    expect(cls).toContain("h-[var(--mobile-header-action-size)]");
    expect(cls).toContain("w-[var(--mobile-header-action-size)]");
  });
  it("fires onClick", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Добавить</Button>);
    fireEvent.click(screen.getByRole("button", { name: "Добавить" }));
    expect(onClick).toHaveBeenCalledOnce();
  });
  it("does not fire onClick when disabled", () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        X
      </Button>,
    );
    const btn = screen.getByRole("button", { name: "X" });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });
});
