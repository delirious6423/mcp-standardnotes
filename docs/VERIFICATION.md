# Verification

Accepted command (from this checkout):

```sh
SN_UPDATE_LOCK=1 SN_INSTALL_ARTIFACTS=1 bash tests/vm/run.sh
```

Native Incus VM, Ubuntu 26.04.1 LTS, Node 22.22.1, npm 11.21.1 (VM only). Normal repeat runs omit `SN_UPDATE_LOCK` and use the committed lockfile; omit `SN_INSTALL_ARTIFACTS` to avoid installing dependencies on the host.

```text
TypeScript / ESLint / build: PASS
PASS regression canary: old protected-search behavior fails its assertion; fixed source restored
Test Files 15 passed (15)
Tests      164 passed (164)
found 0 vulnerabilities
PASS: 54 assertions, two real stdio MCP clients, real libsecret keychain, encrypted recovery,
      stale edits, timeout/retry, token rotation and exclusion
CLEANUP PASS: test-owned MCP processes, mock API, keychain entries and journal files removed
PASS: Ubuntu 26.04 native Incus VM checks (synthetic data; no cloud account)
CLEANUP PASS: owned VM discarded
```

Independent source reviewer did not implement the change. After fixes, it reported no remaining P1/P2 blocker in reviewed paths. That is not hosted-service acceptance or a claim of complete security.

Dotfiles `tests/check.sh` initially passed 112 Python tests + 5 Node tests and shellcheck. After concurrent unrelated Windows work, the final rerun passed 121 Python tests + 5 Node tests but the overall script failed on SC2016 at `vm/windows/build.sh:107` (PowerShell variables inside a single-quoted SSH command). That unrelated file was not modified here. The connector launcher/VM scripts pass shellcheck, and connector diff whitespace checks pass. Adapter installation preserves custom/disabled MCP entries and stores no note credentials in JSON.

Machine-local complete output and failed attempts: `$DATA_DIR/cache/standardnotes-mcp/evidence/`. No test used a real Standard Notes account or launched the connector on the desktop as a test. Only successful VM-built artifacts were installed on the host.

## Not passed / not claimed

- Official hosted account authentication, note-count completeness, server conflict semantics and official-app rendering/round trip. Requires an authorized throwaway hosted account and VM app test; do not use production notes as fixtures.
- Other MCP clients' own UI/approval behavior, other operating systems or architectures.
- Large-vault bandwidth/rate limits: each current process cold-syncs per tool call and commits use a fresh readback. Avoid bulk work until measured on an authorized test vault.
- A sandbox against an agent with unrestricted host shell/PTY and keychain access. Terminal approval is unavailable through MCP but cannot stop an otherwise fully privileged local process.
- Protection changes from an external Standard Notes client atomically coupled to a separate tag update. The service exposes no cross-item transaction for that check.

Upstream's npm lock initially reported 25 dependency advisories; patched constraints plus a regenerated pinned lock now audit clean. Some deprecated upstream build dependencies still emit maintenance warnings.
