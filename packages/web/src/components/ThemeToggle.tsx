import { Moon, Sun } from "lucide-react";
import { useState } from "react";
import { applyTheme, getTheme } from "@/lib/theme";

export function ThemeToggle() {
  const [theme, setTheme] = useState(getTheme);
  function toggle() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    applyTheme(next);
  }
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label="Сменить тему"
      className="inline-flex h-9 w-9 items-center justify-center rounded-md text-text-secondary hover:bg-hover"
    >
      {theme === "dark" ? <Moon size={16} /> : <Sun size={16} />}
    </button>
  );
}
