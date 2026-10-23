#!/usr/bin/env bash
set -euo pipefail
export SN_VM_TEST=1
# A throwaway keyring exists only inside this VM's test user account.
printf '%s' 'synthetic-test-keyring-password' | gnome-keyring-daemon --unlock --components=secrets
SN_VM_TEST=1 node tests/gui-rpc-e2e.mjs
node tests/mcp-e2e.mjs
