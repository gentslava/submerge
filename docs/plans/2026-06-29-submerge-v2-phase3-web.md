# submerge v2 — Phase 3: Web SPA (Indigo Console)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `packages/web` React SPA on the Indigo Console design system — type-safe tRPC client to the Phase-2 server, three working screens (Узлы / Источники / Настройки) plus an adaptive shell (desktop sidebar ⇄ mobile bottom-tab), dark+light themes.

**Architecture:** Vite + React 19 + strict TS. Tailwind v4 (CSS-first `@theme` with Indigo Console tokens, `:root`=light / `.dark`=dark, dark default). Hand-built shadcn-style primitives bound to our tokens. tRPC v11 via `@trpc/tanstack-react-query` (`useTRPC()` + `queryOptions`/`mutationOptions`) over TanStack Query v5. TanStack Router (code-based route tree). Feature folders (`features/nodes|sources|settings`). UI strings are Russian. submerge is a **server combine** — copy says "локальный прокси / LAN-доступ", never "системный прокси".

**Tech Stack:** React 19, Vite 7, TypeScript strict, Tailwind v4, `@tailwindcss/vite`, TanStack Query v5, TanStack Router v1, tRPC v11 + `@trpc/tanstack-react-query`, react-hook-form + Zod 4, lucide-react, sonner, class-variance-authority + clsx + tailwind-merge, uPlot (later phase), Vitest + Testing Library (jsdom).

---

## Notes for implementers (read before Task 1)

- **Check current APIs via Context7 MCP** before coding: Tailwind v4 (`@theme`, `@custom-variant`, `@tailwindcss/vite`), tRPC v11 `@trpc/tanstack-react-query` (`createTRPCContext`/`useTRPC`/`queryOptions`/`mutationOptions`), TanStack Router v1 (code-based `createRootRoute`/`createRoute`/`addChildren`/`createRouter`), TanStack Query v5, react-hook-form + `@hookform/resolvers/zod`. Versions are latest-major.
- **Server contract (already shipped, Phase 2):** `AppRouter` exported from `@submerge/server/src/trpc/router.ts`. Procedures: `health.ping`; `sources.{list,add,remove,refresh,toggle,reorder}`; `nodes.{list,delay,select}`; `settings.{get,set}`. Shared Zod types in `@submerge/shared` (`Source`, `Proxy`, `NodeView`, `NodeItem`, `addSourceInput`, `idInput`, `reorderInput`, `selectNodeInput`, `delayInput`, `setSettingInput`).
- **The web package imports `AppRouter` as a type-only import** from the server package (already a workspace dep pattern). It must NOT import server runtime code.
- **rtk hook masks `pnpm lint`** in this env — verify lint ONLY with the raw binary: `./node_modules/.bin/biome ci packages/ ; echo "EXIT=$?"` (must be 0). Autofix: `./node_modules/.bin/biome check --write packages/`.
- **Do NOT create a git worktree.** Work in the existing checkout on branch `feat/v2-phase3`. Conventional commits; end the body with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **Dev runs two processes:** the server (`pnpm -F @submerge/server dev`, port 3000) and Vite (`pnpm -F @submerge/web dev`, port 5173). Vite proxies `/trpc` → `http://localhost:3000` so the SPA talks to the real server. mihomo/happ-decoder need not run for UI work — calls just error and surface in the UI's error states.
- **Design system source of truth:** `pencil/web-ui.pen` (Indigo Console). Token values are inlined in Task 2 below; the screen layouts mirror the dark desktop frames + mobile frames in that file.

---

## File structure (created in Phase 3)

```
packages/web/
├─ package.json                 # MODIFY (replace Phase-1 placeholder): deps + scripts
├─ vite.config.ts               # NEW: react + tailwind plugins + /trpc proxy + vitest
├─ tsconfig.json                # MODIFY: DOM libs, jsx, bundler resolution
├─ index.html                   # NEW
├─ vitest.setup.ts              # NEW: @testing-library/jest-dom
├─ src/
│  ├─ main.tsx                  # NEW: providers + RouterProvider
│  ├─ index.css                 # NEW: Tailwind v4 @theme tokens (Indigo Console, light/dark)
│  ├─ lib/
│  │  ├─ utils.ts               # NEW: cn()
│  │  ├─ trpc.ts                # NEW: createTRPCContext<AppRouter> → { TRPCProvider, useTRPC }
│  │  ├─ query.ts               # NEW: makeQueryClient()
│  │  └─ theme.ts               # NEW: theme get/set (localStorage + <html> class)
│  ├─ components/ui/            # NEW: button, card, input, textarea, switch, badge, skeleton, dialog, segmented
│  ├─ components/
│  │  ├─ AppShell.tsx           # NEW: responsive sidebar/bottom-nav layout
│  │  ├─ Sidebar.tsx            # NEW (desktop)
│  │  ├─ BottomNav.tsx          # NEW (mobile)
│  │  ├─ ThemeToggle.tsx        # NEW
│  │  ├─ StatusDot.tsx          # NEW (mihomo health)
│  │  └─ LatencyBars.tsx        # NEW (bar sparkline)
│  ├─ routes/
│  │  ├─ root.tsx               # NEW: createRootRoute → AppShell + Outlet
│  │  ├─ nodes.tsx · sources.tsx · settings.tsx · more.tsx   # NEW route components
│  │  └─ tree.ts                # NEW: route tree + createRouter + Register
│  └─ features/
│     ├─ nodes/{NodesScreen,ActiveNodeCard,NodeRow,nodeView}.tsx(.ts)
│     ├─ sources/{SourcesScreen,SourceForm,SourceRow,detectKind}.tsx(.ts)
│     └─ settings/SettingsScreen.tsx
```

