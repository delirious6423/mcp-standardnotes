#!/usr/bin/env bash
# Windows x64 gate in a throwaway copy of the dotfiles native Windows golden VM (vm/windows/run.sh):
# npm ci, typecheck, build, unit tests incl. VM-only NTFS ACL checks, and the MCP e2e with the real
# Credential Manager (guest side: windows-guest.ps1). Portable Node from nodejs.org (SHA-256 checked).
# The copy is discarded afterwards.
set -euo pipefail
SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DOTFILES="${DOTFILES:-$HOME/code/dotfiles}"
# shellcheck source=/dev/null
. "$DOTFILES/vm/windows/common.sh"
RUN="$DOTFILES/vm/windows/run.sh"
[ ! -e "$N/run" ] && [ ! -L "$N/run" ] || { echo 'BLOCKED: a Windows run exists (someone else'"'"'s?); not touching it' >&2; exit 1; }
NODE=v22.22.1
CACHE="$DATA_DIR/cache/node"
ZIP="$CACHE/node-$NODE-win-x64.zip"
mkdir -p "$CACHE"
if [ ! -f "$ZIP" ]; then
    curl -fsS --max-time 300 -o "$ZIP.part" "https://nodejs.org/dist/$NODE/node-$NODE-win-x64.zip"
    mv "$ZIP.part" "$ZIP"
fi
want=$(curl -fsS --max-time 30 "https://nodejs.org/dist/$NODE/SHASUMS256.txt" | awk -v f="node-$NODE-win-x64.zip" '$2 == f {print $1}')
[ -n "$want" ] && [ "$(sha256sum "$ZIP" | cut -d' ' -f1)" = "$want" ] || { echo 'Node zip checksum mismatch' >&2; rm -f "$ZIP"; exit 1; }

OUT=$(mktemp -d)
# Same file list as the macOS gate: no host dependencies, build output, credentials or caches.
tar -C "$SOURCE" -cf "$OUT/source.tar" bin src tests package.json package-lock.json tsconfig.json .eslintrc.cjs LICENSE
OWNED=0
cleanup() {
    local rc=$?
    trap - EXIT INT TERM
    rm -rf "$OUT"
    if [ "$OWNED" = 1 ]; then "$RUN" --stop || rc=1; fi
    exit "$rc"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

"$RUN" > /dev/null
OWNED=1
read_reference "$N/run"
set_ssh "$REF_NAME"
SCP=(scp -q -i "$KEY" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null)
timeout 300 "${SCP[@]}" "$ZIP" "$OUT/source.tar" "$SOURCE/tests/vm/windows-guest.ps1" "${SSH[-1]}:"
# -ExecutionPolicy Bypass applies to this one process; the guest policy is unchanged.
timeout 3000 "${SSH[@]}" "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \$HOME\\windows-guest.ps1 -Node $NODE; exit \$LASTEXITCODE" | tr -d '\r'
