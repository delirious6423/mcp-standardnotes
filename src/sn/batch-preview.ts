import type { PreparedChange } from "./client.js";

type Content = Record<string, unknown>;

export interface BatchItem {
  uuid: string;
  type: string;
  title: unknown;
  kinds: string;
  created?: true;
  changes: Record<string, unknown>;
}

/** One approval for many writes: counts first, then every changed field of every item. */
export interface BatchPreview {
  kind: "batch";
  items: number;
  counts: Record<string, number>;
  plan: BatchItem[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Only our own edit timestamp is dropped; any other appData change is shown.
function appDataWithoutStamp(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const copy = JSON.parse(JSON.stringify(value)) as Content;
  const domain = copy["org.standardnotes.sn"] as Content | undefined;
  if (domain && typeof domain === "object" && !Array.isArray(domain)) {
    delete domain.client_updated_at;
    if (Object.keys(domain).length === 0) delete copy["org.standardnotes.sn"];
  }
  return Object.keys(copy).length === 0 ? undefined : copy;
}

function refIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((ref: unknown) => {
    const r = ref as Content | null;
    return r && typeof r.uuid === "string" ? [`${String(r.content_type)}:${r.uuid}`] : [];
  });
}

function diff(before: Content, after: Content, noteTitle: (uuid: string) => string | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const textChanged = !same(before.text, after.text);
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const from = before[key];
    const to = after[key];
    if (key === "appData") {
      if (!same(appDataWithoutStamp(from), appDataWithoutStamp(to))) out[key] = { from: from ?? null, to: to ?? null };
      continue;
    }
    // Plain/HTML previews are derived from the body and are rewritten with it.
    if ((key === "preview_plain" || key === "preview_html") && textChanged) continue;
    if (same(from, to)) continue;
    if (key === "references") {
      const was = refIds(from);
      const now = refIds(to);
      const describe = (id: string) => {
        const [type, uuid] = id.split(/:(.*)/s) as [string, string];
        return { uuid, type, title: type === "Note" ? noteTitle(uuid) ?? null : null };
      };
      const added = now.filter((id) => !was.includes(id)).map(describe);
      const removed = was.filter((id) => !now.includes(id)).map(describe);
      // Reordering or reshaped reference objects still show in full.
      out[key] = added.length || removed.length ? { added, removed } : { from: from ?? null, to: to ?? null };
      continue;
    }
    out[key] = { from: from ?? null, to: to ?? null };
  }
  return out;
}

export function batchPreview(plans: PreparedChange[], noteTitle: (uuid: string) => string | undefined): BatchPreview {
  const counts: Record<string, number> = {};
  const plan = plans.map((p) => {
    for (const change of p.changes ?? [p.change]) counts[change.kind] = (counts[change.kind] ?? 0) + 1;
    const view = p.preview as { kind: string; before: Content | null; after: Content };
    const before = view.before ?? {};
    return {
      uuid: p.after.uuid,
      type: p.after.content_type,
      title: view.after.title ?? before.title ?? null,
      kinds: view.kind,
      ...(p.before ? {} : { created: true as const }),
      changes: diff(before, view.after, noteTitle),
    };
  });
  return { kind: "batch", items: plans.length, counts, plan };
}
