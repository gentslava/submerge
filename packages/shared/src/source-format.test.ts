import { describe, expect, it } from "vitest";
import { isNodeConfigText } from "./source-format.js";

describe("inline node config hint", () => {
  it.each([
    '{"outbounds": []}',
    '[{"outbounds": []}]',
    "proxies:\n  - name: Node",
    "name: Node\ntype: vless",
    '"name": Node\n"type": trojan',
    "- name: Node\n  type: trojan",
    "---\n{name: Node, type: trojan}",
    "# comment\n---\n{name: Node, type: trojan}",
    "%YAML 1.2\n---\n{name: Node, type: trojan}",
    "--- {name: Node, type: trojan}",
    "# comment\n---\ndns:\n  servers: [https://dns.example.test]\noutbounds: []",
  ])("recognizes structured content: %s", (text) => {
    expect(isNodeConfigText(text)).toBe(true);
  });
  it.each([
    "https://example.test/sub",
    "happ://crypt5/abc",
    "vless://u@example.test:443",
    "[Interface]\nPrivateKey = key\n[Peer]\nEndpoint = example.test:443",
    "dmxlc3M6Ly91QGhvc3Q6NDQz",
    "",
  ])("leaves existing import kinds alone: %s", (text) => {
    expect(isNodeConfigText(text)).toBe(false);
  });
});