---

### Task 1: Web scaffold (Vite + React 19 + TS)

**Files:**
- Modify: `packages/web/package.json`
- Create: `packages/web/vite.config.ts`, `packages/web/index.html`, `packages/web/src/main.tsx`, `packages/web/src/index.css`
- Modify: `packages/web/tsconfig.json`

- [ ] **Step 1: Replace `packages/web/package.json`**

```json
{
  "name": "@submerge/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest run"
  },
  "dependencies": {
    "@submerge/shared": "workspace:*",
    "@tanstack/react-query": "latest",
    "@tanstack/react-router": "latest",
    "@trpc/client": "latest",
    "@trpc/tanstack-react-query": "latest",
    "@hookform/resolvers": "latest",
    "class-variance-authority": "latest",
    "clsx": "latest",
    "lucide-react": "latest",
    "react": "latest",
    "react-dom": "latest",
    "react-hook-form": "latest",
    "sonner": "latest",
    "tailwind-merge": "latest",
    "zod": "latest"
  },
  "devDependencies": {
    "@submerge/server": "workspace:*",
    "@tailwindcss/vite": "latest",
    "@testing-library/jest-dom": "latest",
    "@testing-library/react": "latest",
    "@testing-library/user-event": "latest",
    "@types/react": "latest",
    "@types/react-dom": "latest",
    "@vitejs/plugin-react": "latest",
    "jsdom": "latest",
    "tailwindcss": "latest",
    "vite": "latest",
    "vitest": "latest"
  }
}
```

> `@submerge/server` is a **devDependency** and is used type-only (`import type { AppRouter }`). Never import its runtime.

- [ ] **Step 2: Create `packages/web/vite.config.ts`**

```ts
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": resolve(__dirname, "src") } },
  server: {
    port: 5173,
    proxy: { "/trpc": "http://localhost:3000" },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    css: true,
  },
});
```

- [ ] **Step 3: Create `packages/web/index.html`**

```html
<!doctype html>
<html lang="ru" class="dark">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>submerge</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 4: Modify `packages/web/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src", "vite.config.ts", "vitest.setup.ts"]
}
```

- [ ] **Step 5: Create a minimal `packages/web/src/index.css`** (real tokens land in Task 2)

```css
@import "tailwindcss";
```

- [ ] **Step 6: Create a minimal `packages/web/src/main.tsx`**

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <div className="p-6 text-2xl">submerge — web (scaffold)</div>
  </StrictMode>,
);
```

- [ ] **Step 7: Install + run dev**

Run: `cd ~/Developer/submerge && pnpm install` then `pnpm -F @submerge/web dev`
Expected: Vite serves on `:5173`, page shows "submerge — web (scaffold)". Stop it (Ctrl+C).

- [ ] **Step 8: Commit**

```bash
git add packages/web pnpm-lock.yaml
git commit -m "$(printf 'feat(web): Vite + React 19 + TS scaffold for the SPA\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 2: Tailwind v4 + Indigo Console design tokens

**Files:**
- Modify: `packages/web/src/index.css`
- Create: `packages/web/src/lib/utils.ts`

- [ ] **Step 1: Write `packages/web/src/lib/utils.ts`**

```ts
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

- [ ] **Step 2: Replace `packages/web/src/index.css` with the token system**

```css
@import "tailwindcss";

/* Dark is the default theme; `.dark` on <html> is set in index.html. */
@custom-variant dark (&:where(.dark, .dark *));

/* Light theme (role → value) */
:root {
  --bg-base: #f6f7f9;
  --bg-surface: #ffffff;
  --bg-elevated: #eef0f5;
  --bg-hover: #e7e9f0;
  --bg-input: #ffffff;
  --border-subtle: #e6e8ef;
  --border-default: #d5d9e2;
  --border-strong: #c0c5d1;
  --text-primary: #1a1d24;
  --text-secondary: #585e6a;
  --text-tertiary: #6f7682;
  --text-disabled: #a0a6b0;
  --accent: #6366f1;
  --accent-hover: #5356e0;
  --accent-fg: #ffffff;
  --accent-text: #4f46e5;
  --accent-bg: #6366f114;
  --accent-border: #6366f14d;
  --online: #2e7d32;
  --online-bg: #2e7d3214;
  --slow: #a16207;
  --slow-bg: #a162071f;
  --timeout: #c81e1e;
  --timeout-bg: #c81e1e14;
  --idle: #6f7682;
  --chart-track: #d8daf3;
}

/* Dark theme override */
.dark {
  --bg-base: #0b0d12;
  --bg-surface: #101219;
  --bg-elevated: #161922;
  --bg-hover: #1c2029;
  --bg-input: #13151c;
  --border-subtle: #20232c;
  --border-default: #2a2e39;
  --border-strong: #3a3f4d;
  --text-primary: #e9ebef;
  --text-secondary: #9ba1ad;
  --text-tertiary: #6a707d;
  --text-disabled: #4a4f5a;
  --accent: #6366f1;
  --accent-hover: #7b7df4;
  --accent-fg: #ffffff;
  --accent-text: #adb0f8;
  --accent-bg: #6366f126;
  --accent-border: #6366f14d;
  --online: #3fb950;
  --online-bg: #3fb9501f;
  --slow: #d9a33a;
  --slow-bg: #d9a33a1f;
  --timeout: #e5534b;
  --timeout-bg: #e5534b1f;
  --idle: #6a707d;
  --chart-track: #2e3150;
}

/* Expose roles as Tailwind utilities (bg-base, text-primary, border-default, …) */
@theme inline {
  --color-canvas: var(--bg-base);
  --color-surface: var(--bg-surface);
  --color-elevated: var(--bg-elevated);
  --color-hover: var(--bg-hover);
  --color-input: var(--bg-input);
  --color-border-subtle: var(--border-subtle);
  --color-border-default: var(--border-default);
  --color-border-strong: var(--border-strong);
  --color-text-primary: var(--text-primary);
  --color-text-secondary: var(--text-secondary);
  --color-text-tertiary: var(--text-tertiary);
  --color-text-disabled: var(--text-disabled);
  --color-accent: var(--accent);
  --color-accent-hover: var(--accent-hover);
  --color-accent-fg: var(--accent-fg);
  --color-accent-text: var(--accent-text);
  --color-accent-bg: var(--accent-bg);
  --color-accent-border: var(--accent-border);
  --color-online: var(--online);
  --color-online-bg: var(--online-bg);
  --color-slow: var(--slow);
  --color-slow-bg: var(--slow-bg);
  --color-timeout: var(--timeout);
  --color-timeout-bg: var(--timeout-bg);
  --color-idle: var(--idle);
  --color-chart-track: var(--chart-track);
  --font-sans: "Inter", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
  --radius-sm: 6px;
  --radius-md: 8px;
  --radius-lg: 10px;
  --radius-xl: 14px;
}

@layer base {
  body {
    background-color: var(--bg-base);
    color: var(--text-primary);
    font-family: var(--font-sans);
    -webkit-font-smoothing: antialiased;
  }
}
```

