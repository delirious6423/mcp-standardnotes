import {it,expect} from "vitest";
import {readGuiFrame} from "./framing.js";

async function* chunks(...parts: Buffer[]) { yield* parts; }
it("preserves a Unicode credential across every possible byte split",async()=>{
  const request={id:1,method:"login",params:{email:"synthetic@example.invalid",password:"abcé密🔐xyz"}};
  const bytes=Buffer.from(JSON.stringify(request)+"\n");
  for(let i=0;i<=bytes.length;i++) expect(await readGuiFrame(chunks(bytes.subarray(0,i),bytes.subarray(i)))).toEqual(request);
});
it("rejects malformed UTF-8 and oversized byte streams",async()=>{
  await expect(readGuiFrame(chunks(Buffer.from([0xc3,0x28])))).rejects.toThrow();
  await expect(readGuiFrame(chunks(Buffer.alloc(65537)))).rejects.toThrow(/large/);
});
