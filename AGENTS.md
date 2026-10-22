# Shared Standard Notes connector

This is a local safety fork of lozit/mcp-standardnotes, not a Standard Notes app fork. See PLAN.md, PROGRESS.md and docs/LOCAL-SETUP.md. Upstream README/CLAUDE feature lists describe the original connector; do not re-expose legacy mutators.

- Safe MCP surface: read tools plus writes_prepare/commit/status/undo_prepare. No permanent note deletion or tag deletion. No raw-ciphertext or approval MCP tools.
- Preview and opaque revision must describe the same snapshot. Preserve unknown content, envelope metadata and complete tag references. Only plain-text/Markdown bodies are writable. Known derived previews are refreshed on body edits.
- Respect valid protected/edit-locked flags; malformed access metadata fails closed. Never search protected content then merely mask its matching result.
- Terminal approval is per immutable preview. Durable encrypted before/after data precedes writes. Previously attempted/uncertain operations reconcile only; never silently resubmit, create a replacement, or force a conflict retry.
- Keychain only for session/recovery keys. No credentials, plaintext note fixtures, vault exports or journal keys in git, agent configuration, logs or conversation. All fixtures must be synthetic.
- No real-account access/writes during development. Official-cloud/app verification needs an explicitly authorized throwaway account; mock tests cannot establish hosted acceptance.
- App/process/keychain/integration tests: native Incus Ubuntu 26.04 VM via `bash tests/vm/run.sh`, using `~/code/dotfiles/lib/incus-vm.sh`. No containers or host fallback. The harness verifies ownership before cleanup. Do not touch other VMs/processes.
- `SN_INSTALL_ARTIFACTS=1 bash tests/vm/run.sh` explicitly installs successful VM-built dist/node_modules artifacts in this checkout without launching the app on the host. Normal harness runs copy dist only.
- Preserve MIT attribution and upstream remote. No npm publish, public fork, real note mutation or recovery-history destruction without explicit approval.
