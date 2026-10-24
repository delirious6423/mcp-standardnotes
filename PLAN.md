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
- [ ] Rewrite the README for this fork.
- [ ] Archive, pin and star changes (`note_archive`, `note_unarchive`, `note_pin`, `note_unpin`, `note_star`, `note_unstar`).
- [ ] Nested tags: create/move a tag under a parent; attach a tag created earlier in the same batch.
- [ ] One synced client per server process with delta sync, and a global back-off after HTTP 429.
- [ ] Merge as one reviewable change (combined note plus trashing the sources).
- [ ] Own identity: rename the package and server id; disable the inherited npm/MCP Registry publish workflow.
- [ ] Make this line the fork's `main`; run CI on it.
- [ ] Bugs: launcher fails when called through a symlink; upstream #24 (installer through npm symlinks); `dump-note` dev script prints decrypted text.
- [ ] Re-run macOS and Windows VM gates.

## Boundaries
Standard Notes sync and stored recovery payloads stay end-to-end encrypted. The MCP server uses stdio pipes, never a listening port. Cloud models see the plaintext the agent reads. Protected notes stay excluded. Tests use synthetic data in throwaway VMs (`tests/vm/run.sh`); no real-account writes or package installs on the desktop as tests.