> Fonts (Inter, JetBrains Mono) load via a `<link>` in `index.html` OR a `@import url(...)` at the very top of this file (before `@import "tailwindcss"`). Add the Google Fonts link to `index.html` head: `<link rel="preconnect" href="https://fonts.googleapis.com" /><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet" />`.

- [ ] **Step 3: Smoke the tokens**

Edit `src/main.tsx` temporarily to render `<div className="bg-surface text-accent-text border border-border-default rounded-lg p-4 font-mono">47 ms</div>`, run `pnpm -F @submerge/web dev`, confirm dark Indigo surface + indigo text render. Revert the temp markup. (No commit of temp markup.)

- [ ] **Step 4: Lint + commit**

Run: `./node_modules/.bin/biome ci packages/ ; echo "EXIT=$?"` → 0.

```bash
git add packages/web/src/index.css packages/web/src/lib/utils.ts packages/web/index.html
git commit -m "$(printf 'feat(web): Tailwind v4 theme with Indigo Console tokens (light/dark) + cn util\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 3: UI primitives (shadcn-style, bound to tokens) + tests

**Files:**
- Create: `packages/web/src/components/ui/{button,card,input,textarea,switch,badge,skeleton,segmented}.tsx`
- Test: `packages/web/src/components/ui/button.test.tsx`

- [ ] **Step 1: Create `button.tsx`** (cva variants on our tokens)

```tsx
import { Slot } from "radix-ui";
import { type VariantProps, cva } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const button = cva(
  "inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-border disabled:opacity-50 disabled:pointer-events-none cursor-pointer",
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-fg hover:bg-accent-hover",
        ghost: "bg-elevated text-text-secondary border border-border-default hover:bg-hover",
        subtle: "bg-transparent text-text-secondary hover:bg-hover",
        destructive: "bg-transparent text-timeout border border-border-default hover:bg-timeout-bg",
      },
      size: { sm: "h-8 px-3", md: "h-9 px-4", icon: "h-9 w-9 p-0" },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {
  asChild?: boolean;
}

export function Button({ className, variant, size, asChild, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  return <Comp className={cn(button({ variant, size }), className)} {...props} />;
}
```

> If `radix-ui` (the unified package) is not desired, drop `asChild`/`Slot` and render a plain `<button>`. Verify the current Radix import path via Context7. Add `radix-ui` to deps only if used.

- [ ] **Step 2: Create the remaining primitives** — `card.tsx`, `input.tsx`, `textarea.tsx`, `switch.tsx`, `badge.tsx`, `skeleton.tsx`, `segmented.tsx`. Each is a thin styled element using tokens. Example `card.tsx`:

```tsx
import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("bg-surface border border-border-subtle rounded-xl", className)}
      {...props}
    />
  );
}
```

`input.tsx` / `textarea.tsx`: `bg-input border border-border-default rounded-md px-3 text-sm text-text-primary placeholder:text-text-tertiary focus-visible:ring-2 focus-visible:ring-accent-border focus-visible:outline-none` (input `h-9`, textarea `min-h-24 py-2 font-mono`).
`badge.tsx`: small pill `inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium`, variant prop maps to `bg-elevated text-text-secondary` / `bg-online-bg text-online` / `bg-slow-bg text-slow` / `bg-timeout-bg text-timeout` / `bg-accent-bg text-accent-text`.
`switch.tsx`: a controlled toggle (`role="switch"`, `aria-checked`), 36×20 track, `bg-accent` when on else `bg-border-strong`, animated knob.
`skeleton.tsx`: `animate-pulse bg-elevated rounded-md`.
`segmented.tsx`: a small two/three-option segmented control (used for Ручной/Авто and theme).

(Write each file fully; they are 5–20 lines. Keep one responsibility per file.)

- [ ] **Step 3: Write a failing test `button.test.tsx`**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
    expect(screen.getByRole("button", { name: "Обновить" }).className).toContain("border-border-default");
  });
});
```

- [ ] **Step 4: Create `vitest.setup.ts`**

```ts
import "@testing-library/jest-dom/vitest";
```

