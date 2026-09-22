import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { installHappyDom } from '../../happy-dom';

installHappyDom();

const { act, createElement, createRef } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Workbook } = await import('../../../components/Workbook');
const contextModule = await import('../../../state/context');
type Sheet = import('../../../state').Sheet;
type WorkbookInstance = import('../../../components/Workbook').WorkbookInstance;

// Tab order is `order`, not array position: array-first "Hidden" must never become current.
function sheets(): Sheet[] {
    return [
        { id: 'hidden', name: 'Hidden', order: 0, hide: 1, row: 10, column: 5, celldata: [], config: {} },
        { id: 's1', name: 'One', order: 2, status: 1, row: 20, column: 5, celldata: [], config: {} },
        { id: 's2', name: 'Two', order: 1, row: 30, column: 6, celldata: [], config: {}, defaultRowHeight: 40 },
    ];
}

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
    mock.restore();
    await cleanup?.();
    cleanup = undefined;
});

async function mountWorkbook(props: Record<string, unknown> = {}) {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const ref = createRef<WorkbookInstance>();
    const data = sheets();
    // A fresh hooks object per render, the way an app passes an inline literal.
    const render = () =>
        act(async () => {
            root.render(
                createElement(Workbook, {
                    ref,
                    data,
                    showToolbar: false,
                    showFormulaBar: false,
                    hooks: {},
                    ...props,
                }),
            );
        });
    await render();
    cleanup = async () => {
        await act(async () => root.unmount());
        container.remove();
    };
    const workbook = () => {
        if (!ref.current) throw new Error('workbook did not mount');
        return ref.current;
    };
    const current = () => container.querySelector('.bg-background.text-foreground span')?.textContent;
    return { container, render, workbook, current };
}

function tab(container: HTMLElement, name: string) {
    const span = [...container.querySelectorAll('[role="button"] span')].find((s) => s.textContent === name);
    if (!span?.parentElement) throw new Error(`tab ${name} did not render`);
    return span.parentElement;
}

test('a tab switch derives the sheet geometry once', async () => {
    const { container, current } = await mountWorkbook();
    const geometry = spyOn(contextModule, 'updateContextWithSheetData');
    await act(async () => {
        tab(container, 'Two').click();
    });
    expect(current()).toBe('Two');
    expect(geometry.mock.calls.length).toBe(1);
});

test('an app re-render with fresh hooks derives no geometry', async () => {
    const { render } = await mountWorkbook();
    const geometry = spyOn(contextModule, 'updateContextWithSheetData');
    await render();
    expect(geometry.mock.calls.length).toBe(0);
});

test('a peer hiding the current sheet lands on the first visible sheet in tab order', async () => {
    const { workbook, current } = await mountWorkbook();
    await act(async () => {
        workbook().applyOp([{ op: 'replace', id: 's1', path: ['hide'], value: 1 }]);
    });
    expect(current()).toBe('Two');
    expect(
        workbook()
            .getAllSheets()
            .find((sheet) => sheet.id === 's1')?.hide,
    ).toBe(1);
});

test("a viewer applies a peer's sheet deletion and addition", async () => {
    const { workbook, current } = await mountWorkbook({ allowEdit: false });
    const added = { id: 's3', name: 'Three', order: 3, row: 5, column: 5, celldata: [], config: {} };
    await act(async () => {
        workbook().applyOp([{ op: 'addSheet', id: 's3', path: [], value: added }]);
    });
    await act(async () => {
        workbook().applyOp([{ op: 'deleteSheet', id: 's1', path: [], value: { id: 's1' } }]);
    });
    expect(
        workbook()
            .getAllSheets()
            .map((sheet) => sheet.id),
    ).toEqual(['hidden', 's2', 's3']);
    expect(current()).toBe('Two');
});

test('undoing an added sheet lands on the first visible sheet in tab order', async () => {
    const { container, workbook, current } = await mountWorkbook();
    await act(async () => {
        container.querySelector<HTMLButtonElement>('[aria-label="New sheet"]')?.click();
        await new Promise((resolve) => setTimeout(resolve));
    });
    expect(workbook().getAllSheets()).toHaveLength(4);
    await act(async () => {
        workbook().undo();
    });
    expect(workbook().getAllSheets()).toHaveLength(3);
    expect(current()).toBe('Two');
});
