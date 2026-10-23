#!/usr/bin/env bash
# Runs only in the disposable Tart guest created by macos-run.sh.
set -euo pipefail
: "${SN_MAC_TOKEN:?owned guest token required}"
ROOT="/tmp/sn-acceptance-$SN_MAC_TOKEN"
[[ "$(< "$ROOT/owner")" == "$SN_MAC_TOKEN" ]] || exit 1
[[ "$(/usr/sbin/sysctl -n hw.model)" == VirtualMac* && "$(/usr/sbin/sysctl -n kern.hv_vmm_present)" == 1 ]] || { echo 'Refusing non-VM macOS host'; exit 1; }
cd "$ROOT/source"
mkdir -p "$ROOT/artifacts"
python3 - "$ROOT/artifacts/source-sha256.txt" <<'PY'
import hashlib, pathlib, sys
files = [p for root in ('src', 'gui/src', 'gui/assets', 'gui/vendor') for p in pathlib.Path(root).rglob('*') if p.is_file()]
files += [pathlib.Path(p) for p in ('package-lock.json', 'gui/Cargo.toml', 'gui/Cargo.lock')]
pathlib.Path(sys.argv[1]).write_text(''.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p}\n' for p in sorted(files)))
PY
export PATH="$ROOT/tools/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export CARGO_HOME="$ROOT/cargo" CARGO_TARGET_DIR="$ROOT/target"
export CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0
export CARGO_BUILD_JOBS=4
export npm_config_cache="$ROOT/npm-cache"
export SN_VM_TEST=1
sw_vers
uname -m
xcode-select -p
df -h / /tmp
node --version
npm --version
[[ "$(df -Pk /tmp | awk 'NR==2 {print $4}')" -ge 12000000 ]] || { echo 'BLOCKED: less than 12 GB free in guest'; exit 1; }
mkdir -p "$ROOT/downloads" "$ROOT/tools"
URL=https://static.rust-lang.org/dist/2026-10-15/rust-1.99.1-aarch64-apple-darwin.tar.xz
HASH=30976378b6aaefd1861ba475905c6ba22a44c981418ce52285006af26337f98c
curl -fLsS --max-time 30 https://static.rust-lang.org/dist/channel-rust-stable.toml -o "$ROOT/downloads/stable.toml"
python3 - "$ROOT/downloads/stable.toml" "$URL" "$HASH" <<'PY'
import sys
text=open(sys.argv[1]).read()
section=text.split('[pkg.rust.target.aarch64-apple-darwin]\n',1)[1].split('\n[',1)[0]
assert f'xz_url = "{sys.argv[2]}"' in section
assert f'xz_hash = "{sys.argv[3]}"' in section
print('PASS: current official stable archive and checksum match')
PY
curl -s -o /dev/null --max-time 10 -w 'Rust download probe: %{speed_download} bytes/sec\n' "$URL" || [[ "$?" == 28 ]]
curl -fL --connect-timeout 20 --max-time 900 --progress-bar "$URL" -o "$ROOT/downloads/rust.tar.xz"
printf '%s  %s\n' "$HASH" "$ROOT/downloads/rust.tar.xz" | shasum -a 256 -c -
tar -xf "$ROOT/downloads/rust.tar.xz" -C "$ROOT/downloads"
bash "$ROOT/downloads/rust-1.99.1-aarch64-apple-darwin/install.sh" --prefix="$ROOT/tools" --disable-ldconfig
rm -rf "$ROOT/downloads/rust-1.99.1-aarch64-apple-darwin" "$ROOT/downloads/rust.tar.xz"
rustc --version
cargo --version
# npm 9 cannot consume this lockfile; upgrade only the guest-owned tool directory.
npm install --prefix "$ROOT/tools/npm" npm@11.21.1 --no-audit --no-fund
export PATH="$ROOT/tools/npm/node_modules/.bin:$PATH"
npm --version
npm ci --no-audit --no-fund
npm run typecheck
npm run build
npm test
# Isolated synthetic keychain; never unlock or inspect an existing guest/host keychain.
KEYCHAIN="$ROOT/synthetic.keychain-db"
security create-keychain -p 'SYNTHETIC-VM-ONLY' "$KEYCHAIN"
security set-keychain-settings -lut 21600 "$KEYCHAIN"
security unlock-keychain -p 'SYNTHETIC-VM-ONLY' "$KEYCHAIN"
security list-keychains -d user -s "$KEYCHAIN"
security default-keychain -d user -s "$KEYCHAIN"
node tests/gui-rpc-e2e.mjs
node tests/mcp-e2e.mjs
cd gui
cargo fmt --all --check
cargo clippy --locked --all-targets --all-features -- -D warnings
cargo test --locked --all-features
cargo test --locked --doc
cargo build --locked
printf 'PASS: macOS native Rust checks/build, TypeScript, synthetic Keychain/RPC and MCP acceptance\n'
# A separate GUI acceptance stage must prove native window/interaction, not infer it from build.
if [[ -f ../tests/vm/macos-gui.sh ]]; then
  cd ..
  bash tests/vm/macos-gui.sh
else
  echo 'BLOCKED: native macOS GUI interaction driver not yet available'
  exit 2
fi
