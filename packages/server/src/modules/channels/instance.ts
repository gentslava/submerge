import { selectProxy } from "../../clients/mihomo.js";
import { db } from "../../db/client.js";
import { testDelay } from "../nodes/service.js";
import { ChannelController } from "./controller.js";
import { DEFAULT_CHANNEL_ID, readDefaultChannel, setChannelLastReason } from "./service.js";

// The single controller for the Default channel (Phase 2). Deps bind it to the real
// db + mihomo client; testDelay maps a timeout/unreachable node to null so the
// sticky failure counter advances instead of throwing (covered in nodes/service tests).
export const channelController = new ChannelController({
  readChannel: () => readDefaultChannel(db),
  probe: testDelay,
  select: selectProxy,
  persistReason: (reason, at) => setChannelLastReason(db, DEFAULT_CHANNEL_ID, reason, at),
  now: () => Date.now(),
});
