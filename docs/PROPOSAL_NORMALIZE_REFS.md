# Parent→child ref repair — document-order ranking

> **Status — SHIPPED 2026-08-25.** Both fixes are implemented, tested and reviewed. The durable contract now lives in [CANVAS.md](CANVAS.md) § Shared Primitives; this file keeps the evidence and the decisions, because the load-bearing claim (peers disagree about Y.Map key order) is expensive to re-derive and easy to disbelieve. Subject: `packages/lib/src/core/collab/normalize-refs.ts` and its two hosts, `apps/slides/src/components/slides/normalize-deck.ts` and `apps/stickies/src/components/stickies/normalize-board.ts`.

| # | Issue | Verification | Fix |
|---|-------|--------------|-----|
| 1 | "First parent" / "last parent" meant Y.Map insertion order, not document order | Repro + a two-doc experiment: peers diverge 200/200 | Rank parents by the host's order array (`slideOrder` / `columnOrder`) |
| 2 | A re-homed **or dedupe-moved** object kept a stale `slideId` | Verified in code; user-visible misroute inferred, never reproduced | Slides-side pass reconciles `slideId` from `objectIds` |

## What the module does

`normalizeParentChildRefs` repairs a parent→child reference structure stored in a Yjs doc as a `parentMap` of `Y.Map`s, each holding a `childRefField` `Y.Array<string>` of child ids, plus a `childMap` of the children themselves. Two corruptions a concurrent merge can introduce: a child referenced by **more than one** parent (dedupe — keep one copy, delete the rest), and a child referenced by **no** parent (an orphan — append it to a parent). Slides passes `('slides', 'objects', 'objectIds', 'slideOrder')`, stickies passes `('columns', 'tasks', 'taskIds', 'columnOrder')`. All writes run in one transaction stamped `NORMALIZE_ORIGIN`, a non-null origin so it escapes every host's UndoManager (both hosts build theirs through `useCollabDoc` as `new Y.UndoManager(scope)` with no options, whose default `trackedOrigins` is `{null}`) — a corruption fix must never be undoable — while still syncing to peers. The function is idempotent: a well-formed doc writes nothing.

When it runs matters. Slides calls it on **every** transaction whose origin is the websocket provider or the UndoManager (`hooks/use-deck.ts:84`), plus once on seed (`:122`). Stickies calls it once per doc on sync (`hooks/use-board.ts:159`) and again after a drag-and-drop (`hooks/use-drag-and-drop.ts:199`) — that second call is nested **inside** the drag's own `doc.transact`, so its repair rides the drag's tracked origin rather than a standalone `NORMALIZE_ORIGIN` transaction, as `normalize-board.ts` documents.

## Issue 1 — map insertion order is peer-relative

`parentIds` came from `Array.from(parents.keys())`. Both hosts maintain an explicit order array the module never consulted: slides `slideOrder`, stickies `columnOrder`, both `Y.Array<string>` doc roots. Those orders are unrelated to `parents.keys()`.

**a. The documentation was wrong.** The module and both hosts said the orphan goes to "the first parent" / "the first slide". It went to an arbitrary one — the first map key.

