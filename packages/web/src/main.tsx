import type { AppRouter } from "@submerge/server/router";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { createTRPCClient, httpBatchLink, httpSubscriptionLink, splitLink } from "@trpc/client";
import { type ReactNode, StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { LoginScreen } from "./features/auth/LoginScreen";
import { useAuthStatus } from "./features/auth/useAuth";
import { LiveProvider } from "./features/live/LiveProvider";
import { makeQueryClient } from "./lib/query";
import { applyTheme, getTheme } from "./lib/theme";
import { ThemeProvider, useTheme } from "./lib/theme-context";
import { TRPCProvider } from "./lib/trpc";
import { router } from "./routes/tree";
import "./index.css";

applyTheme(getTheme());

function ThemedToaster() {
  const { theme } = useTheme();
  return <Toaster theme={theme} position="top-right" richColors />;
}

function AuthGate({ children }: { children: ReactNode }) {
  const status = useAuthStatus();
  if (status.isLoading) return null; // brief; auth.me is fast/local
  if (status.data?.required && !status.data.authed) return <LoginScreen />;
  return <>{children}</>;
}

function App() {
  const [queryClient] = useState(makeQueryClient);
  const [trpcClient] = useState(() =>
    createTRPCClient<AppRouter>({
      links: [
        splitLink({
          condition: (op) => op.type === "subscription",
          true: httpSubscriptionLink({ url: "/trpc" }),
          false: httpBatchLink({ url: "/trpc" }),
        }),
      ],
    }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <ThemeProvider>
          <AuthGate>
            <LiveProvider>
              <RouterProvider router={router} />
            </LiveProvider>
          </AuthGate>
          <ThemedToaster />
        </ThemeProvider>
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
