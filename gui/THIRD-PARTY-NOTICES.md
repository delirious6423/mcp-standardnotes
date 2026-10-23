# Native GUI dependency notices

`Cargo.lock` records the complete resolved dependency graph. Seven third-party crates are vendored with documented
modifications (see `PATCHES.md`, `vendor/PATCHES.diff`, `vendor/OMITTED.txt`); their original licenses and copyright
notices are kept in `vendor/*/LICENSE-*`. All other packages are unmodified registry sources.
The three version-specific MPL exceptions below were explicitly approved by the user. `deny.toml`
does not grant blanket permission for other MPL, GPL, AGPL, or LGPL dependencies.

## Frameworks

- [GPUI 0.2.2](https://crates.io/crates/gpui/0.2.2), Apache-2.0; [source](https://github.com/zed-industries/zed). Vendored and modified (portal feature gating, text-stack port); also vendored: gpui_http_client, gpui_util (Apache-2.0).
- [GPUI Component 0.5.1](https://crates.io/crates/gpui-component/0.5.1), Apache-2.0; [source](https://github.com/longbridge/gpui-component). Vendored and modified (dependency bumps, `pastey`).
- cosmic-text 0.19.0 (MIT OR Apache-2.0) and metal 0.29.0 (MIT OR Apache-2.0): vendored with dependency edits only.
- The complete generated license text for the resolved graph is `licenses/THIRD-PARTY-LICENSES.html` (regenerate with `cargo about generate -c about.toml licenses.hbs`).
- The checkmark SVG in `assets/check.svg` is original application artwork, not a third-party icon set.

## Approved MPL-2.0 dependencies

These unmodified packages remain under [Mozilla Public License 2.0](https://www.mozilla.org/en-US/MPL/2.0/).
Their exact corresponding source archives are linked below and must remain available to recipients
of a binary containing their covered code. The application is a larger work; these exceptions do not
relicense the rest of the application.

| Package | Why present | Corresponding source | Upstream |
| --- | --- | --- | --- |
| option-ext 0.2.0 | `gpui → zed-font-kit → dirs → dirs-sys` | [0.2.0 archive](https://crates.io/api/v1/crates/option-ext/0.2.0/download) | https://github.com/soc/option-ext |
| cbindgen 0.28.0 | GPUI build tool; not normally linked into the application | [0.28.0 archive](https://crates.io/api/v1/crates/cbindgen/0.28.0/download) | https://github.com/mozilla/cbindgen |
| dwrote 0.11.5 | Windows font implementation through `zed-font-kit` | [0.11.5 archive](https://crates.io/api/v1/crates/dwrote/0.11.5/download) | https://github.com/servo/dwrote-rs |

The local MPL text is in `licenses/MPL-2.0.txt`. Preserve it and this source notice when packaging.

## Additional permissive license expressions

The baseline allowlist remains MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, Unicode-3.0, Zlib.
The following additional permissive expressions were reviewed and explicitly recorded:

| Package | License | Source |
| --- | --- | --- |
| ar_archive_writer 0.5.3 | Apache-2.0 WITH LLVM-exception | https://github.com/rust-lang/ar_archive_writer |
| enum-iterator 2.3.0 | 0BSD | https://github.com/stephaneyfx/enum-iterator |
| enum-iterator-derive 1.5.0 | 0BSD | https://github.com/stephaneyfx/enum-iterator |
| hexf-parse 0.2.1 | CC0-1.0 | https://github.com/lifthrasiir/hexf |
| notify 7.0.0 | CC0-1.0 | https://github.com/notify-rs/notify |
| tiny-keccak 2.0.2 | CC0-1.0 | https://crates.io/crates/tiny-keccak/2.0.2 |
| workspace-hack 0.1.0 | CC0-1.0 | https://github.com/facebookincubator/cargo-guppy |
| libfuzzer-sys 0.4.13 | (MIT OR Apache-2.0) AND NCSA | https://github.com/rust-fuzz/libfuzzer |

This document identifies the framework and reviewed exceptions, not all transitive copyright
notices. Before publishing/distributing a binary, include target-specific dependency license texts
and attributions for the complete `Cargo.lock` graph, not just this exceptions summary.
