import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { env } from "../config/env.js";
import { probeMihomoDnsListener } from "./gateway-network.js";
import { dnsAnswer } from "./gateway-network.test-support.js";

const { createSocketMock, connectMock } = vi.hoisted(() => ({
  createSocketMock: vi.fn(),
  connectMock: vi.fn(),
}));
vi.mock("node:dgram", () => ({ createSocket: createSocketMock }));
vi.mock("node:net", async (original) => ({
  ...(await original<typeof import("node:net")>()),
  connect: connectMock,
}));

const previousApi = env.MIHOMO_API;
afterEach(() => {
  env.MIHOMO_API = previousApi;
  vi.clearAllMocks();
});

it.each(["0.0.0.0", "127.0.0.1"])(
  "probes remote native IPv6 for the %s listener without host IPv6 support",
  async (listener) => {
    const socket = Object.assign(new EventEmitter(), {
      connect: vi.fn((_port: number, _host: string, callback: () => void) => callback()),
      send: vi.fn((packet: Buffer, callback: () => void) => {
        callback();
        socket.emit("message", dnsAnswer(packet));
      }),
      close: vi.fn(),
    });
    createSocketMock.mockReturnValue(socket);
    env.MIHOMO_API = "http://[2001:db8::1]:9090";

    await expect(probeMihomoDnsListener(listener, 1053, "udp")).resolves.toEqual(["198.19.0.5"]);
    expect(createSocketMock).toHaveBeenCalledWith("udp6");
    expect(socket.connect).toHaveBeenCalledWith(1053, "2001:db8::1", expect.any(Function));
    expect(socket.close).toHaveBeenCalledOnce();
    expect(connectMock).not.toHaveBeenCalled();
  },
);
