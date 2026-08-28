// `ctx.config` is a derived mirror of `ctx.sheets[current].config`. Inside an immer recipe the two
// halves are separate drafts of the same base, so a write to one is invisible to the other, and
// immer attributes a shared child's patches to whichever root key it reaches first — `sheets`, which
// precedes `config` in the Context. `editableConfig` (state/context.ts) is the one helper that gets
// both right; anything hand-rolling the pair either fails to sync (mirror-only) or syncs the whole
// config object as one last-writer-wins replace (mirror-first). This pins the files allowed to touch
// either half, so a new writer has to be a deliberate addition rather than a silently broken one.
//
// Both scans are *syntactic*: they find the assignment sites in a file, not every way a config can be
// mutated. Mutation through a local alias — `const cfg = ctx.config; cfg.rowlen = {}` — is invisible
// to them and always will be. Passing is therefore evidence that no NEW file started writing config,
// not evidence that the writers listed here are correct.

import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';

// Files that assign a whole config object to either half (`x.config = …`).
const CONFIG_WRITERS = [
    'api/rowcol.ts',
    'api/sheet.ts',
    'context.ts',
    'events/mouse-drag.ts',
    'events/mouse-resize.ts',
    'events/paste.ts',
    'modules/filter.ts',
    'modules/move-cells.ts',
    'modules/rowcol.ts',
    'modules/selection.ts',
    'modules/sheet.ts',
    'modules/toolbar.ts',
];

// Files that assign into a config member (`ctx.config.rowlen = …`, `??=`, `[c] = …`). A mirror-side
// write here with no sheet-side flush in the same recipe emits only a top-level `['config']` patch,
// which filterPatch drops — the edit neither syncs nor undoes.
const CONFIG_MEMBER_WRITERS = ['api/rowcol.ts', 'context.ts', 'modules/filter.ts', 'modules/rowcol.ts'];

const ASSIGN = /\.config\s*=[^=]/;
const MEMBER_ASSIGN = /\.config(\.[\w$]+|\[[^\]]*\])+\s*(\?\?|\|\||&&)?=[^=]/;

async function filesMatching(pattern: RegExp) {
    const root = new URL('../../state/', import.meta.url).pathname;
    const found: string[] = [];
    for await (const file of new Glob('**/*.ts').scan(root)) {
        if (pattern.test(await Bun.file(root + file).text())) found.push(file);
    }
    return found.sort();
}

describe('config mirror writers', () => {
    test('only the pinned files assign to a `.config` half', async () => {
        expect(
            await filesMatching(ASSIGN),
            'a new `.config` writer appeared — route it through editableConfig (state/context.ts) and pin it here',
        ).toEqual(CONFIG_WRITERS);
    });

    test('only the pinned files assign into a config member', async () => {
        expect(
            await filesMatching(MEMBER_ASSIGN),
            'a new `ctx.config.<key>` writer appeared — mutating the mirror alone emits a patch filterPatch drops, so route it through editableConfig (state/context.ts) and pin it here',
        ).toEqual(CONFIG_MEMBER_WRITERS);
    });
});
