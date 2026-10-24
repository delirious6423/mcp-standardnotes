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
- [ ] Own identity: rename the package and server id; disable the inherited npm/MCP Registry publish workflow.
- [ ] Make this line the fork's `main`; run CI on it.
- [ ] Bugs: launcher fails when called through a symlink; upstream #24 (installer through npm symlinks); `dump-note` dev script prints decrypted text.
- [ ] Re-run macOS and Windows VM gates.

## Boundaries
Standard Notes sync and stored recovery payloads stay end-to-end encrypted. The MCP server uses stdio pipes, never a listening port. Cloud models see the plaintext the agent reads. Protected notes stay excluded. Tests use synthetic data in throwaway VMs (`tests/vm/run.sh`); no real-account writes or package installs on the desktop as tests.
