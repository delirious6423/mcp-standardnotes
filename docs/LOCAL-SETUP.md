# Local setup and operation

standardnotes-safe-mcp is a fork of lozit/mcp-standardnotes (MIT), branched from upstream `749d4662ca1c4c0183e6086cf1a43f681458ce25`. It is not published to npm and does not change the Standard Notes app.

## Privacy and access

- The default endpoint is the official service, `https://api.standardnotes.com`.
- All unprotected notes are in scope. Protected notes are masked/refused; edit-locked notes remain readable but cannot be changed or retagged.
- Standard Notes sync uses its protocol 004 encryption. Keys/sessions live in the OS keychain. Local MCP uses process pipes, not a listening HTTP service.
- Cloud agents send retrieved note plaintext to their model provider. TLS protects transit, not against that provider. Encrypting content so the provider cannot read it also prevents conventional model inference. Local inference avoids that disclosure (agent logs and remote control channels still matter).
- Recovery records, including exact before/after previews, are encrypted with a separate 256-bit key in the OS keychain. Files are 0600 and account directories 0700 on POSIX; on NTFS both get a protected ACL with one entry for your user. They contain sensitive history once decrypted. No plaintext vault mirror or index is written.
- Losing the recovery key makes local records unreadable. Logout removes the login session, not the recovery key. These records are NOT a substitute for a separate full vault backup. No retention/deletion automation is enabled.
- No telemetry added; connector traffic goes to the configured Standard Notes service. Model traffic is the agent client's responsibility.

## Installation and login

Requires Node ≥ 22.12, a working OS keychain (Linux Secret Service, macOS Keychain, Windows Credential Manager), and the pinned dependencies (`npm ci`, then `npm run build`). Do not run an unpinned npx package.

The launcher is `bin/standardnotes-mcp` in your checkout; it follows symlinks, so you can link it into a directory on your `PATH`. Integration tests run in throwaway VMs (`tests/vm/run.sh`, `macos-run.sh`, `windows-run.sh`); do not run them on your desktop.

