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
files = [p for p in pathlib.Path('src').rglob('*') if p.is_file()] + [pathlib.Path('package-lock.json')]
pathlib.Path(sys.argv[1]).write_text(''.join(f'{hashlib.sha256(p.read_bytes()).hexdigest()}  {p}\n' for p in sorted(files)))
PY
export PATH="$ROOT/tools/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export npm_config_cache="$ROOT/npm-cache"
export SN_VM_TEST=1
sw_vers
uname -m
xcode-select -p
df -h / /tmp
node --version
npm --version
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
node tests/mcp-e2e.mjs
printf 'PASS: macOS TypeScript checks, synthetic Keychain and MCP acceptance\n'
