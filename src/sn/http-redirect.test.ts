import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { refreshSession } from "./http.js";

// Real undici against loopback servers: a redirect must never carry the request body elsewhere.
const servers: http.Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r)))); });
const listen = (handler: http.RequestListener) => new Promise<string>((resolve) => {
  const server = http.createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
});

describe("redirects", () => {
  it("fails a 307 instead of resending the refresh tokens to the new location", async () => {
    const received: string[] = [];
    const elsewhere = await listen((req, res) => { req.on("data", (c) => received.push(String(c))); res.end("{}"); });
    const origin = await listen((_req, res) => { res.writeHead(307, { Location: `${elsewhere}/steal` }); res.end(); });
    await expect(refreshSession({ serverUrl: origin }, "SYNTHETIC-ACCESS", "SYNTHETIC-REFRESH")).rejects.toThrow();
    expect(received).toEqual([]);
  });
});
