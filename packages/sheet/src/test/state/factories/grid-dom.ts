// Minimal DOM for the drag handlers, which measure against a container rect and read
// window.scroll*. The four geometry numbers are load-bearing: the resize hit tests are
// computed from rowHeaderWidth and columnHeaderHeight, so they live here once rather than
// being re-typed in every test that drives a drag.

import { Window } from 'happy-dom';
import type { Context } from '../../../state/context';
import { handleOverlayMouseUp } from '../../../state/events/mouse-drag';
import type { Settings } from '../../../state/settings';
import type { GlobalCache } from '../../../state/types';

const win = new Window();
// biome-ignore lint/suspicious/noExplicitAny: test-only globalThis injection
const g = globalThis as any;
g.window = win;
g.document = win.document;

export const GRID_GEOMETRY = {
    rowHeaderWidth: 46,
    columnHeaderHeight: 20,
    defaultrowlen: 19,
    defaultcollen: 73,
} as const;

export function withGridGeometry(ctx: Context): Context {
    Object.assign(ctx, GRID_GEOMETRY);
    return ctx;
}

export function mouseUpAt(pageX: number, pageY: number) {
    return (ctx: Context) => {
        const container = win.document.createElement('div') as unknown as HTMLDivElement;
        container.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect;
        const scrollEl = win.document.createElement('div') as unknown as HTMLDivElement;
        const event = { button: 0, pageX, pageY } as unknown as MouseEvent;
        handleOverlayMouseUp(ctx, {} as GlobalCache, {} as Settings, event, scrollEl, container, null, null);
    };
}
