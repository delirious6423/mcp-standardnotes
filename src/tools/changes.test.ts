import { describe, it, expect } from "vitest";
import { changeInput, operationInput } from "./changes.js";
const uuid = "11111111-1111-4111-8111-111111111111";
const revision = "a".repeat(64);
describe("safe change boundary",()=>{
  it("requires revision and a real change",()=>{
    expect(changeInput.safeParse({kind:"note_update",uuid,text:"x"}).success).toBe(false);
    expect(changeInput.safeParse({kind:"note_update",uuid,revision}).success).toBe(false);
    expect(changeInput.safeParse({kind:"note_update",uuid,revision,text:"x",append:"y"}).success).toBe(false);
    expect(changeInput.safeParse({kind:"note_update",uuid,revision,append:"y"}).success).toBe(true);
  });
  it("refuses raw recovery, permanent-delete flags and structured body creation",()=>{
    for(const value of [
      {kind:"recovery",uuid,revision},
      {kind:"note_trash",uuid,revision,permanent:true},
      {kind:"tag_delete",uuid,revision},
      {kind:"note_create",title:"t",text:"b",noteType:"super"},
    ]) expect(changeInput.safeParse(value).success).toBe(false);
  });
  it("validates UTF-8 bytes and strict operation IDs",()=>{
    expect(changeInput.safeParse({kind:"note_create",title:"t",text:"😀".repeat(3*1024*1024)}).success).toBe(false);
    expect(operationInput.safeParse({operationId:"../../escape"}).success).toBe(false);
    expect(operationInput.safeParse({operationId:uuid,plan:{}}).success).toBe(false);
  });
});
