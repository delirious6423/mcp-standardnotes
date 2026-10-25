# Standard Notes MCP (safe fork)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node: ≥22.12](https://img.shields.io/badge/node-%E2%89%A522.12-brightgreen.svg)](#install)

A local [MCP](https://modelcontextprotocol.io) server that lets an AI agent read and reorganize your
[Standard Notes](https://standardnotes.com/) vault. Every write is previewed first and approved by you in
your own terminal, and nothing is ever permanently deleted.

This is a maintained fork of [lozit/mcp-standardnotes](https://github.com/lozit/mcp-standardnotes), which
has been inactive since August 2026. It differs from upstream in what it allows:

| | Upstream | This fork |
|---|---|---|
| Writes | Applied immediately | Preview, then your approval in a terminal, then commit |
| Deletion | `notes_delete`, `tags_delete` | None; notes go to Trash, tags are removed in the official app |
| Bulk changes | `notes_create_many` | Up to 200 changes (create, edit, trash, tag) per approval |
| Undo | None | Encrypted before/after record of every write; one-call undo |
| Concurrent edits | On a sync conflict, re-sends its version over the other edit | Stale or conflicting writes fail without sending anything |
| Old accounts | Protocol 004 items only | Also reads legacy protocol 003 items |
| Protected notes | Masked in lists, but still matched by search | Excluded from reads, search and writes |

> Unofficial third-party integration. Not affiliated with or endorsed by Standard Notes Ltd.

## What an agent can do

| Tool | Purpose |
|---|---|
| `notes_list`, `notes_search`, `notes_get`, `notes_stats` | Browse (filter by tag or archived state), search and summarize the vault |
| `notes_get_batch` | Read up to 200 notes with one sync |
| `tags_list`, `tags_get` | Browse tags and their notes |
| `writes_prepare` | Preview one change |
| `writes_prepare_batch` | Preview up to 200 changes as one operation |
| `writes_commit` | Apply an approved operation exactly as previewed |
| `writes_status` | Check an operation's state, including partly saved batches |
| `writes_undo_prepare` | Preview the undo of a committed operation |

Change kinds: `note_create`, `note_update` (rename, replace or append text), `note_trash`, `note_restore`,
`note_flags` (archive, pin, star or undo them), `note_merge` (batch only: one new note from 2–50 notes' text,
each under its title as a heading, with all their tags; the sources are trashed unless `trashSources: false`),
`tag_create` (optionally under a parent), `tag_update` (rename or
move, `parent: null` for top level), `tag_attach`, `tag_detach`. Body edits support plain text and Markdown;
other note types can be renamed, tagged or trashed without touching their body.

A batch can build a whole tag tree: name a new tag with `ref`, then use it as a parent or attach notes to it.

```json
{ "changes": [
  { "kind": "tag_create", "title": "Work", "ref": "@work" },
  { "kind": "tag_create", "title": "NVIDIA", "parent": "@work", "ref": "@nv" },
  { "kind": "tag_attach", "uuid": "@nv", "noteUuid": "<note uuid>" },
  { "kind": "tag_update", "uuid": "<tag uuid>", "revision": "<revision>", "parent": "@work" }
] }
```

Moves that would make a tag its own ancestor are refused.

## How a write works

1. The agent reads notes. Each read includes a revision.
2. The agent calls `writes_prepare` or `writes_prepare_batch` with the changes and those revisions. Nothing
   is sent; you get an operation ID.
3. You review and approve it in your terminal:

   ```text
   $ standardnotes-mcp approve 3f0c2a9e-6b1d-4c8e-9a51-7d2f0b4e8c13
   Operation 3f0c2a9e-6b1d-4c8e-9a51-7d2f0b4e8c13 (prepared), expires 2026-10-25T05:12:00.000Z
   Characters shown as ⟦U+XXXX⟧ are invisible or control characters in the note content; a ⟦ typed in a note shows as ⟦U+27E6⟧.

   Batch of 3 item(s): {"tag_attach":2,"note_trash":1,"note_update":1}

   [1/3] Tag "Travel" a1b2c3d4-0000-4000-8000-000000000001
       change: tag_attach+tag_attach
       references:
         + Note "Kyoto itinerary" a1b2c3d4-0000-4000-8000-000000000002
         + Note "Packing list" a1b2c3d4-0000-4000-8000-000000000003

   [2/3] Note "Packing list" a1b2c3d4-0000-4000-8000-000000000003
       change: note_update
       title:
         from: "packing"
         to:   "Packing list"

   [3/3] Note "https://example.com" a1b2c3d4-0000-4000-8000-000000000004
       change: note_trash
       trashed:
         from: null
         to:   true

   Type "approve 3f0c2a9e-…" to allow exactly this operation, or "reject" to refuse it permanently:
   ```

   Every changed field is shown in full. Invisible and control characters in note text are shown as
   markers, and so is the marker's own bracket, so a note can neither hide a change nor fake a marker.
   `--json` prints the raw stored preview.
4. The agent calls `writes_commit`. If any item changed since it was read, or the commit fails before
   sending, nothing is sent and the approval stays usable until it expires. The result is read back from
   the server before it is reported as saved.
5. If something went wrong mid-way, `writes_status` says which items landed; retrying the same operation
   ID only reconciles and never sends twice. `writes_undo_prepare` stages an undo, which you approve the
   same way.

## Install

Requires Node.js ≥ 22.12, a working OS keychain (macOS Keychain, Linux Secret Service, Windows Credential
Manager) and a Standard Notes account (official cloud or self-hosted).

```bash
git clone https://github.com/delirious6423/mcp-standardnotes.git standardnotes-mcp
cd standardnotes-mcp
npm ci && npm run build
bin/standardnotes-mcp login        # email, password, 2FA; stored only in the OS keychain
```

Add the server to your MCP client (Claude Code `~/.claude.json`, Claude Desktop, Pi, or any stdio client):

```json
{
  "mcpServers": {
    "standardnotes": {
      "command": "/absolute/path/to/standardnotes-mcp/bin/standardnotes-mcp",
      "args": ["serve"]
    }
  }
}
```

No password or email goes in this file. Approve writes with `bin/standardnotes-mcp approve <operation-id>`
(add `bin/` to your `PATH` to shorten it). On Windows, run the same commands with
`node dist/index.js` and `node dist/cli/<login|approve>.js` in place of the launcher.

Sign out with `bin/standardnotes-mcp logout`. More detail, including crash recovery and uninstalling:
[docs/LOCAL-SETUP.md](docs/LOCAL-SETUP.md).

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `SN_EMAIL` | the only saved account | Which account to use when several are logged in |
| `SN_SERVER_URL` | `https://api.standardnotes.com` | Self-hosted sync server ([docs/self-hosted.md](docs/self-hosted.md)) |
| `SN_CERT_FINGERPRINT` | unset | Pin a self-hosted server's TLS certificate (SHA-256) |
| `SN_STATE_DIR` | `$DATA_DIR/standardnotes-mcp`, else the OS state directory | Where encrypted operation and recovery records live |
| `SN_CACHE_TTL_MS` | see [src/sn/cache.ts](src/sn/cache.ts) | How long a synced vault is reused within one process |
| `SN_ALLOW_LEGACY_UUID_MISMATCH` | unset | `1` reads old 003 notes whose embedded ID differs from the server's (read-only) |
| `KEYCHAIN_SERVICE` | `mcp-standardnotes` | Keychain entry name |

## Privacy and safety

- Decryption happens on your machine with libsodium; the server never sees plaintext. Sessions and keys
  live in the OS keychain. The MCP server talks over stdio and opens no network port.
- Whatever the agent reads is sent to its model provider. Use a local model if that matters to you.
- Note content is treated as untrusted data; the server instructions tell the agent not to follow commands
  or links found in notes.
- Protected notes are never returned, searched or changed. Edit-locked notes are readable but not writable.
- Approval guards the MCP tool surface. It is not a sandbox: a process running as you with shell access
  can run the approve command itself. Don't give untrusted agents unrestricted shell access.
- Recovery records are encrypted with a separate key in your keychain. They are not a backup; keep your own.

Details: [docs/protocol-004.md](docs/protocol-004.md) and [SECURITY.md](SECURITY.md).

## Known limits

- The first call in a server process downloads the vault; later calls send only changes since then, and
  each commit re-reads the vault from scratch to confirm what landed. If the server still rate-limits
  (HTTP 429), every process for that account pauses for the server's `Retry-After` (at most 2 hours)
  and says so instead of retrying. Prefer `notes_get_batch` and `writes_prepare_batch` for bulk work.
- No tag deletion (by design); remove unwanted tags in the official app.
- On Windows, each process's first private-file check starts a PowerShell helper (about 2 s), so
  `approve` takes a few seconds there; later checks in the server take about 1 ms.
- Structured note types (Super, checklists, spreadsheets) can't have their body rewritten.

Planned work: [PLAN.md](PLAN.md).

## Development

```bash
npm run typecheck && npm run lint && npm test
```

Integration tests (real stdio clients, real keychain, synthetic server) run in a throwaway VM:
`bash tests/vm/run.sh` (Linux, Incus), `bash tests/vm/macos-run.sh` (macOS, Tart) and
`bash tests/vm/windows-run.sh` (Windows x64, Incus). See
[CONTRIBUTING.md](CONTRIBUTING.md).

## License and credits

[MIT](LICENSE). Original project by Guillaume Ferrari ([lozit](https://github.com/lozit)); this fork keeps
his copyright notice. Encryption design and API by [Standard Notes](https://standardnotes.com/);
primitives from [libsodium](https://doc.libsodium.org/) via libsodium-wrappers-sumo.
