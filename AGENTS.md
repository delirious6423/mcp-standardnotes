# standardnotes-safe-mcp

A maintained safety fork of lozit/mcp-standardnotes (an MCP server, not a Standard Notes app fork). Technical map: CLAUDE.md. Roadmap: PLAN.md. Setup: docs/LOCAL-SETUP.md. Upstream's direct-write and delete tools were removed on purpose; do not re-expose them.

- Safe MCP surface: read tools plus writes_prepare, writes_prepare_batch, writes_commit, writes_status, writes_undo_prepare. No permanent note deletion or tag deletion. No raw-ciphertext or approval MCP tools.
- Preview and opaque revision must describe the same snapshot. Preserve unknown content, envelope metadata and complete tag references. Only plain-text/Markdown bodies are writable. Known derived previews are refreshed on body edits.
- Respect valid protected/edit-locked flags; malformed access metadata fails closed. Never search protected content then merely mask its matching result.
- Terminal approval is per immutable preview. Durable encrypted before/after data precedes writes. Previously attempted/uncertain operations reconcile only; never silently resubmit, create a replacement, or force a conflict retry.
- Keychain only for session/recovery keys. No credentials, plaintext note fixtures, vault exports or journal keys in git, agent configuration, logs or conversation. All fixtures must be synthetic.
- No real-account access/writes during development. Official-cloud/app verification needs an explicitly authorized throwaway account; mock tests cannot establish hosted acceptance.
- App/process/keychain/integration tests run only in throwaway VMs: `bash tests/vm/run.sh` (Linux, Incus), `tests/vm/macos-run.sh` (macOS, Tart), `tests/vm/windows-run.sh` (Windows x64, Incus). The runners use the maintainer's VM helpers from a dotfiles checkout (`DOTFILES`, default `~/code/dotfiles`). No containers or host fallback. Runners verify ownership before cleanup and refuse to start while another run holds a shared slot. Do not touch other VMs/processes.
- `SN_INSTALL_ARTIFACTS=1 bash tests/vm/run.sh` explicitly installs successful VM-built dist/node_modules artifacts in this checkout without launching the app on the host. Normal harness runs copy dist only.
- Preserve MIT attribution and the upstream remote. The repository is public: no personal paths, hostnames, account data or vault statistics in commits. No npm publish, real note mutation or recovery-history destruction without explicit approval.
