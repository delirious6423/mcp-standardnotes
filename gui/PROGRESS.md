# Native GPUI frontend status

## Implemented

- `standardnotes-connection`: native GPUI 0.2.2 + GPUI Component 0.5.1, edition 2024.
- Responsive background one-shot JSONL helper calls; strict framing/ID checks, 90s deadline,
  128 MiB fail-closed response bound, child stderr discarded, safe fixed error messages.
- Portable helper/runtime lookup; no credentials/note text in arguments, environment additions,
  logs or temp files. Close kills/reaps the exact owned active child; final authorization first
  waits for durable acknowledgement or timeout.
- Email, masked password/MFA, check/sign-in, confirmed disconnect, explicit agent enablement.
- Virtualized pending operations and complete plain-JSON previews, Unicode-safe chunking,
  horizontal scrolling, visible embedded consent checkmark, guarded Approve and durable Reject.
- Approval launch mode returns success only on matching UUID + backend `approved:true`.
- Exact user-approved MPL exceptions and notices; no advisory suppressions.
- Fresh-review fixes: explicit private account selection after login/check, no stale Connected
  status after failure, masked credential Copy/Cut capture before clipboard writes (keyboard/menu
  dispatch), and canonical `SN_GUI_PATH` on helper children for portable agent configuration.
- Existing-client manual import: separate validated **Copy MCP settings** snippet; no existing
  client configuration/credential tokens are copied and no snippet can enable note approval.
- Windows cleanup statically implemented: a live owned Node child is tree-terminated through
  absolute SystemRoot/System32/taskkill.exe with `/PID <owned> /T /F`, a 10s command deadline,
  and exact-child kill/reap fallback. This Windows-only branch has not been executed here.

## Verified on Linux host (no app/helper launch)

- `cargo fmt --all --check`: PASS.
- `cargo clippy --all-targets --all-features -- -D warnings`: PASS for application code.
- `cargo test --all-features`: PASS, 19 pure Linux unit tests, 0 failures (approval identity change).
  Four Windows-only path tests replace one non-Windows case, so current Windows expected total is 22;
  that platform-specific build/run is not established by these Linux checks.
- `cargo test --doc`: PASS, 0 doctests.
- `cargo machete`: PASS, no unused direct dependencies.
- `cargo build`: PASS, debug executable `target/debug/standardnotes-connection` (155 MiB).
- `cargo deny check licenses sources`: PASS. Full deny: bans/licenses/sources PASS,
  advisories FAIL on the upstream unmaintained packages listed below.

The host lacks the development linker alias for xkbcommon-x11, but already has its runtime library.
With main-agent approval, build checks used only a test-owned symlink:
`$DATA_DIR/cache/standardnotes-mcp/build-libs/libxkbcommon-x11.so` →
`/usr/lib/x86_64-linux-gnu/libxkbcommon-x11.so.0`, supplied through `LIBRARY_PATH`.
No host packages, services, desktop settings or keychains were changed. No application/helper
process or GUI was launched. Cargo intermediates remain in the configured DATA_DIR build cache.

The lockfile pins libc 0.2.186: 0.2.191 removed Linux `ENOATTR`, breaking GPUI's xattr 0.2.3
through `gpui_http_client → zed-async-tar`. Build/check regression passed with the lockfile pin.

## Approval identity regression fix (new native acceptance required)

A new pure test first failed on the old approval guard: a prepared preview with no backend account
identity still enabled Approve. The guard now requires top-level backend `email` and strict boolean
`accountBound: true` (local journal-account binding, not cloud verification), matching the account pinned for the operation. Missing, malformed,
ambiguous or mismatched identity fails closed; identity inside note content does not count.
Approval mode always renders the confirmed email in a read-only label, never an editable selector;
inherited email alone is shown only as unverified. Exact backend identity is then pinned on later
Approve/Reject RPCs. Main owns the coordinated backend identity metadata implementation.

