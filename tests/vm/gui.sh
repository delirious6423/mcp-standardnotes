#!/usr/bin/env bash
# Native VM only: one private compositor, test keyring and synthetic fixtures.
set -euo pipefail
export SN_VM_TEST=1
XDG_RUNTIME_DIR="/run/user/$(id -u)"
export XDG_RUNTIME_DIR
OUT=/tmp/sn-gui-test
mkdir -p "$OUT"
python3 -I tests/test_gui_vision.py
python3 -I tests/test_gui_owner.py
cleanup() {
  local rc=$?
  for pid in "${POINTER_PID:-}" "${SWAY_PID:-}"; do
    [[ -z "$pid" ]] || kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf '%s' 'synthetic-test-keyring-password' | gnome-keyring-daemon --unlock --components=secrets
printf 'output * mode 1600x1000\nseat seat0 fallback true\n' > "$OUT/sway.conf"
WLR_BACKENDS=headless WLR_RENDERER=pixman WLR_LIBINPUT_NO_DEVICES=1 sway -c "$OUT/sway.conf" > "$OUT/sway.log" 2>&1 &
SWAY_PID=$!
for _ in $(seq 100); do
  SWAYSOCK=$(find "$XDG_RUNTIME_DIR" -maxdepth 1 -name 'sway-ipc.*.sock' -print -quit)
  [[ -z "$SWAYSOCK" ]] || break
  sleep .1
done
export SWAYSOCK
WAYLAND_DISPLAY=$(basename "$(find "$XDG_RUNTIME_DIR" -maxdepth 1 -type s -name 'wayland-*' -print -quit)")
export WAYLAND_DISPLAY
swaymsg -t get_version
python3 tests/vm/hold-pointer.py > "$OUT/pointer.log" 2>&1 &
POINTER_PID=$!
for _ in $(seq 50); do grep -q ready "$OUT/pointer.log" && break; sleep .1; done
grep -q ready "$OUT/pointer.log"
swaymsg -t get_inputs > "$OUT/initial-inputs.json"
jq -e 'any(.[]; .type == "keyboard")' "$OUT/initial-inputs.json" >/dev/null
export SN_GUI_PATH="$PWD/bin/standardnotes-connection" SN_E2E_GUI=1
SN_GUI_AUTH=1 node tests/gui-rpc-e2e.mjs
kill -0 "$POINTER_PID"
swaymsg -t get_inputs > "$OUT/after-auth-inputs.json"
jq -e 'any(.[]; .type == "keyboard")' "$OUT/after-auth-inputs.json" >/dev/null
# Sway clears its current keyboard when transient wtype exits; inventory alone is insufficient.
swaymsg 'input "0:0:wlr_virtual_keyboard_v1" repeat_rate 25' > "$OUT/reselect-keyboard.json"
jq -e 'all(.[]; .success)' "$OUT/reselect-keyboard.json" >/dev/null
if ! node tests/mcp-e2e.mjs; then
  echo "DEBUG: owned compositor/input fixture retained for ${SN_GUI_DEBUG_SECONDS:-0}s"
  sleep "${SN_GUI_DEBUG_SECONDS:-0}"
  exit 1
fi
printf '%s\n' 'PASS: native GPUI window and human approval integration'
