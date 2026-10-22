#!/usr/bin/env bash
set -euo pipefail
# A throwaway keyring exists only inside this VM's test user account.
printf '%s' 'synthetic-test-keyring-password' | gnome-keyring-daemon --unlock --components=secrets
node tests/mcp-e2e.mjs
