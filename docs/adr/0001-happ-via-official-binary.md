# 0001 — Decoding happ:// via the official Happ binary

**Status:** accepted (2026-06-29)

## Context

`happ://crypt5` is an encrypted Happ application link that wraps a regular subscription URL. The encryption keys (RSA + ChaCha20-Poly1305) are tied to the APK version and **rotate silently** (Happ releases ~weekly). Static reverse decoders (LeeeeT/happ-decryptor and similar) hard-code a key snapshot and go stale quickly: on fresh links they fail with "marker not found" / "segment length missing" (verified — a real user link would not decode).

## Decision

Use **the official Happ desktop binary itself** as the decoder (it always has the current keys). The `happ-decoder` sidecar (Python) runs Happ (Qt) headless under **Xvfb**, pipes `--test-crypt5 <link>` through a local **mitmproxy** that intercepts the decoded sub-URL and subscription body. Updating the keys means rebuilding the image with a fresh Happ `.deb`. No reverse engineering or key extraction.

## Consequences

- (+) Works on any current crypt links; updating is trivial.
- (+) No dependency on fragile third-party decoders.
- (−) Heavy image (Qt + Xvfb + mitmproxy), started on demand.
- Happ does not send HWID by default — for providers that require device binding, mitmproxy injects `X-Hwid` (see ADR-0002).
- Happ is version-locked: `HAPP_VERSION` is a build-arg, updated on key rotation.
