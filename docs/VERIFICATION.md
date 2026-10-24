# Verification

Gate (from a checkout): `bash tests/vm/run.sh`. It runs in a throwaway Incus VM with synthetic data only;
add `SN_UPDATE_LOCK=1` to regenerate the lockfile inside the VM.

Latest Linux result (2026-10-25, Ubuntu 26.04.1 LTS, Node 22, npm 11.21.1 in the VM):

```text
TypeScript / ESLint / build: PASS
PASS regression canary: old protected-search behavior fails its assertion; fixed source restored
PASS regression canary: preflight cancellation fails without any of the three send-boundary guards
Test Files 20 passed (20)
Tests      214 passed | 5 skipped (219)
found 0 vulnerabilities
PASS: 74 assertions, two real stdio MCP clients, real OS keychain, encrypted recovery, stale edits,
      timeout/retry, token rotation and exclusion
PASS: Ubuntu 26.04 native Incus VM checks (synthetic data; no cloud account)
CLEANUP PASS: owned VM discarded
```

The end-to-end suite approves and rejects through the real `approve` command under a pseudo-terminal
(macOS uses BSD `script`; Windows approves through the same journal call because it has no `script`).

The batch-write changes passed an independent adversarial review; its four findings were fixed with
regression tests that fail when the fix is removed.

## Not claimed

- macOS and Windows have not been re-run since the native GUI was removed.
- Synthetic HTTP tests are not proof of official-cloud behavior, rate limits or official-app rendering.
  Legacy 003 reads were round-tripped once against a real account in the official app.
- Approval is not a sandbox against an agent with unrestricted shell access as the same user.
- Standard Notes has no cross-item transaction, so a note can become protected in another client between
  the final check and a separate tag write.
