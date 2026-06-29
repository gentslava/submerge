export type Theme = "dark" | "light";

export function getTheme(): Theme {
  const saved = localStorage.getItem("theme");
  return saved === "light" ? "light" : "dark";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.classList.toggle("dark", theme === "dark");
  localStorage.setItem("theme", theme);
}
