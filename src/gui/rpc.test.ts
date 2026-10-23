import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  session:vi.fn(), email:vi.fn(), login:vi.fn(), resume:vi.fn(), remove:vi.fn(), configure:vi.fn(), state:vi.fn(),
  contextEmail:"locked@example.invalid",
  journal:{pending:vi.fn(),preview:vi.fn(),approve:vi.fn(),reject:vi.fn()},
}));
vi.mock("../config.js",()=>({configureStateDirectory:async()=>"/fake"}));
vi.mock("../security/account-context.js",()=>({
  stateDirectory:async()=>"/fake",
  withAccount:async(fn: (client:()=>Promise<unknown>,journal:()=>Promise<unknown>,email:string)=>Promise<unknown>)=>fn(mocks.resume,async()=>mocks.journal,process.env.SN_EMAIL??mocks.contextEmail),
}));
vi.mock("../security/account-state.js",()=>({withAccountLock:async(_dir: string,fn:()=>Promise<unknown>)=>fn()}));
vi.mock("../sn/session.js",()=>({loadSession:mocks.session,resolveEmail:mocks.email,deleteSession:mocks.remove}));
vi.mock("../sn/client.js",()=>({createClientFromLogin:mocks.login}));
vi.mock("./configure.js",()=>({configureAgents:mocks.configure}));
import { guiRequest, handleGuiRequest } from "./rpc.js";

describe("native GUI pipe boundary",()=>{
  beforeEach(()=>{vi.resetAllMocks();vi.stubEnv("SN_EMAIL",undefined);vi.stubEnv("SN_SERVER_URL","https://api.standardnotes.com");mocks.email.mockResolvedValue("synthetic@example.invalid");});
  afterEach(()=>vi.unstubAllEnvs());
  it("rejects unknown operations, flags and credential fields on read actions",async()=>{
    for(const value of [
      {id:1,method:"purge"},{id:1,method:"status",password:"SECRET"},
      {id:1,method:"approve",params:{operationId:"../escape"}},
      {id:1,method:"login",params:{email:"x@y.invalid",password:"s",serverUrl:"https://evil.invalid"}},
    ]) {expect(guiRequest.safeParse(value).success).toBe(false);expect((await handleGuiRequest(value)).error?.code).toBe("invalid_request");}
    expect(mocks.login).not.toHaveBeenCalled();
  });
  it("local status never claims a saved session proves connectivity or returns secrets",async()=>{
    mocks.session.mockResolvedValue({serverUrl:"https://api.standardnotes.com",masterKeyHex:"SECRET",sessionPayload:{access_token:"SECRET"}});
    const result = await handleGuiRequest({id:1,method:"status"});
    expect(result).toMatchObject({ok:true,result:{savedSession:true,verified:false}});
    expect(JSON.stringify(result)).not.toContain("SECRET");expect(mocks.resume).not.toHaveBeenCalled();
  });
  it("asks for MFA without returning/logging credentials or provider payloads",async()=>{
    mocks.login.mockImplementation(async(_config:unknown,_password:string,mfa:()=>Promise<string>)=>mfa());
    const result=await handleGuiRequest({id:1,method:"login",params:{email:"x@y.invalid",password:"SECRET"}});
    expect(result).toMatchObject({ok:false,error:{code:"mfa_required"}});
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
  it("checks counts only; arbitrary server errors do not expose API payloads",async()=>{
    mocks.resume.mockResolvedValue({stats:async()=>({notes:{total:42},tags:3,privateText:"SECRET"})});
    expect(await handleGuiRequest({id:2,method:"check"})).toMatchObject({ok:true,result:{connected:true,notes:42,tags:3}});
    mocks.resume.mockRejectedValue(new Error("PASSWORD SECRET API PAYLOAD"));
    expect(JSON.stringify(await handleGuiRequest({id:2,method:"check"}))).not.toContain("SECRET");
  });
  it("pins later actions to GUI-selected B despite inherited account A",async()=>{
    vi.stubEnv("SN_EMAIL","a@example.invalid");
    mocks.email.mockImplementation(async()=>process.env.SN_EMAIL);
    mocks.remove.mockResolvedValue(true);
    await handleGuiRequest({id:1,account:"b@example.invalid",method:"disconnect"});
    expect(mocks.remove).toHaveBeenCalledWith("b@example.invalid");
    expect(process.env.SN_EMAIL).toBe("a@example.invalid");
  });
  it("binds preview identity to the same captured journal account, not a second resolution",async()=>{
    const operationId="11111111-1111-4111-8111-111111111111";
    mocks.email.mockRejectedValue(new Error("must not resolve the account again"));
    mocks.journal.preview.mockResolvedValue({operationId,status:"prepared",email:"spoof@example.invalid",accountBound:false});
    expect(await handleGuiRequest({id:5,method:"preview",params:{operationId}})).toMatchObject({ok:true,result:{operationId,email:"locked@example.invalid",accountBound:true}});
    expect(mocks.email).not.toHaveBeenCalled();expect(mocks.resume).not.toHaveBeenCalled();
  });
  it("approval/rejection operate on the saved ID without a cloud client",async()=>{
    const operationId="11111111-1111-4111-8111-111111111111";
    expect(await handleGuiRequest({id:3,method:"approve",params:{operationId}})).toMatchObject({ok:true,result:{approved:true,operationId}});
    expect(mocks.journal.approve).toHaveBeenCalledWith(operationId);
    expect(await handleGuiRequest({id:4,method:"reject",params:{operationId}})).toMatchObject({ok:true,result:{rejected:true,operationId}});
    expect(mocks.journal.reject).toHaveBeenCalledWith(operationId);expect(mocks.resume).not.toHaveBeenCalled();
  });
});
