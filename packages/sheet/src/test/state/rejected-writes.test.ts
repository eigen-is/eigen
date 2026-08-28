// A handler that rejects its own operation must leave no trace. Every syncable patch costs
// twice: setContextWithProduce pushes an undo entry for it, so the user's next ⌘Z silently
// consumes a no-op instead of undoing their previous edit, and emitOp ships it to peers.
//
// Deleting the ctx.config mirror made this reachable. Seeding `config.rowlen ??= {}` used to
// land on the mirror draft, whose `['config', ...]` patches filterPatch dropped, so seeding
// before a guard clause was invisible. Now every config write lands under `sheets[i]`, which
// filterPatch keeps — so seeding has to happen after the guards, not before them.

import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { enablePatches, produceWithPatches } from 'immer';
import type { Context } from '../../state/context';
import { handleOverlayMouseUp } from '../../state/events/mouse-drag';
import type { Settings } from '../../state/settings';
import type { GlobalCache } from '../../state/types';
import { filterPatch } from '../../state/utils/patch';
import { contextFactory } from './factories/context';

enablePatches();

// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
const win = new Window();
g.window = win;
g.document = win.document;

// A sheet that has never had a config written — the case where seeding is itself a patch.
function bareSheet(): Context {
    const ctx = contextFactory() as Context;
    ctx.sheets[0].config = undefined;
    ctx.rowHeaderWidth = 46;
    ctx.columnHeaderHeight = 20;
    ctx.defaultrowlen = 19;
    ctx.defaultcollen = 73;
    return ctx;
}

function syncablePatches(ctx: Context, recipe: (draft: Context) => void) {
    const [, patches] = produceWithPatches(ctx, recipe);
    return filterPatch(patches).map((p) => p.path);
}

function mouseUpAt(pageX: number, pageY: number) {
    return (ctx: Context) => {
        const container = win.document.createElement('div') as unknown as HTMLDivElement;
        container.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect;
        const scrollEl = win.document.createElement('div') as unknown as HTMLDivElement;
        const event = { button: 0, pageX, pageY } as unknown as MouseEvent;
        handleOverlayMouseUp(ctx, {} as GlobalCache, {} as Settings, event, scrollEl, container, null, null);
    };
}

describe('a rejected resize writes nothing', () => {
    test('a sub-3px column mis-click emits no patch, even on a sheet with no config', () => {
        const paths = syncablePatches(bareSheet(), (ctx: Context) => {
            ctx.colsResizing = true;
            ctx.colsResizeStart = [200, 2];
            mouseUpAt(200 + 46 - 3, 150)(ctx);
        });
        expect(paths).toEqual([]);
    });

    test('a sub-3px row mis-click emits no patch, even on a sheet with no config', () => {
        const paths = syncablePatches(bareSheet(), (ctx: Context) => {
            ctx.rowsResizing = true;
            ctx.rowsResizeStart = [100, 2];
            mouseUpAt(296, 100 + 20 - 3)(ctx);
        });
        expect(paths).toEqual([]);
    });

    test('a real column resize still emits its patch', () => {
        const paths = syncablePatches(bareSheet(), (ctx: Context) => {
            ctx.colsResizing = true;
            ctx.colsResizeStart = [200, 2];
            mouseUpAt(296, 150)(ctx);
        });
        expect(paths.length).toBeGreaterThan(0);
    });
});
