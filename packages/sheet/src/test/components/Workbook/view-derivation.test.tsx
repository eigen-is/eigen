import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { SHEET_DEFAULT_ROW_HEIGHT as ROW_HEIGHT } from '@workspace/lib/sheets';
import { installHappyDom } from '@workspace/ui/test/happy-dom';

installHappyDom();

const { act, createElement, createRef, Profiler, useContext } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Workbook } = await import('../../../components/Workbook');
const contextModule = await import('../../../state/context');
const { WorkbookContext } = await import('../../../context');
type Sheet = import('../../../state').Sheet;
type WorkbookInstance = import('../../../components/Workbook').WorkbookInstance;

function sheets(): Sheet[] {
    return [
        {
            id: 'one',
            name: 'One',
            order: 0,
            row: 30,
            column: 6,
            celldata: [
                { r: 10, c: 0, v: { v: 2, m: '2', ct: { fa: 'General', t: 'n' } } },
                { r: 11, c: 0, v: { v: 3, m: '3', ct: { fa: 'General', t: 'n' } } },
            ],
            config: {},
        },
        { id: 'two', name: 'Two', order: 1, row: 30, column: 6, celldata: [], config: {}, defaultRowHeight: 40 },
    ];
}

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
    mock.restore();
    await cleanup?.();
    cleanup = undefined;
});

// The workbook, and what the selection's focus box showed in each React commit, read before any effect of that commit.
async function mountWorkbook() {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const ref = createRef<WorkbookInstance>();
    const focusBox = () => container.querySelector<HTMLElement>('.sheet-cell-selected-focus');
    const boxes: { top: string | undefined; height: string | undefined; panes: number }[] = [];
    const onRender = () => {
        boxes.push({
            top: focusBox()?.style.top,
            height: focusBox()?.style.height,
            panes: container.querySelectorAll('.sheet-cell-selected-focus').length,
        });
    };
    const data = sheets();
    // Renders once for each context the Workbook commits, as its element never changes.
    const contextRenders = { count: 0 };
    const probe = createElement(() => {
        useContext(WorkbookContext);
        contextRenders.count += 1;
        return null;
    });
    await act(async () => {
        root.render(
            createElement(
                Profiler,
                { id: 'workbook', onRender },
                createElement(Workbook, { ref, data, toolbarLeftItems: probe }),
            ),
        );
    });
    cleanup = async () => {
        await act(async () => root.unmount());
        container.remove();
    };
    const workbook = () => {
        if (!ref.current) throw new Error('workbook did not mount');
        return ref.current;
    };
    const select = (r: number, sheetId = 'one') =>
        act(async () => {
            workbook().revealSearchMatch({ sheetId, r, c: 0 });
        });
    return { container, workbook, boxes, contextRenders, select };
}

const insertRows = (count: number) => ({
    op: 'insertRowCol' as const,
    id: 'one',
    path: [],
    value: { type: 'row', id: 'one', index: 2, count, direction: 'lefttop' },
});

test('a cell edit derives no geometry and renders the grid once', async () => {
    const { workbook, contextRenders } = await mountWorkbook();
    const geometry = spyOn(contextModule, 'updateContextWithSheetData');
    contextRenders.count = 0;
    await act(async () => {
        workbook().setCellFormat(5, 5, 'fs', 14);
    });
    expect(geometry.mock.calls.length).toBe(0);
    expect(contextRenders.count).toBe(1);
});

test("a peer's row insert moves the selection's box in the render that moves its indices", async () => {
    const { workbook, boxes, select } = await mountWorkbook();
    await select(10);
    boxes.length = 0;
    await act(async () => {
        workbook().applyOp([insertRows(3)]);
    });
    expect(boxes[0].top).toBe(`${13 * ROW_HEIGHT}px`);
});

const highlightCount = (container: HTMLElement, name: string) =>
    container.querySelectorAll(`.sheet-${name}-header-selected`).length;

