import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Runtime data must belong to the server package, not to the caller's cwd. This
// matters for browser tooling, which starts commands from packages/web.
const serverRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const defaultDbPath = resolve(serverRoot, "data/submerge.db");

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().min(1).default("0.0.0.0"),
  DB_PATH: z.string().default(defaultDbPath),
  MIHOMO_API: z.url().default("http://mihomo:9090"),
  // mihomo's mixed (HTTP/SOCKS) proxy port, as the SERVER reaches it — used only by
  // the on-demand speed test to download a payload through a chosen node. Inside
  // compose the server talks to the mihomo service directly (not the host mapping).
  MIHOMO_PROXY: z.url().default("http://mihomo:7890"),
  MIHOMO_SECRET: z.string().default(""),
  HAPP_DECODER_URL: z.url().default("http://happ-decoder:8080"),
  // Local SOCKS/HTTP proxy address shown in the UI (editable in Settings). Default is the
  // host-published mihomo mixed-port; override per topology (e.g. mihomo:7890 inside compose).
  PROXY_ENDPOINT: z.string().default("127.0.0.1:7890"),
  ADMIN_PASSWORD: z.string().optional(),
  // "true"/"false" env string → boolean; absent defaults to false (z.stringbool handles "false"→false correctly, unlike z.coerce.boolean which coerces any non-empty string to true).
  COOKIE_SECURE: z.stringbool().default(false),
  // Where the server writes the generated mihomo config (shared volume in compose).
  MIHOMO_CONFIG_PATH: z.string().default("/mihomo/config.yaml"),
  // Path as mihomo sees it, sent in the reload body (PUT /configs).
  MIHOMO_CONFIG_TARGET: z.string().default("/root/.config/mihomo/config.yaml"),
  // Stable HWID is mirrored here so happ-decoder (unchanged) and the server agree.
  HWID_FILE: z.string().default("/mihomo/hwid.txt"),
  // Directory of the built web SPA to serve (dev default; container overrides to an absolute path).
  WEB_DIST: z.string().default("../web/dist"),
});

export type Env = z.infer<typeof envSchema>;

export function parseEnv(source: NodeJS.ProcessEnv | Record<string, string | undefined>): Env {
  return envSchema.parse(source);
}

export const env = parseEnv(process.env);
