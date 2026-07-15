# Adaptive layout system

**Status:** approved · **Date:** 2026-07-12 · **Scope:** `packages/web`

## Problem

The application currently uses viewport breakpoints (`md`, `lg`) to change page
layouts. This is incorrect whenever the content pane is narrower than the viewport:
the desktop sidebar consumes 248px and docked DevTools can reduce it further. At a
768px viewport, the usable pane can be about 456px, while `md:` already activates
desktop toolbars, tables, and non-wrapping controls. The resulting clipping is a
systemic defect, not a collection of screen-specific defects.

## Decision

Viewport media queries remain responsible only for application chrome: the desktop
sidebar and phone bottom navigation. Each page root becomes a named inline-size
container. Its descendants use semantic container-query classes instead of deciding
their layout mode from the browser viewport.

The shared width contract is:

| Name | Threshold | Intended content |
| --- | ---: | --- |
| compact | `< 42rem` | stacked forms, card/list rows, contextual actions, concise summaries |
| inline | `>= 42rem` | inline headers, compact action groups, horizontal field rows |
| data | `>= 48rem` | dense tables and fixed-column node/source/connection rows |
| detail | `>= 60rem` | long, divider-separated read-only parameter strips |

The `42rem` threshold is deliberately lower than the table threshold: controls can
be read inline before a dense data table has enough width to be legible. The 60rem
detail threshold is reserved for dense summaries with many fixed values; below it
they use balanced one-column parameter rows and never clip. There is no
per-component global `md`/`lg` decision for a layout mode.

## Implementation structure

- `packages/web/src/styles/responsive.css` owns the reusable container contract and
  all semantic responsive selectors. `index.css` imports it; it no longer accrues
  unrelated per-screen patches.
- Each route root uses `responsive-page` plus an explicit page modifier. The nearest
  root supplies the `app-page` container for every descendant.
- Components expose descriptive layout hooks (`cq-inline-*`, `cq-data-*`) only where
  they must switch modes. Their content and behavior remain in the component.
- Controls must wrap, stack, or move actions into their existing contextual menu;
  they must never rely on `overflow: hidden` to conceal content.
- The Nodes compact header keeps refresh and the existing actions menu. The wide
header keeps labelled refresh and ping actions. Auto strategy uses compact
one-column parameter rows below the detail threshold and its divider strip above it.
- Connections uses a compact preferred desktop search width and natural wrapping for
  a constrained pane. Phones intentionally stack search and destructive action at
  full width; this is a phone interaction rule, not the desktop layout rule.

## Screen behaviour

| Screen | Compact | Inline/data |
| --- | --- | --- |
| Nodes | compact header, per-node actions menu, auto strategy grid, 54px chart | labelled header, auto strategy strip, 92px chart, dense node rows at data |
| Connections | full-width search + close action on phones; cards otherwise | compact search/action group; table at data |
| Routing | icon-only add action, card summary and vertical editor | labelled add action, inline card/editor controls where they fit |
| Sources | source cards and stacked form controls | source rows only at data; inline form actions at inline |
| Settings | single-column cards and fields | inline rows only at inline |
| More | vertical list remains stable | no independent dense mode required |

## Source-of-truth and product boundaries

`pencil/web-ui.pen` remains the visual source of truth. The implementation follows
the existing mobile Routing frame (icon-only add) and Nodes chart measurement (54px).
It must not implement the unsupported TUN/TPROXY or LAN controls present in stale
Pencil frames. Those frames will be updated to supported product behaviour. A
Connections mobile frame is added before visual sign-off; until then the existing
card hierarchy is covered by behavioural and geometry tests but is not presented as
pixel-perfect source parity.

## Acceptance criteria

At 320, 390, 425, 768, 1024, and 1440px, and with a desktop viewport whose page
container is 320, 480, 640, 767, and 768px wide:

- The document has no horizontal overflow.
- Labels and action controls do not overlap or conceal each other.
- A control that changes from an inline action to an overflow action remains
  reachable and keyboard-accessible.
- The fixed bottom navigation does not cover the final interactive element.
- Dense tables appear only at the `data` container threshold; otherwise the same
  data has a readable card/list presentation.
- Desktop dark rendering at 1440×1024 and mobile rendering at 390px match their
  applicable Pencil frames after unsupported/stale frames are corrected.
