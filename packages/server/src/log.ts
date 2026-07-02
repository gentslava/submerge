import pino from "pino";

// Single process-wide logger. Import from here instead of creating new pino
// instances so name/config stay consistent across modules.
export const log = pino({ name: "submerge" });
