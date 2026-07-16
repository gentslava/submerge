import { z } from "zod";

export const diagnosticCheckStatusSchema = z.enum(["ok", "failed", "skipped"]);
export type DiagnosticCheckStatus = z.infer<typeof diagnosticCheckStatusSchema>;

export const diagnosticStateSchema = z.enum([
  "ready",
  "partial",
  "mihomo-down",
  "no-nodes",
  "no-internet",
  "external-ip-unavailable",
]);
export type DiagnosticState = z.infer<typeof diagnosticStateSchema>;

export const diagnosticErrorCodeSchema = z.enum([
  "timeout",
  "unreachable",
  "invalid-response",
  "http-error",
  "no-active-node",
  "no-proxy-nodes",
  "dependency-unavailable",
  "unknown",
]);
export type DiagnosticErrorCode = z.infer<typeof diagnosticErrorCodeSchema>;

export const diagnosticsRunInput = z.object({ force: z.boolean().default(false) }).strict();

const durationSchema = z.number().nonnegative();
const optionalDurationSchema = durationSchema.nullable();
const detailSchema = z.string().min(1).max(512);
const errorCodeSchema = diagnosticErrorCodeSchema.nullable();

const diagnosticComponentResultSchema = z
  .object({
    id: z.enum(["submerge", "mihomo", "happ-decoder"]),
    status: diagnosticCheckStatusSchema,
    durationMs: optionalDurationSchema,
    version: z.string().min(1).max(128).nullable(),
    detail: detailSchema,
    errorCode: errorCodeSchema,
  })
  .strict();

const diagnosticExternalIpResultSchema = z
  .object({
    status: diagnosticCheckStatusSchema,
    ip: z.union([z.ipv4(), z.ipv6()]).nullable(),
    country: z.string().min(1).max(32).nullable(),
    colo: z.string().min(1).max(32).nullable(),
    durationMs: optionalDurationSchema,
    route: z.string().min(1).max(256).nullable(),
    node: z.string().min(1).max(256).nullable(),
    detail: detailSchema,
    errorCode: errorCodeSchema,
  })
  .strict();

export const diagnosticRouteResultSchema = z
  .object({
    channelId: z.string().min(1).max(128),
    channelName: z.string().min(1).max(256),
    targetHost: z.string().min(1).max(253),
    node: z.string().min(1).max(256).nullable(),
    status: diagnosticCheckStatusSchema,
    durationMs: optionalDurationSchema,
    detail: detailSchema,
    errorCode: errorCodeSchema,
  })
  .strict();
export type DiagnosticRouteResult = z.infer<typeof diagnosticRouteResultSchema>;

export const diagnosticServiceResultSchema = z
  .object({
    id: z.enum(["google", "youtube", "telegram", "cloudflare", "chatgpt", "steam"]),
    label: z.string().min(1).max(64),
    status: diagnosticCheckStatusSchema,
    durationMs: optionalDurationSchema,
    httpStatus: z.number().int().min(100).max(599).nullable(),
    detail: detailSchema,
    errorCode: errorCodeSchema,
  })
  .strict();
export type DiagnosticServiceResult = z.infer<typeof diagnosticServiceResultSchema>;

const diagnosticRuntimeConfigSchema = z
  .object({
    status: diagnosticCheckStatusSchema,
    proxyEndpoint: z.string().min(1).max(2048),
    mode: z.string().min(1).max(64).nullable(),
    dns: z.boolean().nullable(),
    ipv6: z.boolean().nullable(),
    tun: z.boolean().nullable(),
    errorCode: errorCodeSchema,
  })
  .strict();

export const diagnosticsResultSchema = z
  .object({
    startedAt: z.iso.datetime(),
    completedAt: z.iso.datetime(),
    durationMs: durationSchema,
    state: diagnosticStateSchema,
    summary: z.string().min(1).max(512),
    components: z.array(diagnosticComponentResultSchema),
    externalIp: diagnosticExternalIpResultSchema,
    routes: z.array(diagnosticRouteResultSchema),
    services: z.array(diagnosticServiceResultSchema),
    config: diagnosticRuntimeConfigSchema,
  })
  .strict();
export type DiagnosticsResult = z.infer<typeof diagnosticsResultSchema>;
