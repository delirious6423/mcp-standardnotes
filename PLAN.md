# Shared Standard Notes connector

Goal: one local stdio MCP installation, all notes on the official service, no credentials in agent configuration.

Upstream: lozit/mcp-standardnotes at 749d4662ca1c4c0183e6086cf1a43f681458ce25; local branch safe-shared-connector. No public fork or publish requested.

## Work
- [x] Safe single-item prepare/commit API: raw metadata preservation, expected revision, no forced conflicts, no permanent deletion, read-back verification.
- [x] MCP read tools plus preview/commit/status/recovery tools; encrypted durable operation records; idempotent retries; cross-process account lock and session refresh coordination.
- [x] Plain text/Markdown body writes first; structured note rename/trash remains metadata-safe; respect protection/edit locks.
- [x] Incus Ubuntu 26.04 VM harness, regression canary proving the old search bug fails, build/typecheck/lint/audit and stdio integration tests using synthetic data only.
- [x] Fresh independent adversarial review; fix findings.
- [x] Shared launcher/config registration through source dotfiles (no generated-config hand edits); login remains interactive in user's terminal.
- [x] Document privacy, limitations, exact setup/undo and official-app test prerequisites.
- [ ] Interactive login and separately authorized official-hosted/official-app round trip (requires user-controlled throwaway account; not passed).

## Boundaries
Standard Notes sync and stored recovery payloads remain E2EE. Local MCP uses pipes, not a listening network port. Cloud model inference cannot be opaque to its provider with conventional APIs: TLS protects transit, provider processes plaintext. Fully local inference avoids that disclosure. Account credentials can access all notes; protected notes remain excluded unless unlocked in official app.

No real-account writes, account creation, public publishing, or package/system installation on the desktop during tests. App tests use ~/code/dotfiles/lib/incus-vm.sh (native Incus VM only). No host fallback.
