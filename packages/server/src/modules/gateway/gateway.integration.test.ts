import { execFile as execFileCallback } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { networkProfileSchema } from "@submerge/shared";
import * as yaml from "js-yaml";
import { expect, it } from "vitest";
import {
  getRuleProviders,
  getRules,
  getRuntimeConfig,
  reloadConfig,
  setMihomoSecret,
} from "../../clients/mihomo.js";
import { env } from "../../config/env.js";
import { buildMultiConfig, type ChannelConfigInput } from "../nodes/multiConfig.js";
import { assertPrivateProvidersLoaded } from "./settings.js";

const execFile = promisify(execFileCallback);
const enabled = process.env.GATEWAY_INTEGRATION === "1";
const appImage = process.env.GATEWAY_TEST_IMAGE ?? "submerge-gateway:verify";
async function docker(...args: string[]): Promise<string> {
  const { stdout } = await execFile("docker", args, {
    timeout: 20000,
    maxBuffer: 262144,
  });
  return stdout.trim();
}
async function eventually<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 15000,
): Promise<T> {
  const end = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < end) {
    try {
      const result = await read();
      if (predicate(result)) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Gateway integration condition timed out", { cause: lastError });
}

// Deliberately synthetic endpoints: DIRECT and VPN return different bodies,
// so a successful HTTP response cannot accidentally count as correct routing.
const fixtureScript = `import socket, socketserver, struct, threading, sys
IP = socket.gethostbyname(socket.gethostname())
def audit_syn():
    sock=socket.socket(socket.AF_PACKET,socket.SOCK_RAW,socket.htons(3))
    while True:
        packet=sock.recv(65535)
        if len(packet)<42 or packet[12:14]!=b'\\x08\\x00' or packet[23] not in (6,17): continue
        start=14+(packet[14]&15)*4
        if len(packet)>start+4 and struct.unpack('!H',packet[start+2:start+4])[0]==8081 and (packet[23]==17 or (len(packet)>start+13 and packet[start+13]&2)):
            print('SOURCE:'+socket.inet_ntoa(packet[26:30]),flush=True)
if sys.argv[1]=='proxy': threading.Thread(target=audit_syn,daemon=True).start()
def dns_response(data):
    pos=12; labels=[]
    while data[pos]:
        n=data[pos]; pos+=1; labels.append(data[pos:pos+n].decode()); pos+=n
    pos+=5; name='.'.join(labels)
    if name.startswith('submerge-gateway-readiness.') and name.endswith('.example.com'):
        return data[:2]+struct.pack('!HHHHH',0x8183,1,0,0,0)+data[12:pos]
    address='93.184.215.14' if name=='example.com' else IP
    return data[:2]+struct.pack('!HHHHH',0x8180,1,1,0,0)+data[12:pos]+b'\\xc0\\x0c'+struct.pack('!HHIH',1,1,60,4)+socket.inet_aton(address)
class UDP(socketserver.BaseRequestHandler):
    def handle(self):
        data,sock=self.request; sock.sendto(dns_response(data),self.client_address)
class TCPDNS(socketserver.BaseRequestHandler):
    def handle(self):
        data=self.request.recv(4096); response=dns_response(data[2:]); self.request.sendall(struct.pack('!H',len(response))+response)
class HTTP(socketserver.BaseRequestHandler):
    def handle(self):
        data=self.request.recv(8192)
        if data.startswith(b'CONNECT '):
            self.request.sendall(b'HTTP/1.1 200 Connection established\\r\\n\\r\\n'); data=self.request.recv(8192)
        body=b'PROXY' if sys.argv[1]=='proxy' else b'DIRECT'
        self.request.sendall(b'HTTP/1.1 200 OK\\r\\nContent-Length: '+str(len(body)).encode()+b'\\r\\nConnection: close\\r\\n\\r\\n'+body)
socketserver.TCPServer.allow_reuse_address=True
if sys.argv[1]=='proxy': servers=[socketserver.ThreadingTCPServer(('0.0.0.0',8081),HTTP)]
else: servers=[socketserver.ThreadingTCPServer(('0.0.0.0',80),HTTP),socketserver.ThreadingUDPServer(('0.0.0.0',53),UDP),socketserver.ThreadingTCPServer(('0.0.0.0',53),TCPDNS)]
for server in servers: threading.Thread(target=server.serve_forever,daemon=True).start()
threading.Event().wait()
`;

it.skipIf(!enabled)(
  "routes fake-IP through isolated Linux TUN and refreshes mounted providers",
  async () => {
    const suffix = `${process.pid}-${Date.now()}`;
    const wan = `sm-gw-wan-${suffix}`;
    const lan = `sm-gw-lan-${suffix}`;
    const core = `sm-gw-core-${suffix}`;
    const namespace = `sm-gw-namespace-${suffix}`;
    const target = `sm-gw-target-${suffix}`;
    const proxy = `sm-gw-proxy-${suffix}`;
    const client = `sm-gw-client-${suffix}`;
    const containers: string[] = [];
    const networks: string[] = [];
    const directory = mkdtempSync(join(tmpdir(), "submerge-gateway-native-"));
    const configDir = join(directory, "mihomo");
    const listsDir = join(configDir, "private-lists");
    const previousApi = env.MIHOMO_API;
    try {
      mkdirSync(listsDir, { recursive: true });
      writeFileSync(join(directory, "fixture.py"), fixtureScript);
      writeFileSync(join(listsDir, "notblocked.txt"), "+.direct.ru\n");
      writeFileSync(join(listsDir, "proxy.txt"), "+.forced.ru\n");
      await docker("network", "create", wan);
      networks.push(wan);
      // Docker internal bridges drop off-subnet frames before the container router.
      await docker(
        "network",
        "create",
        "--opt",
        "com.docker.network.bridge.enable_ip_masquerade=false",
        lan,
      );
      networks.push(lan);
      for (const [name, network, role] of [
        [target, lan, "direct"],
        [proxy, wan, "proxy"],
      ]) {
        if (!name || !network || !role) throw new Error("fixture");
        await docker(
          "run",
          "-d",
          "--name",
          name,
          "--network",
          network,
          "-v",
          `${directory}:/fixture:ro`,
          "python:3.12-slim",
          "python",
          "/fixture/fixture.py",
          role,
        );
        containers.push(name);
      }
      const ipOf = (name: string, network: string) =>
        docker(
          "inspect",
          "--format",
          `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`,
          name,
        );
      const localIp = await ipOf(target, lan);
      const proxyIp = await ipOf(proxy, wan);
      const profile = networkProfileSchema.parse({
        profile: "gateway",
        localResolvers: [localIp],
        lanInterface: "lan0",
        ruGeosite: [],
        ruGeoip: [],
        ruZones: ["ru"],
        privateLists: [
          { name: "notblocked", file: "notblocked.txt", target: "notblocked" },
          { name: "proxy", file: "proxy.txt", target: "proxy" },
        ],
      });
      if (profile.profile !== "gateway") throw new Error("gateway fixture");
      const channels: ChannelConfigInput[] = [
        {
          id: "default",
          isDefault: true,
          target: "proxy",
          groupName: "AUTO",
          domains: [],
          cidrs: [],
          policy: { kind: "manual", pinnedNode: "vpn", onFailure: "hold" },
          proxies: [{ name: "vpn", type: "http", server: proxyIp, port: 8081 }],
        },
      ];
      const secret = "gateway-native-test-secret";
      const fixtureConfig = (input: ChannelConfigInput[], apiSecret = secret) => {
        const document = yaml.load(
          buildMultiConfig(input, apiSecret, undefined, undefined, profile),
        ) as Record<string, unknown>;
        // Only the isolated test substitutes deterministic upstream answers.
        // The production profile rejects LAN resolvers for public upstreams.
        const dns = document.dns as Record<string, unknown>;
        dns.nameserver = [localIp];
        dns["direct-nameserver"] = [localIp];
        return yaml.dump(document);
      };
      const config = fixtureConfig(channels);
      writeFileSync(join(configDir, "config.yaml"), config);
      const composePath = join(directory, "compose.yml");
      const production = yaml.load(
        readFileSync(new URL("../../../../../docker-compose.gateway.yml", import.meta.url), "utf8"),
      ) as { services: Record<string, { healthcheck: unknown }> };
      writeFileSync(
        composePath,
        yaml.dump({
          services: {
            namespace: {
              image: appImage,
              container_name: namespace,
              user: "0:0",
              command: ["node", "dist/gateway-network.js"],
              cap_add: ["NET_ADMIN"],
              healthcheck: production.services["gateway-network"]?.healthcheck,
              sysctls: { "net.ipv4.ip_forward": "0", "net.ipv6.conf.all.disable_ipv6": "1" },
              ports: ["127.0.0.1::9090"],
              networks: {
                wan: { interface_name: "eth0", gw_priority: 1, aliases: ["mihomo"] },
                lan: { interface_name: "lan0" },
              },
            },
            mihomo: {
              image: "metacubex/mihomo:latest",
              container_name: core,
              cap_add: ["NET_ADMIN"],
              devices: ["/dev/net/tun:/dev/net/tun"],
              network_mode: "service:namespace",
              sysctls: { "net.ipv4.ip_forward": "1" },
              depends_on: { namespace: { condition: "service_healthy" } },
              volumes: [
                `${configDir}:/root/.config/mihomo`,
                `${listsDir}:/root/.config/mihomo/private-lists:ro`,
              ],
            },
          },
          networks: { wan: { external: true, name: wan }, lan: { external: true, name: lan } },
        }),
      );
      containers.push(namespace, core);
      await docker("compose", "-p", `sm-gw-${suffix}`, "-f", composePath, "up", "-d");
      const gatewayIp = await ipOf(namespace, lan);
      const mapping = await docker("port", namespace, "9090/tcp");
      const port = mapping.match(/:(\d+)$/u)?.[1];
      if (!port) throw new Error("controller mapping");
      env.MIHOMO_API = `http://127.0.0.1:${port}`;
      setMihomoSecret(secret);
      await eventually(getRuntimeConfig, (state) => state.tun === true);
      expect((await getRules()).rules.at(-1)?.proxy).toBe("AUTO");
      const loaded = await getRuleProviders();
      expect(loaded.providers["gateway-notblocked"]?.ruleCount).toBe(1);
      expect(loaded.providers["gateway-notblocked"]?.vehicleType).toBe("File");
      assertPrivateProvidersLoaded(
        profile,
        { "gateway-notblocked": 1, "gateway-proxy": 1 },
        loaded,
      );
      const interfaces = await docker(
        "run",
        "--rm",
        "--network",
        `container:${core}`,
        appImage,
        "node",
        "--input-type=module",
        "-e",
        "import {networkInterfaces} from 'node:os'; console.log(JSON.stringify(networkInterfaces()));",
      );
      expect(interfaces).toContain("sm-gateway");
      expect(interfaces).toContain("198.19.");
      await docker(
        "run",
        "-d",
        "--name",
        client,
        "--network",
        lan,
        "--cap-add",
        "NET_ADMIN",
        "alpine:latest",
        "sleep",
        "300",
      );
      containers.push(client);
      await docker("exec", client, "ip", "route", "replace", "default", "via", gatewayIp);
      expect(
        await docker(
          "exec",
          "-e",
          `http_proxy=http://${gatewayIp}:7890`,
          client,
          "wget",
          "-qO-",
          "-T",
          "3",
          "http://nas.lan/",
        ),
      ).toBe("DIRECT");
      const lookup = async (domain: string) =>
        docker(
          "run",
          "--rm",
          "--network",
          `container:${core}`,
          appImage,
          "node",
          "--input-type=module",
          "-e",
          `import {Resolver} from 'node:dns/promises'; const r=new Resolver({timeout:2000,tries:1}); r.setServers(['127.0.0.1:1053']); console.log((await r.resolve4(${JSON.stringify(domain)}))[0]);`,
        );
      const request = async (domain: string) => {
        const ip = await lookup(domain);
        return docker(
          "exec",
          client,
          "wget",
          "-qO-",
          "-T",
          "3",
          "--header",
          `Host: ${domain}`,
          `http://${ip}/`,
        );
      };
      expect(await lookup("nas.lan")).toBe(localIp);
      const interceptedDns = await docker(
        "run",
        "--rm",
        "--network",
        `container:${client}`,
        appImage,
        "node",
        "--input-type=module",
        "-e",
        "import {Resolver} from 'node:dns/promises'; const r=new Resolver({timeout:2000,tries:1}); r.setServers(['8.8.8.8']); console.log((await r.resolve4('foreign.test'))[0]);",
      );
      expect(interceptedDns).toMatch(/^198\.19\./u);
      await docker(
        "run",
        "--rm",
        "--network",
        `container:${core}`,
        "-e",
        `MIHOMO_SECRET=${secret}`,
        appImage,
        "node",
        "--input-type=module",
        "-e",
        `import {assertGatewayNetworkActivated} from './dist/modules/gateway/readiness.js'; await assertGatewayNetworkActivated(${JSON.stringify(profile)});`,
      );
      expect(await request("direct.ru")).toBe("DIRECT");
      expect(await request("forced.ru")).toBe("PROXY");
      expect(await request("company.ru")).toBe("DIRECT");
      expect(await request("foreign.test")).toBe("PROXY");
      await docker("pause", proxy);
      await expect(request("foreign.test")).rejects.toThrow();
      await docker("unpause", proxy);
      expect(await request("foreign.test")).toBe("PROXY");
      expect(await docker("exec", client, "wget", "-qO-", "-T", "3", "http://198.51.100.80/")).toBe(
        "PROXY",
      );
      const replaceList = (value: string) => {
        const path = join(listsDir, "notblocked.txt");
        writeFileSync(`${path}.next`, value);
        renameSync(`${path}.next`, path);
      };
      replaceList("+.foreign.test\n+.docs.google.test\n");
      await eventually(
        () => request("foreign.test"),
        (body) => body === "DIRECT",
      );
      expect(await request("docs.google.test")).toBe("DIRECT");
      expect(await request("mail.google.test")).toBe("PROXY");
      replaceList("+.direct.ru\n");
      await eventually(
        () => request("foreign.test"),
        (body) => body === "PROXY",
      );
      await expect(reloadConfig("", "rules: [INVALID,RULE]\n")).rejects.toThrow();
      expect(await request("foreign.test")).toBe("PROXY");
      const dnsReadiness = async () =>
        JSON.parse(
          await docker(
            "run",
            "--rm",
            "--network",
            `container:${core}`,
            "-e",
            `MIHOMO_SECRET=${secret}`,
            appImage,
            "node",
            "--input-type=module",
            "-e",
            `import {checkGatewayReadiness,gatewayReadinessDeps} from './dist/modules/gateway/readiness.js'; import {queryRealDns} from './dist/clients/mihomo.js'; const result=await checkGatewayReadiness(${JSON.stringify(profile)},'applied','AUTO',{...gatewayReadinessDeps,files:()=>({'gateway-notblocked':1,'gateway-proxy':1}),vpnProbe:async()=>42}); console.log(JSON.stringify({checks:result.checks.filter(c=>['local-dns','dns-upstream'].includes(c.name)),cached:await queryRealDns('example.com')}));`,
          ),
        ) as { checks: Array<{ name: string; ok: boolean }>; cached: string[] };
      expect((await dnsReadiness()).checks.every((check) => check.ok)).toBe(true);
      await docker("pause", target);
      let dnsOutage: Awaited<ReturnType<typeof dnsReadiness>>;
      try {
        dnsOutage = await dnsReadiness();
      } finally {
        await docker("unpause", target);
      }
      // The real API still returns its warmed answer while both fresh public
      // and local queries must expose the actual resolver outage.
      expect(dnsOutage.cached).toEqual(["93.184.215.14"]);
      expect(dnsOutage.checks.every((check) => !check.ok)).toBe(true);
      const empty = channels.map((channel) =>
        channel.target === "proxy" ? { ...channel, proxies: [] } : channel,
      );
      await reloadConfig("", fixtureConfig(empty));
      await expect(request("foreign.test")).rejects.toThrow();
      expect(await request("direct.ru")).toBe("DIRECT");
      // Control-plane downloads must bootstrap even with no VPN nodes. This is
      // an unbound socket from the real app uid, not a Mihomo DIRECT adapter.
      expect(
        await docker(
          "run",
          "--rm",
          "--network",
          `container:${core}`,
          appImage,
          "node",
          "--input-type=module",
          "-e",
          "const response=await fetch('https://1.1.1.1/cdn-cgi/trace',{signal:AbortSignal.timeout(8000)}); if(!response.ok) throw new Error('Service fetch failed'); console.log('ok');",
        ),
      ).toBe("ok");
      const rotatedSecret = "gateway-native-rotated-secret";
      const rotated = fixtureConfig(channels, rotatedSecret);
      await reloadConfig("", rotated);
      // Native reload retains the old API credential until process restart.
      await expect(getRuntimeConfig()).resolves.toMatchObject({ tun: true });
      writeFileSync(join(configDir, "config.yaml"), rotated);
      await docker("restart", core);
      const restartedPort = (await docker("port", namespace, "9090/tcp")).match(/:(\d+)$/u)?.[1];
      if (!restartedPort) throw new Error("restarted controller mapping");
      env.MIHOMO_API = `http://127.0.0.1:${restartedPort}`;
      setMihomoSecret(rotatedSecret);
      await eventually(getRuntimeConfig, (state) => state.tun === true);
      expect(await request("foreign.test")).toBe("PROXY");
      const withoutTun = yaml.load(rotated) as { tun: { enable: boolean } };
      withoutTun.tun.enable = false;
      await reloadConfig("", yaml.dump(withoutTun));
      await expect(
        docker(
          "run",
          "--rm",
          "--network",
          `container:${core}`,
          "-e",
          `MIHOMO_SECRET=${rotatedSecret}`,
          appImage,
          "node",
          "--input-type=module",
          "-e",
          `import {assertGatewayNetworkActivated} from './dist/modules/gateway/readiness.js'; await assertGatewayNetworkActivated(${JSON.stringify(profile)});`,
        ),
      ).rejects.toThrow("TUN");
    } catch (error) {
      if (containers.includes(core)) {
        process.stderr.write(
          `${await docker("exec", client, "ip", "route").catch(() => "client routes unavailable")}\n`,
        );
        process.stderr.write(
          `${await docker("logs", "--tail", "40", core).catch(() => "core logs unavailable")}\n`,
        );
        process.stderr.write(
          `${await docker("run", "--rm", "--network", `container:${core}`, "alpine:latest", "ip", "rule").catch(() => "rules unavailable")}\n`,
        );
        process.stderr.write(
          `${await docker("run", "--rm", "--network", `container:${core}`, "alpine:latest", "ip", "route", "show", "table", "all").catch(() => "routes unavailable")}\n`,
        );
      }
      throw error;
    } finally {
      env.MIHOMO_API = previousApi;
      setMihomoSecret(env.MIHOMO_SECRET);
      for (const name of containers.reverse())
        await docker("rm", "-f", name).catch(() => undefined);
      for (const name of networks.reverse())
        await docker("network", "rm", name).catch(() => undefined);
      rmSync(directory, { recursive: true, force: true });
    }
  },
  180000,
);

it.skipIf(!enabled)(
  "boots the standalone authenticated gateway with fresh persistent volumes",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "submerge-gateway-compose-"));
    const project = `sm-gw-compose-${process.pid}-${Date.now()}`;
    const composePath = new URL("../../../../../docker-compose.gateway.yml", import.meta.url)
      .pathname;
    const overridePath = join(directory, "override.yml");
    const envPath = join(directory, "gateway.env");
    const listsPath = join(directory, "lists");
    const profilePath = join(directory, "profile.json");
    const extraContainers: string[] = [];
    mkdirSync(listsPath);
    writeFileSync(join(listsPath, "notblocked.txt"), "+.docs.google.test\n");
    writeFileSync(join(listsPath, "custom.txt"), "+.forced.ru\n");
    const profile = networkProfileSchema.parse({
      profile: "gateway",
      localResolvers: ["192.168.1.1"],
      privateLists: [
        { name: "notblocked", file: "notblocked.txt", target: "notblocked" },
        { name: "custom", file: "custom.txt", target: "proxy" },
      ],
    });
    writeFileSync(profilePath, JSON.stringify({ profile: "proxy" }));
    writeFileSync(
      envPath,
      [
        `GATEWAY_SUBMERGE_IMAGE=${appImage}`,
        `GATEWAY_PROFILE_PATH=${profilePath}`,
        `GATEWAY_LISTS_DIR=${listsPath}`,
        "GATEWAY_ADMIN_PASSWORD=compose-native-test-password",
        "GATEWAY_MIHOMO_SECRET=compose-native-test-secret",
        "GATEWAY_UI_PORT=0",
        "GATEWAY_DNS_PORT=0",
        "GATEWAY_PROXY_PORT=0",
        "GATEWAY_LAN_SUBNET=172.30.221.0/24",
        "GATEWAY_LAN_IP=172.30.221.2",
      ].join("\n"),
    );
    // Decoder behavior is outside gateway scope; the app still uses its Compose name.
    writeFileSync(
      overridePath,
      yaml.dump({
        services: {
          "happ-decoder": { image: "alpine:latest", command: ["sleep", "300"] },
        },
      }),
    );
    const compose = (...args: string[]) =>
      docker(
        "compose",
        "--env-file",
        envPath,
        "-p",
        project,
        "--profile",
        "gateway",
        "-f",
        composePath,
        "-f",
        overridePath,
        ...args,
      );
    try {
      await docker(
        "run",
        "--rm",
        appImage,
        "node",
        "--input-type=module",
        "-e",
        "import {existsSync} from 'node:fs'; if(existsSync('/app/data/submerge.db')) throw new Error('Runtime DB must not ship in the image');",
      );
      await compose("config", "--quiet");
      await compose("up", "-d", "--no-build", "--pull", "never");
      const core = await compose("ps", "-q", "mihomo");
      const namespace = await compose("ps", "-q", "gateway-network");
      let app = await compose("ps", "-q", "submerge");
      const uiPort = (await docker("port", namespace, "3000/tcp")).match(/:(\d+)$/u)?.[1];
      if (!uiPort) throw new Error("UI mapping");
      let origin = `http://127.0.0.1:${uiPort}`;
      await eventually(
        async () => (await fetch(`${origin}/healthz`)).status,
        (status) => status === 200,
        60000,
      );
      expect((await fetch(`${origin}/trpc/gateway.get`)).status).toBe(401);
      const login = await fetch(`${origin}/trpc/auth.login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "compose-native-test-password" }),
      });
      expect(login.status).toBe(200);
      const cookie = login.headers.get("set-cookie")?.split(";")[0];
      if (!cookie) throw new Error("login session");
      const getProfile = async () =>
        (await fetch(`${origin}/trpc/gateway.get`, { headers: { cookie } })).json();
      expect(await getProfile()).toMatchObject({ result: { data: { profile: "proxy" } } });
      const firstConfiguration = await (
        await fetch(`${origin}/trpc/gateway.configuration`, { headers: { cookie } })
      ).json();
      expect(firstConfiguration.result.data.tun.localResolvers).toEqual([]);
      const setupReadiness = await eventually(
        async () =>
          (await fetch(`${origin}/trpc/gateway.readiness`, { headers: { cookie } })).json(),
        (value) =>
          value.result?.data?.checks?.some(
            (check: { name: string; ok: boolean }) => check.name === "config-applied" && check.ok,
          ),
        60000,
      );
      expect(setupReadiness.result.data.profile).toBe("proxy");
      for (const name of ["tun-disabled", "default-rule"])
        expect(
          setupReadiness.result.data.checks.find((check: { name: string }) => check.name === name)
            ?.ok,
        ).toBe(true);
      expect(
        setupReadiness.result.data.checks.find(
          (check: { name: string }) => check.name === "local-dns",
        )?.ok,
      ).toBe(false);
      const firstActivation = await fetch(`${origin}/trpc/gateway.set`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(profile),
      });
      expect(firstActivation.status).toBe(200);
      expect(await firstActivation.json()).toMatchObject({ result: { data: { applied: true } } });
      const readiness = await eventually(
        async () =>
          (await fetch(`${origin}/trpc/gateway.readiness`, { headers: { cookie } })).json(),
        (value) =>
          value.result?.data?.checks?.some(
            (check: { name: string; ok: boolean }) => check.name === "config-applied" && check.ok,
          ),
        60000,
      );
      const checks = readiness.result.data;
      expect(checks.ready).toBe(false);
      for (const name of [
        "config-applied",
        "runtime",
        "tun-interface",
        "lan-wan-interfaces",
        "dns-udp",
        "dns-tcp",
        "private-lists",
        "default-rule",
      ])
        expect(checks.checks.find((check: { name: string }) => check.name === name)?.ok).toBe(true);
      expect(checks.checks.find((check: { name: string }) => check.name === "vpn-pool")?.ok).toBe(
        false,
      );
      const mounts = JSON.parse(
        await docker("inspect", "--format", "{{json .Mounts}}", core),
      ) as Array<{ Destination: string; RW: boolean }>;
      expect(mounts.find((mount) => mount.Destination.endsWith("/private-lists"))?.RW).toBe(false);
      const originalProfile = (await getProfile()).result.data;
      const selectMode = async (profile: unknown) => {
        const response = await fetch(`${origin}/trpc/gateway.set`, {
          method: "POST",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify(profile),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ result: { data: { applied: true } } });
      };
      const failedPreferences = { ...originalProfile, lanInterface: "missing-lan" };
      const failedEdit = await fetch(`${origin}/trpc/gateway.set`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(failedPreferences),
      });
      expect(failedEdit.status).toBe(500);
      expect((await getProfile()).result.data).toEqual(failedPreferences);
      const failedState = await (
        await fetch(`${origin}/trpc/gateway.readiness`, { headers: { cookie } })
      ).json();
      expect(
        failedState.result.data.checks.find(
          (check: { name: string }) => check.name === "config-applied",
        )?.ok,
      ).toBe(false);
      expect(
        failedState.result.data.checks.find(
          (check: { name: string }) => check.name === "tun-interface",
        )?.ok,
      ).toBe(true);
      await selectMode({ profile: "proxy" });
      const proxyState = await (
        await fetch(`${origin}/trpc/gateway.readiness`, { headers: { cookie } })
      ).json();
      expect(proxyState.result.data.profile).toBe("proxy");
      expect(
        proxyState.result.data.checks.find(
          (check: { name: string }) => check.name === "tun-disabled",
        )?.ok,
      ).toBe(true);
      expect(
        proxyState.result.data.checks.find(
          (check: { name: string }) => check.name === "default-rule",
        )?.ok,
      ).toBe(true);
      const savedConfiguration = await (
        await fetch(`${origin}/trpc/gateway.configuration`, { headers: { cookie } })
      ).json();
      expect(savedConfiguration.result.data.profile.profile).toBe("proxy");
      expect(savedConfiguration.result.data.tun).toEqual(failedPreferences);
      await compose(
        "run",
        "--rm",
        "--no-deps",
        "gateway-init",
        "node",
        "dist/gateway-cli.js",
        "bootstrap",
      );
      await selectMode(originalProfile);
      const resetSecret = await fetch(`${origin}/trpc/settings.set`, {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ key: "mihomoSecret", value: "" }),
      });
      expect(resetSecret.status).toBe(200);
      expect(await resetSecret.json()).toMatchObject({ result: { data: { applied: true } } });
      writeFileSync(
        envPath,
        readFileSync(envPath, "utf8").replace(
          "compose-native-test-secret",
          "changed-env-native-secret",
        ),
      );
      await compose("up", "-d", "--no-deps", "--force-recreate", "submerge");
      app = await compose("ps", "-q", "submerge");
      await eventually(getProfile, (value) => value.result?.data?.profile === "gateway");
      await eventually(
        async () =>
          (await fetch(`${origin}/trpc/gateway.readiness`, { headers: { cookie } })).json(),
        (value) =>
          ["runtime", "config-applied"].every((name) =>
            value.result?.data?.checks?.some(
              (check: { name: string; ok: boolean }) => check.name === name && check.ok,
            ),
          ),
      );
      await docker("restart", core);
      const restartedUiPort = (await docker("port", namespace, "3000/tcp")).match(/:(\d+)$/u)?.[1];
      if (!restartedUiPort) throw new Error("restarted UI mapping");
      origin = `http://127.0.0.1:${restartedUiPort}`;
      await eventually(getProfile, (value) => value.result?.data?.profile === "gateway");
      await eventually(
        async () =>
          (await fetch(`${origin}/trpc/gateway.readiness`, { headers: { cookie } })).json(),
        (value) =>
          value.result?.data?.checks?.some(
            (check: { name: string; ok: boolean }) => check.name === "tun-interface" && check.ok,
          ),
      );
      await docker("restart", app);
      await eventually(getProfile, (value) => value.result?.data?.profile === "gateway");
      // Audit SYNs independently of successful HTTP replies: a missing return
      // route must never conceal raw LAN packets escaping into WAN.
      writeFileSync(join(directory, "fixture.py"), fixtureScript);
      const audit = `${project}-audit`;
      const client = `${project}-client`;
      await docker(
        "run",
        "-d",
        "--name",
        audit,
        "--network",
        `${project}_egress`,
        "-v",
        `${directory}:/fixture:ro`,
        "python:3.12-slim",
        "python",
        "/fixture/fixture.py",
        "proxy",
      );
      extraContainers.push(audit);
      await docker(
        "run",
        "-d",
        "--name",
        client,
        "--network",
        `${project}_gateway-lan`,
        "--cap-add",
        "NET_ADMIN",
        "alpine:latest",
        "sleep",
        "300",
      );
      extraContainers.push(client);
      const networkIp = async (container: string, network: string) =>
        docker(
          "inspect",
          "--format",
          `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`,
          container,
        );
      const auditIp = await networkIp(audit, `${project}_egress`);
      const clientIp = await networkIp(client, `${project}_gateway-lan`);
      const namespaceIp = await networkIp(namespace, `${project}_egress`);
      await docker("exec", client, "ip", "route", "replace", "default", "via", "172.30.221.2");
      await docker("stop", core);
      const sendUdp = (container: string) =>
        docker(
          "run",
          "--rm",
          "--network",
          `container:${container}`,
          appImage,
          "node",
          "--input-type=module",
          "-e",
          `import {createSocket} from 'node:dgram'; const s=createSocket('udp4'); s.send('probe',8081,${JSON.stringify(auditIp)},error=>{s.close();if(error)throw error});`,
        );
      await eventually(
        async () => {
          await sendUdp(namespace);
          return docker("logs", audit);
        },
        (logs) => logs.includes(`SOURCE:${namespaceIp}`),
      );
      await docker("exec", client, "wget", "-qO-", "-T", "2", `http://${auditIp}:8081/`).catch(
        () => undefined,
      );
      expect(await docker("logs", audit)).not.toContain(`SOURCE:${clientIp}`);
      await sendUdp(client);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await docker("logs", audit)).not.toContain(`SOURCE:${clientIp}`);
      // SIGKILL leaves the engine's nft table behind, unlike graceful cleanup.
      // The independent forwarding guard must work in both failure modes.
      await docker("update", "--restart=no", core);
      await docker("start", core);
      await eventually(
        async () =>
          (await fetch(`${origin}/trpc/gateway.readiness`, { headers: { cookie } })).json(),
        (value) =>
          value.result?.data?.checks?.some(
            (check: { name: string; ok: boolean }) => check.name === "runtime" && check.ok,
          ),
      );
      await docker("kill", core);
      await docker("exec", client, "wget", "-qO-", "-T", "2", `http://${auditIp}:8081/`).catch(
        () => undefined,
      );
      await sendUdp(client);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(await docker("logs", audit)).not.toContain(`SOURCE:${clientIp}`);
    } catch (error) {
      process.stderr.write(
        `${await compose("logs", "--tail", "40").catch(() => "compose logs unavailable")}\n`,
      );
      throw error;
    } finally {
      for (const name of extraContainers.reverse())
        await docker("rm", "-f", name).catch(() => undefined);
      await compose("down", "-v", "--remove-orphans").catch(() => undefined);
      rmSync(directory, { recursive: true, force: true });
    }
  },
  180000,
);
