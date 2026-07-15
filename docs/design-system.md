# Design system — Indigo Console

The visual contract for `packages/web`. This file is to the **UI** what `packages/shared`
(Zod schemas) is to the **data**: the single source of truth that every UI task must
match and that prevents drift. The original v2 UI drifted into a generic "AI" look
precisely because this contract did not exist — the design lived only in the mockup and
nothing tied the code to it.

## Source of truth

- **Mockup:** [`pencil/web-ui.pen`](../pencil/web-ui.pen) — a **plain UTF‑8 JSON** file,
  tracked in git, so it is diffable and reviewable like code. Top‑level keys:
  - `variables` — design tokens (colors, radii, fonts) with per‑theme values.
  - `children` — frames (screens + reusable components).
  - `themes` — `mode: ["dark", "light"]`.
- **Read it two ways:**
  - **Pencil MCP** (preferred for visual work): `get_variables`, `get_screenshot`,
    `batch_get`, `get_editor_state`. Use `resolveVariables: true` to see computed hex/px.
    **Edits** to the mockup go through Pencil MCP, never by hand‑editing the JSON.
  - **Directly as JSON** for token extraction / drift checks (it is not encrypted).
- **Design system reference frame:** `cLCpW` ("Система — Indigo Console") — the canonical
  token + component reference. The earlier `c-*` and `s2-*` variables in the file are
  **abandoned explorations — ignore them.** Only the named role tokens below are live.

## Working agreement (the gates)

Visual fidelity is a **gate**, the same way `pnpm test` / `pnpm typecheck` are:

1. **Tokens first.** Before building screens, the design tokens must exist in
   `packages/web/src/index.css` `@theme`. Never hand‑pick a hex or px that isn't a token.
2. **Measure, don't invent.** When a value isn't obvious, read it from the mockup
   (`batch_get … resolveVariables:true`) — font size/weight, color, padding, radius, icon
   name+size. Do not fill visual gaps with model defaults (gradients, `rounded-2xl`,
   oversized padding). That generic look is the failure mode.
3. **Verify against the frame.** Render the screen at the mockup viewport
   (**1440×1024, dark**), screenshot it, and compare element‑by‑element to the frame.
   Cross‑check exact values with `browser_evaluate` (bounding boxes, computed styles) —
   a screenshot at the wrong viewport produces false conclusions.
4. **Match the control, don't downgrade it.** The mockup's *interaction* is part of the
   spec, not just its box. If the frame shows a segmented control, build a segmented
   control — not a dropdown; a dropdown of presets, not a free‑text input; an editable
   field, not read‑only text; a switch, not an omitted row. Units live where the mockup
   puts them (in the label — "Допуск, мс" — not trailing the input). Read the control
   *type* the way you read a color: from the mockup. Silently swapping a richer control
   for a simpler one is a control‑logic regression — the failure that repeatedly diverged
   the Settings screen from the frame even when the pixels looked close.
5. **Behavior, not just looks.** Interactive controls must work. No dead buttons, no
   decorative tabs that don't do anything — that reads as fake. If the engine genuinely
   can't back a control, that's a product decision: raise it, don't silently fake the
   control or quietly drop it from the mockup.
6. **Honesty over fidelity when they conflict.** Don't render data we don't have (fake
   quotas, fake totals). Show the real thing or omit it, and say why.

## Frame map (screen → frame id)

| Screen / component | Frame | Main child |
| --- | --- | --- |
| Узлы | `I4hmn` | `iuZcj` |
| Узлы — состояния (empty / loading) | `bY6uv` | — |
| Детали узла — drawer | `IgEPe` | `Un6TO` (Panel) |
| Источники | `gm1vM` | `cF8xX` |
| Настройки | `w6qeY` | `L5XjCf` |
| Соединения | `g5hb4` | `DxayN` |
| Соединения — светлая тема | `t9XUT` | production-style populated table |
| Соединения — mobile 390 | `H3itWn` | compact connection cards + «Ещё» navigation |
| Маршрутизация · Populated (dark) | `lYrng` | `R47Ya`; expanded system Direct card is the complete desktop editor reference |
| Маршрутизация · Состояния (create / disabled / mobile 390) | `HXRTv` | Disabled Direct and expanded 390 px Direct states |
| Маршрутизация · Populated — светлая | `CUEoq` | `eHlsq`; collapsed enabled Direct card is the light-theme reference |
| Трафик | `YED5Y` | `ZH6Id` |
| Трафик — светлая тема | `eLeqx` | cloned light-theme reference |
| Трафик — mobile 390 | `Qocs1` | compact 2×2 metrics + stacked charts |
| Трафик — состояния | `yjNoN` | loading / idle / reconnecting / no nodes |
| Логи | `ZdPsU` | `MKvCg` |
| Логи — светлая тема | `mnDGi` | unified mihomo + submerge stream |
| Логи — mobile 390 | `zW719` | stacked metadata/message rows + compact filters |
| Логи — состояния | `rE094` | connecting / live empty / paused / reconnecting |
| Диагностика | `QoRoZ` | `AqDqR` |
| Диагностика — светлая тема | `h9q7E` | full light-theme reference |
| Диагностика — mobile 390 | `BNOEr` | one-column cards + compact route rows |
| Диагностика — состояния | `pi7pQ` | running / partial / component and network failures |
| Раздел в разработке (placeholder) | `fFpGe` | `gsI9Q` |
| Sidebar (reusable) | `t0Wg2` | — |
| Button (reusable) | `hRDqB` | — |
| Badge (reusable) | `J7jxJ` | — |
| Design‑system reference | `cLCpW` | — |

