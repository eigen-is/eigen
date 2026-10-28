// The grid reads whether a press closed a menu on its mousedown, after Radix has closed the menu on the pointerdown.
// SheetOverlay records it on the pointerdown, for the cells and the headers alike.

import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { act, createElement, createRef } = await import('react');
const { createRoot } = await import('react-dom/client');
const { WorkbookContext } = await import('../../../context');
const { SheetOverlay } = await import('../../../components/SheetOverlay');
const { defaultContext, defaultSettings } = await import('../../../state');
type GlobalCache = import('../../../state').GlobalCache;

const globalCache: GlobalCache = {
    undoList: [],
    redoList: [],
    scrollLeft: 0,
    scrollTop: 0,
    scrollListeners: new Set<() => void>(),
    notifyScrollListeners: () => {},
};
const refs = {
    globalCache,
    cellInput: createRef<HTMLDivElement | null>(),
    fxInput: createRef<HTMLDivElement | null>(),
    canvas: createRef<HTMLCanvasElement | null>(),
    cellArea: createRef<HTMLDivElement | null>(),
    workbookContainer: createRef<HTMLDivElement | null>(),
};

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
    document.body.innerHTML = '';
});

async function renderOverlay() {
    const context = {
        ...defaultContext(refs),
        sheets: [{ id: 'id_1', name: 'sheet', order: 0, config: {}, data: [[null, null]] }],
        currentSheetId: 'id_1',
    };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
        root.render(
            createElement(
                WorkbookContext.Provider,
                {
                    value: {
                        context,
                        setContext: () => {},
                        settings: defaultSettings,
                        refs,
                        handleUndo: () => {},
                        handleRedo: () => {},
                    },
                },
                createElement(SheetOverlay),
            ),
        ),
    );
    cleanup = async () => {
        await act(async () => root.unmount());
        container.remove();
    };
    return container;
}

function openMenu(state: 'open' | 'closed') {
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('data-state', state);
    document.body.append(menu);
}

async function pressOn(container: HTMLElement, selector: string) {
    const target = container.querySelector(selector);
    if (!target) throw new Error(`no ${selector}`);
    await act(async () => {
        target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    });
}

test.each(['.sheet-cell-area', '.sheet-col-header-wrap', '.sheet-row-body > :first-child'])(
    'a press on %s with a menu open is noted as closing it',
    async (selector) => {
        const container = await renderOverlay();
        openMenu('open');
        await pressOn(container, selector);
        expect(globalCache.pressClosedMenu).toBe(true);
    },
);

test('a press with no open menu is noted as closing none', async () => {
    const container = await renderOverlay();
    globalCache.pressClosedMenu = true;
    openMenu('closed');
    await pressOn(container, '.sheet-cell-area');
    expect(globalCache.pressClosedMenu).toBe(false);
});
