#!/usr/bin/env node
// Sync design tokens from the Pencil mockup into the stylesheet.
//
// `pencil/web-ui.pen` (plain JSON, tracked in git) is the visual source of truth;
// its `variables` are the design tokens. This script regenerates the :root (light)
// / .dark (dark) role-vars in `src/index.css`, between the @generated markers,
// so colors, radii, and fonts can't silently drift by hand.
//
//   pnpm -F @submerge/web design:tokens          # rewrite index.css in place
//   pnpm -F @submerge/web design:tokens:check    # fail if out of sync (CI)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PEN = resolve(here, "../../../pencil/web-ui.pen");
const CSS = resolve(here, "../src/index.css");

const START = "/* @generated design tokens";
const END = "/* @end generated design tokens */";

// .pen variable name → CSS role var name, in the order they appear in index.css.
// Only the live "Indigo Console" tokens; the abandoned c-* / s2-* explorations in
// the file are intentionally excluded.
const TOKENS = [
  ["bg-base", "bg-base"],
  ["bg-surface", "bg-surface"],
  ["bg-elevated", "bg-elevated"],
  ["bg-hover", "bg-hover"],
  ["bg-input", "bg-input"],
  ["border-subtle", "border-subtle"],
  ["border-default", "border-default"],
  ["border-strong", "border-strong"],
  ["text-primary", "text-primary"],
  ["text-secondary", "text-secondary"],
  ["text-tertiary", "text-tertiary"],
  ["text-disabled", "text-disabled"],
  ["accent", "accent"],
  ["accent-hover", "accent-hover"],
  ["accent-fg", "accent-fg"],
  ["accent-text", "accent-text"],
  ["accent-bg", "accent-bg"],
  ["accent-border", "accent-border"],
  ["status-online", "online"],
  ["status-online-bg", "online-bg"],
  ["status-slow", "slow"],
  ["status-slow-bg", "slow-bg"],
  ["status-timeout", "timeout"],
  ["status-timeout-bg", "timeout-bg"],
  ["status-idle", "idle"],
  ["chart-track", "chart-track"],
];

const SHARED_TOKENS = [
  ["font-sans", "design-font-sans", "font"],
  ["font-mono", "design-font-mono", "font"],
  ["radius-sm", "design-radius-sm", "px"],
  ["radius-md", "design-radius-md", "px"],
  ["radius-lg", "design-radius-lg", "px"],
  ["radius-xl", "design-radius-xl", "px"],
  ["radius-full", "design-radius-full", "px"],
];

function valueFor(variable, mode) {
  const v = variable.value;
  if (typeof v === "string" || typeof v === "number") return v;
  if (Array.isArray(v)) return (v.find((e) => e.theme?.mode === mode) ?? v[0])?.value;
  return undefined;
}

function sharedTokenLines(vars) {
  return SHARED_TOKENS.map(([pen, css, kind]) => {
    const variable = vars[pen];
    if (!variable) throw new Error(`token "${pen}" missing from web-ui.pen variables`);
    const val = valueFor(variable, "light");
    if (val == null) throw new Error(`token "${pen}" has no value`);
    const formatted = kind === "font" ? JSON.stringify(String(val)) : `${Number(val)}px`;
    return `  --${css}: ${formatted};`;
  });
}

function block(selector, vars, mode, includeShared = false) {
  const lines = TOKENS.map(([pen, css]) => {
    const variable = vars[pen];
    if (!variable) throw new Error(`token "${pen}" missing from web-ui.pen variables`);
    const val = valueFor(variable, mode);
    if (val == null) throw new Error(`token "${pen}" has no ${mode} value`);
    return `  --${css}: ${String(val).toLowerCase()};`;
  });
  if (includeShared) lines.push(...sharedTokenLines(vars));
  return `${selector} {\n${lines.join("\n")}\n}`;
}

const pen = JSON.parse(readFileSync(PEN, "utf8"));
const vars = pen.variables ?? {};
const generated = [
  `${START} — sync from pencil/web-ui.pen via \`pnpm -F @submerge/web design:tokens\`. Do not edit by hand. */`,
  block(":root", vars, "light", true),
  "",
  block(".dark", vars, "dark"),
  END,
].join("\n");

const css = readFileSync(CSS, "utf8");
const s = css.indexOf(START);
const e = css.indexOf(END);
if (s === -1 || e === -1) {
  console.error(
    `Markers not found in ${CSS}.\nWrap the :root/.dark token blocks with:\n  ${START} ... */\n  ...\n  ${END}`,
  );
  process.exit(1);
}
const next = css.slice(0, s) + generated + css.slice(e + END.length);

if (process.argv.includes("--check")) {
  if (next !== css) {
    console.error(
      "Design tokens are out of sync with pencil/web-ui.pen.\nRun `pnpm -F @submerge/web design:tokens`.",
    );
    process.exit(1);
  }
  console.log("Design tokens in sync with pencil/web-ui.pen.");
} else if (next !== css) {
  writeFileSync(CSS, next);
  console.log("Design tokens synced from pencil/web-ui.pen.");
} else {
  console.log("Design tokens already in sync.");
}
