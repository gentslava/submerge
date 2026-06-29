# 0002 — X-Hwid as a per-source option (off by default)

**Status:** accepted (2026-06-29)

## Context

Some providers bind subscriptions to a device: without the `X-Hwid` header they return a stub ("App not supported" / "Enable HWID sharing"), with it they return real nodes (verified: Black Cat VPN 1→23 nodes; happ provider stub→12). However, sending HWID to everyone is not acceptable — it burns device slot limits at providers that do not require HWID.

## Decision

`X-Hwid` is an **option per source** (flag `hwid`, off by default). HWID is a single stable identifier per instance (stored in `hwid.txt`/settings). It is submitted as follows:
- for https subscriptions — combine adds the `X-Hwid` header (+ `X-Device-Os`) when fetching;
- for `happ://` — the flag is passed to happ-decoder, and mitmproxy injects `X-Hwid` into Happ's requests to the subscription (equivalent to the "HWID toggle" in the app).

## Consequences

- (+) Providers that require device binding work; providers that do not need HWID are never sent it and do not burn device slot limits.
- (+) Uniform mechanism for regular subscriptions and happ.
- (−) The user must know/understand when to enable the flag (hint in UI + error message "enable HWID").
