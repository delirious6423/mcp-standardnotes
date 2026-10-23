# Standard Notes Agent Connection

Native GPUI desktop frontend for the existing TypeScript connector. No browser, WebView, Zenity,
HTTP listener, or permanent desktop service. Build separately for Linux, macOS, and Windows on
matching native toolchains; a Linux executable is not a universal binary.

## Portable layout

```text
StandardNotesConnection/
  standardnotes-connection[.exe]
  dist/gui/bridge.js
  dist/...                       # full built TypeScript connector
  node_modules/...               # backend dependencies, native modules for this OS/architecture
  runtime/node[.exe]             # optional; otherwise Node.js must be on PATH
  THIRD-PARTY-NOTICES.md
  licenses/...
```

Launch the executable normally. Sign in with email, masked password, and optional masked MFA.
Use **Check connection**, **Enable agents**, or **Disconnect**. Disconnect requires confirmation
and does not delete server notes. Password/MFA input state (including undo history) is replaced
on login completion, except an MFA-required retry; window close also clears those inputs.
Copy/Cut actions are captured before masked credential editors, including context-menu action
dispatch, so password/MFA selections never intentionally enter the OS clipboard/history. Paste
remains available; copying the email selector remains available.

**Enable agents** invokes the backend's explicit configuration action. Its response reports how
many clients were configured, how many existing entries were preserved, and how many existing
configurations need explicit import. Existing client files are never rewritten. For manual import,
**Copy MCP settings** copies only a new `standardnotes` registration, never unrelated settings or
tokens. Paste it into the client's MCP settings/config editor; no CLI is required. This separate
settings snippet cannot become a note preview or enable approval. New configuration files may be
created atomically by the backend without replacing another writer's file.
The backend owns keychain storage, session verification and client configuration; no credentials
are put in client JSON by this frontend. Email also selects a saved account for **Check connection**.
The active account is shown explicitly. After choosing/signing into another account, subsequent
requests pin that account in private stdin JSON rather than reverting to inherited `SN_EMAIL`.
Starting a check/login immediately invalidates old Connected counts and previous-account previews;
a failed check cannot leave an old successful status visible.

Select a pending edit to review its exact saved before/after preview. The entire response is plain
JSON text, not Markdown/HTML. JSON escapes remain literal; direction controls are escaped. Long
lines are split into 48-Unicode-scalar rows. Both vertical virtualization and horizontal scrolling
keep all accepted content inspectable without truncation. An invalid or >128 MiB response disables
approval rather than presenting a partial preview. Check the explicit consent box before **Approve**.
**Reject** durably rejects that operation; this does not write to Standard Notes.

Agents launch the same executable with `--approve UUID`. Only the UUID goes in arguments.
This mode loads exactly that saved preview and shows its **backend-confirmed account email** in
a read-only **Approval account (pinned)** label. No account-switch inputs appear in approval mode.
The preview response must supply top-level `email` and `accountBound: true` from the same
backend context that opened the journal (local journal-account binding, not a cloud connectivity check). Missing, ambiguous or mismatched identity disables
approval; an inherited `SN_EMAIL` or identity embedded in note content does not count. Later
Approve/Reject requests explicitly pin that confirmed email. The app exits 0 only after the backend
acknowledges durable approval for that same UUID, and exits 1 on rejection or window close. While an approve/reject
transaction is finalizing, window-close is deferred until acknowledgement or timeout to avoid a
close/authorization race. This UI authorizes the operation; the agent sends the actual write later.

Cloud AI providers can see notes retrieved for their models even though Standard Notes sync is
end-to-end encrypted. Local inference avoids that particular provider disclosure.

## Helper discovery and transport

- Root: `SN_CONNECTOR_ROOT` override, otherwise executable ancestors containing
  `dist/gui/bridge.js`. There is no implicit checkout lookup, in debug builds either.
- Node: `SN_NODE_PATH` override, otherwise `runtime/node[.exe]` beside the executable, otherwise PATH.
- One child per RPC. One request line on stdin, then EOF. Exactly one response line on stdout.
- 90-second deadline; no automatic retries. Each child is killed/reaped on failure, timeout or close.
  Windows first tree-terminates the still-live owned Node PID through absolute SystemRoot taskkill
  (10s command deadline) so PowerShell/compiler descendants do not survive normal cleanup.
- No credentials or note data in arguments, environment, temp files, or application logs. Child stderr
  is discarded; backend error messages are not displayed or logged because they may contain secrets.
- Existing inherited backend environment remains available, but the GUI never inserts secrets into it.
  `SN_GUI_PATH` is set to this canonical executable path so configured clients launch this same app.

Methods: `status`, `check`, `login`, `disconnect`, `pending`, `preview`, `approve`, `reject`, `configure`.
Missing Node/helper, invalid responses and request failures appear as fixed, safe in-window messages.

## Build and safe checks

Stable Rust, edition 2024. Official `gpui = 0.2.2` and compatible `gpui-component = 0.5.1` are pinned;
no unofficial `gpui-pre` replacement is used. macOS alone enables GPUI's official `runtime_shaders`
feature, using the OS Metal runtime compiler instead of requiring Xcode's offline `metal` tool.
This does not establish macOS build/runtime acceptance; native VM testing remains required.
`Cargo.lock` pins libc 0.2.186 because 0.2.191 removed
Linux `ENOATTR`, breaking GPUI's transitive xattr 0.2.3. Recheck that compatibility before updating.

```sh
cd gui
cargo fmt --all --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features
cargo test --doc
cargo deny check
cargo machete
cargo build --release --locked
```

Linux needs the native link/runtime libraries required by GPUI (including xkbcommon-x11).
Do not install host dependencies or launch this app to test it. Pure unit/static/build checks may
run on the host only without app/helper initialization. **All GUI, subprocess, keychain and
integration/E2E tests run in a disposable native Incus Ubuntu 26.04 VM**, through the owning
repository's `tests/vm/run.sh` and dotfiles `~/code/dotfiles/lib/incus-vm.sh`. Never fall back to a
container or host app launch. Preserve unrelated VMs; cleanup must verify test ownership.

Installation is gated on successful Linux, macOS and Windows VM tests; a host-built executable
is only a test artifact until all three pass. The dependency graph uses the vendored maintained patch
layer in `PATCHES.md`; `cargo deny check` exits 0 on it (no ignores). Re-run it after any dependency or
vendor change. Approved MPL
exceptions and source/license notices are in `THIRD-PARTY-NOTICES.md` and `licenses/`.

## Threat model

Human approval protects the MCP tool surface. It is not an OS sandbox and not proof of human presence: any
process running as the same user with shell and keychain access can invoke this app's private bridge or the
connector directly. Do not give untrusted agents unrestricted shell access under your account.
