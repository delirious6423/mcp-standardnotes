# Contributing

Thanks for your interest! This project is small and opinionated — please read the whole guide before opening your first PR.

## Ground rules

1. **Never commit fixtures containing real encrypted data or keys.** Not your account, not a test account.
2. **Security rules in [`.claude/rules/security.md`](.claude/rules/security.md) are non-negotiable.** Any change that touches auth, crypto, logging, storage, or network must respect them.
3. **`npm audit` HIGH/CRITICAL is a merge blocker.** CI enforces it.
4. **For cryptography-touching changes, open an issue first** to discuss scope. We do not reimplement primitives — everything comes from `libsodium-wrappers-sumo`.

## Setup

```bash
git clone https://github.com/delirious6423/mcp-standardnotes.git standardnotes-mcp
cd standardnotes-mcp
npm install
```

## Commands

```bash
npm run dev         # watch mode (tsx)
npm run build       # tsc → dist/
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm test            # vitest run
npm run audit       # npm audit, fails on HIGH/CRITICAL
```

Run the built server and CLIs through the launcher: `bin/standardnotes-mcp serve | login | logout |
approve OPERATION_UUID | unlock --clients-stopped`. Never test writes against a real account; use the VM gates.

## PR checklist

Before opening a PR:

```bash
npm run typecheck && npm run lint && npm test && npm run audit
```

Then:

- Keep changes focused. If you find an unrelated bug, open a separate PR.
- For new MCP tools or change kinds: add the zod schema (`src/tools/changes.ts` for writes), register in
  `src/server.ts`, and add input-validation tests. Writes must stay prepare → terminal approval → commit.
- For a fix, add a regression test and check that it fails when the fix is removed.
- For changes to the sync/write path: run `bash tests/vm/run.sh`, and confirm the stored item format against
  the official Standard Notes app source or a throwaway account.
- For protocol 004 changes: read [docs/protocol-004.md](./docs/protocol-004.md) first.

## Project layout

See the structure section of [CLAUDE.md](./CLAUDE.md).

## Testing

Unit tests live alongside the code they test (`*.test.ts`). Write tests for:

- Input validation (zod schemas must reject malformed inputs).
- Encryption round-trips when touching `protocol004.ts`.
- Redaction rules when touching `redact.ts`.

Integration tests run real stdio MCP clients against a synthetic sync server inside throwaway VMs:
`tests/vm/run.sh` (Linux), `tests/vm/macos-run.sh` (macOS), `tests/vm/windows-run.sh` (Windows x64).
**Never point tests or CI at the production Standard Notes server.**

## Commit style

- Present-tense, imperative ("Add X", "Fix Y"), lowercase after the verb is fine.
- Body explains *why*, not *what* (the diff shows *what*).
- Reference issues in the body when applicable.

## Releasing

The package is private and is not published to npm or the MCP Registry. Install from a checkout
([README](./README.md#install)); versions are recorded in [CHANGELOG.md](./CHANGELOG.md).
