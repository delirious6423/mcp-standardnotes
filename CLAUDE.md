# standardnotes-safe-mcp

Agent rules for this repository are in `AGENTS.md`; this file is the technical map.

An MCP server (stdio only) that reads a Standard Notes vault and makes previewed, terminal-approved,
undoable writes, keeping Standard Notes' end-to-end encryption. Fork of lozit/mcp-standardnotes; the
upstream direct-write and delete tools are gone on purpose.

<important if="working on encryption or authentication">
NEVER reimplement a cryptographic primitive. Primitives come only from `libsodium-wrappers-sumo`
(Argon2id, XChaCha20-Poly1305 IETF); the one exception is `node:crypto` AES-256-CBC + HMAC for reading
legacy protocol 003 items. What is implemented here is protocol framing: `004:` payloads, root-key
derivation, items-key wrap/unwrap, and decrypt-only `003:`.
</important>

## Stack

TypeScript (strict), Node.js ≥ 22.12, `@modelcontextprotocol/sdk`, `zod` 4, `keytar`, native `fetch`.

## Commands

```bash
npm ci                 # pinned dependencies
npm run build          # tsc → dist/
npm run typecheck && npm run lint && npm test
bash tests/vm/run.sh           # Linux gate (Incus VM): unit tests, canaries, MCP e2e
bash tests/vm/macos-run.sh     # macOS gate (Tart VM on an Apple Silicon host)
bash tests/vm/windows-run.sh   # Windows x64 gate (Incus VM)
```

## Structure

```
bin/standardnotes-mcp     launcher: serve | login | logout | approve ID | unlock
src/
  index.ts, server.ts     stdio entry, tool registration and descriptions
  config.ts               state-directory resolution
  tools/                  notes.ts, tags.ts (reads), changes.ts (zod schemas for every change kind)
  sn/
    client.ts             sync, delta sync, decrypt, planning and committing changes
    batch-preview.ts      per-item preview diffs
    protocol004.ts, protocol003.ts, crypto.ts, http.ts, session.ts (keychain), cache.ts, tagHierarchy.ts
  security/
    write-journal.ts      encrypted prepare/approve/commit/undo records
    account-context.ts    per-process client, account lock, shared HTTP 429 back-off
    account-state.ts, private-fs.ts, line-helper.ts   private state files (POSIX modes, NTFS ACLs)
    redact.ts, logger.ts
  cli/                    login, logout, approve (+ render-preview), unlock, install
tests/                    mcp-e2e.mjs, approve-pty.py, regression_canary.py, vm/ runners
```

## MCP tools

Reads: `notes_list`, `notes_search`, `notes_get`, `notes_get_batch`, `notes_stats`, `tags_list`, `tags_get`.
Writes: `writes_prepare` / `writes_prepare_batch` (preview only) → the user runs `standardnotes-mcp approve ID`
in a terminal → `writes_commit`. Also `writes_status`, `writes_undo_prepare`. Change kinds: `note_create`,
`note_update`, `note_trash`, `note_restore`, `note_flags`, `note_merge` (batch only), `tag_create`, `tag_update`,
`tag_attach`, `tag_detach`. No permanent deletion, no tag deletion, no MCP tool that approves.

## Security requirements (non-negotiable)

<important if="adding/modifying a tool, storage, logging, or auth">
1. The password is never logged or stored; it only derives the root key in memory.
2. Sessions and journal keys live in the OS keychain (`keytar`), never in a plaintext file.
3. stdio transport only; refuse requests for a network transport.
4. Logs go to stderr through `security/redact.ts`; any stdout write breaks MCP.
5. Every tool input is validated by zod (strict UUIDs, size limits).
6. Every write is previewed, approved by the user in their own terminal, journaled encrypted before it
   is sent, and undoable. An uncertain write is only reconciled, never resent.
7. Protected notes are never searched or returned; locked notes are never changed.
8. No telemetry; no network calls except the configured sync server.
9. `npm audit` HIGH/CRITICAL blocks a merge.
</important>

## Gotchas

- Any `console.log` breaks MCP stdio.
- The server rate-limits (HTTP 429, up to about an hour). The client backs off; never retry in a loop.
- On Windows each private-file check goes through one PowerShell helper per process; the first check
  costs about 2 s.
- Tests use synthetic data only. Never commit fixtures with real encrypted data or keys.

## References

- SNJS specification: https://github.com/standardnotes/snjs/blob/main/packages/snjs/specification.md
- Encryption whitepaper: https://standardnotes.com/help/security/encryption
- MCP SDK: https://github.com/modelcontextprotocol/typescript-sdk
