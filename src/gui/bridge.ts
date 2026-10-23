#!/usr/bin/env node
import { handleGuiRequest } from "./rpc.js";
import { readGuiFrame } from "./framing.js";

// One request per short-lived child: no localhost listener, credential-bearing argv or persistent GUI session.
async function main(): Promise<void> {
  const request = await readGuiFrame(process.stdin);
  process.stdout.write(JSON.stringify(await handleGuiRequest(request)) + "\n");
}

main().catch(() => {
  // Deliberately exclude raw input, exceptions and API payloads from stdout/stderr.
  process.stdout.write(JSON.stringify({id:0,ok:false,error:{code:"invalid_request",message:"Invalid connection-app request"}}) + "\n");
  process.exitCode = 1;
});
