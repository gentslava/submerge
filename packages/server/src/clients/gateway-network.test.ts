import { createSocket } from "node:dgram";
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { parseDnsAResponse, probeDnsListener } from "./gateway-network.js";

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
  it("checks both UDP and TCP responses on the actual listener", async () => {
    const tcp = createServer((socket) => {
      socket.on("data", (data) => {
        const response = answer(data.subarray(2));
        const prefix = Buffer.alloc(2);
        prefix.writeUInt16BE(response.length);
        socket.end(Buffer.concat([prefix, response]));
      });
    });
    await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", resolve));
    const address = tcp.address();
    if (!address || typeof address === "string") throw new Error("fixture");
    const udp = createSocket("udp4");
    udp.on("message", (data, remote) => udp.send(answer(data), remote.port, remote.address));
    await new Promise<void>((resolve) => udp.bind(address.port, "127.0.0.1", resolve));
    try {
      expect(await probeDnsListener("127.0.0.1", address.port, "udp")).toEqual(["198.19.0.5"]);
      expect(await probeDnsListener("127.0.0.1", address.port, "tcp")).toEqual(["198.19.0.5"]);
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
