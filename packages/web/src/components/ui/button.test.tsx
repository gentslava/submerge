import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./button";

describe("Button", () => {
  it("renders its label and primary variant classes", () => {
    render(<Button>Пинг всех</Button>);
    const btn = screen.getByRole("button", { name: "Пинг всех" });
    expect(btn).toBeInTheDocument();
    expect(btn.className).toContain("bg-accent");
  });
  it("applies the ghost variant", () => {
    render(<Button variant="ghost">Обновить</Button>);
    expect(screen.getByRole("button", { name: "Обновить" }).className).toContain(
      "border-border-default",
    );
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
