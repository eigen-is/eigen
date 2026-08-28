// `ctx.config` is a derived mirror of `ctx.sheets[current].config`, and immer only emits a
// syncable `sheets[*]` patch when the mirror is mutated and the sheet half flushed after —
// see editableConfig in state/context.ts. This pins the files allowed to write either half,
// so a new writer has to be a deliberate addition rather than a silently broken one.

import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';

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

describe('config mirror writers', () => {
    test('only the pinned files assign to a `.config` half', async () => {
        const root = new URL('../../state/', import.meta.url).pathname;
        const found: string[] = [];
        for await (const file of new Glob('**/*.ts').scan(root)) {
            if (/\.config\s*=[^=]/.test(await Bun.file(root + file).text())) found.push(file);
        }
        expect(
            found.sort(),
            'a new `.config` writer appeared — route it through editableConfig (state/context.ts) and pin it here',
        ).toEqual(CONFIG_WRITERS);
    });
});
