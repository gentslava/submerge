import { clearFixedSelection, getProxies, selectProxy } from "../../clients/mihomo.js";
import { db } from "../../db/client.js";
import { testDelay } from "../nodes/service.js";
import { ControllerRegistry } from "./registry.js";
import { listChannels, setChannelLastReason } from "./service.js";

// The multi-channel registry (Phase 3a): one ChannelController per channel, ticked
// every poll. Deps bind it to the real db + mihomo client; testDelay maps a
// timeout/unreachable node to null so the sticky failure counter advances instead
// of throwing (covered in nodes/service tests).
export const registry = new ControllerRegistry({
  listChannels: () => listChannels(db),
  fetchProxies: getProxies,
  probe: testDelay,
  select: selectProxy,
  clearFixed: clearFixedSelection,
  persistReason: (id, reason, at) => setChannelLastReason(db, id, reason, at),
  now: () => Date.now(),
});
