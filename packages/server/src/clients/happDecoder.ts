// Isolated happ-decoder client: POST /decode {link, hwid}.
// The decoder runs the official Happ binary and injects X-Hwid via mitmproxy
// when hwid=true; we only forward the flag. Response is Zod-parsed.
import { z } from "zod";
import { env } from "../config/env.js";

const TIMEOUT_MS = 70_000; // Happ binary + Xvfb startup is slow
const HEALTH_TIMEOUT_MS = 5000;

const decodeResponseSchema = z.object({
  ok: z.boolean(),
  url: z.string().optional(),
  body: z.string().optional(),
  error: z.string().optional(),
});
export type DecodeResponse = z.infer<typeof decodeResponseSchema>;

const healthResponseSchema = z.object({ ok: z.literal(true) });

export async function healthHapp(signal?: AbortSignal): Promise<{ ok: true }> {
  const timeout = AbortSignal.timeout(HEALTH_TIMEOUT_MS);
  const boundedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(`${env.HAPP_DECODER_URL}/health`, {
      method: "GET",
      signal: boundedSignal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`happ-decoder health check unreachable/timeout (${env.HAPP_DECODER_URL})`, {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new Error(`happ-decoder health check returned HTTP ${response.status}`);
  }
  const parsed = healthResponseSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new Error("happ-decoder health check returned an invalid response");
  return parsed.data;
}

export async function decodeHapp(link: string, useHwid: boolean): Promise<DecodeResponse> {
  let r: Response;
  try {
    r = await fetch(`${env.HAPP_DECODER_URL}/decode`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ link: link.trim(), hwid: useHwid }),
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
