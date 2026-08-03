import { execFile as execFileCallback } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Proxy as ProxyConfig } from "@submerge/shared";
import { afterEach, expect, it } from "vitest";
import {
  buildMultiConfig,
  type ChannelConfigInput,
  DOMAIN_VALIDATION_LISTENER_NAME,
  DOMAIN_VALIDATION_USERNAME,
} from "../nodes/multiConfig.js";

const runIntegration = process.env.MIHOMO_INTEGRATION === "1";
const execFile = promisify(execFileCallback);
const suffix = `${process.pid}-${Date.now()}`;
const networkName = `submerge-domain-validation-${suffix}`;
const targetName = `submerge-domain-target-${suffix}`;
const upstreamName = `submerge-domain-upstream-${suffix}`;
const mihomoName = `submerge-domain-core-${suffix}`;
const createdContainers: string[] = [];
let networkCreated = false;
let runtimeDir: string | null = null;

async function docker(...args: string[]): Promise<string> {
  const { stdout } = await execFile("docker", args, {
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 256 * 1024,
  });
  return stdout.trim();
}

async function removeResources(): Promise<void> {
  for (const name of createdContainers.reverse()) {
    await docker("rm", "-f", name).catch(() => undefined);
  }
  if (networkCreated) await docker("network", "rm", networkName).catch(() => undefined);
  if (runtimeDir) rmSync(runtimeDir, { recursive: true, force: true });
  createdContainers.length = 0;
  networkCreated = false;
  runtimeDir = null;
}

afterEach(async () => {
  if (runIntegration) await removeResources();
});

function mappedPort(raw: string): number {
  const match = raw.match(/:(\d+)$/u);
  if (!match?.[1]) throw new Error("Docker did not publish an integration port");
  return Number(match[1]);
}

async function waitForController(port: number, secret: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/version`, {
        headers: { Authorization: `Bearer ${secret}` },
      });
      if (response.ok) return;
    } catch {
      // The container is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("isolated Mihomo controller did not become ready");
}

async function containerIpv4(name: string): Promise<string> {
  const address = await docker(
    "inspect",
    "--format",
    `{{with index .NetworkSettings.Networks "${networkName}"}}{{.IPAddress}}{{end}}`,
    name,
  );
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(address)) {
    throw new Error("Docker did not assign an integration IPv4 address");
  }
  return address;
}

async function openConnect(
  port: number,
  targetAddress: string,
  authorization: string | null,
  attempt: "missing-auth" | "bad-auth" | "valid-auth",
): Promise<{ statusLine: string; socket: import("node:net").Socket }> {
  const { connect } = await import("node:net");
  return await new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let response = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`integration CONNECT timed out (${attempt})`));
    }, 5_000);
    timer.unref();
    socket.once("connect", () => {
      socket.write(
        [
          `CONNECT ${targetAddress}:8443 HTTP/1.1`,
          `Host: ${targetAddress}:8443`,
          ...(authorization ? [`Proxy-Authorization: ${authorization}`] : []),
          "",
          "",
        ].join("\r\n"),
      );
    });
    socket.on("data", (chunk) => {
      response += chunk.toString("latin1");
      if (!response.includes("\r\n\r\n")) return;
      clearTimeout(timer);
      socket.removeAllListeners("data");
      resolve({ statusLine: response.split("\r\n", 1)[0] ?? "", socket });
    });
    socket.once("end", () => {
      clearTimeout(timer);
      reject(new Error(`integration CONNECT closed before headers (${attempt})`));
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitForForcedConnection(
  controllerPort: number,
  secret: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const response = await fetch(`http://127.0.0.1:${controllerPort}/connections`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    if (!response.ok) throw new Error("isolated Mihomo /connections failed");
    const payload = (await response.json()) as { connections?: Array<Record<string, unknown>> };
    const match = payload.connections?.find((connection) => {
      const metadata = connection.metadata as Record<string, unknown> | undefined;
      return metadata?.inboundName === DOMAIN_VALIDATION_LISTENER_NAME;
    });
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("forced listener connection did not appear in Mihomo metadata");
}

