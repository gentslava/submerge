// Isolated happ-decoder client: POST /decode {link, hwid}.
// The decoder runs the official Happ binary and injects X-Hwid via mitmproxy
// when hwid=true; we only forward the flag. Response is Zod-parsed.
import { z } from "zod";
import { env } from "../config/env.js";

const TIMEOUT_MS = 70_000; // Happ binary + Xvfb startup is slow

const decodeResponseSchema = z.object({
  ok: z.boolean(),
  url: z.string().optional(),
  body: z.string().optional(),
  error: z.string().optional(),
});
export type DecodeResponse = z.infer<typeof decodeResponseSchema>;

export async function decodeHapp(link: string, useHwid: boolean): Promise<DecodeResponse> {
  let r: Response;
  try {
    r = await fetch(`${env.HAPP_DECODER_URL}/decode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ link: link.trim(), hwid: !!useHwid }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`happ-decoder unreachable/timeout (${env.HAPP_DECODER_URL}): ${msg}`);
  }
  const parsed = decodeResponseSchema.safeParse(await r.json().catch(() => ({})));
  if (!parsed.success)
    throw new Error(`happ-decoder returned an unexpected response (HTTP ${r.status})`);
  const data = parsed.data;
  if (!r.ok || !data.ok) throw new Error(data.error || `happ-decoder returned HTTP ${r.status}`);
  return data;
}
