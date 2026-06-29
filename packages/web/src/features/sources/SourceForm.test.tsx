import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithClient } from "@/test/utils";
import { KIND_LABEL } from "./detectKind";
import { SourceForm } from "./SourceForm";

vi.mock("@/lib/trpc", () => ({
  useTRPC: () => ({
    sources: {
      add: { mutationOptions: () => ({}) },
      list: { queryKey: () => ["sources", "list"] },
    },
  }),
}));

describe("SourceForm", () => {
  it("shows the type badge when a vless value is entered", async () => {
    renderWithClient(<SourceForm />);

    const textarea = screen.getByLabelText("Ссылка источника");
    fireEvent.change(textarea, { target: { value: "vless://abc" } });

    expect(await screen.findByText(KIND_LABEL.vless)).toBeInTheDocument();
  });

  it("toggles the HWID switch aria-checked", () => {
    renderWithClient(<SourceForm />);

    const sw = screen.getByRole("switch");
    expect(sw).toHaveAttribute("aria-checked", "false");

    fireEvent.click(sw);
    expect(sw).toHaveAttribute("aria-checked", "true");
  });
});
