# Manual Mihomo credentials

Status: implemented and verified locally; not merged or deployed.

The administrator owns the value of a manually supplied Mihomo API credential.
Submerge must not reject startup, bootstrap, config generation, activation or
restart because a nonempty manual credential contains fewer than 16 characters.
This applies to environment seeds, saved settings and pending credential rotation
in both Proxy and TUN modes. Existing manual credentials remain unchanged.

When no effective credential exists, generate a random 32-byte hexadecimal
credential, including normal application startup without the Compose init service.
Reuse the durable rotation journal so an interrupted activation can still use the
old credential. Repeated startup must reuse the pending/generated credential.
Empty resets retain an explicit environment seed or confirmed credential, or
generate a credential if neither exists. Environment edits do not silently rotate
a confirmed credential.

Controller authentication preserves the UTF-8 bytes of manually supplied Unicode
credentials in HTTP headers. Mihomo compares those bytes directly with its
configured secret. A locally unrepresentable primary header must still allow the
previous credential to recover an interrupted rotation; network errors must not
retry controller mutations with another credential.

Keep authentication proof, atomic file updates, rotation recovery, TUN admin
authentication, routing, DNS and container permissions unchanged. This does not
make an old Compose installation ready for TUN; the complete deployment update
is still required for its network namespace and permissions.

No UI controls, dependencies, deployment files, commits or publication are needed
to implement this correction. The user explicitly requested the credential policy.
