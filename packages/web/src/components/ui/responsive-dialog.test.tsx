import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, StrictMode, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResponsiveDialog } from "./responsive-dialog";

function Harness({ children = <input aria-label="Значение" /> }: { children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Открыть
      </button>
      {open ? (
        <ResponsiveDialog title="Фильтр" onClose={() => setOpen(false)}>
          {children}
        </ResponsiveDialog>
      ) : null}
    </>
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("ResponsiveDialog", () => {
  it("opens as a shared modal surface and closes from its action", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Открыть" }));

    const dialog = await screen.findByRole("dialog", { name: "Фильтр" });
    expect(dialog).toHaveAttribute("data-open");
    expect(dialog).toHaveClass("responsive-dialog");
    await userEvent.click(screen.getByRole("button", { name: "Закрыть «Фильтр»" }));
    expect(screen.queryByRole("dialog", { name: "Фильтр" })).toBeNull();
  });

  it("closes on outside press and Escape", async () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <ResponsiveDialog title="Фильтр" onClose={onClose}>
        Значение
      </ResponsiveDialog>,
    );
    await screen.findByRole("dialog", { name: "Фильтр" });
    const backdrop = document.querySelector<HTMLElement>(".responsive-dialog-backdrop");
    expect(backdrop).not.toBeNull();
    fireEvent.pointerDown(backdrop as HTMLElement);
    fireEvent.click(backdrop as HTMLElement);
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());

    onClose.mockClear();
    unmount();
    render(
      <ResponsiveDialog title="Фильтр" onClose={onClose}>
        Значение
      </ResponsiveDialog>,
    );
    await screen.findByRole("dialog", { name: "Фильтр" });
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  });

  it("returns focus to the trigger after close", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Открыть" });
    trigger.focus();
    await userEvent.click(trigger);
    await userEvent.click(await screen.findByRole("button", { name: "Закрыть «Фильтр»" }));

    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("stays open through the development StrictMode effect replay", async () => {
    render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Открыть" }));

    expect(await screen.findByRole("dialog", { name: "Фильтр" })).toHaveAttribute("data-open");
  });

  it("uses the gesture-enabled bottom drawer on compact screens", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    render(<Harness />);
    await userEvent.click(screen.getByRole("button", { name: "Открыть" }));

    expect(await screen.findByRole("dialog", { name: "Фильтр" })).toHaveAttribute(
      "data-swipe-direction",
      "down",
    );
    expect(screen.getByRole("button", { name: "Закрыть «Фильтр»" })).toBeInTheDocument();
  });
});