**b. The choice was not stable across peers.** `Y.Map.keys()` iterates `type._map.entries()`, a native JS `Map`, so iteration is insertion order — deterministic *within* a peer, per the ECMAScript spec. But `_map.set()` happens in `Item.integrate`, so insertion order is that peer's **local integration order**, which puts each peer's own edits ahead of what it later received. Two docs created from the same empty base, one adding `alpha` and the other `beta` concurrently, then exchanging updates, end with **opposite** key order — `p1 → ["alpha","beta"]`, `p2 → ["beta","alpha"]` — over 200 trials, **200/200**. A single-source load (peer C loading peer A's full state) does *not* diverge; divergence needs concurrent creation, which is exactly the situation this module exists to survive.

**c. Concurrent repairs could destroy the child.** Because slides re-runs the repair on every remote merge, two peers repairing the same duplicate concurrently picked *different* survivors and deleted each other's copy — leaving the child in **no** parent at all. Written up as theoretical in the proposal; it turned out to be directly demonstrable, and the regression test for it (`two peers … converge to one survivor`) fails against the old logic with `refsOf(p2) === []`, i.e. real data loss.

### What shipped

`normalizeParentChildRefs` takes a fifth required `orderArrayName: string`, consistent with its existing all-strings positional signature; both hosts had the root in hand. The parent sequence is `[...strays, ...orderedParents]`, where `orderedParents` are the order array's entries that exist in the parent map, de-duplicated keeping first occurrence (a merged order array can itself hold duplicates), and `strays` are parents absent from the order array, in map-key order.

- **Dedupe survivor** = highest-ranked holder, i.e. last in document order. Implemented by sorting each child's `owners` by rank and keeping the existing delete-all-but-last loop, so a parent listing the same child twice still collapses (one of its two entries is a lower holder; the re-read after each delete does the rest).
- **Orphan re-home target** = the first *ordered* parent, skipping strays. Ranking strays first at one end and skipping them at the other is deliberate: neither end may park a child on a parent the UI never renders.
- **Degenerate case** — no ordered parents at all (order array empty or never seeded) falls back to map-key order. Reviewed as unreachable in normal operation: `slideOrder` / `columnOrder` are written in the *same* transaction as the slide/column on both the seed and add paths, so this only arises from legacy corruption, where the old behaviour is a harmless floor.

Eight tests were added alongside the eight existing ones: re-home follows `slideOrder[0]`, dedupe keeps the last parent in document order, a stray loses the dedupe and is never a re-home target, a stray that is the sole holder keeps its child, unseeded order array falls back, intra-parent duplicates still collapse, two divergent peers converge on one survivor, and idempotency holds. Reverting the module makes exactly the four document-order tests fail — the net is not vacuous.

## Issue 2 — the stale `slideId` back-reference (slides only)

The repair moved child ids between parents' ref arrays but never touched the child's own back-reference. Every slides object carries `slideId` (`packages/lib/src/slides/types.ts`, `BaseObject`), so after a repair that field could name a slide whose `objectIds` no longer contains it. **The proposal framed this as a re-home problem; verification found the dedupe branch strands `slideId` the same way** — if `slideId` named one of the parents the child was deleted from, it is stale by the same definition. A re-home-only fix would have been half a fix.

`obj.slideId` is not decorative:

- `hooks/use-deck.ts:292` and `:360` — duplicate / z-order **write** into `slidesMap.get(src.slideId)`. A stale id targets the wrong slide or one that no longer exists, i.e. it can *create* the very duplicate-reference corruption this module repairs.
- `hooks/use-slides-doc-search.ts:37,48` — in-document search **navigates** to `obj.slideId`.
- `editor.tsx:367` — `openCommentCard` reveals the anchored object's slide via `setActiveSlideId(obj.slideId)`.

The user-visible misroute was never reproduced; the reads are confirmed by code. Stickies is unaffected — cards are `CommentCard` (`packages/lib/src/types/comments.ts`), which has no parent/column field at all.

### What shipped

Not an optional `childParentField` on the shared function: stickies has no back-reference, so the shared module stays host-agnostic. Instead `normalize-deck.ts` folds a second loop into its existing `NORMALIZE_ORIGIN` transaction (the one doing the `fontFamily` backfill) that walks each slide's `objectIds` and sets every contained object's `slideId` to that slide, writing only on a real change. `objectIds` is the source of truth; `slideId` is derived. One traversal covers re-home and dedupe alike, and a well-formed deck still writes nothing.

## Decisions taken on the proposal's open questions

1. **Strays rank first at the dedupe end, and are skipped at the re-home end.** Kept as proposed; the two ends genuinely want opposite treatment.
2. **Dedupe survivor stays "last in document order", not "the parent the back-reference names."** Deterministic and host-agnostic beats meaningful-but-host-specific, and the back-reference is itself the thing that goes stale. Issue 2 makes `slideId` follow the ref arrays rather than the reverse.
3. **Slides-side reconciliation pass, not an optional parameter** — see above.
4. **1c got a test**, and it was worth it: it fails against the old logic with observable data loss.
5. **Idempotency and "safe on every remote merge" are preserved** — both are pinned by tests.

## Still out of scope

**Performance.** The pre-read calls `refs.toArray()` once per parent, O(total refs), and in slides that runs on every remote transaction. Real but unmeasured, and a deck-sized map is small. No speculative work without a number.

**Claims checked and rejected.** An earlier automated review raised four issues; two do not survive contact with the code. *"Duplicate references within a single parent are not deleted"* is false — verified by running the module: `["c1","c1"] → ["c1"]`, `["x","c1","c1","y"] → ["x","c1","y"]`. (Caveat for anyone re-running: seed the child map only with ids the parent references, or the extras are orphans, get re-homed into that same parent, and mask the result.) *"Race condition: Yjs structures are read before `doc.transact` opens"* is false — there is no suspension point between the read loop and the transaction, no `await`, one synchronous JS turn; applying a remote update is itself synchronous work that can only run once the stack is empty. The third claim (O(N²) deletions) is misframed — the loop is gated by `if (owners.length <= 1) continue`, so it runs zero times on a well-formed document. The fourth (unstable `parentIds[0]`) reached a correct conclusion via wrong reasoning: it blamed cross-engine iteration order, which the ECMAScript spec pins; the actual cause was local integration order, and it is issue 1.

## Appendix — the divergence experiment

The load-bearing evidence for issue 1b, reduced to its core. Run from `packages/lib`.

```ts
import * as Y from 'yjs';

let divergences = 0;
const trials = 200;
for (let i = 0; i < trials; i++) {
    const x = new Y.Doc();
    const y = new Y.Doc();
    x.getMap('m').set('A', new Y.Map()); // peer x creates A
    y.getMap('m').set('B', new Y.Map()); // peer y creates B, concurrently
    Y.applyUpdate(x, Y.encodeStateAsUpdate(y));
    Y.applyUpdate(y, Y.encodeStateAsUpdate(x));
    const kx = JSON.stringify(Array.from(x.getMap('m').keys()));
    const ky = JSON.stringify(Array.from(y.getMap('m').keys()));
    if (kx !== ky) divergences++; // each peer integrates its own local key first
}
console.log(`concurrent-create divergences: ${divergences}/${trials}`);
// concurrent-create divergences: 200/200
```

Across 200 freshly-created doc pairs the two peers' `Array.from(map.keys())` never agreed. "First parent" was a peer-relative fact, not a document one — which is the whole reason ranking now comes from a `Y.Array` that converges.
