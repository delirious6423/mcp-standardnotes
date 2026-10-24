# Verification

Gate (from a checkout): `bash tests/vm/run.sh`. It runs in a throwaway Incus VM with synthetic data only;
add `SN_UPDATE_LOCK=1` to regenerate the lockfile inside the VM.

Latest Linux result (2026-10-25, Ubuntu 26.04.1 LTS, Node 22, npm 11.21.1 in the VM):

```text
TypeScript / ESLint / build: PASS
PASS regression canary: old protected-search behavior fails its assertion; fixed source restored
PASS regression canary: preflight cancellation fails without any of the three send-boundary guards
Test Files 22 passed (22)
Tests      231 passed | 5 skipped (236)
found 0 vulnerabilities
PASS: 100 assertions, two real stdio MCP clients, real OS keychain, encrypted recovery, stale edits,
      timeout/retry, token rotation and exclusion
PASS: Ubuntu 26.04 native Incus VM checks (synthetic data; no cloud account)
CLEANUP PASS: owned VM discarded
```

Latest macOS result (2026-10-25, macOS 26.6.2 arm64 Tart VM on Apple Silicon, Node 24.21.0):
`bash tests/vm/macos-run.sh` PASS — same 231 unit tests and 100 e2e assertions with a synthetic
Keychain; the VM was token-verified and deleted.

The end-to-end suite approves and rejects through the real `approve` command in a pseudo-terminal
(`tests/approve-pty.py` types only after the prompt). Windows has no pty module, so it approves through
the same journal call the CLI makes.

The batch-write changes passed an independent adversarial review; its four findings were fixed with
regression tests that fail when the fix is removed.

## Not claimed

- Windows x64: `bash tests/vm/windows-run.sh` exists but has not run yet (the shared Windows VM slot was
  in use by another session). Windows ARM64 and Linux ARM64 have not been run.
- Synthetic HTTP tests are not proof of official-cloud behavior, rate limits or official-app rendering.
  Legacy 003 reads were round-tripped once against a real account in the official app.
- Approval is not a sandbox against an agent with unrestricted shell access as the same user.
- Standard Notes has no cross-item transaction, so a note can become protected in another client between
  the final check and a separate tag write.
