# Security Policy

`standardnotes-safe-mcp` gives an AI assistant end-to-end-encrypted access to a
Standard Notes vault. Security is the whole point of the project, so this
document states the posture explicitly and explains how to report problems.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Use GitHub's private vulnerability reporting:
[**Report a vulnerability**](https://github.com/delirious6423/mcp-standardnotes/security/advisories/new)
(the *Security → Advisories* tab on the repository). Include the version, your
platform, and a minimal reproduction.

Expect an acknowledgement within a few days. Confirmed issues are fixed on a
priority basis, released as a patch version, and credited in the changelog
unless you ask otherwise.

## Supported versions

Only the latest commit on `main` receives security fixes. The package is not published to npm; install
from a checkout and update with `git pull`.

## Security posture

- **End-to-end encryption is preserved.** Cryptographic primitives come from `libsodium-wrappers-sumo`
  (Argon2id, XChaCha20-Poly1305 IETF); reading legacy protocol 003 items uses `node:crypto` AES-256-CBC
  with HMAC-SHA256 verification. Only protocol framing is implemented here — no hand-rolled crypto. See
  [docs/protocol-004.md](./docs/protocol-004.md).
- **The password lives in RAM only**, during key derivation. It is never logged, written to disk or put
  in an environment variable.
- **Secrets go to the OS keychain only** (`keytar`: macOS Keychain, Linux Secret Service, Windows
  Credential Manager). Session tokens, the master key and the journal key are never in plaintext files.
- **No write without the user.** Agents can only prepare a preview. The user approves that exact preview
  in their own terminal (`standardnotes-mcp approve ID`); there is no MCP tool that approves. Nothing can
  permanently delete a note or delete a tag. Every committed operation can be undone from an encrypted
  journal kept in a private state directory (mode 0700 on POSIX, a user-only ACL on NTFS).
- **Protected notes stay out.** They are never searched, listed with content or returned; locked notes
  are never changed.
- **stdio transport only.** No network port; the only outbound traffic is to the configured sync server.
- **Logs are redacted** through `src/security/redact.ts` and go to stderr only.
- **All tool inputs are validated by `zod`** (strict UUIDs, size limits).
- **TLS verification is never disabled**; self-hosted servers can be pinned with `SN_CERT_FINGERPRINT`.

Approval is not a sandbox: an agent with unrestricted shell access as the same user could run the
approve command itself. Give agents MCP access, not your shell, when that matters.

## Dependency advisories

`npm audit` reported **0 vulnerabilities** on 2026-10-25 (Linux VM gate). CI fails on any HIGH or
CRITICAL advisory. The `overrides` in `package.json` pin patched versions of transitive dependencies of
`@modelcontextprotocol/sdk`; its HTTP/SSE transport code is never loaded, because this server is stdio-only.

If you believe an advisory is reachable in stdio-only use, report it privately via the link above.