### Routing / system Direct contract

- Direct is a system-owned channel in the normal sortable list. Desktop uses the existing
  grip; mobile uses the existing up/down controls. Default remains separate and terminal.
- The collapsed card always shows `Direct`, the `Системный` and mono `DIRECT` labels, an
  enabled switch, matcher-summary chips with the existing complete-chip `+N` behavior, and
  an expand control. Disabling the channel dims the whole card without hiding its saved
  matcher summary.
- Expanding Direct keeps the header on `bg-surface`; expansion is communicated by the
  editor and chevron, not by recoloring the header.
- The expanded Direct editor contains the independent `Частные сети` and `Локальные
  домены` preset switches followed by every shared custom matcher editor: preset domains,
  custom domains, domain keywords, rule-providers, GEOSITE, GEOIP, and IPv4/IPv6 CIDR.
- Direct never exposes a name editor, node pool, selection policy, active-node status, or
  delete action. Those controls remain exclusive to proxy-backed channels.
- `lYrng` is the dark expanded desktop reference, `CUEoq` is the light collapsed reference,
  and `HXRTv` contains the disabled desktop and expanded 390 px references. At 390 px all
  identity, summary, provider, and CIDR chips/controls stay complete within the card; no
  horizontal clipping or scrolling is permitted.

## Tokens

Defined in [`packages/web/src/index.css`](../packages/web/src/index.css): role variables
under `:root` (light) / `.dark` (dark), exposed as Tailwind utilities via `@theme inline`.
**These values are mirrored from the mockup's `variables`; keep them in sync.**

### Colors (role → dark / light)

| Role | Dark | Light |
| --- | --- | --- |
| `bg-base` | `#0B0D12` | `#F6F7F9` |
| `bg-surface` | `#101219` | `#FFFFFF` |
| `bg-elevated` | `#161922` | `#EEF0F5` |
| `bg-hover` | `#1C2029` | `#E7E9F0` |
| `bg-input` | `#13151C` | `#FFFFFF` |
| `border-subtle` | `#20232C` | `#E6E8EF` |
| `border-default` | `#2A2E39` | `#D5D9E2` |
| `border-strong` | `#3A3F4D` | `#C0C5D1` |
| `text-primary` | `#E9EBEF` | `#1A1D24` |
| `text-secondary` | `#9BA1AD` | `#585E6A` |
| `text-tertiary` | `#6A707D` | `#6F7682` |
| `text-disabled` | `#4A4F5A` | `#A9AEB9` |
| `accent` | `#6366F1` | `#6366F1` |
| `accent-hover` | `#7B7DF4` | `#5457E0` |
| `accent-fg` | `#FFFFFF` | `#FFFFFF` |
| `accent-text` | `#ADB0F8` | `#4F46E5` |
| `accent-bg` | `#6366F126` | `#6366F114` |
| `accent-border` | `#6366F14D` | `#6366F133` |
| `online` / `online-bg` | `#3FB950` / `…1F` | `#2E7D32` / `…1F` |
| `slow` / `slow-bg` | `#D9A33A` / `…1F` | `#A16207` / `…1F` |
| `timeout` / `timeout-bg` | `#E5534B` / `…1F` | `#C81E1E` / `…1F` |
| `idle` | `#6A707D` | `#9AA0AC` |
| `chart-track` | `#2E3150` | `#D8DAF3` |

> The accent is `#6366F1`. Do **not** confuse it with the abandoned `c-accent #6E8BFF`.

