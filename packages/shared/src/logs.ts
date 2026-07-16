import { z } from "zod";

export const logLevelSchema = z.enum(["debug", "info", "warning", "error"]);
export type LogLevel = z.infer<typeof logLevelSchema>;

export const logSourceSchema = z.enum(["mihomo", "submerge"]);
export type LogSource = z.infer<typeof logSourceSchema>;

export const logScalarSchema = z.union([z.string(), z.number(), z.boolean()]);

export const logUpstreamStateSchema = z.enum(["connecting", "live", "reconnecting"]);
export type LogUpstreamState = z.infer<typeof logUpstreamStateSchema>;

export const logEventSchema = z.object({
  id: z.number().int().positive(),
  time: z.iso.datetime(),
  source: logSourceSchema,
  level: logLevelSchema,
  message: z.string().min(1),
  fields: z.record(z.string(), logScalarSchema).optional(),
});
export type LogEvent = z.infer<typeof logEventSchema>;

function requireConsistentRetryState(
  value: { upstream: LogUpstreamState; nextRetryAt: string | null },
  ctx: z.RefinementCtx,
): void {
  const hasRetryAt = value.nextRetryAt !== null;
  if ((value.upstream === "reconnecting") !== hasRetryAt) {
    ctx.addIssue({
      code: "custom",
      path: ["nextRetryAt"],
      message: "nextRetryAt is required only while reconnecting",
    });
  }
}

const logSnapshotSchema = z
  .object({
    type: z.literal("snapshot"),
    cursor: z.number().int().nonnegative(),
    upstream: logUpstreamStateSchema,
    nextRetryAt: z.iso.datetime().nullable(),
    events: z.array(logEventSchema),
  })
  .superRefine(requireConsistentRetryState);

const logStatusSchema = z
  .object({
    type: z.literal("status"),
    cursor: z.number().int().positive(),
    upstream: logUpstreamStateSchema,
    nextRetryAt: z.iso.datetime().nullable(),
  })
  .superRefine(requireConsistentRetryState);

export const logStreamMessageSchema = z.discriminatedUnion("type", [
  logSnapshotSchema,
  z.object({
    type: z.literal("append"),
    cursor: z.number().int().positive(),
    event: logEventSchema,
  }),
  z.object({ type: z.literal("clear"), cursor: z.number().int().positive() }),
  logStatusSchema,
]);
export type LogStreamMessage = z.infer<typeof logStreamMessageSchema>;
