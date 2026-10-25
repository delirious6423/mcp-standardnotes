import { describe, expect, it } from "vitest";
import { renderPreview, visible } from "./render-preview.js";

const record = (preview: unknown) => ({ operationId: "op", status: "prepared", expiresAt: "later", preview });

describe("terminal approval preview", () => {
  it("makes control, bidi, zero-width and tag characters visible", () => {
    expect(visible("a\u001b[2Kb\rc\u202ed\u200be\u{e0041}f\tg")).toBe("a⟦U+001B⟧[2Kb⟦U+000D⟧c⟦U+202E⟧d⟦U+200B⟧e⟦U+E0041⟧f\tg");
  });

  it("cannot be imitated by text that spells a marker, and marks every default-ignorable character", () => {
    const literal = "a⟦U+202E⟧b", real = "a\u202Eb";
    expect(visible(literal)).not.toBe(visible(real));
    expect(visible(real)).toBe("a⟦U+202E⟧b");
    expect(visible(literal)).toBe("a⟦U+27E6⟧U+202E⟧b");
    for (const cp of [0x34f, 0x180b, 0x2065, 0xfe0f, 0xfff0, 0x1bca0, 0x1d173, 0xe0100]) {
      expect(visible(`x${String.fromCodePoint(cp)}y`)).toBe(`x⟦U+${cp.toString(16).toUpperCase().padStart(4, "0")}⟧y`);
    }
    // Ordinary text, including the closing bracket and other symbols, is unchanged.
    expect(visible("Café ⟧ 注音 → ok")).toBe("Café ⟧ 注音 → ok");
    const preview = { kind: "batch", items: 1, counts: { note_update: 1 }, plan: [{ uuid: "u", kinds: "note_update", changes: { text: { from: literal, to: real } } }] };
    const out = renderPreview({ operationId: "op", status: "prepared", expiresAt: "later", preview });
    expect(out).toContain("a⟦U+27E6⟧U+202E⟧b");
    expect(out).toContain("a⟦U+202E⟧b");
  });

  it("lists every batch item and changed field, including references, without truncating", () => {
    const long = "x".repeat(5000);
    const out = renderPreview(record({ kind: "batch", items: 2, counts: { tag_attach: 1, note_update: 1 }, plan: [
      { uuid: "t1", type: "Tag", title: "Work", kinds: "tag_attach", changes: { references: { added: [{ uuid: "n1", type: "Note", title: "A" }], removed: [{ uuid: "n2", type: "Note" }] } } },
      { uuid: "n3", type: "Note", title: "Evil\u202eexe.txt", kinds: "note_update", changes: { text: { from: "line1\nline2", to: long } } },
    ] }));
    expect(out).toContain("[1/2] Tag \"Work\" t1");
    expect(out).toContain("+ Note \"A\" n1");
    expect(out).toContain("- Note (untitled or protected) n2");
    expect(out).toContain("[2/2] Note \"Evil⟦U+202E⟧exe.txt\" n3");
    expect(out).toContain("| line1\n");
    expect(out).toContain(long);
    expect(out.includes("\u202e") || out.includes("\u001b")).toBe(false);
  });

  it("shows only changed fields of a single change and marks new items", () => {
    const edit = renderPreview(record({ kind: "note_update", uuid: "n1", before: { title: "A", text: "same" }, after: { title: "B", text: "same" } }));
    expect(edit).toContain("title:");
    expect(edit).not.toContain("text:");
    expect(renderPreview(record({ kind: "note_create", uuid: "n2", before: null, after: { title: "New" } }))).toContain("(new item)");
  });
});
