# Troubleshooting

Commands below use the launcher in a checkout: `bin/standardnotes-mcp …` (or `standardnotes-mcp …` if
`bin/` is on your `PATH`).

### "Human approval required: ask the user to run `standardnotes-mcp approve ID` …"

Expected: the agent prepared a change and you have not approved it yet. Run the command it names in your own
terminal, read the preview, and type the phrase it asks for (or `reject`). Then let the agent call
`writes_commit` again. Previews expire after one hour ("Preview expired; prepare a fresh operation").

### "Approval requires your interactive terminal, not piped input"

`approve` refuses piped input on purpose, so an agent cannot approve its own writes by scripting it. Run
it yourself in a terminal window.

### "No session found" / "Keychain session does not match this account/server"

Sign in again with `standardnotes-mcp login`. If several accounts are signed in, set `SN_EMAIL` in the MCP
server's environment to the one you want (it must match the login email exactly). To switch accounts:

```bash
SN_EMAIL=old@example.com bin/standardnotes-mcp logout
bin/standardnotes-mcp login
```

### "Rate limited by Standard Notes until … No request was sent."

The server returned HTTP 429. Every server process for the account now waits until the time shown (the
server's `Retry-After`, at most 2 hours) instead of retrying. Wait it out. For bulk work use
`notes_get_batch` and `writes_prepare_batch`, which need one sync instead of one per item.

### "Operation … was not confirmed" / "Write outcome uncertain …"

The connection dropped or the server's reply did not prove the write landed. Do not prepare a replacement.
Retry `writes_commit` with the **same** operation ID: it only re-reads and reconciles, and never resends.
`writes_status` shows which items of a batch are confirmed.

### "Stale revision; reconcile before retry" / "Conflict: expected item changed …"

The note or tag changed after the agent read it (for example in the official app). Nothing was sent. Have
the agent read it again and prepare a new change.

### "Account is busy or has an unrecovered lock"

Another MCP process is using the account; retry in a moment. If a process crashed, stop every client that
uses this server, then run `bin/standardnotes-mcp unlock --clients-stopped`. It refuses while the lock owner
is still alive.

### "Note … is protected or locked"

Protected notes are never read or changed through MCP, and locked notes are never changed. Edit them in
the official app.

### "State directory must …" / "Private NTFS operation failed …"

The state directory (`SN_STATE_DIR`, or `$DATA_DIR/standardnotes-mcp`) must be a real directory owned by
you with mode 0700 (POSIX) or a user-only ACL (Windows NTFS, no junctions or symlinks on the path). Let the
connector create it. On Windows, a directory created from an Administrator shell is owned by
Administrators and is refused; remove it and let the connector recreate it.

### Server disconnects immediately in your MCP client

GUI clients do not inherit your shell's `nvm` setup and may find an old `node`. Use the launcher's absolute
path as the command, and make sure `node` on that client's `PATH` is version 22.12 or newer. The launcher
prints the reason to stderr if `dist/` or `node_modules/` is missing.

### "No items_key decrypted — likely wrong password or account not on protocol 004"

Check the password at login. If it is right, upgrade the account's encryption in the official Standard Notes app (Preferences → Security). Legacy
protocol 003 *items* inside an upgraded account are read-only here.

### keytar fails to install on Linux

`keytar` needs `libsecret` at build time: `sudo apt-get install libsecret-1-dev` (Debian/Ubuntu) or
`sudo dnf install libsecret-devel` (Fedora/RHEL).
