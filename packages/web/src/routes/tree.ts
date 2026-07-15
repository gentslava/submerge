import { createRoute, createRouter } from "@tanstack/react-router";
import { ConnectionsRoute } from "./connections";
import { MoreRoute } from "./more";
import { NodesRoute } from "./nodes";
import { rootRoute } from "./root";
import { RoutingRoute } from "./routing";
import { SettingsRoute } from "./settings";
import { SourcesRoute } from "./sources";
import { TrafficRoute } from "./traffic";

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
const connectionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/connections",
  component: ConnectionsRoute,
});
const routingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/routing",
  component: RoutingRoute,
});
const trafficRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/traffic",
  component: TrafficRoute,
});
const moreRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/more",
  component: MoreRoute,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  trafficRoute,
  sourcesRoute,
  connectionsRoute,
  routingRoute,
  settingsRoute,
  moreRoute,
]);

export const router = createRouter({ routeTree, defaultPreload: "intent" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
