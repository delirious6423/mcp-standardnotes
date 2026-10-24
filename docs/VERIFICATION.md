# Verification

Gate (from a checkout): `bash tests/vm/run.sh`. It runs in a throwaway Incus VM with synthetic data only;
add `SN_UPDATE_LOCK=1` to regenerate the lockfile inside the VM.

Latest Linux result (2026-10-25, Ubuntu 26.04.1 LTS, Node 22, npm 11.21.1 in the VM):

```text
TypeScript / ESLint / build: PASS
PASS regression canary: old protected-search behavior fails its assertion; fixed source restored
PASS regression canary: preflight cancellation fails without any of the three send-boundary guards
Test Files 23 passed (23)
Tests      235 passed | 5 skipped (240)
found 0 vulnerabilities
PASS: 100 assertions, two real stdio MCP clients, real OS keychain, encrypted recovery, stale edits,
      timeout/retry, token rotation and exclusion
PASS: Ubuntu 26.04 native Incus VM checks (synthetic data; no cloud account)
CLEANUP PASS: owned VM discarded
```

Latest macOS result (2026-10-25, macOS 26.6.2 arm64 Tart VM on Apple Silicon, Node 24.21.0):
`bash tests/vm/macos-run.sh` PASS — unit tests and 100 e2e assertions with a synthetic Keychain; the VM
was token-verified and deleted.

Latest Windows result (2026-10-25, Windows 11 build 26300 x64 Incus VM, Node 22.22.1, npm 10.9.4):
`bash tests/vm/windows-run.sh` PASS — 232 unit tests passed, 8 skipped (POSIX-only and test-double
cases), including the native NTFS ACL suite; 84 e2e assertions against the real Credential Manager. The
e2e runs as a scheduled task in the tester's desktop session, because Credential Manager refuses
key-authenticated SSH logons. The VM copy was discarded.

Windows private-file checks, one long-lived process, 50 calls after the first (same VM run,
`tests/private-fs-bench.mjs`):

```text
before (PowerShell per check): first 1577 ms, then median 901.6 ms, max 1435.2 ms
after (one helper per process): first 1895 ms, then median 1.0 ms, max 2.1 ms
```

The end-to-end suite approves and rejects through the real `approve` command in a pseudo-terminal
(`tests/approve-pty.py` types only after the prompt). Windows has no pty module, so it approves through
the same journal call the CLI makes.

The batch-write changes passed an independent adversarial review; its four findings were fixed with
regression tests that fail when the fix is removed.

## Not claimed

- Windows ARM64 and Linux ARM64 have not been run. On Windows the e2e approves through the journal call,
  not the interactive `approve` prompt.
- Synthetic HTTP tests are not proof of official-cloud behavior, rate limits or official-app rendering.
  Legacy 003 reads were round-tripped once against a real account in the official app.
- Approval is not a sandbox against an agent with unrestricted shell access as the same user.
- Standard Notes has no cross-item transaction, so a note can become protected in another client between
  the final check and a separate tag write.
