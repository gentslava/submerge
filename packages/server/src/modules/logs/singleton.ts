import { getConnections, openLogStream } from "../../clients/mihomo.js";
import { db } from "../../db/client.js";
import { log } from "../../log.js";
import { createDomainIntelligenceObserver } from "../domain-intelligence/instance.js";
import { DomainIntelligenceScheduler } from "../domain-intelligence/scheduler.js";
import { LogHub } from "./hub.js";

export const domainIntelligenceObserver = createDomainIntelligenceObserver(db, (err) => {
  log.warn({ err }, "domain observation persistence failed");
});
export const domainIntelligenceScheduler = new DomainIntelligenceScheduler({
  fetchConnections: getConnections,
  observer: domainIntelligenceObserver,
});

export const logHub = new LogHub({
  openLogStream,
  onMihomoFrame: (frame, observedAt) =>
    domainIntelligenceObserver.observeLogFrame(frame, observedAt),
  onMihomoFrameError: (err) => {
    log.warn({ err }, "domain observation hook failed");
  },
});
