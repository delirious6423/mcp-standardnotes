import { z } from "zod";
import { configureStateDirectory } from "../config.js";
import { withAccount, stateDirectory } from "../security/account-context.js";
import { withAccountLock } from "../security/account-state.js";
import { createClientFromLogin, type SnClient } from "../sn/client.js";
import { loadSession, resolveEmail, deleteSession } from "../sn/session.js";
import { serverUrl } from "../sn/server-url.js";
import { configureAgents } from "./configure.js";

const operation = z.object({operationId:z.string().uuid()}).strict();
const id = z.number().int().nonnegative();
const account = z.string().trim().email().max(320).optional();
export const guiRequest = z.discriminatedUnion("method", [
  z.object({id,account,method:z.enum(["status", "check", "pending", "disconnect", "configure"]),params:z.object({}).strict().optional()}).strict(),
  z.object({id,account,method:z.literal("login"),params:z.object({email:z.string().trim().email().max(320),password:z.string().min(1).max(4096),mfa:z.string().max(64).optional()}).strict()}).strict(),
  z.object({id,account,method:z.enum(["preview", "approve", "reject"]),params:operation}).strict(),
]);

export interface GuiResponse {id: number; ok: boolean; result?: unknown; error?: {code: string; message: string}}
class MfaRequired extends Error {}
async function counts(client: SnClient, email: string, server: string): Promise<unknown> {
  const stats = await client.stats();
  return {connected:true,email,server,notes:stats.notes.total,tags:stats.tags};
}

/** Local native GUI pipe only; deliberately not exposed as an MCP tool or listening socket. */
export async function handleGuiRequest(value: unknown): Promise<GuiResponse> {
  const parsed = guiRequest.safeParse(value);
  if (!parsed.success) return {id:0,ok:false,error:{code:"invalid_request",message:"Invalid connection-app request"}};
  const request = parsed.data;
  const previousAccount = process.env.SN_EMAIL;
  // The bridge accepts one request per process; explicit GUI selection wins over inherited CLI settings.
  if (request.account) process.env.SN_EMAIL = request.account;
  try {
    await configureStateDirectory();
    const server = serverUrl();
    let result: unknown;
    switch (request.method) {
      case "status": {
        let email: string | undefined;
        try { email = await resolveEmail(server); }
        catch { /* No unique local account is not proof of live connectivity. */ }
        const saved = email ? await loadSession(email) : null;
        result = {savedSession:Boolean(saved && saved.serverUrl===server),email,server,verified:false};
        break;
      }
      case "login": {
        const {email,password,mfa} = request.params as {email:string;password:string;mfa?:string};
        result = await withAccountLock(await stateDirectory(server,email), async () => {
          const client = await createClientFromLogin({email,serverUrl:server},password,async () => {
            if (!mfa) throw new MfaRequired();
            return mfa;
          });
          return counts(client,email,server);
        });
        break;
      }
      case "check":
        result = await withAccount(async (client,_journal,email) => counts(await client(),email,server));
        break;
      case "disconnect":
        result = await withAccount(async (_client,_journal,email) => ({disconnected:await deleteSession(email)}));
        break;
      case "pending":
        result = await withAccount(async (_client,journal) => (await journal()).pending());
        break;
      case "preview":
      case "approve":
      case "reject": {
        const {operationId} = request.params as {operationId:string};
        result = await withAccount(async (_client,journal,email) => {
          const j = await journal();
          // Local journal-account binding, not cloud verification; the stored preview cannot assert its own identity.
          if (request.method === "preview") return {...(await j.preview(operationId)),email,accountBound:true};
          if (request.method === "approve") { await j.approve(operationId); return {approved:true,operationId}; }
          await j.reject(operationId); return {rejected:true,operationId};
        });
        break;
      }
      case "configure": result = await configureAgents(); break;
      default: throw new Error("Unknown operation");
    }
    return {id:request.id,ok:true,result};
  } catch (error) {
    // Raw API errors may echo request details. Never send/log them, credentials, keys or notes.
    const mfa = error instanceof MfaRequired;
    return {id:request.id,ok:false,error:{code:mfa?"mfa_required":"action_failed",message:mfa
      ? "Enter the current two-factor code, then sign in again."
      : "Action failed. Check your account, connection and recovery location. A busy account may need retrying; do not blindly repeat a note edit."}};
  } finally {
    if (previousAccount === undefined) delete process.env.SN_EMAIL;
    else process.env.SN_EMAIL = previousAccount;
  }
}
