import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <div className="p-6 text-2xl">submerge — web (scaffold)</div>
  </StrictMode>,
);
