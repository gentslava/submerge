import { readFileSync } from "node:fs";
import * as yaml from "js-yaml";
import { expect, it } from "vitest";
import { z } from "zod";

it("ships a prepared standard installation with private API, engine-only TUN and no required mode files", () => {
  const compose = z
    .object({ services: z.record(z.string(), z.record(z.string(), z.unknown())) })
    .parse(
      yaml.load(readFileSync(new URL("../../../docker-compose.yml", import.meta.url), "utf8"), {
        schema: yaml.CORE_SCHEMA.withTags(yaml.mergeTag),
      }),
    );
  const { submerge, mihomo, "submerge-network": network, "submerge-init": init } = compose.services;
  expect(submerge?.profiles).toBeUndefined();
  expect(submerge?.network_mode).toBe("service:submerge-network");
  expect(mihomo?.network_mode).toBe("service:submerge-network");
  expect(mihomo?.devices).toContain("/dev/net/tun:/dev/net/tun");
  expect(mihomo?.cap_add).toContain("NET_ADMIN");
  expect(submerge?.devices).toBeUndefined();
  expect(submerge?.cap_add).toBeUndefined();
  expect(compose.services["happ-decoder"]?.group_add).toEqual(["999"]);
  expect(init?.network_mode).toBe("none");
  expect(init?.environment).toMatchObject({
    GATEWAY_DEPLOYMENT: "true",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Compose interpolation is literal YAML.
    MIHOMO_SECRET: "${MIHOMO_SECRET:-}",
  });
  expect(init?.environment).not.toHaveProperty("GATEWAY_PROFILE_FILE");
  expect(JSON.stringify(init?.volumes)).not.toContain("profile.json");
  const ports = z.array(z.string()).parse(network?.ports);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Compose interpolation is literal YAML.
  expect(ports).toContain("${DNS_BIND:-127.0.0.1}:${DNS_PORT:-1053}:1053/udp");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Compose interpolation is literal YAML.
  expect(ports).toContain("${DNS_BIND:-127.0.0.1}:${DNS_PORT:-1053}:1053/tcp");
  expect(ports.some((port) => port.includes("9090"))).toBe(false);
});
