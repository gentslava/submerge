import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DB_PATH: z.string().default("./data/submerge.db"),
  MIHOMO_API: z.string().default("http://mihomo:9090"),
  MIHOMO_SECRET: z.string().default(""),
  HAPP_DECODER_URL: z.string().default("http://happ-decoder:8080"),
  ADMIN_PASSWORD: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: NodeJS.ProcessEnv | Record<string, string | undefined>): Env {
  return envSchema.parse(source);
}

export const env = parseEnv(process.env);