Historical native acceptance on the prior frozen source is not acceptance of this UI change.
All three native platform reruns remain pending, and installation remains on explicit hold until the
14 upstream maintenance findings are addressed. No advisory ignores or dependency changes were made.

## Display-fit regression fix

Native macOS VM evidence showed the original 1120px window starting at negative X on a 1024px
display. Initial bounds now use GPUI's primary display bounds, capped at 1120×820 with 16px side
margins and 48px vertical margins for desktop/window chrome. A 1024×768 display produces 992×672
at (16,48), with a 760×520 minimum capped further on smaller displays. GPUI 0.2.2 exposes display
bounds but not a public work-area API. Compact spacing, equal-width shrinkable credential fields,
and wrapping toolbar controls preserve space; complete preview rows remain horizontally scrollable.
Three pure geometry tests cover 1024×768, a desktop with a nonzero display origin, and small viewports.
The revised native UI's visibility still requires the owning VM worker's verification.

## macOS build prerequisite adjustment

Target-specific `gpui = 0.2.2` enables official `runtime_shaders` on macOS only. Upstream build.rs
selects `emit_stitched_shaders` rather than the offline xcrun/metal compiler in this feature branch.
`cargo tree --locked --target aarch64-apple-darwin -e features -i gpui` confirms the feature is
selected; the equivalent Linux tree confirms it is absent. Linux locked check passes. Native macOS
build, Metal runtime rendering and all application tests remain unverified by this agent.

## Remaining checks / risks

Main agent owns disposable native Incus Ubuntu 26.04 testing through repository `tests/vm/run.sh`
and `~/code/dotfiles/lib/incus-vm.sh`, including actual window rendering, keyboard/pointer flow,
helper/keychain behavior, close/timeout child cleanup and backend durable approval/rejection.
Those application checks have **not** been run by this implementation agent.

macOS and Windows builds, actual runtime behavior, signing and packaging are unverified.
User requires all three platform VM tests to pass before installation. No installation, release
executable, portable distribution or external publication was produced. Complete binary-specific
transitive license attributions must accompany any future distribution. The main agent's fresh
review found account selection/status, clipboard and portable-launch metadata issues; fixes are
implemented above, including follow-up manual-import and Windows child-tree cleanup findings,
but runtime regressions and the reviewer's recheck are still pending.

## Unsuppressed upstream maintenance findings

Current full `cargo deny check` reports 14 unmaintained-package findings, not vulnerability advisories:

| Package/version | RustSec advisory |
| --- | --- |
| async-std 1.13.2 | RUSTSEC-2025-0052 |
| instant 0.1.13 | RUSTSEC-2024-0384 |
| paste 1.0.15 | RUSTSEC-2024-0436 |
| proc-macro-error2 2.0.1 | RUSTSEC-2026-0173 |
| rustls-pemfile 2.2.0 | RUSTSEC-2025-0134 |
| rustybuzz 0.14.1, 0.20.1 | RUSTSEC-2026-0206 |
| ttf-parser 0.20.0, 0.21.1, 0.25.1 | RUSTSEC-2026-0192 |
| unsafe-libyaml 0.2.11 | RUSTSEC-2024-0449 |
| zbus_names 4.3.5 | RUSTSEC-2026-0371 |
| zvariant 5.15.1 | RUSTSEC-2026-0370 |
| zvariant_derive 5.15.1 | RUSTSEC-2026-0372 |

These come from official GPUI/component dependencies (HTTP utility, renderer/font stack,
localization and desktop integration). This application never gives GPUI arbitrary remote URLs,
images, HTML or Markdown, and uses Node for Standard Notes HTTP; that does not make maintenance
findings disappear or prove absence of vulnerabilities. Current compatible dependency resolution
already selected these versions. Removing findings generally requires upstream migrations, not
blindly ignoring advisories. `proc-macro-error2` also emits a Rust future-incompatibility warning;
application Clippy diagnostics are clean. No advisory has been ignored or downgraded here.
