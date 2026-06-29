import { z } from "zod";

export const sourceKindSchema = z.enum(["sub", "vless", "happ"]);
export type SourceKind = z.infer<typeof sourceKindSchema>;

// mihomo-proxy: фиксируем обязательное ядро, остальное passthrough
// Zod 4: z.looseObject() вместо z.object().passthrough() / .loose()
export const proxySchema = z.looseObject({
  name: z.string(),
  type: z.string(),
  server: z.string(),
  port: z.number(),
  uuid: z.string().optional(),
});
export type Proxy = z.infer<typeof proxySchema>;

export const sourceSchema = z.object({
  id: z.number().int(),
  kind: sourceKindSchema,
  value: z.string(),
  label: z.string(),
  hwid: z.boolean(),
  enabled: z.boolean(),
  sortOrder: z.number().int(),
  proxies: z.array(proxySchema),
  updatedAt: z.string(),
  createdAt: z.string(),
});
export type Source = z.infer<typeof sourceSchema>;

export const addSourceInput = z.object({
  value: z.string().min(1),
  hwid: z.boolean().default(false),
});
export type AddSourceInput = z.infer<typeof addSourceInput>;