### Radii, fonts, spacing

- **Radii:** `sm 6 · md 8 · lg 10 · xl 14 · full 999`.
- **Fonts:** sans **Inter**, mono **JetBrains Mono**.
- **Spacing — 4px grid.** The mockup is built on a 4px step (with 8px as the common
  rhythm). Keep arbitrary values on the 4px grid; a future migration to a strict 8px
  scale should be done **in the mockup first**, then synced.

### Typography scale (role → size/weight)

`h1 24/600 · page-title-compact 22/600 · section 18/600 · cardtitle 15/600 ·
label 14/500 · sub 13/400 · meta 12/500 · caption 11/600 (ls .5) · fine 11/400 ·
micro 10 · axis 9 · metric 26/600`. Baked into `text-*` utilities in `@theme`
(`text-h1`, `text-section`, …). `caption` is the 11px LABEL style; `fine` is its
regular-weight body counterpart — never hand-write `text-[11px]`.

## Component specs (measured from the mockup)

These are the proven‑correct specs for the components reworked to match `I4hmn`.

- **Button** (`hRDqB`): height 40 (sm 32), padding `0 14`, radius 8, gap 8, label 14/500.
  - `primary`: fill `accent`, text/icon `accent-fg` (white).
  - `secondary`: fill `bg-elevated`, border `border-default`, **label `text-primary`
    (bright), icon `text-secondary` (muted)**. A fully‑muted label reads as *disabled* —
    that was the "bleached buttons" bug.
- **Switch:** track **40×22**, knob 16, inset 3, radius full. ON = `accent`, OFF =
  `bg-hover`. (A 36×20 track left too little accent visible and looked washed‑out.)
- **Badge** (`J7jxJ`): padding `3 8`, radius full, 11/600. Accent variant = `accent-bg`
  fill + `accent-text` + `accent-border`.
- **Node row** (`IWc4p`): dot 8 (status color) + name **Inter 14/600 `text-primary`** +
  sub **Inter 12/normal `text-tertiary`**. Inline ping button = **transparent (no
  border/fill), `zap` 18, `text-secondary`**, hover `bg-hover`. Active action = solid
  `primary` (not opacity‑dimmed).
- **Active‑node stats** (`P2IiG0` etc.): row is **bottom‑aligned**. Latency = 9px status
  dot + value **mono 30/600** status‑colored; throughput = **mono 18/500** with ↓/↑.
  Captions lowercase **11/normal `text-tertiary`** ("задержка · сейчас" / "принято" /
  "отдано").
- **Latency chart:** fixed‑width **40‑slot** frame, data right‑anchored and filling
  leftward; faint baseline tick for empty slots; recent ~4 bars `accent`, older
  `chart-track`, timeouts full‑height `timeout`; hover tooltip with the ms value; left
  axis = real elapsed time (`(count−1)×pollInterval`), right = "сейчас".
- **ConfirmDialog** (no mockup frame yet — product decision recorded here; draw a frame
  when dialogs multiply): native `<dialog>` (`showModal` = focus trap/Esc/top layer for
  free), width 360, `bg-surface` + `border-subtle` + `rounded-lg`; title `cardtitle`,
  body `sub`/`text-secondary`; actions right‑aligned — `secondary` (Отмена) +
  `destructive`; scrim `--color-scrim`; backdrop click closes.

## Enforcement

The contract is enforced the same way the data layer is (Zod + `db:generate`):

- **Token sync (implemented).** The color role variables in `index.css` (the `:root` /
  `.dark` blocks between the `@generated design tokens` markers) are generated from the
  mockup's `variables` by [`scripts/sync-design-tokens.mjs`](../packages/web/scripts/sync-design-tokens.mjs)
  (curated allow‑list `.pen` name → role var, ignoring `c-*`/`s2-*`). Do not hand‑edit
  inside the markers.
  - `pnpm -F @submerge/web design:tokens` — rewrite in place after the mockup changes.
  - `pnpm -F @submerge/web design:tokens:check` — fails if out of sync; runs in CI.
  - First run already corrected six light‑theme drifts (accent‑hover, accent‑border,
    text‑disabled, idle, online‑bg, timeout‑bg). Radii / fonts / type‑scale still live in
    `@theme` (they change rarely).

Still worth adding:

- **Per‑task visual acceptance criteria.** UI tasks in `docs/plans/` should carry measured
  specs referencing a frame id (as in the table above), not prose descriptions.
- **Visual‑diff review stage.** Render at 1440×dark → screenshot → compare to
  `get_screenshot` of the frame, before a UI task is "done".
