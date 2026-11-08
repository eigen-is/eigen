// The hovered column's menu arrow shows only while the user may edit, and follows a change of rights while the
// same column stays hovered.

import { afterEach, expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { act, createElement, createRef } = await import('react');
const { createRoot } = await import('react-dom/client');
const { WorkbookContext } = await import('../../../context');
const { ColumnHeader } = await import('../../../components/SheetOverlay/ColumnHeader');
const { defaultContext, defaultSettings } = await import('../../../state');
type GlobalCache = import('../../../state').GlobalCache;
type Context = import('../../../state').Context;
type SheetConfig = import('../../../state').SheetConfig;

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

function contextWith(config: SheetConfig): Context {
    return {
        ...defaultContext(refs),
        sheets: [{ id: 'id_1', name: 'sheet', order: 0, config, data: [[null, null]] }],
        currentSheetId: 'id_1',
        visibledatacolumn: [100, 200],
        visibledatarow: [20],
    };
}

test('losing edit rights while the same column stays hovered hides its menu arrow', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const render = (context: Context) =>
        act(async () =>
            root.render(
                createElement(
                    WorkbookContext.Provider,
                    {
                        value: {
                            context,
                            getContext: () => context,
                            setContext: () => {},
                            settings: defaultSettings,
                            refs,
                            handleUndo: () => {},
                            handleRedo: () => {},
                        },
                    },
                    createElement(ColumnHeader),
                ),
            ),
        );
    cleanup = async () => {
        await act(async () => root.unmount());
        container.remove();
    };

    await render(contextWith({}));
    const header = container.querySelector('.sheet-col-header');
    if (!(header instanceof HTMLElement)) throw new Error('no column header');
    await act(async () => {
        header.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 50 }));
    });
    expect(container.querySelector('.header-arrow')).not.toBeNull();

    await render({ ...contextWith({}), allowEdit: false });
    expect(container.querySelector('.sheet-col-header-hover')).not.toBeNull();
    expect(container.querySelector('.header-arrow')).toBeNull();
});