test("a peer's delete of the selected row keeps the box, the header highlights and the status bar on it", async () => {
    const { container, workbook, boxes, select } = await mountWorkbook();
    await select(10);
    boxes.length = 0;
    await act(async () => {
        workbook().applyOp([{ op: 'deleteRowCol', id: 'one', path: [], value: { type: 'row', start: 10, end: 10 } }]);
    });
    expect(boxes[0].top).toBe(`${10 * ROW_HEIGHT}px`);
    expect(container.textContent).toContain('Count: 1');
    expect(highlightCount(container, 'col')).toBeGreaterThan(0);
    expect(highlightCount(container, 'row')).toBeGreaterThan(0);
});

// A batch that lands ahead of a row op the tab applied leaves the tab unable to tell where the selection went.
test('a replay that loses the selection clears the header highlights and the status bar', async () => {
    const { container, workbook, select } = await mountWorkbook();
    const base = workbook().getAllSheets();
    await select(10);
    const applied = [insertRows(3)];
    await act(async () => {
        workbook().applyOp(applied);
    });
    expect(container.textContent).toContain('Count: 1');
    const late = [insertRows(1)];
    await act(async () => {
        workbook().replayOps(base, [late, applied], new Set([late]));
    });
    expect(container.textContent).not.toContain('Count:');
    expect(highlightCount(container, 'col')).toBe(0);
    expect(highlightCount(container, 'row')).toBe(0);
});

test("a peer's freeze splits the overlay into its panes in its own render", async () => {
    const { workbook, boxes } = await mountWorkbook();
    boxes.length = 0;
    await act(async () => {
        const frozen = { type: 'both', range: { row_focus: 1, column_focus: 0 } };
        workbook().applyOp([{ op: 'replace', id: 'one', path: ['frozen'], value: frozen }]);
    });
    expect(boxes[0].panes).toBe(4);
});

test("a peer's unfreeze joins the overlay's panes", async () => {
    const { workbook, container } = await mountWorkbook();
    const write = (value: unknown) =>
        act(async () => {
            workbook().applyOp([{ op: 'replace', id: 'one', path: ['frozen'], value }]);
        });
    await write({ type: 'row', range: { row_focus: 1, column_focus: 0 } });
    await write(undefined);
    expect(container.querySelectorAll('.sheet-cell-selected-focus').length).toBe(1);
});

test("a tab switch paints the new sheet's layout in its first render", async () => {
    const { container, boxes, contextRenders } = await mountWorkbook();
    const tab = [...container.querySelectorAll('[role="button"] span')].find((s) => s.textContent === 'Two');
    boxes.length = 0;
    contextRenders.count = 0;
    await act(async () => {
        tab?.parentElement?.click();
    });
    expect(boxes[0].height).toBe('39px');
    expect(contextRenders.count).toBe(1);
});

test("a peer's merge over the selected cell grows its box", async () => {
    const { workbook, container, select } = await mountWorkbook();
    await select(4);
    const main = { r: 4, c: 0, rs: 2, cs: 1 };
    await act(async () => {
        workbook().applyOp([
            { op: 'replace', id: 'one', path: ['data', 4, 0], value: { mc: main } },
            { op: 'replace', id: 'one', path: ['data', 5, 0], value: { mc: { r: 4, c: 0 } } },
            { op: 'add', id: 'one', path: ['config', 'merge'], value: { '4_0': main } },
        ]);
    });
    expect(container.querySelector<HTMLElement>('.sheet-cell-selected-focus')?.style.height).toBe(
        `${2 * ROW_HEIGHT}px`,
    );
});

test("the status bar's sum follows a peer's edit of the selected cell", async () => {
    const { workbook, container, select } = await mountWorkbook();
    await select(10);
    expect(container.textContent).toContain('Sum: 2');
    await act(async () => {
        workbook().applyOp([
            { op: 'replace', id: 'one', path: ['data', 10, 0], value: { v: 7, m: '7', ct: { fa: 'General', t: 'n' } } },
        ]);
    });
    expect(container.textContent).toContain('Sum: 7');
});

test('a row height a peer sets reaches the geometry', async () => {
    const { workbook, container } = await mountWorkbook();
    const spacer = () => container.querySelector<HTMLElement>('.sheet-cell-table')?.style.height;
    const before = spacer();
    await act(async () => {
        workbook().applyOp([{ op: 'add', id: 'one', path: ['config', 'rowlen'], value: { 3: ROW_HEIGHT + 30 } }]);
    });
    expect(spacer()).toBe(`${Number.parseFloat(before ?? '') + 30}px`);
});
