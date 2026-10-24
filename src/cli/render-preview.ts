// Terminal rendering of a stored preview for human approval. Note content is untrusted: every
// control, bidi and zero-width character is shown as a visible marker so text cannot rewrite or
// hide parts of what the user is approving. Nothing is truncated.

type Obj = Record<string, unknown>;

// Inclusive code point ranges: C0/C1 controls (except tab and newline), soft hyphen, fillers,
// zero-width and bidi controls, line/paragraph separators, BOM, interlinear annotations, tag characters.
const HIDDEN: Array<[number, number]> = [
  [0x00, 0x08], [0x0b, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x115f, 0x1160], [0x17b4, 0x17b5],
  [0x180e, 0x180e], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0x3164, 0x3164],
  [0xfeff, 0xfeff], [0xffa0, 0xffa0], [0xfff9, 0xfffb], [0xe0000, 0xe007f],
];

export function visible(text: string): string {
  let out = "";
  for (const c of text) {
    const cp = c.codePointAt(0)!;
    out += HIDDEN.some(([lo, hi]) => cp >= lo && cp <= hi) ? `⟦U+${cp.toString(16).toUpperCase().padStart(4, "0")}⟧` : c;
  }
  return out;
}

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function value(v: unknown, indent: string): string {
  if (typeof v === "string") {
    const lines = visible(v).split("\n");
    return lines.length === 1 ? JSON.stringify(lines[0]) : `\n${lines.map((l) => `${indent}| ${l}`).join("\n")}`;
  }
  return visible(JSON.stringify(v) ?? "undefined");
}

function field(name: string, from: unknown, to: unknown, indent: string): string[] {
  if (name === "references" && isObj(to) && Array.isArray(to.added) && Array.isArray(to.removed)) {
    const ref = (sign: string, r: unknown) => {
      const o = isObj(r) ? r : {};
      return `${indent}  ${sign} ${o.relation === "parent" ? "parent " : ""}${visible(String(o.type ?? "?"))} ${o.title === undefined ? "(untitled or protected)" : value(o.title, indent)} ${visible(String(o.uuid ?? "?"))}`;
    };
    return [`${indent}references:`, ...to.added.map((r) => ref("+", r)), ...to.removed.map((r) => ref("-", r))];
  }
  return [`${indent}${visible(name)}:`, `${indent}  from: ${value(from, `${indent}    `)}`, `${indent}  to:   ${value(to, `${indent}    `)}`];
}

function batch(preview: Obj): string[] {
  const items = Array.isArray(preview.plan) ? preview.plan : [];
  const out = [`Batch of ${items.length} item(s): ${visible(JSON.stringify(preview.counts ?? {}))}`];
  items.forEach((raw, i) => {
    const item = isObj(raw) ? raw : {};
    const title = item.title === undefined ? "(untitled or protected)" : value(item.title, "      ");
    out.push("", `[${i + 1}/${items.length}] ${visible(String(item.type))} ${title} ${visible(String(item.uuid))}`,
      `    change: ${visible(String(item.kinds))}${item.created ? " (new item)" : ""}`);
    const changes = isObj(item.changes) ? item.changes : {};
    for (const [name, diff] of Object.entries(changes)) {
      if (name === "references") out.push(...field(name, undefined, diff, "    "));
      else out.push(...field(name, isObj(diff) ? diff.from : undefined, isObj(diff) ? diff.to : diff, "    "));
    }
    if (Object.keys(changes).length === 0) out.push("    (no field changes)");
  });
  return out;
}

function single(preview: Obj): string[] {
  const before = isObj(preview.before) ? preview.before : null;
  const after = isObj(preview.after) ? preview.after : {};
  const out = [`${visible(String(preview.kind))} ${visible(String(preview.uuid))}${before ? "" : " (new item)"}`];
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after)])];
  for (const key of keys) {
    const from = before?.[key], to = after[key];
    if (JSON.stringify(from) !== JSON.stringify(to)) out.push(...field(key, from, to, "    "));
  }
  return out;
}

/** Human-readable approval screen for the record returned by WriteJournal.preview(). */
export function renderPreview(record: Obj): string {
  const preview = isObj(record.preview) ? record.preview : {};
  const body = preview.kind === "batch" ? batch(preview) : single(preview);
  return [
    `Operation ${visible(String(record.operationId))} (${visible(String(record.status))}), expires ${visible(String(record.expiresAt))}`,
    "Characters shown as ⟦U+XXXX⟧ are invisible or control characters in the note content.",
    "",
    ...body,
    "",
  ].join("\n");
}
