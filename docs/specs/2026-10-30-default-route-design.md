# Default route selection

Status: implemented and verified locally; not merged or deployed.

The admin can choose whether unmatched traffic goes directly from the server or
through the Default channel's VPN pool. This supports production services whose
source IP is allowlisted: only explicitly matched destinations such as Docker Hub
and npm use VPN, without maintaining a list of insurance API destinations.

- Routing → Default exposes a segmented **Напрямую / Через VPN** choice. The
  collapsed card states the selected route. Existing and new installations retain
  the current VPN default until the admin explicitly selects Direct.
- Persist `defaultRoute: proxy | direct` on the Default row, independently of the
  system Direct channel and connection mode. Only Default can change this value.
- Direct default ends with `MATCH,DIRECT` in legacy Proxy, prepared Proxy and TUN.
  All existing explicit rules retain their order and targets, including Default's
  Always VPN lists and managed VPN rules. Default's VPN pool/policy remain saved
  and available to those lists and when switching back.
- An explicit VPN channel with an empty pool rejects traffic in Direct-default
  mode; it must never silently fall through to Direct, even with zero exit nodes.
- Changing the route applies immediately. Pending changes disable duplicate
  selections; activation failure restores the saved route and accepted config and
  reports an error. A lost engine response cannot be described as confirmed active.
- Readiness accepts the selected final rule and does not require a VPN pool for
  a purely Direct configuration. Diagnostics attribute unmatched traffic to Direct.
- No host routes, Docker settings, dependencies, public deployment, or existing
  routing preferences change as part of this task.

PR review corrections: diagnostics derive Default from the accepted engine rules,
including a Default row whose enabled flag is false. Probe native DIRECT before
reporting it available. If configuration activation overlaps a diagnostic run,
report uncertain route attribution and do not cache a definitive result. Apply
completion invalidates previous diagnostic cache generations. Runtime bookkeeping
failures after a committed apply retain its result and schedule observer recovery.

Crash recovery belongs to the common config apply lifecycle, for all configuration
changes and connection modes. Desired settings in SQLite, a durable pending config
and the last accepted config are distinct. Staged mutations and the apply journal
are one SQLite transaction. The bounded internal journal binds config path and
previous/candidate hashes to their Default route; it contains no config payload.
The candidate is persisted separately and sent inline to Mihomo. Only successful
reload/readiness checks replace the accepted file; credential confirmation and
apply bookkeeping precede journal removal. Failed ordinary applies retain pending
state and retry even when bytes are identical. Existing explicit rollback callers
restore the previous file before atomically undoing their staged mutation and
restoring the previous journal.

Startup validates a journal-proven accepted file using its accepted route while
keeping the requested settings. The normal serialized owner then regenerates from
current desired settings and coordinated managed rules, reloads and confirms the
configuration. It also recovers when the candidate reached the accepted path but
the process stopped before recording completion. Bootstrap never promotes an apply
without contacting Mihomo. Missing files are regenerated only when no accepted
file existed; unknown files, invalid journals and path mismatches fail explicitly.
Pending credential rotations retain both keys until normal apply completes; an
offline bootstrap preserves the journal-bound file rather than rewriting its key.
Existing bootstrap safety and TUN administrator checks continue to apply.
Supported legacy Proxy preparation also resumes interrupted applies: only a proven
pre-native Proxy file can migrate offline. Rebase its current file identity before
publishing a prepared candidate, retain desired settings and credential recovery,
and leave activation pending. Native/TUN validation failures remain explicit.
Offline legacy migration retains any accepted managed domain-rule provider at a
REJECT target until the coordinated owner proves its current VPN route. Keep its
normal rule priority and canonical local provider; missing or unsafe definitions
fail explicitly instead of allowing a Direct catch-all to absorb managed domains.
Inspect the backing file with the existing local-store safety checks and accept
only its attested digest or a known unfinished operation's intended digest.
Missing, unsafe, unattested or unknown bytes block preparation. Offline inspection
never promotes the store marker or finishes a domain-rule operation.

UI uses the existing Indigo Console `Segmented` control and channel editor row:
`oXxu8/KvheA` (3 px inset/gap, 7×13 px option padding, text-sub, md/sm radii),
and Routing frames `lYrng`, `HXRTv`. No new tokens. The new row adapts these existing
controls; the original Pencil app is unavailable, so design values are read from
the tracked JSON. The user approved this choice in the task conversation.
