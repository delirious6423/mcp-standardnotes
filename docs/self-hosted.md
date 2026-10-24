# Using a self-hosted Standard Notes server

You can point this server at any Standard Notes sync server you run, such as your own
[`standardnotes/server`](https://github.com/standardnotes/server) deployment. See the
[official self-hosting guide](https://standardnotes.com/help/47/can-i-self-host-standard-notes) to set one up.
The server must be reachable over **HTTPS**; plain HTTP is refused (it is allowed only for loopback test
servers with `SN_ALLOW_LOCAL_TEST_SERVER=1`).

## 1. Create the account

Register against your server URL in the official Standard Notes app. New accounts use protocol 004.

## 2. Sign in and configure

```bash
SN_SERVER_URL=https://sn.example.com bin/standardnotes-mcp login
```

Then give the MCP server the same URL:

```json
{
  "mcpServers": {
    "standardnotes": {
      "command": "/absolute/path/to/checkout/bin/standardnotes-mcp",
      "args": ["serve"],
      "env": { "SN_SERVER_URL": "https://sn.example.com" }
    }
  }
}
```

Run `approve`, `logout` and `unlock` with the same `SN_SERVER_URL`. Use the URL without a trailing slash,
query or credentials.

## 3. Pin the TLS certificate (recommended)

Set `SN_CERT_FINGERPRINT` to the SHA-256 fingerprint of the server's leaf certificate; the connector then
refuses any other certificate, even one your trust store accepts:

```bash
echo | openssl s_client -connect sn.example.com:443 -servername sn.example.com 2>/dev/null \
  | openssl x509 -noout -fingerprint -sha256 \
  | sed 's/^.*=//; s/://g; y/ABCDEF/abcdef/'
```

Put the 64-hex-character result in both the login command's environment and the MCP server's `env`.
Repeat after every certificate renewal.

## Several accounts

Each server process serves one account. Run one MCP server entry per account, each with its own
`SN_EMAIL` (and `SN_SERVER_URL` if they differ). Their encrypted journals live in separate per-account
directories under the state directory automatically.

## Operational notes

- **State.** Besides the keychain entries, the connector keeps an encrypted operation and recovery journal
  in its state directory (see the README's configuration table). Note backups remain your server's job.
- **Rate limiting.** The connector honours HTTP 429 and `Retry-After` for every process of the account.
- **Files.** Attachments are not supported; this server handles notes and tags only.
- **Testing.** Never point tests at a server holding real notes; the VM gates use a synthetic server.

## If login fails

- Wrong scheme or extra characters in `SN_SERVER_URL`: use `https://host` with no trailing slash.
- Invalid certificate (expired, wrong host, untrusted CA): fix it on the server, or pin it with
  `SN_CERT_FINGERPRINT` if it is intentionally self-signed.
- Wrong password, or an account that was never upgraded to protocol 004: check the password, then upgrade
  the encryption in the official app (Preferences → Security).
