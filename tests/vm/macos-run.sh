#!/usr/bin/env bash
# Native macOS guest only; no installs or application launches on the Mac host.
set -euo pipefail
DOTFILES="${DOTFILES:-$HOME/code/dotfiles}"
SOURCE=$(cd "$(dirname "$0")/../.." && pwd)
TOKEN=$(python3 -c 'import uuid;print(uuid.uuid4())')
export MAC_VM="sn-connection-${TOKEN:0:8}"
# shellcheck source=/dev/null
. "$DOTFILES/vm/macos/common.sh"
OWNER="/tmp/$MAC_VM.owner"
CLAIMED=0
cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  if [[ "$CLAIMED" == 1 ]]; then
    # The name was absent before our atomic claim. A matching token is required to stop it.
    if ! mac "test \"\$(cat '$OWNER/token')\" = '$TOKEN'"; then
      echo 'FAIL: ownership mismatch; refusing VM cleanup' >&2
      exit 1
    fi
    # Collect only synthetic screenshots/metadata, never guest keychains or credentials.
    local evidence="/tmp/$MAC_VM.artifacts"
    mkdir -p "$evidence"
    # shellcheck disable=SC2016 # Positional arguments expand in the child shell.
    timeout 30 bash -c '
      source "$1/vm/macos/common.sh"
      vm_ssh "test ! -d /tmp/sn-acceptance-$2/artifacts || tar -cf - -C /tmp/sn-acceptance-$2/artifacts ."
    ' _ "$DOTFILES" "$TOKEN" | tar -xf - -C "$evidence" 2>/dev/null || true
    echo "Synthetic evidence: $evidence"
    if ! timeout 150 bash "$DOTFILES/vm/macos/run.sh" --stop; then rc=1; fi
    if mac 'tart list -q --source local' | grep -Fxq "$MAC_VM"; then
      echo "FAIL: owned VM remains: $MAC_VM" >&2
      rc=1
    else
      mac "rm -f '$OWNER/token' '/tmp/$MAC_VM.log'; rmdir '$OWNER'" || rc=1
      echo "CLEANUP PASS: token-verified $MAC_VM absent; tahoe-base/unrelated VMs preserved"
    fi
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mac 'tart list -q --source local' > "/tmp/$MAC_VM.before"
if grep -Fxq "$MAC_VM" "/tmp/$MAC_VM.before"; then echo 'Refusing existing VM name' >&2; exit 1; fi
mac "mkdir '$OWNER' && printf '%s' '$TOKEN' > '$OWNER/token'"
CLAIMED=1
echo "VM=$MAC_VM ownership=$TOKEN"
# Reuse the shared native lifecycle/settings, but disable host clipboard/device channels explicitly.
mac 'tart list -q --source local' | grep -Fxq "$BASE"
[[ -f "$KEY" && -f "$KEY.pub" ]] || { echo 'BLOCKED: run dotfiles macOS preflight to create its test SSH key' >&2; exit 1; }
mac "tart clone '$BASE' '$MAC_VM' && tart set '$MAC_VM' --display 1024x768pt --no-display-refit && (nohup tart run --no-graphics --no-clipboard --no-audio --no-usb-accessories '$MAC_VM' > '/tmp/$MAC_VM.log' 2>&1 < /dev/null &)"
T=300 mac "for i in \$(seq 100); do tart exec '$MAC_VM' true 2>/dev/null && exit 0; sleep 3; done; exit 1"
mac "tart exec -i '$MAC_VM' sh -c 'mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys'" < "$KEY.pub"
# shellcheck disable=SC2016 # Positional arguments expand in the child shell.
timeout 30 bash -c 'source "$1/vm/macos/common.sh"; vm_ssh true' _ "$DOTFILES"
echo "PASS: owned native VM ready; host clipboard/audio/USB channels disabled"
ROOT="/tmp/sn-acceptance-$TOKEN"
T=30 mac "tart exec '$MAC_VM' sh -c 'mkdir -p $ROOT/source; printf %s $TOKEN > $ROOT/owner'"
# Never transfer host dependencies, credentials, caches, or platform-specific build output.
# shellcheck disable=SC2016 # Positional arguments expand in the child shell.
tar --exclude=.git --exclude=node_modules --exclude=dist --exclude=.serena \
  -C "$SOURCE" -cf - bin src tests package.json package-lock.json tsconfig.json .eslintrc.cjs LICENSE | timeout 120 bash -c '
  source "$1/vm/macos/common.sh"
  vm_ssh "tar -xf - -C $2/source"
' _ "$DOTFILES" "$ROOT"
# The timeout kills the guest SSH session; VM discard removes all test processes and credentials.
export SN_MAC_TOKEN="$TOKEN"
# shellcheck disable=SC2016 # Positional arguments expand in the child shell.
timeout 7200 bash -c '
  source "$1/vm/macos/common.sh"
  vm_ssh "SN_MAC_TOKEN=$2 bash /tmp/sn-acceptance-$2/source/tests/vm/macos-guest.sh"
' _ "$DOTFILES" "$TOKEN"
