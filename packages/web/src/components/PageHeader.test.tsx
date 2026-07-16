import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PageHeader } from "./PageHeader";

describe("PageHeader", () => {
  it("keeps page title, subtitle, and actions on the shared design-system structure", () => {
    render(
      <PageHeader
        title="Трафик"
        subtitle="Все каналы · последние 60 секунд"
        actions={<button type="button">Сбросить</button>}
      />,
    );

    expect(screen.getByRole("heading", { level: 1, name: "Трафик" })).toHaveClass(
      "page-header-title",
    );
    expect(screen.getByText("Все каналы · последние 60 секунд")).toHaveClass(
      "page-header-subtitle",
    );
    expect(screen.getByRole("button", { name: "Сбросить" }).parentElement).toHaveClass(
      "page-header-actions",
    );
  });
});
