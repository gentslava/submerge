import { createSocket } from "node:dgram";
import { createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { env } from "../config/env.js";
import { parseDnsAResponse, probeDnsListener, probeMihomoDnsListener } from "./gateway-network.js";

const previousApi = env.MIHOMO_API;
afterEach(() => {
  env.MIHOMO_API = previousApi;
});

function answer(query: Buffer): Buffer {
  const header = Buffer.from(query.subarray(0, 12));
  header.writeUInt16BE(0x8180, 2);
  header.writeUInt16BE(1, 6);
  return Buffer.concat([
    header,
    query.subarray(12),
    Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 1, 0, 4, 198, 19, 0, 5]),
  ]);
}

describe("gateway DNS listener probes", () => {
  it("rejects a failed controller lookup without throwing from a socket callback", async () => {
    env.MIHOMO_API = "http://missing.invalid:9090";
    await expect(probeMihomoDnsListener("0.0.0.0", 1053, "udp")).rejects.toThrow();
  });

  it("probes the controller host rather than the app loopback for engine DNS", async () => {
    const host = Object.values(networkInterfaces())
      .flatMap((entries) => entries ?? [])
      .find((entry) => entry.family === "IPv4" && !entry.internal)?.address;
    if (!host) throw new Error("No non-loopback IPv4 interface for DNS fixture");
    const udp = createSocket("udp4");
    udp.on("message", (data, remote) => udp.send(answer(data), remote.port, remote.address));
    await new Promise<void>((resolve, reject) => {
      udp.once("error", reject);
      udp.bind(0, host, resolve);
    });
    const port = udp.address().port;
    try {
      for (const controller of [`http://${host}:9090`, `http://[::ffff:${host}]:9090`]) {
        env.MIHOMO_API = controller;
        expect(await probeMihomoDnsListener("127.0.0.1", port, "udp")).toEqual(["198.19.0.5"]);
        expect(await probeMihomoDnsListener("0.0.0.0", port, "udp")).toEqual(["198.19.0.5"]);
      }
      env.MIHOMO_API = "http://unreachable.invalid:9090";
      expect(await probeMihomoDnsListener(host, port, "udp")).toEqual(["198.19.0.5"]);
    } finally {
      udp.close();
    }
  });

  it.each([
    { host: "127.0.0.1", type: "udp4" },
    { host: "::1", type: "udp6" },
  ] as const)("checks UDP and TCP responses on the $host listener", async ({ host, type }) => {
    const tcp = createServer((socket) => {
      socket.on("data", (data) => {
        const response = answer(data.subarray(2));
        const prefix = Buffer.alloc(2);
        prefix.writeUInt16BE(response.length);
        socket.end(Buffer.concat([prefix, response]));
      });
    });
    await new Promise<void>((resolve) => tcp.listen(0, host, resolve));
    const address = tcp.address();
    if (!address || typeof address === "string") throw new Error("fixture");
    const udp = createSocket(type);
    udp.on("message", (data, remote) => udp.send(answer(data), remote.port, remote.address));
    await new Promise<void>((resolve) => udp.bind(address.port, host, resolve));
    try {
      expect(await probeDnsListener(host, address.port, "udp")).toEqual(["198.19.0.5"]);
      expect(await probeDnsListener(host, address.port, "tcp")).toEqual(["198.19.0.5"]);
      if (host === "::1") return;
      for (const controller of [
        "http://[::1]:9090",
        "http://localhost:9090",
        "http://[::ffff:127.0.0.1]:9090",
        "http://[::ffff:127.255.255.255]:9090",
      ]) {
        env.MIHOMO_API = controller;
        for (const protocol of ["udp", "tcp"] as const) {
          expect(await probeMihomoDnsListener("127.0.0.1", address.port, protocol)).toEqual([
            "198.19.0.5",
          ]);
          expect(await probeMihomoDnsListener("0.0.0.0", address.port, protocol)).toEqual([
            "198.19.0.5",
          ]);
        }
      }
    } finally {
      udp.close();
      await new Promise<void>((resolve) => tcp.close(() => resolve()));
    }
  });

  it("rejects malformed, mismatched and failed DNS responses", () => {
    expect(() => parseDnsAResponse(Buffer.alloc(1), 1)).toThrow();
    const failed = Buffer.alloc(12);
    failed.writeUInt16BE(1);
    failed.writeUInt16BE(0x8182, 2);
    expect(() => parseDnsAResponse(failed, 1)).toThrow();
    expect(() => parseDnsAResponse(failed, 2)).toThrow();
  });
});
