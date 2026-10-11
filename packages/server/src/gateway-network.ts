import { execFileSync } from "node:child_process";

// A separate table survives Mihomo's TUN cleanup and process death. All internet
// forwarding must terminate in the engine; its DIRECT/VPN sockets use OUTPUT.
const guard = `delete table inet submerge_gateway
table inet submerge_gateway {
  chain forward_guard {
    type filter hook forward priority 100; policy accept;
    iifname "lan0" oifname "eth0" counter drop
    iifname "eth0" oifname "lan0" counter drop
  }
}
`;

if (process.getuid?.() !== 0) throw new Error("Gateway network bootstrap requires root");
try {
  execFileSync("nft", ["list", "table", "inet", "submerge_gateway"], { stdio: "ignore" });
} catch {
  execFileSync("nft", ["add", "table", "inet", "submerge_gateway"], { stdio: "inherit" });
}
// Delete/recreate in a single nft transaction, including on an idempotent restart.
execFileSync("nft", ["-f", "-"], { input: guard, stdio: ["pipe", "inherit", "inherit"] });
process.setgid?.(999);
process.setuid?.(999);
// Keep the namespace stable without application data, secrets or active privileges.
setInterval(() => {}, 60000);
