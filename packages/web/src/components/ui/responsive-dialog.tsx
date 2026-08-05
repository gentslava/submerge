import { Dialog } from "@base-ui/react/dialog";
import { Drawer } from "@base-ui/react/drawer";
import { X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { buttonVariants } from "./button";

interface ResponsiveDialogProps {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  closeLabel?: string;
  size?: "standard" | "compact";
  onClose(): void;
}

const DESKTOP_QUERY = "(min-width: 48rem)";

// Base UI provides the interaction primitives: a conventional dialog on
// desktop and a velocity-aware, swipe-to-dismiss drawer on compact screens.
// This wrapper only applies the product's shared structure and design tokens.
export function ResponsiveDialog({
  title,
  description,
  children,
  footer,
  closeLabel = `Закрыть «${title}»`,
  size = "standard",
  onClose,
}: ResponsiveDialogProps) {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const [open, setOpen] = useState(false);
  const hasOpenedRef = useRef(false);
  const closeReportedRef = useRef(false);
  const returnFocusRef = useRef<HTMLElement | null>(
    typeof document === "undefined" || !(document.activeElement instanceof HTMLElement)
      ? null
      : document.activeElement,
  );

  useEffect(() => {
    // Mount the Base UI root closed, then open on the next frame. Mounting it
    // already open skips the starting-style phase and makes the sheet pop in.
    const frame = requestAnimationFrame(() => {
      hasOpenedRef.current = true;
      setOpen(true);
    });
    return () => cancelAnimationFrame(frame);
  }, []);

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
  }

  function handleOpenChangeComplete(nextOpen: boolean) {
    if (nextOpen || !hasOpenedRef.current || closeReportedRef.current) return;
    closeReportedRef.current = true;
    onClose();
  }

  if (desktop) {
    return (
      <Dialog.Root
        open={open}
        onOpenChange={handleOpenChange}
        onOpenChangeComplete={handleOpenChangeComplete}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className="responsive-dialog-backdrop" />
          <Dialog.Viewport className="responsive-dialog-viewport responsive-dialog-viewport--modal">
            <Dialog.Popup
              className={`responsive-dialog responsive-dialog--modal responsive-dialog--${size}`}
              finalFocus={returnFocusRef}
            >
              <header className="responsive-dialog-header">
                <div className="flex min-w-0 flex-col gap-1">
                  <Dialog.Title className="text-section text-text-primary">{title}</Dialog.Title>
                  {description ? (
                    <Dialog.Description className="text-sub text-text-tertiary">
                      {description}
                    </Dialog.Description>
                  ) : null}
                </div>
                <Dialog.Close
                  className={buttonVariants({ variant: "ghost", size: "icon" })}
                  aria-label={closeLabel}
                >
                  <X aria-hidden="true" size={18} />
                </Dialog.Close>
              </header>
              <div className="responsive-dialog-body">{children}</div>
              {footer ? <footer className="responsive-dialog-footer">{footer}</footer> : null}
            </Dialog.Popup>
          </Dialog.Viewport>
        </Dialog.Portal>
      </Dialog.Root>
    );
  }

  return (
    <Drawer.Root
      open={open}
      onOpenChange={handleOpenChange}
      onOpenChangeComplete={handleOpenChangeComplete}
      swipeDirection="down"
    >
      <Drawer.Portal>
        <Drawer.Backdrop className="responsive-dialog-backdrop responsive-dialog-backdrop--drawer" />
        <Drawer.Viewport className="responsive-dialog-viewport responsive-dialog-viewport--drawer">
          <Drawer.Popup
            className="responsive-dialog responsive-dialog--drawer"
            finalFocus={returnFocusRef}
          >
            <div className="responsive-dialog-handle" aria-hidden="true" />
            <Drawer.Close
              className={`${buttonVariants({ variant: "ghost", size: "headerIcon" })} responsive-dialog-mobile-close`}
              aria-label={closeLabel}
            >
              <span className="responsive-dialog-mobile-close-visual">
                <X aria-hidden="true" size={17} />
              </span>
            </Drawer.Close>
            <Drawer.Content className="responsive-dialog-content">
              <header className="responsive-dialog-header">
                <div className="flex min-w-0 flex-col gap-1">
                  <Drawer.Title className="text-section text-text-primary">{title}</Drawer.Title>
                  {description ? (
                    <Drawer.Description className="text-sub text-text-tertiary">
                      {description}
                    </Drawer.Description>
                  ) : null}
                </div>
              </header>
              <div className="responsive-dialog-body">{children}</div>
              {footer ? <footer className="responsive-dialog-footer">{footer}</footer> : null}
            </Drawer.Content>
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia?.(query).matches ?? true);

  useEffect(() => {
    const media = window.matchMedia?.(query);
    if (!media) return;
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);

  return matches;
}
