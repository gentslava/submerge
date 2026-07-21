import { db } from "../../db/client.js";
import { operationalLog } from "../../log.js";
import { SourceRefreshCoordinator } from "./refresh.js";
import { SourceRefreshScheduler } from "./scheduler.js";
import { refreshSource } from "./service.js";

export const sourceRefreshCoordinator = new SourceRefreshCoordinator({
  db,
  refresh: (sourceId) => refreshSource(db, sourceId),
  onFailure: (event) => operationalLog("source-refresh-failed", { ...event }),
});

export const sourceRefreshScheduler = new SourceRefreshScheduler({
  db,
  coordinator: sourceRefreshCoordinator,
  onError: () => operationalLog("source-refresh-scheduler-failed"),
});