- [ ] **Step 5: Run tests → pass**

Run: `pnpm -F @submerge/web test` → button tests pass.

- [ ] **Step 6: Lint + commit**

```bash
git add packages/web/src/components/ui packages/web/vitest.setup.ts
git commit -m "$(printf 'feat(web): UI primitives (button/card/input/switch/badge/...) bound to Indigo Console tokens + test\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 4: tRPC client + Query + Router wiring

**Files:**
- Create: `packages/web/src/lib/trpc.ts`, `packages/web/src/lib/query.ts`, `packages/web/src/lib/theme.ts`
- Create: `packages/web/src/routes/root.tsx`, `packages/web/src/routes/tree.ts`, and stub route components `routes/{nodes,sources,settings,more}.tsx`
- Modify: `packages/web/src/main.tsx`

- [ ] **Step 1: `src/lib/trpc.ts`**

```ts
import type { AppRouter } from "@submerge/server/src/trpc/router.js";
import { createTRPCContext } from "@trpc/tanstack-react-query";

export const { TRPCProvider, useTRPC } = createTRPCContext<AppRouter>();
```

> If `@submerge/server/src/trpc/router.js` does not resolve under bundler resolution, add an `exports` map entry to the server `package.json` (`"./router": "./src/trpc/router.ts"`) and import `@submerge/server/router`. Type-only import — no runtime pulled in.

- [ ] **Step 2: `src/lib/query.ts`**

```ts
import { QueryClient } from "@tanstack/react-query";

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { staleTime: 5_000, retry: 1 } },
  });
}
```

- [ ] **Step 3: `src/lib/theme.ts`**

```ts
export type Theme = "dark" | "light";

export function getTheme(): Theme {
  const saved = localStorage.getItem("theme");
  return saved === "light" ? "light" : "dark";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  localStorage.setItem("theme", theme);
}
```

- [ ] **Step 4: `src/routes/root.tsx`** (root route renders the shell; AppShell created in Task 5 — stub it for now)

```tsx
import { Outlet, createRootRoute } from "@tanstack/react-router";

export const rootRoute = createRootRoute({
  component: () => <Outlet />,
});
```

- [ ] **Step 5: Stub route components** — `routes/nodes.tsx`, `routes/sources.tsx`, `routes/settings.tsx`, `routes/more.tsx`, each exporting a component that renders its title (replaced by real screens in Tasks 6–8). Example `routes/nodes.tsx`:

```tsx
export function NodesRoute() {
  return <div className="p-6 text-text-primary">Узлы</div>;
}
```

- [ ] **Step 6: `src/routes/tree.ts`**

```ts
import { createRoute, createRouter } from "@tanstack/react-router";
import { MoreRoute } from "./more";
import { NodesRoute } from "./nodes";
import { rootRoute } from "./root";
import { SettingsRoute } from "./settings";
import { SourcesRoute } from "./sources";

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: NodesRoute });
const sourcesRoute = createRoute({ getParentRoute: () => rootRoute, path: "/sources", component: SourcesRoute });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsRoute });
const moreRoute = createRoute({ getParentRoute: () => rootRoute, path: "/more", component: MoreRoute });

