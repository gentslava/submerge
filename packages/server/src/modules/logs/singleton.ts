import { openLogStream } from "../../clients/mihomo.js";
import { LogHub } from "./hub.js";

export const logHub = new LogHub({ openLogStream });
