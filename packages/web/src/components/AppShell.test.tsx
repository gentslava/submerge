import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppShell } from "./AppShell";

vi.mock("@tanstack/react-router", () => ({
  Outlet: () => <p>Содержимое страницы</p>,
}));

vi.mock("./Sidebar", () => ({
  Sidebar: () => <aside>Навигация</aside>,
}));

vi.mock("./BottomNav", () => ({
  BottomNav: () => <nav>Мобильная навигация</nav>,
}));

describe("AppShell", () => {
  it("connects the first-page skip link to a programmatically focusable main", () => {
    render(<AppShell />);

    const skipLink = screen.getByRole("link", { name: "Перейти к содержимому" });
    const main = screen.getByRole("main");

    expect(skipLink).toHaveAttribute("href", "#main-content");
    expect(main).toHaveAttribute("id", "main-content");
    expect(main).toHaveAttribute("tabindex", "-1");
  });
});
