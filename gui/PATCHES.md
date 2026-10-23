# Maintained patch layer for the GUI dependency graph

`Cargo.toml` `[patch.crates-io]` points at `vendor/*`, copies of the published crates (licenses kept) with the
edits below. `vendor/PATCHES.diff` is the exact diff of every vendored file that differs from the published
crate (`diff -ru` against `~/.cargo/registry/src/*/<crate>`); `vendor/OMITTED.txt` lists published files not
copied or deleted (tests, benches, examples, fonts, samples, scripts, CI files, `github*.rs`). Regenerate both
after any edit. The published `gpui = 0.2.2` /
`gpui-component = 0.5.1` pins stay in `[dependencies]`. No advisory ignore, `deny.toml` change or renamed
archived code: each advisory is removed by dropping unused code or moving to a maintained crate.

| Advisory leaf | Fix |
|---|---|
| zbus_names, zvariant, zvariant_derive | gpui: `ashpd`/`oo7` are now optional behind a non-default `portal` feature. Without it, file dialogs return `None`, Secret Service credentials return an error, URI opening uses the `open` crate fallback, and the XDG settings watcher (system theme/cursor) is not started. This GUI uses none of them. |
| async-std, rustls-pemfile | gpui_http_client: removed the reqwest client, GitHub download helpers, tar/gzip code and the multipart trait method. The `HttpClient` trait, `Url`, `Uri`, `StatusCode` and `NullHttpClient` that gpui uses remain. |
| ttf-parser (3), rustybuzz (2) | gpui: `cosmic-text` 0.14 → 0.19 (API port in `platform/linux/text_system.rs`: font weight arguments, `Ellipsize`, `Hinting`), `usvg`/`resvg` 0.45 → 0.48. Vendored `cosmic-text` 0.19.0 changes `fontdb` `^0.23` → `^0.24` (the release still pins the older fontdb) and drops its test/bench targets and dev-dependencies. |
| paste | gpui-component: `paste` → `pastey` (maintained fork, same macro). metal 0.29.0 (macOS only): `paste` → `pastey`. `image` crate default features replaced by the six formats gpui decodes (drops exr/pulp and avif/rav1e). |
| instant, proc-macro-error2, unsafe-libyaml | gpui: `stacksafe` 0.1 → 1; gpui_util: `futures-lite` 1 → 2; gpui-component: `notify` 7 → 8, `rust-i18n` 3 → 4. |

`libc` stays pinned to 0.2.186 in `Cargo.lock` (0.2.191 removed `ENOATTR`, breaking `xattr`).

Verified on the host (Linux x86_64): `cargo check/clippy -D warnings/fmt --locked`, `cargo deny check` exit 0.
NOT verified: Rust tests/linking (need the Linux VM), rendering with the new text/SVG stack, the Windows and
macOS builds (macOS metal/pastey and the Windows graph), and runtime behavior with the `portal` feature on.
Every platform gate must be rerun on this graph.

Known limits (accepted, documented):
- `portal` off: the system dark/light preference and cursor theme are not followed (appearance stays Light), file
  dialogs and Secret Service credentials from gpui are unavailable (this app uses none of them).
- Linux text: glyphs are rasterized at each loaded face's own weight while cosmic-text 0.19 shapes with the
  requested weight. They differ only for a fallback variable font chosen by cosmic-text; the app and its
  components request only regular weight. Fix if bold fallback text is ever needed: key `LoadedFont` by
  `(fontdb::ID, Weight)`.
- The approval label shows the account email only; journals are keyed by (server, email) but non-default servers
  are test-only (`SN_ALLOW_LOCAL_TEST_SERVER`).
