// The name box shows the selection's reference and nothing more: nothing in it takes focus or shows a text cursor,
// and a press on it leaves the focus where it was, so a key pressed after clicking it still goes to the grid.

import { expect, test } from 'bun:test';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { act, createElement, createRef } = await import('react');
const { createRoot } = await import('react-dom/client');
const { WorkbookContext } = await import('../../../context');
const { NameBox } = await import('../../../components/FxEditor/NameBox');
const { defaultContext } = await import('../../../state');

const refs = {
    globalCache: { undoList: [], redoList: [], scrollLeft: 0, scrollTop: 0, scrollListeners: new Set<() => void>() },
    cellInput: createRef<HTMLDivElement | null>(),
    fxInput: createRef<HTMLDivElement | null>(),
    canvas: createRef<HTMLCanvasElement | null>(),
    cellArea: createRef<HTMLDivElement | null>(),
    workbookContainer: createRef<HTMLDivElement | null>(),
    hooks: { current: {} },
};

test('the name box names the selection and leaves the focus with the grid', async () => {
    const context = {
        ...defaultContext(refs),
        sheets: [
            {
                id: 'id_1',
                name: 'sheet',
                order: 0,
                config: {},
                data: [
                    [null, null],
                    [null, null],
                ],
            },
        ],
        currentSheetId: 'id_1',
        selections: [{ row: [1, 1], column: [1, 1], row_focus: 1, column_focus: 1 }],
    };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
        root.render(
            createElement(
                WorkbookContext.Provider,
                {
                    value: {
                        context,
                        getContext: () => context,
                        setContext: () => {},
                        aspectLocked: false,
                        refs,
                        handleUndo: () => {},
                        handleRedo: () => {},
                        pasteClipboard: () => {},
                    },
                },
                createElement(NameBox),
            ),
        );
    });

    expect(container.textContent).toBe('B2');
    expect(container.querySelector('[tabindex]')).toBeNull();
    expect(container.querySelector('.cursor-text')).toBeNull();
    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    container.querySelector('[dir="ltr"]')?.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(true);

    await act(async () => root.unmount());
    container.remove();
});
