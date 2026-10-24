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

const plain = (v: unknown): v is Content => !!v && typeof v === "object" && !Array.isArray(v);

// Per-field app data changes, e.g. `appData.org.standardnotes.sn.archived`; malformed shapes show whole.
function appDataDiff(from: unknown, to: unknown): Record<string, unknown> {
  if (same(from, to)) return {};
  if ((from !== undefined && !plain(from)) || (to !== undefined && !plain(to))) return { appData: { from: from ?? null, to: to ?? null } };
  const out: Record<string, unknown> = {};
  const a = (from ?? {}) as Content, b = (to ?? {}) as Content;
  for (const domain of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const da = a[domain], db = b[domain];
    if (same(da, db)) continue;
    if ((da !== undefined && !plain(da)) || (db !== undefined && !plain(db))) {
      out[`appData.${domain}`] = { from: da ?? null, to: db ?? null };
      continue;
    }
    const fa = (da ?? {}) as Content, fb = (db ?? {}) as Content;
    for (const key of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
      if (!same(fa[key], fb[key])) out[`appData.${domain}.${key}`] = { from: fa[key] ?? null, to: fb[key] ?? null };
    }
  }
  return out;
}

// Identity of a reference for added/removed: type, relation and target.
function refIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((ref: unknown) => {
    const r = ref as Content | null;
    return r && typeof r.uuid === "string" ? [`${String(r.content_type)}|${String(r.reference_type ?? "")}|${r.uuid}`] : [];
  });
}

function diff(before: Content, after: Content, titleOf: (uuid: string) => string | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const textChanged = !same(before.text, after.text);
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const from = before[key];
    const to = after[key];
    if (key === "appData") {
      Object.assign(out, appDataDiff(appDataWithoutStamp(from), appDataWithoutStamp(to)));
      continue;
    }
    // Plain/HTML previews are derived from the body and are rewritten with it.
    if ((key === "preview_plain" || key === "preview_html") && textChanged) continue;
    if (same(from, to)) continue;
    if (key === "references") {
      const was = refIds(from);
      const now = refIds(to);
      const describe = (id: string) => {
        const [type, relation, uuid] = id.split("|") as [string, string, string];
        return { uuid, type, title: titleOf(uuid) ?? null, ...(relation === "TagToParentTag" ? { relation: "parent" } : {}) };
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

export function batchPreview(plans: PreparedChange[], titleOf: (uuid: string) => string | undefined): BatchPreview {
  const counts: Record<string, number> = {};
  // Items created in this batch are not in the vault yet; name them from the plan.
  const planned = new Map(plans.filter((p) => !p.before).map((p) => [p.after.uuid, (p.preview as { after: Content }).after.title]));
  const title = (uuid: string) => { const t = planned.get(uuid); return typeof t === "string" ? t : titleOf(uuid); };
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
      changes: diff(before, view.after, title),
    };
  });
  return { kind: "batch", items: plans.length, counts, plan };
}