const routeTree = rootRoute.addChildren([indexRoute, sourcesRoute, settingsRoute, moreRoute]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
```

- [ ] **Step 7: Replace `src/main.tsx`**

```tsx
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import type { AppRouter } from "@submerge/server/src/trpc/router.js";
import { makeQueryClient } from "./lib/query";
import { applyTheme, getTheme } from "./lib/theme";
import { TRPCProvider } from "./lib/trpc";
import { router } from "./routes/tree";
import "./index.css";

applyTheme(getTheme());

function App() {
  const [queryClient] = useState(makeQueryClient);
  const [trpcClient] = useState(() =>
    createTRPCClient<AppRouter>({ links: [httpBatchLink({ url: "/trpc" })] }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <RouterProvider router={router} />
        <Toaster theme="dark" position="top-right" richColors />
      </TRPCProvider>
    </QueryClientProvider>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 8: Verify dev + health**

Run server (`pnpm -F @submerge/server dev`) and web (`pnpm -F @submerge/web dev`). Visit `:5173` → "Узлы" stub renders; `:5173/sources` → "Источники". Open devtools network: navigating shouldn't 404. Stop both.

- [ ] **Step 9: Typecheck + lint + commit**

Run: `pnpm typecheck` (clean) and `./node_modules/.bin/biome ci packages/ ; echo "EXIT=$?"` → 0.

```bash
git add packages/web/src/lib packages/web/src/routes packages/web/src/main.tsx packages/server/package.json
git commit -m "$(printf 'feat(web): tRPC client + TanStack Query + Router wiring (typed AppRouter)\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 5: Adaptive shell — Sidebar (desktop) / BottomNav (mobile)

**Files:**
- Create: `packages/web/src/components/{AppShell,Sidebar,BottomNav,ThemeToggle,StatusDot}.tsx`
- Modify: `packages/web/src/routes/root.tsx` (use AppShell)

The shell: on `md+` a fixed left sidebar (240px) + content; below `md` a content area + fixed bottom tab bar. Nav destinations: **Узлы** (`/`), **Источники** (`/sources`), **Настройки** (`/settings`) are active; future ones (Трафик, Соединения, Логи, Диагностика, Маршрутизация) render as disabled "скоро" items in the sidebar. Mobile bottom-tab shows 5 slots — Узлы · Источники · Настройки · (placeholder) · **Ещё** (`/more`); the «Ещё» screen lists the rest + server utilities.

- [ ] **Step 1: `StatusDot.tsx`** — polls `health.ping`, shows a colored dot + "mihomo: online/offline".

```tsx
import { useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc";

export function StatusDot() {
  const trpc = useTRPC();
  const ping = useQuery({ ...trpc.health.ping.queryOptions(), refetchInterval: 10_000 });
  const online = ping.data?.ok === true;
  return (
    <div className="flex items-center gap-2 text-xs text-text-secondary">
      <span className={`h-2 w-2 rounded-full ${online ? "bg-online" : "bg-timeout"}`} />
      mihomo: {online ? "online" : "offline"}
    </div>
  );
}
```

- [ ] **Step 2: `ThemeToggle.tsx`** — toggles dark/light via `applyTheme`, lucide `Sun`/`Moon`, local state seeded from `getTheme()`.

- [ ] **Step 3: `Sidebar.tsx`** — wordmark "submerge" + StatusDot; nav items (lucide icon + label) via `Link` with `[&.active]` styling; a "СКОРО" group of disabled items; footer: proxy chip `SOCKS · 127.0.0.1:7890` (mono) + ThemeToggle. Active link style: `bg-accent-bg text-accent-text`; idle: `text-text-secondary hover:bg-hover`.

```tsx
import { Link } from "@tanstack/react-router";
import { Activity, Inbox, Settings } from "lucide-react";
import { StatusDot } from "./StatusDot";
import { ThemeToggle } from "./ThemeToggle";

const NAV = [
  { to: "/", label: "Узлы", icon: Activity },
  { to: "/sources", label: "Источники", icon: Inbox },
  { to: "/settings", label: "Настройки", icon: Settings },
] as const;

export function Sidebar() {
  return (
    <aside className="hidden md:flex w-60 shrink-0 flex-col gap-1 border-r border-border-subtle bg-surface p-3">
      <div className="flex items-center justify-between px-2 py-3">
        <span className="font-semibold text-text-primary">submerge</span>
      </div>
      <StatusDot />
      <nav className="mt-3 flex flex-col gap-1">
        {NAV.map(({ to, label, icon: Icon }) => (
          <Link
            key={to}
            to={to}
            className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-text-secondary hover:bg-hover [&.active]:bg-accent-bg [&.active]:text-accent-text"
          >
            <Icon size={16} /> {label}
          </Link>
        ))}
      </nav>
      <div className="mt-auto flex flex-col gap-2">
        <div className="rounded-md bg-elevated px-2.5 py-1.5 font-mono text-xs text-text-tertiary">
          SOCKS · 127.0.0.1:7890
        </div>
        <ThemeToggle />
      </div>
    </aside>
  );
}
```

- [ ] **Step 4: `BottomNav.tsx`** — `md:hidden fixed bottom-0` tab bar, 5 slots (Узлы/Источники/Настройки/—/Ещё), each a `Link` with icon + tiny label, ≥44px touch height, active = `text-accent-text`.

- [ ] **Step 5: `AppShell.tsx`**

```tsx
import { Outlet } from "@tanstack/react-router";
import { BottomNav } from "./BottomNav";
import { Sidebar } from "./Sidebar";

export function AppShell() {
  return (
    <div className="flex min-h-dvh bg-canvas text-text-primary">
      <Sidebar />
      <main className="flex-1 pb-16 md:pb-0">
        <Outlet />
      </main>
      <BottomNav />
    </div>
  );
}
```

- [ ] **Step 6: Use AppShell in `root.tsx`** — change `component` to render `<AppShell />`.

- [ ] **Step 7: Verify responsive** — dev, resize browser across the `md` breakpoint: sidebar ⇄ bottom-tab. Active item highlights. ThemeToggle flips light/dark. Commit.

```bash
git add packages/web/src/components packages/web/src/routes/root.tsx
git commit -m "$(printf 'feat(web): adaptive shell — desktop sidebar / mobile bottom-tab + theme toggle + mihomo status\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 6: Узлы screen (nodes.list / select / delay)

**Files:**
- Create: `packages/web/src/components/LatencyBars.tsx`
- Create: `packages/web/src/features/nodes/{NodesScreen,ActiveNodeCard,NodeRow}.tsx`, `packages/web/src/features/nodes/nodeView.ts`
- Test: `packages/web/src/features/nodes/nodeView.test.ts`
- Modify: `packages/web/src/routes/nodes.tsx`

`nodes.list` returns `NodeView { now: string|null, all: NodeItem[] }`. The PROXY group's `all` includes the pseudo-targets `AUTO`/`DIRECT` (see phase2-followups) — render them distinctly (no flag, a "режим" badge), not as provider nodes.

- [ ] **Step 1: Pure helper `nodeView.ts` + failing test** — split nodes into the active one, the "режимы" (AUTO/DIRECT/REJECT), and real nodes; classify latency.

```ts
import type { NodeItem } from "@submerge/shared";

export type LatencyClass = "online" | "slow" | "timeout" | "idle";

export function latencyClass(delay: number | null): LatencyClass {
  if (delay === null) return "idle";
  if (delay <= 0) return "timeout";
  if (delay < 100) return "online";
  if (delay < 300) return "slow";
  return "slow";
}

const PSEUDO = new Set(["AUTO", "DIRECT", "REJECT", "GLOBAL"]);

export function splitNodes(all: NodeItem[]): { modes: NodeItem[]; nodes: NodeItem[] } {
  const modes: NodeItem[] = [];
  const nodes: NodeItem[] = [];
  for (const n of all) (PSEUDO.has(n.name) ? modes : nodes).push(n);
  return { modes, nodes };
}
```

```ts
// nodeView.test.ts
import { describe, expect, it } from "vitest";
import { latencyClass, splitNodes } from "./nodeView";

describe("nodeView", () => {
  it("classifies latency", () => {
    expect(latencyClass(null)).toBe("idle");
    expect(latencyClass(0)).toBe("timeout");
    expect(latencyClass(47)).toBe("online");
    expect(latencyClass(210)).toBe("slow");
  });
  it("separates pseudo modes from real nodes", () => {
    const { modes, nodes } = splitNodes([
      { name: "AUTO", type: "URLTest", delay: null },
      { name: "NL-1", type: "vless", delay: 47 },
      { name: "DIRECT", type: "Direct", delay: null },
    ]);
    expect(modes.map((m) => m.name)).toEqual(["AUTO", "DIRECT"]);
    expect(nodes.map((n) => n.name)).toEqual(["NL-1"]);
  });
});
```

Run the test → fails (module missing) → after writing `nodeView.ts` → passes.

- [ ] **Step 2: `LatencyBars.tsx`** — a bar sparkline (per feedback-chart-style: bars, not a line). Takes `number[]` heights, renders flex of `bg-accent` rects over a `bg-chart-track` baseline. Pure presentational.

- [ ] **Step 3: `NodeRow.tsx`** — props `{ item: NodeItem; isActive: boolean; onSelect(): void; onPing(): void }`. Renders status dot (latencyClass → online/slow/timeout color), mono name, a latency `Badge` (variant from latencyClass, text `47 ms` / `timeout` / `— ms`), and an "Активен" badge or a `Выбрать` ghost button. Active row: `bg-accent-bg` tint + left accent border.

- [ ] **Step 4: `ActiveNodeCard.tsx`** — the `now` node: eyebrow "АКТИВНЫЙ УЗЕЛ", mono name, big latency number (color by class), `LatencyBars`, a `Сменить узел` action (no-op scroll-to-list for now). If `now` is null → "Нет активного узла".

- [ ] **Step 5: `NodesScreen.tsx`** — `useTRPC()` + `useQuery(trpc.nodes.list.queryOptions(), { refetchInterval: 5000 })`. Header "Узлы" + subtitle (group + active) + buttons "Обновить" (refetch) / "Пинг всех" (fire `nodes.delay` per node). `select` mutation (`trpc.nodes.select.mutationOptions`) → on success `invalidate` nodes.list + toast. `delay` mutation updates a local map of name→ms (optimistic display). Loading → skeleton rows; empty (no PROXY) → empty state "Нет узлов — добавьте источник" + Link to `/sources`.

```tsx
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useTRPC } from "@/lib/trpc";
import { ActiveNodeCard } from "./ActiveNodeCard";
import { NodeRow } from "./NodeRow";
import { splitNodes } from "./nodeView";

export function NodesScreen() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const nodesQuery = useQuery({ ...trpc.nodes.list.queryOptions(), refetchInterval: 5000 });
  const select = useMutation(
    trpc.nodes.select.mutationOptions({
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: trpc.nodes.list.queryKey() });
        toast.success("Узел выбран");
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const view = nodesQuery.data;
  if (!view) return <div className="p-6 text-text-secondary">Загрузка…</div>;
  const { nodes } = splitNodes(view.all);

  return (
    <div className="mx-auto max-w-4xl p-4 md:p-8">
      <header className="mb-6 flex items-center gap-3">
        <div className="flex-1">
          <h1 className="text-2xl font-semibold">Узлы</h1>
          <p className="text-sm text-text-secondary">Группа PROXY · активный: {view.now ?? "—"}</p>
        </div>
        <Button variant="ghost" onClick={() => nodesQuery.refetch()}>Обновить</Button>
      </header>
      <ActiveNodeCard now={view.now} all={view.all} />
      <div className="mt-6 flex flex-col rounded-xl border border-border-subtle bg-surface">
        {nodes.length === 0 ? (
          <div className="p-8 text-center text-text-secondary">Нет узлов — добавьте источник.</div>
        ) : (
          nodes.map((n) => (
            <NodeRow
              key={n.name}
              item={n}
              isActive={view.now === n.name}
              onSelect={() => select.mutate({ group: "PROXY", name: n.name })}
              onPing={() => {}}
            />
          ))
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Wire `routes/nodes.tsx`** to render `<NodesScreen />`. Run tests (nodeView) + dev smoke (with server running; without mihomo the list is empty/errors — confirm graceful empty/error, not a crash).

- [ ] **Step 7: Lint + commit**

```bash
git add packages/web/src/features/nodes packages/web/src/components/LatencyBars.tsx packages/web/src/routes/nodes.tsx
git commit -m "$(printf 'feat(web): Узлы screen — list/select/delay, active card, latency bars + nodeView tests\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 7: Источники screen (sources CRUD)

**Files:**
- Create: `packages/web/src/features/sources/{SourcesScreen,SourceForm,SourceRow,detectKind}.tsx(.ts)`
- Test: `packages/web/src/features/sources/detectKind.test.ts`
- Modify: `packages/web/src/routes/sources.tsx`

- [ ] **Step 1: Client-side `detectKind.ts` (UI hint only) + failing test** — mirrors the server's detection just to show a type badge while typing (the server re-detects authoritatively on add).

```ts
export type KindHint = "vless" | "happ" | "sub" | "unknown";

export function detectKindHint(value: string): KindHint {
  const v = value.trim();
  if (!v) return "unknown";
  if (v.startsWith("vless://")) return "vless";
  if (/^happ:\/\//i.test(v)) return "happ";
  if (/^https?:\/\//i.test(v)) return "sub";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return "sub";
  return "unknown";
}

export const KIND_LABEL: Record<KindHint, string> = {
  vless: "одиночный vless",
  happ: "happ (зашифр.)",
  sub: "подписка / deep-link",
  unknown: "база64 / неизвестно",
};
```

```ts
// detectKind.test.ts
import { describe, expect, it } from "vitest";
import { detectKindHint } from "./detectKind";

describe("detectKindHint", () => {
  it("detects kinds for the type badge", () => {
    expect(detectKindHint("vless://u@h:443")).toBe("vless");
    expect(detectKindHint("happ://crypt5/x")).toBe("happ");
    expect(detectKindHint("https://ex.com/sub")).toBe("sub");
    expect(detectKindHint("clash://install?url=x")).toBe("sub");
    expect(detectKindHint("")).toBe("unknown");
  });
});
```

- [ ] **Step 2: `SourceForm.tsx`** — `react-hook-form` + `zodResolver(addSourceInput)`. A mono `Textarea` for `value` (live type badge via `detectKindHint`), a `Switch` for `hwid` with helper "Включайте только для провайдеров с привязкой к устройству", a primary `Добавить` button. On submit → `trpc.sources.add.mutationOptions` → invalidate `sources.list` + reset + toast; button shows pending state.

- [ ] **Step 3: `SourceRow.tsx`** — props `{ source: Source }`. A drag handle (grip icon, reorder is visual-only this phase OR wired to `sources.reorder` if time), kind icon (lucide), label (mono, truncate), count badge `N узлов`, optional `HWID` badge, a `Switch` (enabled → `sources.toggle`), refresh icon button (`sources.refresh`), remove icon button → confirm dialog → `sources.remove`. Disabled rows dimmed.

- [ ] **Step 4: `SourcesScreen.tsx`** — `useQuery(trpc.sources.list.queryOptions())`; render `SourceForm` then the list (or empty state "Пока нет источников — вставьте ссылку выше."). Mutations invalidate `sources.list`; each surfaces a sonner toast on success/error.

- [ ] **Step 5: Wire `routes/sources.tsx`**, run tests + dev smoke (add/remove/toggle against the real server with in-memory/file DB; ingest of a real URL will fail without network — confirm the error toast shows, no crash).

- [ ] **Step 6: Lint + commit**

```bash
git add packages/web/src/features/sources packages/web/src/routes/sources.tsx
git commit -m "$(printf 'feat(web): Источники screen — add (rhf+zod, type hint, HWID) + list (toggle/refresh/remove) + detectKind test\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 8: Настройки screen + Ещё (mobile)

**Files:**
- Create: `packages/web/src/features/settings/SettingsScreen.tsx`
- Modify: `packages/web/src/routes/settings.tsx`, `packages/web/src/routes/more.tsx`

- [ ] **Step 1: `SettingsScreen.tsx`** — `useQuery(trpc.settings.get.queryOptions())` returns `Record<string,string>`. Sections (Card per group):
  - **Внешний вид:** Тема — segmented (Тёмная / Светлая) calling `applyTheme` + persisting via `settings.set({key:"theme", value})`.
  - **Подключение:** read-only proxy address chip (`127.0.0.1:7890`), `mihomo secret` (read-only display of whether set), интервал опроса (number, persisted via `settings.set`).
  - **HWID:** current hwid value (mono, from `settings.get`'s `hwid` if present) + copy button.
  Each `settings.set` mutation invalidates `settings.get` + toast "Сохранено".

- [ ] **Step 2: `routes/more.tsx` (mobile «Ещё»)** — a list of the deferred sections as disabled "скоро" rows (Соединения, Трафик, Логи, Диагностика, Маршрутизация), then server utilities placeholders (LAN-доступ — описание, Перезапустить ядро — disabled for now, proxy endpoint chip). Реальные действия появятся в Фазах 4–6. This screen is reachable from the mobile bottom-tab «Ещё»; on desktop it's not in the sidebar.

- [ ] **Step 3: Wire routes, dev smoke (theme switch persists across reload; settings.set round-trips), lint, commit**

```bash
git add packages/web/src/features/settings packages/web/src/routes/settings.tsx packages/web/src/routes/more.tsx
git commit -m "$(printf 'feat(web): Настройки screen (theme/connection/HWID) + mobile «Ещё» overflow\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 9: States, polish, a11y

**Files:** modify the three screens + shell.

- [ ] **Step 1: Loading skeletons** — each screen shows skeleton rows/cards (not a bare spinner) while its query is pending (>300ms).
- [ ] **Step 2: Empty states** — Узлы (no PROXY) / Источники (no rows) have helpful centered empty states with a primary action.
- [ ] **Step 3: Error surfacing** — every mutation `onError` shows a sonner error toast with `error.message`; the nodes/sources queries render an inline error block with a "Повторить" button on failure (mihomo/decoder down).
- [ ] **Step 4: a11y pass** — buttons have accessible names, icon-only buttons get `aria-label`, the Switch has `role="switch"`/`aria-checked`, focus rings visible (already in primitives), bottom-tab targets ≥44px. Verify keyboard tab order on Узлы.
- [ ] **Step 5: Lint + commit**

```bash
git add packages/web/src
git commit -m "$(printf 'feat(web): loading/empty/error states + a11y polish across screens\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 10: Component tests for screen logic

**Files:**
- Test: `packages/web/src/features/nodes/NodeRow.test.tsx`, `packages/web/src/features/sources/SourceForm.test.tsx`
- Create (if needed): `packages/web/src/test/utils.tsx` (render helper with a QueryClient + a mocked `useTRPC`)

Mock the tRPC layer at the hook boundary (don't hit the network). The simplest approach: render components that take data + callbacks as props (NodeRow, SourceRow already do) so they test without providers; for screen-level forms, wrap with a QueryClientProvider and stub the mutation via `vi.mock("@/lib/trpc", ...)` returning a fake `useTRPC()` whose `*.mutationOptions` produce inert options.

- [ ] **Step 1: `NodeRow.test.tsx`** — renders a node with delay 47 → shows "47 ms" + online color; renders timeout → "timeout"; clicking "Выбрать" calls `onSelect`. (Pure prop-driven, no providers.)

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NodeRow } from "./NodeRow";

describe("NodeRow", () => {
  it("shows latency and fires onSelect", () => {
    const onSelect = vi.fn();
    render(
      <NodeRow item={{ name: "NL-1", type: "vless", delay: 47 }} isActive={false} onSelect={onSelect} onPing={() => {}} />,
    );
    expect(screen.getByText("47 ms")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Выбрать" }));
    expect(onSelect).toHaveBeenCalledOnce();
  });
  it("marks the active node", () => {
    render(
      <NodeRow item={{ name: "NL-1", type: "vless", delay: 47 }} isActive onSelect={() => {}} onPing={() => {}} />,
    );
    expect(screen.getByText("Активен")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: `SourceForm.test.tsx`** — typing a `vless://…` shows the "одиночный vless" type badge; the `HWID` switch toggles `aria-checked`. (Wrap in a minimal provider or mock `useTRPC`.)
- [ ] **Step 3: Run all web tests → pass.** `pnpm -F @submerge/web test`.
- [ ] **Step 4: Lint + commit**

```bash
git add packages/web/src
git commit -m "$(printf 'test(web): NodeRow + SourceForm component tests\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')"
```

---

### Task 11: Phase gate — build, typecheck, lint, browser smoke

**Files:** none (verification).

- [ ] **Step 1: Full test suite** — `cd ~/Developer/submerge && pnpm -r test` → shared + server + web all green.
- [ ] **Step 2: Typecheck** — `pnpm typecheck` → clean across all packages (web `tsc -b` with DOM libs).
- [ ] **Step 3: Lint (raw binary)** — `./node_modules/.bin/biome ci packages/ ; echo "EXIT=$?"` → 0.
- [ ] **Step 4: Production build** — `pnpm -F @submerge/web build` → `tsc -b` + `vite build` produce `packages/web/dist/` with no errors.
- [ ] **Step 5: Browser smoke (Chrome DevTools MCP / verify skill)** — run server + web dev, then verify in a real browser: (a) dark theme renders Indigo Console; (b) Узлы/Источники/Настройки navigate; (c) theme toggle flips to light and persists on reload; (d) resize to mobile width → bottom-tab appears, «Ещё» reachable; (e) an action with mihomo down surfaces an error toast, not a crash. Capture a screenshot of Узлы (dark) and the light theme.
- [ ] **Step 6: Final commit (if anything changed)**

```bash
git add -A
git commit -m "$(printf 'chore(web): phase 3 gate — build/typecheck/lint/tests green\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>')" || echo "nothing to commit"
```

---

## Self-Review (performed while writing)

- **Spec coverage (spec §2/§6, design system):** Vite+React19+TS ✓ (T1); Tailwind v4 + Indigo Console tokens light/dark ✓ (T2); shadcn-style primitives ✓ (T3); tRPC client typed via AppRouter + TanStack Query + Router ✓ (T4); adaptive sidebar/bottom-tab + theme + mihomo status ✓ (T5); Узлы (list/select/delay, AUTO/DIRECT handling, bar charts) ✓ (T6); Источники (rhf+zod add, HWID, toggle/refresh/remove/reorder) ✓ (T7); Настройки + mobile Ещё ✓ (T8); states/a11y ✓ (T9); tests ✓ (T3/T6/T7/T10); gate ✓ (T11). Real-time SSE/live charts = Phase 4 (out of scope; bars use snapshot now). Auth/login = Phase 5. Serving web from the server + Docker = Phase 6 (dev uses Vite proxy).
- **Placeholder scan:** setup/logic steps carry full code; visual primitives (T3) and some rows (T6/T7) are specified by exact classes/props/behavior rather than full JSX to keep the plan readable — the implementer writes 5–20 line files from precise specs. No TODO/TBD; no undefined types (all server/shared types are named and exist).
- **Type consistency:** `useTRPC()` + `trpc.<router>.<proc>.queryOptions()/mutationOptions()` used uniformly (T4 pattern); `NodeItem`/`NodeView`/`Source`/`addSourceInput` come from `@submerge/shared`; `latencyClass`/`splitNodes` (T6) and `detectKindHint`/`KIND_LABEL` (T7) are defined before use; `AppRouter` type-only import path consistent (T1/T4/main).
- **DRY/YAGNI:** primitives bound to tokens (no per-screen colors); prop-driven rows (testable without providers); no uPlot yet (bars suffice for snapshot — uPlot arrives with live data in Phase 4).

## Notes
- **uPlot / live latency** is deliberately deferred to Phase 4 (SSE). Phase 3 charts are static bars from the last delay snapshot (consistent with feedback-chart-style).
- **reorder** (drag) may ship as visual-only in T7 if DnD wiring is heavy; the `sources.reorder` procedure exists, so a follow-up can connect it. Note the limitation in the commit if so.
- **Server `exports` for the router type:** if `@submerge/server/src/trpc/router.js` doesn't resolve under web's bundler resolution, add `"./router": "./src/trpc/router.ts"` to the server package `exports` and import `@submerge/server/router` (type-only) — adjust T1/T4/main accordingly.
