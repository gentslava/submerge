import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  DB_PATH: z.string().default("./data/submerge.db"),
  MIHOMO_API: z.url().default("http://mihomo:9090"),
  MIHOMO_SECRET: z.string().default(""),
  HAPP_DECODER_URL: z.url().default("http://happ-decoder:8080"),
  ADMIN_PASSWORD: z.string().optional(),
  // "true"/"false" env string → boolean; absent defaults to false (z.stringbool handles "false"→false correctly, unlike z.coerce.boolean which coerces any non-empty string to true).
  COOKIE_SECURE: z.stringbool().default(false),
  // Where the server writes the generated mihomo config (shared volume in compose).
  MIHOMO_CONFIG_PATH: z.string().default("/mihomo/config.yaml"),
  // Path as mihomo sees it, sent in the reload body (PUT /configs).
  MIHOMO_CONFIG_TARGET: z.string().default("/root/.config/mihomo/config.yaml"),
  // Stable HWID is mirrored here so happ-decoder (unchanged) and the server agree.
  HWID_FILE: z.string().default("/mihomo/hwid.txt"),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: NodeJS.ProcessEnv | Record<string, string | undefined>): Env {
  return envSchema.parse(source);
}

export const env = parseEnv(process.env);
