#!/usr/bin/env bash
# All process-launching, keychain and MCP tests run in a native throwaway VM.
set -euo pipefail
# Bash reads incrementally: keep one in-memory runner while agents edit the checkout.
if [[ "${SN_VM_RUNNER_FROZEN:-0}" != 1 ]]; then
  SN_VM_RUNNER_FROZEN=1
  runner_source=$(<"${BASH_SOURCE[0]}")
  bash -n <<< "$runner_source"
  eval "$runner_source"
  exit $?
fi
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DOTFILES="${DOTFILES:-$HOME/code/dotfiles}"
# Evidence goes to the machine's data volume when dotfiles define one (same lookup as bin/standardnotes-mcp).
if [[ -z "${DATA_DIR:-}" && -f "$DOTFILES/machines/$(hostname).env" ]]; then
  # shellcheck source=/dev/null
  . "$DOTFILES/machines/$(hostname).env"
fi
# shellcheck source=/dev/null
. "$DOTFILES/lib/incus-vm.sh"
cleanup() {
  local rc=$? evidence
  if [[ -n "$INCUS_VM" ]]; then
    incus_vm_owned || { echo "Refusing evidence/cleanup for an unowned VM" >&2; exit 1; }
  fi
  if [[ "$rc" != 0 && -n "$INCUS_VM" ]]; then
    evidence="${DATA_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}}/cache/standardnotes-mcp/$INCUS_VM"
    mkdir -p "$evidence"
    timeout 20 "${INCUS[@]}" file pull -r "$INCUS_VM/home/tester/.npm/_logs" "$evidence" >/dev/null 2>&1 || true
  fi
  if incus_vm_delete; then echo 'CLEANUP PASS: owned VM discarded'; else rc=1; fi
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Packages are installed once and kept in the warm VM snapshot.
INCUS_PACKAGES="nodejs npm build-essential python3 pkg-config libsecret-1-dev dbus-x11 gnome-keyring --no-install-recommends"
incus_vm_start standardnotes 4096 2
printf 'VM: '
# shellcheck disable=SC2016
timeout 20 "${GUEST[@]}" '. /etc/os-release; echo "$PRETTY_NAME"; mkdir -p ~/standardnotes-mcp'
tar --exclude=.git --exclude=node_modules --exclude=dist --exclude=target -C "$REPO" -cf - . | timeout 30 "${GUEST[@]}" 'tar -xf - -C ~/standardnotes-mcp'
# npm 9 shipped by the guest OS crashes resolving the updated peer/override graph.
# Registry-verified npm 11.21.1 supports guest Node 22.22.1; install only inside this VM.
timeout 180 "${GUEST[@]}" 'sudo npm install --global --ignore-scripts --no-audit --no-fund npm@11.21.1 && npm --version'
if [[ "${SN_UPDATE_LOCK:-0}" == 1 ]]; then
  timeout 300 "${GUEST[@]}" 'cd ~/standardnotes-mcp && rm package-lock.json && npm install --package-lock-only --ignore-scripts --no-audit --no-fund'
  timeout 20 "${INCUS[@]}" file pull "$INCUS_VM/home/tester/standardnotes-mcp/package-lock.json" "$REPO/package-lock.json"
fi
timeout 600 "${GUEST[@]}" 'cd ~/standardnotes-mcp && npm ci --no-audit --no-fund'
timeout 120 "${GUEST[@]}" 'cd ~/standardnotes-mcp && npm run typecheck && npm run lint && npm run build'
timeout 90 "${GUEST[@]}" 'cd ~/standardnotes-mcp && SN_VM_TEST=1 python3 tests/regression_canary.py'
timeout 240 "${GUEST[@]}" 'cd ~/standardnotes-mcp && npm test'
timeout 120 "${GUEST[@]}" 'cd ~/standardnotes-mcp && npm audit --audit-level=high'
if [ -f "$REPO/tests/mcp-e2e.mjs" ]; then
  timeout 120 "${GUEST[@]}" 'cd ~/standardnotes-mcp && dbus-run-session -- bash tests/vm/e2e.sh'
fi
# No guest accounts, keychain entries or operation state copied to host.
if [[ "${SN_INSTALL_ARTIFACTS:-0}" == 1 ]]; then
  # Stage then swap so live MCP clients never see a half-written dist/. node_modules is replaced
  # only on request: clients run from it.
  rm -rf "$REPO/dist.new"
  mkdir -p "$REPO/dist.new"
  timeout 20 "${GUEST[@]}" 'tar -cf - -C ~/standardnotes-mcp/dist .' | tar -xf - -C "$REPO/dist.new"
  [[ -f "$REPO/dist.new/index.js" ]] || { echo 'Staged dist is incomplete; installed dist untouched' >&2; exit 1; }
  rm -rf "$REPO/dist.old"
  [[ ! -e "$REPO/dist" ]] || mv "$REPO/dist" "$REPO/dist.old"
  mv "$REPO/dist.new" "$REPO/dist"
  if [[ "${SN_INSTALL_NODE_MODULES:-0}" == 1 ]]; then
    # Explicit local installation of VM-built dependencies; never run the app on the desktop as a test.
    timeout 60 "${GUEST[@]}" 'tar -cf - -C ~/standardnotes-mcp node_modules' | tar -xf - -C "$REPO"
  fi
fi
echo 'PASS: Ubuntu 26.04 native Incus VM checks (synthetic data; no cloud account)'