it.runIf(runIntegration)(
  "proves generated listener authentication and route identity against real Mihomo",
  async () => {
    runtimeDir = mkdtempSync(join(tmpdir(), "submerge-domain-integration-"));
    const mainDir = join(runtimeDir, "main");
    const upstreamDir = join(runtimeDir, "upstream");
    mkdirSync(mainDir);
    mkdirSync(upstreamDir);

    const controllerSecret = "integration-controller-secret";
    const listenerPassword = "integration-domain-validation-password-0001";
    writeFileSync(
      join(upstreamDir, "config.yaml"),
      [
        "mixed-port: 1080",
        "allow-lan: true",
        'bind-address: "*"',
        "mode: rule",
        "log-level: silent",
        "rules:",
        "  - MATCH,DIRECT",
        "",
      ].join("\n"),
      "utf8",
    );

    await docker("network", "create", networkName);
    networkCreated = true;
    await docker(
      "run",
      "-d",
      "--pull=never",
      "--name",
      targetName,
      "--network",
      networkName,
      "alpine:latest",
      "sh",
      "-c",
      "while true; do tail -f /dev/null | nc -l -p 8443 >/dev/null; done",
    );
    createdContainers.push(targetName);
    await docker(
      "run",
      "-d",
      "--pull=never",
      "--name",
      upstreamName,
      "--network",
      networkName,
      "-v",
      `${upstreamDir}:/root/.config/mihomo`,
      "metacubex/mihomo:latest",
      "-d",
      "/root/.config/mihomo",
    );
    createdContainers.push(upstreamName);

    const targetAddress = await containerIpv4(targetName);
    const upstreamAddress = await containerIpv4(upstreamName);
    const proxy: ProxyConfig = {
      name: "integration-exit",
      type: "socks5",
      server: upstreamAddress,
      port: 1080,
    };
    const channel: ChannelConfigInput = {
      target: "proxy",
      id: "integration-custom-channel",
      groupName: "CUSTOM",
      isDefault: true,
      policy: {
        kind: "sticky",
        testUrl: "https://example.com/generate_204",
        intervalSec: 60,
        failureThreshold: 3,
        maxHoldHours: null,
        initialCriterion: "fastest",
      },
      domains: [],
      cidrs: [],
      proxies: [proxy],
    };
    writeFileSync(
      join(mainDir, "config.yaml"),
      buildMultiConfig([channel], controllerSecret, {
        listen: "0.0.0.0",
        port: 7891,
        password: listenerPassword,
        targetGroupName: "CUSTOM",
      }),
      "utf8",
    );
    await docker(
      "run",
      "-d",
      "--pull=never",
      "--name",
      mihomoName,
      "--network",
      networkName,
      "-p",
      "127.0.0.1::7891",
      "-p",
      "127.0.0.1::9090",
      "-v",
      `${mainDir}:/root/.config/mihomo`,
      "metacubex/mihomo:latest",
      "-d",
      "/root/.config/mihomo",
    );
    createdContainers.push(mihomoName);

    const listenerPort = mappedPort(await docker("port", mihomoName, "7891/tcp"));
    const controllerPort = mappedPort(await docker("port", mihomoName, "9090/tcp"));
    await waitForController(controllerPort, controllerSecret);

    const missing = await openConnect(listenerPort, targetAddress, null, "missing-auth");
    expect(missing.statusLine).toMatch(/^HTTP\/1\.1 407\b/u);
    missing.socket.destroy();

    const rejected = await openConnect(
      listenerPort,
      targetAddress,
      `Basic ${Buffer.from(`${DOMAIN_VALIDATION_USERNAME}:wrong-password`).toString("base64")}`,
      "bad-auth",
    );
    expect(rejected.statusLine).toMatch(/^HTTP\/1\.1 403\b/u);
    rejected.socket.destroy();

    const accepted = await openConnect(
      listenerPort,
      targetAddress,
      `Basic ${Buffer.from(`${DOMAIN_VALIDATION_USERNAME}:${listenerPassword}`).toString("base64")}`,
      "valid-auth",
    );
    expect(accepted.statusLine).toMatch(/^HTTP\/1\.1 200\b/u);

    const connection = await waitForForcedConnection(controllerPort, controllerSecret);
    expect(connection.metadata).toMatchObject({
      inboundName: DOMAIN_VALIDATION_LISTENER_NAME,
      inboundUser: DOMAIN_VALIDATION_USERNAME,
      inboundPort: "7891",
      destinationIP: targetAddress,
      destinationPort: "8443",
    });
    expect(connection.chains).toEqual(expect.arrayContaining(["integration-exit", "CUSTOM"]));
    accepted.socket.destroy();
  },
  30_000,
);
