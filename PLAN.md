# Roadmap

Fork of lozit/mcp-standardnotes, maintained here because upstream has been inactive since 2026-08-19.
Goal: a local stdio MCP server that lets an agent read and safely reorganize a Standard Notes vault, with
every write previewed and approved by a human, reversible where Standard Notes allows it.

## Done
- [x] Safe prepare/commit writes: expected revision, no forced conflicts, no permanent deletion, read-back verification, encrypted recovery records, idempotent retry, cross-process account lock.
- [x] Legacy protocol 003 reads in accounts upgraded to 004.
- [x] Batch reads and writes: up to 200 changes per preview and approval.
- [x] Drop the native GPUI approval/login app (too costly to maintain). Approval is the terminal `approve` command with a readable, escape-safe preview and a durable `reject`.

## Next (in order)
- [x] Rewrite the README for this fork.
- [x] Archive, pin and star: `note_flags` change, flags in reads, `archived` filter on `notes_list`.
- [x] Nested tags: `parent` on tag_create/tag_update, `@ref` names for tags created in the same batch, cycle checks; parent links match the official app (`content_type: "Tag"`).
- [x] One synced client per server process with delta sync (keychain tokens adopted each call); after HTTP 429 every process for the account waits out Retry-After without sending.
- [x] Merge as one reviewable change: `note_merge` in a batch creates the combined note, carries over tags and trashes the sources; one undo reverts it.
- [x] Own identity: package `standardnotes-safe-mcp` 0.7.0 (private), server id and User-Agent renamed; upstream publish workflow, server.json and release script removed. Keychain service unchanged.
- [x] Make this line the fork's `main` (fast-forward); CI on Node 22 and 24, matching `engines`.
- [x] Bugs: launcher follows symlinks to its checkout; installer entry check compares real paths (upstream #24); `dump-note` (printed decrypted text, ignored protection) removed.
- [x] Re-run macOS and Windows VM gates: macOS ARM64 and Windows x64 PASS 2026-10-25. Windows fixes: elevated-owner new files, one PowerShell helper per process (per-check median 901.6 ms → 1.0 ms).
- [ ] Windows ARM64 and Linux ARM64 gates.
- [ ] Drop the dotfiles machine-file lookup from the launcher and `src/config.ts` (maintainer-specific); configure `SN_STATE_DIR` explicitly.

## Boundaries
Standard Notes sync and stored recovery payloads stay end-to-end encrypted. The MCP server uses stdio pipes, never a listening port. Cloud models see the plaintext the agent reads. Protected notes stay excluded. Tests use synthetic data in throwaway VMs (`tests/vm/run.sh`); no real-account writes or package installs on the desktop as tests.
