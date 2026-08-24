import { normalizeParentChildRefs } from '@workspace/lib/collab';
import type * as Y from 'yjs';

// Dedupe tasks referenced by multiple columns (keep the last) and re-home orphaned tasks to the first
// column — the shared parent→child ref repair (U6d), parameterized on stickies' stored literals.
// Repairs are untracked when run standalone (onSync) and ride the caller's undo step when nested in a
// drag transact (use-drag-and-drop) — the shared helper's transaction origin handles both.
export function normalizeBoard(yjsDoc: Y.Doc) {
    normalizeParentChildRefs(yjsDoc, 'columns', 'tasks', 'taskIds');
}
