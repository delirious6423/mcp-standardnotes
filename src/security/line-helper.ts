import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * A long-lived child that answers one line per request line, one request at a time. Starting
 * PowerShell costs about 1.5 s on Windows, so private-file checks reuse one helper per process.
 * Requests are JSON with every non-ASCII character escaped, so the child's console code page cannot
 * corrupt paths. A timeout, a crash or an unexpected reply kills the child; the next request starts
 * a new one. The child never keeps the parent process alive while idle.
 */
export interface LineHelper {
  request(payload: Record<string, string>): Promise<string>;
  close(): void;
}

export function asciiJson(value: unknown): string {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function createLineHelper(command: string, args: string[], timeoutMs: number, env?: NodeJS.ProcessEnv): LineHelper {
  let child: ChildProcessWithoutNullStreams | undefined;
  let pending: ((line: string | null) => void) | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  const stop = () => {
    const current = child;
    child = undefined;
    if (current) current.kill();
    pending?.(null);
  };
  const start = (): ChildProcessWithoutNullStreams => {
    const next = spawn(command, args, { env, stdio: "pipe", windowsHide: true });
    next.stderr.resume(); // Diagnostics may include paths; drain and drop them.
    // A killed child's late output must never answer the next request.
    createInterface({ input: next.stdout }).on("line", (line) => { if (child === next) pending?.(line); });
    next.on("exit", () => { if (child === next) { child = undefined; pending?.(null); } });
    next.on("error", () => { if (child === next) { child = undefined; pending?.(null); } });
    next.stdin.on("error", () => undefined);
    return next;
  };
  // The pipes are sockets at run time; their declared stream types omit ref/unref.
  const pipes = (c: ChildProcessWithoutNullStreams) => [c.stdin, c.stdout, c.stderr] as unknown as Array<{ ref?(): void; unref?(): void }>;
  const idle = (c: ChildProcessWithoutNullStreams) => { c.unref(); for (const p of pipes(c)) p.unref?.(); };
  const busy = (c: ChildProcessWithoutNullStreams) => { c.ref(); for (const p of pipes(c)) p.ref?.(); };

  const once = (payload: Record<string, string>) => new Promise<string>((resolve, reject) => {
    const c = child ?? (child = start());
    busy(c);
    const timer = setTimeout(() => { stop(); }, timeoutMs);
    pending = (line) => {
      pending = undefined;
      clearTimeout(timer);
      if (child) idle(child);
      if (line === null) reject(new Error("Helper stopped"));
      else resolve(line);
    };
    c.stdin.write(`${asciiJson(payload)}\n`);
  });

  return {
    request(payload) {
      const run = queue.then(() => once(payload));
      queue = run.catch(() => undefined);
      return run;
    },
    close: stop,
  };
}
