export type Theme = "dark" | "light" | "system";

const MEDIA = "(prefers-color-scheme: dark)";

// The user's explicit choice, or "system" by default (follow the OS until they pick).
export function getTheme(): Theme {
  const saved = localStorage.getItem("theme");
  return saved === "dark" || saved === "light" ? saved : "system";
}

// The concrete theme to render: "system" resolves against the OS preference.
export function resolveTheme(theme: Theme): "dark" | "light" {
  if (theme === "system") return window.matchMedia(MEDIA).matches ? "dark" : "light";
  return theme;
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", resolveTheme(theme) === "dark");
  // Absence of the key means "system" — only persist an explicit choice.
  if (theme === "system") localStorage.removeItem("theme");
  else localStorage.setItem("theme", theme);
}