State: set `SN_STATE_DIR` to a private absolute path, or `DATA_DIR` (`DATA_DIR=/mnt/data` gives `/mnt/data/standardnotes-mcp`); otherwise the OS state directory is used. If neither is set and `~/code/dotfiles/machines/<hostname>.env` exists, `DATA_DIR` is read from it as data, never run as shell code (the maintainer's machine convention). The terminal `approve` and the MCP server must resolve the same directory; set `SN_STATE_DIR` in both if you use neither convention. No password belongs in MCP JSON.

Sign in from your own interactive terminal:

```bash
bin/standardnotes-mcp login
```

The password prompt is masked; 2FA is prompted if needed. Check the displayed account, service and note count against the official app. Never paste credentials or decrypted backups into an agent conversation.

If you have one saved account, clients discover its email in the keychain. Multiple accounts require `SN_EMAIL` locally. Login never edits client configuration.

## One entry for compatible clients

```json
{
  "mcpServers": {
    "standardnotes": {
      "command": "/path/to/standardnotes-mcp/bin/standardnotes-mcp",
      "args": ["serve"]
    }
  }
}
```

Use the equivalent entry in each client's own configuration format. Each client starts a stdio process; account-wide filesystem locking serializes calls and fresh clients read keychain token rotation. Overlapping calls fail busy instead of racing; retry read/preparation later. A single installation does not mean all clients share one process.

## Tools and writes

Read tools: `notes_list`, `notes_search`, `notes_get`, `notes_get_batch` (up to 200 notes, one sync), `notes_stats`, `tags_list`, `tags_get`. Reads of an individual item include an opaque revision paired with that exact ciphertext snapshot.

1. Agent calls `writes_prepare` with one change. Available kinds: `note_create`, `note_update` (replace body, append, rename), `note_trash`, `note_restore`, `note_flags` (`archived`, `pinned`, `starred`), `note_merge` (batch only; `title`, 2–50 `sources` with revisions, optional `headings`, `separator`, `trashSources`, `noteType`; new note plus the sources' tags, sources trashed by default, one-step undo), `tag_create` (optional `parent`, `ref`), `tag_update` (rename and/or move; `parent: null` for top level), `tag_attach` (also to a `@ref` tag created earlier in the same batch, without revision), `tag_detach`. Existing-item changes require the read revision. Body writes support plain-text/Markdown only; structured-note body conversion is deliberately unavailable. Body edits refresh the derived plain preview and remove stale HTML previews; renames/trash preserve them.

   For more than a few changes, call `writes_prepare_batch` with up to 200 changes instead: one sync, one preview, one approval. Several changes to the same item compose in order and must cite the same revision. Commit is all-or-nothing at preflight: if any item is stale, protected or changed, nothing is sent. Items are pushed in chunks of 50 and read back; if only some land, the operation becomes `uncertain`, `writes_status` lists the unconfirmed items, and retrying the same operation UUID only reconciles. Undo of a batch stages one recovery batch. For an `uncertain` batch, undo covers only items that landed (exact never-applied items are skipped; any other change is a conflict). Created tags are kept and listed in `skipped`. During commit, a server conflict or cancellation stops the remaining chunks.
2. The user approves in their own terminal: `bin/standardnotes-mcp approve OPERATION_UUID`. It prints every changed field of every item (nothing truncated; invisible, control and bidi characters, and `⟦` itself, shown as `⟦U+XXXX⟧`), then asks for the typed phrase `approve OPERATION_UUID`, or `reject` to refuse it permanently. `--json` prints the raw stored preview instead. Previews expire after one hour. There is no MCP approval tool, and the command refuses piped input.

   **Threat model:** human approval protects the MCP tool surface. It is not an OS sandbox and not proof of human presence: any process running as your user with shell and keychain access can run the approve command under a pseudo-terminal, or call the connector directly, and approve its own write. Do not give untrusted agents unrestricted shell access under your account; stronger isolation (separate user/service, OS user-presence prompt) is a separate design that is not implemented.
3. Agent calls `writes_commit` with the saved operation UUID. Without approval it fails and sends nothing. Recovery records are durable before transmission; conflicts fail closed. The server reads the result back before confirming it.
4. After an uncertain outcome, inspect `writes_status`. Retry ONLY the same operation UUID to reconcile. Previously attempted operations never resend; they can confirm an exact applied ciphertext or fail closed. Do not create a replacement operation blindly.
5. `writes_undo_prepare` stages recovery of a confirmed operation only if the item still matches what it wrote. Approve and commit the new preview separately. New-note undo uses Trash; tag creation cannot be undone through MCP.

There is no permanent deletion or tag deletion tool. Tags have no reversible trash in Standard Notes, so remove obsolete tags manually in the official app. No cross-format conversion or scheduling is exposed by the safe interface.

## Crash recovery and uninstalling

After a killed process, stop ALL connector clients, then:

```bash
bin/standardnotes-mcp unlock --clients-stopped
```

Only after an incomplete lock error, and only with all clients stopped:

```bash
bin/standardnotes-mcp unlock --clients-stopped --incomplete-lock
```

Live PID locks are refused. No age-based lock stealing is used. Operation ciphertext is preserved.

To disconnect: remove the `standardnotes` MCP entry from your clients (and from any tool that regenerates client configuration), then run `bin/standardnotes-mcp logout` with the same account selection. Do not delete recovery keychain entries or state files unless you explicitly intend to destroy that recovery history. Nothing is installed as a service.

## Acceptance limits

Synthetic HTTP tests are not proof of current official-cloud acceptance, rate limits, or official-editor compatibility. Before real writes: keep an encrypted full backup, rehearse on a throwaway official-cloud account, and open created/edited/trashed/restored notes in the official app. Compare counts and metadata, including another device's concurrent edits. No account creation or production note access is automated.

The shared lock covers our MCP clients, not the official app. Server timestamp compare-and-swap detects ordinary concurrent edits; the server has no cross-item transaction for a tag write plus a note protection check. A note can become protected in another client between the final check and a separate tag write. Ordinary cloud API processing inherently cannot provide a cryptographic privacy boundary from the model provider.
