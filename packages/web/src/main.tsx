import type { AppRouter } from "@submerge/server/router";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
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
        <Toaster theme={getTheme()} position="top-right" richColors />
      </TRPCProvider>
    </QueryClientProvider>
  );
}

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root mount point #root not found");
createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
