import { createRoute, createRouter } from "@tanstack/react-router";
import { MoreRoute } from "./more";
import { NodesRoute } from "./nodes";
import { rootRoute } from "./root";
import { SettingsRoute } from "./settings";
import { SourcesRoute } from "./sources";

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: NodesRoute,
});
const sourcesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sources",
  component: SourcesRoute,
});
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsRoute,
});
const moreRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/more",
  component: MoreRoute,
});

const routeTree = rootRoute.addChildren([indexRoute, sourcesRoute, settingsRoute, moreRoute]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
