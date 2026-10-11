import { z } from "zod";

export function isPublicResolverIp(value: string): boolean {
  if (!z.ipv4().safeParse(value).success) return false;
  const [a, b, c] = value.split(".").map(Number);
  return (
    a !== 0 &&
    a !== 10 &&
    a !== 127 &&
    !(a === 169 && b === 254) &&
    !(a === 172 && (b ?? 0) >= 16 && (b ?? 0) <= 31) &&
    !(a === 192 && (b === 168 || b === 0)) &&
    !(a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) &&
    !(a === 203 && b === 0 && c === 113) &&
    (a ?? 256) < 224 &&
    !(a === 100 && (b ?? 0) >= 64 && (b ?? 0) <= 127)
  );
}

export const localResolverSchema = z
  .string()
  .max(64)
  .refine((value) => {
    const parts = value.split(":");
    return (
      parts.length <= 2 &&
      z.ipv4().safeParse(parts[0]).success &&
      (parts.length === 1 ||
        (parts[1] !== undefined &&
          /^\d+$/u.test(parts[1]) &&
          Number(parts[1]) > 0 &&
          Number(parts[1]) <= 65535)) &&
      parts[0] !== "0.0.0.0" &&
      !parts[0]?.startsWith("127.") &&
      !parts[0]?.startsWith("198.18.") &&
      !parts[0]?.startsWith("198.19.")
    );
  }, "Use a separate LAN DNS IPv4 address, optionally with a port");

export const networkSettingsSchema = z.strictObject({
  mode: z.enum(["proxy", "tun"]).default("proxy"),
  localResolvers: z.array(localResolverSchema).max(8).default([]),
});
export type NetworkSettings = z.infer<typeof networkSettingsSchema>;
