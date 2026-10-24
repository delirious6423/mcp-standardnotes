import type { DecryptedTag, TagReference } from "./protocol004.js";

/**
 * Standard Notes stores tag folder hierarchy as a TagToParentTag reference on the CHILD tag.
 * The official app recognises a parent link by `reference_type` alone
 * (standardnotes/app packages/models .../Reference/Functions.ts `isTagToParentTagReference`)
 * and writes `{ reference_type: "TagToParentTag", content_type: "Tag", uuid }`
 * (TagMutator `makeChildOf`; ContentType.TYPES.Tag is "Tag"). References without a
 * reference_type are not parent links and are preserved untouched.
 */
export function parentUuidOf(t: DecryptedTag): string | null {
  return t.references.find((r) => r.reference_type === "TagToParentTag")?.uuid ?? null;
}

export function stripParentRefs(refs: TagReference[]): TagReference[] {
  return refs.filter((r) => r.reference_type !== "TagToParentTag");
}

export function makeParentRef(parentUuid: string): TagReference {
  return { uuid: parentUuid, content_type: "Tag", reference_type: "TagToParentTag" };
}

/**
 * All tag UUIDs in the subtree rooted at `rootUuid`, INCLUDING the root
 * itself. Order is BFS by depth but callers should treat the result as a
 * set. A pre-existing cycle in the vault (data corruption) is handled
 * defensively via a visited-set — no infinite loop, no throw.
 *
 * Returns an empty set when the root is unknown; a leaf tag returns just
 * its own uuid.
 */
export function subtreeTagUuids(
  tags: Map<string, DecryptedTag>,
  rootUuid: string,
): Set<string> {
  const result = new Set<string>();
  if (!tags.has(rootUuid)) return result;
  // One-pass parent → children index so BFS is O(n + edges) rather than
  // O(n * depth) if we walked ancestors per tag.
  const childrenByParent = new Map<string, string[]>();
  for (const t of tags.values()) {
    const p = parentUuidOf(t);
    if (p === null) continue;
    const list = childrenByParent.get(p);
    if (list) list.push(t.uuid);
    else childrenByParent.set(p, [t.uuid]);
  }
  const queue: string[] = [rootUuid];
  while (queue.length > 0) {
    const cur = queue.shift() as string;
    if (result.has(cur)) continue;
    result.add(cur);
    const kids = childrenByParent.get(cur);
    if (kids) queue.push(...kids);
  }
  return result;
}

/**
 * Would re-parenting `childUuid` under `newParentUuid` create a cycle?
 *
 * Walks up the ancestor chain from `newParentUuid`. If the walk ever visits
 * `childUuid`, the child is currently an ancestor of the proposed parent —
 * setting the link would close the loop. A pre-existing cycle in the vault
 * (data-corruption case) is detected and treated as "not our cycle" so a
 * legitimate re-parent can still repair a broken tree.
 */
export function wouldCreateCycle(
  tags: Map<string, DecryptedTag>,
  childUuid: string,
  newParentUuid: string,
): boolean {
  if (childUuid === newParentUuid) return true;
  let cursor: string | null = newParentUuid;
  const seen = new Set<string>();
  while (cursor) {
    if (seen.has(cursor)) return false;
    seen.add(cursor);
    if (cursor === childUuid) return true;
    const t = tags.get(cursor);
    cursor = t ? parentUuidOf(t) : null;
  }
  return false;
}
