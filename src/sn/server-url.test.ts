import { describe,it,expect,vi,afterEach } from "vitest";
import { serverUrl } from "./server-url.js";
afterEach(()=>vi.unstubAllEnvs());
describe("transport configuration",()=>{
 it("defaults to official HTTPS",()=>{
  vi.stubEnv("SN_SERVER_URL",undefined);expect(serverUrl()).toBe("https://api.standardnotes.com");
 });
 it("refuses plaintext/credential/query endpoints, permits explicit loopback test only",()=>{
  for(const bad of ["http://example.com","https://a:b@example.com","https://example.com?token=x","https://example.com#x"]) {
   vi.stubEnv("SN_SERVER_URL",bad);expect(()=>serverUrl()).toThrow();
  }
  vi.stubEnv("SN_SERVER_URL","http://127.0.0.1:1234");expect(()=>serverUrl()).toThrow();
  vi.stubEnv("SN_ALLOW_LOCAL_TEST_SERVER","1");expect(serverUrl()).toBe("http://127.0.0.1:1234");
 });
});
